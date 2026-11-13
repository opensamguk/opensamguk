// 원작 core2026 화면의 정보 칸을 우리 응답에서 계산하는 순수 함수 (INT-25 3단계, D-085).
// 서버가 이미 주는 값만 쓰고 규칙 값은 새로 정하지 않는다. 화면 부품은 결과를 그리기만 한다.
import { josa } from '../mapEditor/josa';
import { levelName } from './siteMarkers';

const n = (value: number) => value.toLocaleString('ko-KR');

// 통솔 1당 거느릴 수 있는 병사 (packages/rules/src/balance.ts의 CREW_PER_LEADERSHIP). web은 rules를 읽지 않아 값만 옮긴다.
export const CREW_PER_LEADERSHIP = 100;

// 기술 칸. 원작처럼 1000 단위 등급을 앞에 쓴다. 연도별 상한 색은 우리 규칙에 없어 넣지 않는다.
export function techText(tech: number): string {
  const value = Math.max(0, Math.floor(tech));
  return `${Math.floor(value / 1000)}등급 / ${n(value)}`;
}

// 도시 규모. 이름(특·대·중…)과 숫자를 함께 쓴다. 모르는 규모는 숫자만 쓴다.
export function cityLevelText(level: number): string {
  const name = levelName(level);
  return name === undefined ? `규모 ${level}` : `${name}(${level})`;
}

// 장수 한 명의 병력. 부곡 월드는 지휘 병력 합계와 병력 가중 평균을 쓴다.
export type ArmyFields = {
  crew: number;
  train: number;
  atmos: number;
  commandedArmy?: { troops: number; train: number; atmos: number } | undefined;
};
export function armyOf(general: ArmyFields) {
  return general.commandedArmy ?? { troops: general.crew, train: general.train, atmos: general.atmos };
}

// 훈련·사기가 모두 기준 이상인 병력과 장수 수. 원작 90병장·60병장처럼 바로 출전할 수 있는 병력이다.
export function readyArmy(generals: readonly ArmyFields[], threshold: number) {
  let troops = 0;
  let count = 0;
  for (const general of generals) {
    const army = armyOf(general);
    if (army.troops <= 0 || army.train < threshold || army.atmos < threshold) continue;
    troops += army.troops;
    count += 1;
  }
  return { troops, count };
}

type Detailed = ArmyFields & { leadership: number; gold: number; rice: number };

// 국가 장수 합계 (원작 암행부 요약). 같은 국가 장수만 수치가 오므로 받은 장수만 더한다.
export function nationTotals(generals: readonly Detailed[]) {
  let troops = 0;
  let maxTroops = 0;
  let gold = 0;
  let rice = 0;
  let withTroops = 0;
  for (const general of generals) {
    const army = armyOf(general);
    troops += army.troops;
    maxTroops += general.leadership * CREW_PER_LEADERSHIP;
    gold += general.gold;
    rice += general.rice;
    if (army.troops > 0) withTroops += 1;
  }
  const count = generals.length;
  return {
    count,
    troops,
    maxTroops,
    withTroops,
    gold,
    rice,
    averageGold: count === 0 ? 0 : Math.round(gold / count),
    averageRice: count === 0 ? 0 : Math.round(rice / count),
    ready90: readyArmy(generals, 90),
    ready80: readyArmy(generals, 80),
    ready60: readyArmy(generals, 60),
  };
}

// 도시 주둔 장수 요약 (원작 현재 도시의 병장·적군 칸). 수치가 온 장수가 아군이고, 나머지는 소속으로 가른다.
export function garrisonSummary(
  generals: ReadonlyArray<(ArmyFields & { nationId: number | null }) | { nationId: number | null }>,
) {
  const allies = generals.filter((general): general is ArmyFields & { nationId: number | null } => 'crew' in general);
  const others = generals.filter((general) => !('crew' in general));
  let troops = 0;
  let withTroops = 0;
  for (const general of allies) {
    const army = armyOf(general);
    troops += army.troops;
    if (army.troops > 0) withTroops += 1;
  }
  return {
    allies: allies.length,
    troops,
    withTroops,
    ready90: readyArmy(allies, 90),
    ready60: readyArmy(allies, 60),
    foreign: others.filter((general) => general.nationId !== null).length,
    ronin: others.filter((general) => general.nationId === null).length,
  };
}

// 군주(12)·참모(11) 이름. 직책이 오지 않는 다른 국가는 undefined다.
export function nationHeads(generals: ReadonlyArray<{ name: string; officerLevel?: number }>) {
  const ranked = generals.filter((general) => typeof general.officerLevel === 'number');
  if (ranked.length === 0) return undefined;
  return {
    ruler: ranked.find((general) => general.officerLevel === 12)?.name ?? null,
    advisor: ranked.find((general) => general.officerLevel === 11)?.name ?? null,
  };
}

// 인구율. 최대 주민에 대한 주민 비율을 소수 한 자리로 쓴다.
export function populationRate(population: number, max: number): string {
  if (!(max > 0)) return '—';
  return `${(Math.floor((population / max) * 1000) / 10).toFixed(1)}%`;
}

// 최대치에 가까운 내정 수치. 원작처럼 1,000(수비·성벽은 700) 안쪽이면 남은 양을 알린다. 이미 최대면 뺀다.
export function nearMax(rows: ReadonlyArray<{ label: string; value: number; max: number }>) {
  return rows.flatMap((row) => {
    const left = row.max - row.value;
    const limit = row.label === '수비' || row.label === '성벽' ? 700 : 1000;
    return left > 0 && left <= limit ? [{ label: row.label, left }] : [];
  });
}

// 개발 정도 구간 (원작 세력 도시의 비율별 글자색). 최대치에 대한 비율로 낮음·보통·높음을 나눈다.
// 경계(40%·80%)는 화면 표시 기준이고 규칙 값이 아니다. 색만으로 뜻을 전하지 않도록 글자 딱지를 함께 쓴다.
export type StatBand = 'low' | 'mid' | 'high';
export const BAND_LABEL: Record<StatBand, string> = { low: '낮음', mid: '보통', high: '높음' };
export const BAND_LOW_BELOW = 0.4;
export const BAND_HIGH_FROM = 0.8;
export function statBand(value: number, max: number): StatBand | null {
  if (!(max > 0) || !Number.isFinite(value)) return null;
  const ratio = value / max;
  if (ratio < BAND_LOW_BELOW) return 'low';
  if (ratio < BAND_HIGH_FROM) return 'mid';
  return 'high';
}

// 도시 수치 일곱 줄(주민·내정 다섯·민심)의 구간. city.get 상세를 받은 도시만 쓴다.
export function cityBands(city: {
  population: number;
  populationMax: number;
  agriculture: number;
  agricultureMax: number;
  commerce: number;
  commerceMax: number;
  security: number;
  securityMax: number;
  defence: number;
  defenceMax: number;
  wall: number;
  wallMax: number;
  trust: number;
}) {
  const rows = [
    { label: '주민', value: city.population, max: city.populationMax },
    { label: '농업', value: city.agriculture, max: city.agricultureMax },
    { label: '상업', value: city.commerce, max: city.commerceMax },
    { label: '치안', value: city.security, max: city.securityMax },
    { label: '수비', value: city.defence, max: city.defenceMax },
    { label: '성벽', value: city.wall, max: city.wallMax },
    { label: '민심', value: Math.floor(city.trust), max: 100 },
  ];
  return rows.flatMap((row) => {
    const band = statBand(row.value, row.max);
    return band === null ? [] : [{ ...row, band }];
  });
}

// 중원 정세 글줄. 연감의 달별 도시 소유를 바로 앞 달과 견주어 건국·멸망·영토 변화를 만든다.
// 서버 연감은 국가 번호·도시 수·도시 소유만 주므로(records.world) 사건 종류(점령·양도 등)는 가르지 않는다.
export interface YearbookFrame {
  nations: ReadonlyArray<{ nationId: number; cities: number }>;
  cities: ReadonlyArray<{ cityKey: number; nationId: number | null }>;
}
export function worldEvents(
  current: YearbookFrame,
  older: YearbookFrame | undefined,
  names: { nation: (id: number) => string | undefined; city: (key: number) => string },
): string[] {
  if (!older) return [];
  const events: string[] = [];
  const before = new Set(older.nations.map((nation) => nation.nationId));
  const after = new Set(current.nations.map((nation) => nation.nationId));
  for (const nation of current.nations)
    if (!before.has(nation.nationId))
      events.push(`${josa(names.nation(nation.nationId) ?? '새 세력', '이/가')} 일어났습니다.`);
  for (const nation of older.nations)
    if (!after.has(nation.nationId)) {
      const name = names.nation(nation.nationId);
      events.push(
        name ? `${josa(name, '이/가')} 멸망했습니다.` : `도시 ${n(nation.cities)}곳을 가졌던 세력이 사라졌습니다.`,
      );
    }
  const owner = new Map(older.cities.map((city) => [city.cityKey, city.nationId]));
  const gained = new Map<number | null, string[]>();
  for (const city of current.cities) {
    if (!owner.has(city.cityKey) || owner.get(city.cityKey) === city.nationId) continue;
    const list = gained.get(city.nationId) ?? [];
    list.push(names.city(city.cityKey));
    gained.set(city.nationId, list);
  }
  for (const [nationId, cities] of gained) {
    const list = cities.join('·');
    if (nationId === null) events.push(`${josa(list, '이/가')} 공백지가 되었습니다.`);
    else events.push(`${josa(names.nation(nationId) ?? '다른 세력', '이/가')} ${josa(list, '을/를')} 차지했습니다.`);
  }
  return events;
}

// 기록·순위의 승리·점령. 순위 응답(ranking.generals)의 값을 그대로 쓴다.
export const meritText = (row: { wins: number; captures: number }) => `승리 ${n(row.wins)} · 점령 ${n(row.captures)}`;
