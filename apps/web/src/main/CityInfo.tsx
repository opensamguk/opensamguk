import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { retryUnlessClientError } from '../game/errors';
import { QueryError } from '../game/QueryState';
import { isDetailedCity, isDetailedGeneral, type MapNation, type GeneralView } from '../game/types';
import { useTRPC } from '../trpc';
import { DataTable, type Column } from '../ui/DataTable';
import { NationBadge } from '../ui/NationBadge';
import { LoadingState } from '../ui/States';
import { StatTable, type StatRow } from '../ui/StatTable';
import { Tag } from '../ui/Tag';
import styles from './CityInfo.module.css';
import { CityResourcesPanel } from './CityResourcesPanel';

const HIDDEN_CITY = '다른 국가의 도시입니다';
const HIDDEN_GENERAL = '다른 국가 장수입니다';

export function useCity(worldId: string, cityKey: number | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.city.get.queryOptions({ worldId, cityKey: cityKey ?? 1 }),
    enabled: cityKey !== null,
    retry: retryUnlessClientError,
  });
}

// 도시 정보 칸. 원작 CityBasicCard처럼 제목·지배 국가·수치 막대를 두고, 주둔 장수 표를 붙인다.
// 공개 범위 밖이면 서버가 수치를 빼고 보낸다. 그 칸은 —와 이유로 보여 준다.
export function CityInfo({
  worldId,
  cityKey,
  nations,
  onSelectCity,
  showGenerals = true,
}: {
  worldId: string;
  cityKey: number;
  nations: readonly MapNation[];
  onSelectCity?: (key: number) => void;
  showGenerals?: boolean;
}) {
  const city = useCity(worldId, cityKey);
  if (city.isPending) return <LoadingState />;
  if (city.isError)
    return <QueryError error={city.error} notFound="없는 도시입니다" onRetry={() => void city.refetch()} />;

  const data = city.data;
  const nationById = new Map(nations.map((nation) => [nation.id, nation]));
  const owner = data.nationId === null ? undefined : nationById.get(data.nationId);
  const detailed = isDetailedCity(data);
  const stat = (label: string, value: number | undefined, max: number | undefined): StatRow => ({
    label,
    value: value ?? null,
    ...(max === undefined ? {} : { max }),
    hiddenReason: HIDDEN_CITY,
  });
  const rows: StatRow[] = detailed
    ? [
        stat('주민', data.population, data.populationMax),
        stat('농업', data.agriculture, data.agricultureMax),
        stat('상업', data.commerce, data.commerceMax),
        stat('치안', data.security, data.securityMax),
        stat('수비', data.defence, data.defenceMax),
        stat('성벽', data.wall, data.wallMax),
        stat('민심', Math.floor(data.trust), 100),
      ]
    : ['주민', '농업', '상업', '치안', '수비', '성벽', '민심'].map((label) => stat(label, undefined, undefined));

  return (
    <div className={styles.city} data-city-key={data.key} data-visibility={detailed ? 'detail' : 'public'}>
      <div className={styles.title}>
        <strong className={styles.name}>{data.name}</strong>
        <span className={styles.meta}>규모 {data.level}</span>
        {owner ? (
          <Link to="/w/$worldId/nation/$nationId" params={{ worldId, nationId: String(owner.id) }}>
            <NationBadge name={owner.name} color={owner.color} />
          </Link>
        ) : (
          <NationBadge name="공백지" color={null} />
        )}
        {data.supplied ? <Tag tone="muted">보급 연결</Tag> : <Tag tone="danger">보급 끊김</Tag>}
      </div>
      {detailed ? null : (
        <p className={styles.note} role="note">
          {HIDDEN_CITY}. 수치는 자기 국가 도시나 내 장수가 있는 도시에서만 보입니다.
        </p>
      )}
      <StatTable rows={rows} />
      <CityResourcesPanel worldId={worldId} cityKey={cityKey} />
      {data.links.length > 0 ? (
        <p className={styles.links}>
          <span className={styles.meta}>연결</span>
          {data.links.map((key) => (
            <NeighborLink
              key={key}
              worldId={worldId}
              cityKey={key}
              {...(onSelectCity ? { onSelect: onSelectCity } : {})}
            />
          ))}
        </p>
      ) : null}
      {showGenerals ? (
        <Garrison
          generals={data.generals}
          nations={nationById}
          campaign={data.campaignEnabled === true}
          fiveStats={data.fiveStats === true}
        />
      ) : null}
    </div>
  );
}

// 연결 도시. 메인에서는 같은 화면에서 그 도시로 바꾸고, 단독 화면에서는 그 도시 주소로 간다.
function NeighborLink({
  worldId,
  cityKey,
  onSelect,
}: {
  worldId: string;
  cityKey: number;
  onSelect?: (key: number) => void;
}) {
  const trpc = useTRPC();
  const map = useQuery({ ...trpc.world.map.queryOptions({ worldId }), staleTime: 30_000 });
  const name = map.data?.cities.find((city) => city.key === cityKey)?.name ?? String(cityKey);
  if (onSelect)
    return (
      <button type="button" className={styles.neighbor} onClick={() => onSelect(cityKey)}>
        {name}
      </button>
    );
  return (
    <Link className={styles.neighbor} to="/w/$worldId/city/$cityKey" params={{ worldId, cityKey: String(cityKey) }}>
      {name}
    </Link>
  );
}

function Garrison({
  generals,
  nations,
  campaign,
  fiveStats,
}: {
  generals: readonly GeneralView[];
  nations: Map<number, MapNation>;
  campaign: boolean;
  fiveStats: boolean;
}) {
  if (generals.length === 0) return <p className={styles.meta}>주둔 장수가 없습니다.</p>;
  const num = (pick: (g: Extract<GeneralView, { leadership: number }>) => number | undefined) => ({
    numeric: true,
    sortValue: (g: GeneralView) => (isDetailedGeneral(g) ? (pick(g) ?? null) : null),
    render: (g: GeneralView) => (isDetailedGeneral(g) ? (pick(g)?.toLocaleString('ko-KR') ?? '—') : '—'),
    title: (g: GeneralView) => (isDetailedGeneral(g) ? undefined : HIDDEN_GENERAL),
  });
  const columns: Column<GeneralView>[] = [
    { key: 'name', label: '장수', sortValue: (g) => g.name, render: (g) => g.name },
    {
      key: 'nation',
      label: '소속',
      sortValue: (g) => g.nationId ?? 0,
      render: (g) => {
        const nation = g.nationId === null ? undefined : nations.get(g.nationId);
        return nation ? (
          <NationBadge name={nation.name} color={nation.color} />
        ) : (
          <NationBadge name="재야" color={null} />
        );
      },
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
    {
      key: 'crew',
      label: campaign ? '지휘 병력' : '병력',
      ...num((g) => (campaign ? ('commandedArmy' in g ? g.commandedArmy.troops : undefined) : g.crew)),
    },
    {
      key: 'train',
      label: campaign ? '평균 훈련' : '훈련',
      ...num((g) => (campaign ? ('commandedArmy' in g ? g.commandedArmy.train : undefined) : g.train)),
    },
    {
      key: 'atmos',
      label: campaign ? '평균 사기' : '사기',
      ...num((g) => (campaign ? ('commandedArmy' in g ? g.commandedArmy.atmos : undefined) : g.atmos)),
    },
  ];
  return (
    <DataTable
      caption={`주둔 장수 ${generals.length}명`}
      rows={generals}
      columns={columns}
      rowKey={(g) => g.id}
      mobileDetails={['leadership', 'strength', 'intel', 'politics', 'charm', 'train', 'atmos']}
    />
  );
}
