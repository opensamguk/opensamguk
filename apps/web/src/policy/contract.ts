import type { QueryKey, UseMutationOptions, UseQueryOptions } from '@tanstack/react-query';
import type { Home } from '../game/types';
import type { Trpc } from '../trpc';

// 임시 계약. docs/plans/T2-13.md 절 "화면(T2-14)이 기대하는 응답 모양"과 "예턴 칸 모양과 전환"을 옮겼다.
// general.policy·general.setPolicy와 칸의 explicit, home.get의 policy는 아직 AppRouter에 없다.
// Codex API가 main에 들어오면 AppRouter 타입으로 바꾸고 이 파일을 지운다 (game/types.ts처럼 inferRouterOutputs에서 꺼낸다).

export type PolicyKey = 'none' | 'farm' | 'commerce' | 'security' | 'defend' | 'drill';
export type CommandRef = { key: string; name: string };

export type PolicyOption = {
  key: PolicyKey;
  name: string;
  emptyCommand: CommandRef;
  thenCommand: CommandRef | null;
};

export type PolicyResponse = {
  current: PolicyKey;
  pending: PolicyKey | null;
  lastRejected: { policy: PolicyKey; reason: string } | null;
  options: PolicyOption[];
  inactiveAfterDays: number;
};

export type SetPolicyOutcome = { status: 'applied'; policy: PolicyResponse } | { status: 'pending' };
export type SetPolicyInput = { worldId: string; policy: PolicyKey };

export type SlotView = { commandKey: string; args: unknown; name: string; explicit: boolean };
export type GeneralPolicySummary = { policy: { key: PolicyKey; name: string } };

interface PolicyProcedures {
  policy: {
    queryOptions(input: { worldId: string }): UseQueryOptions<PolicyResponse, unknown, PolicyResponse, QueryKey>;
    queryKey(input: { worldId: string }): QueryKey;
  };
  setPolicy: {
    mutationOptions(): UseMutationOptions<SetPolicyOutcome, unknown, SetPolicyInput>;
  };
}

// tRPC 프록시는 경로를 실행 중에 만든다. 타입만 계약대로 붙인다.
export const policyProcedures = (trpc: Trpc): PolicyProcedures =>
  (trpc as unknown as { general: PolicyProcedures }).general;

// home.get 장수 요약의 방침. 아직 응답에 없으면 null이다.
export function homePolicy(home: Home): GeneralPolicySummary['policy'] | null {
  return (home.general as Partial<GeneralPolicySummary>).policy ?? null;
}
