import type { StratagemCardsInput, WorldView } from '@opensamguk/rules';
export type StratagemCardsIdentity = { userId: string; sessionId: string };
export interface StratagemCardsWorld {
  id: string;
  status: 'PREOPEN' | 'RUNNING' | 'PAUSED' | 'ENDED';
  clockTick: number;
  monthlyTick: number;
  replayFormat: number;
  ruleFeatures: readonly string[];
  replayOrigin: unknown;
  unitSet: unknown;
}
export interface StratagemCardsRequest {
  kind: string;
  idempotencyKey: string;
  generalId: number | null;
  status: 'PENDING' | 'APPLIED' | 'REJECTED';
  sequence: number | null;
  tick: number | null;
  payload: unknown;
  result: unknown;
}
export interface StratagemCardsSnapshot {
  authenticated: boolean;
  sanctioned: boolean;
  world: StratagemCardsWorld | null;
  state: WorldView | null;
  previous: StratagemCardsRequest | null;
}
export type StratagemCardsAdmission =
  { enqueue: false } | { enqueue: true; generalId: number; payload: StratagemCardsInput };
export interface StratagemCardsStore {
  read(identity: StratagemCardsIdentity, worldId: string): Promise<StratagemCardsSnapshot>;
  request(identity: StratagemCardsIdentity, worldId: string, requestId: string): Promise<StratagemCardsSnapshot>;
  submit(
    identity: StratagemCardsIdentity,
    worldId: string,
    requestId: string,
    decide: (snapshot: StratagemCardsSnapshot) => StratagemCardsAdmission,
  ): Promise<StratagemCardsRequest>;
}
