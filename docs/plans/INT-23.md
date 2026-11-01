# INT-23 운영자 게임 안 개입과 기록 조회

> AC-INT-23 · 구현 Codex · 리뷰 Claude · 결정 [D-055](../product/decisions.md) · 사용자 직접 요청 2026-11-01
> 상태: 상세 계획 제안. Codex 계획 기술 검토(G-03) 전이다.
> 기준: main `d2202e13`. 짝 계획은 [INT-24 서버 속성과 NPC 플레이](./INT-24.md)다. 기존 운영 콘솔은 [T3-05](./T3-05.md)·[T3-06](./T3-06.md), 문서는 [관리자 콘솔](../admin-console.md)이다.

## 계획 (Claude)

### 목표

지금 운영 콘솔은 계정·제재·공지와 월드의 생성·시계·초기화·종료만 다룬다. 진행 중인 월드 안에서 장수·국가·도시가 잘못되면 DB를 직접 고치는 수밖에 없다. 직접 고치면 재생과 해시가 깨지고 감사 기록도 남지 않는다. 사용자가 2026-11-01 운영자가 게임 안에 개입하는 조치와 기록 조회를 모두 넣도록 정했다(D-055).

모든 조치는 사유를 받는다. 기존 월드 시계 요청과 같은 길(InputEvent → 엔진 재검사 → 규칙 순수 함수 → APPLIED/REJECTED)로 처리한다. 그래서 재생하면 같은 상태와 해시가 나오고 감사 기록과 게임 안 기록이 함께 남는다.

### 조치 목록

| 묶음 | 입력 종류 | 내용 |
| --- | --- | --- |
| 장수 | `admin.general.rename` | 장수 이름을 바꾼다. 월드 안 이름 중복 검사는 장수 생성과 같다 |
| 장수 | `admin.general.release` | 사람 장수를 NPC로 돌린다. `userId`를 끊고 `isNpc`를 켠다. 군주였다면 `Nation.isNpc`도 켠다(T3-07 맡기의 반대). 소속·관직·병력은 그대로다 |
| 장수 | `admin.general.remove` | 장수를 월드에서 내보낸다. 아래 「장수 내보내기」 절 |
| 장수 | `admin.general.clearTurns` | 예턴 30칸을 비운다(휴식으로 채움) |
| 수치 | `admin.general.adjust` | 금·쌀·병력·훈련·사기·병종·위치 도시 |
| 수치 | `admin.city.adjust` | 주민·농업·상업·치안·수비·성벽·민심과 소속 국가 |
| 수치 | `admin.nation.adjust` | 국고 금·쌀·기술 |
| 국가 | `admin.nation.rename` | 국명을 바꾼다 |
| 국가 | `admin.nation.setRuler` | 군주를 같은 나라의 다른 장수로 바꾼다. T4-15 선양과 같은 상태 변경을 쓴다 |
| 국가 | `admin.nation.dismissOffice` | 수뇌 한 자리의 임명을 취소한다 |
| 국가 | `admin.nation.disband` | 나라를 해산한다. T4-15(선양·해산) 규칙이 들어오면 그 상태 변경 함수를 쓰며 운영 조치는 해산 조건 검사만 건너뛴다 |
| 쪽지 | `admin.message.send` | 운영 쪽지를 월드 전체(WORLD) 또는 장수 한 명(PRIVATE)에게 보낸다. 보낸 이는 「운영」이다 |

수치 조치의 입력은 바꿀 칸과 새 값이다. 칸마다 지금 규칙의 범위 검사(`packages/rules/src/model`·`world/resources.ts`의 상한)를 그대로 건다. 변화량이 아니라 새 값을 받는다. 요청을 받은 뒤 엔진이 처리하기 전에 값이 바뀌면 거절하도록 요청에 지금 값(`expected`)도 함께 받는다.

### 입력 계약

서버 `admin.game.request`(새 tRPC 프로시저) 하나가 모든 조치를 받는다.

```ts
{
  expectedUserId: uuid,          // 기존 운영 요청과 같다
  worldId: uuid,
  idempotencyKey: uuid,
  reason: string,                // 1~200자, 기존 adminClockPayloadSchema.reason과 같은 규칙
  action: AdminGameAction,       // kind별 판별 합집합
}
```

`AdminGameAction`은 `packages/rules/src/admin/game.ts`(새 파일)의 zod 판별 합집합이다. payload는 `{ version: 1, reason, action }`이다. 서버 접수는 `apps/server/src/admin/worldActions.ts`의 `requestWorldClock`과 같다. World 행을 `FOR UPDATE`로 잠근 뒤 `requireCurrentAdmin`을 거쳐 같은 키 재사용을 대조하고 InputEvent를 PENDING으로 넣는다. 결과 조회는 `admin.game.requestStatus`로 한다.

### 엔진 처리

`apps/engine/src/admin/game.ts`(새 파일)가 TurnLoop의 리스→World 잠금 트랜잭션 안에서 대기 중인 `admin.*` 운영 조치를 id 순으로 하나씩 처리한다. 시계·종료·초기화 요청(`processAdminClock`)과 같은 자리에서 같은 순서 규칙을 쓴다. 재검사 순서와 거절 코드다.

| 순서 | 거절 코드 | 조건 |
| --- | --- | --- |
| 1 | `ACTOR_INACTIVE` | 행위자 계정이 ACTIVE가 아님 |
| 2 | `ADMIN_REQUIRED` | 행위자 역할이 ADMIN이 아님 |
| 3 | `ACTOR_SANCTIONED` | 행위자에게 유효한 전체 제재가 있음 |
| 4 | `UNSUPPORTED_FORMAT` | `replayFormat`이 3이 아님 |
| 5 | `WORLD_STATE_CHANGED` | 월드가 RUNNING·PAUSED가 아님 |
| 6 | `TARGET_MISSING` | 대상 장수·국가·도시가 없음 |
| 7 | `TARGET_CHANGED` | `expected`와 지금 값이 다름 |
| 8 | `INVALID_VALUE` | 규칙 범위 밖 값, 이름 중복, 같은 나라가 아닌 군주 후보 등 |

통과하면 규칙 함수 `applyAdminGameAction(state, action, at)`을 부르고 결과 상태를 저장한다. InputEvent에는 `sequence`(`nextActionSequence`)·`tick`·`result`(`{ version: 1, before, after }`)를 남긴다. 턴 처리 도중에 들어온 요청은 다음 리스 트랜잭션에서 처리한다. 같은 월드의 장수 턴과 섞이지 않게 월 정산과 장수 턴 사이 한 자리에서만 처리한다.

### 규칙과 재생

`applyAdminGameAction`은 순수 함수다. 난수를 쓰지 않으며 같은 상태와 입력이면 같은 결과를 낸다. `packages/rules/src/replay.ts`의 `applyRecordedInput`에 `isAdminGameKind` 갈래를 `isAdminClockKind` 다음에 더한다. 거절 기록은 상태를 바꾸지 않고 형식만 검사한다. `replayCapabilities.ts`의 `CAPS_INPUT_OWNERS`에 새 종류를 `'admin'` 주인으로 올린다. 기능 플래그는 두지 않는다. 기존 월드의 재생 기록에는 이 종류가 없으므로 결과가 바뀌지 않는다. 새 코드로 기존 월드에 조치를 적용할 수 있다.

조치마다 게임 안 기록 한 줄을 남긴다. 장수 조치는 그 장수의 GeneralLog(`commandKey` 해당 종류, `kind: 'admin'`), 국가·도시 조치는 월드 기록에 남긴다. 문구는 「운영 조치: 이름을 ○○로 바꿈」처럼 무엇이 바뀌었는지만 쓴다. 사유는 감사 기록에만 남기고 게임 화면에는 보이지 않는다. 운영 쪽지는 Message 행으로 남고 보낸 이(`fromParty`)는 `{ kind: 'admin', name: '운영' }`이다.

### 장수 내보내기

지금 규칙에는 장수가 죽거나 월드에서 빠지는 처리가 없다. 행을 지우면 부곡·작전·쪽지·로그 외래 키가 함께 지워져 기록이 사라진다. 그래서 행은 남기고 상태만 바꾼다. 장수에 `removedAt`(틱)을 더한다. 내보낸 장수는 이렇게 처리한다.

- 소속 국가에서 빠진다. 관직을 잃고 군주였다면 거절한다(먼저 `setRuler`로 바꾼다).
- 병력은 0이 되고 지휘하던 부곡은 해산한다.
- 사람 연결을 끊고 명령 대상·지도·순위에서 빠진다.
- 로그·쪽지·전투 기록은 남는다.

### 감사

모든 요청은 접수할 때와 처리할 때 AuditLog를 하나씩 남긴다(`actorKind: 'ADMIN'`, `action`은 입력 종류, `targetType`·`targetId`, `worldId`, `reason`, `inputEventId`, `payload`는 `before`·`after`). 이미 있는 UPDATE·DELETE 거부 트리거를 그대로 쓴다.

### 기록 조회

읽기 전용 프로시저를 더한다. 모두 `adminProcedure`이며 한 번에 100행까지 커서로 넘긴다.

| 프로시저 | 읽는 것 |
| --- | --- |
| `admin.game.general` | 장수 상세(숨김 값 포함), 연결된 계정 id |
| `admin.game.generalLogs` | GeneralLog를 틱 범위로 |
| `admin.game.generalInputs` | 그 장수의 InputEvent(예턴 편집·명령·생성·운영 조치) |
| `admin.game.nationLogs` | 월드 기록·국가 이력(NationHistory) |
| `admin.game.battles` | BattleLog를 장수·틱 범위로 |

조회도 AuditLog에 남긴다(`admin.game.read`). 기존 다중계정 조사(`admin.investigate.shared`)와 같은 기준이다.

### 화면

`/admin/worlds/$worldId` 아래에 「장수」「국가」「도시」「기록」「쪽지」 탭을 더한다. 장수·국가·도시는 검색해서 고른 뒤 상세를 보고 조치를 고른다. 조치 창은 바꿀 값, 사유, 영향 문구를 보여 준다. 확인을 누르면 요청을 넣고 처리 결과(APPLIED·REJECTED와 이유)를 같은 창에서 수동으로 조회한다. 기존 초기화·종료 화면의 처리 흐름과 문구 규칙을 따른다. 375px에서도 쓸 수 있어야 한다.

### 범위

| PR | 파일 | 시작 조건 |
| --- | --- | --- |
| 1 규칙 | `packages/rules/src/admin/game.ts`, `replay.ts`·`replayCapabilities.ts` 갈래, 장수 `removedAt`, 시험 | G-03 통과 |
| 2 엔진·서버 | `apps/engine/src/admin/game.ts`, TurnLoop 연결, 새 migration(`General.removedAt`), `apps/server/src/admin/game.ts`, `routers/admin.ts`, 감사 | PR 1 |
| 3 조회 | 기록 조회 프로시저와 시험 | PR 2 |
| 4 화면 | `apps/web/src/admin/` 새 탭, 도움말·`docs/admin-console.md` | PR 3 |

### 하지 않는 것

- 관리자 지정·회수 화면. CLI만 유지한다.
- 장수 능력치·특기 수정. 5능력치 원장(INT-16)과 충돌하므로 따로 정한다.
- 여러 장수·도시를 한꺼번에 바꾸는 일괄 조치.
- 서버 속성 변경과 NPC 플레이(INT-24).

### 검증

규칙 단위 시험은 조치마다 성공 하나, 거절 코드마다 하나씩 둔다. 재생 시험은 조치를 섞은 월드를 순수 재생해 DB 상태와 해시가 같은지 본다. 엔진 통합 시험(실제 PostgreSQL)은 접수 → 처리 → 감사 두 행 → 게임 기록 → 재시작 뒤 같은 상태까지 확인한다. 권한 시험은 비관리자·제재 관리자·키 재사용 충돌을 본다. 화면은 실제 Chromium으로 장수 이름 바꾸기, 수치 고치기, 운영 쪽지 한 번씩 확인한다. `pnpm check`와 독립 리뷰를 거친다.

### 질문

- G-03에 물을 것: 조치를 월 정산과 장수 턴 사이 한 자리에서만 처리해도 시계·리스 계약과 맞는지, `removedAt`을 두는 방식이 기존 장수 조회·순위·NPC 선택에서 빠짐없이 걸러지는지.
- 사용자 확인: 게임 안 기록에 「운영 조치」를 공개로 남기는 기본값.
