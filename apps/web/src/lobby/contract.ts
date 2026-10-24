import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';

// 로비 응답 모양. AppRouter 타입에서만 꺼낸다 (T2-03 API 계약, 패키지 경계).
// 조회는 화면에서 trpc.lobby.worlds·trpc.lobby.notices의 queryOptions로 부른다.
type Outputs = inferRouterOutputs<AppRouter>['lobby'];

export type LobbyWorld = Outputs['worlds'][number];
export type LobbyNotice = Outputs['notices'][number];
