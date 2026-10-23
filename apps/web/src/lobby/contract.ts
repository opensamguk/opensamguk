import { getUntypedClient } from '@trpc/client';
import { queryOptions } from '@tanstack/react-query';
import { trpcClient } from '../trpc';

// 임시 계약. 기준은 docs/plans/T2-03.md의 "API 계약" 절이다.
// Codex API(lobby.worlds, lobby.notices)가 main에 들어오면 AppRouter 타입으로 바꾸고 이 파일을 지운다.
// 그때 queryOptions 두 개는 trpc.lobby.worlds.queryOptions(...)와 trpc.lobby.notices.queryOptions()로 바뀐다.
// 쿼리 키는 tRPC tanstack 키 모양으로 맞춰 두어 바꾼 뒤에도 무효화 키가 같다.

export type GameDate = { year: number; month: number };

export type LobbyWorld = {
  id: string;
  name: string;
  status: 'PREOPEN' | 'RUNNING' | 'PAUSED' | 'ENDED';
  presetName: string | null;
  scenarioTitle: string;
  startYear: number;
  gameDate: GameDate;
  turnTermMinutes: number;
  startedAt: string | null;
  humanGenerals: number;
  // D-025 승인 뒤에만 있는 키다. 승인 전 응답에는 키 자체가 없다.
  maxHumanGenerals?: number | null;
  myGeneral: { id: number; name: string; nationName: string | null } | null;
  createBlockedReason: string | null;
};

export type LobbyNotice = { id: string; title: string; body: string; publishedAt: string };

const untyped = () => getUntypedClient(trpcClient);

// M2 화면은 includeEnded를 쓰지 않는다 (T2-04 화면 절).
export const lobbyWorldsQuery = () =>
  queryOptions({
    queryKey: [['lobby', 'worlds'], { input: {}, type: 'query' }],
    queryFn: () => untyped().query('lobby.worlds', {}) as Promise<LobbyWorld[]>,
    staleTime: 0,
  });

export const lobbyNoticesQuery = () =>
  queryOptions({
    queryKey: [['lobby', 'notices'], { type: 'query' }],
    queryFn: () => untyped().query('lobby.notices') as Promise<LobbyNotice[]>,
  });
