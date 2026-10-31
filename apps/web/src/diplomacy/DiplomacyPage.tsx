import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { useMemo } from 'react';
import { errorCode, retryUnlessClientError } from '../game/errors';
import { formatYearMonth } from '../game/gameDate';
import { NoGeneral, QueryError } from '../game/QueryState';
import { useHome, useWorldId, useWorldMap } from '../game/queries';
import { useTRPC } from '../trpc';
import { serverMessage } from '../turns/apiError';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, ErrorState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import diplomacyIcon from '../art/icons/diplomacy.png';
import {
  fetchTreatyPage,
  type FinishedTreaty,
  type PendingAction,
  type TreatyItem,
  type TreatyListPage,
  type TreatyTarget,
} from './contract';
import styles from './Diplomacy.module.css';
import {
  actionLabel,
  finishedText,
  phaseText,
  recentText,
  requestsStorageKey,
  trackedFor,
  type Finished,
  type Tracked,
} from './requests';
import { nationName, TreatyCard } from './TreatyCard';
import { relationText, TreatyComposer } from './TreatyComposer';
import { useTreatyRequests } from './useTreatyRequests';

// 외교실 (T2-08, AC-M2-06). 받은 제안·보낸 제안·진행 중·끝남·조약서 쓰기를 탭으로 나눈다.
// 제안·수락·거절은 엔진이 처리한 뒤에 결과가 정해진다. 화면은 applied·rejected를 받기 전에는 성공 문구를 띄우지 않는다.
// 신의·파기는 월드가 켠 기능과 서버 권한을 따른다.

export const DIPLOMACY_TABS = ['nations', 'incoming', 'outgoing', 'active', 'ended', 'write', 'trust'] as const;
export type DiplomacyTab = (typeof DIPLOMACY_TABS)[number];

const TAB_LABELS: Record<DiplomacyTab, string> = {
  nations: '국가',
  incoming: '받은 제안',
  outgoing: '보낸 제안',
  active: '진행 중',
  ended: '끝남',
  write: '조약서 쓰기',
  trust: '신의',
};

export const parseDiplomacySearch = (search: Record<string, unknown>): { tab: DiplomacyTab } => ({
  tab: DIPLOMACY_TABS.includes(search.tab as DiplomacyTab) ? (search.tab as DiplomacyTab) : 'incoming',
});

// 탭마다 보일 조약. 목록 순서(조약 ID 내림차순)는 서버가 정한 그대로 둔다.
export function treatiesForTab(items: readonly TreatyItem[], tab: DiplomacyTab): TreatyItem[] {
  switch (tab) {
    case 'incoming':
      return items.filter((t) => t.status === 'PROPOSED' && t.incoming);
    case 'outgoing':
      return items.filter((t) => t.status === 'PROPOSED' && !t.incoming);
    case 'active':
      return items.filter((t) => t.status === 'ACTIVE');
    case 'ended':
      return items.filter(
        (t) => t.status === 'ENDED' || t.status === 'REJECTED' || t.status === 'EXPIRED' || t.status === 'BROKEN',
      );
    default:
      return [];
  }
}

// 불러온 쪽들의 조약을 이어 붙인다. 커서는 조약 ID라 쪽끼리 겹치지 않지만 같은 ID가 오면 앞의 것을 쓴다.
export function joinTreatyPages(pages: readonly TreatyListPage[]): TreatyItem[] {
  const seen = new Set<string>();
  const items: TreatyItem[] = [];
  for (const page of pages)
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  return items;
}

// 탭 수는 불러온 쪽만 센다. 다음 쪽이 남아 있으면 그렇다고 적는다.
export function pageCountText(loaded: number, hasMore: boolean): string {
  return hasMore
    ? `탭의 수는 지금까지 불러온 조약 ${loaded}개만 셉니다. 더 오래된 조약이 남아 있습니다.`
    : `탭의 수는 불러온 조약 ${loaded}개를 모두 셉니다.`;
}

// 끝난 요청의 조약 요약. 서버는 국가 ID만 주므로 이름은 호출자가 공개 지도에서 찾는다.
export const finishedTreatyText = (treaty: NonNullable<FinishedTreaty>, nation: (id: number) => string) =>
  `${nation(treaty.fromNationId)}·${nation(treaty.toNationId)}, 조항 ${treaty.clauses.length}개`;

const emptyText = (label: string, hasMore: boolean) =>
  hasMore ? `불러온 조약에는 ${label} 조약이 없습니다` : `${label} 조약이 없습니다`;

// 조약 카드의 처리 중 안내. 내 요청은 그 단계, 같은 국가 다른 장수의 요청은 treaty.list의 pending으로 본다.
export function busyText(
  treatyId: string,
  tracked: readonly Tracked[],
  pending: readonly PendingAction[],
): string | null {
  const mine = trackedFor(tracked, { treatyId });
  if (mine) return `${actionLabel(mine.action)} ${phaseText(mine.phase)}`;
  const other = pending.find((p) => p.kind !== 'treaty.propose' && p.treatyId === treatyId);
  return other ? `${other.requestedBy.name}의 요청을 처리하는 중입니다.` : null;
}

// 형식 1(legacy) 월드는 서버가 PRECONDITION_FAILED로 조약 조회를 막는다. 빈 목록으로 그리지 않고 그 문장을 보인다.
export function treatyListBlocked(error: unknown): string | null {
  return errorCode(error) === 'PRECONDITION_FAILED'
    ? (serverMessage(error) ?? '이 월드에서는 조약을 볼 수 없습니다.')
    : null;
}

const retryTreatyList = (failureCount: number, error: unknown) =>
  errorCode(error) !== 'PRECONDITION_FAILED' && retryUnlessClientError(failureCount, error);

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
    body = <Diplomacy key={storageKey} worldId={worldId} tab={tab} storageKey={storageKey} />;
  }

  return (
    <section className={styles.page}>
      <div className={styles.heading}>
        <img className="pixel-art" src={diplomacyIcon} alt="" width={48} height={48} />
        <h1>외교실</h1>
      </div>
      {body}
    </section>
  );
}

function Diplomacy({ worldId, tab, storageKey }: { worldId: string; tab: DiplomacyTab; storageKey: string }) {
  const trpc = useTRPC();
  const href = useRouterState({ select: (state) => state.location.href });
  const map = useWorldMap(worldId);
  const requests = useTreatyRequests(worldId, storageKey);
  const list = useInfiniteQuery({
    queryKey: trpc.treaty.list.infiniteQueryKey({ worldId }),
    queryFn: ({ pageParam, signal }) => fetchTreatyPage(worldId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 10_000,
    retry: retryTreatyList,
  });

  const pages = list.data?.pages;
  const head = pages?.[0];
  const items = useMemo(() => joinTreatyPages(pages ?? []), [pages]);
  const pending = head?.pending ?? [];

  // 끝난 요청의 조약은 국가 ID만 담는다. 이름은 공개 지도에서 찾는다. 지도에 없으면 없는 국가로 적는다.
  const nationLabel = (id: number) =>
    map.data ? nationName(map.data.nations.find((n) => n.id === id) ?? null, id) : `국가 ${id}`;
  const treatyName = (treatyId: string) => {
    const t = items.find((row) => row.id === treatyId);
    return t ? `${nationName(t.from, t.fromNationId)}·${nationName(t.to, t.toNationId)} 조약` : '조약';
  };
  const describeTarget = (t: Tracked) =>
    t.action.kind === 'treaty.propose'
      ? `${nationLabel(t.action.input.toNationId)}에 보낸`
      : treatyName(t.action.input.treatyId);

  const blocked = !head && list.isError ? treatyListBlocked(list.error) : null;
  const pageNote = head ? pageCountText(items.length, list.hasNextPage) : null;

  return (
    <>
      <RequestPanel
        tracked={requests.tracked}
        finished={requests.finished}
        describeTarget={describeTarget}
        nationLabel={nationLabel}
        loginHref={href}
        onResend={requests.resend}
        onDismiss={requests.dismiss}
      />

      <nav className={styles.tabs} aria-label="외교실 탭">
        {DIPLOMACY_TABS.map((key) => {
          if (key === 'trust' && !head?.breakEnabled) return null;
          const count = key === 'write' || !head ? null : treatiesForTab(items, key).length;
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
      {pageNote !== null ? (
        <p className={styles.muted} data-testid="treaty-page-note">
          {pageNote}
        </p>
      ) : null}

      {!head ? (
        blocked !== null ? (
          <div data-testid="treaty-unavailable">
            <ErrorState title={blocked} />
          </div>
        ) : list.isError ? (
          <QueryError error={list.error} notFound="외교 정보를 찾을 수 없습니다" onRetry={() => void list.refetch()} />
        ) : (
          <LoadingState />
        )
      ) : tab === 'nations' ? (
        <NationTable worldId={worldId} targets={head.targets} items={items} canPropose={head.canPropose.ok} />
      ) : tab === 'trust' ? (
        head.breakEnabled ? (
          <TrustTable worldId={worldId} />
        ) : (
          <EmptyState title="신의 기능을 쓰지 않는 월드입니다" />
        )
      ) : tab === 'write' ? (
        head.canPropose.ok ? (
          <TreatyComposer
            worldId={worldId}
            targets={head.targets}
            tradeEnabled={head.tradeEnabled === true}
            busyFor={(toNationId) => {
              const mine = trackedFor(requests.tracked, { toNationId });
              if (mine) return `이 상대에게 보낸 제안이 ${phaseText(mine.phase)}`;
              return pending.some((p) => p.kind === 'treaty.propose' && p.toNation?.id === toNationId)
                ? '같은 국가의 다른 장수가 이 상대에게 보낸 제안을 처리하는 중입니다.'
                : null;
            }}
            onPropose={(input) => requests.send({ kind: 'treaty.propose', input })}
          />
        ) : (
          <ReadOnlyWrite reason={head.canPropose.reason} code={head.canPropose.code} targets={head.targets} />
        )
      ) : (
        <>
          <TreatyList
            treaties={treatiesForTab(items, tab)}
            empty={emptyText(TAB_LABELS[tab], list.hasNextPage)}
            busy={(id) => busyText(id, requests.tracked, pending)}
            onRespond={(treatyId, accept) => requests.send({ kind: 'treaty.respond', input: { treatyId, accept } })}
            onBreak={(treatyId) => requests.send({ kind: 'treaty.break', input: { treatyId } })}
          />
          {list.hasNextPage ? (
            <div className={styles.buttons}>
              <button
                type="button"
                className={styles.secondary}
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? '불러오는 중' : '이전 조약 더 불러오기'}
              </button>
            </div>
          ) : null}
        </>
      )}

      {head && head.myRecent.length > 0 ? (
        <section className={styles.recent} aria-label="최근 처리된 내 요청">
          <h2>최근 처리된 내 요청</h2>
          <ul>
            {head.myRecent.map((r) => (
              <li key={r.requestId} data-request-id={r.requestId}>
                {recentText(r)}
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
  nationLabel,
  loginHref,
  onResend,
  onDismiss,
}: {
  tracked: readonly Tracked[];
  finished: readonly Finished[];
  describeTarget: (t: Tracked) => string;
  nationLabel: (id: number) => string;
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
            data-outcome={f.outcome ?? undefined}
            role={f.result === 'applied' ? 'status' : 'alert'}
            className={f.result === 'applied' ? styles.applied : styles.rejected}
          >
            {finishedText(f)}
            {f.treaty ? (
              <span className={styles.muted}>{` (${finishedTreatyText(f.treaty, nationLabel)})`}</span>
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
  busy,
  onRespond,
  onBreak,
}: {
  treaties: TreatyItem[];
  empty: string;
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
          busy={busy(t.id)}
          onRespond={(accept) => onRespond(t.id, accept)}
          onBreak={() => onBreak(t.id)}
        />
      ))}
    </div>
  );
}

// 국가 탭: 다른 국가마다 우리와의 관계와 이어 볼 곳을 한 줄에 둔다 (INT-20 외교실 시안).
// 이미 받은 treaty.list의 상대 목록과 조약만 쓴다. 마지막 파기는 신의 탭이 따로 조회하므로 여기에는 없다.
function NationTable({
  worldId,
  targets,
  items,
  canPropose,
}: {
  worldId: string;
  targets: TreatyTarget[];
  items: readonly TreatyItem[];
  canPropose: boolean;
}) {
  if (targets.length === 0) return <EmptyState title="다른 국가가 없습니다" />;
  const withNation = (id: number) => items.filter((t) => t.fromNationId === id || t.toNationId === id);
  return (
    <div className={styles.sheet}>
      <table className={styles.table} data-testid="nation-relations">
        <thead>
          <tr>
            <th scope="col">국가</th>
            <th scope="col">우리와의 관계</th>
            <th scope="col">이어 보기</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((target) => {
            const treaties = withNation(target.nation.id);
            const incoming = treaties.some((t) => t.status === 'PROPOSED' && t.incoming);
            const active = treaties.some((t) => t.status === 'ACTIVE');
            const next: { tab: DiplomacyTab; text: string } | null = incoming
              ? { tab: 'incoming', text: '받은 제안 보기' }
              : active
                ? { tab: 'active', text: '진행 중 조약 보기' }
                : canPropose
                  ? { tab: 'write', text: '조약서 쓰기' }
                  : null;
            return (
              <tr key={target.nation.id}>
                <td>
                  <NationBadge name={target.nation.name} color={target.nation.color} />
                </td>
                <td>
                  <RelationTag target={target} />
                </td>
                <td>
                  {next ? (
                    <Link
                      to="/w/$worldId/diplomacy"
                      params={{ worldId }}
                      search={{ tab: next.tab }}
                      className={styles.secondary}
                      aria-label={`${target.nation.name}: ${next.text}`}
                    >
                      {next.text}
                    </Link>
                  ) : (
                    <span className={styles.muted}>없음</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// 관계 꼬리표. 교전은 주칠, 불가침은 남색으로 채우고 글자를 함께 쓴다.
function RelationTag({ target }: { target: TreatyTarget }) {
  const tone = target.relation === 'WAR' ? 'danger' : target.relation === 'NON_AGGRESSION' ? 'info' : 'muted';
  return <Tag tone={tone}>{relationText(target)}</Tag>;
}

function TrustTable({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const trust = useQuery({
    ...trpc.treaty.trust.queryOptions({ worldId }),
    retry: retryUnlessClientError,
    refetchInterval: 10_000,
  });
  if (trust.isError)
    return (
      <QueryError error={trust.error} notFound="신의 기록을 찾을 수 없습니다" onRetry={() => void trust.refetch()} />
    );
  if (!trust.data) return <LoadingState />;
  return (
    <table className={styles.table} data-testid="trust-table">
      <thead>
        <tr>
          <th scope="col">국가</th>
          <th scope="col">조약 파기</th>
          <th scope="col">마지막 파기</th>
        </tr>
      </thead>
      <tbody>
        {trust.data.items.map((row) => (
          <tr key={row.nation.id}>
            <td>
              <NationBadge name={row.nation.name} color={row.nation.color} />
            </td>
            <td>{row.brokenTreaties}회</td>
            <td>{row.lastBrokenAt ? formatYearMonth(row.lastBrokenAt) : '없음'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 권한 없는 직책은 쓰기 대신 관계만 본다. NO_PERMISSION이 아닌 이유(예: 실행 중이 아닌 월드)는 그 문장을 그대로 보인다.
function ReadOnlyWrite({ reason, code, targets }: { reason: string; code: string; targets: TreatyTarget[] }) {
  return (
    <div className={styles.readOnly}>
      <p role="note">{code === 'NO_PERMISSION' ? `${reason} 이 직책은 외교 문서를 읽기만 합니다.` : reason}</p>
      <RelationTable targets={targets} />
    </div>
  );
}

function RelationTable({ targets }: { targets: TreatyTarget[] }) {
  if (targets.length === 0) return <EmptyState title="다른 국가가 없습니다" />;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">국가</th>
          <th scope="col">우리와의 관계</th>
        </tr>
      </thead>
      <tbody>
        {targets.map((t) => (
          <tr key={t.nation.id}>
            <td>
              <NationBadge name={t.nation.name} color={t.nation.color} />
            </td>
            <td>{relationText(t)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
