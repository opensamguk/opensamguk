import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTRPC } from '../trpc';
import { DisabledReason } from '../ui/DisabledReason';
import { EmptyState, ErrorState } from '../ui/States';
import { errorCode, retryUnlessClientError } from './apiError';
import { describeArgs } from './args';
import { CommandPicker, type CommandInfo } from './CommandPicker';
import {
  describeSelection,
  quickSelect,
  rangeBetween,
  repeatRange,
  SLOT_COUNT,
  turnKey,
  type QuickSelect,
  type Turn,
} from './draft';
import { slotTimes } from './schedule';
import styles from './TurnEditor.module.css';
import { draftStorageKey, useTurnDraft } from './useTurnDraft';

export interface TurnEditorProps {
  worldId: string;
  // 메인 지도에서 고른 도시(city.key). 대상 도시 칸의 기본값으로만 쓴다. 권한 근거가 아니며 편집을 바꾸거나 저장하지 않는다.
  selectedCityKey: number | null;
}

// 30칸 예턴 편집기. 메인 명령 칸(T1-16)과 /w/:worldId/turns가 같은 부품을 쓴다.
// 편집 초안·revision·선택·충돌 처리는 이 안에서 한다. 바깥에서 지도 선택이 바뀌거나 조회가 다시 돌아도 초안은 그대로다.
export function TurnEditor({ worldId, selectedCityKey }: TurnEditorProps) {
  const trpc = useTRPC();
  const me = useQuery({ ...trpc.auth.me.queryOptions(), retry: retryUnlessClientError });
  const userId = me.data?.user?.id;
  if (!userId) {
    if (me.data && !me.data.user) return <AuthLost />;
    if (me.isError) return <ErrorState title="불러오지 못했습니다" onRetry={() => void me.refetch()} />;
    return <p className={styles.muted}>예턴을 불러오는 중…</p>;
  }
  const storageKey = draftStorageKey(userId, worldId);
  return <Editor key={storageKey} worldId={worldId} selectedCityKey={selectedCityKey} storageKey={storageKey} />;
}

function AuthLost() {
  const href = useRouterState({ select: (state) => state.location.href });
  return (
    <div className={styles.alert} role="alert">
      <p>로그인이 풀렸습니다. 같은 계정으로 다시 로그인하면 저장하지 않은 편집을 이어서 저장할 수 있습니다.</p>
      <Link to="/login" search={{ next: href }}>
        다시 로그인
      </Link>
    </div>
  );
}

type PrecheckResult = { ok: true } | { ok: false; message: string } | { ok: 'error'; message: string } | undefined;

function Editor({ worldId, selectedCityKey, storageKey }: TurnEditorProps & { storageKey: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const state = useTurnDraft(worldId, storageKey);
  const { server, turns, serverTurns, draft, pending, notice } = state;

  const commands = useQuery({
    ...trpc.commands.list.queryOptions({ worldId }),
    staleTime: Infinity,
    retry: retryUnlessClientError,
  });
  const map = useQuery({
    ...trpc.world.map.queryOptions({ worldId }),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
  const home = useQuery({
    ...trpc.home.get.queryOptions({ worldId }),
    refetchInterval: 15_000,
    retry: retryUnlessClientError,
  });
  const summary = useQuery({ ...trpc.world.summary.queryOptions({ worldId }), retry: retryUnlessClientError });

  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [focus, setFocus] = useState(0);
  const [shiftBy, setShiftBy] = useState('1');
  const [times, setTimes] = useState('1');
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const helpId = useId();

  // 서버 목록이 바뀌면(저장·턴 실행) 사전 검사도 새로 받는다. 장수 상태가 바뀌었을 수 있다.
  const revision = server.data?.revision;
  useEffect(() => {
    if (revision !== undefined) void queryClient.invalidateQueries({ queryKey: trpc.turns.precheck.pathKey() });
  }, [revision, queryClient, trpc]);

  const commandList: CommandInfo[] = useMemo(() => commands.data ?? [], [commands.data]);
  const commandName = useCallback(
    (key: string) => commandList.find((c) => c.key === key)?.name ?? (key === 'rest' ? '휴식' : key),
    [commandList],
  );
  const cities = useMemo(() => map.data?.cities ?? [], [map.data]);
  const nations = useMemo(() => map.data?.nations ?? [], [map.data]);
  const names = useMemo(
    () => ({
      city: (key: number) => cities.find((c) => c.key === key)?.name,
      nation: (id: number) => nations.find((n) => n.id === id)?.name,
    }),
    [cities, nations],
  );

  // 같은 명령·인자는 사전 검사를 한 번만 묻는다. 휴식은 묻지 않는다.
  const distinct = useMemo(() => {
    const seen = new Map<string, Turn>();
    for (const turn of turns ?? []) if (turn.commandKey !== 'rest') seen.set(turnKey(turn), turn);
    return [...seen.entries()];
  }, [turns]);
  const prechecks = useQueries({
    queries: distinct.map(([, turn]) => ({
      ...trpc.turns.precheck.queryOptions({ worldId, commandKey: turn.commandKey, args: turn.args }),
      staleTime: 15_000,
      retry: retryUnlessClientError,
    })),
  });
  const precheckByKey = new Map<string, PrecheckResult>();
  distinct.forEach(([key], i) => {
    const query = prechecks[i];
    if (!query) return;
    if (query.data) precheckByKey.set(key, query.data.ok ? { ok: true } : { ok: false, message: query.data.message });
    else if (query.isError)
      precheckByKey.set(key, {
        ok: 'error',
        message: errorCode(query.error) === 'BAD_REQUEST' ? '명령과 인자를 확인하세요.' : '검사하지 못했습니다.',
      });
  });

  const times30 = slotTimes(SLOT_COUNT, summary.data, home.data?.general.nextTurnTick, home.data?.nextTurnAt);

  const focusRow = (i: number) => {
    const next = Math.max(0, Math.min(SLOT_COUNT - 1, i));
    setFocus(next);
    rowRefs.current[next]?.focus();
  };

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const addRange = (from: number, to: number) => setSelected((prev) => new Set([...prev, ...rangeBetween(from, to)]));

  const onRowClick = (event: MouseEvent, i: number) => {
    if (event.shiftKey && anchor !== null) addRange(anchor, i);
    else {
      toggle(i);
      setAnchor(i);
    }
    setFocus(i);
  };

  const onGridKey = (event: KeyboardEvent<HTMLTableElement>) => {
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault();
      const next =
        key === 'ArrowDown' ? focus + 1 : key === 'ArrowUp' ? focus - 1 : key === 'Home' ? 0 : SLOT_COUNT - 1;
      const clamped = Math.max(0, Math.min(SLOT_COUNT - 1, next));
      if (event.shiftKey) addRange(anchor ?? focus, clamped);
      focusRow(clamped);
    } else if (key === ' ') {
      event.preventDefault();
      toggle(focus);
      setAnchor(focus);
    } else if (key === 'Enter') {
      event.preventDefault();
      if (selected.size === 0) setSelected(new Set([focus]));
      searchRef.current?.focus();
    } else if (key === 'Escape') {
      setSelected(new Set());
    }
  };

  const busyReason = state.saving
    ? '저장하는 중입니다.'
    : pending
      ? '먼저 위 충돌 안내에서 다시 적용할지 고르세요.'
      : !server.data
        ? '예턴을 불러온 뒤에 고칠 수 있습니다.'
        : null;
  const putBlocked = busyReason ?? (selected.size === 0 ? '칸을 먼저 고르세요.' : null);
  const shiftN = Number(shiftBy);
  const shiftOk = Number.isInteger(shiftN) && shiftN >= 1 && shiftN <= SLOT_COUNT - 1;
  const repeat = repeatRange(selected);
  const timesN = Number(times);
  const timesOk = Number.isInteger(timesN) && timesN >= 1 && timesN <= SLOT_COUNT - 1;
  const repeatReason =
    busyReason ??
    (!repeat
      ? '이어진 칸 한 구간을 고르세요. 30번 칸에서 끝나는 구간은 반복할 자리가 없습니다.'
      : !timesOk
        ? '반복 횟수는 1~29입니다.'
        : null);

  const onPut = (turn: Turn) => {
    if (putBlocked) return;
    state.edit({ put: { indices: [...selected].sort((a, b) => a - b), turn } });
    rowRefs.current[focus]?.focus();
  };

  if (!turns) {
    if (state.authLost) return <AuthLost />;
    if (server.isError) {
      const code = errorCode(server.error);
      if (code === 'NOT_FOUND')
        return (
          <EmptyState title="이 월드에 내 장수가 없습니다">
            <Link to="/w/$worldId/create" params={{ worldId }}>
              장수 만들기
            </Link>
          </EmptyState>
        );
      if (code === 'BAD_REQUEST') return <EmptyState title="월드를 찾을 수 없습니다" />;
      return <ErrorState title="예턴을 불러오지 못했습니다" onRetry={() => void server.refetch()} />;
    }
    return <p className={styles.muted}>예턴을 불러오는 중…</p>;
  }

  const editCount = draft?.ops.length ?? 0;
  const selectionText = selected.size === 0 ? '없음' : `${describeSelection(selected)}번 칸`;
  const targetLabel = selected.size === 0 ? '고른 칸' : `${describeSelection(selected)}번 칸`;

  return (
    <div className={styles.editor} data-testid="turn-editor">
      <div className={styles.saveBar}>
        <p className={styles.saveState} data-testid="draft-state">
          {editCount > 0 ? `저장하지 않은 편집 ${editCount}건` : '저장된 목록'}
        </p>
        {draft && !state.saving ? (
          <button type="button" className={styles.primary} onClick={state.submit}>
            저장
          </button>
        ) : (
          <DisabledReason reason={state.saving ? '저장하는 중입니다.' : '바꾼 칸이 없습니다.'}>저장</DisabledReason>
        )}
        {draft ? (
          <button type="button" className={styles.secondary} onClick={state.discard} disabled={state.saving}>
            편집 취소
          </button>
        ) : null}
      </div>

      <div role="status" className={styles.notice}>
        {state.saving ? '저장하는 중…' : null}
        {notice?.kind === 'saved' ? '저장했습니다.' : null}
        {notice?.kind === 'reapplied' ? '최신 목록에 내 편집을 다시 적용했습니다. 확인한 뒤 저장하세요.' : null}
        {state.behind && !pending
          ? '다른 곳에서 예턴이 바뀌었습니다(다른 탭 저장이나 턴 실행). 저장하면 최신 목록에 다시 적용할지 묻습니다.'
          : null}
      </div>
      {notice?.kind === 'error' ? (
        <p className={styles.errorText} role="alert">
          {notice.message}
        </p>
      ) : null}
      {state.authLost ? <AuthLost /> : null}
      {pending ? (
        <div className={styles.alert} role="alert" data-testid="stale-alert">
          <p>다른 곳에서 먼저 바뀌었습니다. 최신 목록을 다시 불러왔습니다.</p>
          <p>내 편집 {pending.ops.length}건은 버리지 않고 보관했습니다. 최신 목록에 다시 적용할까요?</p>
          <div className={styles.buttons}>
            <button type="button" className={styles.primary} onClick={state.reapply}>
              내 편집 다시 적용
            </button>
            <button type="button" className={styles.secondary} onClick={state.discard}>
              내 편집 버리기
            </button>
          </div>
        </div>
      ) : null}

      <div className={styles.selectBar} role="group" aria-label="칸 고르기">
        <span data-testid="selection">선택: {selectionText}</span>
        {(['all', 'odd', 'even'] as QuickSelect[]).map((kind) => (
          <button
            key={kind}
            type="button"
            className={styles.chip}
            onClick={() => {
              setSelected(quickSelect(kind));
              setAnchor(null);
            }}
          >
            {kind === 'all' ? '전체' : kind === 'odd' ? '홀수 칸' : '짝수 칸'}
          </button>
        ))}
        <button
          type="button"
          className={styles.chip}
          onClick={() => {
            setSelected(new Set());
            setAnchor(null);
          }}
        >
          선택 해제
        </button>
      </div>

      <div className={styles.tableWrap}>
        <table
          className={styles.table}
          role="grid"
          aria-multiselectable="true"
          aria-label="예턴 30칸"
          aria-describedby={helpId}
          onKeyDown={onGridKey}
        >
          <thead>
            <tr>
              <th scope="col" className="num">
                칸
              </th>
              <th scope="col">실행 시기</th>
              <th scope="col">명령</th>
              <th scope="col">사전 검사</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((turn, i) => {
              const isSelected = selected.has(i);
              const changed = !!draft && !pending && !!serverTurns && turnKey(serverTurns[i]!) !== turnKey(turn);
              const check = turn.commandKey === 'rest' ? undefined : precheckByKey.get(turnKey(turn));
              const args = describeArgs(turn.args, names);
              const time = times30[i]!;
              return (
                <tr
                  key={i}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  aria-selected={isSelected}
                  aria-rowindex={i + 2}
                  tabIndex={focus === i ? 0 : -1}
                  className={[styles.row, isSelected ? styles.selected : '', changed ? styles.changed : '']
                    .filter(Boolean)
                    .join(' ')}
                  data-slot={i + 1}
                  onClick={(e) => onRowClick(e, i)}
                  onFocus={() => setFocus(i)}
                >
                  <td className="num" role="gridcell">
                    {i + 1}
                  </td>
                  <td role="gridcell" className={styles.when}>
                    <span>{time.date ?? '—'}</span>
                    {time.time ? <time dateTime={time.iso ?? undefined}>{time.time}</time> : null}
                  </td>
                  <td role="gridcell">
                    <span className={styles.command}>{commandName(turn.commandKey)}</span>
                    {args ? <span className={styles.args}> {args}</span> : null}
                    {changed ? <span className={styles.changedTag}>바뀜</span> : null}
                  </td>
                  <td role="gridcell" className={styles.check}>
                    {check === undefined ? (
                      turn.commandKey === 'rest' ? (
                        <span className={styles.muted}>—</span>
                      ) : (
                        <span className={styles.muted}>검사 중</span>
                      )
                    ) : check.ok === true ? (
                      <span className={styles.ok}>가능</span>
                    ) : (
                      <span className={styles.warn}>경고: {check.message}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p id={helpId} className={styles.help}>
        칸을 누르면 고르고, Shift를 누른 채 누르면 범위를 고릅니다. 키보드는 위아래 화살표로 옮기고 Space로 고르며
        Enter로 명령 찾기로 갑니다. 경고가 있어도 저장되며 실행할 때 다시 검사합니다.
      </p>

      {commands.isError ? (
        <ErrorState title="명령 목록을 불러오지 못했습니다" onRetry={() => void commands.refetch()} />
      ) : (
        <CommandPicker
          commands={commandList}
          cities={cities}
          nations={nations}
          selectedCityKey={selectedCityKey}
          defaultCrewType={home.data?.general.crewType}
          blockedReason={putBlocked}
          targetLabel={targetLabel}
          searchRef={searchRef}
          onPut={onPut}
        />
      )}

      <div className={styles.editBar} role="group" aria-label="칸 옮기기와 반복">
        <label className={styles.inline}>
          <span>칸 수</span>
          <input
            type="number"
            className="num"
            min={1}
            max={SLOT_COUNT - 1}
            value={shiftBy}
            onChange={(e) => setShiftBy(e.target.value)}
          />
        </label>
        {busyReason || !shiftOk ? (
          <>
            <DisabledReason reason={busyReason ?? '칸 수는 1~29입니다.'}>당기기</DisabledReason>
            <DisabledReason reason={busyReason ?? '칸 수는 1~29입니다.'}>밀기</DisabledReason>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.secondary}
              title="모든 칸을 앞으로 당기고 끝을 휴식으로 채웁니다"
              onClick={() => state.edit({ shift: -shiftN })}
            >
              당기기
            </button>
            <button
              type="button"
              className={styles.secondary}
              title="모든 칸을 뒤로 밀고 앞을 휴식으로 채웁니다"
              onClick={() => state.edit({ shift: shiftN })}
            >
              밀기
            </button>
          </>
        )}
        <label className={styles.inline}>
          <span>반복 횟수</span>
          <input
            type="number"
            className="num"
            min={1}
            max={SLOT_COUNT - 1}
            value={times}
            onChange={(e) => setTimes(e.target.value)}
          />
        </label>
        {repeatReason || !repeat ? (
          <DisabledReason reason={repeatReason ?? ''}>고른 구간 반복</DisabledReason>
        ) : (
          <button
            type="button"
            className={styles.secondary}
            title="고른 구간을 바로 뒤에 횟수만큼 이어 붙입니다"
            onClick={() => state.edit({ repeat: { ...repeat, times: timesN } })}
          >
            고른 구간 반복
          </button>
        )}
      </div>
    </div>
  );
}
