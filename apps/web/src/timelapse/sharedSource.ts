import { publicGeographySchema, type PublicGeography } from '@opensamguk/shared';
import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';
import type { SavedFrame } from './displaySource';
import type { TimelapseFrame, TimelapseMapCity, TimelapsePage } from './frames';

// 종료 월드 공유 화면이 공개 조회 응답에서 재생 입력만 고르는 함수 (docs/plans/T4-37.md 3.2, T4-91 2.1).
// 서버가 다른 키를 섞어 보내도 그리지 않도록 보이는 칸만 새 객체로 옮긴다. 지금 국가 행 값이나 지어낸 값을 넣지 않는다.

export type PublicFrames = inferRouterOutputs<AppRouter>['timelapse']['publicFrames'];
type PublicCity = NonNullable<PublicFrames['map']>['cities'][number];
type PublicFrame = PublicFrames['items'][number];

export type SharedFrame = TimelapseFrame & SavedFrame;
export interface SharedHead {
  world: { name: string; endedYear: number; endedMonth: number };
  map: TimelapseMapCity[];
  operationalMap?: PublicGeography;
}

// 공개 지도 다섯 칸을 재생 부품의 지도 칸 이름(key·links)으로 옮긴다. 규모·소유·보급은 채우지 않는다.
export function toSharedMap(cities: readonly PublicCity[]): TimelapseMapCity[] {
  return cities.map(({ cityKey, name, x, y, connections }) => ({ key: cityKey, name, x, y, links: [...connections] }));
}

export function toSharedFrame(frame: PublicFrame): SharedFrame {
  return {
    tick: frame.tick,
    year: frame.year,
    month: frame.month,
    cities: frame.cities.map(({ cityKey, nationId }) => ({ cityKey, nationId })),
    nations: frame.nations.map(({ id, name, color }) => ({ id, name, color })),
  };
}

export function toSharedPage(page: PublicFrames): TimelapsePage<SharedFrame> {
  return { items: page.items.map(toSharedFrame), nextCursor: page.nextCursor };
}

// 첫 페이지에서만 월드 이름·종료 연월과 지도를 읽는다. 첫 페이지에 지도가 없으면 계약 위반이라 그리지 않는다.
export class SharedMapMissingError extends Error {
  constructor() {
    super('공유 지도를 받지 못했습니다.');
    this.name = 'SharedMapMissingError';
  }
}
export function toSharedHead(page: PublicFrames): SharedHead {
  if (page.map === null) throw new SharedMapMissingError();
  const { name, endedYear, endedMonth } = page.world;
  const geometry =
    page.map.operationalMap === undefined ? undefined : publicGeographySchema.parse(page.map.operationalMap);
  return {
    world: { name, endedYear, endedMonth },
    map: toSharedMap(page.map.cities),
    ...(geometry ? { operationalMap: geometry } : {}),
  };
}
