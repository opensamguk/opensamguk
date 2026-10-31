import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTRPC } from '../trpc';
import { errorCode, serverMessage } from '../turns/apiError';
import { CommandPicker } from '../turns/CommandPicker';
import type { Turn } from '../turns/draft';
import { describeArgs } from '../turns/args';
import { ErrorState, LoadingState } from '../ui/States';
import styles from './RetinueOrdersPanel.module.css';

type Board = inferRouterOutputs<AppRouter>['campaign']['orders'];
type Payload = inferRouterInputs<AppRouter>['campaign']['order']['payload'];
type Json = Extract<Payload, { type: 'issue' }>['command']['args'];
type Pending = { requestId: string; payload: Payload };
const accountChanged = '로그인한 계정이 바뀌었습니다. 화면을 다시 확인하세요.';
const labels = {
  PENDING: '응답 대기',
  READY: '다음 차례 실행 대기',
  REJECTED: '거절',
  CANCELLED: '취소',
  EXECUTED: '실행 완료',
  FAILED: '실행 실패',
} as const;

function json(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)]));
  throw new Error('명령 인자를 다시 확인하세요.');
}

function firstSlot(value: Board['next']['firstSlot']) {
  return { commandKey: value.commandKey, args: json(value.args), explicit: value.explicit };
}

function remember(key: string, value: Pending | null) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* 저장 공간 오류가 현재 접수 결과를 바꾸지 않는다. */
  }
}
function recover(key: string): Pending | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object' || !('requestId' in value) || !('payload' in value)) return null;
    return typeof value.requestId === 'string' && value.payload && typeof value.payload === 'object'
      ? (value as Pending)
      : null;
  } catch {
    return null;
  }
}

export function RetinueOrdersPanel({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const me = useQuery(trpc.auth.me.queryOptions());
  const previous = useRef<{ worldId: string; userId: string } | null>(null);
  const [changedWorld, setChangedWorld] = useState<string | null>(null);
  const userId = me.data?.user?.id;
  useEffect(() => {
    if (!userId) return;
    if (previous.current?.worldId === worldId && previous.current.userId !== userId) setChangedWorld(worldId);
    else if (previous.current?.worldId !== worldId) setChangedWorld(null);
    previous.current = { worldId, userId };
  }, [userId, worldId]);
  if (!userId) return null;
  return (
    <OrdersBoard
      key={`${userId}:${worldId}`}
      worldId={worldId}
      userId={userId}
      accountNotice={changedWorld === worldId ? accountChanged : ''}
    />
  );
}

function OrdersBoard({ worldId, userId, accountNotice }: { worldId: string; userId: string; accountNotice: string }) {
  const trpc = useTRPC(),
    client = useQueryClient();
  const storageKey = `campaign.order.pending:${userId}:${worldId}`;
  const [pending, setPending] = useState<Pending | null>(() => recover(storageKey));
  const [notice, setNotice] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [recipientId, setRecipientId] = useState(0);
  const [command, setCommand] = useState<Turn | null>(null);
  const [consent, setConsent] = useState<Record<number, boolean>>({});
  const busy = useRef(false),
    alive = useRef(false),
    searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const board = useQuery({
    ...trpc.campaign.orders.queryOptions({ worldId }),
    retry: false,
    refetchInterval: preparing ? false : 2000,
  });
  useEffect(() => {
    void client.invalidateQueries({ queryKey: trpc.campaign.orders.queryKey({ worldId }) });
  }, [client, trpc, userId, worldId]);
  useEffect(() => {
    setConsent({});
  }, [board.data?.next.turnRevision]);
  const commands = useQuery(trpc.commands.list.queryOptions({ worldId }));
  const map = useQuery(trpc.world.map.queryOptions({ worldId }));
  const summary = useQuery(trpc.world.summary.queryOptions({ worldId }));
  const home = useQuery(trpc.home.get.queryOptions({ worldId }));
  const order = useMutation(trpc.campaign.order.mutationOptions());
  const request = useQuery({
    ...trpc.campaign.request.queryOptions({ worldId, requestId: pending?.requestId ?? '' }),
    enabled: pending !== null,
    retry: false,
    refetchInterval: (query) =>
      pending && (!query.state.data || query.state.data.status === 'pending') ? 1500 : false,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: trpc.campaign.orders.queryKey({ worldId }) });
    void client.invalidateQueries({ queryKey: trpc.campaign.get.queryKey({ worldId }) });
    void client.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
  };
  useEffect(() => {
    const result = request.data;
    if (!pending || !result || result.requestId !== pending.requestId || result.status === 'pending') return;
    setNotice(
      result.status === 'rejected' ? result.result.message : '지시 요청을 처리했습니다. 아래 실행 상태를 확인하세요.',
    );
    remember(storageKey, null);
    setPending(null);
    void client.invalidateQueries({ queryKey: trpc.campaign.orders.queryKey({ worldId }) });
  }, [request.data, pending, storageKey, client, trpc, worldId]);

  async function submit(make: (latest: Board) => Payload, retry?: Pending) {
    if (busy.current || (!retry && pending)) return;
    busy.current = true;
    setPreparing(true);
    setNotice('');
    let action: Pending | undefined;
    try {
      const me = await client.fetchQuery({ ...trpc.auth.me.queryOptions(), staleTime: 0 });
      if (me.user?.id !== userId) throw new Error(accountChanged);
      await client.cancelQueries({ queryKey: trpc.campaign.orders.queryKey({ worldId }), exact: true });
      const latest = await client.fetchQuery({ ...trpc.campaign.orders.queryOptions({ worldId }), staleTime: 0 });
      if (!alive.current) return;
      if (latest.userId !== userId) throw new Error(accountChanged);
      if (client.getQueryData(trpc.auth.me.queryKey())?.user?.id !== userId) throw new Error(accountChanged);
      if (latest.status !== 'RUNNING') throw new Error('실행 중인 월드에서만 지시할 수 있습니다.');
      action = retry ?? { requestId: crypto.randomUUID(), payload: make(latest) };
      remember(storageKey, action);
      setPending(action);
      await order.mutateAsync({ worldId, expectedUserId: userId, ...action });
      if (alive.current) refresh();
    } catch (error) {
      if (!alive.current) return;
      setNotice(serverMessage(error) ?? (error instanceof Error ? error.message : '요청 결과를 확인하지 못했습니다.'));
      if (
        !retry &&
        errorCode(error) &&
        ['BAD_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED', 'CONFLICT', 'PRECONDITION_FAILED'].includes(errorCode(error)!)
      ) {
        remember(storageKey, null);
        setPending(null);
      }
      refresh();
    } finally {
      busy.current = false;
      if (alive.current) setPreparing(false);
    }
  }

  const denied =
    board.isError &&
    ['FORBIDDEN', 'UNAUTHORIZED', 'PRECONDITION_FAILED', 'SERVICE_UNAVAILABLE'].includes(errorCode(board.error) ?? '');
  if (denied || !board.data || board.data.userId !== userId)
    return board.isError ? (
      <ErrorState title="지시 현황을 불러오지 못했습니다" onRetry={() => void board.refetch()} />
    ) : (
      <LoadingState />
    );
  const data = board.data;
  const disabled = preparing || pending !== null || data.status !== 'RUNNING';
  const name = (key: string) => commands.data?.find((c) => c.key === key)?.name ?? key;
  const args = (value: Record<string, unknown>) =>
    describeArgs(value, {
      city: (key) => map.data?.cities.find((city) => city.key === key)?.name,
      nation: (id) => map.data?.nations.find((nation) => nation.id === id)?.name,
    });
  return (
    <section className={styles.panel} aria-labelledby="retinue-orders-title">
      <h2 id="retinue-orders-title">장수 지시</h2>
      <p>직속 상급자는 한 명입니다. 부곡은 장수 개인의 사병이며 여러 부곡을 편성할 수 있습니다.</p>
      <p>
        사람 장수는 본인이 수락한 지시로 다음 예약 한 칸을 실행합니다. 이후 예턴을 고치거나 지시 권한이 바뀌면
        취소됩니다.
      </p>
      {notice || accountNotice ? <p role="status">{notice || accountNotice}</p> : null}
      {pending ? (
        <div className={styles.pending}>
          <p>접수 결과를 확인 중입니다. 화면을 다시 열어도 같은 요청 번호로 확인합니다.</p>
          {request.isError ? (
            <button type="button" disabled={preparing} onClick={() => void submit(() => pending.payload, pending)}>
              같은 요청 다시 확인·접수
            </button>
          ) : null}
        </div>
      ) : null}
      <div className={styles.send}>
        <h3>지시 보내기</h3>
        <label>
          받을 장수{' '}
          <select
            value={recipientId}
            disabled={disabled}
            onChange={(event) => {
              setRecipientId(Number(event.target.value));
              setCommand(null);
            }}
          >
            <option value={0}>장수 선택</option>
            {data.recipients.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} ({person.isHuman ? '사람' : 'NPC'})
              </option>
            ))}
          </select>
        </label>
        {data.recipients.length === 0 ? <p>현재 지시할 수 있는 장수가 없습니다.</p> : null}
        {commands.data && map.data ? (
          <CommandPicker
            commands={commands.data}
            cities={map.data.cities}
            nations={map.data.nations}
            selectedCityKey={null}
            defaultCrewType={home.data?.general.crewType}
            cityResources={summary.data?.cityResourcesEnabled === true}
            blockedReason={disabled ? '다른 요청의 처리를 기다리세요.' : !recipientId ? '받을 장수를 고르세요.' : null}
            targetLabel="보낼 지시"
            searchRef={searchRef}
            onPut={setCommand}
          />
        ) : null}
        {command ? (
          <p>
            선택한 지시: {name(command.commandKey)} {args(command.args)}
          </p>
        ) : null}
        <button
          type="button"
          disabled={disabled || !recipientId || !command}
          onClick={() => {
            if (!command) return;
            void submit((latest) => {
              if (!latest.recipients.some((person) => person.id === recipientId))
                throw new Error('지시할 권한이 바뀌었습니다.');
              return {
                type: 'issue',
                recipientId,
                command: { commandKey: command.commandKey, args: json(command.args) },
                revision: latest.revision,
              };
            });
          }}
        >
          지시 보내기
        </button>
      </div>
      {data.npcSuperior ? (
        <div>
          <h3>NPC 상급자 지시</h3>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              void submit((latest) => {
                if (!latest.npcSuperior) throw new Error('지시를 요청할 NPC 상급자가 없습니다.');
                return { type: 'request', revision: latest.revision };
              })
            }
          >
            {data.npcSuperior.name}에게 지시 요청
          </button>
          <p>받은 지시는 본인이 수락해야 실행합니다.</p>
        </div>
      ) : null}
      <h3>받고 보낸 지시</h3>
      {data.orders.length === 0 ? <p>지시가 없습니다.</p> : null}
      <ul className={styles.orders}>
        {data.orders.map((item) => (
          <li key={item.id}>
            <p>
              {item.issuerName} → {item.recipientName}: {name(item.command.commandKey)}{' '}
              {args(item.command.args as Record<string, unknown>)}
            </p>
            <p>
              {labels[item.status]}
              {typeof item.result === 'string' && item.result ? ` · ${item.result}` : ''}
            </p>
            {item.recipientId === data.actorId && item.status === 'PENDING' ? (
              <div>
                <p>
                  현재 다음 예약: {name(data.next.firstSlot.commandKey)}{' '}
                  {args(data.next.firstSlot.args as Record<string, unknown>)}
                </p>
                <label className={styles.consent}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={consent[item.id] ?? false}
                    onChange={(event) => setConsent((old) => ({ ...old, [item.id]: event.target.checked }))}
                  />
                  다음 한 칸을 이 지시로 실행하는 데 동의합니다.
                </label>
                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={disabled || !consent[item.id]}
                    onClick={() =>
                      void submit((latest) => {
                        const current = latest.orders.find((row) => row.id === item.id);
                        if (!current || current.status !== 'PENDING' || current.recipientId !== latest.actorId)
                          throw new Error('지시 상태가 바뀌었습니다.');
                        if (JSON.stringify(latest.next) !== JSON.stringify(data.next))
                          throw new Error('다음 예약이 바뀌었습니다. 확인한 뒤 다시 수락하세요.');
                        return {
                          type: 'respond',
                          orderId: item.id,
                          accept: true,
                          revision: latest.revision,
                          expectedTurnRevision: latest.next.turnRevision,
                          expectedFirstSlot: firstSlot(latest.next.firstSlot),
                        };
                      })
                    }
                  >
                    다음 한 칸으로 수락
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      void submit((latest) => ({
                        type: 'respond',
                        orderId: item.id,
                        accept: false,
                        revision: latest.revision,
                        expectedTurnRevision: latest.next.turnRevision,
                        expectedFirstSlot: firstSlot(latest.next.firstSlot),
                      }))
                    }
                  >
                    지시 거절
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
