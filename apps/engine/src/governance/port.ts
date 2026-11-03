import type { WorldState } from '@opensamguk/rules';

export interface GovernanceRepository {
  isUserActive(userId: string): Promise<boolean>;
  isSanctioned(worldId: string, userId: string): Promise<boolean>;
  load(worldId: string): Promise<WorldState>;
  loadForGeneral(worldId: string, generalId: number): Promise<WorldState>;
  save(worldId: string, before: WorldState, next: WorldState, at: { tick: number; sequence: number }): Promise<void>;
}
export interface GovernanceOrder {
  worldId: string;
  running: boolean;
  userId: string;
  generalId: number | null;
  payload: unknown;
  tick: number;
  sequence: number;
}
