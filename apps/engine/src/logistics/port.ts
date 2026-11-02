import type { LogisticsMovement, WorldState } from '@opensamguk/rules';

export interface LogisticsRepository {
  isUserActive(userId: string): Promise<boolean>;
  isSanctioned(worldId: string, userId: string): Promise<boolean>;
  loadForGeneral(worldId: string, generalId: number): Promise<WorldState>;
  // 같은 엔진 트랜잭션에서 상태·금·원장만 한 번 쓴다. InputEvent 결과·순번은 호출자가 마감한다.
  // 다른 기능의 afterQueuedInput은 물류·금을 중복 정산하면 안 된다. 공통 인사 후처리는 현재 상태를 읽어 실행한다.
  // PG와 DO 어댑터에 같은 계약을 적용한다.
  save(
    worldId: string,
    before: WorldState,
    next: WorldState,
    movements: readonly LogisticsMovement[],
    at: { tick: number; sequence: number },
  ): Promise<void>;
}

export interface LogisticsOrder {
  worldId: string;
  running: boolean;
  userId: string;
  generalId: number | null;
  payload: unknown;
  tick: number;
  sequence: number;
}
