import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { Home } from '../game/types';

// 기본 방침 화면이 쓰는 응답 모양. AppRouter 타입에서만 꺼낸다 (T2-13 general.policy·general.setPolicy).
type Outputs = inferRouterOutputs<AppRouter>;
type Inputs = inferRouterInputs<AppRouter>;

export type PolicyResponse = Outputs['general']['policy'];
export type SetPolicyOutcome = Outputs['general']['setPolicy'];
export type SetPolicyInput = Inputs['general']['setPolicy'];
export type PolicyKey = PolicyResponse['current'];
export type PolicyOption = PolicyResponse['options'][number];
export type PolicyRejection = NonNullable<PolicyResponse['lastRejected']>;
// home.get 장수 요약의 방침 이름.
export type HomePolicy = Home['general']['policy'];
