import type { ReplayState, WorldState } from '@opensamguk/rules';

export interface LineageRepository {
  isUserActive(userId: string): Promise<boolean>;
  isSanctioned(worldId: string, userId: string): Promise<boolean>;
  load(worldId: string): Promise<WorldState>;
  loadForGeneral(worldId: string, generalId: number): Promise<ReplayState>;
  save(worldId: string, before: WorldState, next: WorldState, at: { tick: number; sequence: number }): Promise<void>;
  saveControl(
    worldId: string,
    before: ReplayState,
    next: ReplayState,
    fromId: number,
    toId: number,
    at: { tick: number; sequence: number },
  ): Promise<void>;
}
export interface LineageOrder {
  worldId: string;
  running: boolean;
  userId: string;
  generalId: number | null;
  payload: unknown;
  tick: number;
  sequence: number;
}
