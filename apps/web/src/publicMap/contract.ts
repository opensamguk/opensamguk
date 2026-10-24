import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';
import type { MapCity, MapNation } from '../game/types';

// 공개 지도 응답 모양. AppRouter 타입에서만 꺼낸다 (T2-24 API 계약, 패키지 경계).
// 조회는 화면에서 trpc.world.publicMaps.queryOptions로 부른다. 서버 사본의 도시 key·links는 문자열이다.
export type PublicMapsOutput = inferRouterOutputs<AppRouter>['world']['publicMaps'];
export type PublicWorldStatus = PublicMapsOutput['worlds'][number]['status'];

// 화면이 쓰는 도시는 메인 지도(WorldMap)와 같은 숫자 키 단위다. 보급 값은 받지 않는다.
export type PublicCity = Omit<MapCity, 'supplied'>;
export type PublicNation = Pick<MapNation, 'id' | 'name' | 'color'>;
