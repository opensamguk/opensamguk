# 시나리오 합성

> 상태: T1-03 구현 · 관련 AC: M1-03, M2-03 · 출처: [리소스 고지](../../resources/NOTICE.md)
> 이 문서가 답할 질문: 월드 하나를 만들 때 어떤 파일들을 어떻게 합쳐 초기 상태를 만드나?

## 1. 재료

| 재료     | 파일                              | 출처 |
| -------- | --------------------------------- | ---- |
| 지도     | `resources/map/che.json`          | core2026 `map_che.json` (도시 94개) ⚠️ A5 |
| 시나리오 | `resources/scenario/1030.json`    | core2026 「군웅할거(191)」 ⚠️ A6 |
| 병종     | `resources/unitset/basic.json`    | core2026 `unitset_basic.json` 참고 ⚠️ A7 |
| 능력치   | `resources/scenario/default.json` | 합계 165, 최소 15, 최대 80 |
| 프리셋   | `resources/preset/*.json` (M2)    | 새로 작성 (D5) |

core2026 파일을 옮길 때 출처(MIT, © 2025 devsam)를 남깁니다.

## 2. 합성 순서

```text
프리셋 ─▶ (어떤 시나리오·지도·병종·명령 세트·턴 간격을 쓸지)
   └─▶ 시나리오 + 지도 + 병종 ─▶ zod 검증 ─▶ 시드 고정 초기화 ─▶ 월드 초기 상태
```

`apps/engine/src/world/resources.ts`만 파일을 읽고, `packages/rules/src/world/resources.ts`가 zod로 검증합니다.
순수 함수 `buildInitialWorld()`가 국가·도시·장수·외교 상태를 만듭니다. 도시 ID는 지도 것을 쓰고 국가·장수 ID는 원본 배열 순서 + 1입니다.
DB의 ID는 모두 월드 안에서만 유일합니다.

- 도시 소유는 국가의 도시 목록, 수도는 그 목록의 첫 도시입니다. 지도 초기값·최대치와 기본 민심 50을 보존합니다.
- 도시가 없는 장수는 `rngFor(seed, 'bootstrap')`로 소속 국가 도시에서 고릅니다. 재야면 전체 도시에서 고릅니다.
- 원본 `officerLevel` 0~12를 그대로 보존하고, `activeFromYear = birthYear + 15`를 저장합니다.
- 외교는 국가 ID를 작은 순서로 정규화하고 마지막 줄을 적용합니다. 원본 8줄 중 중복 1개를 합쳐 7쌍입니다.
  기간은 1개월 = 10,000 tick으로 바꿉니다 (T1-04의 시계 단위).
- 원작의 `general_ex`, `history`, `extends`와 대사는 사용하지 않습니다. 특기·성격은 문자열만 저장하며,
  병종은 성벽·보병·궁병·기병 4종으로 줄였습니다. 초상 경로는 무시하고 `portraitId = null`입니다.

초기 금·쌀은 장수당 1,000, 병력·훈련·사기·경험·공헌·부상·다음 턴 tick은 0입니다.
턴 시각 분산은 T1-06에서 추가합니다.

`hashState()`는 키를 정렬한 JSON의 SHA-256입니다. 월드 ID·이름·생성 시각·운영 설정을 제외한 `WorldInit`을 해시합니다.
Node `crypto` 구현은 `@opensamguk/shared/node`에 분리하며 rules·브라우저 공용 진입점으로 내보내지 않습니다.
같은 리소스와 시드면 같은 해시이고, DB에 저장한 상태를 다시 적재한 해시도 같습니다.

## 3. 검증

- 도시 ID·이름 중복, 없는 도시·단방향·자기 자신 연결, 초기값의 최대치 초과를 거부합니다.
- 없는 국가 도시·수도, 도시 소유 중복, 장수의 잘못된 국가·도시, 외교의 없는 국가·동일 국가 쌍을 거부합니다.
- 기본 병종이 없거나 병종 ID가 중복되면 거부합니다.
- 엔진이 월드·국가·도시·장수·외교를 한 트랜잭션으로 저장합니다. 국가↔수도 참조는 도시 생성 뒤 연결하며,
  중간 실패는 전체를 롤백합니다. 모든 관계는 `worldId`를 포함하는 외래키로 격리합니다.
- 단위 테스트는 `tools/world-bootstrap.test.ts`, 실제 DB 검증은 `apps/engine/src/world/createWorld.integration.test.ts`입니다.

## 4. 프리셋 형식 (M2)

<!-- TODO(M2): 정규·속성·초보·하드코어 예시. 턴 간격, 시작 조건, 명령 세트, NPC 비율, 초보 보호 기간. -->
