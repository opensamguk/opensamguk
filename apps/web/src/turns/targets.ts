// 인자 입력 화면의 대상 목록 계산 (INT-25). 서버 판정을 흉내 내지 않고 지도 자료로 거리와 묶음만 만든다.
// 대상이 맞는지는 서버의 사전 검사와 실행 때 판정한다.

export interface LinkedCity {
  key: number;
  links: readonly number[];
}

// 출발 도시에서 연결선을 따라 몇 칸인지 센다. 닿지 않는 도시는 지도에 없다.
export function cityDistances(cities: readonly LinkedCity[], from: number | null): Map<number, number> {
  const distance = new Map<number, number>();
  if (from === null || !cities.some((city) => city.key === from)) return distance;
  const byKey = new Map(cities.map((city) => [city.key, city]));
  distance.set(from, 0);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    const next = (distance.get(current) ?? 0) + 1;
    for (const key of byKey.get(current)?.links ?? []) {
      if (distance.has(key) || !byKey.has(key)) continue;
      distance.set(key, next);
      queue.push(key);
    }
  }
  return distance;
}

export interface TargetCity {
  key: number;
  name: string;
  level: number;
  nationId: number | null;
}

export interface DistanceGroup<T> {
  // 0이면 출발 도시, null이면 연결선으로 닿지 않는 도시
  distance: number | null;
  items: T[];
}

// 후보 도시를 거리별로 묶는다. 같은 거리 안에서는 다른 국가 도시를 먼저, 그다음 규모가 큰 순, 이름순이다.
// ownFirst면(발령·천도·백성동원) 내 국가 도시를 먼저 둔다.
export function groupByDistance<T extends TargetCity>(
  candidates: readonly T[],
  distances: ReadonlyMap<number, number>,
  ownNationId: number | null,
  ownFirst = false,
): DistanceGroup<T>[] {
  const groups = new Map<number | null, T[]>();
  for (const city of candidates) {
    const distance = distances.get(city.key) ?? null;
    const list = groups.get(distance) ?? [];
    list.push(city);
    groups.set(distance, list);
  }
  const own = (city: T) => ((ownNationId !== null && city.nationId === ownNationId) !== ownFirst ? 1 : 0);
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([distance, items]) => ({
      distance,
      items: items.sort((a, b) => own(a) - own(b) || b.level - a.level || a.name.localeCompare(b.name, 'ko')),
    }));
}

// 장수 이름 표시는 game/names.ts의 displayName 하나를 쓴다.
export { displayName } from '../game/names';

// 대상 도시 이름표 (INT-25 3단계). 원작처럼 `도시명 (국가명)`, 주인 없는 도시는 `(공백지)`다.
export function cityLabel(name: string, nationName: string | null | undefined): string {
  return `${name} (${nationName ?? '공백지'})`;
}

// 내 국가 도시를 먼저 고르는 명령(발령·천도·백성동원). 나머지는 다른 국가 도시를 먼저 둔다.
export const OWN_CITY_FIRST: ReadonlySet<string> = new Set(['nation_assign', 'nation_capital', 'nation_mobilize']);

// 이름 찾기. 이름 일부나 초성(ㅈㅈ → 조조)으로 찾는다.
const INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
function initialsOf(text: string): string {
  return Array.from(text, (char) => {
    const code = char.charCodeAt(0) - 0xac00;
    return code >= 0 && code < 11172 ? INITIALS[Math.floor(code / 588)]! : char;
  }).join('');
}
export function matchesName(name: string, query: string): boolean {
  const q = query.trim();
  if (q === '' || name.includes(q)) return true;
  return /^[ㄱ-ㅎ]+$/.test(q) && initialsOf(name).includes(q);
}

// 찾기 칸 옆의 수. 찾을 때는 `N개 / M개`, 아니면 전체 수만 적는다.
export function countText(shown: number, total: number, query: string): string {
  return query.trim() === '' ? `${total}개` : `${shown}개 / ${total}개`;
}

const n = (value: number) => value.toLocaleString('ko-KR');

// 대상 국가 카드 한 줄: `수도 X · 국력 N · 도시 N · 장수 N`. 모르는 값은 뺀다.
export function nationFactsText(facts: {
  capital?: string | null | undefined;
  power?: number | undefined;
  cities?: number | undefined;
  generals?: number | undefined;
}): string {
  return [
    facts.capital === undefined ? null : facts.capital === null ? '수도 없음' : `수도 ${facts.capital}`,
    facts.power === undefined ? null : `국력 ${n(facts.power)}`,
    facts.cities === undefined ? null : `도시 ${n(facts.cities)}`,
    facts.generals === undefined ? null : `장수 ${n(facts.generals)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export type RelationState = 'WAR' | 'DECLARED' | 'NON_AGGRESSION' | 'NONE';
const RELATION_NAMES: Record<RelationState, string> = {
  WAR: '교전',
  DECLARED: '선포',
  NON_AGGRESSION: '불가침',
  NONE: '관계 없음',
};

// 우리와의 관계와 남은 기간. 끝나는 달을 알면 지금 연월로 남은 달을 센다 (예: `선포 · 12개월 남음`).
export function relationLabel(
  relation: RelationState,
  endAt: { year: number; month: number } | null,
  now: { year: number; month: number } | null | undefined,
): string {
  const name = RELATION_NAMES[relation];
  if (!endAt) return name;
  if (!now) return `${name} · ${endAt.year}년 ${endAt.month}월까지`;
  const left = endAt.year * 12 + endAt.month - (now.year * 12 + now.month);
  return left > 0 ? `${name} · ${left}개월 남음` : `${name} · 이번 달까지`;
}

export interface GeneralFacts {
  id: number;
  name: string;
  isHuman?: boolean | undefined;
  leadership?: number | undefined;
  strength?: number | undefined;
  intel?: number | undefined;
  gold?: number | undefined;
  rice?: number | undefined;
  crew?: number | undefined;
  train?: number | undefined;
  atmos?: number | undefined;
}

// 장수 카드의 세 줄. 같은 국가 장수만 서버가 수치를 주므로 값이 없으면 그 줄은 없다.
export function statLine(g: GeneralFacts): string | null {
  return g.leadership === undefined || g.strength === undefined || g.intel === undefined
    ? null
    : `통솔 ${g.leadership} · 무력 ${g.strength} · 지력 ${g.intel}`;
}
export function troopLine(g: GeneralFacts): string | null {
  return g.crew === undefined ? null : `병력 ${n(g.crew)} · 훈련 ${g.train ?? 0} · 사기 ${g.atmos ?? 0}`;
}
export function purseLine(g: GeneralFacts): string | null {
  return g.gold === undefined || g.rice === undefined ? null : `금 ${n(g.gold)} · 쌀 ${n(g.rice)}`;
}

// 물자 순서로 놓는 명령. 포상은 고른 물자가 적은 장수부터, 몰수는 많은 장수부터 둔다.
export const RESOURCE_ORDER: Readonly<Record<string, 'asc' | 'desc'>> = { nation_reward: 'asc', nation_seize: 'desc' };

// 대상 장수 순서. 물자 순서가 있으면 그 값으로, 없으면 유저 장수를 먼저 두고 이름순이다. 물자를 모르는 장수는 뒤로 간다.
export function sortGenerals<T extends GeneralFacts>(
  list: readonly T[],
  order: { resource: 'gold' | 'rice'; direction: 'asc' | 'desc' } | null,
  label: (general: T) => string,
): T[] {
  const byName = (a: T, b: T) => label(a).localeCompare(label(b), 'ko');
  const npc = (g: T) => (g.isHuman === false ? 1 : 0);
  return [...list].sort((a, b) => {
    if (!order) return npc(a) - npc(b) || byName(a, b);
    const av = a[order.resource],
      bv = b[order.resource];
    if (av === undefined || bv === undefined) return av === bv ? byName(a, b) : av === undefined ? 1 : -1;
    return (order.direction === 'asc' ? av - bv : bv - av) || byName(a, b);
  });
}

// 모병·징병 수량 단추. 모집 상한은 통솔×100이고 지금 병력을 뺀 만큼 더 뽑는다 (규칙 commands/military.ts).
// 절반은 남은 자리의 반을 100명 단위로 내린 값이다.
export function recruitRoom(leadership: number, crew: number): { cap: number; room: number; half: number } {
  const cap = leadership * 100;
  const room = Math.max(0, cap - crew);
  return { cap, room, half: Math.floor(room / 200) * 100 };
}

type Purse = { gold: number; rice: number };

// 수량 칸의 `전부` 값. 물자를 내는 쪽이 가진 만큼이다 (규칙 commands/personal.ts·nation.ts의 부족 판정과 같은 쪽).
// 헌납·군량매매는 내 금·쌀, 포상·원조는 국고, 몰수는 대상 장수다. 모르면 null이다.
export function amountLimit(
  commandKey: string,
  values: Readonly<Record<string, string>>,
  purses: {
    wallet?: Purse | undefined;
    treasury?: Purse | undefined;
    target?: { gold?: number | undefined; rice?: number | undefined } | undefined;
  },
): number | null {
  const resource = values.resource === 'gold' || values.resource === 'rice' ? values.resource : null;
  if (commandKey === 'trade_rice')
    return values.buy === 'true'
      ? (purses.wallet?.gold ?? null)
      : values.buy === 'false'
        ? (purses.wallet?.rice ?? null)
        : null;
  if (!resource) return null;
  if (commandKey === 'donate') return purses.wallet?.[resource] ?? null;
  if (commandKey === 'nation_reward' || commandKey === 'nation_aid') return purses.treasury?.[resource] ?? null;
  if (commandKey === 'nation_seize') return purses.target?.[resource] ?? null;
  return null;
}

// 수량 칸의 자주 쓰는 값. 칸의 최소·최대 안의 값만 둔다.
export function amountPresets(min: number, max: number): number[] {
  return [100, 500, 1_000, 5_000, 10_000].filter((value) => value >= min && value <= max);
}
