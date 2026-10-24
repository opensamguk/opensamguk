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

내장 `che` 1판은 `version` 없는 v1입니다. v2는 `version: 2`, 정수 `canvas.width`·`canvas.height`, 필수 `terrain`과 네 층(`coast`, `lakes`, `mountains`, `rivers`)을 더합니다. `$comment`는 선택이며 도시 칸은 v1과 같습니다. v2는 모든 깊이에서 모르는 칸을 거부합니다. `defaults`는 `trust`·`supplyState`·선택 `trade`·선택 `frontState`만 받습니다. `normalizeMapToV2`는 v1을 700×500과 빈 지형으로 올리고 출처 고지를 보존하며 `meta`를 버립니다. 지도 초안의 저장과 게시는 v2만 받는 서버 작업(T4-78)에서 연결합니다.

검증용 `mapV1Schema`는 `$comment`와 `defaults.trade`·`defaults.frontState`를 선택 칸으로 보존합니다. 따라서 `normalizeMapToV2(validateMap(content).value!)`로 이어도 출처가 남습니다. 월드 생성용 `world/resources.ts`의 `mapSchema`는 그대로이며 이 선택 칸을 초기 상태에 넣지 않습니다.

| 공개 경로 | 이름 | 역할 |
| --------- | ---- | ---- |
| `@opensamguk/rules/resources` | `mapResourceSchema` | v1·v2를 분기해 읽는 자원 검증용 형식입니다. |
| `@opensamguk/rules/resources` | `mapV1Schema`, `mapV2Schema` | 각 판 형식을 읽으며 v1에서도 출처와 선택 기본 칸을 보존합니다. |
| `@opensamguk/rules` | `mapSchema` | 기존 월드 생성용 v1 형식이며 모르는 칸을 버립니다. |

캔버스와 지형은 표시 전용이며 `WorldInit`에 들어가지 않습니다. 같은 도시를 가진 v1·v2의 초기 상태·상태 해시·자원 해시는 같습니다. 좌표 경계는 안에 포함하고 해안이 없으면 바탕이 땅입니다. 해안이 있으면 바탕은 바다이며 다각형 전체를 짝홀 규칙으로 채웁니다. 산맥·호수·강을 차례로 덧칠합니다. 자기 교차는 허용합니다.

밑그림의 색과 순서는 `MAP_SKETCH_PALETTE`가 정합니다.

| 번호 | 층 | 색 |
| ---- | -- | -- |
| 0 | 바다 | `#2b5d8c` |
| 1 | 땅 | `#cbb98a` |
| 2 | 강 | `#4f8fd0` |
| 3 | 산 | `#7a6347` |
| 4 | 호수 | `#6aa6d8` |

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

게시 검증기는 `@opensamguk/rules/resources`의 `validateResource`와 종류별 함수입니다. 결과는 `{ ok, issues, value }`이며 형식 실패면 `value`는 null이고 뜻 검사는 멈춥니다. 경고만 있으면 `ok`는 true입니다. `value`는 표시용으로만 쓰고 받은 원문을 저장합니다. 기존 `buildInitialWorld`의 마지막 방어선은 그대로 두며 `tools/resource-validate.test.ts`가 거부 사례와 v1·v2 해시 불변을 대조합니다. 카탈로그에서 짝 지도 유무·게시 여부를 확인하고 게시를 막는 연결은 T4-78 몫입니다.

짝 지도의 형식만 잘못됐으면 `scenario-map-invalid`를 내고 시나리오의 도시 참조 검사만 건너뜁니다. 시나리오 자체의 ID·이름·소유·소속·생몰년·외교 검사는 계속합니다. `shape-invalid` 문구는 zod 오류 코드를 한국어로 바꾸고 점으로 이은 경로를 넣으며 루트 경로는 `$`로 씁니다. `terrain-out-of-canvas`는 선마다 하나이며 캔버스 밖 점 수와 첫 점 번호를 알립니다.

코드·문구·고정 params 키의 정본은 `packages/rules/src/world/validate/issues.ts`의 `RESOURCE_ISSUES`입니다. 계획 파일의 구현 기록은 조율 세션이 채우므로 여기에도 코드별 키를 남깁니다. 지도 한도는 도시 300개, 선 하나당 점 2,000개, 지형 전체 점 20,000개, 캔버스 700×500입니다.

| 코드 | params 키 |
| ---- | --------- |
| `shape-invalid` | `path` (점으로 이은 경로, 루트는 `$`), `detail` (한국어 설명) |
| `resource-id-mismatch` | `id`, `expectedId` |
| `map-canvas-range` | `width`, `height` |
| `map-too-large`, `terrain-too-large` | `count`, `limit` |
| `city-id-duplicate` | `id`, `firstIndex` |
| `city-name-empty` | `id` |
| `city-name-duplicate`, `scenario-nation-name-duplicate`, `scenario-general-name-duplicate`, `unitset-crew-name-duplicate` | `name`, `firstIndex` |
| `city-out-of-canvas`, `city-off-land` | `name`, `x`, `y` |
| `city-level-range` | `name`, `level` |
| `city-region-range` | `name`, `region` |
| `city-initial-over-max` | `name`, `field`, `initial`, `max` |
| `link-duplicate`, `link-self`, `link-missing-city`, `link-one-way` | `name`, `cityId` |
| `network-split` | `name`, `id` |
| `terrain-open` | `count` |
| `terrain-degenerate` | `count`, `minimum` |
| `terrain-out-of-canvas` | `outsideCount` (밖 점 수), `firstPointIndex` (첫 밖 점의 0부터 센 번호) |
| `scenario-invalid` | `key` |
| `scenario-map-missing` | `mapKey` (미지정이면 키 생략) |
| `scenario-map-unpublished` | `mapKey` |
| `scenario-map-invalid`, `unitset-wall-missing` | 없음 |
| `scenario-nation-city-missing`, `scenario-general-city-missing` | `name`, `city` |
| `scenario-city-owner-duplicate` | `city`, `firstIndex` |
| `scenario-general-nation-missing` | `name`, `nationId` |
| `scenario-general-years` | `name`, `birthYear`, `deathYear` |
| `scenario-diplomacy-invalid` | `nationA`, `nationB` |
| `scenario-diplomacy-duplicate` | `nationA`, `nationB`, `firstIndex` |
| `unitset-arm-key-invalid` | `key` |
| `unitset-crew-id-duplicate` | `id`, `firstIndex` |
| `unitset-crew-arm-missing` | `name`, `armType` |
| `unitset-coef-arm-missing` | `name`, `field`, `key` |
| `unitset-default-missing`, `unitset-default-not-recruitable` | `id` |
| `stat-rules-inconsistent` | `total`, `min`, `max` |
| `portrait-id-duplicate` | `id`, `firstName` |

- 도시 ID·이름 중복, 없는 도시·단방향·자기 자신 연결, 초기값의 최대치 초과를 거부합니다.
- 없는 국가 도시·수도, 도시 소유 중복, 장수의 잘못된 국가·도시, 외교의 없는 국가·동일 국가 쌍을 거부합니다.
- 기본 병종이 없거나 병종 ID가 중복되면 거부합니다.
- 엔진이 월드·국가·도시·장수·외교를 한 트랜잭션으로 저장합니다. 국가↔수도 참조는 도시 생성 뒤 연결하며
  중간 실패는 전체를 롤백합니다. 모든 관계는 `worldId`를 포함하는 외래키로 격리합니다.
- 단위 테스트는 `tools/world-bootstrap.test.ts`, 실제 DB 검증은 `apps/engine/src/world/createWorld.integration.test.ts`입니다.

### 편집 자원 검증 (T4-76)

`@opensamguk/rules/resource-validation`은 파일이나 DB를 읽지 않고 지도·시나리오·병종·능력치·초상을 검사합니다. `version`이 없는 지도는 기존 v1 schema로 읽고 `version: 2`는 캔버스와 표시용 지형을 포함한 엄격한 형식으로 읽습니다. `normalizeMapToV2`는 입력을 복제하고 버린 칸의 경로를 돌려줍니다. v1의 유한수 `trade`·`frontState`와 출처 `$comment`는 보존합니다.

보고의 `status`는 `pass`·`fail`·`incomplete`입니다. 오류가 있으면 `fail`, 참조 검사에 필요한 맥락이 빠지거나 깨졌으면 `incomplete`입니다. 경고만 있으면 통과할 수 있습니다. 지도에는 관련 시나리오 전체를 `scenarios`로 넘기며 참조 대상이 없을 때는 `[]`를 명시합니다. 한도·진단 코드·검사 순서와 호출자 책임은 [T4-76 계약](../plans/T4-76.md#계약)에 있습니다.

기존 `buildInitialWorld`의 schema와 거부 검사는 그대로입니다. 새 검증기는 아직 엔진 로더나 게시 API에 연결하지 않았습니다. v2의 캔버스·지형은 `WorldInit`에 들어가지 않고 이동·전투·해시 계산도 바꾸지 않습니다. 내장 v1 지도와 정규화한 v2 지도에 표시 지형을 더해도 같은 초기 상태와 해시가 나오는지 시험합니다.

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
