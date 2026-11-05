# INT-24 진행 중 월드의 서버 속성 변경, NPC 플레이, 야간 휴전 토글

> AC-INT-24 · 구현 Codex · 리뷰 Claude · 결정 [D-057](../product/decisions.md) · 사용자 직접 요청 2026-11-01
> 상태: 4판 G-03 통과([PR #331 검토](https://github.com/opensamguk/opensamguk/pull/331#issuecomment-6558996970)). PR1 백엔드 구현·검증 중이며 전체 AC는 미완료다.
> 기준: main `d2202e13`. 짝 계획은 [INT-23 게임 안 개입과 기록 조회](./INT-23.md)다. 입력 등록·접수·엔진 처리 자리·감사는 INT-23과 같다. NPC 장수 맡기는 [T3-07](./T3-07.md)의 `entry.possess` 설계를 쓴다.

## 계획 (Claude)

### 목표

월드의 이름·종료 연도·턴 간격과 프리셋 값은 지금 만들 때만 정한다. 사용자가 2026-11-01 진행 중인 월드에서 이 값들을 바꾸고 NPC 플레이 허용과 야간 휴전도 켜고 끌 수 있게 하도록 정했다(D-057). 맡을 수 있는 NPC는 군주를 포함한 모든 NPC 장수다.

### 바꿀 수 있는 속성

| 속성 | 입력 종류 | 저장 위치 | 적용 시점 | PR |
| --- | --- | --- | --- | --- |
| 이름 | `admin.world.rename` | `World.name` | 처리한 순간 | 1 |
| 종료 연도 | `admin.world.setEndYear` | `World.endYear` | 처리한 순간. 지금 연도보다 이른 값은 거절 | 1 |
| 턴 간격 | `admin.world.setTurnTerm` | `World.turnTermMinutes`, 재생 정책 | 처리 시각까지 도달한 틱은 옛 간격으로 확정하고 그다음 틱부터 새 간격 | 1 |
| 보호 기간·NPC 공격성·추가 보정 | `admin.world.setOption` (`protection.foundUntilMonths`, `protection.peaceMonths`, `npc.aggression`, `boost.*`) | `World.runtimeOptions.rules`, 상태 `presetRules` | 처리 다음의 첫 틱부터 | 1 |
| 장수 생성 열고 닫기 | `admin.world.setOption` (`entry.generalCreation`) | `World.runtimeOptions.entry` | 처리 뒤 새 접수부터. 이미 대기인 생성도 처리 때 재검사 | 2 |
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

초기화로 만드는 새 월드는 진행 중에 바꾼 설정을 이어받지 않는다. 원본 월드를 만들 때의 이름·간격·종료 연도·프리셋으로 다시 시작하고 `runtimeOptions`는 null이다. 2차 검토에서 승계를 택하면 새 월드의 재생 시작 상태, 정책 featureData, 자원 해시(`clock/reset.ts:118`의 원본·새 자원 해시 같음 조건)와 초기화 증거가 모두 갈라진다는 점이 드러났다. 바꾼 설정이 다음 판에도 필요하면 운영자가 새 월드에서 다시 바꾼다. 그 변경도 감사와 재생 기록에 남는다.

이렇게 하려면 초기화가 읽는 설정을 하나의 함수 `creationSettings(world, appliedSettingInputs)`로 모은다. 이 함수는 그 월드의 APPLIED `rename`·`setEndYear`·`setTurnTerm` 입력 가운데 칸마다 가장 앞선 것의 `result.before`를 생성 당시 값으로 돌려준다. 그런 입력이 없으면 지금 World 값이다. `runtimeOptions`는 읽지 않는다. 아래 다섯 곳이 지금 World 값 대신 이 함수를 쓴다.

| 곳 | 하는 일 |
| --- | --- |
| `resetPreparation.ts:354-367` | 생성 요청과 원본 월드의 출처 대조 |
| `resetSourceSettingsHash`(`:171`), `resetSettingsReference`(`:186`) | 초기화 증거의 원본 설정 해시와 새 월드 설정 |
| `resetPreparation.ts:231` `resetRefs` | 초기화로 생긴 월드를 다시 초기화할 때 과거 증거 대조 |
| `admin/reset.ts:179` `checkedResetTarget` | 원본 월드 재생 내보내기에서 새 월드 연결 검사 |
| `resetPreparation.ts:158` `sourceOrigin`의 `InitialWorldOptions` | 원본 시드 재구성과 새 월드 준비 양쪽에 넘기는 이름·간격·종료 연도. 정책 featureData의 간격과 같아야 `world/persistence.ts:107` 검사를 통과한다 |

재생 내보내기의 종료 연도는 두 값을 나눈다. 아카이브 `config.endYear`(`apps/engine/src/replay.ts:219`)는 종료 판정에 쓰는 지금 값 그대로다. 초기화 결과 검사(`replay.ts:424`)의 `reset.settings.endYear !== archive.config.endYear`는 `reset.settings.endYear !== creationEndYear(archive)`로 바꾼다. `creationEndYear`는 아카이브 안의 APPLIED `setEndYear` 입력 가운데 가장 앞선 것의 `result.before`이고 없으면 `config.endYear`다. 변경 입력이 없는 기존 아카이브는 지금과 같은 비교가 된다.

설정을 바꾼 적 없는 월드는 함수 값이 지금 값과 같으므로 이미 저장한 초기화 기록의 해시가 그대로 검증된다. 생성 당시 값은 바뀌지 않으므로 A를 초기화해 B를 만든 뒤 B의 설정을 바꿔도 A 내보내기와 B 재초기화의 대조가 그대로 통과한다. featureData와 자원 해시는 생성 당시 간격으로 만들므로 지금처럼 원본과 새 월드가 같다.

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
| 1 속성 | `packages/rules/src/admin/settings.ts`, `world/options.ts`, 등록부·재생 검사, migration(`World.runtimeOptions`), 위 표의 유효 옵션 경로(로더·저장·서버 조회·늦은 참가), 이름·종료 연도·턴 간격·규칙 옵션, 초기화 설정 함수 `creationSettings`와 다섯 사용처, `creationEndYear`, 서버 프로시저·감사, 「속성」 탭 | G-03 통과, INT-23 PR 1 |
| 2 생성 닫기 | 장수 생성 접수·엔진 재검사, 로비·생성 화면 문구 | PR 1 |
| 3 NPC 플레이 | `general.possess` 접수·처리 조건, 로비 진입 | PR 1, T3-07 맡기 구현 |
| 4 휴전 토글 | `admin.world.setTruce`, 휴전 읽기 지점을 유효 옵션으로, 「속성」 탭의 휴전 칸 | PR 1, T4-40 시계 구현 |

PR 1·2는 T3-07·T4-40을 기다리지 않는다.

### 하지 않는 것

- 시나리오·지도·병종 판, 확장 명령 목록 변경.
- 장수 정원(`maxGeneralsPerNation`) 정책(P-6 결정 전).
- 공개 월드 목록의 노출·순서 변경.

### 검증

규칙 단위 시험은 속성마다 성공과 거절을 본다. 형식3 월드에서 속성 변경을 섞은 기록을 내보내고 읽어 순수 재생한 상태와 DB에서 불러온 상태의 해시가 같아야 한다. 턴 간격은 변경 전후 월간 해시, 미접속 경계, 재시작 뒤 값을 본다. 엔진 통합 시험은 실행 중 간격 변경 뒤 다음 틱 시각, 정지 중 변경 뒤 재개, `clockRevision` 경쟁, 재시작 뒤 `runtimeOptions` 유지를 본다. 초기화는 이름·간격·종료 연도·규칙 옵션을 바꾼 월드 A의 초기화 성공, 종료 연도를 바꾼 A의 원본 내보내기·읽기·끝까지 재생, 새 월드 B가 생성 당시 설정으로 시작하는지, B의 첫 정산·재시작·재생 해시 일치, 이전 초기화 기록의 해시 검증, B 설정 변경 뒤 A 내보내기와 B 재초기화를 본다. 장수 생성 닫기와 NPC 플레이는 접수 거절과 엔진 거절을 둘 다 본다. 휴전은 실행 중 켜기·끄기, 휴전 시간대 안에서 켜기, 정지 중 바꾼 뒤 재개, 재시작 뒤 설정 유지와 30칸 예정 시각을 본다. 화면은 실제 Chromium으로 속성 탭과 로비 문구를 본다. `pnpm check`와 독립 리뷰를 거친다.


## PR1 백엔드 구현 (Codex)

형식3 전용 설정 요청·조회, 리스와 월드 잠금 아래 적용, 유효 규칙 병합, 간격 변경과 정책 재생을 연결했다. `World.runtimeOptions`는 nullable JSONB이며 생성 원본 프리셋은 유지한다. API는 입력만 접수하고 설정·메시지·처리 결과·감사는 엔진 트랜잭션에서 확정한다. 운영 알림은 commit 뒤 보낸다.

설정 변경 이력에서 생성 당시 이름·간격·종료 연도를 역산해 초기화의 다섯 사용처에 적용했다. 이름을 바꾼 월드의 초기화 결과에는 `confirmedName`을 선택 키로 추가한다. 이 값은 접수 때 확인한 현재 이름이고 `settings.name`은 새 판에 복원하는 생성 이름이다. 기존 기록의 키·해시는 유지하며 이름이 달라질 때만 새 키를 쓴다. 재생 파일은 이름 변경 이력으로 두 이름의 연결을 대조한다.

프론트 속성 탭은 Claude 담당이다. PR2 생성 닫기는 아래 후속 구현에 기록한다. PR3 NPC 맡기와 PR4 휴전은 아직 구현하지 않았다. 실제 PostgreSQL·HTTP·엔진 검증과 전체 검사·독립 리뷰·보호 병합 전에는 PR1이나 전체 AC를 완료로 바꾸지 않는다.

실제 PostgreSQL18.6·소켓 HTTP·펜싱 엔진 검증 3파일29건이 통과했다(46.43초). 새 API 권한15경우, 입력 멱등성과 권한 재검사, DB 원자성, 간격 변경 전후 월간 해시·활동 기준, 오래된 시계 revision의 롤백, A→B 초기화·B 첫 정산·설정 변경 뒤 A 내보내기·B 재초기화를 확인했다. 기존 마이그레이션 empty/legacy4건은 nullable 열과 기존 행·golden을 함께 검증했다. 전체 검사와 독립 리뷰는 진행 중이다.


## PR2 장수 생성 열기·닫기 (Codex)

`entry.generalCreation`은 프리셋과 관계없이 open·closed를 받는다. 기존 규칙 옵션을 보존하며 `runtimeOptions.entry`에 저장하고 규칙 재생 상태는 바꾸지 않는다. 접수·엔진·로비의 생성 차단은 같은 순수 `creationBlock`을 쓰며 기존 장수와 멈춘 판의 판정은 유지한다. 닫은 뒤 새 접수는 412로 막고 이미 접수된 생성은 엔진에서 `ENTRY_CLOSED`로 거절한다. 다시 열면 새 요청으로 생성할 수 있다.

`general.mine.creationRules.generalCreationEnabled`와 로비 차단 사유를 화면에 제공한다. 프론트 파일은 수정하지 않았으며 생성 화면·속성 탭 문구는 Claude 담당이다. 초기화로 만든 새 판의 생성 허용은 기본값 open이다.

실제 PostgreSQL18.6·HTTP·펜싱 엔진4파일103건이 통과했다(83.46초). 새 생성 제어5건, 기존 설정25건, 기존 생성·로비 회귀를 함께 확인했다. 전체 타입 검사·수정 파일 ESLint와 집중 규칙2파일16건도 통과했다. 검증 뒤 시험 제목 한 곳과 이 문서·API 문서만 정리했다. 전체 로컬 `pnpm check`는 460파일·7168시험이 통과했다(시험498.27초). 독립 Codex 리뷰는 필수 수정0건이며 보호 CI·병합은 진행 중이다. PR2나 전체 AC를 완료로 바꾸지 않는다.
