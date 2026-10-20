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
   ─▶ 상태 변경 + 로그 + 예턴 당김 + nextTurnTick 갱신 ─▶ 펜싱 토큰 조건부 commit ─▶ NOTIFY
```

- 펜싱 토큰이 바뀌었으면(다른 엔진이 실행권을 가져감) commit하지 않고 멈춥니다.
- 메모리 상태는 commit이 성공한 뒤에만 확정합니다.

## 4. 재시작

<!-- TODO(M1): 재시작하면 DB에서 월드를 다시 적재하고, nextTurnTick이 지난 장수부터 순서대로 처리. 이미 commit된 턴은 nextTurnTick이 앞으로 갔으므로 다시 실행되지 않는다 (AC-M1-11). -->

## 5. 재생 테스트

<!-- TODO(M1): 시드 + InputEvent 기록 + 예턴 편집 기록으로 같은 상태 해시를 재현 (AC-M1-13). 무엇을 기록해야 재생이 되는지 목록. -->
