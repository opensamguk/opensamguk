import type { PublicCity, PublicMapsRaw, PublicNation } from './contract';

// 화면이 쓰는 공개 지도. 서버 응답에서 공개 범위(D-026: 도시 소유 색과 국가 이름) 안의 키만 골라 담는다.
// 서버가 실수로 보급·장수·병력 같은 값을 섞어 보내도 화면까지 오지 않는다.
export type PublicWorld = PublicMapsRaw['worlds'][number];
export type PublicMap = NonNullable<PublicWorld['map']>;
export interface PublicMaps {
  delayMinutes: number;
  worlds: PublicWorld[];
}

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null;
const isInt = (value: unknown): value is number => Number.isInteger(value);
const isText = (value: unknown): value is string => typeof value === 'string';

function pickCity(value: unknown): PublicCity | null {
  if (!isObject(value)) return null;
  const { key, name, level, x, y, nationId, links } = value;
  if (!isInt(key) || !isText(name) || !isInt(level) || typeof x !== 'number' || typeof y !== 'number') return null;
  return {
    key,
    name,
    level,
    x,
    y,
    nationId: isInt(nationId) ? nationId : null,
    links: Array.isArray(links) ? links.filter(isInt) : [],
  };
}

function pickNation(value: unknown): PublicNation | null {
  if (!isObject(value)) return null;
  const { id, name, color } = value;
  return isInt(id) && isText(name) && isText(color) ? { id, name, color } : null;
}

function pickMap(value: unknown): PublicMap | null {
  if (!isObject(value)) return null;
  const { takenAt, year, month, cities, nations } = value;
  if (!isText(takenAt) || Number.isNaN(Date.parse(takenAt)) || !isInt(year) || !isInt(month)) return null;
  return {
    takenAt,
    year,
    month,
    cities: Array.isArray(cities) ? cities.map(pickCity).filter((city) => city !== null) : [],
    nations: Array.isArray(nations) ? nations.map(pickNation).filter((nation) => nation !== null) : [],
  };
}

function pickWorld(value: unknown): PublicWorld | null {
  if (!isObject(value)) return null;
  const { id, name, status, map } = value;
  if (!isText(id) || !isText(name) || (status !== 'RUNNING' && status !== 'PAUSED')) return null;
  return { id, name, status, map: pickMap(map) };
}

export function toPublicMaps(raw: unknown): PublicMaps {
  if (!isObject(raw)) return { delayMinutes: 0, worlds: [] };
  const delayMinutes = isInt(raw.delayMinutes) && raw.delayMinutes > 0 ? raw.delayMinutes : 0;
  const worlds = Array.isArray(raw.worlds) ? raw.worlds.map(pickWorld).filter((world) => world !== null) : [];
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
