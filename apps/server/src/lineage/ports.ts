import type { LineageInput, WorldView } from '@opensamguk/rules';
export type LineageIdentity = { userId: string; sessionId: string };
export interface LineageWorld {
  id: string;
  status: 'PREOPEN' | 'RUNNING' | 'PAUSED' | 'ENDED';
  clockTick: number;
  monthlyTick: number;
  replayFormat: number;
  ruleFeatures: readonly string[];
  replayOrigin: unknown;
  unitSet: unknown;
}
export interface LineageRequest {
  kind: string;
  idempotencyKey: string;
  generalId: number | null;
  status: 'PENDING' | 'APPLIED' | 'REJECTED';
  sequence: number | null;
  tick: number | null;
  payload: unknown;
  result: unknown;
}
export interface LineageSnapshot {
  authenticated: boolean;
  sanctioned: boolean;
  world: LineageWorld | null;
  state: WorldView | null;
  previous: LineageRequest | null;
}
export type LineageAdmission = { enqueue: false } | { enqueue: true; generalId: number; payload: LineageInput };
export interface LineageStore {
  read(identity: LineageIdentity, worldId: string): Promise<LineageSnapshot>;
  request(identity: LineageIdentity, worldId: string, requestId: string): Promise<LineageSnapshot>;
  submit(
    identity: LineageIdentity,
    worldId: string,
    requestId: string,
    decide: (snapshot: LineageSnapshot) => LineageAdmission,
  ): Promise<LineageRequest>;
}
