import { Portrait } from '../portrait/Portrait';
import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
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
import {
  activityKey,
  activityLine,
  battleKey,
  battleText,
  flattenPages,
  groupByMonth,
  reviewLines,
  worldTimeline,
  yearbookSummary,
  type FeedMonth,
  type WorldItem,
} from './RecordsFeed';
import styles from './Records.module.css';

export type RecordKind = 'general' | 'nation' | 'world';
// 서버 사건 조회로 그리는 기록. RecordList가 아니라 ActivityFeed·BattleList가 그린다.
export type FeedKind = 'activity' | 'battles';
export const RECORD_LABELS: Record<RecordKind | FeedKind, string> = {
  activity: '장수 동향',
  battles: '전투 기록',
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
function useCursorPages<P extends { nextCursor: string | null }>(
  key: QueryKey,
  fetch: (cursor: string | undefined) => Promise<P>,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: [...key, 'pages'] as const,
    queryFn: ({ pageParam }) => fetch(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: P) => last.nextCursor ?? undefined,
    enabled,
    retry: retryUnlessClientError,
  });
}

const withCursor = <T extends object>(input: T, cursor: string | undefined) =>
  cursor === undefined ? input : { ...input, cursor };

function useRecords(kind: RecordKind, worldId: string, enabled: boolean) {
  const trpc = useTRPC();
  const procedures = {
    general: { key: trpc.records.general.queryKey({ worldId }), fetch: trpcClient.records.general.query },
    nation: { key: trpc.records.nation.queryKey({ worldId }), fetch: trpcClient.records.nation.query },
    world: { key: trpc.records.world.queryKey({ worldId }), fetch: trpcClient.records.world.query },
  } as const;
  const procedure = procedures[kind];
  return useCursorPages(
    procedure.key,
    (cursor) =>
      (procedure.fetch as (input: { worldId: string; cursor?: string }) => Promise<RecordPage>)(
        withCursor({ worldId }, cursor),
      ),
    enabled,
  );
}

// 장수 동향(scope all: 평판 사건 + 공개 국가 사건)과 중원 정세(scope world: 국가 사건만). 같은 procedure의 다른 입력이다.
function useActivity(worldId: string, scope: 'all' | 'world' | 'biography') {
  const trpc = useTRPC();
  return useCursorPages(trpc.records.activity.queryKey({ worldId, scope }), (cursor) =>
    trpcClient.records.activity.query(withCursor({ worldId, scope }, cursor)),
  );
}

function useBattles(worldId: string) {
  const trpc = useTRPC();
  return useCursorPages(trpc.records.battles.queryKey({ worldId }), (cursor) =>
    trpcClient.records.battles.query(withCursor({ worldId }, cursor)),
  );
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
  worldLines = true,
}: {
  kind: RecordKind;
  worldId: string;
  clock: Clock;
  nations: readonly MapNation[];
  // 중원 정세 글줄의 도시 이름. 없으면 도시 번호로 쓴다.
  cities?: readonly Pick<MapCity, 'key' | 'name'>[];
  hasNation?: boolean;
  compact?: boolean;
  // 연감 달마다 앞 달과 견준 영토 글줄과 월단평 머리글을 쓸지. 서버 사건(WorldFeed)이 있으면 끈다.
  worldLines?: boolean;
}) {
  const enabled = kind !== 'nation' || hasNation;
  const query = useRecords(kind, worldId, enabled);
  if (!enabled) return <EmptyState title="소속 국가가 없습니다" />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    if (errorCode(query.error) === 'NOT_FOUND' && kind !== 'world') return <NoGeneral worldId={worldId} />;
    return <QueryError error={query.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void query.refetch()} />;
  }
  const body = renderRecords(kind, query.data.pages, clock, nations, cities, compact, worldLines);
  return (
    <div className={compact ? `${styles.records} ${styles.compact}` : styles.records} data-record-kind={kind}>
      {body ?? <EmptyState title={emptyText[kind]} />}
      <MoreButton query={query} />
    </div>
  );
}

interface PagedQuery {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
}

// 다음 30개를 이어 받는 단추와 그 실패 안내. 받은 줄은 그대로 두고 아래에 붙인다.
function MoreButton({ query }: { query: PagedQuery }) {
  return (
    <>
      {query.isFetchNextPageError ? <p className={styles.error}>다음 기록을 불러오지 못했습니다.</p> : null}
      {query.hasNextPage ? (
        <button
          type="button"
          className={styles.more}
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? '불러오는 중' : '더 보기'}
        </button>
      ) : null}
    </>
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
  worldLines: boolean,
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
  return <WorldHistoryList items={items} nations={nations} cities={cities} compact={compact} lines={worldLines} />;
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

// 연감 목록. 기록 화면의 월별 세력은 달마다 세력 크기만(lines=false) 보인다.
// 서버 사건 조회(records.activity)를 못 쓸 때만 메인 중원 정세가 이 목록으로 돌아와, 달마다 앞 달과 도시 소유를 견주어
// 글줄을 만든다(compact). 이때는 글줄만 보인다.
export function WorldHistoryList({
  items,
  nations,
  cities = [],
  compact = false,
  lines: withLines = true,
}: {
  items: readonly WorldItem[];
  nations: readonly MapNation[];
  cities?: readonly Pick<MapCity, 'key' | 'name'>[];
  compact?: boolean;
  lines?: boolean;
}) {
  const byId = new Map(nations.map((nation) => [nation.id, nation]));
  const cityName = new Map(cities.map((city) => [city.key, city.name]));
  const names = {
    nation: (id: number) => byId.get(id)?.name,
    city: (key: number) => cityName.get(key) ?? `도시 ${key}`,
  };
  const months = items.map((item, i) => ({
    item,
    lines: withLines
      ? [...(item.review ? [`월단평: ${item.review.headline}`] : []), ...worldEvents(item, items[i + 1], names)]
      : [],
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
                        {'power' in entry && typeof entry.power === 'number'
                          ? ` · 국력 ${entry.power.toLocaleString('ko-KR')}`
                          : ''}
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

// 달마다 묶은 사건 글줄. 장수 동향은 줄 앞에 소속 국가 이름표를 붙인다.
function FeedList({ months, testId }: { months: readonly FeedMonth[]; testId: string }) {
  return (
    <ol className={styles.lines} data-testid={testId}>
      {months.map((month) => (
        <li key={month.key} className={styles.yearbook} data-feed-month={`${month.year}-${month.month}`}>
          <span className={`num ${styles.date}`}>
            {month.year}년 {month.month}월
          </span>
          <span className={styles.events}>
            {month.lines.map((line) => (
              <span
                key={line.key}
                className={styles.event}
                data-feed-source={line.source}
                data-feed-kind={line.kind}
                data-testid={line.source === 'review' ? 'world-review-headline' : undefined}
              >
                {line.portrait ? (
                  <Portrait id={line.portrait.id} name={line.portrait.name} variant="icon" size={20} decorative />
                ) : null}
                {line.nation ? <NationBadge name={line.nation.name} color={line.nation.color} /> : null}
                {line.nation ? ' ' : null}
                {line.text}
              </span>
            ))}
          </span>
        </li>
      ))}
    </ol>
  );
}

const feedClass = (compact: boolean) => (compact ? `${styles.records} ${styles.compact}` : styles.records);

// 장수 동향 (원작 메인 첫 칸). 온 세상 장수의 공개 평판 사건과 건국·멸망·선전포고·점령을 최신순으로 쓴다.
export function ActivityFeed({
  worldId,
  compact = false,
  biography = false,
}: {
  worldId: string;
  compact?: boolean;
  biography?: boolean;
}) {
  const query = useActivity(worldId, biography ? 'biography' : 'all');
  if (query.isPending) return <LoadingState />;
  if (query.isError)
    return <QueryError error={query.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void query.refetch()} />;
  const lines = flattenPages(query.data.pages, activityKey).map(activityLine);
  return (
    <div className={feedClass(compact)} data-record-kind="activity">
      {lines.length > 0 ? (
        <FeedList months={groupByMonth(lines)} testId="activity-feed" />
      ) : (
        <EmptyState title={biography ? '열전에 기록된 점령·승전이 없습니다' : '장수 동향이 아직 없습니다'} />
      )}
      <MoreButton query={query} />
    </div>
  );
}

// 중원 정세 (원작 메인 셋째 칸). 서버가 남긴 국가 사건 문장을 최신순으로 쓰고, 그 사이에 월단평 머리글을 끼운다.
// 사건 조회를 못 쓰면(옛 서버·꺼진 기능·오류) 예전처럼 연감 두 달을 견준 글줄로 돌아간다.
export function WorldFeed({
  worldId,
  clock,
  nations,
  cities = [],
  compact = false,
}: {
  worldId: string;
  clock: Clock;
  nations: readonly MapNation[];
  cities?: readonly Pick<MapCity, 'key' | 'name'>[];
  compact?: boolean;
}) {
  const events = useActivity(worldId, 'world');
  const yearbook = useRecords('world', worldId, true);
  if (events.isError)
    return <RecordList kind="world" worldId={worldId} clock={clock} nations={nations} cities={cities} compact />;
  if (events.isPending) return <LoadingState />;
  const months = yearbook.data?.pages.flatMap((page) => page.items as WorldItem[]) ?? [];
  const lines = worldTimeline(
    flattenPages(events.data.pages, activityKey).map(activityLine),
    reviewLines(months),
    events.hasNextPage,
  );
  const latest = months[0];
  return (
    <div className={feedClass(compact)} data-record-kind="world-events">
      {lines.length > 0 ? (
        <FeedList months={groupByMonth(lines)} testId="world-feed" />
      ) : compact && latest ? (
        <ol className={styles.lines}>
          <li className={styles.yearbook}>
            <span className={`num ${styles.date}`}>
              {latest.year}년 {latest.month}월
            </span>
            <span className={styles.text}>{yearbookSummary(latest)}</span>
          </li>
        </ol>
      ) : compact && yearbook.isPending ? (
        <LoadingState />
      ) : (
        <EmptyState title="중원 정세 사건이 아직 없습니다" />
      )}
      <MoreButton query={events} />
    </div>
  );
}

// 전투 기록 (기록 화면 탭). 내 장수가 치르거나 받은 교전 보고를 최신순으로 쓴다.
export function BattleList({ worldId }: { worldId: string }) {
  const query = useBattles(worldId);
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    if (errorCode(query.error) === 'NOT_FOUND') return <NoGeneral worldId={worldId} />;
    return <QueryError error={query.error} notFound="월드를 찾을 수 없습니다" onRetry={() => void query.refetch()} />;
  }
  const items = flattenPages(query.data.pages, battleKey);
  return (
    <div className={styles.records} data-record-kind="battles">
      {items.length > 0 ? (
        <ol className={styles.lines}>
          {items.map((item) => (
            <li key={battleKey(item)} className={styles.line} data-battle-tick={item.tick}>
              <span className={`num ${styles.date}`}>{formatYearMonth(item.gameDate)}</span>
              <span className={styles.text}>
                <Portrait id={item.portraitId} name="공격 장수" variant="icon" size={20} decorative />{' '}
                {battleText(item.text)}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState title="전투 기록이 아직 없습니다" />
      )}
      <MoreButton query={query} />
    </div>
  );
}
