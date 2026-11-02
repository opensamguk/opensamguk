import type { LogisticsInput, LogisticsMovement, WorldView } from '@opensamguk/rules';

export type LogisticsIdentity = { userId: string; sessionId: string };
export interface LogisticsWorld {
  id: string;
  status: 'PREOPEN' | 'RUNNING' | 'PAUSED' | 'ENDED';
  clockTick: number;
  monthlyTick: number;
  replayFormat: number;
  ruleFeatures: readonly string[];
  replayOrigin: unknown;
  unitSet: unknown;
}
export interface LogisticsRequest {
  kind: string;
  idempotencyKey: string;
  generalId: number | null;
  status: 'PENDING' | 'APPLIED' | 'REJECTED';
  sequence: number | null;
  tick: number | null;
  payload: unknown;
  result: unknown;
}
export interface LogisticsSnapshot {
  authenticated: boolean;
  sanctioned: boolean;
  world: LogisticsWorld | null;
  state: WorldView | null;
  previous: LogisticsRequest | null;
  movements: readonly (LogisticsMovement & { tick: number; sequence: number; ordinal: number })[];
}
export type LogisticsAdmission = { enqueue: false } | { enqueue: true; generalId: number; payload: LogisticsInput };

export interface LogisticsStore {
  read(identity: LogisticsIdentity, worldId: string, cityKey: number): Promise<LogisticsSnapshot>;
  request(identity: LogisticsIdentity, worldId: string, requestId: string): Promise<LogisticsSnapshot>;
  // 현재 월드·멱등 키를 고정한 저장소 트랜잭션에서 동기 판정 후 입력+활동만 원자적으로 접수한다.
  // PG는 World 잠금, DO는 동기 SQL transaction을 쓴다. 게임 재고는 이 경로에서 쓰지 않는다.
  submit(
    identity: LogisticsIdentity,
    worldId: string,
    requestId: string,
    decide: (snapshot: LogisticsSnapshot) => LogisticsAdmission,
  ): Promise<LogisticsRequest>;
}
