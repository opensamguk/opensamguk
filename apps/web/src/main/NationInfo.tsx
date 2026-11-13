import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { retryUnlessClientError } from '../game/errors';
import { formatYearMonth, personalLogDate } from '../game/gameDate';
import { displayName, officerName } from '../game/names';
import { useWorldMap, useWorldRules, useWorldSummary } from '../game/queries';
import { QueryError } from '../game/QueryState';
import { isDetailedGeneral, isMemberNation, type Home, type MapCity, type NationView } from '../game/types';
import { NationNoticeBox } from '../messages/NationNotice';
import { useTRPC } from '../trpc';
import { DataTable, type Column } from '../ui/DataTable';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState, LoadingState } from '../ui/States';
import { Tag } from '../ui/Tag';
import { GeneralNameCell } from './CityInfo';
import { displayedAge } from './GeneralInfo';
import { armyOf, cityLevelText, nationHeads, nationTotals, techText, type ArmyFields } from './infoView';
import { InfoGrid } from './Panel';
import { unitNameOf } from './UnitName';
import styles from './NationInfo.module.css';

const HIDDEN_NATION = '다른 국가 정보';
const n = (value: number) => value.toLocaleString('ko-KR');

type NationSummary = NonNullable<Home['nation']> | NationView;
type NationGenerals = NationView['generals'];
// 공개 국력과 순위 (ranking.nations, 달마다 찍은 값). 아직 정산 전이면 null이다.
export type NationPower = { power: number; rank: number; at: string } | null;

// 국가 요약 칸이다. 원작 국가 카드처럼 군주·참모·총 병사·국력을 앞에 둔다.
// 소속국만 국고·군량·세율·기술과 장수 직책·병력을 받는다. 다른 국가는 —와 이유를 보여 준다.
export function NationSummaryGrid({
  nation,
  capitalName,
  generals,
  power,
}: {
  nation: NationSummary;
  capitalName?: string | undefined;
  generals?: NationGenerals | undefined;
  power?: NationPower | undefined;
}) {
  const member = isMemberNation(nation);
  const hidden = { value: '—', title: HIDDEN_NATION };
  const detailed = generals?.filter(isDetailedGeneral) ?? [];
  const heads = generals ? nationHeads(detailed) : undefined;
  const totals = member && generals ? nationTotals(detailed) : null;
  const headValue = (name: string | null | undefined) => (name ? displayName(name) : '—');
  return (
    <InfoGrid
      items={[
        member ? { label: '군주', value: headValue(heads?.ruler) } : { label: '군주', ...hidden },
        member ? { label: '참모', value: headValue(heads?.advisor) } : { label: '참모', ...hidden },
        { label: '속령', value: n(nation.cityCount) },
        { label: '장수', value: n(nation.generalCount) },
        member
          ? {
              label: '총 병사',
              value: totals ? `${n(totals.troops)} / ${n(totals.maxTroops)}` : '—',
              title: '소속 장수 병력 합계 / 통솔 합계 × 100',
            }
          : { label: '총 병사', ...hidden },
        power
          ? { label: '국력', value: `${n(power.power)} · ${power.rank}위`, title: power.at }
          : { label: '국력', value: '—', title: '월간 정산 뒤에 보입니다' },
        member ? { label: '국고', value: n(nation.gold) } : { label: '국고', ...hidden },
        member ? { label: '군량', value: n(nation.rice) } : { label: '군량', ...hidden },
        member ? { label: '세율', value: `${Math.round(nation.taxRate * 100)}%` } : { label: '세율', ...hidden },
        member ? { label: '기술', value: techText(nation.tech) } : { label: '기술', ...hidden },
        // 수도는 지도 응답(world.map)에 모든 국가 것이 있어 다른 국가도 보인다 (원작 세력일람의 [수도]).
        { label: '수도', value: capitalName ?? '—' },
        member ? { label: '성향', value: nation.philosophy || '—' } : { label: '성향', ...hidden },
      ]}
    />
  );
}

export function useNation(worldId: string, nationId: number, enabled = true) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.nation.get.queryOptions({ worldId, nationId }), enabled, retry: retryUnlessClientError });
}

// 공개 국력과 그 순위. 순위 화면과 같은 조회(ranking.nations, 국력 기준)에서 이 국가 줄을 읽는다.
export function useNationPower(worldId: string, nationId: number | null): NationPower | undefined {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.ranking.nations.queryOptions({ worldId, by: 'power' }),
    enabled: nationId !== null,
    retry: retryUnlessClientError,
    staleTime: 60_000,
  });
  if (!query.data) return undefined;
  const at = query.data.at;
  const row = query.data.items.find((item) => item.nationId === nationId);
  return row && at ? { power: row.power, rank: row.rank, at: `${at.year}년 ${at.month}월 정산 기준` } : null;
}

// 모든 국가의 수도 이름. 지도 응답의 capitalCityKey를 쓴다.
export function capitalNameOf(map: ReturnType<typeof useWorldMap>['data'], nationId: number) {
  const key = map?.nations.find((nation) => nation.id === nationId)?.capitalCityKey;
  return key == null ? undefined : map?.cities.find((city) => city.key === key)?.name;
}

// 국가 소개와 방랑 표시. 소개는 시나리오가 준 국가 설명(소속국만 받는다), 방랑은 nation-lifecycle-v1 월드의 기한이다.
export function NationExtras({ worldId, nation }: { worldId: string; nation: NationSummary | NationView }) {
  const summary = useWorldSummary(worldId).data;
  const map = useWorldMap(worldId).data;
  const wandering = 'wandering' in nation ? nation.wandering : null;
  const description = isMemberNation(nation) ? nation.description.trim() : '';
  const generals: NationGenerals = 'generals' in nation ? (nation.generals as NationGenerals) : [];
  const ruler = generals.filter(isDetailedGeneral).find((g) => g.officerLevel === 12);
  const rulerCity = ruler ? map?.cities.find((city) => city.key === ruler.cityKey)?.name : undefined;
  if (!wandering && description === '') return null;
  return (
    <div className={styles.extras}>
      {wandering ? (
        <p className={styles.extraLine} data-testid="nation-wandering">
          <Tag tone="warning">방랑 중</Tag>
          <span>
            {summary ? `${formatYearMonth(personalLogDate(wandering.expiresTick, summary))}까지` : '기한 확인 중'}
            {rulerCity ? ` · 현재 위치 ${rulerCity}` : ''}
          </span>
        </p>
      ) : null}
      {description ? (
        <p className={styles.extraLine} data-testid="nation-description">
          <span className={styles.extraLabel}>국가 소개</span>
          <span>{description}</span>
        </p>
      ) : null}
    </div>
  );
}

// 메인의 국가 정보 칸. 요약만 보이고, 소속 장수·소유 도시 표와 통치는 전용 화면 링크로 잇는다 (INT-25).
export function NationInfo({
  worldId,
  nation,
  cities,
}: {
  worldId: string;
  nation: Home['nation'];
  cities: readonly MapCity[];
}) {
  const detail = useNation(worldId, nation?.id ?? 1, nation !== null);
  const power = useNationPower(worldId, nation?.id ?? null);
  // 통치(황실·정통성)는 전용 화면으로 옮겼다 (INT-25). 재야 장수도 링크로 공개 정보를 본다.
  if (nation === null)
    return (
      <>
        <EmptyState title="재야입니다">국가에 임관하면 국고·군량과 소속 장수를 여기서 봅니다.</EmptyState>
        <p className={styles.links}>
          <Link to="/w/$worldId/nation/governance" params={{ worldId }}>
            통치
          </Link>
        </p>
      </>
    );
  const capital = isMemberNation(nation) ? cities.find((city) => city.key === nation.capitalCityKey) : undefined;
  return (
    <div className={styles.nation} data-nation-id={nation.id}>
      <div className={styles.title} style={{ background: nation.color }}>
        <NationBadge name={nation.name} color={nation.color} />
        <Link
          to="/w/$worldId/nation/$nationId"
          params={{ worldId, nationId: String(nation.id) }}
          className={styles.more}
        >
          국가 화면
        </Link>
      </div>
      <NationSummaryGrid nation={nation} capitalName={capital?.name} generals={detail.data?.generals} power={power} />
      <NationExtras worldId={worldId} nation={detail.data ?? nation} />
      {/* 소속 장수·도시 표와 통치는 전용 화면으로 옮겼다 (INT-25). */}
      <p className={styles.links}>
        <Link to="/w/$worldId/nation/$nationId" params={{ worldId, nationId: String(nation.id) }}>
          세력 장수 {n(nation.generalCount)}명
        </Link>
        <Link to="/w/$worldId/nation/$nationId" params={{ worldId, nationId: String(nation.id) }} hash="cities">
          세력 도시 {n(nation.cityCount)}곳
        </Link>
        <Link to="/w/$worldId/nation/governance" params={{ worldId }}>
          통치
        </Link>
      </p>
      <NationNoticeBox worldId={worldId} />
    </div>
  );
}

// 소속 장수 합계 (원작 암행부 요약 표). 같은 국가 장수의 금·쌀·병력을 화면에서 더한다.
export function NationTotalsGrid({ generals }: { generals: NationGenerals }) {
  const totals = nationTotals(generals.filter(isDetailedGeneral));
  const ready = (row: { troops: number; count: number }) => `${n(row.troops)}명 (${n(row.count)}장수)`;
  return (
    <div data-testid="nation-totals">
      <InfoGrid
        items={[
          { label: '장수 금', value: `${n(totals.gold)} (평균 ${n(totals.averageGold)})` },
          { label: '장수 쌀', value: `${n(totals.rice)} (평균 ${n(totals.averageRice)})` },
          { label: '병력', value: `${n(totals.troops)} / ${n(totals.maxTroops)}` },
          { label: '병력 있는 장수', value: `${n(totals.withTroops)} / ${n(totals.count)}명` },
          { label: '훈련·사기 90 이상', value: ready(totals.ready90) },
          { label: '훈련·사기 80 이상', value: ready(totals.ready80) },
          { label: '훈련·사기 60 이상', value: ready(totals.ready60) },
        ]}
      />
    </div>
  );
}

// 국가의 소유 도시·소속 장수 표. 관리가 필요한 칸은 글자 표시와 색을 함께 쓴다.
export function NationTables({
  worldId,
  nationId,
  onSelectCity,
}: {
  worldId: string;
  nationId: number;
  onSelectCity?: (key: number) => void;
}) {
  const query = useNation(worldId, nationId);
  const map = useWorldMap(worldId).data;
  const summary = useWorldSummary(worldId).data;
  const crewTypes = useWorldRules(worldId).data?.unitSet.crewTypes;
  if (query.isPending) return <LoadingState />;
  if (query.isError)
    return <QueryError error={query.error} notFound="없는 국가입니다" onRetry={() => void query.refetch()} />;
  const data = query.data;
  const campaign = 'campaignEnabled' in data && data.campaignEnabled;
  const fiveStats = 'fiveStats' in data && data.fiveStats;
  // 수도는 지도 응답에 모든 국가 것이 있다. 소속국 응답의 값을 먼저 쓴다.
  const capitalKey = isMemberNation(data)
    ? data.capitalCityKey
    : (map?.nations.find((nation) => nation.id === nationId)?.capitalCityKey ?? null);
  const cityName = new Map(data.cities.map((city) => [city.key, city.name]));
  type City = (typeof data.cities)[number];
  type General = (typeof data.generals)[number];
  // 도시별 배치 장수 (원작 세력 도시의 장수 목록). 위치는 같은 국가 장수만 온다.
  const stationed = new Map<number, string[]>();
  for (const general of data.generals)
    if (isDetailedGeneral(general))
      stationed.set(general.cityKey, [...(stationed.get(general.cityKey) ?? []), displayName(general.name)]);
  const member = isMemberNation(data);

  const cityColumns: Column<City>[] = [
    {
      key: 'name',
      label: '도시',
      sortValue: (c) => c.name,
      render: (c) =>
        onSelectCity ? (
          <button type="button" className={styles.cityButton} onClick={() => onSelectCity(c.key)}>
            {c.name}
          </button>
        ) : (
          <Link to="/w/$worldId/city/$cityKey" params={{ worldId, cityKey: String(c.key) }}>
            {c.name}
          </Link>
        ),
    },
    {
      key: 'level',
      label: '규모',
      numeric: true,
      sortValue: (c) => c.level,
      render: (c) => cityLevelText(c.level),
    },
    {
      key: 'generals',
      label: '장수',
      numeric: true,
      sortValue: (c) => (member ? (stationed.get(c.key)?.length ?? 0) : null),
      render: (c) => (member ? n(stationed.get(c.key)?.length ?? 0) : '—'),
      title: (c) => (member ? stationed.get(c.key)?.join(', ') : HIDDEN_NATION),
    },
    {
      key: 'state',
      label: '상태',
      sortValue: (c) => (c.supplied ? 1 : 0),
      render: (c) => (
        <span className={styles.tags}>
          {c.key === capitalKey ? <Tag tone="accent">수도</Tag> : null}
          {c.supplied ? null : <Tag tone="danger">보급 끊김</Tag>}
        </span>
      ),
    },
  ];

  const hidden = (g: General) => (isDetailedGeneral(g) ? undefined : HIDDEN_NATION);
  const num = (pick: (g: Extract<General, { leadership: number }>) => number | undefined) => ({
    numeric: true,
    sortValue: (g: General) => (isDetailedGeneral(g) ? (pick(g) ?? null) : null),
    render: (g: General) => (isDetailedGeneral(g) ? (pick(g)?.toLocaleString('ko-KR') ?? '—') : '—'),
    title: hidden,
  });
  const text = (pick: (g: Extract<General, { leadership: number }>) => string | null) => ({
    sortValue: (g: General) => (isDetailedGeneral(g) ? pick(g) : null),
    render: (g: General) => (isDetailedGeneral(g) ? pick(g) || '—' : '—'),
  });
  const generalColumns: Column<General>[] = [
    {
      key: 'name',
      label: '장수',
      sortValue: (g) => displayName(g.name),
      render: (g) => <GeneralNameCell general={g} injury={false} />,
    },
    {
      key: 'officer',
      label: '직책',
      sortValue: (g) => (isDetailedGeneral(g) ? g.officerLevel : null),
      render: (g) => (isDetailedGeneral(g) ? officerName(g.officerLevel, g.nationId !== null) : '—'),
    },
    {
      key: 'city',
      label: '위치',
      sortValue: (g) => (isDetailedGeneral(g) ? (cityName.get(g.cityKey) ?? String(g.cityKey)) : null),
      render: (g) => (isDetailedGeneral(g) ? (cityName.get(g.cityKey) ?? g.cityKey) : '—'),
    },
    { key: 'leadership', label: '통솔', ...num((g) => g.leadership) },
    { key: 'strength', label: '무력', ...num((g) => g.strength) },
    { key: 'intel', label: '지력', ...num((g) => g.intel) },
    ...(fiveStats
      ? [
          { key: 'politics', label: '정치', ...num((g) => g.politics) },
          { key: 'charm', label: '매력', ...num((g) => g.charm) },
        ]
      : []),
    // 부곡 월드는 병종이 부곡마다 달라 장수 병종 열을 두지 않는다.
    ...(campaign
      ? []
      : [
          {
            key: 'crewType',
            label: '병종',
            sortValue: (g: General) => (isDetailedGeneral(g) ? g.crewType : null),
            render: (g: General) => (isDetailedGeneral(g) ? unitNameOf(crewTypes, g.crewType).name : '—'),
            title: (g: General) => (isDetailedGeneral(g) ? unitNameOf(crewTypes, g.crewType).title : HIDDEN_NATION),
          },
        ]),
    { key: 'crew', label: campaign ? '지휘 병력' : '병력', ...num((g) => armyOf(g).troops) },
    { key: 'train', label: campaign ? '평균 훈련' : '훈련', ...num((g) => armyOf(g).train) },
    { key: 'atmos', label: campaign ? '평균 사기' : '사기', ...num((g) => armyOf(g).atmos) },
    {
      key: 'care',
      label: '관리',
      render: (g) => (isDetailedGeneral(g) ? <GeneralCare general={g} /> : null),
    },
  ];
  // 원작 세력 장수 표의 자금·연령·명성·계급·성격·특기 (INT-25). 한 표에 모두 두면 768px에서 넘치므로 따로 둔다.
  const recordColumns: Column<General>[] = [
    generalColumns[0]!,
    { key: 'gold', label: '금', ...num((g) => g.gold) },
    { key: 'rice', label: '쌀', ...num((g) => g.rice) },
    { key: 'age', label: '나이', ...num((g) => displayedAge(g, summary)) },
    { key: 'experience', label: '경험', ...num((g) => g.experience) },
    { key: 'dedication', label: '공헌', ...num((g) => g.dedication) },
    { key: 'personality', label: '성격', ...text((g) => g.personality) },
    { key: 'special', label: '특기', ...text((g) => g.special) },
  ];

  return (
    <div className={styles.tables}>
      {member ? null : (
        <p className={styles.note} role="note">
          {HIDDEN_NATION}라 장수 수치와 국고는 보이지 않습니다.
        </p>
      )}
      <div id="cities">
        <DataTable
          caption={`소유 도시 ${data.cities.length}곳`}
          rows={data.cities}
          columns={cityColumns}
          rowKey={(c) => c.key}
          mobileDetails={[]}
        />
      </div>
      {member ? <NationTotalsGrid generals={data.generals} /> : null}
      <DataTable
        caption={`소속 장수 ${data.generals.length}명`}
        rows={data.generals}
        columns={generalColumns}
        rowKey={(g) => g.id}
        mobileDetails={[
          'officer',
          'city',
          'leadership',
          'strength',
          'intel',
          'politics',
          'charm',
          'crewType',
          'train',
          'atmos',
          'care',
        ]}
      />
      {member ? (
        <DataTable
          caption={`장수 자금·이력 ${data.generals.length}명`}
          rows={data.generals}
          columns={recordColumns}
          rowKey={(g) => g.id}
          mobileDetails={['age', 'experience', 'dedication', 'personality', 'special']}
        />
      ) : null}
    </div>
  );
}

// 관리 필요 표시 (myosam 아이디어). 부상, 병력이 있는데 훈련·사기가 낮은 경우를 노랑으로 표시한다.
export function careTags(general: ArmyFields & { injury: number }): string[] {
  const tags: string[] = [];
  if (general.injury > 0) tags.push(`부상 ${general.injury}`);
  const army = armyOf(general);
  if (army.troops > 0 && army.train < 50) tags.push('훈련 부족');
  if (army.troops > 0 && army.atmos < 50) tags.push('사기 부족');
  return tags;
}

function GeneralCare({ general }: { general: ArmyFields & { injury: number } }) {
  const tags = careTags(general);
  return (
    <span className={styles.tags}>
      {tags.map((tag) => (
        <Tag key={tag} tone="warning">
          {tag}
        </Tag>
      ))}
    </span>
  );
}
