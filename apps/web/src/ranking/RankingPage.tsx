import { publicImageUrl } from '@opensamguk/shared/public-images';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../trpc';
import { displayName } from '../game/names';
const rankingIcon = publicImageUrl('apps/web/src/art/icons/ranking.png');
import { EmptyState, ErrorState } from '../ui/States';
import styles from './Ranking.module.css';
import { GeneralRankingTable, NationRankingTable } from './RankingTables';
import {
  defaultSearch,
  formatAt,
  parseRankingSearch,
  type GeneralKind,
  type GeneralSortKey,
  type NationSortKey,
  type RankingSearch,
} from './rankingView';
import { useRankingData, type RankingData } from './useRankingData';

const route = getRouteApi('/w/$worldId/ranking');

const TABS = [
  { tab: 'generals', label: '장수' },
  { tab: 'nations', label: '국가' },
] as const;

export function RankingPage() {
  const { worldId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const data = useRankingData(worldId, search);
  return (
    <RankingView
      search={search}
      data={data}
      onSort={(by) => void navigate({ search: parseRankingSearch({ ...search, by, page: 1 }), replace: true })}
      onKind={(kind) => void navigate({ search: parseRankingSearch({ ...search, kind, page: 1 }), replace: true })}
      onPage={(page) => void navigate({ search: parseRankingSearch({ ...search, page }) })}
      supplemental={
        search.tab === 'nations' ? <FreeGenerals worldId={worldId} /> : <HeritageRankings worldId={worldId} />
      }
      renderTab={(tab, label, active) => (
        <Link
          key={tab}
          to="/w/$worldId/ranking"
          params={{ worldId }}
          search={defaultSearch(tab)}
          className={`${styles.tab}${active ? ` ${styles.tabActive}` : ''}`}
          aria-current={active ? 'page' : undefined}
        >
          {label}
        </Link>
      )}
    />
  );
}

// 라우터 없이 시험할 수 있게 그리는 부분을 나눴다.
export function RankingView({
  search,
  data,
  onSort,
  renderTab,
  onKind,
  onPage,
  supplemental,
}: {
  search: RankingSearch;
  data: RankingData;
  onSort: (by: GeneralSortKey | NationSortKey) => void;
  renderTab: (tab: RankingSearch['tab'], label: string, active: boolean) => React.ReactNode;
  onKind?: (kind: GeneralKind) => void;
  onPage?: (page: number) => void;
  supplemental?: React.ReactNode;
}) {
  return (
    <section className={styles.page}>
      <div className={styles.head}>
        <img className="pixel-art" src={rankingIcon} alt="" width={48} height={48} />
        <h1>순위</h1>
        {data.state === 'ready' && data.ranking.at ? (
          <span className={styles.at}>{formatAt(data.ranking.at)}</span>
        ) : null}
      </div>
      <nav className={styles.tabs} aria-label="순위 종류">
        {TABS.map(({ tab, label }) => renderTab(tab, label, tab === search.tab))}
      </nav>
      {search.tab === 'generals' && onKind ? (
        <div className={styles.tabs} role="group" aria-label="장수 종류">
          {(
            [
              ['all', '전체'],
              ['human', '사람'],
              ['npc', 'NPC'],
            ] as const
          ).map(([kind, label]) => (
            <button
              key={kind}
              className={styles.tab}
              type="button"
              aria-pressed={(search.kind ?? 'all') === kind}
              onClick={() => onKind(kind)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <RankingBody search={search} data={data} onSort={onSort} />
      {onPage &&
      search.tab === 'generals' &&
      data.state === 'ready' &&
      data.tab === 'generals' &&
      data.ranking.pagination ? (
        <RankingPages {...data.ranking.pagination} onPage={onPage} />
      ) : null}
      {supplemental}
    </section>
  );
}

function RankingPages({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  return (
    <nav className={styles.tabs} aria-label="장수 순위 페이지">
      <button type="button" className={styles.tab} disabled={page === 1} onClick={() => onPage(page - 1)}>
        이전
      </button>
      <span aria-live="polite">
        {page} / {pageCount}
      </span>
      <button type="button" className={styles.tab} disabled={page === pageCount} onClick={() => onPage(page + 1)}>
        다음
      </button>
    </nav>
  );
}

function HeritageRankings({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.ranking.heritage.queryOptions({ worldId }));
  if (query.isPending || query.isError || (!query.data.spent.length && !query.data.earned.length)) return null;
  const { spent, earned, identitiesVisible } = query.data;
  return (
    <details>
      <summary>유산 포인트 순위</summary>
      {[
        { title: '유산 소모량', rows: spent },
        { title: '유산 획득량', rows: earned },
      ].map(({ title, rows }) => (
        <section key={title} aria-label={title}>
          <h3>{title}</h3>
          {rows.length ? (
            <ol>
              {rows.map(({ rank, name, nationName, points }) => (
                <li key={rank}>
                  {identitiesVisible ? (name === null ? '???' : displayName(name)) : '???'}
                  {' · '}
                  {identitiesVisible && name !== null ? (nationName ?? '재야') : '???'}
                  {' · '}
                  {points}점
                </li>
              ))}
            </ol>
          ) : (
            <p>아직 기록이 없습니다.</p>
          )}
        </section>
      ))}
    </details>
  );
}

function FreeGenerals({ worldId }: { worldId: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.ranking.freeGenerals.queryOptions({ worldId }));
  if (query.isPending) return <p role="status">재야 장수를 불러오는 중…</p>;
  if (query.isError) return <ErrorState title="재야 장수를 불러오지 못했습니다" onRetry={() => void query.refetch()} />;
  return (
    <details>
      <summary>재야 장수 {query.data.count}명</summary>
      {query.data.items.length > 0 ? (
        <ul>
          {query.data.items.map((general) => (
            <li key={general.id}>
              {displayName(general.name)}
              {general.isHuman ? '' : ' · NPC'}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

function RankingBody({
  search,
  data,
  onSort,
}: {
  search: RankingSearch;
  data: RankingData;
  onSort: (by: GeneralSortKey | NationSortKey) => void;
}) {
  if (data.state === 'loading') return <p role="status">순위를 불러오는 중…</p>;
  if (data.state === 'error') return <ErrorState title="순위를 불러오지 못했습니다" onRetry={data.retry} />;
  if (data.ranking.at === null) return <EmptyState title={formatAt(null)} />;

  if (data.tab === 'generals' && search.tab === 'generals') {
    if (data.ranking.top.length === 0) return <EmptyState title="순위에 오른 장수가 없습니다" />;
    return <GeneralRankingTable ranking={data.ranking} by={search.by} onSort={onSort} />;
  }
  if (data.tab === 'nations' && search.tab === 'nations') {
    if (data.ranking.items.length === 0) return <EmptyState title="순위에 오른 국가가 없습니다" />;
    return <NationRankingTable ranking={data.ranking} by={search.by} onSort={onSort} />;
  }
  return <p role="status">순위를 불러오는 중…</p>;
}
