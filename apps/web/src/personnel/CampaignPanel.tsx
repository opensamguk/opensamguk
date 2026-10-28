import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTRPC } from '../trpc';
import { errorCode, serverMessage } from '../turns/apiError';
import { Portrait } from '../portrait/Portrait';
import { ErrorState, LoadingState } from '../ui/States';
import styles from './CampaignPanel.module.css';

type Inputs = inferRouterInputs<AppRouter>['campaign'];
type Board = inferRouterOutputs<AppRouter>['campaign']['get'];
type Pending = { requestId: string } & (
  | { kind: 'campaign.relationship'; payload: Inputs['relationship']['payload'] }
  | { kind: 'campaign.unit'; payload: Inputs['unit']['payload'] }
);
const relations = { STAFF: '가신', LIEUTENANT: '부장', GUEST: '식객' } as const;
function remember(key: string, pending: Pending | null) {
  try {
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
  } catch {
    /* 저장 공간을 쓸 수 없어도 현재 화면의 접수 상태는 유지한다. */
  }
}
function recover(key: string): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Pending | null;
    return value &&
      typeof value.requestId === 'string' &&
      ['campaign.relationship', 'campaign.unit'].includes(value.kind) &&
      value.payload &&
      typeof value.payload === 'object'
      ? value
      : null;
  } catch {
    return null;
  }
}

export function CampaignPanel({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const me = useQuery(trpc.auth.me.queryOptions());
  if (!me.data?.user) return null;
  return <CampaignBoard key={`${me.data.user.id}:${worldId}`} worldId={worldId} userId={me.data.user.id} />;
}

function CampaignBoard({ worldId, userId }: { worldId: string; userId: string }) {
  const trpc = useTRPC(),
    client = useQueryClient();
  const storageKey = `campaign.pending:${userId}:${worldId}`;
  const [pending, setPending] = useState<Pending | null>(() => recover(storageKey));
  const [notice, setNotice] = useState('');
  const sending = useRef(false);
  const relationship = useMutation(trpc.campaign.relationship.mutationOptions());
  const unit = useMutation(trpc.campaign.unit.mutationOptions());
  const board = useQuery({
    ...trpc.campaign.get.queryOptions({ worldId }),
    refetchInterval: (query) => (query.state.data?.status === 'RUNNING' ? 2000 : false),
    retry: false,
  });
  const request = useQuery({
    ...trpc.campaign.request.queryOptions({ worldId, requestId: pending?.requestId ?? '' }),
    enabled: pending !== null,
    retry: false,
    refetchInterval: (query) =>
      pending && (!query.state.data || query.state.data.status === 'pending') ? 1500 : false,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: trpc.campaign.get.queryKey({ worldId }) });
    void client.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
  };
  useEffect(() => {
    const result = request.data;
    if (!pending || !result || result.requestId !== pending.requestId || result.status === 'pending') return;
    setNotice(
      result.status === 'rejected'
        ? result.result.message
        : result.kind === 'campaign.relationship' && result.result.accepted === false
          ? `상대가 거절했습니다.${result.result.cost ? ` 서약 비용 금${result.result.cost}을 썼습니다.` : ''}`
          : '처리했습니다.',
    );
    remember(storageKey, null);
    setPending(null);
    void client.invalidateQueries({ queryKey: trpc.campaign.get.queryKey({ worldId }) });
    void client.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
  }, [request.data, pending, storageKey, client, trpc, worldId]);
  async function send(action: Pending) {
    if (sending.current) return;
    sending.current = true;
    setNotice('');
    remember(storageKey, action);
    setPending(action);
    try {
      const input = { worldId, requestId: action.requestId, payload: action.payload };
      if (action.kind === 'campaign.relationship')
        await relationship.mutateAsync({ ...input, payload: action.payload });
      else await unit.mutateAsync({ ...input, payload: action.payload });
      await client.invalidateQueries({
        queryKey: trpc.campaign.request.queryKey({ worldId, requestId: action.requestId }),
      });
    } catch (error) {
      setNotice(serverMessage(error) ?? '접수 여부를 확인하지 못했습니다. 같은 요청을 다시 보낼 수 있습니다.');
      if (['BAD_REQUEST', 'FORBIDDEN', 'CONFLICT', 'PRECONDITION_FAILED'].includes(errorCode(error) ?? '')) {
        remember(storageKey, null);
        setPending(null);
        refresh();
      }
    } finally {
      sending.current = false;
    }
  }
  const act = (
    action:
      | Omit<Extract<Pending, { kind: 'campaign.relationship' }>, 'requestId'>
      | Omit<Extract<Pending, { kind: 'campaign.unit' }>, 'requestId'>,
  ) => {
    if (pending || sending.current) return;
    void send({ ...action, requestId: crypto.randomUUID() });
  };
  return (
    <section className={styles.panel} aria-labelledby="campaign-title">
      <h2 id="campaign-title" tabIndex={-1}>
        개인 휘하·부곡
      </h2>
      {notice ? <p role="status">{notice}</p> : null}
      {pending ? (
        <div role="status">
          {request.data?.status === 'pending' ? '엔진이 요청을 처리하는 중입니다.' : '요청 접수를 확인하는 중입니다.'}
          {request.isError && !relationship.isPending && !unit.isPending ? (
            <button type="button" onClick={() => void send(pending)}>
              같은 요청 다시 보내기
            </button>
          ) : null}
        </div>
      ) : null}
      {board.data ? (
        <CampaignControls board={board.data} busy={pending !== null} act={act} />
      ) : board.isError ? (
        <ErrorState
          title={serverMessage(board.error) ?? '휘하 현황을 불러오지 못했습니다'}
          onRetry={() => void board.refetch()}
        />
      ) : (
        <LoadingState />
      )}
    </section>
  );
}

type Action =
  | Omit<Extract<Pending, { kind: 'campaign.relationship' }>, 'requestId'>
  | Omit<Extract<Pending, { kind: 'campaign.unit' }>, 'requestId'>;
function CampaignControls({ board, busy, act }: { board: Board; busy: boolean; act: (action: Action) => void }) {
  const [relation, setRelation] = useState<keyof typeof relations>('STAFF');
  const [commander, setCommander] = useState(board.actorId);
  const [crewType, setCrewType] = useState(board.armyTypes[0]?.id ?? 1100);
  const names = new Map(board.people.map((person) => [person.id, person.name]));
  const disabled = busy || board.status !== 'RUNNING';
  const rel = (payload: Inputs['relationship']['payload']) => act({ kind: 'campaign.relationship', payload });
  const unit = (payload: Inputs['unit']['payload']) => act({ kind: 'campaign.unit', payload });
  const ownLinks = board.links.filter((link) => link.masterId === board.actorId || link.personId === board.actorId);
  return (
    <div className={styles.sections}>
      <p>
        직속 명망 {board.renownUsed}/{board.renownCapacity}. 사람은 본인이 수락합니다. 개인 예턴은 각자30칸을
        예약합니다.
      </p>
      <p>
        소유 부곡 {board.units.length}개 · 총 병력{' '}
        {board.units.reduce((sum, unit) => sum + unit.troops, 0).toLocaleString('ko-KR')}명 · 금{' '}
        {board.resources.gold.toLocaleString('ko-KR')} · 쌀 {board.resources.rice.toLocaleString('ko-KR')}
      </p>
      <section>
        <h3>받은 휘하 제안</h3>
        {board.offers
          .filter((offer) => offer.personId === board.actorId && offer.status === 'PENDING')
          .map((offer) => (
            <div className={styles.row} key={offer.id}>
              <span>
                {names.get(offer.masterId)}의 {relations[offer.relation]} 제안
              </span>
              <button
                disabled={disabled}
                onClick={() => rel({ type: 'respond', offerId: offer.id, accept: true, revision: board.revision })}
              >
                수락
              </button>
              <button
                disabled={disabled}
                onClick={() => rel({ type: 'respond', offerId: offer.id, accept: false, revision: board.revision })}
              >
                거절
              </button>
            </div>
          ))}
        {board.offers
          .filter((offer) => offer.masterId === board.actorId)
          .map((offer) => (
            <p key={offer.id}>
              {names.get(offer.personId)}에게 {relations[offer.relation]} 제안 ·{' '}
              {{ PENDING: '응답 대기', ACCEPTED: '수락', REJECTED: '거절', CANCELLED: '취소' }[offer.status]}
            </p>
          ))}
      </section>
      <section>
        <h3>휘하 관계</h3>
        {ownLinks.length ? (
          ownLinks.map((link) => (
            <div className={styles.row} key={link.personId}>
              <span>
                {names.get(link.masterId)} → {names.get(link.personId)} ({relations[link.relation]})
              </span>
              <button
                disabled={disabled}
                onClick={() => rel({ type: 'release', personId: link.personId, revision: board.revision })}
              >
                관계 해제
              </button>
            </div>
          ))
        ) : (
          <p>직속 관계가 없습니다.</p>
        )}
      </section>
      <section>
        <h3>휘하 영입</h3>
        <p>
          같은 거점의 동국·재야 장수에게 제안합니다. NPC 서약은 금{board.npcPledge.cost}, 호응 {board.npcPledge.chance}
          %이며 거절에도 비용을 씁니다. 같은 대상은 장수별 게임 월1회, 다음 달에 다시 시도합니다. 사람 제안은
          비용·확률을 적용하지 않습니다.
        </p>
        <label>
          제안할 관계{' '}
          <select value={relation} onChange={(event) => setRelation(event.target.value as keyof typeof relations)}>
            {Object.entries(relations).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.candidates}>
          {board.candidates.map((id) => {
            const person = board.people.find((person) => person.id === id)!;
            const attempted =
              !person.isHuman &&
              board.npcPledge.attempts.some(
                (attempt) => attempt.personId === id && attempt.month >= board.npcPledge.month,
              );
            const capacity = board.renownUsed + person.renownCost > board.renownCapacity;
            const noGold = !person.isHuman && board.resources.gold < board.npcPledge.cost;
            return (
              <article key={id} className={styles.person}>
                <Portrait id={person.portraitId} name={person.name} variant="icon" />
                <div>
                  <span>
                    {person.name} · {person.isHuman ? '사람' : 'NPC'} · 명망{person.renownCost}
                  </span>
                  <small>
                    통솔{person.leadership} 무력{person.strength} 지력{person.intel} 정치{person.politics} 매력
                    {person.charm}
                  </small>
                  <button
                    disabled={disabled || attempted || capacity || noGold}
                    onClick={() => rel({ type: 'offer', targetId: id, relation, revision: board.revision })}
                  >
                    {attempted
                      ? '다음 달 서약 가능'
                      : capacity
                        ? '명망 수용량 부족'
                        : noGold
                          ? `서약 금${board.npcPledge.cost} 부족`
                          : `${person.name}에게 제안`}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        {!board.candidates.length ? <p>현재 제안할 장수가 없습니다. 출사 후 같은 거점에서 확인하세요.</p> : null}
      </section>
      <section>
        <h3>부곡 편성·지휘</h3>
        <p>
          빈 부곡을 편성하고 기존 모병·징병·훈련·사기·소집해제 예턴을 사용합니다. 병력은 실제 지휘관의
          통솔×100까지입니다. 여러 부곡을 합산합니다. 군량은 소유자의 쌀에서만 씁니다.
        </p>
        <div className={styles.row}>
          <label>
            새 부곡 지휘관{' '}
            <select value={commander} onChange={(event) => setCommander(Number(event.target.value))}>
              {board.commanders.map((row) => (
                <option key={row.id} value={row.id}>
                  {names.get(row.id)} · {row.commanded}/{row.capacity}
                </option>
              ))}
            </select>
          </label>
          <label>
            새 부곡 병종{' '}
            <select value={crewType} onChange={(event) => setCrewType(Number(event.target.value))}>
              {board.armyTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={disabled || !board.commanders.some((row) => row.id === commander)}
            onClick={() => unit({ type: 'form', commanderId: commander, crewType, revision: board.revision })}
          >
            빈 부곡 편성
          </button>
        </div>
        {board.units.map((row) => (
          <article className={styles.unit} key={row.id}>
            <h4>
              부곡 {row.id} · {board.armyTypes.find((type) => type.id === row.crewType)?.name}
            </h4>
            <p>
              병력 {row.troops} · 훈련 {row.train} · 사기 {row.atmos} · 지휘관 {names.get(row.commanderId)} · 거점{' '}
              {row.cityKey}
            </p>
            <label>
              부곡 {row.id} 지휘관{' '}
              <select
                disabled={disabled}
                value={row.commanderId}
                onChange={(event) =>
                  unit({
                    type: 'command',
                    unitId: row.id,
                    commanderId: Number(event.target.value),
                    revision: board.revision,
                  })
                }
              >
                {!board.commanders.some((commander) => commander.id === row.commanderId) ? (
                  <option value={row.commanderId}>{names.get(row.commanderId)} (다른 거점)</option>
                ) : null}
                {board.commanders.map((commander) => (
                  <option key={commander.id} value={commander.id}>
                    {names.get(commander.id)} · {commander.commanded}/{commander.capacity}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={disabled || row.troops !== 0}
              onClick={() => unit({ type: 'disband', unitId: row.id, revision: board.revision })}
            >
              {row.troops ? '소집해제 후 해산 가능' : '빈 부곡 해산'}
            </button>
          </article>
        ))}
      </section>
    </div>
  );
}
