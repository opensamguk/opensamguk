import { publicGeographySchema, type PublicGeography } from '@opensamguk/shared';
import type { PublicCity, PublicNation, PublicWorldStatus } from './contract';

// 화면이 쓰는 공개 지도. 서버 응답(PublicMapsOutput)에서 공개 범위(D-026: 도시 소유 색과 국가 이름) 안의 키만 골라 담는다.
// 서버가 실수로 보급·장수·병력 같은 값을 섞어 보내도 화면까지 오지 않는다.
export interface PublicMap {
  takenAt: string;
  year: number;
  month: number;
  cities: PublicCity[];
  nations: PublicNation[];
  operationalMap?: PublicGeography;
}
export interface PublicWorld {
  id: string;
  name: string;
  status: PublicWorldStatus;
  map: PublicMap | null;
}
export interface PublicMaps {
  delayMinutes: number;
  worlds: PublicWorld[];
}

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null;
const isInt = (value: unknown): value is number => Number.isInteger(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isCoord = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isColor = (value: unknown): value is string => isText(value) && /^#[0-9a-fA-F]{6}$/.test(value);

// 서버 사본의 도시 key·links는 문자열이고(T2-24) 메인 지도는 숫자 키를 쓴다. 여기서 한 번만 바꾼다.
// 0 이상 안전한 정수를 앞자리 0 없이 쓴 십진 표기만 받는다. 빈 문자열, "01", "1.0", "-1", "1e3", 너무 큰 수,
// 문자열이 아닌 값은 키로 쓰지 않는다. 비슷한 숫자로 고쳐 쓰지 않는다.
function toCityKey(value: unknown): number | null {
  if (!isText(value) || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const key = Number(value);
  return Number.isSafeInteger(key) ? key : null;
}

// 같은 키가 둘 이상이면 어느 쪽이 맞는지 알 수 없으므로 모두 버린다.
function dropDuplicates<T, K>(items: T[], keyOf: (item: T) => K): T[] {
  const counts = new Map<K, number>();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return items.filter((item) => counts.get(keyOf(item)) === 1);
}

const notNull = <T>(value: T | null): value is T => value !== null;

function pickCity(value: unknown): PublicCity | null {
  if (!isObject(value)) return null;
  const { key, name, level, x, y, nationId, links } = value;
  const cityKey = toCityKey(key);
  if (cityKey === null || !isText(name) || !isInt(level) || !isCoord(x) || !isCoord(y)) return null;
  // 소유가 틀린 도시를 공백지로 바꾸면 거짓 색이 된다. 도시째 버린다.
  if (nationId !== null && !isInt(nationId)) return null;
  if (!Array.isArray(links)) return null;
  if (value.kind !== undefined && value.kind !== 'CITY' && value.kind !== 'PASS') return null;
  return {
    key: cityKey,
    name,
    level,
    x,
    y,
    nationId,
    links: links.map(toCityKey).filter(notNull),
    ...(value.kind ? { kind: value.kind } : {}),
  };
}

function pickNation(value: unknown): PublicNation | null {
  if (!isObject(value)) return null;
  const { id, name, color } = value;
  return isInt(id) && isText(name) && isColor(color) ? { id, name, color } : null;
}

function pickMap(value: unknown): PublicMap | null {
  if (!isObject(value)) return null;
  const { takenAt, year, month, cities, nations } = value;
  if (!isText(takenAt) || Number.isNaN(Date.parse(takenAt)) || !isInt(year) || !isInt(month)) return null;
  if (!Array.isArray(cities) || !Array.isArray(nations)) return null;
  const pickedNations = dropDuplicates(nations.map(pickNation).filter(notNull), (nation) => nation.id);
  const nationIds = new Set(pickedNations.map((nation) => nation.id));
  // 사본에 없는 국가를 가리키는 도시는 이름과 색을 알 수 없다. 공백지로 그리지 않고 버린다.
  const pickedCities = dropDuplicates(cities.map(pickCity).filter(notNull), (city) => city.key).filter(
    (city) => city.nationId === null || nationIds.has(city.nationId),
  );
  const cityKeys = new Set(pickedCities.map((city) => city.key));
  const geography =
    value.operationalMap === undefined ? undefined : publicGeographySchema.safeParse(value.operationalMap);
  if (geography && !geography.success) return null;
  return {
    ...(geography?.success ? { operationalMap: geography.data } : {}),
    takenAt,
    year,
    month,
    cities: pickedCities.map((city) => ({
      ...city,
      links: [...new Set(city.links)].filter((key) => key !== city.key && cityKeys.has(key)),
    })),
    nations: pickedNations,
  };
}

function pickWorld(value: unknown): PublicWorld | null {
  if (!isObject(value)) return null;
  const { id, name, status, map } = value;
  if (!isText(id) || !isText(name) || (status !== 'RUNNING' && status !== 'PAUSED')) return null;
  return { id, name, status, map: pickMap(map) };
}

// 응답 타입은 AppRouter에서 오지만 화면은 값을 다시 확인한다. 모양이 틀린 칸은 대신할 값을 만들지 않고 버린다.
export function toPublicMaps(raw: unknown): PublicMaps {
  if (!isObject(raw)) return { delayMinutes: 0, worlds: [] };
  const delayMinutes = isInt(raw.delayMinutes) && raw.delayMinutes > 0 ? raw.delayMinutes : 0;
  const worlds = Array.isArray(raw.worlds)
    ? dropDuplicates(raw.worlds.map(pickWorld).filter(notNull), (world) => world.id)
    : [];
  return { delayMinutes, worlds };
}

// 기준 시각 줄. 사본의 게임 연월과 찍은 실제 시각을 같이 쓴다. 오늘이 아니면 날짜를 붙인다.
export function snapshotTimeText(map: Pick<PublicMap, 'takenAt' | 'year' | 'month'>, now: Date): string {
  const taken = new Date(map.takenAt);
  const hour = taken.getHours();
  const clock = `${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}시${taken.getMinutes() ? ` ${taken.getMinutes()}분` : ''}`;
  const sameDay = taken.toDateString() === now.toDateString();
  const day = sameDay ? '' : `${taken.getMonth() + 1}월 ${taken.getDate()}일 `;
  return `${map.year}년 ${map.month}월 · ${day}${clock} 기준`;
}

export const delayText = (delayMinutes: number) => `${delayMinutes}분 이상 지난 상태입니다`;
