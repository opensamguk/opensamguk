import type { PublicMapsResponse } from '../game/types';

type ResponseWorld = PublicMapsResponse['worlds'][number];
type ResponseMap = NonNullable<ResponseWorld['map']>;
type ResponseCity = ResponseMap['cities'][number];

// 화면이 쓰는 공개 지도. 서버 응답에서 공개 범위(D-026: 도시 소유 색과 국가 이름) 안의 키만 골라 담는다.
// 서버가 실수로 보급·장수·병력 같은 값을 섞어 보내도 화면까지 오지 않는다.
// 서버 사본은 도시 key·links를 문자열로 준다(T2-24). 메인 지도(WorldMap)는 숫자 key로 그리므로 여기서 바꾼다.
export type PublicCity = Omit<ResponseCity, 'key' | 'links'> & { key: number; links: number[] };
export type PublicNation = ResponseMap['nations'][number];
export type PublicMap = Omit<ResponseMap, 'cities'> & { cities: PublicCity[] };
export type PublicWorld = Omit<ResponseWorld, 'map'> & { map: PublicMap | null };
export interface PublicMaps {
  delayMinutes: number;
  worlds: PublicWorld[];
}

// 숫자로 읽을 수 없는 도시 키는 버린다. 없는 도시를 가리키는 연결은 WorldMap이 따로 버린다.
function cityKey(value: string): number | null {
  const key = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(key) ? key : null;
}

function toCity({ key, name, level, x, y, nationId, links }: ResponseCity): PublicCity | null {
  const parsed = cityKey(key);
  if (parsed === null) return null;
  return { key: parsed, name, level, x, y, nationId, links: links.map(cityKey).filter((link) => link !== null) };
}

function toMap({ takenAt, year, month, cities, nations }: ResponseMap): PublicMap {
  return {
    takenAt,
    year,
    month,
    cities: cities.map(toCity).filter((city) => city !== null),
    nations: nations.map(({ id, name, color }) => ({ id, name, color })),
  };
}

export function toPublicMaps({ delayMinutes, worlds }: PublicMapsResponse): PublicMaps {
  return {
    delayMinutes,
    worlds: worlds.map(({ id, name, status, map }) => ({ id, name, status, map: map && toMap(map) })),
  };
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
