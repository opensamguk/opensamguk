export interface HeritageIdentity {
  userId: string;
  sessionId: string | null;
  now: number;
}
export interface HeritageSnapshot {
  authenticated: boolean;
  balance: number;
  activeWorlds: { worldId: string; worldName: string; activityMonths: number }[];
  entries: {
    id: string;
    kind: string;
    worldId: string | null;
    worldName: string | null;
    delta: number;
    detail: unknown;
    createdAt: string;
  }[];
}
export interface HeritageReadStore {
  mine(identity: HeritageIdentity): Promise<HeritageSnapshot>;
}
export interface HeritageBalanceStore {
  balance(userId: string): Promise<number>;
}
