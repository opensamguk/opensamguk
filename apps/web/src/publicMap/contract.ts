import { trpc } from '../trpc';
import { toPublicMaps } from './publicMaps';

// world.publicMaps(T2-24) 조회. 응답 타입은 AppRouter에서 오고(game/types.ts의 PublicMapsResponse)
// select에서 화면이 그리는 모양으로 바꾼다.
// 사본은 엔진이 5분마다 찍는다(T2-24). 1분마다 다시 받으면 새 사본이 늦어도 1분 안에 보인다.
export const publicMapsQueryOptions = () =>
  trpc.world.publicMaps.queryOptions(undefined, {
    select: toPublicMaps,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
