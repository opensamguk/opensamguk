import { useInfiniteQuery } from '@tanstack/react-query';
import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';
import { retryUnlessClientError, errorCode } from '../game/errors';
import { formatYearMonth, personalLogDate, tickDate } from '../game/gameDate';
import { NoGeneral, QueryError } from '../game/QueryState';
import type { MapCity, MapNation, WorldSummary } from '../game/types';
import { trpcClient, useTRPC } from '../trpc';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import { ValueDelta } from '../ui/ValueDelta';
import { worldEvents } from './infoView';
import styles from './Records.module.css';

export type RecordKind = 'general' | 'nation' | 'world';
export const RECORD_LABELS: Record<RecordKind, string> = {
  general: '개인 기록',
  nation: '국가 기록',
  world: '중원 정세',
};

type Clock = Pick<WorldSummary, 'startYear' | 'gameDate' | 'nowTick' | 'msPerTick' | 'turnTermMinutes'> | undefined;
const dateOf = (tick: number, clock: Clock) => (clock ? formatYearMonth(tickDate(tick, clock)) : '—');
const logDateOf = (tick: number, clock: Clock) => (clock ? formatYearMonth(personalLogDate(tick, clock)) : '—');
const n = (value: number) => value.toLocaleString('ko-KR');

// 기록 조회. tRPC의 infiniteQueryOptions는 입력에 direction을 덧붙이는데 서버의 기록 입력은 strict라 거부한다.
// 그래서 커서만 넣어 직접 부르고, 쿼리 키는 같은 procedure 아래에 둬 records 무효화에 함께 걸리게 한다.
function useRecords(kind: RecordKind, worldId: string, enabled: boolean) {
  const trpc = useTRPC();
  const procedures = {
    general: { key: trpc.records.general.queryKey({ worldId }), fetch: trpcClient.records.general.query },
    nation: { key: trpc.records.nation.queryKey({ worldId }), fetch: trpcClient.records.nation.query },
    world: { key: trpc.records.world.queryKey({ worldId }), fetch: trpcClient.records.world.query },
  } as const;
  const procedure = procedures[kind];
  return useInfiniteQuery({
    queryKey: [...procedure.key, 'pages'] as const,
    queryFn: ({ pageParam }) =>
      (procedure.fetch as (input: { worldId: string; cursor?: string }) => Promise<RecordPage>)(
        pageParam === undefined ? { worldId } : { worldId, cursor: pageParam },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: RecordPage) => last.nextCursor ?? undefined,
    enabled,
    retry: retryUnlessClientError,
  });
}

interface RecordPage {
  items: unknown[];
  nextCursor: string | null;
}

// 기록 한 종류를 보여 준다. 최신순 30개씩 받고 더 보기로 이어 받는다. 메인 안에서 늘어나며 다른 화면으로 가지 않는다.
export function RecordList({
  kind,
  worldId,
  clock,
  nations,
  cities = [],
  hasNation = true,
  compact = false,
}: {
  kind: RecordKind;
  worldId: string;
  clock: Clock;
  nations: readonly MapNation[];
  // 중원 정세 글줄의 도시 이름. 없으면 도시 번호로 쓴다.
  cities?: readonly Pick<MapCity, 'key' | 'name'>[];
  hasNation?: boolean;
  compact?: boolean;
}) {
  const enabled = kind !== 'nation' || hasNation;
  const query = useRecords(kind, worldId, enabled);
  if (!enabled) return <EmptyState title="소속 국가가 없습니다" />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    if (errorCode(query.error) === 'NOT_FOUND' && kind !== 'world') return <NoGeneral worldId={worldId} />;
    return <QueryError error={query.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void query.refetch()} />;
  }
  const pages = query.data.pages;
  const more = query.hasNextPage ? (
    <button
      type="button"
      className={styles.more}
      disabled={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}
    >
      {query.isFetchingNextPage ? '불러오는 중' : '더 보기'}
    </button>
  ) : null;
  const body = renderRecords(kind, pages, clock, nations, cities, compact);
  return (
    <div className={compact ? `${styles.records} ${styles.compact}` : styles.records} data-record-kind={kind}>
      {body ?? <EmptyState title={emptyText[kind]} />}
      {query.isFetchNextPageError ? <p className={styles.error}>다음 기록을 불러오지 못했습니다.</p> : null}
      {more}
    </div>
  );
}

const emptyText: Record<RecordKind, string> = {
  general: '아직 기록이 없습니다',
  nation: '국가 기록이 아직 없습니다. 월간 정산 뒤에 쌓입니다',
  world: '중원 정세가 아직 없습니다. 월간 정산 뒤에 쌓입니다',
};

type Pages = Array<{ items: unknown[] }>;

function renderRecords(
  kind: RecordKind,
  pages: Pages,
  clock: Clock,
  nations: readonly MapNation[],
  cities: readonly Pick<MapCity, 'key' | 'name'>[],
  compact: boolean,
) {
  if (kind === 'general') {
    const items = pages.flatMap((page) => page.items as GeneralItem[]);
    if (items.length === 0) return null;
    return <GeneralLogList items={items} clock={clock} />;
  }
  if (kind === 'nation') {
    const items = pages.flatMap((page) => page.items as NationItem[]);
    if (items.length === 0) return null;
    return <NationHistoryTable items={items} clock={clock} />;
  }
  const items = pages.flatMap((page) => page.items as WorldItem[]);
  if (items.length === 0) return null;
  return <WorldHistoryList items={items} nations={nations} cities={cities} compact={compact} />;
}

interface GeneralItem {
  id: string;
  tick: number;
  commandKey: string;
  kind: string;
  text: string;
}
interface NationItem {
  tick: number;
  nationId: number;
  cities: number;
  generals: number;
  gold: number;
  rice: number;
}
type WorldItem = inferRouterOutputs<AppRouter>['records']['world']['items'][number];

export function GeneralLogList({ items, clock }: { items: readonly GeneralItem[]; clock: Clock }) {
  return (
    <ol className={styles.lines}>
      {items.map((item) => (
        <li key={item.id} className={styles.line} data-log-kind={item.kind}>
          <span className={`num ${styles.date}`}>{logDateOf(item.tick, clock)}</span>
          {item.kind === 'failure' ? <Tag tone="danger">실패</Tag> : null}
          <span className={styles.text}>{item.text}</span>
        </li>
      ))}
    </ol>
  );
}

function NationHistoryTable({ items, clock }: { items: readonly NationItem[]; clock: Clock }) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">연월</th>
            <th scope="col" className="num">
              속령
            </th>
            <th scope="col" className="num">
              장수
            </th>
            <th scope="col" className="num">
              국고
            </th>
            <th scope="col" className="num">
              군량
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => {
            const older = items[i + 1];
            return (
              <tr key={item.tick}>
                <td className={`num ${styles.dateCell}`}>{dateOf(item.tick, clock)}</td>
                <td className="num">
                  {n(item.cities)} {older ? <ValueDelta value={item.cities - older.cities} /> : null}
                </td>
                <td className="num">
                  {n(item.generals)} {older ? <ValueDelta value={item.generals - older.generals} /> : null}
                </td>
                <td className="num">
                  {n(item.gold)} {older ? <ValueDelta value={item.gold - older.gold} /> : null}
                </td>
                <td className="num">
                  {n(item.rice)} {older ? <ValueDelta value={item.rice - older.rice} /> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// 중원 정세 (원작 메인의 중원 정세 칸). 서버 연감에는 사건 글이 없어 달마다 앞 달과 도시 소유를 견주어 글줄을 만든다.
// 메인(compact)은 글줄만, 기록 화면은 글줄 아래 그 달의 세력 크기를 함께 보인다.
export function WorldHistoryList({
  items,
  nations,
  cities = [],
  compact = false,
}: {
  items: readonly WorldItem[];
  nations: readonly MapNation[];
  cities?: readonly Pick<MapCity, 'key' | 'name'>[];
  compact?: boolean;
}) {
  const byId = new Map(nations.map((nation) => [nation.id, nation]));
  const cityName = new Map(cities.map((city) => [city.key, city.name]));
  const names = {
    nation: (id: number) => byId.get(id)?.name,
    city: (key: number) => cityName.get(key) ?? `도시 ${key}`,
  };
  const months = items.map((item, i) => ({
    item,
    lines: [...(item.review ? [`월단평: ${item.review.headline}`] : []), ...worldEvents(item, items[i + 1], names)],
  }));
  const shown = compact ? months.filter((month) => month.lines.length > 0) : months;
  // 메인에서 불러온 달에 변화가 하나도 없으면 가장 최근 달의 세력 수만 한 줄로 쓴다.
  if (shown.length === 0 && months[0]) {
    const latest = months[0].item;
    return (
      <ol className={styles.lines}>
        <li className={styles.yearbook}>
          <span className={`num ${styles.date}`}>
            {latest.year}년 {latest.month}월
          </span>
          <span className={styles.text}>
            영토 변화 없음 · 세력 {latest.nations.filter((x) => x.cities > 0).length}곳 · 공백지{' '}
            {latest.cities.filter((city) => city.nationId === null).length}성
          </span>
        </li>
      </ol>
    );
  }
  return (
    <ol className={styles.lines}>
      {shown.map(({ item, lines }) => {
        const ranked = [...item.nations].filter((x) => x.cities > 0).sort((a, b) => b.cities - a.cities);
        const empty = item.cities.filter((city) => city.nationId === null).length;
        return (
          <li key={item.tick} className={styles.yearbook} data-world-month={`${item.year}-${item.month}`}>
            <span className={`num ${styles.date}`}>
              {item.year}년 {item.month}월
            </span>
            {lines.length > 0 ? (
              <span className={styles.events}>
                {lines.map((line) => (
                  <span
                    key={line}
                    className={styles.event}
                    data-testid={line.startsWith('월단평:') ? 'world-review-headline' : undefined}
                  >
                    {line}
                  </span>
                ))}
              </span>
            ) : null}
            {compact ? null : (
              <span className={styles.nations}>
                {ranked.map((entry) => {
                  const nation = byId.get(entry.nationId);
                  return (
                    <span key={entry.nationId} className={styles.nationEntry}>
                      <NationBadge name={nation?.name ?? `국가 ${entry.nationId}`} color={nation?.color ?? null} />
                      <span className="num">
                        {entry.cities}성 {entry.generals}명
                      </span>
                    </span>
                  );
                })}
                <span className={styles.nationEntry}>공백지 {empty}성</span>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
