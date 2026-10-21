import { getRouteApi, Link } from '@tanstack/react-router';
import { EmptyState, ErrorState } from '../ui/States';
import styles from './Ranking.module.css';
import { GeneralRankingTable, NationRankingTable } from './RankingTables';
import { defaultSearch, formatAt, type GeneralSortKey, type NationSortKey, type RankingSearch } from './rankingView';
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
      onSort={(by) => void navigate({ search: { tab: search.tab, by } as RankingSearch, replace: true })}
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
}: {
  search: RankingSearch;
  data: RankingData;
  onSort: (by: GeneralSortKey | NationSortKey) => void;
  renderTab: (tab: RankingSearch['tab'], label: string, active: boolean) => React.ReactNode;
}) {
  return (
    <section className={styles.page}>
      <div className={styles.head}>
        <h1>순위</h1>
        {data.state === 'ready' && data.ranking.at ? (
          <span className={styles.at}>{formatAt(data.ranking.at)}</span>
        ) : null}
      </div>
      <nav className={styles.tabs} aria-label="순위 종류">
        {TABS.map(({ tab, label }) => renderTab(tab, label, tab === search.tab))}
      </nav>
      <RankingBody search={search} data={data} onSort={onSort} />
    </section>
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
  if (data.state === 'waiting') {
    return <EmptyState title="순위 API를 기다리는 중입니다">T2-22가 합쳐지면 연결합니다.</EmptyState>;
  }
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
