# 요청·턴·저장 흐름

> 상태: 뼈대 · 필요 시점: M1 · 관련 AC: M1-08, M1-10, M1-11, M1-13
> 참고: core2026 `docs/developer/request-turn-persistence.md`, `docs/architecture/api-input-event-replay.md`
> 이 문서가 답할 질문: 요청 하나와 턴 하나가 언제, 어떤 순서로 저장되고 실패하면 어떻게 되나?

## 1. 예턴 저장 (server)

```text
요청(장수 ID는 세션에서) ─▶ strict 입력·명령 인자 검증 ─▶ World 잠금 ─▶ 멱등 키 재검사 ─▶ General 잠금 ─▶ turnRevision 비교
   ├─ 다르면: 거부 + 최신 목록 반환 (AC-M1-08)
   └─ 같으면: GeneralTurn 30칸 교체 + turnRevision 증가 + APPLIED InputEvent (한 트랜잭션)
```

`turns.get`과 충돌 응답은 같은 revision의 30칸을 반환한다. 조회는 RepeatableRead 스냅샷을 쓴다. API 입력의 칸 번호는 0~29이며 0번이 다음 실행 칸이다. null 칸과 생략한 args는 각각 `rest`와 `{}`로 바꾼다. 저장은 registry의 general 명령과 파싱된 인자만 허용한다. 표시용 name은 받지 않으며 출력 때 registry에서 붙인다. 빠진 DB 칸은 휴식으로 읽는다.

`turns.edit`의 put은 from..to 양끝을 포함해 덮어쓴다. shift 양수는 뒤로 밀고 음수는 앞으로 당기며 새 칸은 휴식으로 채운다. repeat는 편집 전 from..to 사본을 to+1부터 times번 복사하고 30칸 밖은 자른다. 편집도 `turns.set` 입력으로 최종 30칸만 기록한다. STALE·권한·형식 오류는 입력 기록과 revision을 바꾸지 않는다. 같은 revision 재전송은 STALE이므로 화면은 최신 목록으로 복구한다.

구현은 `routers/turns.ts`, `game/slots.ts`와 `packages/shared/src/editArray.ts`다. 편집 유틸에는 명령 registry와 게임 규칙을 넣지 않는다. `commands.list`와 예턴 API는 장수 명령 27개만 다루며 국가 명령 10개는 입력에서도 거부한다. `turns.precheck`는 같은 DB 스냅샷의 소유 장수 nextTurnTick과 검증한 World.unitSet을 actor에 넘기고 등용 제안은 World.commandMeta에서 읽는다. 클라이언트 actor·target·unitSet은 받지 않는다. 순수 precheck만 호출하므로 상태를 바꾸지 않으며 저장 때 조건 경고가 나더라도 형식이 맞으면 저장하고 실행 때 엔진이 다시 검사한다.

## 2. 즉시 행동 (server → engine)

```text
요청 ─▶ InputEvent(멱등 키) 기록 ─▶ engine이 가져가 처리 ─▶ 결과·상태를 한 트랜잭션으로 저장
```

`general.create`는 세션 사용자·월드로 접수한다. 서버가 `general.create:<UUID>` 키를 만들고 PENDING을 기록한다. 같은 actor·world의 PENDING이 있으면 정규화된 payload가 같을 때만 재사용하며 다른 payload는 CONFLICT다. 완료 뒤 재요청은 기존 장수가 있으므로 CONFLICT이며 `general.mine`으로 복구한다. REJECTED 뒤 재시도는 새 입력을 만든다. 첫 입력의 결과는 바꾸지 않는다.

API와 엔진은 NFC·trim 뒤 코드포인트 1~6글자 이름(한글 음절·Han·ASCII 영문·숫자), 실제 World.statRules의 정수·범위·정확한 합계, null 또는 10001~11000 초상을 검사한다. 생성은 RUNNING만 받는다. 엔진은 계정 ACTIVE와 월드 상태도 다시 검사하고 NPC를 포함한 정규화된 이름 중복을 거부한다. 접수 뒤 제재·탈퇴는 ACTOR_INACTIVE로 거부한다. 오류는 정해진 code/message만 공개한다.

엔진 `inputs.ts`가 리스→World 잠금 아래 id 순으로 한 건씩 처리한다. 순수 생성 규칙은 `packages/rules/src/general/create.ts`에 있다. `rngFor(seed, 'create', userId)`에서 cityKey 정렬 후보의 도시→affinity 1~150→턴 offset 0~9999 순서로 소비한다. ID는 잠금 아래 기존 최댓값+1이다. 초기 금·쌀은 1000, 재야·나이 20, 기본 병종이며 나머지 전투 수치는 0이다. nextTurnTick은 monthlyTick+offset에서 시작해 처리 tick보다 뒤가 될 때까지 월 간격을 더한다. 다중 월 지연도 같은 계산을 쓴다.

General·휴식 30칸·완료 sequence·InitialGeneral 전체 결과를 같은 펜싱 트랜잭션으로 저장한다. API는 commit 뒤 최대 5초 조회하고 미완료면 pending을 반환한다. mine.creation으로 pending·rejected를 구분한다. 공개 장수는 명시적 projection이며 userId·affinity·내부 입력 키·sequence는 내보내지 않는다. 세션은 30일 수명을 유지하며 잔여 15일 이하일 때만 연장·Set-Cookie를 한다. 정상 동시 연장은 최신 상태를 다시 읽어 인증 실패와 구분한다.

증거는 `tools/t1-11.integration.test.ts`의 실제 HTTP·PostgreSQL 권한·경합·원자성·SIGKILL·12개월 재생 시험으로 확인한다. 화면 AC는 T1-15에서 별도로 검증한다.

## 3. 턴 실행 (engine)

```text
리스·펜싱 토큰 확인 ─▶ 실행할 장수 고르기 (nextTurnTick 순) ─▶ 예턴 1칸 실행 (rules)
   ─▶ 상태 변경 + 로그 + 예턴 당김 + nextTurnTick 갱신 ─▶ 펜싱 토큰 조건부 commit
```

- 펜싱 토큰이 바뀌었으면(다른 엔진이 실행권을 가져감) commit하지 않고 멈춥니다.
- 메모리 상태는 commit이 성공한 뒤에만 확정합니다.
- `TurnLoop`는 한 턴마다 리스 행 → 월드 행 → 실행할 장수 행 순서로 잠급니다. `nextTurnTick`, 장수 ID 순으로 고르며 같은 tick의 실행 순서도 고정합니다. rules에는 `rngFor(seed, 'turn', 실행 tick, generalId)`를 전달합니다.
- 매 턴 현재 DB 상태를 다시 읽어 예턴 편집을 반영합니다. 규칙이 반환한 Effect를 사본에 적용한 뒤 변경한 필드만 저장합니다. 실행 검사 실패는 Effect 없이 실패 이유를 기록하고 턴을 소비합니다.
- 실행할 턴이 없는 폴링은 전체 월드 적재를 생략하며 기존 메모리 사본을 유지합니다. realtime 시계만 5초마다 별도 트랜잭션으로 체크포인트하고 manual은 호출한 목표 tick을 저장합니다. 정지 상태는 둘 다 저장하지 않습니다.
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

장수 턴은 국가 행을 지우기 직전에 공개 ID·이름·색과 삭제 행동 번호·tick을 `RemovedNation`에 같은 트랜잭션으로 남깁니다. 첫 정산 전이나 같은 달에 건국하고 멸망한 국가도 보존합니다. 월간 정산은 프레임 생성 직후 그 시점 국가의 ID·이름·색을 `YearbookNation`에 같은 트랜잭션으로 씁니다. 키 충돌도 전체 트랜잭션을 롤백합니다. 두 표는 게임 상태 해시와 v1·v2 재생 보관 파일에 들어가지 않습니다.

해시는 게임 상태, 정규화한 예턴 30칸, 장수별 revision, 마지막 정산 tick을 포함합니다. DB의 월드 UUID·행 ID·실제 시각·리스는 포함하지 않습니다. 초기 상태는 리소스에서 만든 전체 `WorldInit`을 그대로 보존하고 해시로 검사하므로 현재 리소스 파일이 바뀌어도 기록 안의 원본으로 재생합니다. 형식 버전은 1이며 다른 버전은 거부합니다.

`DATABASE_URL`이 설정된 환경에서 `pnpm exec tsx tools/replay.ts --world <ID> --output <새 파일>`로 일관된 DB 스냅샷을 내보냅니다. 파일은 0600으로 새로 만들며 기존 파일은 덮어쓰지 않습니다. `pnpm exec tsx tools/replay.ts --from <파일> --months 12`는 DB 없이 매달 상태·예턴 해시와 연감을 비교해 일치한 tick과 해시를 출력합니다. 원본 변조, 입력 순서·revision 불일치, 누락된 월간 기록, 지원하지 않는 입력, 해시 불일치는 종료 코드 1입니다. 마지막 연감 이후 입력과 미완료 요청은 해당 내보내기에 포함하지 않습니다.
