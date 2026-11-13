import type { AppRouter } from '@opensamguk/server/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { inferRouterOutputs } from '@trpc/server';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { displayName, officerName } from '../game/names';
import { Portrait } from '../portrait/Portrait';
import { useTRPC, useTRPCClient } from '../trpc';
import { errorCode, retryUnlessClientError, serverMessage } from '../turns/apiError';
import styles from './CreateGeneralPage.module.css';
import { candidateStats, sortByStatTotal, statTotal } from './npcCandidates';

type Reply = inferRouterOutputs<AppRouter>['entry']['possess'];
const roles = { ruler: '군주', core: '중견', retainer: '부하', free: '재야' } as const;
type Role = keyof typeof roles;
type Receipt = { idempotencyKey: string; generalId: number };

function readReceipt(key: string): Receipt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Receipt | null;
    return value &&
      /^[0-9a-f-]{36}$/i.test(value.idempotencyKey) &&
      Number.isSafeInteger(value.generalId) &&
      value.generalId > 0
      ? value
      : null;
  } catch {
    return null;
  }
}

export function NpcPossession({
  worldId,
  enabled,
  onPendingChange,
}: {
  worldId: string;
  enabled: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  const trpc = useTRPC();
  const auth = useQuery(trpc.auth.me.queryOptions());
  const userId = auth.data?.user?.id;
  return userId ? (
    <NpcEntry
      key={`${worldId}:${userId}`}
      worldId={worldId}
      userId={userId}
      enabled={enabled}
      onPendingChange={onPendingChange}
    />
  ) : null;
}

function NpcEntry({
  worldId,
  userId,
  enabled,
  onPendingChange,
}: {
  worldId: string;
  userId: string;
  enabled: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const key = `entry.possess:${worldId}:${userId}`;
  const [receipt, setReceipt] = useState(() => readReceipt(key));
  const pending = receipt !== null;
  useLayoutEffect(() => {
    onPendingChange(pending);
    return () => onPendingChange(false);
  }, [onPendingChange, pending]);
  const [open, setOpen] = useState(() => receipt !== null);
  const [role, setRole] = useState<Role>('ruler');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(30);
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const settled = useRef<string | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const candidates = useQuery({
    queryKey: ['npc-entry-roles', worldId, userId],
    queryFn: ({ signal }) => client.entry.roles.query({ worldId }, { signal }),
    enabled: enabled && open && !receipt,
    retry: retryUnlessClientError,
  });
  const possession = useMutation(trpc.entry.possess.mutationOptions());
  const status = useQuery({
    ...trpc.entry.possessStatus.queryOptions({
      worldId,
      expectedUserId: userId,
      idempotencyKey: receipt?.idempotencyKey ?? '00000000-0000-4000-8000-000000000000',
    }),
    enabled: receipt !== null && !possession.isPending,
    retry: retryUnlessClientError,
    refetchInterval: (query) =>
      query.state.status === 'success' && query.state.data?.status === 'pending' ? 1500 : false,
  });

  const finish = useCallback(
    (result: Reply, id: string) => {
      if (!mounted.current || result.status === 'pending' || settled.current === id) return;
      settled.current = id;
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* 요청은 화면 상태에서도 관리한다. */
      }
      setReceipt(null);
      setSelected(null);
      if (result.status === 'rejected') {
        setMessage(result.message);
        void cache.invalidateQueries({ queryKey: ['npc-entry-roles', worldId, userId] });
        return;
      }
      void cache.invalidateQueries({ queryKey: trpc.general.mine.queryKey({ worldId }) });
      void cache.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
      void navigate({ to: '/w/$worldId', params: { worldId } });
    },
    [cache, key, navigate, trpc, userId, worldId],
  );

  useEffect(() => {
    if (receipt && status.data) finish(status.data, receipt.idempotencyKey);
  }, [finish, receipt, status.data]);

  async function send(current: Receipt) {
    if (inFlight.current) return;
    inFlight.current = true;
    setMessage('');
    try {
      const result = await possession.mutateAsync({ ...current, worldId, expectedUserId: userId });
      finish(result, current.idempotencyKey);
    } catch (error) {
      if (!mounted.current) return;
      setMessage(serverMessage(error) ?? '접수 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하세요.');
      if (['BAD_REQUEST', 'PRECONDITION_FAILED', 'FORBIDDEN', 'UNAUTHORIZED'].includes(errorCode(error) ?? '')) {
        // 접수 전 거절도 세션이 바뀐 뒤에는 기존 요청이 있었는지 확인할 수 있으므로 번호를 보관한다.
        void cache.invalidateQueries({ queryKey: trpc.auth.me.queryKey() });
      }
    } finally {
      inFlight.current = false;
    }
  }

  const group = candidates.data?.roles[role] ?? [];
  // 서버는 국가 순으로 준다. 화면은 역할 묶음 안에서 능력치 합이 큰 순으로 다시 둔다 (원작 빙의 후보 순서).
  const filtered = sortByStatTotal(
    group.filter((general) =>
      [general.name, general.nation?.name, general.city.name].some((value) => value?.includes(search.trim())),
    ),
  );
  const picked = group.find((general) => general.generalId === selected);
  if (!enabled && !receipt) return null;
  return (
    <section className={styles.form} aria-label="NPC 무장 맡기">
      {receipt ? (
        <>
          <p role="status">NPC 무장 맡기 결과를 확인하고 있습니다.</p>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={possession.isPending || status.isFetching}
              onClick={() => void status.refetch()}
            >
              결과 다시 확인
            </button>
            {status.isError ? (
              <button type="button" disabled={possession.isPending} onClick={() => void send(receipt)}>
                같은 요청 다시 보내기
              </button>
            ) : null}
            {errorCode(status.error) === 'NOT_FOUND' ? (
              <button
                type="button"
                disabled={possession.isPending}
                onClick={() => {
                  try {
                    sessionStorage.removeItem(key);
                  } catch {
                    /* 요청 번호는 화면에서도 지운다. */
                  }
                  setReceipt(null);
                  setSelected(null);
                  setMessage('');
                }}
              >
                새로 선택
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            className={styles.submit}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            NPC 무장 맡기
          </button>
          {open ? (
            <>
              <div className={styles.field}>
                <label>
                  역할{' '}
                  <select
                    className={styles.input}
                    value={role}
                    onChange={(event) => {
                      setRole(event.currentTarget.value as Role);
                      setSelected(null);
                      setLimit(30);
                    }}
                  >
                    {Object.entries(roles).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label} ({candidates.data?.roles[id as Role].length ?? 0})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  이름·국가·도시 검색{' '}
                  <input
                    className={styles.input}
                    value={search}
                    onChange={(event) => {
                      setSearch(event.currentTarget.value);
                      setSelected(null);
                      setLimit(30);
                    }}
                  />
                </label>
              </div>
              {candidates.isPending ? <p role="status">입장할 수 있는 무장을 불러오는 중입니다.</p> : null}
              {candidates.isError ? (
                <button type="button" onClick={() => void candidates.refetch()}>
                  무장 목록 다시 불러오기
                </button>
              ) : null}
              {candidates.data?.blockedReason ? <p>{candidates.data.blockedReason}</p> : null}
              {candidates.data?.canPossess && filtered.length === 0 ? <p>조건에 맞는 무장이 없습니다.</p> : null}
              {filtered.length > 0 ? (
                <fieldset className={`${styles.portraits} ${styles.npcList}`} aria-describedby="npc-order">
                  <legend>{roles[role]} 무장</legend>
                  <p id="npc-order" className={styles.npcStats}>
                    능력치 합이 큰 순입니다.
                  </p>
                  {filtered.slice(0, limit).map((general) => (
                    <label key={general.generalId} className={styles.npcRow}>
                      <input
                        type="radio"
                        name="npc-general"
                        checked={selected === general.generalId}
                        onChange={() => setSelected(general.generalId)}
                      />
                      <Portrait
                        id={general.portraitId}
                        name={displayName(general.name)}
                        variant="icon"
                        shape="round"
                        decorative
                      />
                      <span className={styles.npcInfo}>
                        <span>
                          <strong>{displayName(general.name)}</strong> · {general.nation?.name ?? '재야'} ·{' '}
                          {general.city.name}
                        </span>
                        {general.progression && (
                          <span className={styles.npcStats}>
                            {general.age}세 · Lv {general.progression.level} · {general.progression.honorTitle} ·{' '}
                            {general.progression.dedicationRank} · {general.generalType} ·{' '}
                            {officerName(general.officerLevel, general.nation !== null)}
                          </span>
                        )}
                        {general.personality || general.special ? (
                          <span className={styles.npcStats}>
                            {[
                              general.personality && `성격 ${general.personality}`,
                              general.special && `특기 ${general.special}`,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        ) : null}
                        <span className={`num ${styles.npcStats}`} data-testid="npc-stats">
                          {candidateStats(general)
                            .map((cell) => `${cell.label} ${cell.value}`)
                            .join(' · ')}{' '}
                          · 합 {statTotal(general)}
                        </span>
                        {general.proficiency?.length ? (
                          <span className={styles.npcStats}>
                            {'병종 숙련 '}
                            {general.proficiency.map(({ name, grade }) => `${name} ${grade}`).join(' · ')}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {filtered.length > limit ? (
                <button type="button" onClick={() => setLimit((value) => value + 30)}>
                  30명 더 보기
                </button>
              ) : null}
              {picked ? (
                <button
                  type="button"
                  className={styles.submit}
                  disabled={possession.isPending}
                  onClick={() => {
                    if (inFlight.current) return;
                    const current = { generalId: picked.generalId, idempotencyKey: crypto.randomUUID() };
                    try {
                      sessionStorage.setItem(key, JSON.stringify(current));
                    } catch {
                      /* 화면 상태에서도 번호를 보관한다. */
                    }
                    setReceipt(current);
                    void send(current);
                  }}
                >
                  {displayName(picked.name)}(으)로 시작
                </button>
              ) : null}
            </>
          ) : null}
        </>
      )}
      {message ? (
        <p role="alert" className={styles.errorText}>
          {message}
        </p>
      ) : null}
    </section>
  );
}
