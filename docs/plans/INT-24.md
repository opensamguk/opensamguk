# INT-24 진행 중 월드의 서버 속성 변경, NPC 플레이, 야간 휴전 토글

> AC-INT-24 · 구현 Codex · 리뷰 Claude · 결정 [D-057](../product/decisions.md) · 사용자 직접 요청 2026-11-01
> 상태: 상세 계획 제안. 2026-11-01 Codex G-03 1차 보류(PR #331 댓글) 지적을 반영한 2판이다.
> 기준: main `d2202e13`. 짝 계획은 [INT-23 게임 안 개입과 기록 조회](./INT-23.md)다. 입력 등록·접수·엔진 처리 자리·감사는 INT-23과 같다. NPC 장수 맡기는 [T3-07](./T3-07.md)의 `entry.possess` 설계를 쓴다.

## 계획 (Claude)

### 목표

월드의 이름·종료 연도·턴 간격과 프리셋 값은 지금 만들 때만 정한다. 사용자가 2026-11-01 진행 중인 월드에서 이 값들을 바꾸고 NPC 플레이 허용과 야간 휴전도 켜고 끌 수 있게 하도록 정했다(D-057). 맡을 수 있는 NPC는 군주를 포함한 모든 NPC 장수다.

### 바꿀 수 있는 속성

| 속성 | 입력 종류 | 저장 위치 | 적용 시점 | PR |
| --- | --- | --- | --- | --- |
| 이름 | `admin.world.rename` | `World.name` | 처리한 순간 | 1 |
| 종료 연도 | `admin.world.setEndYear` | `World.endYear` | 처리한 순간. 지금 연도보다 이른 값은 거절 | 1 |
| 턴 간격 | `admin.world.setTurnTerm` | `World.turnTermMinutes`, 재생 정책 | 처리한 순간의 체크포인트 다음 틱부터 | 1 |
| 보호 기간·NPC 공격성·추가 보정 | `admin.world.setOption` (`protection.foundUntilMonths`, `protection.peaceMonths`, `npc.aggression`, `boost.*`) | `World.runtimeOptions.rules`, 상태 `presetRules` | 처리 다음의 첫 틱부터 | 1 |
| 장수 생성 열고 닫기 | `admin.world.setOption` (`entry.generalCreation`) | `World.runtimeOptions.entry` | 처리 뒤 접수되는 요청부터 | 2 |
| NPC 플레이 허용 | `admin.world.setOption` (`entry.npcPlay`) | `World.runtimeOptions.entry` | 처리 뒤 접수되는 요청부터 | 3 |
| 야간 휴전 켜고 끄기·시간대 | `admin.world.setTruce` | `World.runtimeOptions.truce` | 처리한 순간. 시계 기준점을 다시 잡는다 | 4 |

시나리오·지도·병종 판, 확장 명령 목록(`commands`), `npc.fillRatio`, `protection.maxGeneralsPerNation`은 바꾸지 않는다. 이 값들은 생성 원본과 재생 능력 기술(`replayCapabilities.ts`)에 묶여 있다.

### 유효 옵션 한 함수

`World.preset`은 생성 원본이다. 초기화(`apps/engine/src/admin/resetPreparation.ts:152-157`)와 확장 상태(`extState.ts:39`)가 그 해시를 대조하므로 고치지 않는다. 진행 중 변경은 새 칸 `World.runtimeOptions`(Json, 기본 null)에 둔다. 모양은 `{ rules?, entry?, truce? }`다.

- `rules`: 프리셋 규칙 옵션(`protection`·`npc.aggression`·`boost`) 가운데 바꾼 칸만. 깊게 병합한다.
- `entry`: `{ generalCreation: 'open' | 'closed', npcPlay: 'off' | 'on' }`의 일부. 없으면 `open`·`off`다.
- `truce`: 키가 있으면(값이 null이어도) 프리셋의 휴전 설정보다 앞선다. null은 휴전 끔이다.

순수 함수 `effectiveWorldOptions(preset, runtimeOptions)`(`packages/rules/src/world/options.ts`)가 `{ presetRules, entry, truce }`를 낸다. `entry`와 `truce`는 규칙 상태에 넣지 않는다. 프리셋 없는 월드는 `rules` 변경을 `NO_PRESET`으로 거절하고 `entry`·`truce`만 받는다.

지금 프리셋을 직접 읽는 곳을 모두 이 함수로 바꾼다. 생성 원본을 만드는 곳(`world/persistence.ts:134`)만 원본 프리셋을 그대로 쓴다.

| 곳 | 지금 | 바꾼 뒤 |
| --- | --- | --- |
| 엔진 로더 `apps/engine/src/worldLoader.ts:52` | `presetRules(preset)` | 유효 옵션의 `presetRules` |
| 상태 저장 `world/persistence.ts:354` | 같음 | 같음 |
| 서버 조회 `apps/server/src/game/queries.ts:86` | 같음 | 같음. 미리보기와 실행이 같은 값을 본다 |
| 늦은 참가 보정 `apps/engine/src/inputs.ts:289` | 원본 프리셋의 `boost.lateJoin` | 유효 옵션 |
| 장수 생성 접수 `apps/server/src/routers/general.ts`, 엔진 `processCreation` | 검사 없음 | `entry.generalCreation` |
| 맡기 접수·처리(T3-07) | 없음 | `entry.npcPlay` |
| 휴전 읽기(T4-40의 엔진 시계 명령, 턴 루프 시계, 30칸 예정 시각) | 원본 프리셋 | 유효 옵션의 `truce` |

### 재생과 해시

새 종류는 INT-23처럼 `ruleRegistry.inputKinds`에 `feature: null`, `route: 'direct'`, `directTick: true`로 올리고 형식3 기록에서만 받는다. 엄격한 기록 검사(`validateAdminSettingRecord`)를 엔진 재생 검사에 더한다.

- `setOption`의 `rules`: 적용 함수가 상태의 `presetRules`에 같은 병합을 한다. DB에서 불러온 상태(유효 옵션)와 순수 재생 상태가 같은 해시가 된다.
- `setOption`의 `entry`, `rename`, `setEndYear`, `setTruce`: 규칙 상태를 바꾸지 않는다. 재생은 형식만 검사한다. 종료 연도는 재생 설정 `config.endYear`(`apps/engine/src/replay.ts:219`)가 지금 World 값을 쓴다. 종료 판정(`packages/rules/src/season.ts:18`)은 그 해 12월 정산에서만 일어나고 지금 연도보다 이른 값은 거절하므로 기록 전체를 마지막 값으로 재생해도 판정이 같다. 이 성질을 시험으로 고정한다.
- `setTurnTerm`: 재생 정책 `ReplayPolicy.turnTermMinutes`(`apps/engine/src/monthly.ts:55`에서 `World.turnTermMinutes`로 채움)가 해시와 미접속 판정(`packages/rules/src/policy/index.ts:32` `isInactive`)에 쓰인다. 적용 함수가 그 sequence에서 `replay.policy.turnTermMinutes`를 새 값으로 바꾼다. 기존 `lastActiveTicks`는 틱 그대로 두고 그 뒤 모든 미접속 판정은 새 간격으로 한다. 엔진도 같은 순서로 `World.turnTermMinutes`를 바꾼다. 변경 전후의 월간 해시, 미접속 경계, 재시작 뒤 값을 시험한다.

기존 월드는 `runtimeOptions`가 null이고 기록에 새 종류가 없으므로 결과가 바뀌지 않는다.

### 시계 변경 계약

턴 간격과 휴전 변경은 시계를 건드린다. 둘 다 INT-23의 `processAdminInputs` 자리(리스→World 잠금 트랜잭션, 일반 입력·월 정산 앞)에서 처리한다.

- 시각은 `databaseNow(tx)`다.
- 지금 시각에서 옛 설정으로 `checkpointClock(clock, now, highWaterTick)`을 한 뒤 새 설정으로 `clockAnchorAt`을 지금으로 다시 잡는다.
- `clockRevision`은 읽은 값과 같을 때만 1 올린다(조건부 갱신). 다르면 트랜잭션을 되돌리고 다음 순번에 다시 처리한다.
- 리스 검증은 TurnLoop가 한다.
- 체크포인트까지 도달한 틱은 옛 설정의 시각으로 확정되고 다시 계산하지 않는다. 남은 틱은 새 설정으로 계산한다.
- 정지한 월드는 `clockAnchorAt`을 건드리지 않고 값만 바꾸며 재개할 때 새 설정을 쓴다.

휴전 쪽 추가 사항이다. 휴전 규칙 본체(시간대 계산, 예정 시각 역변환 C18)는 [T4-40](./T4-40.md)·[T4-41](./T4-41.md)에 두고 이 작업은 입력과 저장만 맡는다. 입력 `admin.world.setTruce`는 T4-40의 `truceSchema` 값 또는 null을 받는다. 휴전 중에 끄면 지금 시각부터 시계가 흐른다. 휴전 시간대 안에서 켜면 지금 시각부터 멈춘다. T4-40 계획의 「진행 중 월드의 휴전 설정 바꾸기는 하지 않는다」는 이 작업이 맡는다(T4-40 정정 메모). T4-40이 휴전을 읽는 곳은 위 유효 옵션 함수를 쓴다. 그러려면 이 작업 PR 1(`runtimeOptions` migration)이 먼저 들어가야 한다.

### 초기화와의 관계

초기화 준비는 생성 요청의 이름·간격·종료 연도를 지금 World 값과 대조한다(`resetPreparation.ts:354-367`). 그대로 두면 이름만 바꿔도 `PROVENANCE_INVALID`가 난다. 그래서 대조 기준을 생성 당시 값으로 바꾼다. 생성 당시 값은 그 월드의 APPLIED `rename`·`setEndYear`·`setTurnTerm` 입력 가운데 칸마다 가장 앞선 것의 `result.before`다. 그런 입력이 없으면 지금 값이다.

초기화로 만드는 새 월드는 지금 값(바뀐 이름·간격·종료 연도)과 `runtimeOptions`를 이어받는다. 운영자가 맞춰 둔 설정을 다음 판에서도 쓰기 위해서다. 새 월드의 정책 featureData는 이어받은 간격으로 새로 만든다. 증거 해시 `resetSourceSettingsHash`(`:171`)와 `resetSettingsReference`(`:186`)에는 `runtimeOptions`가 null이 아닐 때만 키를 더한다. 그래서 이미 저장한 초기화 기록의 해시는 그대로 검증된다. 초기화 뒤 원본 월드의 재생 내보내기(`reset.ts:179`)가 통과하는지 시험한다.

### NPC 플레이

T3-07 계획의 `entry.possess`(InputEvent `general.possess`)로 사람이 NPC 장수를 맡는다. 이 작업은 그 입력을 받을지 정하는 조건만 더한다.

- `entry.npcPlay`가 `on`인 월드에서만 받는다.
- 대상은 사람이 맡지 않은 모든 NPC 장수다. 군주도 맡을 수 있다(사용자 결정). T3-07 계획은 이미 군주를 맡으면 `Nation.isNpc`를 끈다.
- 한 계정은 한 월드에서 장수 하나만 가진다. 이미 장수가 있으면 거절한다.
- 내보낸 장수(INT-23의 `removedAt`)는 맡을 수 없다.

### 접수와 거절

서버 `admin.world.requestSetting`(새 프로시저)이 받는다. 입력은 기대 사용자, 월드, 중복 방지 UUID, 사유, 판별 합집합 `setting`이다. 접수·재검사·감사는 INT-23과 같다. INT-23의 1~5번 코드에 이 코드들을 더한다.

| 코드 | 조건 |
| --- | --- |
| `END_YEAR_PASSED` | 새 종료 연도가 지금 연도보다 작음 |
| `NO_PRESET` | 프리셋 없는 월드에서 `rules`를 바꿈 |
| `UNCHANGED` | 새 값이 지금 값과 같음 |
| `INVALID_VALUE` | 프리셋·휴전 스키마 범위 밖 |

장수 생성과 맡기가 닫혀 있으면 서버 접수가 `ENTRY_CLOSED`로 막는다. 이미 PENDING이던 요청은 엔진이 처리할 때 다시 읽어 `ENTRY_CLOSED`로 REJECTED 기록을 남긴다.

화면은 운영 콘솔 월드 상세에 「속성」 탭을 두고 지금 값과 바꿀 값, 적용 시점, 사유를 보여 준다. 장수 생성이 닫히면 로비와 장수 생성 화면에 「지금은 새 장수를 받지 않습니다」를 보인다. NPC 플레이가 켜지면 로비에 「NPC 장수 맡기」 진입을 보인다.

### 범위

| PR | 내용 | 시작 조건 |
| --- | --- | --- |
| 1 속성 | `packages/rules/src/admin/settings.ts`, `world/options.ts`, 등록부·재생 검사, migration(`World.runtimeOptions`), 위 표의 유효 옵션 경로(로더·저장·서버 조회·늦은 참가), 이름·종료 연도·턴 간격·규칙 옵션, 초기화 대조, 서버 프로시저·감사, 「속성」 탭 | G-03 통과, INT-23 PR 1 |
| 2 생성 닫기 | 장수 생성 접수·엔진 재검사, 로비·생성 화면 문구 | PR 1 |
| 3 NPC 플레이 | `general.possess` 접수·처리 조건, 로비 진입 | PR 1, T3-07 맡기 구현 |
| 4 휴전 토글 | `admin.world.setTruce`, 휴전 읽기 지점을 유효 옵션으로, 「속성」 탭의 휴전 칸 | PR 1, T4-40 시계 구현 |

PR 1·2는 T3-07·T4-40을 기다리지 않는다.

### 하지 않는 것

- 시나리오·지도·병종 판, 확장 명령 목록 변경.
- 장수 정원(`maxGeneralsPerNation`) 정책(P-6 결정 전).
- 공개 월드 목록의 노출·순서 변경.

### 검증

규칙 단위 시험은 속성마다 성공과 거절을 본다. 형식3 월드에서 속성 변경을 섞은 기록을 내보내고 읽어 순수 재생한 상태와 DB에서 불러온 상태의 해시가 같아야 한다. 턴 간격은 변경 전후 월간 해시, 미접속 경계, 재시작 뒤 값을 본다. 엔진 통합 시험은 실행 중 간격 변경 뒤 다음 틱 시각, 정지 중 변경 뒤 재개, `clockRevision` 경쟁, 재시작 뒤 `runtimeOptions` 유지를 본다. 초기화는 이름·간격을 바꾼 월드의 초기화 성공, 이어받은 설정, 이전 초기화 기록의 해시 검증, 원본 월드 재생 내보내기를 본다. 장수 생성 닫기와 NPC 플레이는 접수 거절과 엔진 거절을 둘 다 본다. 휴전은 실행 중 켜기·끄기, 휴전 시간대 안에서 켜기, 정지 중 바꾼 뒤 재개, 재시작 뒤 설정 유지와 30칸 예정 시각을 본다. 화면은 실제 Chromium으로 속성 탭과 로비 문구를 본다. `pnpm check`와 독립 리뷰를 거친다.
