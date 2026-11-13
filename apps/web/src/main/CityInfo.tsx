import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { retryUnlessClientError } from '../game/errors';
import { displayName, officerName } from '../game/names';
import { useHome, useWorldMap, useWorldRules, useWorldUnits } from '../game/queries';
import { QueryError } from '../game/QueryState';
import {
  isDetailedCity,
  isDetailedGeneral,
  type CityDetailFields,
  type CityView,
  type MapNation,
  type GeneralView,
} from '../game/types';
import { crewText, missingReason, RECORD_NOTE, recordedAtText, trustText } from '../intel/view';
import { Portrait } from '../portrait/Portrait';
import { useTRPC } from '../trpc';
import { DataTable, type Column } from '../ui/DataTable';
import { NationBadge } from '../ui/NationBadge';
import { OFFICER_MIN_LEVEL, type InspectionRow } from '../operations/contract';
import { EMPTY_SLOT_TITLE, slotLabel } from '../operations/timeline';
import type { ArgNames } from '../turns/args';
import { LoadingState } from '../ui/States';
import statStyles from '../ui/StatTable.module.css';
import { Tag } from '../ui/Tag';
import styles from './CityInfo.module.css';
import { CityOffices } from './CityOffices';
import { CityResourcesPanel } from './CityResourcesPanel';
import {
  BAND_LABEL,
  cityLevelText,
  garrisonSummary,
  nearMax,
  populationRate,
  statBand,
  type StatBand,
} from './infoView';
import { levelName } from './siteMarkers';
import { unitNameOf } from './UnitName';
import { LogisticsPanel } from '../city/LogisticsPanel';

const HIDDEN_CITY = '다른 국가의 도시입니다';
// 도시 제목 괄호 안 글자. 규모 이름을 모르면 규모 숫자를 쓴다.
export const cityRegionTitle = (regionName: string, level: number) =>
  `${regionName} · ${levelName(level) ?? `규모 ${level}`}`;
// 서버는 나 자신과 같은 국가 장수의 능력치만 준다(visibility.general). 재야끼리도 서로 보이지 않는다.
const HIDDEN_GENERAL = '능력치는 같은 국가 장수만 보입니다';
const GARRISON_HIDDEN = '주둔 장수는 보이지 않습니다';
// 예턴은 감찰 자료(inspection.members)로 채운다. 서버가 직책자(직책 5 이상)에게만 준다.
export const TURNS_OFFICER_ONLY = '예턴은 직책자에게 같은 국가 장수만 보입니다';
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
  const stat = (
    label: string,
    value: number | undefined,
    max: number | undefined,
    reason = HIDDEN_CITY,
  ): CityStatRow => ({
    label,
    value: value ?? null,
    ...(max === undefined ? {} : { max }),
    hiddenReason: reason,
  });
  const domestic = intel?.domestic;
  const domesticReason = intel ? missingReason(intel, 'domestic') : HIDDEN_CITY;
  const rows: CityStatRow[] = detailed
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
        {/* 원작 도시 카드 제목 【 하북 · 특 】 업. 지역 이름(region·regionName, INT-26)이 없는 지도는 규모만 이름 뒤에 쓴다. */}
        {data.regionName ? (
          <span className={styles.region} data-testid="city-region" title={`규모 ${data.level}`}>
            【 {cityRegionTitle(data.regionName, data.level)} 】
          </span>
        ) : null}
        <strong className={styles.name}>{data.name}</strong>
        {data.regionName ? null : (
          <span className={styles.meta} title={`규모 ${data.level}`}>
            {cityLevelText(data.level)}
          </span>
        )}
        {data.ruin ? <Tag tone="danger">폐허 복구 {data.ruin.percent}%</Tag> : null}
        {data.events?.map((event) => (
          <Tag key={event.kind} tone={event.favorable ? 'info' : 'danger'}>
            {event.name}
            {event.monthsRemaining ? ` · ${event.monthsRemaining}개월` : ''}
          </Tag>
        ))}
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
      <CityStats rows={rows} />
      {data.incomeEstimate ? (
        <p className={styles.meta}>
          예상 세입 · 금 {n(data.incomeEstimate.gold.amount)} ({data.incomeEstimate.gold.year}년{' '}
          {data.incomeEstimate.gold.month}월)
          {' · '}쌀 {n(data.incomeEstimate.rice.amount)} ({data.incomeEstimate.rice.year}년{' '}
          {data.incomeEstimate.rice.month}월)
          {data.incomeEstimate.rice.wallIncome === undefined
            ? null
            : ` · 둔전 포함 ${n(data.incomeEstimate.rice.wallIncome)}`}
        </p>
      ) : null}
      {data.riceMarket && (
        <p className={styles.facts}>
          쌀 시세 {data.riceMarket.rate === null ? '상인 없음' : `${data.riceMarket.rate}%`}
        </p>
      )}
      {/* 태수·군사·종사는 관직 효과 월드에서 서버가 officers로 준다(타국 도시는 첩보 기능이면 빠진다). */}
      {data.nationId !== null && data.kind !== 'PASS' && data.officeEffectsEnabled && data.officers ? (
        <CityOffices officers={data.officers} secretaryEnabled={data.secretaryEnabled === true} />
      ) : null}
      {isDetailedCity(data) ? <CityFacts city={data} /> : null}
      {garrisonHidden ? null : (
        <GarrisonLine generals={data.generals} campaign={data.campaignEnabled === true} defense={data.defense} />
      )}
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
          defense={data.defense}
          ownerId={data.nationId}
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

export interface CityStatRow {
  label: string;
  value: number | null; // null = 공개 범위 밖
  max?: number;
  hiddenReason?: string;
}

const BAND_FILL: Record<StatBand, string | undefined> = {
  low: styles.fillLow,
  mid: styles.fillMid,
  high: styles.fillHigh,
};
const BAND_TEXT: Record<StatBand, string | undefined> = {
  low: styles.bandLow,
  mid: styles.bandMid,
  high: styles.bandHigh,
};

// 개발 정도 글자 딱지. 색과 함께 낮음·보통·높음 글자를 쓴다 (색만으로 뜻을 전하지 않는다).
export function BandText({ band, label }: { band: StatBand; label?: string }) {
  return (
    <span className={`${styles.band} ${BAND_TEXT[band] ?? ''}`} data-band={band}>
      {label ? `${label} ` : ''}
      {BAND_LABEL[band]}
    </span>
  );
}

// 도시 수치 표. 공용 수치 표(ui/StatTable)와 같은 모양에 개발 정도 구간(낮음·보통·높음)을 막대 색과 글자로 더한다 (INT-25).
export function CityStats({ rows }: { rows: readonly CityStatRow[] }) {
  return (
    <table className={`${statStyles.table} ${styles.stats}`} data-testid="city-stats">
      <tbody>
        {rows.map((row) => {
          const band = row.value !== null && row.max !== undefined ? statBand(row.value, row.max) : null;
          return (
            <tr key={row.label} data-band={band ?? undefined}>
              <th scope="row" className={statStyles.label}>
                {row.label}
              </th>
              <td className="num" title={row.value === null ? row.hiddenReason : undefined}>
                {row.value === null ? '—' : row.value.toLocaleString('ko-KR')}
              </td>
              <td className={`num ${statStyles.max}`}>
                {row.max === undefined ? '' : `/ ${row.max.toLocaleString('ko-KR')}`}
              </td>
              <td className={statStyles.barCell}>
                {row.max !== undefined && row.value !== null ? (
                  <span
                    className={statStyles.bar}
                    role="meter"
                    aria-label={`${row.label} ${row.value} / ${row.max}`}
                    aria-valuenow={row.value}
                    aria-valuemin={0}
                    aria-valuemax={row.max}
                  >
                    <span
                      className={`${statStyles.fill} ${band ? (BAND_FILL[band] ?? '') : ''}`}
                      style={{ width: `${Math.min(100, (row.value / Math.max(row.max, 1)) * 100)}%` }}
                    />
                  </span>
                ) : null}
              </td>
              <td className={styles.bandCell}>{band ? <BandText band={band} /> : null}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// 감찰 자료. 내가 직책자이고 (nationId를 주면) 그 국가 소속일 때만 조회한다. 일반 장수는 null이라 예턴 칸이 없다.
export function useInspectionRows(worldId: string, nationId?: number | null): Map<number, InspectionRow> | null {
  const trpc = useTRPC();
  const me = useHome(worldId).data?.general;
  const officer =
    me !== undefined &&
    me.nationId !== null &&
    me.officerLevel >= OFFICER_MIN_LEVEL &&
    (nationId === undefined || nationId === me.nationId);
  const query = useQuery({
    ...trpc.inspection.members.queryOptions({ worldId }),
    enabled: officer,
    retry: retryUnlessClientError,
    staleTime: 30_000,
  });
  const items = query.data?.items;
  return useMemo(() => (officer && items ? new Map(items.map((row) => [row.generalId, row])) : null), [officer, items]);
}

// 예턴 인자에 붙일 도시·국가·병종 이름.
export function useArgNames(worldId: string): ArgNames {
  const map = useWorldMap(worldId).data;
  const { units } = useWorldUnits(worldId);
  return useMemo(() => {
    const cities = map?.cities ?? [];
    const nations = map?.nations ?? [];
    return {
      city: (key) => cities.find((c) => c.key === key)?.name,
      nation: (id) => nations.find((nation) => nation.id === id)?.name,
      unit: units.name,
    };
  }, [map, units]);
}

// 예턴 앞 5칸. 감찰 화면과 같이 비워 둔 칸은 방침 명령을 짐작하지 않고 `빈 칸`으로 적는다.
export function TurnFive({ turns, names }: { turns: InspectionRow['turns']; names: ArgNames }) {
  return (
    <ol className={styles.turnFive} data-testid="turn-five">
      {turns.map((turn, i) => {
        const label = slotLabel(turn, names);
        return (
          <li key={i} data-kind={label.kind}>
            <span className={styles.slotNo}>{i + 1}</span>{' '}
            {label.kind === 'empty' ? (
              <span className={styles.meta} title={EMPTY_SLOT_TITLE}>
                {label.text}
              </span>
            ) : (
              label.text
            )}
          </li>
        );
      })}
    </ol>
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
type CityDefense = CityView['defense'];

export function GarrisonLine({
  generals,
  campaign,
  defense,
}: {
  generals: readonly GeneralView[];
  campaign: boolean;
  defense?: CityDefense;
}) {
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
      {defense ? (
        <span
          title={
            defense.individualThresholds
              ? '각 장수의 수비 기준과 현재 훈련·사기로 집계합니다'
              : `훈련 ${defense.minimumTraining}, 사기 ${defense.minimumMorale} 이상`
          }
        >
          수비 참가 {n(defense.troops)}명 · 장수 {n(defense.generals.length)}명
        </span>
      ) : null}
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
// NPC 딱지는 장수 행의 isHuman(INT-26, 모든 장수 행에 온다)이 false일 때 단다. npc는 감찰 자료의 사람 여부로 덧붙인다.
// 둘 다 모르면 딱지를 달지 않는다.
export function GeneralNameCell({
  general,
  injury = true,
  npc = false,
  possessedNpc = false,
}: {
  general: GeneralView;
  injury?: boolean;
  npc?: boolean;
  possessedNpc?: boolean;
}) {
  const name = displayName(general.name);
  const isNpc = npc || general.isHuman === false;
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
      {isNpc ? (
        <Tag tone="muted" title="사람이 맡지 않은 장수입니다">
          NPC
        </Tag>
      ) : possessedNpc ? (
        <Tag tone="muted">맡은 NPC</Tag>
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
  defense,
  ownerId,
}: {
  worldId: string;
  generals: readonly GeneralView[];
  nations: Map<number, MapNation>;
  campaign: boolean;
  fiveStats: boolean;
  defense?: CityDefense;
  ownerId: number | null;
}) {
  const crewTypes = useWorldRules(worldId).data?.unitSet.crewTypes;
  // 직책자만 감찰 자료로 같은 국가 장수의 예턴 앞 5칸을 본다 (원작 현재 도시의 명령 열). 일반 장수는 열이 없다.
  const inspection = useInspectionRows(worldId);
  const names = useArgNames(worldId);
  const defenders = new Map(defense?.generals.map(({ generalId, troops }) => [generalId, troops]));
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
      render: (g) => <GeneralNameCell general={g} npc={inspection?.get(g.id)?.isHuman === false} />,
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
    ...(defense
      ? [
          {
            key: 'defending',
            label: '수비 참가',
            numeric: true,
            sortValue: (g: GeneralView) => defenders.get(g.id) ?? 0,
            render: (g: GeneralView) =>
              defenders.has(g.id) ? `${n(defenders.get(g.id)!)}명` : g.nationId === ownerId ? '불참' : '—',
          },
        ]
      : []),
    ...(inspection
      ? [
          {
            key: 'turns',
            label: '예턴',
            render: (g: GeneralView) => {
              const row = inspection.get(g.id);
              return row ? <TurnFive turns={row.turns} names={names} /> : '—';
            },
            // 다른 국가 장수는 다른 칸과 같은 이유를 써서 좁은 화면에서 이유를 한 번만 적게 한다.
            title: (g: GeneralView) =>
              !isDetailedGeneral(g) ? HIDDEN_GENERAL : inspection.has(g.id) ? undefined : TURNS_OFFICER_ONLY,
          },
        ]
      : []),
  ];
  return (
    <DataTable
      caption={`주둔 장수 ${generals.length}명`}
      rows={generals}
      columns={columns}
      rowKey={(g) => g.id}
      mobileDetails={[
        'officer',
        'leadership',
        'strength',
        'intel',
        'politics',
        'charm',
        'crewType',
        'train',
        'atmos',
        'defending',
        'turns',
      ]}
    />
  );
}
