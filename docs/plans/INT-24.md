# INT-24 진행 중 월드의 서버 속성 변경, NPC 플레이, 야간 휴전 토글

> AC-INT-24 · 구현 Codex · 리뷰 Claude · 결정 [D-057](../product/decisions.md) · 사용자 직접 요청 2026-11-01
> 상태: 상세 계획 제안. Codex 계획 기술 검토(G-03) 전이다.
> 기준: main `d2202e13`. 짝 계획은 [INT-23 게임 안 개입과 기록 조회](./INT-23.md)다. NPC 장수 맡기는 [T3-07](./T3-07.md)의 `entry.possess` 설계를 쓴다.

## 계획 (Claude)

### 목표

월드의 이름·종료 연도·턴 간격과 프리셋 값은 지금 만들 때만 정한다. 사용자가 2026-11-01 진행 중인 월드에서 이 값들을 바꾸고 NPC 플레이 허용과 야간 휴전도 켜고 끌 수 있게 하도록 정했다(D-057). 맡을 수 있는 NPC는 군주를 포함한 모든 NPC 장수다.

### 바꿀 수 있는 속성

| 속성 | 입력 종류 | 저장 위치 | 적용 시점 |
| --- | --- | --- | --- |
| 이름 | `admin.world.rename` | `World.name` | 즉시. 규칙 상태와 무관 |
| 종료 연도 | `admin.world.setEndYear` | `World.endYear` | 즉시. 이미 지난 연도는 거절 |
| 턴 간격 | `admin.world.setTurnTerm` | `World.turnTermMinutes` | 다음 틱부터. 시계 기준점을 다시 잡는다 |
| 장수 생성 열고 닫기 | `admin.world.setOption` (`entry.generalCreation`) | 새 칸 `World.runtimeOptions` | 다음 생성 요청부터 |
| NPC 플레이 허용 | `admin.world.setOption` (`entry.npcPlay`) | `World.runtimeOptions` | 다음 맡기 요청부터 |
| 보호 기간 | `admin.world.setOption` (`protection.foundUntilMonths`, `protection.peaceMonths`) | `World.runtimeOptions`와 규칙 상태 `presetRules` | 다음 틱부터 |
| NPC 공격성·추가 보정 | `admin.world.setOption` (`npc.aggression`, `boost.*`) | 같음 | 다음 틱부터 |
| 야간 휴전 켜고 끄기·시간대 | `admin.world.setTruce` | `World.runtimeOptions.truce` | 지금 시각부터. 시계 기준점을 다시 잡는다 |

프리셋에서 바꾸지 않는 값은 시나리오·지도·병종 판, 확장 명령 목록(`commands`), `npc.fillRatio`, `protection.maxGeneralsPerNation`이다. 이 값들은 월드 생성 원본과 재생 능력 기술(`replayCapabilities.ts`)에 묶여 있다.

### 프리셋 값과 재생

규칙은 프리셋 값을 상태의 `presetRules`(`packages/rules/src/model/world.ts:22`)로 읽는다. 엔진은 월드를 불러올 때 `World.preset`에서 다시 만든다(`apps/engine/src/worldLoader.ts:52`, `world/persistence.ts:134`). `World.preset`은 생성 원본이다. 초기화(`admin/resetPreparation.ts:152-157`)와 확장 상태(`extState.ts:39`)가 그 해시를 원본과 대조하므로 고치지 않는다.

그래서 진행 중 변경은 새 칸 `World.runtimeOptions`(Json, 기본 null)에 덮어쓸 값만 둔다. 월드를 불러올 때 `presetRules(preset)`에 `runtimeOptions`를 덮어 상태를 만든다. 같은 변경을 재생 입력으로도 기록한다. `applyRecordedInput`이 `admin.world.setOption`을 만나면 상태의 `presetRules`에 같은 덮어쓰기를 한다. 그러면 순수 재생과 DB에서 불러온 상태가 같은 해시가 된다. 기존 월드는 `runtimeOptions`가 null이고 재생 기록에 이 입력이 없으므로 결과가 바뀌지 않는다.

`entry.generalCreation`(`open`·`closed`)과 `entry.npcPlay`(`off`·`on`)는 규칙 상태가 아니라 서버 접수 조건이다. 기본값은 `open`·`off`다. 엔진은 생성·맡기 입력을 처리할 때 이 값을 다시 읽어 닫혀 있으면 `ENTRY_CLOSED`로 거절한다. 그 거절도 재생 기록에 남는다.

### 턴 간격

턴 간격은 `apps/engine/src/world/clock.ts`의 `controlClockInTransaction`과 같은 방식으로 바꾼다. 지금 시각에서 시계를 체크포인트(`checkpointClock`)한 뒤 `turnTermMinutes`를 바꾸고 `clockAnchorAt`을 지금으로 다시 잡는다. `clockRevision`을 올린다. 이미 처리한 틱은 다시 계산하지 않는다. 범위는 프리셋 스키마와 같다(1분 이상). 실행 중 월드에서는 정지 없이 바꿀 수 있고 정지한 월드는 재개할 때 새 간격을 쓴다. 재생 결과는 틱 순서로만 계산하므로 턴 간격이 바뀌어도 상태 해시는 변하지 않는다. 시계 기록은 InputEvent의 `result`(`before`·`after`)에 남긴다.

### 야간 휴전

사용자가 2026-11-01 야간 휴전을 월드마다 운영자가 켜고 끌 수 있게 하도록 정했다(D-057). 휴전 규칙 본체는 [T4-40](./T4-40.md)(시계와 예정 시각 역변환, C18)과 [T4-41](./T4-41.md)(화면)에 둔다. 이 작업은 진행 중 월드에서 휴전 설정을 바꾸는 입력과 저장만 맡는다.

- 입력 `admin.world.setTruce`는 `truce: Truce | null`을 받는다. `Truce`는 T4-40의 `truceSchema`(`utcOffsetMinutes`, `startMinute`, `endMinute`)다. null이면 휴전을 끈다.
- 저장은 `World.runtimeOptions.truce`다. 이 칸이 있으면(null 포함) `World.preset.truce`보다 앞선다. 엔진과 서버는 휴전 설정을 읽는 곳마다 `runtimeOptions.truce`가 있으면 그 값, 없으면 프리셋 사본 값을 쓴다. T4-40이 둔 읽기 지점(엔진 시계 명령, 턴 루프의 시계 생성, 30칸 예정 시각 응답)을 이 한 함수로 모은다.
- 바꿀 때는 턴 간격과 같이 지금 시각에서 옛 설정으로 시계를 체크포인트한 뒤 새 설정으로 기준 시각을 다시 잡고 `clockRevision`을 올린다. 이미 지난 틱의 시각은 다시 계산하지 않는다. 휴전 중에 끄면 지금 시각부터 시계가 다시 흐른다. 휴전 시간대 안에서 켜면 지금 시각부터 멈춘다.
- T4-40대로 휴전은 상태(`presetRules`)에 넣지 않으므로 상태 해시는 바뀌지 않는다. 재생은 틱 순서로만 계산하므로 이 입력은 재생에서 상태를 바꾸지 않고 형식만 검사한다. 시계 기록은 InputEvent `result`의 `before`·`after`에 남긴다.
- 순서는 T4-40 시계 PR 다음이다. T4-40 계획의 「진행 중 월드의 휴전 설정 바꾸기는 하지 않는다」는 이 작업이 맡는다고 정정한다.

### NPC 플레이

T3-07 계획의 `entry.possess`(InputEvent `general.possess`)로 사람이 NPC 장수를 맡는다. 이 작업은 그 입력을 받을지 정하는 조건만 더한다.

- `entry.npcPlay`가 `on`인 월드에서만 받는다.
- 대상은 사람이 맡지 않은 모든 NPC 장수다. 군주도 맡을 수 있다(사용자 결정).
- 한 계정은 한 월드에서 장수 하나만 가진다. 이미 장수가 있으면 거절한다.
- 내보낸 장수(INT-23의 `removedAt`)는 맡을 수 없다.

T3-07의 맡기 구현이 아직 없다. 순서는 이 작업의 서버 속성 PR → T3-07 맡기 → 이 작업의 NPC 플레이 PR이다. T3-07 계획은 이미 군주도 맡을 수 있고 군주를 맡으면 `Nation.isNpc`를 끈다(T3-07 맡기 처리 절). D-057와 맞는다.

### 입력 계약과 처리

서버 `admin.world.requestSetting`(새 프로시저)이 받는다. 기대 사용자, 월드, 중복 방지 UUID, 사유, 판별 합집합 `setting`이 입력이다. 접수·재검사·거절 코드·감사는 INT-23과 같다. 추가 거절 코드다.

| 코드 | 조건 |
| --- | --- |
| `END_YEAR_PASSED` | 새 종료 연도가 지금 연도보다 작음 |
| `UNCHANGED` | 새 값이 지금 값과 같음 |
| `INVALID_VALUE` | 프리셋 스키마 범위 밖 |

이름·종료 연도·턴 간격·`runtimeOptions`는 World 행을 잠근 같은 트랜잭션에서 바꾼다. 화면에는 월드 목록의 상세 창에 「속성」 탭을 두고 지금 값과 바꿀 값, 적용 시점, 사유를 보여 준다. 장수 생성이 닫히면 로비와 장수 생성 화면에 「지금은 새 장수를 받지 않습니다」를 보인다. NPC 플레이가 켜지면 로비에 「NPC 장수 맡기」 진입을 보인다.

### 범위

| PR | 파일 | 시작 조건 |
| --- | --- | --- |
| 1 속성 | `packages/rules/src/admin/settings.ts`, `replay.ts` 갈래, migration(`World.runtimeOptions`), `worldLoader.ts`·`persistence.ts` 덮어쓰기, `apps/engine/src/admin/settings.ts`, 서버 프로시저·감사, 운영 화면 「속성」 탭 | G-03 통과 |
| 2 생성 닫기 | 서버 `general.create` 접수 검사와 엔진 재검사, 로비·생성 화면 문구 | PR 1 |
| 3 NPC 플레이 | `general.possess` 접수 조건, 로비 진입 | PR 1, T3-07 맡기 |
| 4 휴전 토글 | `admin.world.setTruce` 규칙·엔진·서버, 휴전 설정 읽기 함수 하나로 모으기, 운영 화면 「속성」 탭의 휴전 칸 | PR 1, T4-40 시계 PR |

### 하지 않는 것

- 시나리오·지도·병종 판, 확장 명령 목록 변경.
- 장수 정원(`maxGeneralsPerNation`) 정책(P-6 결정 전).
- 공개 월드 목록의 노출·순서 변경.

### 검증

규칙 단위 시험은 속성마다 성공과 거절을 본다. 재생 시험은 `setOption`을 섞은 월드를 순수 재생해 DB에서 불러온 상태와 해시를 비교한다. 엔진 통합 시험은 실행 중 턴 간격 변경 뒤 다음 틱 시각, 정지·재개 뒤 간격, 재시작 뒤 `runtimeOptions` 유지를 본다. 장수 생성 닫기와 NPC 플레이는 접수 거절과 엔진 거절을 둘 다 본다. 휴전은 실행 중 켜기·끄기, 휴전 시간대 안에서 켜기, 정지 중 바꾼 뒤 재개, 재시작 뒤 설정 유지와 30칸 예정 시각을 본다. 화면은 실제 Chromium으로 속성 탭과 로비 문구를 본다. `pnpm check`와 독립 리뷰를 거친다.

### 질문

- G-03에 물을 것: `runtimeOptions`를 불러올 때 덮는 방식이 초기화(`resetPreparation`)와 재생 능력 기술의 원본 대조를 건드리지 않는지, 턴 간격 변경을 시계 요청과 같은 InputEvent 순서에 두어도 리스·시계 계약과 맞는지.
- 사용자 결정이 남은 것은 없다.
