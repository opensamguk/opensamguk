# opensamguk 문서 지도

**이 지도에 없는 문서는 만들지 않습니다** ([AGENTS.md §4](../AGENTS.md#4-문서는-적게-지도에-올린다)).
새 문서가 필요하면 먼저 여기에 한 줄을 추가합니다.

상태: **초안**은 내용이 있음, **뼈대**는 목차와 할 일만 있음, **예정**은 아직 파일 없음

## 독자별 시작점

- 지금 무엇을 하는지 알고 싶다면 → [인수조건](./product/acceptance-criteria.md)
- 게임을 처음 하는 플레이어 → [플레이어 가이드](./user/index.md) (초안, 게임 안에서는 `/help`)
- 코드를 처음 보는 개발자 → [개발자 핸드북](./developer/index.md)
- 운영자 → [릴리스 운영](./release-operations.md), [관리자 콘솔](./admin-console.md)

## product/ 무엇을 왜 언제까지

| 문서                                           | 상태 | 필요 시점 |
| ---------------------------------------------- | ---- | --------- |
| [안내](./product/README.md)                    | 초안 | 지금 |
| [PRD](./product/prd.md)                        | 초안 | 지금 |
| [요구사항](./product/requirements.md)          | 초안 | 지금 |
| [인수조건](./product/acceptance-criteria.md)   | 초안 | 지금 |
| [명령 대응표](./product/command-coverage.json) (D-022, AC-M1-14). 원작 90개 대조와 명령별 11단계 증거. 대조 기준(원본 ID 전집·승인된 추가와 대체·verified 검증 기록)은 [대응표 고정 기준](./product/command-coverage-baseline.json)에 따로 둔다. 검사는 `node tools/command-coverage.mjs`, 제품 전체 완료는 `--require-complete`, 커밋·시험 파일 확인은 `--verify-git`, 실행 결과 원격 확인은 `--verify-ci` | 정본 | 지금 |
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
| M1 데모 계획 [T1-18 독립 에이전트 완주 데모](./plans/T1-18.md), [T1-26 같은 판 가속·기수 종료](./plans/T1-26.md), [T1-27 기수 종료 화면](./plans/T1-27.md) | 계획 완료 (D-024) | 지금 |
| 참가 시험 계획 [T2-18 독립 에이전트 참가 시험](./plans/T2-18.md), [T3-15 오픈 리허설과 공개](./plans/T3-15.md) (D-021) | 계획 완료 | M2·M3 |
| M2 작업 계획 [T2-01](./plans/T2-01.md) ~ [T2-17](./plans/T2-17.md), [T2-20](./plans/T2-20.md) ~ [T2-25](./plans/T2-25.md) | 계획 완료 | M2 |
| M3 작업 계획 [T3-07](./plans/T3-07.md) ~ [T3-09](./plans/T3-09.md), [T3-16](./plans/T3-16.md) | 계획 완료 | M3 |
| [T4-01 `pnpm next`의 Phase 2 절 분리](./plans/T4-01.md) (AC-M1-14 후속 제안, 도구 수정 전, 기술 검토 전) | 제안 | MVP·Phase 2 |
| [T3-04 요청 제한·CSRF·권한 대조](./plans/T3-04.md) | 현재 API 선행 구현 리뷰 | M3 전 |
| [T4-02 확장 명령 resolver·`ext` 순수 경로 상세 계획](./plans/T4-02.md), [누락 명령 19개(T4-57~T4-75)·미해결 원본 3개 실행 단위](./plans/mvp-command-gaps.md) (AC-M1-14 후속 제안, 원고 `391432c` 기술계약 검토 통과, 사용자 승인·구현 허가 별도) | 제안 | MVP |
| M3 작업 계획 [T3-02](./plans/T3-02.md), [T3-03](./plans/T3-03.md), [T3-13](./plans/T3-13.md) | 초안 | M3 전 |
| M3 작업 계획 [T3-10 반응형 375px](./plans/T3-10.md) | 계획 완료 (사용자 검토 대기) | M2 완료 뒤 |
| M3 작업 계획 [T3-05](./plans/T3-05.md), [T3-06](./plans/T3-06.md), [T3-11](./plans/T3-11.md), [T3-14](./plans/T3-14.md) | 계획 완료 | M3 |
| 나머지 M3 작업 계획                    | 예정 | M3 전 |
| [Phase 2 확장 기술 명세](./plans/phase2-expansion.md) (AC-P2·T4 제안) | 초안 | Phase 2 |
| [T4-56 멸망 국가 이름·색 보존](./plans/T4-56.md) (과거 국가 표시값의 저장·조회. PR 1 저장 구현, 독립 리뷰와 정확 SHA CI 전) | 구현 | Phase 2 |
| [초기화 자원 DB 이전·자원 편집기·도트 바탕 지도](./plans/map-editor.md) (D-028, T4-76~T4-87) | 초안 | Phase 2 |
| [T4-80 지도 편집 캔버스](./plans/T4-80.md) (AC-P2-27 일부, 서버 없는 편집·검증·v2와 밑그림 내보내기) | 구현 중 | Phase 2 |
| [T4-34 전투 시뮬레이터 화면](./plans/T4-34.md) (AC-P2-16 (가), D-023. PR #132로 main `494272b` 병합. AC-P2-16 (나)는 남음) | 구현 병합 | Phase 2 |
| [T4-30 토너먼트 대진 틀](./plans/T4-30.md), [T4-35 월간 영토 스냅샷 조회 API](./plans/T4-35.md) (AC-P2-15 (가), AC-P2-17 1차 API. Codex 계획 기술 검토 수용, 정본 한정 반영은 통합 커밋 전, 로컬 구현 WIP) | 계획 검토 수용 | Phase 2 |
| [T4-18 효과 합산 틀](./plans/T4-18.md) (AC-P2-12·13 순수 공통 기반 몫. Codex 계획 기술 검토 수용, D-027 한정 반영은 통합 커밋 전) | 계획 검토 수용 | Phase 2 |

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
| [시작하기](./user/index.md)                              | 초안 (T2-17, 리뷰 전) | M2 |
| [장수와 도시, 내정](./user/general-and-city.md)          | 초안 (T2-17, 리뷰 전) | M2 |
| [시간과 턴](./user/time-and-turns.md)                    | 초안 (T2-17, 리뷰 전) | M2 |
| [전쟁과 예턴 조합](./user/war-and-orders.md)             | 초안 (T2-17, 리뷰 전) | M2 |
| [지도와 보급](./user/map-and-supply.md)                  | 초안 (T2-17, 리뷰 전) | M2 |
| [국가 재정과 외교](./user/economy-and-diplomacy.md)      | 초안 (T2-17, 리뷰 전) | M2 |
| [국가 운영과 주요 기능](./user/nation-and-features.md)   | 초안 (T2-17, 리뷰 전) | M2 |
| [용어 사전](./user/glossary.md)                          | 초안 (T2-17, 리뷰 전) | M2 |
| [명령과 실행 시기](./user/commands-and-timing.md)        | 초안 (T2-17, 리뷰 전) | M2 |
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
