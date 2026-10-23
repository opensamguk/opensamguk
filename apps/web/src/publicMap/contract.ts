import { queryOptions } from '@tanstack/react-query';
import { trpcClient } from '../trpc';
import { toPublicMaps, type PublicMaps } from './publicMaps';

// 임시 계약. docs/plans/T2-24.md의 조회(서버) 절에 적힌 world.publicMaps 응답 모양을 따른다.
// Codex API가 main에 들어오면 AppRouter 타입으로 바꾼다. 그때 이 파일의 캐스트와 PublicMapsRaw를 지우고
// trpc.world.publicMaps.queryOptions()를 쓴다. 쿼리 키는 tRPC 키 모양과 같게 두어 그대로 이어진다.
// 계획은 PublicCity의 key·links를 string으로 적었지만 근거로 든 mapCity(apps/server/src/visibility.ts)는 number다. 여기서는 number로 받는다.

export interface PublicCity {
  key: number;
  name: string;
  level: number;
  x: number;
  y: number;
  nationId: number | null;
  links: number[];
}

export interface PublicNation {
  id: number;
  name: string;
  color: string;
}

export interface PublicMapsRaw {
  delayMinutes: number;
  worlds: Array<{
    id: string;
    name: string;
    status: 'RUNNING' | 'PAUSED';
    map: null | { takenAt: string; year: number; month: number; cities: PublicCity[]; nations: PublicNation[] };
  }>;
}

interface PublicMapsClient {
  world: { publicMaps: { query: () => Promise<unknown> } };
}

const client = trpcClient as unknown as PublicMapsClient;

// 사본은 엔진이 5분마다 찍는다(T2-24). 1분마다 다시 받으면 새 사본이 늦어도 1분 안에 보인다.
export const publicMapsQueryOptions = () =>
  queryOptions<PublicMaps>({
    queryKey: [['world', 'publicMaps'], { type: 'query' }],
    queryFn: async () => toPublicMaps(await client.world.publicMaps.query()),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
