import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';

// 화면이 쓰는 응답 모양. AppRouter 타입에서만 꺼낸다 (패키지 경계).
type Outputs = inferRouterOutputs<AppRouter>;

export type WorldSummary = Outputs['world']['summary'];
export type WorldMap = Outputs['world']['map'];
export type MapCity = WorldMap['cities'][number];
export type MapNation = WorldMap['nations'][number];
export type Home = Outputs['home']['get'];
export type CityView = Outputs['city']['get'];
export type NationView = Outputs['nation']['get'];
export type GeneralView = CityView['generals'][number];
export type GeneralLog = Home['recentLogs'][number];

// 공개 범위 밖이면 서버가 필드를 빼고 보낸다 (apps/server/src/visibility.ts, docs/plans/T1-12.md).
// cityInfo·nationInfo는 공개 모양과 상세 모양을 함께 반환하지만, 반환 타입 추론에서 상세 쪽이 공개 쪽에 흡수돼
// AppRouter 타입에는 공개 필드만 남는다. 그래서 상세 필드는 T1-12 계약대로 여기서 적고, 실제로 받았는지로 가른다.
export interface CityDetailFields {
  region: number;
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
}
export interface NationMemberFields {
  description: string;
  tech: number;
  philosophy: string;
  level: number;
  capitalCityKey: number | null;
  gold: number;
  rice: number;
  taxRate: number;
}
export type DetailedGeneral = Extract<GeneralView, { leadership: number }>;

export const isDetailedCity = <T extends object>(city: T): city is T & CityDetailFields => 'population' in city;
export const isMemberNation = <T extends object>(nation: T): nation is T & NationMemberFields => 'gold' in nation;
export const isDetailedGeneral = <T extends object>(general: T): general is Extract<T, { leadership: number }> =>
  'leadership' in general;
