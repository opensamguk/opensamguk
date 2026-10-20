# 요청·턴·저장 흐름

> 상태: 뼈대 · 필요 시점: M1 · 관련 AC: M1-08, M1-10, M1-11, M1-13
> 참고: core2026 `docs/developer/request-turn-persistence.md`, `docs/architecture/api-input-event-replay.md`
> 이 문서가 답할 질문: 요청 하나와 턴 하나가 언제, 어떤 순서로 저장되고, 실패하면 어떻게 되나?

## 1. 예턴 저장 (server)

```text
요청(장수 ID는 세션에서) ─▶ 입력 검증 ─▶ 현재 turnRevision과 비교
   ├─ 다르면: 거부 + 최신 목록 반환 (AC-M1-08)
   └─ 같으면: GeneralTurn 교체 + turnRevision 증가 (한 트랜잭션)
```

## 2. 즉시 행동 (server → engine)

```text
요청 ─▶ InputEvent(멱등 키) 기록 ─▶ engine이 가져가 처리 ─▶ 결과·상태를 한 트랜잭션으로 저장
```

<!-- TODO(M1): 같은 멱등 키로 다시 요청하면 처음 결과를 그대로 돌려준다 (core2026 api-input-event-replay 참고). -->

## 3. 턴 실행 (engine)

```text
리스·펜싱 토큰 확인 ─▶ 실행할 장수 고르기 (nextTurnTick 순) ─▶ 예턴 1칸 실행 (rules)
   ─▶ 상태 변경 + 로그 + 예턴 당김 + nextTurnTick 갱신 ─▶ 펜싱 토큰 조건부 commit
```

- 펜싱 토큰이 바뀌었으면(다른 엔진이 실행권을 가져감) commit하지 않고 멈춥니다.
- 메모리 상태는 commit이 성공한 뒤에만 확정합니다.
- `TurnLoop`는 한 턴마다 리스 행 → 월드 행 → 실행할 장수 행 순서로 잠급니다. `nextTurnTick`, 장수 ID 순으로 고르며 같은 tick의 실행 순서도 고정합니다. rules에는 `rngFor(seed, 'turn', 실행 tick, generalId)`를 전달합니다.
- 매 턴 현재 DB 상태를 다시 읽어 예턴 편집을 반영합니다. 규칙이 반환한 Effect를 사본에 적용한 뒤 변경한 필드만 저장합니다. 실행 검사 실패는 Effect 없이 실패 이유를 기록하고 턴을 소비합니다.
- 실행할 턴이 없는 폴링은 전체 월드 적재를 생략하며 기존 메모리 사본을 유지합니다. realtime 시계만 5초마다 별도 트랜잭션으로 체크포인트하고, manual은 호출한 목표 tick을 저장합니다. 정지 상태는 둘 다 저장하지 않습니다.
- `GeneralLog`는 장수·tick마다 한 행이며 복수 규칙 로그는 줄바꿈으로 묶습니다. `(worldId, generalId, tick)` unique 제약도 중복 기록을 막습니다.
- 같은 트랜잭션에서 0번을 소비하고 1~29번을 한 칸 당기며 29번은 휴식으로 채웁니다. 빈칸도 휴식입니다. `nextTurnTick += 10,000`, `turnRevision += 1`을 함께 저장합니다.
- 예턴 API(T1-11)는 장수 행 잠금 또는 `turnRevision` 조건부 UPDATE를 **같은 트랜잭션**에 포함해야 합니다. 엔진과 경합하면 오래된 revision으로 예턴을 덮어쓰지 않아야 합니다.
- commit 직전에도 DB 시각 기준 리스 만료와 소유자·토큰을 확인합니다. 실패하면 엔티티·로그·예턴·시계 모두 롤백합니다. NOTIFY/SSE는 M2 실시간 갱신에서 연결합니다.

## 4. 재시작

재시작한 엔진은 유효한 리스가 만료될 때까지 기다린 뒤 더 큰 토큰으로 획득하고 DB에서 월드를 다시 읽습니다. `nextTurnTick ≤ 현재 tick`인 턴을 순서대로 따라잡습니다.

- commit 전에 죽으면 열린 트랜잭션은 롤백됩니다. 예턴과 실행 tick이 남아 있으므로 같은 시드·장수·tick으로 같은 결과를 다시 계산합니다.
- commit 뒤에 죽으면 다음 턴 tick과 예턴 당김도 이미 저장되어 같은 턴을 재실행하지 않습니다.
- 리스가 살아 있는 동안 다른 엔진은 대기합니다. 만료 후에도 이전 엔진의 토큰으로는 갱신·턴 저장이 거부됩니다.

증거: `apps/engine/src/turnLoop.integration.test.ts`의 실제 PostgreSQL·별도 프로세스 SIGKILL(commit 직전/직후)·동시 프로세스·토큰 이전 테스트. `pnpm test:int`로 실행합니다.

## 5. 재생 테스트

<!-- TODO(M1): 시드 + InputEvent 기록 + 예턴 편집 기록으로 같은 상태 해시를 재현 (AC-M1-13). 무엇을 기록해야 재생이 되는지 목록. -->
