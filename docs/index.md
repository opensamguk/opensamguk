# opensamguk 문서 지도

**이 지도에 없는 문서는 만들지 않습니다** ([AGENTS.md §4](../AGENTS.md#4-문서는-적게-지도에-올린다)).
새 문서가 필요하면 먼저 여기에 한 줄을 추가합니다.

상태: **초안**은 내용이 있음, **뼈대**는 목차와 할 일만 있음, **예정**은 아직 파일 없음

## 독자별 시작점

- 지금 무엇을 하는지 알고 싶다면 → [인수조건](./product/acceptance-criteria.md)
- 게임을 처음 하는 플레이어 → [플레이어 가이드](./user/index.md) (M2에 작성)
- 코드를 처음 보는 개발자 → [개발자 핸드북](./developer/index.md)
- 운영자 → [릴리스 운영](./release-operations.md), [관리자 콘솔](./admin-console.md)

## product/ 무엇을 왜 언제까지

| 문서                                           | 상태 | 필요 시점 |
| ---------------------------------------------- | ---- | --------- |
| [안내](./product/README.md)                    | 초안 | 지금 |
| [PRD](./product/prd.md)                        | 초안 | 지금 |
| [요구사항](./product/requirements.md)          | 초안 | 지금 |
| [인수조건](./product/acceptance-criteria.md)   | 초안 | 지금 |
| [단계 계획](./product/phases.md)               | 초안 | 지금 |
| [데이터 모델](./product/data-model.md)         | 초안 | 지금 |
| [차별화 기능 후보](./product/differentiation.md) | 초안 | 지금 |
| [아이디어 수집](./product/idea-harvest.md)     | 초안 | 지금 |
| [결정 기록](./product/decisions.md)            | 초안 | 상시 |
| [백로그](./product/backlog.md)                 | 초안 | 상시 |
| [core2026 문서 대응표](./product/doc-map.md)   | 초안 | 지금 |

## plans/ 작업 계획 (계획 → 구현 → 리뷰 기록)

| 문서                                   | 상태 | 필요 시점 |
| -------------------------------------- | ---- | --------- |
| [작업 계획 틀과 규칙](./plans/README.md) | 초안 | 지금 |
| [T1-01 저장소 뼈대](./plans/T1-01.md), [T1-02 로컬 실행](./plans/T1-02.md) | 완료 | 지금 |
| M1 작업 계획 [T1-03](./plans/T1-03.md) ~ [T1-17](./plans/T1-17.md), [T1-19](./plans/T1-19.md), [T1-20](./plans/T1-20.md) ~ [T1-25](./plans/T1-25.md) | 계획 완료 | 지금 |
| 참가 시험 계획 [T2-18 독립 에이전트 참가 시험](./plans/T2-18.md), [T3-15 오픈 리허설과 공개](./plans/T3-15.md) (D-021) | 계획 완료 | M2·M3 |
| M2 작업 계획 [T2-01](./plans/T2-01.md) ~ [T2-17](./plans/T2-17.md), [T2-20](./plans/T2-20.md) ~ [T2-23](./plans/T2-23.md) | 계획 완료 | M2 |
| [T3-04 요청 제한·CSRF·권한 대조](./plans/T3-04.md) | 현재 API 선행 구현 리뷰 | M3 전 |
| 나머지 M3 작업 계획                    | 예정 | M3 전 |

## architecture/ 무엇이 어디서 실행되나

| 문서                                                     | 상태 | 필요 시점 |
| -------------------------------------------------------- | ---- | --------- |
| [아키텍처 개요](./architecture/overview.md)              | 초안 | M1 |
| [런타임](./architecture/runtime.md)                      | 뼈대 | M1 |
| [패키지 경계](./architecture/package-boundaries.md)      | 초안 | M1 |
| [게임 시계](./architecture/game-clock.md)                | 뼈대 | M1 |
| [시나리오 합성](./architecture/scenario-composition.md)  | 뼈대 | M1 |
| [명령 프로토콜](./architecture/command-protocol.md)      | 뼈대 | M1 |
| [실시간 갱신](./architecture/realtime.md)                | 뼈대 | M2 |
| 성능 기준 (performance.md)                               | 예정 | M3 전 |

## resources/ 원본 출처

| 문서 | 상태 | 필요 시점 |
| ---- | ---- | --------- |
| [리소스 출처와 MIT 고지](../resources/NOTICE.md) | 초안 | M1 |

## developer/ 어디를 고치나

| 문서                                                          | 상태 | 필요 시점 |
| ------------------------------------------------------------- | ---- | --------- |
| [개발자 핸드북](./developer/index.md)                         | 뼈대 | M1 |
| [파일 지도](./developer/code-map.md)                          | 뼈대 | M1 |
| [요청·턴·저장 흐름](./developer/request-turn-persistence.md)  | 뼈대 | M1 |
| 처음 읽는 사람을 위한 구조 안내 (first-steps.md)              | 예정 | M2 |
| 경험자를 위한 시스템 읽기 (system-walkthrough.md)             | 예정 | M2 |

## user/ 플레이어 가이드

| 문서                                                     | 상태 | 필요 시점 |
| -------------------------------------------------------- | ---- | --------- |
| [시작하기](./user/index.md)                              | 뼈대 | M2 |
| [장수와 도시, 내정](./user/general-and-city.md)          | 뼈대 | M2 |
| [시간과 턴](./user/time-and-turns.md)                    | 뼈대 | M2 |
| [전쟁과 예턴 조합](./user/war-and-orders.md)             | 뼈대 | M2 |
| [지도와 보급](./user/map-and-supply.md)                  | 뼈대 | M2 |
| [국가 재정과 외교](./user/economy-and-diplomacy.md)      | 뼈대 | M2 |
| [국가 운영과 주요 기능](./user/nation-and-features.md)   | 뼈대 | M2 |
| [용어 사전](./user/glossary.md)                          | 뼈대 | M2 |
| [명령과 실행 시기](./user/commands-and-timing.md)        | 뼈대 | M2 |
| 명령 전체 목록 (command-catalog.generated.md, 코드에서 생성) | 예정 | M2 |

## design/ 기능 설계

| 문서                                   | 상태 | 필요 시점 |
| -------------------------------------- | ---- | --------- |
| [설계 문서 틀](./design/README.md)     | 초안 | 차별화 기능 착수 전 |
| [화면 레퍼런스](./design/references/README.md) | 확정 (A10 확인 완료) | 지금 |

## 운영·품질

| 문서                                               | 상태 | 필요 시점 |
| -------------------------------------------------- | ---- | --------- |
| [테스트 정책](./testing-policy.md)                 | 뼈대 | M1 |
| [수치 상태 정책](./numeric-state-policy.md)        | 뼈대 | M1 |
| [UI 지침](./frontend-ui-guidelines.md)             | 초안 | M1 |
| [글쓰기 규칙](./writing-style.md)                  | 초안 | 지금 |
| [이미지 자산](./image-assets.md)                   | 초안 | M1 |
| [릴리스 운영](./release-operations.md)             | 뼈대 | M2 |
| [관리자 콘솔](./admin-console.md)                  | 뼈대 | M3 |
