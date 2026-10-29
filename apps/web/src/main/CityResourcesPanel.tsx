import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTRPC, useTRPCClient } from '../trpc';
import { errorCode, serverMessage } from '../turns/apiError';
import { DataTable, type Column } from '../ui/DataTable';
import { TRPCClientError } from '@trpc/client';
import { retryAfterSeconds } from '../auth/credentials';
import {
  allocationLimit,
  allocationStorageKey,
  readAllocation,
  forgetAllocation,
  type AllocationRequest,
  type CityResourceBoard,
  type VisibleCityResources,
} from './cityResourceRequest';
import styles from './CityResourcesPanel.module.css';

type View = { userId: string; board: CityResourceBoard; pending: AllocationRequest | null };
const number = (value: number) => value.toLocaleString('ko-KR');
class IdentityChanged extends Error {}
const deniedView = (error: unknown) =>
  error instanceof IdentityChanged ||
  ['UNAUTHORIZED', 'FORBIDDEN', 'CONFLICT', 'PRECONDITION_FAILED', 'NOT_FOUND'].includes(errorCode(error) ?? '');
const admissionRejected = (error: unknown) =>
  error instanceof TRPCClientError &&
  error.meta?.response instanceof Response &&
  ['BAD_REQUEST', 'FORBIDDEN', 'CONFLICT', 'PRECONDITION_FAILED', 'TOO_MANY_REQUESTS'].includes(errorCode(error) ?? '');

export function CityResourcesPanel({ worldId, cityKey }: { worldId: string; cityKey: number }) {
  const trpc = useTRPC();
  const summary = useQuery(trpc.world.summary.queryOptions({ worldId }));
  return summary.data?.cityResourcesEnabled === true ? (
    <ResourceBoard key={`${worldId}:${cityKey}`} worldId={worldId} cityKey={cityKey} />
  ) : null;
}

function ResourceBoard({ worldId, cityKey }: { worldId: string; cityKey: number }) {
  const api = useTRPCClient(),
    trpc = useTRPC(),
    queries = useQueryClient();
  const [view, setView] = useState<View | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [retryUntil, setRetryUntil] = useState(0),
    [now, setNow] = useState(Date.now);
  const retryDeadline = useRef(0);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    sending = useRef(false);
  const begin = useCallback(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const stamp = ++generation.current;
    return { stamp, signal: abort.signal, current: () => generation.current === stamp && !abort.signal.aborted };
  }, []);
  const snapshot = useCallback(
    async (signal: AbortSignal, expected?: string) => {
      const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) };
      const before = await api.auth.me.query(undefined, options);
      const userId = before.user?.id;
      if (!userId || (expected && userId !== expected))
        throw new IdentityChanged('계정이 바뀌었습니다. 다시 확인하세요.');
      const board = await api.cityResources.get.query({ worldId, cityKey }, options);
      const after = await api.auth.me.query(undefined, options);
      if (board.userId !== userId || after.user?.id !== userId)
        throw new IdentityChanged('계정이 바뀌었습니다. 다시 확인하세요.');
      return { userId, board };
    },
    [api, worldId, cityKey],
  );

  const observe = useCallback(
    async (current: View, request: AllocationRequest, signal: AbortSignal, valid: () => boolean) => {
      const deadline = Date.now() + 60_000;
      while (valid()) {
        const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) };
        const me = await api.auth.me.query(undefined, options);
        if (me.user?.id !== current.userId) throw new IdentityChanged('계정이 바뀌었습니다. 다시 확인하세요.');
        const result = await api.cityResources.request.query(
          { worldId, requestId: request.requestId },
          { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
        );
        const after = await api.auth.me.query(undefined, options);
        if (
          after.user?.id !== current.userId ||
          result.userId !== current.userId ||
          result.requestId !== request.requestId
        )
          throw new IdentityChanged('계정이나 요청이 바뀌었습니다. 다시 확인하세요.');
        if (!valid()) return;
        if (result.status !== 'pending') {
          if (!forgetAllocation(sessionStorage, allocationStorageKey(current.userId, worldId), request))
            throw new IdentityChanged('요청 기록이 바뀌었습니다. 다시 확인하세요.');
          const fresh = await snapshot(signal, current.userId);
          if (!valid()) return;
          setView({ ...fresh, pending: null });
          setNotice(result.status === 'applied' ? '도시 병력을 부곡에 배속했습니다.' : result.result.message);
          void queries.invalidateQueries({ queryKey: trpc.campaign.get.queryKey({ worldId }) });
          void queries.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
          return;
        }
        if (Date.now() >= deadline) {
          setNotice('아직 처리 중입니다. 같은 요청의 상태를 다시 확인할 수 있습니다.');
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1500);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
          }
          signal.addEventListener('abort', done, { once: true });
        });
      }
    },
    [api, worldId, snapshot, queries, trpc],
  );

  const load = useCallback(async () => {
    if (Date.now() < retryDeadline.current) return;
    const run = begin();
    setView(null);
    setNotice('');
    setBusy(false);
    try {
      const fresh = await snapshot(run.signal);
      const pending = readAllocation(sessionStorage, allocationStorageKey(fresh.userId, worldId));
      if (!run.current()) return;
      setView({ ...fresh, pending });
      if (pending) {
        setBusy(true);
        await observe({ ...fresh, pending }, pending, run.signal, run.current);
      }
    } catch (error) {
      if (run.current()) {
        if (deniedView(error)) setView(null);
        setNotice(
          error instanceof IdentityChanged
            ? error.message
            : (serverMessage(error) ?? '도시 자원을 확인하지 못했습니다. 다시 확인하세요.'),
        );
      }
    } finally {
      if (run.current()) setBusy(false);
    }
  }, [begin, snapshot, worldId, observe]);
  useEffect(() => {
    void load();
    const clear = () => {
      controller.current?.abort();
      ++generation.current;
      setView(null);
      setNotice('');
      setBusy(false);
    };
    const focus = () => {
      if (!document.hidden) void load();
    };
    const visibility = () => (document.hidden ? clear() : focus());
    window.addEventListener('blur', clear);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      controller.current?.abort();
      ++generation.current;
      window.removeEventListener('blur', clear);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [load]);
  useEffect(() => {
    if (!retryUntil) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= retryUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryUntil]);

  // 원장은 공용 캐시에 넣지 않고 같은 신원/세대에서 새로 읽는다. 입력 중인 폼은 다시 만들지 않는다.
  useEffect(() => {
    if (!view || view.pending || busy || (view.board.visible && view.board.status !== 'RUNNING')) return;
    const timer = setInterval(() => {
      if (sending.current || document.hidden) return;
      const signal = controller.current?.signal,
        stamp = generation.current;
      if (!signal || signal.aborted) return;
      void snapshot(signal, view.userId)
        .then((fresh) => {
          if (generation.current === stamp && !signal.aborted) setView({ ...fresh, pending: null });
        })
        .catch((error) => {
          if (generation.current !== stamp || signal.aborted) return;
          setView(null);
          setNotice(error instanceof IdentityChanged ? error.message : '도시 자원을 다시 확인하지 못했습니다.');
        });
    }, 15_000);
    return () => clearInterval(timer);
  }, [view, busy, snapshot]);

  async function act(request: AllocationRequest, submit: boolean) {
    if (!view || sending.current || (submit && Date.now() < retryDeadline.current)) return;
    sending.current = true;
    const run = begin();
    const current = view;
    setBusy(true);
    setNotice('');
    let mutationStarted = false,
      mutationReturned = false;
    try {
      const fresh = await snapshot(run.signal, current.userId);
      if (!run.current()) return;
      setView({ ...fresh, pending: current.pending });
      if (submit) {
        if (
          !fresh.board.visible ||
          !fresh.board.canAllocate ||
          request.payload.amount > allocationLimit(fresh.board, request.payload.unitId, request.payload.crewType)
        )
          throw new Error('수량·병종·지휘 상한을 다시 확인하세요.');
        const me = await api.auth.me.query(undefined, {
          signal: AbortSignal.any([run.signal, AbortSignal.timeout(10_000)]),
        });
        if (me.user?.id !== current.userId) throw new IdentityChanged('계정이 바뀌었습니다. 다시 확인하세요.');
        if (!run.current()) return;
        // 마지막 신원 조회까지 마친 뒤 저장한다. 저장과 mutation 호출 사이에는 await를 두지 않는다.
        sessionStorage.setItem(allocationStorageKey(current.userId, worldId), JSON.stringify(request));
        setView({ ...fresh, pending: request });
        mutationStarted = true;
        await api.cityResources.allocate.mutate(
          { worldId, expectedUserId: current.userId, ...request },
          { signal: AbortSignal.any([run.signal, AbortSignal.timeout(10_000)]) },
        );
        mutationReturned = true;
      }
      await observe(current, request, run.signal, run.current);
    } catch (error) {
      const unaccepted = submit && mutationStarted && !mutationReturned && admissionRejected(error);
      let cleanupFailed = false;
      if (unaccepted) {
        try {
          forgetAllocation(sessionStorage, allocationStorageKey(current.userId, worldId), request);
        } catch {
          cleanupFailed = true;
        }
      }
      if (run.current()) {
        if (deniedView(error) || (submit && !mutationStarted) || unaccepted) setView(null);
        if (errorCode(error) === 'TOO_MANY_REQUESTS') {
          const seconds = retryAfterSeconds(error);
          const at = Date.now();
          retryDeadline.current = seconds === null ? 0 : at + seconds * 1000;
          setNow(at);
          setRetryUntil(retryDeadline.current);
        }
        setNotice(
          cleanupFailed
            ? '요청 기록을 지우지 못했습니다. 같은 요청의 상태를 다시 확인하세요.'
            : error instanceof IdentityChanged
              ? error.message
              : (serverMessage(error) ??
                (submit && !mutationStarted
                  ? '배속을 보내지 않았습니다. 신원과 도시를 다시 확인하세요.'
                  : '접수 상태를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.')),
        );
      }
    } finally {
      sending.current = false;
      if (run.current()) setBusy(false);
    }
  }
  return (
    <section className={styles.panel} aria-label="도시 금·쌀·수비병">
      <h3>도시 금·쌀·수비병</h3>
      {notice ? (
        <p className={styles.error} role="status">
          {notice}
        </p>
      ) : null}
      {!view ? (
        <>
          <p>도시 자원을 확인하고 있습니다.</p>
          {retryUntil > now ? (
            <p role="status">{Math.ceil((retryUntil - now) / 1000)}초 뒤에 다시 확인하세요.</p>
          ) : null}
          <button type="button" disabled={retryUntil > now} onClick={() => void load()}>
            다시 확인
          </button>
        </>
      ) : !view.board.visible ? (
        <p className={styles.note}>금·쌀·수비병은 자기 국가 도시나 내 장수가 있는 도시에서만 보입니다.</p>
      ) : (
        <>
          <ResourceSummary board={view.board} />
          {view.pending ? (
            <>
              <p role="status">배속 요청을 확인하는 중입니다. 새 배속은 처리 결과 뒤에 할 수 있습니다.</p>
              <button type="button" disabled={busy} onClick={() => void act(view.pending!, false)}>
                같은 요청 상태 확인
              </button>
            </>
          ) : view.board.canAllocate ? (
            <AllocationForm
              key={`${view.userId}:${cityKey}`}
              board={view.board}
              busy={busy}
              allocate={(payload) => void act({ requestId: crypto.randomUUID(), payload }, true)}
            />
          ) : (
            <p className={styles.note}>자국 도시의 병력 배속은 군주·참모·수뇌가 맡습니다.</p>
          )}
        </>
      )}
    </section>
  );
}

function ResourceSummary({ board }: { board: VisibleCityResources }) {
  type Row = VisibleCityResources['resources']['garrison'][number];
  const columns: Column<Row>[] = [
    {
      key: 'crewType',
      label: '병종',
      render: (row) => board.armyTypes.find((type) => type.id === row.crewType)?.name ?? `병종 ${row.crewType}`,
    },
    ...(['troops', 'train', 'atmos'] as const).map((key) => ({
      key,
      label: { troops: '수비병', train: '훈련', atmos: '사기' }[key],
      numeric: true,
      render: (row: Row) => number(row[key]),
    })),
  ];
  return (
    <>
      <p className={styles.summary}>
        <span>금 {number(board.resources.gold)}</span>
        <span>쌀 {number(board.resources.rice)}</span>
        <span>수비병 합계 {number(board.resources.garrison.reduce((sum, row) => sum + row.troops, 0))}명</span>
      </p>
      {board.resources.garrison.length ? (
        <DataTable
          caption="병종별 도시 수비병"
          rows={board.resources.garrison}
          columns={columns}
          rowKey={(row) => row.crewType}
        />
      ) : (
        <p>도시 수비병이 없습니다. 모병·징병은 개인 예턴에서 예약합니다.</p>
      )}
      <p className={styles.note}>수비병은 도시 방어에 참전합니다. 부곡에 배속한 인원은 도시 수비병에서 빠집니다.</p>
    </>
  );
}

function AllocationForm({
  board,
  busy,
  allocate,
}: {
  board: VisibleCityResources;
  busy: boolean;
  allocate: (payload: AllocationRequest['payload']) => void;
}) {
  const [unit, setUnit] = useState(''),
    [amount, setAmount] = useState('');
  const target = board.targets.find((row) => String(row.id) === unit);
  const limit = target ? allocationLimit(board, target.id, target.crewType) : 0;
  const value = Number(amount),
    valid = target && Number.isInteger(value) && value > 0 && value <= limit;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !busy)
      allocate({ cityKey: board.cityKey, unitId: target.id, crewType: target.crewType, amount: value });
  };
  return (
    <form className={styles.form} onSubmit={submit} aria-label="도시 병력 배속">
      <label>
        배속할 부곡
        <select
          value={unit}
          disabled={busy}
          onChange={(e) => {
            setUnit(e.target.value);
            setAmount('');
          }}
        >
          <option value="">부곡을 고르세요</option>
          {board.targets.map((row) => (
            <option key={row.id} value={row.id}>
              부곡 {row.id} · 소유 {row.ownerName} · 지휘 {row.commanderName} · {number(row.troops)}명
            </option>
          ))}
        </select>
      </label>
      {target ? (
        <p className={styles.note}>
          지휘관 전체 병력 {number(target.commanded)}/{number(target.capacity)}명 · 배속 가능 {number(limit)}명
        </p>
      ) : null}
      <label>
        배속 인원
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={limit}
          step={1}
          value={amount}
          disabled={busy || !target}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy || !valid}>
        도시 수비병을 부곡에 배속
      </button>
      {!board.targets.length ? <p>소유자와 지휘관이 이 도시에 모인 자국 부곡이 없습니다.</p> : null}
      <p className={styles.note}>
        금·쌀·인구와 장수의 예약30칸은 바꾸지 않습니다. 병종과 지휘 상한은 처리할 때 다시 확인합니다.
      </p>
    </form>
  );
}
