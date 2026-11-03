import type { GovernanceInput, GovernanceMovement, WorldView } from '@opensamguk/rules';

export type GovernanceIdentity = { userId: string; sessionId: string };
export interface GovernanceWorld {
  id: string;
  status: 'PREOPEN' | 'RUNNING' | 'PAUSED' | 'ENDED';
  clockTick: number;
  monthlyTick: number;
  replayFormat: number;
  ruleFeatures: readonly string[];
  replayOrigin: unknown;
  unitSet: unknown;
}
export interface GovernanceRequest {
  kind: string;
  idempotencyKey: string;
  generalId: number | null;
  status: 'PENDING' | 'APPLIED' | 'REJECTED';
  sequence: number | null;
  tick: number | null;
  payload: unknown;
  result: unknown;
}
export type GovernanceLedgerScope = { monarchNationId: number | null; generalId: number | null };
export interface GovernanceSnapshot {
  authenticated: boolean;
  sanctioned: boolean;
  world: GovernanceWorld | null;
  state: WorldView | null;
  previous: GovernanceRequest | null;
  movements: readonly (GovernanceMovement & { tick: number; sequence: number; ordinal: number })[];
}
export type GovernanceAdmission = { enqueue: false } | { enqueue: true; generalId: number; payload: GovernanceInput };
export interface GovernanceStore {
  read(
    identity: GovernanceIdentity,
    worldId: string,
    select: (snapshot: GovernanceSnapshot) => GovernanceLedgerScope,
  ): Promise<GovernanceSnapshot>;
  request(identity: GovernanceIdentity, worldId: string, requestId: string): Promise<GovernanceSnapshot>;
  submit(
    identity: GovernanceIdentity,
    worldId: string,
    requestId: string,
    decide: (snapshot: GovernanceSnapshot) => GovernanceAdmission,
  ): Promise<GovernanceRequest>;
}
