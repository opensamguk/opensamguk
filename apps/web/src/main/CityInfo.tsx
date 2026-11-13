import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { retryUnlessClientError } from '../game/errors';
import { displayName, officerName } from '../game/names';
import { useWorldRules } from '../game/queries';
import { QueryError } from '../game/QueryState';
import {
  isDetailedCity,
  isDetailedGeneral,
  type CityDetailFields,
  type MapNation,
  type GeneralView,
} from '../game/types';
import { crewText, missingReason, RECORD_NOTE, recordedAtText, trustText } from '../intel/view';
import { Portrait } from '../portrait/Portrait';
import { CityOfficeResidences } from '../personnel/OfficeResidence';
import { useTRPC } from '../trpc';
import { DataTable, type Column } from '../ui/DataTable';
import { NationBadge } from '../ui/NationBadge';
import { LoadingState } from '../ui/States';
import { StatTable, type StatRow } from '../ui/StatTable';
import { Tag } from '../ui/Tag';
import styles from './CityInfo.module.css';
import { CityResourcesPanel } from './CityResourcesPanel';
import { cityLevelText, garrisonSummary, nearMax, populationRate } from './infoView';
import { unitNameOf } from './UnitName';
import { LogisticsPanel } from '../city/LogisticsPanel';

const HIDDEN_CITY = '다른 국가의 도시입니다';
// 서버는 나 자신과 같은 국가 장수의 능력치만 준다(visibility.general). 재야끼리도 서로 보이지 않는다.
const HIDDEN_GENERAL = '능력치는 같은 국가 장수만 보입니다';
const GARRISON_HIDDEN = '주둔 장수는 보이지 않습니다';
const n = (value: number) => value.toLocaleString('ko-KR');

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
// 첩보 기능 월드의 타국 도시는 서버가 준 가장 최근 첩보 기록(fog.intel)을 기록 연월과 함께 보인다 (INT-25).
export function CityInfo({
  worldId,
  cityKey,
  nations,
  onSelectCity,
  showGenerals = true,
  logisticsEnabled = false,
  summary = false,
}: {
  worldId: string;
  cityKey: number;
  nations: readonly MapNation[];
  onSelectCity?: (key: number) => void;
  showGenerals?: boolean;
  // world.summary.logisticsEnabled가 true인 월드에서만 물류 칸을 그리고 조회한다 (T4-93).
  logisticsEnabled?: boolean;
  // 메인의 요약 칸 (INT-25). 주둔 장수 표·물류는 도시 화면으로 보내고 링크만 둔다.
  summary?: boolean;
}) {
  const city = useCity(worldId, cityKey);
  if (city.isPending) return <LoadingState />;
  if (city.isError)
    return <QueryError error={city.error} notFound="없는 도시입니다" onRetry={() => void city.refetch()} />;

  const data = city.data;
  const nationById = new Map(nations.map((nation) => [nation.id, nation]));
  const owner = data.nationId === null ? undefined : nationById.get(data.nationId);
  const detailed = isDetailedCity(data);
  const intel = !detailed && data.fog?.intel ? data.fog.intel : null;
  const garrisonHidden = data.fog?.garrisonHidden === true;
  const stat = (label: string, value: number | undefined, max: number | undefined, reason = HIDDEN_CITY): StatRow => ({
    label,
    value: value ?? null,
    ...(max === undefined ? {} : { max }),
    hiddenReason: reason,
  });
  const domestic = intel?.domestic;
  const domesticReason = intel ? missingReason(intel, 'domestic') : HIDDEN_CITY;
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
    : intel
      ? [
          stat('주민', intel.population, intel.populationMax),
          stat('농업', domestic?.agriculture, domestic?.agricultureMax, domesticReason),
          stat('상업', domestic?.commerce, domestic?.commerceMax, domesticReason),
          stat('치안', domestic?.security, domestic?.securityMax, domesticReason),
          stat('수비', domestic?.defence, domestic?.defenceMax, domesticReason),
          stat('성벽', domestic?.wall, domestic?.wallMax, domesticReason),
          stat('민심', Math.floor(intel.trust), 100),
        ]
      : ['주민', '농업', '상업', '치안', '수비', '성벽', '민심'].map((label) => stat(label, undefined, undefined));

  return (
    <div className={styles.city} data-city-key={data.key} data-visibility={detailed ? 'detail' : 'public'}>
      <div className={styles.title}>
        <strong className={styles.name}>{data.name}</strong>
        <span className={styles.meta} title={`규모 ${data.level}`}>
          {cityLevelText(data.level)}
        </span>
        {data.ruin ? <Tag tone="danger">폐허 복구 {data.ruin.percent}%</Tag> : null}
        {owner ? (
          <Link to="/w/$worldId/nation/$nationId" params={{ worldId, nationId: String(owner.id) }}>
            <NationBadge name={owner.name} color={owner.color} />
          </Link>
        ) : (
          <NationBadge name="공백지" color={null} />
        )}
        {data.supplied ? <Tag tone="muted">보급 연결</Tag> : <Tag tone="danger">보급 끊김</Tag>}
      </div>
      {detailed ? null : intel ? (
        <p className={styles.intel} role="note" data-intel-tick={intel.tick}>
          <Tag tone="info">첩보 {recordedAtText(intel)}</Tag>
          <span>
            장수 {n(intel.generals)}명 · 병력 {crewText(intel.crew)} · 민심 {trustText(intel.trust)}
          </span>
          <span className={styles.meta}>{RECORD_NOTE}</span>
        </p>
      ) : (
        <p className={styles.note} role="note">
          {HIDDEN_CITY}. 수치는 자기 국가 도시나 내 장수가 있는 도시에서만 보입니다.
        </p>
      )}
      <StatTable rows={rows} />
      {data.nationId !== null && data.kind !== 'PASS' && data.officeEffectsEnabled && data.officers ? (
        <CityOfficeResidences officers={data.officers} />
      ) : null}
      {isDetailedCity(data) ? <CityFacts city={data} /> : null}
      {garrisonHidden ? null : <GarrisonLine generals={data.generals} campaign={data.campaignEnabled === true} />}
      {/* 도시 금·쌀·수비병(INT-18)은 모병·배속 명령과 함께 쓰므로 메인에도 둔다. */}
      <CityResourcesPanel worldId={worldId} cityKey={cityKey} />
      {summary ? (
        <p className={styles.links}>
          {garrisonHidden ? (
            <span className={styles.meta}>{GARRISON_HIDDEN}</span>
          ) : (
            <Link to="/w/$worldId/city/$cityKey" params={{ worldId, cityKey: String(cityKey) }}>
              주둔 장수 {data.generals.length}명
            </Link>
          )}
          {logisticsEnabled ? (
            <Link to="/w/$worldId/city/$cityKey" params={{ worldId, cityKey: String(cityKey) }} hash="logistics">
              물류
            </Link>
          ) : null}
        </p>
      ) : logisticsEnabled ? (
        <div id="logistics">
          <LogisticsPanel worldId={worldId} cityKey={cityKey} />
        </div>
      ) : null}
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
      {/* 첩보 기능 월드의 타국 도시는 서버가 장수 목록을 비워 보낸다. 없는 것과 못 보는 것을 가른다. */}
      {showGenerals && !summary && garrisonHidden ? (
        <p className={styles.meta} data-garrison="hidden">
          {GARRISON_HIDDEN}. 첩보로 확인합니다.
        </p>
      ) : showGenerals && !summary ? (
        <Garrison
          worldId={worldId}
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

// 인구율과 최대치에 가까운 내정 (원작 세력 도시의 남은 양 표시). 수치를 받은 도시만 쓴다.
function CityFacts({ city }: { city: CityDetailFields }) {
  const near = nearMax([
    { label: '농업', value: city.agriculture, max: city.agricultureMax },
    { label: '상업', value: city.commerce, max: city.commerceMax },
    { label: '치안', value: city.security, max: city.securityMax },
    { label: '수비', value: city.defence, max: city.defenceMax },
    { label: '성벽', value: city.wall, max: city.wallMax },
  ]);
  return (
    <p className={styles.facts} data-testid="city-facts">
      <span>인구율 {populationRate(city.population, city.populationMax)}</span>
      {near.map((row) => (
        <Tag key={row.label} tone="warning">
          {row.label} 최대까지 {n(row.left)}
        </Tag>
      ))}
    </p>
  );
}

// 주둔 병력 요약 (원작 현재 도시의 병장(총)·90병장·60병장·적군 칸). 아군은 수치를 받은 같은 국가 장수다.
export function GarrisonLine({ generals, campaign }: { generals: readonly GeneralView[]; campaign: boolean }) {
  const sum = garrisonSummary(generals);
  return (
    <p className={styles.facts} data-testid="garrison-summary">
      <span>
        {campaign ? '아군 지휘 병력' : '아군 병력'} {n(sum.troops)} · 병력 있는 장수 {n(sum.withTroops)}명 / 아군{' '}
        {n(sum.allies)}명
      </span>
      <span>
        훈련·사기 90 이상 {n(sum.ready90.troops)}명({n(sum.ready90.count)}장수) · 60 이상 {n(sum.ready60.troops)}명(
        {n(sum.ready60.count)}장수)
      </span>
      {sum.foreign + sum.ronin > 0 ? (
        <span>
          타국 장수 {n(sum.foreign)}명 · 재야 {n(sum.ronin)}명
        </span>
      ) : null}
    </p>
  );
}

// 장수 이름 칸. 같은 국가 장수는 얼굴(thumb을 20×28로)과 부상을 함께 쓴다. 얼굴은 이름과 겹치므로 읽기 이름에서 뺀다.
// 국가 표는 관리 칸에 부상을 따로 적으므로 injury={false}로 뺀다.
export function GeneralNameCell({ general, injury = true }: { general: GeneralView; injury?: boolean }) {
  const name = displayName(general.name);
  return (
    <span className={styles.who}>
      {isDetailedGeneral(general) ? (
        <span aria-hidden="true" className={styles.faceBox}>
          <Portrait id={general.portraitId} name={name} variant="thumb" className={styles.face} />
        </span>
      ) : null}
      <span data-general-name="">{name}</span>
      {injury && isDetailedGeneral(general) && general.injury > 0 ? (
        <Tag tone="warning">부상 {general.injury}</Tag>
      ) : null}
    </span>
  );
}

function Garrison({
  worldId,
  generals,
  nations,
  campaign,
  fiveStats,
}: {
  worldId: string;
  generals: readonly GeneralView[];
  nations: Map<number, MapNation>;
  campaign: boolean;
  fiveStats: boolean;
}) {
  const crewTypes = useWorldRules(worldId).data?.unitSet.crewTypes;
  if (generals.length === 0) return <p className={styles.meta}>주둔 장수가 없습니다.</p>;
  const hidden = (g: GeneralView) => (isDetailedGeneral(g) ? undefined : HIDDEN_GENERAL);
  const num = (pick: (g: Extract<GeneralView, { leadership: number }>) => number | undefined) => ({
    numeric: true,
    sortValue: (g: GeneralView) => (isDetailedGeneral(g) ? (pick(g) ?? null) : null),
    render: (g: GeneralView) => (isDetailedGeneral(g) ? (pick(g)?.toLocaleString('ko-KR') ?? '—') : '—'),
    title: hidden,
  });
  const columns: Column<GeneralView>[] = [
    {
      key: 'name',
      label: '장수',
      sortValue: (g) => displayName(g.name),
      render: (g) => <GeneralNameCell general={g} />,
    },
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
    {
      key: 'officer',
      label: '직책',
      sortValue: (g) => (isDetailedGeneral(g) ? g.officerLevel : null),
      render: (g) => (isDetailedGeneral(g) ? officerName(g.officerLevel, g.nationId !== null) : '—'),
      title: hidden,
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
            sortValue: (g: GeneralView) => (isDetailedGeneral(g) ? g.crewType : null),
            render: (g: GeneralView) => (isDetailedGeneral(g) ? unitNameOf(crewTypes, g.crewType).name : '—'),
            title: (g: GeneralView) =>
              isDetailedGeneral(g) ? unitNameOf(crewTypes, g.crewType).title : HIDDEN_GENERAL,
          },
        ]),
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
      mobileDetails={['officer', 'leadership', 'strength', 'intel', 'politics', 'charm', 'crewType', 'train', 'atmos']}
    />
  );
}
