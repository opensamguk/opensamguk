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

새 월드는 생성 시점의 `WorldInit`과 리소스 내용 해시를 `World.replayOrigin`에 저장합니다. 기존 월드는 원본을 추측하지 않고 재생을 거부합니다. 예턴·장수 생성 입력은 `InputEvent`에 남깁니다. 기록 파일은 사용자 식별자를 포함할 수 있으므로 공개하지 않습니다.

### InputEvent 계약 (T1-07 소유, T1-11 사용)

`id`는 DB BigInt 접수 순서입니다. `worldId`, 세션의 `userId`, 선택적 `generalId`, `kind`, `idempotencyKey`, `payload`를 저장합니다. `(worldId, userId, idempotencyKey)`는 유일하며 재요청은 kind·payload 일치 여부를 검사한 뒤 기존 결과를 돌려줍니다. 실패한 요청도 처음 결과를 바꾸지 않습니다.

`general.create` 접수는 `PENDING`, `sequence = null`, `result = null`입니다. 엔진의 성공은 `APPLIED`, 확정 실패는 `REJECTED`로 저장합니다. 성공 결과의 `general`에는 생성된 `InitialGeneral` 전체를 담습니다. 생성 RNG·검증·결과 저장은 T1-11이 담당합니다. `turns.set`은 API의 예턴 30칸 교체·revision 증가와 같은 트랜잭션에서 `APPLIED`로 기록합니다. payload는 `{ turns: [{ commandKey, args }, ...30칸], revision: 저장 전 revision }`, result는 `{ revision: 저장 후 revision }`입니다. `generalId`는 이벤트 열에서 읽습니다.

처리 순서는 `World.actionSequence`로 고정합니다. 입력 완료·턴 실행·월간 정산마다 `nextActionSequence(tx, worldId)`를 한 번 호출합니다. 완료한 입력의 sequence는 양수이며 월드 안에서 유일합니다. `REJECTED`도 sequence와 오류 결과를 남기며 재생 시 상태를 바꾸지 않습니다. `PENDING`에는 sequence를 부여하지 않습니다. DB 제약이 이 구분을 검사합니다.

API와 엔진 모두 월드 행을 장수 행보다 먼저 잠급니다. API는 월드 행 잠금 → 멱등 키 재검사 → 장수 행·revision 검사 → 예턴 및 입력 저장 순서입니다. 엔진은 리스 행 → 월드 행 → 장수 행 순서를 유지합니다. 밀린 턴 도중 접수된 예턴도 actionSequence 덕분에 실제 적용 위치에서 재생됩니다. 시계 tick만으로 입력을 정렬하지 않습니다.

`YearbookSnapshot`은 정산 경계 tick·정산한 연월·actionSequence·국가 요약·도시 소유권·게임 상태 및 예턴 해시를 보존합니다. `NationHistory`에는 같은 경계의 국가 요약을 남깁니다. `World.monthlyTick`은 마지막 정산 경계이며 시계 체크포인트와 별개입니다. 세 값과 정산 상태는 같은 펜싱 트랜잭션으로 저장합니다.

해시는 게임 상태, 정규화한 예턴 30칸, 장수별 revision, 마지막 정산 tick을 포함합니다. DB의 월드 UUID·행 ID·실제 시각·리스는 포함하지 않습니다. 초기 상태는 리소스에서 만든 전체 `WorldInit`을 그대로 보존하고 해시로 검사하므로 현재 리소스 파일이 바뀌어도 기록 안의 원본으로 재생합니다. 형식 버전은 1이며 다른 버전은 거부합니다.

`DATABASE_URL`이 설정된 환경에서 `pnpm exec tsx tools/replay.ts --world <ID> --output <새 파일>`로 일관된 DB 스냅샷을 내보냅니다. 파일은 0600으로 새로 만들며 기존 파일은 덮어쓰지 않습니다. `pnpm exec tsx tools/replay.ts --from <파일> --months 12`는 DB 없이 매달 상태·예턴 해시와 연감을 비교해 일치한 tick과 해시를 출력합니다. 원본 변조, 입력 순서·revision 불일치, 누락된 월간 기록, 지원하지 않는 입력, 해시 불일치는 종료 코드 1입니다. 마지막 연감 이후 입력과 미완료 요청은 해당 내보내기에 포함하지 않습니다.
