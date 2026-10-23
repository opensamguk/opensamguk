import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { useMemo } from 'react';
import { errorCode, retryUnlessClientError } from '../game/errors';
import { formatYearMonth } from '../game/gameDate';
import { NoGeneral, QueryError } from '../game/QueryState';
import { useHome, useWorldId, useWorldMap } from '../game/queries';
import { useTRPC } from '../trpc';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, LoadingState } from '../ui/States';
import type { ClauseNames } from './clauses';
import { treatyApi, treatyQueryKey, type TreatyList, type TreatyRow, type TrustRow } from './contract';
import styles from './Diplomacy.module.css';
import { actionLabel, finishedText, phaseText, requestsStorageKey, trackedFor, type Tracked } from './requests';
import { TreatyCard } from './TreatyCard';
import { relationText, TreatyComposer } from './TreatyComposer';
import { useTreatyRequests } from './useTreatyRequests';

// 외교실 (T2-08, AC-M2-06). 받은 제안·보낸 제안·조약 목록·조약서 쓰기·국가별 신의를 탭으로 나눈다.
// 제안·수락·거절·파기는 엔진이 처리한 뒤에 결과가 정해진다. 화면은 applied·rejected를 받기 전에는 성공 문구를 띄우지 않는다.

export const DIPLOMACY_TABS = ['incoming', 'outgoing', 'active', 'ended', 'broken', 'write', 'trust'] as const;
export type DiplomacyTab = (typeof DIPLOMACY_TABS)[number];

const TAB_LABELS: Record<DiplomacyTab, string> = {
  incoming: '받은 제안',
  outgoing: '보낸 제안',
  active: '진행 중',
  ended: '끝남',
  broken: '파기됨',
  write: '조약서 쓰기',
  trust: '국가별 신의',
};

export const parseDiplomacySearch = (search: Record<string, unknown>): { tab: DiplomacyTab } => ({
  tab: DIPLOMACY_TABS.includes(search.tab as DiplomacyTab) ? (search.tab as DiplomacyTab) : 'incoming',
});

// 탭마다 보일 조약. 목록 순서(proposedSeq 내림차순)는 서버가 정한 그대로 둔다.
export function treatiesForTab(items: readonly TreatyRow[], tab: DiplomacyTab): TreatyRow[] {
  switch (tab) {
    case 'incoming':
      return items.filter((t) => t.status === 'PROPOSED' && t.incoming);
    case 'outgoing':
      return items.filter((t) => t.status === 'PROPOSED' && !t.incoming);
    case 'active':
      return items.filter((t) => t.status === 'ACTIVE');
    case 'ended':
      return items.filter((t) => t.status === 'ENDED' || t.status === 'REJECTED' || t.status === 'EXPIRED');
    case 'broken':
      return items.filter((t) => t.status === 'BROKEN');
    default:
      return [];
  }
}

// 조약 카드의 처리 중 안내. 내 요청은 그 단계, 같은 국가 다른 장수의 요청은 treaty.list의 pending으로 본다.
export function busyText(treatyId: string, tracked: readonly Tracked[], pending: TreatyList['pending']): string | null {
  const mine = trackedFor(tracked, { treatyId });
  if (mine) return `${actionLabel(mine.action)} ${phaseText(mine.phase)}`;
  const other = pending.find((p) => p.treatyId === treatyId);
  return other ? `${other.requestedBy.name}의 요청을 처리하는 중입니다.` : null;
}

export function DiplomacyPage({ tab }: { tab: DiplomacyTab }) {
  const worldId = useWorldId();
  const trpc = useTRPC();
  const me = useQuery({ ...trpc.auth.me.queryOptions(), retry: retryUnlessClientError });
  const home = useHome(worldId);
  const userId = me.data?.user?.id;

  let body;
  if (home.isError && errorCode(home.error) === 'NOT_FOUND') body = <NoGeneral worldId={worldId} />;
  else if (home.isError)
    body = <QueryError error={home.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void home.refetch()} />;
  else if (!home.data || !userId) body = <LoadingState />;
  else if (home.data.nation === null)
    body = (
      <EmptyState title="소속 국가가 없습니다">
        외교는 국가에 속한 장수가 봅니다. 임관하거나 건국한 뒤에 오세요.
      </EmptyState>
    );
  else {
    const storageKey = requestsStorageKey(userId, worldId);
    body = (
      <Diplomacy
        key={storageKey}
        worldId={worldId}
        tab={tab}
        myNationId={home.data.nation.id}
        storageKey={storageKey}
      />
    );
  }

  return (
    <section className={styles.page}>
      <h1>외교실</h1>
      {body}
    </section>
  );
}

function Diplomacy({
  worldId,
  tab,
  myNationId,
  storageKey,
}: {
  worldId: string;
  tab: DiplomacyTab;
  myNationId: number;
  storageKey: string;
}) {
  const href = useRouterState({ select: (state) => state.location.href });
  const map = useWorldMap(worldId);
  const requests = useTreatyRequests(worldId, storageKey);
  const list = useQuery({
    queryKey: treatyQueryKey('list', { worldId }),
    queryFn: () => treatyApi.list.query({ worldId }),
    refetchInterval: 10_000,
    retry: retryUnlessClientError,
  });
  const trust = useQuery({
    queryKey: treatyQueryKey('trust', { worldId }),
    queryFn: () => treatyApi.trust.query({ worldId }),
    enabled: tab === 'trust',
    retry: retryUnlessClientError,
  });

  const names: ClauseNames = useMemo(() => {
    const cities = map.data?.cities ?? [];
    const nations = map.data?.nations ?? [];
    return {
      city: (key) => cities.find((c) => c.key === key)?.name ?? `도시 ${key}`,
      nation: (id) => nations.find((n) => n.id === id)?.name ?? `국가 ${id}`,
    };
  }, [map.data]);

  const items = list.data?.items ?? [];
  const pending = list.data?.pending ?? [];
  const treatyName = (treatyId: string) => {
    const t = items.find((row) => row.id === treatyId);
    return t ? `${t.from.name}·${t.to.name} 조약` : '조약';
  };
  const describeTarget = (t: Tracked) =>
    t.action.kind === 'propose'
      ? `${names.nation(t.action.input.toNationId)}에 보낸`
      : `${treatyName(t.action.input.treatyId)}`;

  return (
    <>
      <RequestPanel
        tracked={requests.tracked}
        finished={requests.finished}
        describeTarget={describeTarget}
        loginHref={href}
        onResend={requests.resend}
        onDismiss={requests.dismiss}
      />

      <nav className={styles.tabs} aria-label="외교실 탭">
        {DIPLOMACY_TABS.map((key) => {
          const count = key === 'write' || key === 'trust' ? null : treatiesForTab(items, key).length;
          return (
            <Link
              key={key}
              to="/w/$worldId/diplomacy"
              params={{ worldId }}
              search={{ tab: key }}
              className={key === tab ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              aria-current={key === tab ? 'page' : undefined}
            >
              {TAB_LABELS[key]}
              {count ? <span className="num"> {count}</span> : null}
            </Link>
          );
        })}
      </nav>

      {tab === 'trust' ? (
        <TrustTable query={trust} />
      ) : !list.data ? (
        list.isError ? (
          <QueryError error={list.error} notFound="외교 정보를 찾을 수 없습니다" onRetry={() => void list.refetch()} />
        ) : (
          <LoadingState />
        )
      ) : tab === 'write' ? (
        list.data.canPropose.ok ? (
          <TreatyComposer
            worldId={worldId}
            myNationId={myNationId}
            targets={list.data.targets}
            cities={map.data?.cities ?? []}
            busyFor={(toNationId) => {
              const mine = trackedFor(requests.tracked, { toNationId });
              if (mine) return `이 상대에게 보낸 제안이 ${phaseText(mine.phase)}`;
              return pending.some((p) => p.kind === 'propose' && p.toNation?.id === toNationId)
                ? '같은 국가의 다른 장수가 이 상대에게 보낸 제안을 처리하는 중입니다.'
                : null;
            }}
            onPropose={(input) => requests.send({ kind: 'propose', input })}
          />
        ) : (
          <ReadOnlyWrite reason={list.data.canPropose.reason} code={list.data.canPropose.code} list={list.data} />
        )
      ) : (
        <TreatyList
          treaties={treatiesForTab(items, tab)}
          empty={`${TAB_LABELS[tab]} 조약이 없습니다`}
          names={names}
          busy={(id) => busyText(id, requests.tracked, pending)}
          onRespond={(treatyId, accept) => requests.send({ kind: 'respond', input: { treatyId, accept } })}
          onBreak={(treatyId) => requests.send({ kind: 'break', input: { treatyId } })}
        />
      )}

      {list.data && list.data.myRecent.length > 0 ? (
        <section className={styles.recent} aria-label="최근 처리된 내 요청">
          <h2>최근 처리된 내 요청</h2>
          <ul>
            {list.data.myRecent.map((r) => (
              <li key={r.requestId}>
                {r.kind === 'propose' ? '제안' : r.kind === 'break' ? '파기' : '응답'} ·{' '}
                {r.result === 'APPLIED' ? '처리됨' : `거절됨${r.reason ? ` (${r.reason})` : ''}`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function RequestPanel({
  tracked,
  finished,
  describeTarget,
  loginHref,
  onResend,
  onDismiss,
}: {
  tracked: ReturnType<typeof useTreatyRequests>['tracked'];
  finished: ReturnType<typeof useTreatyRequests>['finished'];
  describeTarget: (t: Tracked) => string;
  loginHref: string;
  onResend: (requestId: string) => void;
  onDismiss: (requestId: string) => void;
}) {
  if (tracked.length === 0 && finished.length === 0) return null;
  return (
    <section className={styles.requests} aria-label="내 요청" data-testid="treaty-requests">
      <ul>
        {tracked.map((t) => (
          <li key={t.requestId} data-request-id={t.requestId} data-phase={t.phase} role="status">
            <span className={styles.requestHead}>
              {describeTarget(t)} {actionLabel(t.action)}
            </span>{' '}
            {phaseText(t.phase)}
            {t.phase === 'unknown' ? (
              <button type="button" className={styles.secondary} onClick={() => onResend(t.requestId)}>
                같은 요청 다시 보내기
              </button>
            ) : null}
            {t.phase === 'auth' ? (
              <Link to="/login" search={{ next: loginHref }}>
                다시 로그인
              </Link>
            ) : null}
          </li>
        ))}
        {finished.map((f) => (
          <li
            key={f.requestId}
            data-request-id={f.requestId}
            data-result={f.result}
            role={f.result === 'rejected' ? 'alert' : 'status'}
            className={f.result === 'rejected' ? styles.rejected : styles.applied}
          >
            {finishedText(f)}
            {f.treaty ? (
              <span className={styles.muted}>
                {' '}
                ({f.treaty.from.name}·{f.treaty.to.name}, 조항 {f.treaty.clauses.length}개
                {f.treaty.endAt ? `, ${formatYearMonth(f.treaty.endAt)}까지` : ''})
              </span>
            ) : null}
            <button type="button" className={styles.linkButton} onClick={() => onDismiss(f.requestId)}>
              닫기
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TreatyList({
  treaties,
  empty,
  names,
  busy,
  onRespond,
  onBreak,
}: {
  treaties: TreatyRow[];
  empty: string;
  names: ClauseNames;
  busy: (treatyId: string) => string | null;
  onRespond: (treatyId: string, accept: boolean) => void;
  onBreak: (treatyId: string) => void;
}) {
  if (treaties.length === 0) return <EmptyState title={empty} />;
  return (
    <div className={styles.cards}>
      {treaties.map((t) => (
        <TreatyCard
          key={t.id}
          treaty={t}
          names={names}
          busy={busy(t.id)}
          onRespond={(accept) => onRespond(t.id, accept)}
          onBreak={() => onBreak(t.id)}
        />
      ))}
    </div>
  );
}

// 권한 없는 직책은 쓰기 대신 관계만 본다. NO_PERMISSION이 아닌 이유(예: 형식 1 월드)는 그 문장을 그대로 보인다.
function ReadOnlyWrite({ reason, code, list }: { reason: string; code: string; list: TreatyList }) {
  return (
    <div className={styles.readOnly}>
      <p role="note">{code === 'NO_PERMISSION' ? `${reason} 이 직책은 외교 문서를 읽기만 합니다.` : reason}</p>
      <RelationTable list={list} />
    </div>
  );
}

function RelationTable({ list }: { list: TreatyList }) {
  if (list.targets.length === 0) return <EmptyState title="다른 국가가 없습니다" />;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">국가</th>
          <th scope="col">우리와의 관계</th>
          <th scope="col">신의</th>
        </tr>
      </thead>
      <tbody>
        {list.targets.map((t) => (
          <tr key={t.nation.id}>
            <td>
              <NationBadge name={t.nation.name} color={t.nation.color} />
            </td>
            <td>{relationText(t)}</td>
            <td className="num">{t.trust.brokenTreaties}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TrustTable({
  query,
}: {
  query: { data?: { items: TrustRow[] } | undefined; isError: boolean; error: unknown; refetch: () => unknown };
}) {
  if (!query.data)
    return query.isError ? (
      <QueryError error={query.error} notFound="신의 기록을 찾을 수 없습니다" onRetry={() => void query.refetch()} />
    ) : (
      <LoadingState />
    );
  if (query.data.items.length === 0) return <EmptyState title="신의 기록이 있는 국가가 없습니다" />;
  return (
    <table className={styles.table} data-testid="trust-table">
      <caption className={styles.caption}>조약을 파기한 횟수입니다. 모든 국가가 같은 표를 봅니다.</caption>
      <thead>
        <tr>
          <th scope="col">국가</th>
          <th scope="col" className="num">
            파기
          </th>
          <th scope="col">마지막 파기</th>
        </tr>
      </thead>
      <tbody>
        {query.data.items.map((row) => (
          <tr key={row.nation.id}>
            <td>
              <NationBadge name={row.nation.name} color={row.nation.color} />
            </td>
            <td className="num">{row.brokenTreaties}회</td>
            <td>{formatYearMonth(row.lastBrokenAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
