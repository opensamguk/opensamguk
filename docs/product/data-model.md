# 데이터 모델

> 상태: 확정 v0.2 (2026-10-20, D-011)
> 코드가 생기면 Prisma schema(`packages/db/prisma/schema.prisma`)가 기준이 되고 이 문서는 개요만 남깁니다.

## 원칙

- **모든 게임 데이터에 `worldId`가 있다.** 다중 월드를 처음부터 지원하기 위해서입니다. 한 DB, 한 schema에서
  `worldId`로 나눕니다. core2026은 profile마다 schema를 나누지만 1인 운영에서는 하나가 단순합니다.
- **게임 상태는 엔진만 바꾼다.** API는 예턴(`GeneralTurn`, `NationTurn`)과 요청 기록(`InputEvent`)만 씁니다.
- **게임 시간은 tick으로 저장한다.** 날짜 문자열은 화면용입니다. 자세한 규칙은 [게임 시계](../architecture/game-clock.md)에 있습니다.
- **나중 기능은 자리만 둔다.** Phase 2 테이블은 이름만 정해 두고 만들지 않습니다.

## 관계도

```text
 계정 영역 (월드와 무관)                 월드 영역 (모두 worldId를 가짐)
 ────────────────────────               ─────────────────────────────────────────────

 User ─1:N─ Session                     World ─1:1─ EngineLease
  │  ─1:N─ LoginRecord                    │  ─1:N─ InputEvent
  │  ─1:N─ ConsentRecord                  │
  │  ─1:N─ Sanction                       ├─1:N─ Nation ─1:N─ City
  │                                       │        │  ─1:N─ NationTurn (직책별 12칸)
  └─1:N─────────────────────────────────▶ ├─1:N─ General ─N:1─ City (현재 위치)
        (월드마다 0~1명, NPC는 User 없음)  │        │  ─N:1─ Nation (재야면 없음)
                                          │        └─1:30─ GeneralTurn
 AuditLog (운영자 조치)                    ├─1:N─ Diplomacy (국가 쌍)
                                          ├─1:N─ DiplomacyProposal
                                          ├─1:N─ Message
                                          ├─1:N─ GeneralLog, NationHistory
                                          ├─1:N─ YearbookSnapshot (달마다)
                                          └─1:1─ WorldResult (기수 결과)
```

## 계정 영역

| 테이블          | 주요 필드                                                                 | 관문 |
| --------------- | ------------------------------------------------------------------------- | ---- |
| `User`          | id, email(고유), passwordHash, emailVerifiedAt, role(USER·ADMIN), status(ACTIVE·SANCTIONED·WITHDRAWN), createdAt | M1 |
| `Session`       | id(토큰 해시), userId, expiresAt, ip, deviceHash, createdAt               | M1   |
| `LoginRecord`   | userId, at, ip, deviceHash, success                                       | M3   |
| `ConsentRecord` | userId, docType(약관·개인정보), version, agreedAt                         | M3   |
| `Sanction`      | id, userId, worldId(없으면 전체), reason, expiresAt, createdBy             | M3   |
| `AuditLog`      | id, actorUserId, action, target, payload, at                              | M3   |

## 월드 운영 영역

| 테이블        | 주요 필드                                                                                  | 관문 |
| ------------- | ------------------------------------------------------------------------------------------ | ---- |
| `World` | id, name, scenarioKey, mapKey, unitSetKey, startYear, endYear(기본값 없는 nullable), status(PREOPEN·RUNNING·PAUSED·ENDED), clockMode(REALTIME·ACCELERATED, 기본 REALTIME), turnTermMinutes, seed, clockTick, clockAnchorAt, clockRevision, startedAt, endedAt, initialStateHash, replayOrigin, outcomeFromSequence, statRules, unitSet | M1 |
| `EngineLease` | worldId(PK), ownerId, fencingToken, expiresAt                                              | M1   |
| `InputEvent`  | id, worldId, actorUserId, generalId, kind, payload, idempotencyKey(월드 안에서 고유), status(PENDING·DONE·FAILED), result, createdAt, processedAt | M1 |

## 게임 상태 영역

| 테이블      | 주요 필드                                                                                   | 관문 |
| ----------- | ------------------------------------------------------------------------------------------- | ---- |
| `Nation`    | (worldId, id) PK, name, color, capitalCityKey, gold, rice, description, philosophy, tech, level, isNpc. taxRate·payRate·notice·foundedTick·destroyedTick는 후속 작업 | M1 |
| `City`      | (worldId, cityKey) PK, name, nationId, population·Max, agriculture·Max, commerce·Max, security·Max, defence·Max, wall·Max, trust(민심), supplied | M1 |
| `General`   | (worldId, id) PK, userId(NPC면 없음), name, portraitId, nationId, cityKey, officerLevel, leadership, strength, intel, affinity, birthYear, deathYear, activeFromYear, personality, special, gold, rice, crew, crewType, train, atmos, experience, dedication, age, injury, nextTurnTick, turnRevision. defenceMode·npcKind·lastActiveAt는 후속 작업 | M1 |
| `GeneralTurn` | (worldId, generalId, slot 0~29) PK, commandKey, args. slot 범위는 DB CHECK로 제한           | M1   |
| `NationTurn`  | (nationId, officerLevel, slot 0~11) PK, commandKey, args                                  | M1   |
| `Diplomacy`   | (worldId, nationA, nationB) PK (A < B), state(NEUTRAL·DECLARED·WAR·NON_AGGRESSION), untilTick, treatyId | M1 |
| `DiplomacyProposal` | id, worldId, fromNationId, toNationId, kind, terms, status, expiresTick             | M2   |
| `Message`   | id, worldId, scope(PRIVATE·NATION·DIPLOMACY·WORLD), fromGeneralId, toGeneralId, toNationId, body, createdAt, readAt | M2 |

## 기록 영역

| 테이블             | 주요 필드                                                         | 관문 |
| ------------------ | ----------------------------------------------------------------- | ---- |
| `GeneralLog`       | id(BigInt), worldId, generalId, tick, commandKey, kind, text, createdAt. (worldId, generalId, tick) 고유 | M1   |
| `NationHistory`    | id, worldId, nationId(없으면 월드 정세), tick, text               | M1   |
| `YearbookSnapshot` | (worldId, tick) PK, data(국가별 국력, 도시별 소유 국가, 장수 수)  | M1   |
| `WorldResult` | worldId(PK이자 World FK), reason(UNIFIED·END_YEAR), winnerNationId·winnerName·winnerColor(nullable 종료 시점 사본), endedYear, endedMonth, endedTick, endedSequence, remainingNations, finalStateHash, endedAt(DB 시각) | M1 |

`YearbookSnapshot.data`에 도시별 소유 국가를 꼭 넣습니다. 천하 타임랩스(D4)가 이것만으로 재생합니다.

`WorldResult`는 결정 사건과 같은 트랜잭션에서 한 번만 생성합니다. `outcomeFromSequence`는 새 월드에서 0이며 기존 월드는 migration 직전 `actionSequence`로 채웁니다. 종료 재생은 그 번호 이후의 게임 사건만 판정합니다. 저장된 초기·월간 해시와 origin v1은 바꾸지 않습니다. archive v2의 설정·종료 정보는 네 키 `ReplayState` 밖에 둡니다. 종료 뒤 닫힌 생성 요청은 `afterEnd`에 REJECTED로만 남고 최종 해시를 바꾸지 않습니다.

## 차별화 기능 자리 (D-010 선택분)

| 테이블              | 쓰는 기능       | 주요 필드                                                    | 관문 |
| ------------------- | --------------- | ------------------------------------------------------------ | ---- |
| `Treaty`            | D1 조약서 외교, D16 교역 | id, worldId, nations, clauses(교역 허용 포함), status, startTick, endTick, brokenBy | M2 |
| `NationTrust`       | D1 신의 기록    | worldId, nationId, brokenTreaties, lastBrokenTick            | M2   |
| `Operation`         | D2 국가 작전판  | id, worldId, nationId, targetCityKey, targetTick, members, status | M2 |
| `AssignmentOffer`   | D11 발령 응답   | id, worldId, generalId, fromNationId, targetCityKey, status, expiresTick | M2 |
| `General.defaultPolicy` | D12 기본 방침 | 필드 하나: 방침 key                                         | M2   |
| `NotificationTarget`| D6 턴 알림      | userId, kind(디스코드·웹 푸시), endpoint, events              | M2   |
| `OfficeEffect` (리소스 파일) | D17 관직 주재 효과 | 관직별 도시 보정 표. DB가 아닌 `resources/`          | M3   |
| `ReputationEvent`   | D10 월단평      | worldId, generalId, tick, kind, score                        | M3   |
| (없음)              | D3 군사 조언, D15 역할별 입장 | 기존 데이터와 NPC AI만 사용                   | M3   |
| `GeneralRelation`   | D7 (Phase 2)    | worldId, generalA, generalB, kind                            | —    |

## 리소스 (DB 밖, `resources/`)

| 리소스     | 출처                        | 내용                                         |
| ---------- | --------------------------- | -------------------------------------------- |
| 지도       | core2026 `map_che.json`     | 도시 94개: id, 이름, 등급, 지역, 좌표, 연결, 초기값, 최대치 |
| 시나리오   | core2026 `scenario_1030.json` 등 | 시작 연도, 국가, 장수, 외교, 도시 소유 |
| 병종       | core2026 `unitset_basic.json` 참고 | 보병·궁병·기병·성벽과 상성             |
| 프리셋     | 새로 작성                   | 턴 간격, 명령 세트, NPC 설정 (D5)            |

core2026 리소스를 옮길 때는 파일 머리나 `resources/NOTICE`에 출처(MIT, © 2025 devsam)를 남깁니다.

## 정할 것

- tick 단위: core2026처럼 1턴을 큰 정수(36,000,000 tick)로 둘지, 더 단순하게 갈지. M1 엔진 작업 첫날 정합니다.
- `officerLevel`은 원작 숫자 0~12를 보존합니다 (T1-03). 0 재야, 1 장수, 5~10 수뇌, 11 참모, 12 군주입니다.
