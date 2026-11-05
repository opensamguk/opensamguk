# INT-23 운영자 게임 안 개입과 기록 조회

> AC-INT-23 · 구현 Codex · 리뷰 Claude · 결정 [D-057](../product/decisions.md) · 사용자 직접 요청 2026-11-01
> 상태: 4판 G-03 통과([PR #331 리뷰](https://github.com/opensamguk/opensamguk/pull/331#issuecomment-6558996970)). PR1 규칙·엔진·서버 후보를 구현 중이며 전체 AC는 미완료다.
> 기준: main `d2202e13`. 짝 계획은 [INT-24 서버 속성·NPC 플레이·야간 휴전 토글](./INT-24.md)이다. 기존 운영 콘솔은 [T3-05](./T3-05.md)·[T3-06](./T3-06.md), 문서는 [관리자 콘솔](../admin-console.md)이다.

## 계획 (Claude)

### 목표

지금 운영 콘솔은 계정·제재·공지와 월드의 생성·시계·초기화·종료만 다룬다. 진행 중인 월드 안에서 장수·국가·도시가 잘못되면 DB를 직접 고치는 수밖에 없다. 직접 고치면 재생과 해시가 깨지고 감사 기록도 남지 않는다. 사용자가 2026-11-01 운영자가 게임 안에 개입하는 조치와 기록 조회를 모두 넣도록 정했다(D-057). 게임 안 기록은 무엇이 바뀌었는지만 공개로 남긴다(D-057).

모든 조치는 사유를 받는다. 기존 월드 종료·초기화 요청과 같은 형식3 운영 입력으로 처리한다. 엔진이 재검사한 뒤 등록된 입력 종류의 적용 함수로 상태를 바꾸고 재생도 같은 함수를 지난다. 그래서 순수 재생과 DB 상태의 해시가 같다.

### 조치 목록

| 묶음 | 입력 종류 | 내용 | PR |
| --- | --- | --- | --- |
| 장수 | `admin.general.rename` | 장수 이름을 바꾼다. 월드 안 이름 중복 검사는 장수 생성과 같다 | 1 |
| 장수 | `admin.general.release` | 사람 장수를 NPC로 돌린다. `userId`를 null로 하고 `policy.lastActiveTicks`에서 뺀다. 군주였다면 `Nation.isNpc`를 켠다(T3-07 맡기의 반대). 소속·관직·병력은 그대로다 | 1 |
| 장수 | `admin.general.clearTurns` | 예턴 30칸을 휴식으로 채우고 `revisions`를 1 올린다 | 1 |
| 장수 | `admin.general.remove` | 장수를 월드에서 내보낸다. 사람 연결도 끊는다. 아래 「장수 내보내기」 절 | 2 |
| 수치 | `admin.general.adjust` | 금·쌀·위치 도시. 부곡 프로필이 아닌 월드에서만 병력·병종·훈련·사기 | 1 |
| 수치 | `admin.city.adjust` | 주민·농업·상업·치안·수비·성벽·민심 | 1 |
| 수치 | `admin.nation.adjust` | 국고 금·쌀·기술 | 1 |
| 국가 | `admin.nation.rename` | 국명을 바꾼다 | 1 |
| 국가 | `admin.nation.dismissOffice` | 수뇌 한 자리의 임명을 취소한다 | 1 |
| 국가 | `admin.nation.setRuler` | 군주를 같은 나라의 다른 장수로 바꾼다 | 5 |
| 국가 | `admin.nation.disband` | 나라를 해산한다 | 5 |
| 쪽지 | `admin.message.send` | 운영 쪽지를 월드 전체(WORLD) 또는 장수 한 명(PRIVATE)에게 보낸다 | 3 |

수치 조치는 바꿀 칸과 새 값, 그리고 요청 당시 지금 값(`expected`)을 받는다. 칸마다 지금 규칙의 범위 검사를 그대로 건다. 부곡 프로필(`campaign-v1`) 월드에서는 장수의 병력이 부곡에 있다. 그 월드에서 장수 행의 병력·병종·훈련·사기를 고치면 `apps/engine/src/campaignState.ts:28`이 월드를 읽지 못하므로 `CAMPAIGN_FIELD`로 거절한다. 부곡 수치 조정과 도시 소속 국가 변경은 점령·보급·인사 상태 전이가 함께 필요해 이 작업에서 뺀다.

### 입력 등록과 재생

새 종류는 모두 `packages/rules/src/ruleRegistry.ts`의 `inputKinds`에 `admin.world.end`·`admin.world.reset`과 같은 모양으로 올린다. `feature: null`, `route: 'direct'`, `directTick: true`이며 `apply`는 종류별 적용 함수다. 적용 함수는 `ReplayState` 전체(`state`, `turns`, `revisions`, `policy`, `offices`, `residenceAnchors`)를 받아 새 `ReplayState`를 돌려준다. `applyRecordedInput`의 일반 경로를 그대로 지나므로 켠 기능의 `afterAppliedInput`(직책 예턴 정리, 거주 앵커 갱신)도 다른 입력과 똑같이 돈다. 따로 일찍 반환하는 갈래는 두지 않는다. 엔진은 같은 적용 함수와 같은 후처리를 써서 DB에 저장한다.

엔진 재생 검사(`apps/engine/src/replay.ts:342` 근처)에 `validateAdminGameRecord`를 더한다. 종료·초기화 기록처럼 형식3에서만 받고 payload·result 모양을 엄격히 검사한다. 형식3이 아닌 기록(caps 포함)에 이 종류가 있으면 「관리자 운영 입력은 형식3 기록에만 넣을 수 있습니다」로 거절한다. `CAPS_INPUT_OWNERS`에는 올리지 않는다. 엔진도 형식3이 아닌 월드의 요청을 `UNSUPPORTED_FORMAT`으로 거절한다.

### 입력 계약과 접수

서버 `admin.game.request`(새 tRPC 프로시저) 하나가 모든 조치를 받는다. 입력은 기대 사용자, 월드, 중복 방지 UUID, 사유(1~200자, 기존 운영 사유 규칙), `action`(zod 판별 합집합, `packages/rules/src/admin/game.ts`)이다. payload는 `{ version: 1, reason, action }`이다.

접수는 `apps/server/src/admin/worldActions.ts`의 `requestWorldClock`과 같다. World 행을 `FOR UPDATE`로 잠근 뒤 `requireCurrentAdmin`을 거친다. 같은 키에 같은 내용이면 기존 결과를 돌려주고 다른 내용이면 `CONFLICT`다. 새 요청이면 InputEvent를 PENDING으로 넣는다. 결과는 `admin.game.requestStatus`로 조회한다.

### 엔진 처리 자리

지금 운영 요청은 `apps/engine/src/turnLoop.ts:155`의 `processAdminClock`이 일반 입력과 월 정산보다 먼저, 리스→World 잠금 트랜잭션 안에서 하나씩 처리하고 그 트랜잭션을 끝낸다. 새 종류도 이 자리에서 처리한다. `processAdminClock`을 `processAdminInputs`로 넓혀 모든 `admin.*` 종류를 id 순으로 하나씩 꺼낸다. 시계·종료·초기화와 새 조치가 같은 줄을 선다. 일반 입력과 월 정산·장수 턴은 그다음 트랜잭션에서 지금처럼 처리한다. PAUSED 월드에서도 운영 입력은 처리한다.

재검사 순서와 거절 코드다.

| 순서 | 거절 코드 | 조건 |
| --- | --- | --- |
| 1 | `ACTOR_INACTIVE` | 행위자 계정이 ACTIVE가 아님 |
| 2 | `ADMIN_REQUIRED` | 행위자 역할이 ADMIN이 아님 |
| 3 | `ACTOR_SANCTIONED` | 행위자에게 유효한 전체 제재가 있음 |
| 4 | `UNSUPPORTED_FORMAT` | `replayFormat`이 3이 아님 |
| 5 | `WORLD_STATE_CHANGED` | 월드가 RUNNING·PAUSED가 아님 |
| 6 | `TARGET_MISSING` | 대상 장수·국가·도시가 없거나 이미 내보낸 장수 |
| 7 | `TARGET_CHANGED` | `expected`와 지금 값이 다름 |
| 8 | `CAMPAIGN_FIELD` | 부곡 프로필 월드에서 장수 병력 칸을 고침 |
| 9 | `INVALID_VALUE` | 규칙 범위 밖 값, 이름 중복, 같은 나라가 아닌 군주 후보, 군주를 내보내려 함 등 |

APPLIED·REJECTED 모두 `sequence`(`nextActionSequence`)와 `tick`을 받는다. `result`는 APPLIED면 `{ version: 1, before, after }`, REJECTED면 `{ code, message }`다.

### 상태 표현과 해시

장수 내보내기는 장수에 `removedAt`(틱)을 더한다. 기존 해시를 지키려고 내보내지 않은 장수에는 이 키를 두지 않는다. DB 열은 nullable이다. 엔진 로더(`apps/engine/src/worldLoader.ts:66`), 상태 저장(`world/persistence.ts:369`), 생성 결과, 순수 재생이 모두 null이면 키를 빼고 숫자면 넣는다. `replayCaps.ts:179`의 엄격한 General 모양은 바꾸지 않는다. caps 월드에는 운영 입력이 들어갈 수 없어 `removedAt`이 생기지 않는다. 기존 형식1~3과 caps의 재생 골든 해시가 그대로인지 시험한다.

`General`에는 `isNpc` 열이 없다. 사람 장수 판정은 지금처럼 `userId !== null`이다.

### 장수 내보내기

행은 남기고 `removedAt`을 둔다. 군주는 내보낼 수 없다(먼저 군주를 바꾼다). 내보낸 장수는 활동 대상에서 빠지고 기록 참조로만 남는다. PR 2는 아래 표의 경로를 모두 고친다. 시작할 때 `General`을 읽는 곳을 다시 grep해 표에 없는 경로를 더한다.

| 경로 | 처리 |
| --- | --- |
| 장수 턴 선택 `apps/engine/src/turnLoop.ts:205`·`:237`, 순수 재생 `packages/rules/src/replay.ts:73` | `removedAt`이 있으면 고르지 않는다 |
| NPC 명령 선택 `packages/rules/src/npc/` | 후보에서 뺀다 |
| 월 정산·보급 `packages/rules/src/monthly/`, `supply.ts` | 봉급·인구 계산과 보급 판정에서 뺀다 |
| 사람 연결 | 내보낼 때 `userId`를 null로 하고 `policy.lastActiveTicks`에서 뺀다. 그 계정은 이 월드에서 장수가 없는 상태가 되어 새 장수를 만들 수 있다(생성이 열려 있을 때) |
| 사용자 장수 조회 `apps/server/src/game/queries.ts:33` `requireGeneral` 등 | `userId`로 찾으므로 내보낸 장수는 자연히 빠진다. 예턴·방침·휘하 지시·쪽지 같은 변경 접수는 이 조회를 거쳐 거절된다 |
| 이미 PENDING인 일반 입력 | 엔진이 처리할 때 대상 장수에 `removedAt`이 있으면 `GENERAL_REMOVED`로 REJECTED 기록을 남긴다(입력 종류마다 같은 검사) |
| 장수 생성·맡기 | 맡을 수 없다. 이름 중복 검사에는 남긴다 |
| 지도·장수 목록 조회 `apps/server/src/game/`, `visibility.ts` | 목록과 지도에서 뺀다. 상세 조회는 「내보낸 장수」로 보인다 |
| 순위 `packages/rules/src/ranking.ts` | 새 집계에서 뺀다. 이미 저장한 RankingSnapshot은 고치지 않는다 |
| 작전 후보·예측 `packages/rules/src/operation/` | 뺀다 |
| 부곡 `packages/rules/src/campaign/` | 지휘하던 부곡과 소유한 부곡을 해산한다. 병력은 소속 도시 주민으로 돌린다 |
| 휘하·발령 `packages/rules/src/personnel/`, AssignmentOffer | 휘하 연결과 대기 중 제안·지시·발령을 취소한다 |
| 관직 | 수뇌 자리를 비운다(`offices` revision을 올린다) |
| 소속·병력 | 소속 국가를 비우고(재야와 같은 `nationId` null) 비부곡 월드의 장수 병력은 0으로 해 소속 도시 주민으로 돌린다. 그래서 수비 장수 선택(`packages/rules/src/commands/attack.ts:61`, 소속·병력·도시로 고름)과 같은 나라 대상 명령에서 자연히 빠진다 |
| 장수를 대상으로 하는 명령 `packages/rules/src/commands/`(포상·몰수 `nation.ts:18`, 등용·임명 등 `args.generalId`를 받는 모든 명령) | 대상 장수를 고르는 공통 함수(`targetGeneral`)를 두고 `removedAt`이면 `BAD_TARGET`으로 거절한다. PR 2는 `generalId` 인자를 받는 명령을 grep해 모두 이 함수로 바꾼다 |
| 서버 작전 `apps/server/src/game/operation.ts:52`, 같은 파일의 `createOperation` | 참여자 검사와 기존 참여자 조회에서 뺀다. 이미 들어간 작전의 집계에서도 뺀다 |

로그·쪽지·전투 기록은 남는다.

### 국가 조치와 T4-15

`setRuler`와 `disband`는 [T4-15](./T4-15.md)(선양·해산, 계획 제안 상태)의 상태 전이와 같은 일을 한다. 두 조치는 PR 5로 따로 두고 T4-15 규칙 PR이 공통 함수(군주 교체, 해산)를 내놓은 뒤에 붙인다. 운영 조치는 그 함수를 부르되 명령의 조건 검사는 건너뛴다. T4-15가 늦어지면 PR 5만 늦어지고 나머지 PR은 영향이 없다.

### 운영 쪽지와 게임 안 기록

지금 쪽지 발신자 파서(`apps/server/src/messaging.ts:71`)는 `{ generalId, name, nation }`만 받는다. 운영 쪽지를 위해 발신자 모양에 `{ kind: 'admin', name: '운영' }`을 더하고 파서, `routers/message.ts`, 웹 쪽지 타입과 표시를 함께 고친다(PR 3). 기존 행은 그대로 읽힌다.

장수 조치는 그 장수의 GeneralLog에 한 줄 남긴다. `commandKey`는 입력 종류, `kind: 'admin'`이며 운영 입력의 `sequence`와 `ordinal`을 채운다. 그러면 `GeneralLog_worldId_generalId_sequence_ordinal_key`에 걸리고 sequence 없는 로그의 장수·tick 고유 제약에는 걸리지 않는다. 같은 tick에 로그가 여러 줄 생기므로 장수 기록 조회(`apps/server/src/routers/records.ts`의 `records.general`, 30행 단위·`tick < cursor`)를 `(tick, id)` 복합 커서로 바꾼다. 같은 tick 로그가 페이지 경계에서 빠지지 않는지 시험한다.

국가·도시 조치의 공개 기록은 새 표를 만들지 않고 월드 쪽지(Message, scope WORLD, 발신자 「운영」)로 남긴다. 지금 `records.world`는 연감(YearbookSnapshot)만 읽으므로 거기에 섞지 않는다. 쪽지는 APPLIED 처리와 같은 트랜잭션에서 한 번만 만든다. InputEvent는 한 번만 APPLIED가 되므로 중복이 생기지 않는다. 쪽지는 재생 상태가 아니며 재생 해시에 들어가지 않는다. 문구는 「운영 조치: 위나라 국명을 ○○로 바꿈」처럼 바뀐 것만 쓰고 사유는 넣지 않는다.

### 감사

접수 때 한 행(`admin.game.request`), 엔진 처리 때 한 행(APPLIED·REJECTED와 `inputEventId`)을 AuditLog에 남긴다. 접수 단계에서 거절된 요청(권한·형식·키 충돌)은 InputEvent 없이 감사 한 행만 남긴다. `actorKind: 'ADMIN'`, `targetType`·`targetId`, `worldId`, `reason`, `payload`(`before`·`after`)다. 이미 있는 UPDATE·DELETE 거부 트리거를 쓴다.

### 기록 조회

읽기 전용 프로시저다. 모두 `adminProcedure`이고 한 번에 100행까지 커서로 넘긴다. 각 조회는 한 트랜잭션에서 관리자 권한을 다시 확인하고 조회 감사(`admin.game.read`)를 남긴 뒤 읽는다.

| 프로시저 | 읽는 것 |
| --- | --- |
| `admin.game.general` | 장수 상세(숨김 값 포함), 연결된 계정 id, `removedAt` |
| `admin.game.generalLogs` | GeneralLog를 틱 범위로 |
| `admin.game.generalInputs` | 그 장수의 InputEvent(예턴 편집·명령·생성·운영 조치) |
| `admin.game.nationLogs` | 월드 기록·국가 이력(NationHistory) |
| `admin.game.battles` | BattleLog를 장수·틱 범위로 |

### 화면

`/admin/worlds/$worldId` 아래에 「장수」「국가」「도시」「기록」「쪽지」 탭을 더한다. 대상을 검색해 고른 뒤 상세를 보고 조치를 고른다. 조치 창은 바꿀 값, 사유, 영향 문구를 보여 준다. 확인하면 요청을 넣고 처리 결과(APPLIED·REJECTED와 이유)를 같은 창에서 수동으로 조회한다. 기존 초기화·종료 화면의 흐름과 문구 규칙을 따르고 375px에서도 쓸 수 있게 한다.

### 범위

| PR | 내용 | 시작 조건 |
| --- | --- | --- |
| 1 규칙·엔진·서버 | 입력 스키마, 등록부, 적용 함수(장수 이름·NPC 돌리기·예턴 비우기·수치·국명·수뇌 임명 취소), `processAdminInputs`, 서버 접수·조회 결과, 감사, 재생 검사, 시험 | G-03 통과 |
| 2 내보내기 | migration(`General.removedAt`), 상태 표현, 위 경로 표 전부(사람 연결·사용자 조회·대기 입력의 `GENERAL_REMOVED`, 소속·병력, 대상 명령 공통 함수, 서버 작전 포함), 시험 | PR 1 |
| 3 쪽지·기록 | 발신자 모양 확장, GeneralLog와 `records.general` 복합 커서, 국가·도시 조치의 월드 쪽지, 기록 조회 프로시저 | PR 1 |
| 4 화면 | 운영 콘솔 탭, `docs/admin-console.md`, 도움말 | PR 1~3 |
| 5 국가 전이 | `setRuler`, `disband` | PR 1, T4-15 규칙 PR |

### 하지 않는 것

- 관리자 지정·회수 화면(CLI만 유지).
- 장수 능력치·특기 수정. 5능력치 원장(INT-16)과 따로 정한다.
- 부곡 수치 조정, 도시 소속 국가 변경, 일괄 조치.
- 서버 속성 변경과 NPC 플레이(INT-24).

### 검증

규칙 단위 시험은 조치마다 성공 하나와 거절 코드마다 하나를 둔다. 형식3 월드에서 조치를 섞은 기록을 내보내고 읽어 순수 재생한 결과가 DB 상태·해시와 같아야 한다. caps 월드의 기록에 운영 입력이 있으면 거절해야 한다. 기존 형식1~3·caps 재생 골든 해시는 그대로여야 한다. 엔진 통합 시험(실제 PostgreSQL)은 접수 → 처리 → 감사 두 행 → 게임 기록 → 재시작 뒤 같은 상태를 본다. 권한 시험은 비관리자·제재 관리자, 같은 키 같은 내용(기존 결과)과 다른 내용(충돌)을 본다. 내보내기는 경로 표의 각 줄을 시험한다. 특히 내보낸 뒤 수비전 불참, 대상 명령 거절, 기존 작전 집계 제외를 본다. 화면은 실제 Chromium으로 장수 이름 바꾸기, 수치 고치기, 운영 쪽지를 한 번씩 확인한다. `pnpm check`와 독립 리뷰를 거친다.

### PR1 구현 후보

8종의 엄격한 입력·변경 전후 기록, 순수 적용 함수와 등록부, 기존 운영 대기열의 엔진 처리, 관리자 접수·결과 조회와 감사를 연결했다. 게임 상태는 엔진에서만 바꾸고 순수 재생과 같은 공통 후처리를 쓴다. 실제 PostgreSQL 시험은 권한과 제재의 접수 뒤 변경, expected 충돌, commit 실패의 전체 롤백과 새 리스 적용, 사람의 NPC 전환과 거주 앵커, 월간 기록과 재생 해시를 검사한다. 계약은 [요청·턴·저장 흐름](../developer/request-turn-persistence.md)에 정리한다.

전체 검사·최종 네이티브 검증·독립 리뷰·보호 병합은 진행 중이다. 공개 변경 기록과 기록 조회는 PR3, 화면은 PR4에 남으며 이 후보로 AC를 완료하지 않는다.

### PR2 구현 후보

형식3의 `admin.general.remove`와 nullable `General.removedAt` migration을 추가했다. null은 규칙 상태에서 생략해 기존 형식·caps의 장수 모양과 해시를 보존한다. 행과 과거 참조는 유지하고 조작권·소속·관직을 해제한다. 소유·지휘 부곡을 해산하고 병력을 도시 주민으로 환원하며 직책·발령·휘하·혼인·조정의 현재 관계를 정리한다. 가문의 사망·계승 기록과 구별한다. 변경 번호 한도에 걸리면 부분 적용하지 않는다.

턴 선택·현재 순위·월 정산·조회·작전 참여자에서 제외한다. 기본 명령의 장수 대상과 휘하 영입을 막고 무주 도시 첩보 인원수에서도 뺀다. 앞서 접수된 그 장수의 일반 입력은 `GENERAL_REMOVED`로 거절한다. 같은 계정의 새 장수 생성은 기존 생성 조건을 따른다. 개별 운영 상세 조회와 공개 변경 기록은 PR3, 표시 화면은 PR4 범위다.

관련 규칙·가문·황실·재생 시험 296건과 전체 타입 검사는 통과했다. 실제 PostgreSQL·HTTP 18건에서 대기 요청 거절·새 장수 생성·작전 참여 제외·491명 부곡 월드와 재생을 확인했다. 전체 검사·독립 리뷰·보호 병합 전이며 전체 AC는 미완료다.
