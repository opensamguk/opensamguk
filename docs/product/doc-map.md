# core2026 문서 대응표

> 상태: v0.1 (2026-10-20) · 기준: core2026 `df6c926` (2026-09-29)의 `docs/` 마크다운 53개

core2026의 문서를 하나씩 보고, 이 프로젝트에서 어떻게 할지 정했습니다.

- **채택:** 같은 역할의 문서를 둡니다. 내용은 우리 구조에 맞게 새로 씁니다.
- **통합:** 다른 문서의 한 절로 합칩니다.
- **보류:** 지금은 만들지 않고 적힌 시점에 만듭니다.
- **제외:** 우리에게 필요 없습니다. 이유를 적습니다.

결과: 채택 24 · 통합 14 · 보류 7 · 제외 8 (합계 53). 지금 만든 문서는 뼈대이며 "필요 시점" 관문 전에 채웁니다.

## architecture/ (17개)

| core2026                                    | 처리 | 우리 문서                                  | 필요 시점 | 메모 |
| ------------------------------------------- | ---- | ------------------------------------------ | --------- | ---- |
| overview.md                                 | 채택 | [architecture/overview.md](../architecture/overview.md) | M1 | Gateway orchestrator 없이 단순화 |
| runtime.md                                  | 채택 | [architecture/runtime.md](../architecture/runtime.md) | M1 | 프로세스·환경변수·배포 단위 |
| package-boundaries.md                       | 채택 | [architecture/package-boundaries.md](../architecture/package-boundaries.md) | M1 | 의존 방향은 지금 확정 |
| action-module-protocol.md                   | 통합 | [architecture/command-protocol.md](../architecture/command-protocol.md) | M1 | 특기·장비 fold는 Phase 2 |
| scenario-composition.md                     | 채택 | [architecture/scenario-composition.md](../architecture/scenario-composition.md) | M1 | |
| game-clock.md                               | 채택 | [architecture/game-clock.md](../architecture/game-clock.md) | M1 | |
| time-domains.md                             | 통합 | architecture/game-clock.md §시간 종류       | M1 | |
| game-clock-reconciliation.md                | 통합 | architecture/game-clock.md §일시정지·재개   | M1 | |
| api-input-event-replay.md                   | 통합 | developer/request-turn-persistence.md §재시도 | M1 | |
| realtime-change-journal.md                  | 채택 | [architecture/realtime.md](../architecture/realtime.md) | M2 | revision 기반 조회는 단순화 |
| battle-simulator-browser-worker.md          | 보류 | —                                          | Phase 2 | 전투 시뮬레이터와 함께 |
| npc-lifecycle-memory-profile.md             | 보류 | architecture/performance.md (예정)         | M3 전 | 부하 기준 정할 때 |
| npc-unification-timing-benchmark.md         | 통합 | testing-policy.md §시뮬레이션              | M1 | AC-M1-17·18의 기준 근거 |
| turn-state-differential-testing.md          | 제외 | —                                          | — | 원작과 1:1 비교를 하지 않음 (D-001) |
| game-api-daemon-procedure-inventory.md      | 제외 | —                                          | — | 기존 코드 리팩터링 점검 자료 |
| game-api-direct-mutation-journal-inventory.md | 제외 | —                                        | — | 기존 코드 리팩터링 점검 자료 |
| typescript-version.md                       | 제외 | —                                          | — | TypeScript 버전 하나만 씀 |

## developer/ (7개)

| core2026                     | 처리 | 우리 문서                                    | 필요 시점 | 메모 |
| ---------------------------- | ---- | -------------------------------------------- | --------- | ---- |
| index.md                     | 채택 | [developer/index.md](../developer/index.md)  | M1 | |
| code-map.md                  | 채택 | [developer/code-map.md](../developer/code-map.md) | M1 | 코드가 생기면 채움 |
| request-turn-persistence.md  | 채택 | [developer/request-turn-persistence.md](../developer/request-turn-persistence.md) | M1 | |
| domain-and-classes.md        | 통합 | architecture/command-protocol.md, developer/code-map.md | M1 | |
| game-clock-recovery.md       | 통합 | release-operations.md §장애 대응             | M2 | |
| first-steps.md               | 보류 | developer/first-steps.md (예정)              | M2 | 코드가 안정된 뒤 |
| system-walkthrough.md        | 보류 | developer/system-walkthrough.md (예정)       | M2 | 코드가 안정된 뒤 |

## user/ (11개)

원작과 규칙이 다르므로 내용은 새로 씁니다. 원작 문서의 구성과 "처음 온 사람의 언어"만 따릅니다.

| core2026                     | 처리 | 우리 문서                                     | 필요 시점 |
| ---------------------------- | ---- | --------------------------------------------- | --------- |
| index.md                     | 채택 | [user/index.md](../user/index.md)             | M2 |
| general-and-city.md          | 채택 | [user/general-and-city.md](../user/general-and-city.md) | M2 |
| time-and-turns.md            | 채택 | [user/time-and-turns.md](../user/time-and-turns.md) | M2 |
| war-and-orders.md            | 채택 | [user/war-and-orders.md](../user/war-and-orders.md) | M2 |
| map-and-supply.md            | 채택 | [user/map-and-supply.md](../user/map-and-supply.md) | M2 |
| economy-and-diplomacy.md     | 채택 | [user/economy-and-diplomacy.md](../user/economy-and-diplomacy.md) | M2 |
| nation-and-features.md       | 채택 | [user/nation-and-features.md](../user/nation-and-features.md) | M2 |
| glossary.md                  | 채택 | [user/glossary.md](../user/glossary.md)       | M2 |
| commands-and-timing.md       | 채택 | [user/commands-and-timing.md](../user/commands-and-timing.md) | M2 |
| command-catalog.generated.md | 채택 | user/command-catalog.generated.md (코드에서 생성) | M2 |
| sources.md                   | 제외 | —                                             | — |

`sources.md`는 원작 게시판 글을 근거로 다는 문서입니다. 새 게임에는 그 근거가 없습니다.

## design/ (2개)

| core2026                 | 처리 | 우리 문서                                   | 필요 시점 | 메모 |
| ------------------------ | ---- | ------------------------------------------- | --------- | ---- |
| play-audit.md            | 통합 | admin-console.md §부정 플레이 조사          | M3 | AC-M3-05 범위만 |
| city-office-requests.md  | 보류 | —                                           | Phase 2 | 원작 세부 규칙 |

기능 설계 문서의 틀은 [design/README.md](../design/README.md)에 새로 만들었습니다.

## 루트 문서 (16개)

| core2026                      | 처리 | 우리 문서                                        | 필요 시점 | 메모 |
| ----------------------------- | ---- | ------------------------------------------------ | --------- | ---- |
| index.md                      | 채택 | [docs/index.md](../index.md)                     | 지금 | 문서 지도 |
| testing-policy.md             | 채택 | [testing-policy.md](../testing-policy.md)        | M1 | |
| integration-tests.md          | 통합 | testing-policy.md §통합 테스트                   | M1 | |
| numeric-state-policy.md       | 채택 | [numeric-state-policy.md](../numeric-state-policy.md) | M1 | 결정성과 직결 |
| frontend-css-architecture.md  | 통합 | [frontend-ui-guidelines.md](../frontend-ui-guidelines.md) | M1 | |
| frontend-typography.md        | 통합 | frontend-ui-guidelines.md §글자                  | M1 | |
| frontend-page-navigation.md   | 통합 | frontend-ui-guidelines.md §화면 이동             | M1 | |
| release-operations.md         | 채택 | [release-operations.md](../release-operations.md) | M2 | 서버 1대 기준으로 단순화 |
| e2e-caddy-routing.md          | 통합 | release-operations.md §프록시 경로               | M2 | |
| admin-console.md              | 채택 | [admin-console.md](../admin-console.md)          | M3 | |
| play-audit-operations.md      | 통합 | admin-console.md §부정 플레이 조사               | M3 | |
| runtime-navigation.md         | 보류 | —                                                | M3 이후 | 메뉴를 설정 파일로 바꾸는 기능 |
| frontend-typography-audit.md  | 보류 | —                                                | M3 | 반응형 검사(AC-M3-08)와 함께 필요하면 |
| frontend-legacy-parity.md     | 제외 | —                                                | — | 원작 화면과 비교하지 않음 (D-001) |
| e2e-orchestrator-tests.md     | 제외 | —                                                | — | orchestrator를 만들지 않음 (D-006) |
| legacy-db-migration.md        | 제외 | —                                                | — | 이관할 데이터가 없음 |

## core2026에 없는 새 문서

| 문서 | 왜 필요한가 |
| ---- | ----------- |
| [product/](./README.md) 전체 | 요구사항·PRD·인수조건·단계·결정·백로그. 지난번에 없던 "끝의 기준" |
| [image-assets.md](../image-assets.md) | 초상 ID 규칙과 공개 전 라이선스 관문 (D-004) |
| [design/README.md](../design/README.md) | 차별화 기능 설계 문서의 틀 |
| [AGENTS.md](../../AGENTS.md) | AI·개발 작업 규칙. core2026 AGENTS.md를 범위 관리 중심으로 다시 씀 |

## 세어 본 결과

| 폴더         | 채택 | 통합 | 보류 | 제외 | 합계 |
| ------------ | ---- | ---- | ---- | ---- | ---- |
| architecture | 6    | 5    | 2    | 4    | 17   |
| developer    | 3    | 2    | 2    | 0    | 7    |
| user         | 10   | 0    | 0    | 1    | 11   |
| design       | 0    | 1    | 1    | 0    | 2    |
| 루트         | 5    | 6    | 2    | 3    | 16   |
| **합계**     | 24   | 14   | 7    | 8    | 53   |
