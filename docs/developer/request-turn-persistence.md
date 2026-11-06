# 요청·턴·저장 흐름

## 관리자 게임 조치 후보 (INT-23 PR1·2 · AC-INT-23)

`admin.game.request`는 현재 세션의 관리자와 `expectedUserId`가 같은지 확인한다. World 잠금 뒤 현재 계정·세션·제재·인증·동의를 다시 검사한다. 입력은 `{expectedUserId,worldId,idempotencyKey,reason,action}`이다. 장수 이름·NPC 전환·30칸 비우기·내보내기·수치, 도시 수치, 국가 수치·이름·수뇌 임명 취소의9종을 받는다. 수치마다 `{expected,value}`를 받으며 장수 능력치나 도시 소유 국가는 바꾸지 않는다.

접수는 형식3의 RUNNING·PAUSED 월드에 PENDING 입력과 `game.request` 감사만 쓴다. 같은 키·같은 정규형 입력은 기존 결과를 반환하고 다른 내용은409다. 인증·약관 경계를 지난 요청의 권한·형식·접수 거절은 `game.request.rejected` 감사에 오류 코드만 남긴다. 원래 요청 트랜잭션을 되돌린 뒤 남기는 감사이므로 거절된 InputEvent는 만들지 않는다. `admin.game.requestStatus`는 현재 관리자 자격을 다시 검사하고 본인 계정·월드·키의 결과만 읽는다.

엔진은 기존 시계·종료·초기화와 같은 운영 대기열에서 id 순서로 하나씩 처리한다. 리스→World→행위자 잠금과 현재 관리자·전체 제재·월드 상태를 검사한다. 수치의 모든 `expected`와 대상·범위도 확인한다. 부곡 월드는 장수 행의 병력·병종·훈련·사기를 `CAMPAIGN_FIELD`로 거절한다. 일반 월드의 병종은 원생성 병종표에 있는 전투 병종만 받는다. 적용·거절 모두 순서와 tick, 처리 감사를 같은 트랜잭션에 쓴다.

적용은 rules 등록부와 `applyRecordedInput`의 공통 후처리를 거친다. NPC 전환은 사람 연결·활동 기준을 지우고 군주였다면 국가의 NPC 표시를 켠다. 소속·관직·병력은 유지한다. 30칸 비우기는 방침 월드의 빈칸 형식을 유지하고 revision을1 올린다. 인사 후처리는 수뇌 자리와 발령 제안, 실제 이동의 거주 앵커도 함께 저장한다. 재생은 변경 전후를 다시 계산해 기록과 대조한다. 기존 형식과 caps에는 새 운영 입력을 넣을 수 없다.

`{kind:'admin.general.remove',generalId}`는 군주를 제외한 장수의 활동을 끝낸다. 처리 tick을 `General.removedAt`에 저장하며 행·이름·기록 참조는 남긴다. 기존 장수의 null은 규칙 상태에서 키를 생략해 이전 해시를 지킨다. 조작권·소속·관직·활동 기록을 해제하고 병력은 실제 지휘관이 있는 도시 주민으로 최대치까지 돌려준다. 소유·지휘 부곡은 해산하고 휘하·발령·혼인·조정 직위와 제안을 정리한다. 턴·순위·현재 인원 조회·명령 대상에서 제외하며 이 장수가 앞서 접수한 대기 입력은 `GENERAL_REMOVED`로 거절한다. 계정은 생성이 열린 월드에서 새 장수를 만들 수 있다. 가문의 사망·계승으로 기록하지 않는다.

`admin.message.send`는 같은 요청 경로에서 `{scope:'WORLD',body}` 또는 `{scope:'PRIVATE',generalId,body}`를 받는다. 본문은 공백만으로 쓸 수 없고 최대 1,000자다. 게임 수치를 바꾸지 않는 엄격한 입력으로 재생하고 실제 쪽지는 엔진 트랜잭션에서 한 번 저장한다. 거절·롤백 때 쪽지는 생기지 않는다. 저장 발신자는 `{kind:'admin',name:'운영'}`이며 응답에는 기존 `generalId:null,nation:null`도 있어 기존 발신자 표시를 유지한다. 알림은 commit 뒤 기존 실시간 경로로 보낸다.

적용한 장수 조치는 해당 `GeneralLog`의 `kind:'admin'`으로, 국가·도시 조치는 월드 쪽지로 남긴다. 운영 계정과 사유는 감사에만 남긴다. 개인 기록과 홈 최근 기록은 `(tick,id)` 내림차순이다. `records.general`은 새 복합 커서를 돌려주며 기존 숫자 커서도 받는다. 나머지 개인 기록 API의 커서는 그대로다.

운영 조회는 모두 `adminProcedure`이며 같은 트랜잭션에서 현재 관리자·세션을 다시 검사하고 `admin.game.read` 감사를 저장한다. `admin.game.general`은 `{worldId,generalId}`를 받아 퇴장 여부와 연결 계정을 포함한 장수 상세를 돌려준다. 없는 대상 조회도 감사한 뒤 NOT_FOUND를 돌려준다. `generalLogs`·`generalInputs`는 같은 필수 입력에, `nationLogs`는 선택 `nationId`, `battles`는 선택 `generalId`에 `fromTick`·`toTick`·불투명 `cursor`를 받는다. 목록 응답은 `{items,nextCursor}`이고 한 페이지 최대 100행이다. 전투의 장수 필터는 공격자와 기록 대상 양쪽에 적용한다. 같은 tick의 경계에서도 중복·누락 없이 다음 행으로 이어진다.

공개 기록·쪽지·운영 조회는 전체 검사·독립 리뷰·보호 병합 전의 후보다. 운영 화면은 Claude 담당이며 전체 AC-INT-23은 미완료다.

## 관리자 초기화 적용 후보 (ADMIN-RESET-D1~D3)

초기화는 기존 원본 월드의 `(worldId, userId, idempotencyKey)` InputEvent를 단일 요청 원장으로 쓴다. 새 표나 migration은 없다. `requestReset`은 World 쓰기 잠금 뒤 현재 User·Session과 관리자 자격·제재·인증·동의를 확인한다. 기존 키를 먼저 대조하고 새 접수만 원본 상태·이름·revision·원생성 형식3을 검사한다. 서버가 처음 만든 새 월드 UUID와 실제 시드를 엄격 payload에 고정하고 PENDING·요청 감사만 함께 확정한다. 같은 정규형 재접수는 원래 결과를 반환한다. `resetRequest`도 현재 자격을 확인하며 본인의 월드·키만 읽는다.

준비 단계는 원본 초기·자원·설정 해시를 확인하고 생성 요청·이전 APPLIED 초기화·CLI 출처를 구분한다. 존재하는 잘못된 출처나 읽기 실패를 CLI 부재로 취급하지 않는다. 첫 fenced 조회 뒤 TX 밖에서 읽기 전용 RepeatableRead 준비를 하며 기존 리스를 유한 갱신한다. 후보는 원 준비 객체·증거·요청 시드와 선두 입력 전체에 결속한다. 공유 검증은 호출자가 소유한 기존30초 적용 트랜잭션에서 동일 출처 fingerprint와 5종 PUBLISHED 자원을 대조하고 자원 행을 정렬된 FOR SHARE로 잠근다. 준비 트랜잭션을 중첩하지 않는다.

적용은 리스→World→현재 User 순서로 잠그고 현재 활성 관리자·전체 제재를 확인한다. 로그아웃만으로 이미 접수한 요청을 취소하지 않는다. 원본 ENDED·새 PREOPEN·APPLIED InputEvent·감사를 함께 확정하고 마지막 취소·fence 검사에 실패하면 모두 롤백한다. 원본 게임·사람·30칸과 이전 입력은 유지하며 새 월드에 사람을 복사하지 않는다. 종료 뒤 일반 입력은 기존 거부 경로로 처리한다. 형식3 `ADMIN_RESET` 재생은 원본 종료 해시와 새 월드의 독립 원생성을 구분한다. 현재는 소스 후보이며 실제 PG·복원·전체 검사·독립 리뷰·보호 병합은 남아 있다.

## 관리자 월드 생성 후보

ADMIN-CREATE-B는 아직 월드가 없는 접수를 `WorldCreateRequest`에 둔다. API는 현재 User 쓰기 잠금과 Session 읽기 잠금 뒤 기존 요청을 MVCC로 읽으며 요청 행 잠금을 추가하지 않는다. 엔진은 요청 행을 `FOR UPDATE SKIP LOCKED`로 먼저 잠그고 User 읽기 잠금 뒤 현재 자격·제재를 확인한다. 이 순서가 API와 엔진의 User/요청 교착을 막는다. 게시 자원의 버전·해시를 검증하고 최초 해석을 요청에 고정한 뒤 저장 트랜잭션에서 다시 대조한다. 월드·DONE·감사는 한 트랜잭션이며 실패하면 PENDING을 보존한다. 확정 자료 오류는 FAILED와 기각 감사를 함께 쓴다. 접속 오류는 후속 발견에서 재시도한다. 기존 게임 InputEvent·리스·시드 RNG 경계는 유지한다.

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

T4-97의 AC-P2-34·AC-INT-20 후속으로 `general.mine.creationRules.personnelEnabled`는 항상 boolean을 반환한다. 장수 생성 전후 모두 저장된 월드의 replayFormat이 3이고 ruleFeatures에 personnel이 있을 때만 true다. 화면은 이 값으로 인사 조회와 메뉴를 켠다. 실제 인사 API는 기존 세션·월드·장수 권한을 계속 검사한다.

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

해시는 게임 상태, 정규화한 예턴 30칸, 장수별 revision, 마지막 정산 tick을 포함합니다. DB의 월드 UUID·행 ID·실제 시각·리스는 포함하지 않습니다. 초기 상태는 리소스에서 만든 전체 `WorldInit`을 그대로 보존하고 해시로 검사하므로 현재 리소스 파일이 바뀌어도 기록 안의 원본으로 재생합니다. 생성 형식은 1·3을 받습니다.

| origin | archive | 적용 |
| ------ | ------- | ---- |
| 1 | 1·2 | 기존 규칙과 수출 바이트 유지 |
| 3 | 3 | 기능 목록과 처리 tick을 기록하는 새 월드 |

새 월드는 기능을 켜지 않아도 origin 3입니다. 켠 기능은 비지 않은 오름차순 배열인 `initial.ruleFeatures`에 담고 기능이 없으면 키를 생략합니다. 기능 자료 사본은 `origin.featureData`에 담으며 키는 켠 기능의 부분집합입니다. 빈 자료 객체는 받지 않습니다. 자료가 없으면 리소스 해시 식도 형식 1과 같습니다. 기능 자료·초기 상태는 기능별 `checkOrigin`, 거부 입력과 종료 뒤 입력을 포함한 전체 입력은 `checkArchive`로 검사합니다. 모르는 기능·빠진 의존·충돌 조합은 생성과 재생 전에 거부합니다.

`World.replayFormat`과 `World.ruleFeatures`는 생성 기록의 읽기용 사본이며 생성 뒤 바꾸지 않습니다. 엔진은 리스를 얻은 뒤 첫 월드 잠금에서 원본과 사본을 대조하고 쓰기 전에 멈춥니다. 초기 해시는 여기서 다시 재지 않고 수출·재생에서 검사합니다. 켠 기능은 `loadWorld`, `loadReplayState`, 월간 저장 자리로 운반합니다. 순수 재생의 시작값은 `initReplayState`가 채웁니다.

`processInputs`는 모든 종류의 PENDING 중 id가 가장 작은 입력 하나를 꺼냅니다. 판정 전에 sequence를 한 번 받고 기능이 꺼졌으면 FEATURE_DISABLED로 거부합니다. 처리기는 같은 펜싱 트랜잭션에서 상태와 결과를 만들고 공통 처리기가 PENDING 조건 갱신으로 결과·sequence·tick을 확정합니다. 모르는 종류나 즉시 종류가 대기열에 있으면 쓰지 않고 멈춥니다. 형식 3의 대기 입력 tick은 처리한 tick이고 즉시 입력은 null입니다. 형식 1·2 보관 파일은 tick 키를 넣지 않습니다. PENDING은 DB에서도 tick이 null이어야 합니다.

형식 3 월드가 다음 달 경계를 넘겨 밀렸으면 턴과 월간 정산을 게임 시간 순서로 먼저 따라잡고 입력을 처리합니다(C2). 경계 밖에서 PAUSED 상태가 되면 입력은 재개·정산까지 PENDING으로 남습니다. 따라잡다가 종료하면 남은 입력을 거절해 afterEnd에 남깁니다. 재생은 종료 전 대기 입력이 그 시점의 월 창 안인지 확인합니다. 형식 1은 입력을 먼저 처리합니다. 같은 달의 밀린 턴과 즉시 입력 `turns.set` 순서는 바꾸지 않습니다. 즉시 입력은 API가 바로 적용하고 sequence가 그 위치를 기록합니다.

`DATABASE_URL`이 설정된 환경에서 `pnpm exec tsx tools/replay.ts --world <ID> --output <새 파일>`로 일관된 DB 스냅샷을 내보냅니다. 파일은 0600으로 새로 만들며 기존 파일은 덮어쓰지 않습니다. `pnpm exec tsx tools/replay.ts --from <파일> --months 12`는 DB 없이 매달 상태·예턴 해시와 연감을 비교해 일치한 tick과 해시를 출력합니다. 원본 변조, 입력 순서·revision 불일치, 누락된 월간 기록, 지원하지 않는 입력, 해시 불일치는 종료 코드 1입니다. 종료 기록이 없으면 마지막 연감 이후 입력과 미완료 요청은 내보내지 않습니다. 종료 기록이 있으면 끝 번호까지의 입력과 종료 뒤 거부 입력을 `afterEnd`로 구분해 내보냅니다. `--to-end`는 archive 2·3의 종료 사건까지 비교합니다.


## 진행 중 월드 속성 (INT-24 · AC-INT-24)

`admin.world.settings({worldId})`는 현재 관리자 권한을 다시 검사하고 조회 감사를 남긴다. 응답은 `name`, `status`, `startYear`, `endYear`, `turnTermMinutes`, `clockRevision`, `presetKey`, `canChangeRules`, `canChangeNpcPlay`, `rules`, `entry`, `truce`다. `rules`는 원본 프리셋에 진행 중 변경을 합친 값이며 프리셋이 없으면 null이다. `truce`는 유효 휴전 설정 또는 null이다.

`admin.world.requestSetting`은 `{expectedUserId,worldId,idempotencyKey,reason,setting}`을 받는다. `setting`은 다음 중 하나다.

| kind | 값 |
| --- | --- |
| `admin.world.rename` | `name` (trim 뒤 1~100자) |
| `admin.world.setEndYear` | `endYear` (1~10000 정수 또는 null) |
| `admin.world.setTurnTerm` | `turnTermMinutes` (1~2147483647 정수) |
| `admin.world.setOption` | `key`, `value` (프리셋과 같은 형식) |
| `admin.world.setTruce` | `truce` (고정 UTC 오프셋·시작 분·종료 분 또는 null) |

규칙 옵션 키는 `protection.foundUntilMonths`, `protection.peaceMonths`, `npc.aggression`, `boost.smallWorld`, `boost.lateJoin`이다. 명령 목록·NPC 충원 비율·장수 정원은 받지 않는다. 프리셋이 없는 월드의 규칙 변경은 엔진이 `NO_PRESET`으로 거절한다.

접수 응답과 `admin.world.settingRequest({expectedUserId,worldId,idempotencyKey})`는 `{requestId,kind,status,sequence,tick,result}`다. 접수 때는 PENDING이며 게임 설정을 바꾸지 않는다. 같은 사용자·월드·키·정규화한 내용은 같은 영수증을 반환하고 다른 내용은 409다. 완료 결과는 `{version:1,before,after}` 또는 `{code,message}`다. 이름·종료 연도·간격은 해당 필드의 사본, 옵션은 `{value}`를 전후 값으로 쓴다. `END_YEAR_PASSED`, `NO_PRESET`, `UNCHANGED`, `INVALID_VALUE`와 기존 운영 거절 코드를 받는다. 형식3의 RUNNING·PAUSED 월드만 접수한다.

엔진은 처리 때 계정·관리자·제재를 다시 검사한다. 간격 변경은 DB 시각과 옛 간격으로 체크포인트를 확정하고 `clockRevision` 조건부 갱신으로 새 간격을 저장한다. 실행 중에는 기준 시각을 다시 잡고 정지 중에는 기준 시각을 유지한다. 재생 정책의 간격도 같은 입력 sequence에서 바꾸며 장수의 활동 tick은 보존한다. 규칙 옵션은 깊게 합쳐 로더·서버 미리보기·늦은 참가 보정에서 같은 값을 쓴다.

초기화는 변경 이력의 전후 연결을 검사해 생성 당시 설정으로 새 판을 만든다. 새 판의 `runtimeOptions`는 null이다. 이름 변경 뒤 초기화 결과의 `confirmedName`은 확인한 현재 이름이며 `settings.name`은 생성 이름이다. 기존 초기화 기록에는 키를 추가하지 않는다. 조회와 입력 오류에는 운영 계정·비공개 사유를 공개하지 않는다.


### 장수 생성 허용 (INT-24 PR2)

`admin.world.requestSetting`의 옵션 키 `entry.generalCreation`은 `open`·`closed`를 받는다. 프리셋 없는 월드에서도 사용할 수 있으며 규칙 옵션과 서로 지우지 않는다. `admin.world.settings`는 `entry.generalCreation`을 함께 반환한다.

`general.mine.creationRules.generalCreationEnabled`는 항상 boolean이고 기본값은 true다. 기존 장수 유무와 별도로 이 판의 생성 허용을 나타낸다. 로비의 기존 `createBlockedReason`은 닫힌 RUNNING 판에서 「지금은 새 장수를 받지 않습니다」를 반환한다. 기존 장수가 있으면 접속할 수 있고 차단 사유는 null이다. PAUSED·PREOPEN·ENDED는 기존 월드 상태 사유를 유지한다.

닫힌 판의 새 생성 접수는 HTTP412(PRECONDITION_FAILED)와 「지금은 새 장수를 받지 않습니다.」 메시지를 반환하며 입력을 만들지 않는다. 이미 PENDING인 생성도 처리할 때 현재 값을 다시 읽고 REJECTED `ENTRY_CLOSED`로 확정한다. `general.mine.creation`에서 해당 코드와 문구를 복구할 수 있다. 다시 연 뒤에는 새 요청을 접수하며 이전 거절 기록을 바꾸지 않는다. 초기화는 생성 허용을 원래 기본값 open으로 돌린다.

### NPC 장수 맡기 (T3-07 · AC-M3-14 · INT-24 PR3)

`entry.npcPlay`는 기본 off이며 형식3에서 운영자가 on으로 바꾼 PREOPEN·RUNNING 판만 맡기를 받는다. PREOPEN 설정 허용은 이 키에만 한정하고 다른 설정은 RUNNING·PAUSED를 유지한다. 감독은 PREOPEN의 대기 설정·맡기를 발견해 실제 자식을 띄운다. 맡기는 시계·장수의 다음 턴 시각을 바꾸지 않는다. 다른 entry 키·규칙·명시한 휴전 null을 보존하며 초기화는 기본 off로 돌아간다.

`entry.roles({worldId})`는 `gameDate`, 사람 수와 상한 null인 `quota`, `mine`, `roles`, `canPossess`, `blockedReason`을 반환한다. 군주·중견·부하·재야 목록에는 활성·생존·미제거·미소유 NPC의 ID·이름·초상·소속·위치·능력·관직만 담는다. 정치·매력은5능력치 판에서만 있으며 재야는 국가 추천도 받는다. 금·쌀·병력·예턴·계정 신원은 공개하지 않는다. 내 장수나 대기 입장 요청이 있거나 설정·월드 상태가 맞지 않으면 후보 목록은 비운다. `general.mine.creationRules`와 로비는 허용된 판에만 선택 키 `npcPlayEnabled:true`를 반환한다. 키가 없으면 꺼짐이다.

`entry.possess({worldId,generalId,expectedUserId,idempotencyKey})`는 세션의 사용자로 대상 NPC를 요청한다. 완료 응답은 `{status:'possessed',generalId}`, 대기는 `{status:'pending'}`, 엔진 거절은 `{status:'rejected',rejectCode,message}`다. 최대5초 대기 뒤 `entry.possessStatus({worldId,expectedUserId,idempotencyKey})`로 회수한다. 거절 코드는 `TAKEN`, `ALREADY_HAS_GENERAL`, `NOT_ELIGIBLE`, `ENTRY_CLOSED`, `ACTOR_INACTIVE`, `ACTOR_SANCTIONED`다. 새 접수의 꺼진 설정은412, 같은 키의 다른 대상은409, 계정 전환은401, 남의 키·없는 대상은404, 입력 형식 오류는400이다.

같은 키의 기존 기록은 새 자격 검사보다 먼저 회수한다. 성공 영수증은 현재 장수의 상세나 소유권을 뜻하지 않는다. 화면은 성공 뒤 `general.mine`을 다시 읽는다. 운영 해제·다른 계정의 재맡기 뒤 옛 키도 ID 영수증만 반환하며 새 사용자의 금·병력·예턴·계정은 읽지 않는다. 완료·거절·pending 응답 전 현재 세션·만료·ACTIVE·전역/월드 제재를 경과 시간을 포함해 다시 검사한다.

대기 입력의 `generalId`는 null이고 payload는 `{generalId,userId}`다. 행위자는 서버가 정하며 엔진은 payload와 입력의 사용자도 대조한다. 실제 적용 때만 결과의 `generalId`에 대상을 채운다. 엔진은 현재 자격을 재검사하고 userId null·기존 revision 조건으로 소유권과 revision을 한 번 바꾼다. 군주의 국가 isNpc와 정책 활동 tick도 같은 트랜잭션에 저장한다. 기존30칸·명시 여부·장비·능력·자원·병력·위치·다음 턴 시각은 유지한다. 거주 앵커는 생성·계승과 분리한 엄격한 possession 출처로 새로 만들며 검증 없는 NPC→사람 전환은 계속 거부한다.

맡기 로그는 기존 `GeneralLog`에 `kind:'possess'`, `commandKey:'general.possess'`로 남긴다. 인사 후처리 뒤 대상·sequence의 마지막 ordinal 다음을 쓰며 실제 턴 로그와 같은 tick에도 공존한다. `records.general`의30행 복합 커서와 home10행을 그대로 쓴다. rollback은 소유권·앵커·로그·완료 기록을 함께 되돌리고 재전송은 행을 늘리지 않는다. 순수 재생은 적용·거절 모두 엄격히 검증하며 형식1·5에는 새 kind를 받지 않는다. 맡기 자체는 장수 생성처럼 유산 직접 명령 활동에서 제외한다. 배포는 새 엔진을 먼저 올린다.

### 휴전 설정과 예정 시각 (INT-24 PR4 · T4-40)

`admin.world.setTruce`의 `truce`는 `{utcOffsetMinutes,startMinute,endMinute}` 또는 null이다. UTC 오프셋은 −720~840 정수, 시작·종료는 0~1439의 서로 다른 분이다. 매일 시작 포함·종료 제외로 반복하며 자정을 넘을 수 있다. 결과의 전후 값은 `{truce}`이며 재생은 기록을 검증한 뒤 게임 상태와 정책을 그대로 둔다.

엔진은 간격 변경과 휴전 변경 모두 옛 유효 시계·DB 시각으로 체크포인트를 확정한 뒤 `clockRevision` 조건부 갱신으로 저장한다. 실행 중에는 기준 시각을 다시 잡고 정지 중에는 유지한다. `runtimeOptions.truce` 키가 있으면 null도 원본 프리셋보다 앞선다. 다른 옵션과 원본 프리셋은 보존하며 초기화는 원본 휴전을 복원한다.

`world.summary.truce`와 시계 CLI의 `truce`는 설정 세 값에 `active`, `endsAt`, `nextStartsAt`, `nextEndsAt`을 더한 값 또는 null이다. 시각은 ISO 문자열이며 `endsAt`은 현재 휴전 중일 때만 있다. 정지·종료 여부와 별도로 벽시각의 구간을 나타낸다. 원본 프리셋과 비공개 운영 사유는 응답하지 않는다.

`home.get.turnSchedule`은 개인 30칸의 `(string | null)[] | null`이다. 실행 중 실시간 시계와 기준 시각이 있을 때만 배열을 응답하며 칸 0은 `nextTurnAt`과 같다. Date 범위를 넘는 칸만 null이고 저장 설정 오류는 숨기지 않는다. 클라이언트는 휴전 경계를 다시 계산하지 않는다. 국가 직책 12칸의 무시각 계약은 바꾸지 않는다.

## 군사 조언과 공지 지시 (T3-07 · AC-M3-13)

`advice.get({worldId})`는 세션의 장수에게 `{basis:{tick,revision},items,skipped}`를 반환한다. `tick`은 현재 유효 시계, `revision`은 장수의 예턴 판이다. 명령 자격은 기존 `turns.precheck`처럼 다음 개인 턴 시각으로 검사한다. 현재 세션·ACTIVE·전역/월드 제재·소유 장수·작전·공지·상태를 같은 읽기 트랜잭션에서 확인한다. 장수가 없으면404이며 요청에 장수나 계정 ID를 넣을 수 없다.

`items`는 최대3개다. 현재 같은 국가의 참여 중인 열린 작전, 자기 국가의 공지 지시, 공용 NPC 후보 순이다. 작전은 목표 시각·ID, NPC 후보는 점수 내림차순·명령 키·정규 JSON 인자로 정렬한다. 같은 명령과 인자는 먼저 나온 출처만 남긴다. 준비된 작전과 제안을 만들 수 없는 `noop`은 제외한다. 재야에게는 상성과 도시 수로 임관 국가를 추천한다. NPC 자동 행동의 사람 제외 조건과 난수 소비는 유지한다.

각 항목은 `{source,commandKey,commandName,args,argsLabel,reason,score,nation}`이다. `source`는 `operation`·`notice`·`ai`, 점수는 NPC 후보에만 있고 나머지는 null이다. 재야의 `nation`은 `{id,name,color}`, 다른 항목은 null이다. 작전·공지 명령의 사전 검사 실패는 `skipped:[{source,commandKey,code,message}]`로 설명한다. 다른 국가의 공지나 작전, 참여자·계정 신원·비공개 수치는 반환하지 않는다.

조회는 예턴·입력·로그·활동 기록을 바꾸지 않는다. 화면에서 추천을 고르면 기존 `turns.edit`의0번 칸 `put`과 revision 충돌 처리를 사용한다. 조언이 왔다는 이유로 기존 초안을 덮거나 자동 저장하지 않는다. 프론트 구현과 E2E는 T3-08의 별도 인수 대상이다.

`notice.nation.set({worldId,body,directive?})`의 지시는 `{commandKey,args}` 또는 null이다. 생략하면 현재 지시를 보존하고 null이면 지운다. 현재 월드가 허용하는 일반 장수 명령과 실제 인자 스키마·저장 가능한 JSON만 받으며 국가 명령은 거절한다. 자원·위치 부족은 저장을 막지 않고 조언에서 사전 검사 실패로 설명한다. 기존 군주·참모 권한과 인증·동의·제재 검사는 유지한다.

본문·지시·revision은 같은 트랜잭션에 저장하고 기존 `notice.updated`를 commit 뒤에 보낸다. 본문이 비어도 지시가 있으면 읽음 여부는 revision을 따른다. `notice.nation.get/set/markSeen`은 지시가 있을 때만 선택 키 `directive`를 반환하므로 이전 빈 공지 응답 모양은 유지된다. 손상된 저장 지시는500으로 드러내고 조회 중에 고쳐 쓰지 않는다.

`Nation.noticeDirective`는 기존 공지와 같은 규칙 밖 metadata다. nullable JSONB 새 migration으로 추가하며 기존 행과 새 월드는 null이다. 엔진의 `loadWorld`·`readWorldState`, 서버의 `readView`에서 제외한다. 게임 해시·재생 원본·입력 종류·보상 활동에 추가하지 않는다. 실제 HTTP 권한과 공지·작전·롤백·불변성 검증은 `tools/t3-07-advice.integration.test.ts`에 있다. 백엔드 병합만으로 AC-M3-13 전체 완료를 뜻하지 않는다.
