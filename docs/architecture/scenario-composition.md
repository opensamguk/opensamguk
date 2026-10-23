# 시나리오 합성

> 상태: T1-03 구현 · 관련 AC: M1-03, M2-03 · 출처: [리소스 고지](../../resources/NOTICE.md)
> 이 문서가 답할 질문: 월드 하나를 만들 때 어떤 파일들을 어떻게 합쳐 초기 상태를 만드나?

## 1. 재료

| 재료     | 파일                              | 출처 |
| -------- | --------------------------------- | ---- |
| 지도     | `resources/map/che.json`          | core2026 `map_che.json` (도시 94개, 가정 A5) |
| 시나리오 | `resources/scenario/1030.json`    | core2026 「군웅할거(191)」 (가정 A6) |
| 병종     | `resources/unitset/basic.json`    | core2026 `unitset_basic.json` 참고 (가정 A7) |
| 능력치   | `resources/scenario/default.json` | 합계 165, 최소 15, 최대 80 |
| 프리셋   | `resources/preset/*.json` (M2)    | 새로 작성 (D5) |

core2026 파일을 옮길 때 출처(MIT, © 2025 devsam)를 남깁니다.

## 2. 합성 순서

```text
프리셋 ─▶ (어떤 시나리오·지도·병종·명령 세트·턴 간격을 쓸지)
   └─▶ 시나리오 + 지도 + 병종 ─▶ zod 검증 ─▶ 시드 고정 초기화 ─▶ 월드 초기 상태
```

`apps/engine/src/world/resources.ts`만 파일을 읽고 `packages/rules/src/world/resources.ts`가 zod로 검증합니다.
순수 함수 `buildInitialWorld()`가 국가·도시·장수·외교 상태를 만듭니다. 도시 ID는 지도 것을 쓰고 국가·장수 ID는 원본 배열 순서 + 1입니다.
DB의 ID는 모두 월드 안에서만 유일합니다.

- 도시 소유는 국가의 도시 목록, 수도는 그 목록의 첫 도시입니다. 지도 초기값·최대치와 기본 민심 50을 보존합니다.
- 도시가 없는 장수는 `rngFor(seed, 'bootstrap')`로 소속 국가 도시에서 고릅니다. 재야면 전체 도시에서 고릅니다.
- 원본 `officerLevel` 0~12를 그대로 보존하고 `activeFromYear = birthYear + 15`를 저장합니다.
- 외교는 국가 ID를 작은 순서로 정규화하고 마지막 줄을 적용합니다. 원본 8줄 중 중복 1개를 합쳐 7쌍입니다.
  기간은 1개월 = 10,000 tick으로 바꿉니다 (T1-04의 시계 단위).
- 원작의 `general_ex`, `history`, `extends`와 대사는 사용하지 않습니다. 특기·성격은 문자열만 저장하며
  병종은 성벽·보병·궁병·기병 4종으로 줄였습니다. 초상 경로는 무시하고 `portraitId = null`입니다.

초기 금·쌀은 장수당 1,000, 병력·훈련·사기·경험·공헌·부상·다음 턴 tick은 0입니다.
턴 시각 분산은 T1-06에서 추가합니다.

`hashState()`는 키를 정렬한 JSON의 SHA-256입니다. 월드 ID·이름·생성 시각·운영 설정을 제외한 `WorldInit`을 해시합니다.
Node `crypto` 구현은 `@opensamguk/shared/node`에 분리하며 rules·브라우저 공용 진입점으로 내보내지 않습니다.
같은 리소스와 시드면 같은 해시이고 DB에 저장한 상태를 다시 적재한 해시도 같습니다.

## 3. 검증

- 도시 ID·이름 중복, 없는 도시·단방향·자기 자신 연결, 초기값의 최대치 초과를 거부합니다.
- 없는 국가 도시·수도, 도시 소유 중복, 장수의 잘못된 국가·도시, 외교의 없는 국가·동일 국가 쌍을 거부합니다.
- 기본 병종이 없거나 병종 ID가 중복되면 거부합니다.
- 엔진이 월드·국가·도시·장수·외교를 한 트랜잭션으로 저장합니다. 국가↔수도 참조는 도시 생성 뒤 연결하며
  중간 실패는 전체를 롤백합니다. 모든 관계는 `worldId`를 포함하는 외래키로 격리합니다.
- 단위 테스트는 `tools/world-bootstrap.test.ts`, 실제 DB 검증은 `apps/engine/src/world/createWorld.integration.test.ts`입니다.

## 4. 프리셋 형식 (M2)

`resources/preset/{regular,speed,beginner,hardcore}.json`을 읽어 월드를 만듭니다.
턴 간격은 각각 60·10·30·60분이며 출병·선포 후보의 NPC 점수 가중치는 1·1·0.5·1.5입니다.
가중치는 최고 점수를 고르기 전에 곱합니다. 출병 횟수의 배수를 뜻하지 않습니다.

```sh
pnpm world:create --preset beginner --seed example --end-year 300 --name 초보월드
```

프리셋은 `name`, `turnTermMinutes`, `scenario`, `map`, `unitSet`, `commands`, `npc`,
`protection`, `boost`, `features`를 받습니다. `packages/rules/src/world/preset.ts`가
모르는 칸과 범위를 벗어난 값을 거부합니다. `--scenario`, `--map`, `--turn-term`은 프리셋 값을
덮어씁니다. `--seed`와 `--end-year`, `--name`은 필수입니다. 프리셋 없이 실행하면 기존 생성 경로를 씁니다.

`commands`는 기본 37개 명령에 더할 확장 명령의 `general`·`nation` 목록입니다.
생략·`null`·빈 두 목록은 `null`로 정규화합니다. 기본 명령 key와 모르는 key는 거부합니다.
현재 운영 확장 목록은 비어 있어 네 프리셋의 명령 세트는 같습니다. 실제 경로 연결은 T4-03 몫입니다.

초보는 시작 뒤 12개월 동안 건국·거병, 24개월 동안 출병·선포를 막습니다.
경과 개월은 실행 tick을 10,000으로 나눈 내림값이며 기간과 같아지는 tick부터 허용합니다.
사람 장수가 300명 미만이면 내정의 도시·국가 상승량만 1.2배이고 경험·공헌은 같습니다.
속성·초보는 시작 3년 뒤부터 국가 소속 장수의 경험을 정렬해
`max(1, round(수 × 0.2))`번째 경험의 0.8배를 반올림해 새 장수에게 줍니다. 빈 풀은 경험 0입니다.
초보의 시작 금·쌀은 경험 보정 시점과 별개로 `1000 + 100 × min(경과 연도, 5)`입니다.
정규·하드코어에는 인원·늦은 참가 보정이 없습니다.

네 프리셋은 시작 NPC 100%, 국가당 정원 무제한입니다. 비율 1 미만과 유한 정원은
정책이 정해지지 않아 스키마가 거부합니다. 초보의 `features.advisor`는 켜짐을 저장하며
실제 군사 조언은 T3-07에서 구현합니다.

생성 트랜잭션이 정규화한 사본을 `World.preset`, 선택 key를 `World.presetKey`에 한 번 저장합니다.
리소스 파일이 나중에 바뀌어도 기존 월드에는 영향을 주지 않습니다.
CLI 덮어쓰기 값은 기존 월드 칸에만 남고 프리셋 사본은 그대로입니다.
보호·NPC 가중치·보정은 `presetRules`로 초기 상태·엔진·서버 보기·복제·재생에 전달합니다.
v1 origin의 `initial`과 초기 해시가 이 값을 포함합니다. 기록 버전은 바꾸지 않습니다.
기존 월드는 두 DB 칸이 `null`이고 상태에 `presetRules` 키를 만들지 않아 기존 해시를 보존합니다.
