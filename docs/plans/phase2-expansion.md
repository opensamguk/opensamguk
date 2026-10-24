# Phase 2 확장 기술 명세 (제안)

> 상태: 제안 초안 (2026-10-21) · 1차 기술 검토 R67-1~9 반영 · 재검토 R67-8-R 반영 · main `2380904` 병합과 경로 재확인 · 2026-10-22 D-022 명령 범위 정정 반영 · 2026-10-22 누락 명령 19행(T4-57~T4-75)·대응표 `queueIds`·C14 버전 문구 편입 · 2026-10-23 D-027 한정 채택 반영 · 같은 날 T4-56 (가)·T4-36·T4-05 후속 채택 반영 · 계획: Claude · 기술 검토: Codex
> 근거: [단계 계획 Phase 2](../product/phases.md#phase-2-확장-mvp-뒤), [백로그](../product/backlog.md), [차별화 기능 후보](../product/differentiation.md), [요구사항 §4](../product/requirements.md#4-범위-밖), [PRD §6.3](../product/prd.md)
> 이 문서의 AC-P2와 T4 작업은 **제안**이다. 예외는 D-023·D-027으로 정식 반영된 몫이다. AC-P2-16은 2026-10-22 [D-023](../product/decisions.md#d-023-ac-p2-16을-인수조건에-올리고-수동-1회-계산-몫만-계약으로-채택한다-2026-10-22)으로 [인수조건](../product/acceptance-criteria.md#p2)에 정식 반영됐다. 2026-10-23 [D-027](../product/decisions.md#d-027-사용자-맥북에서-phase-2를-재개하고-t4-네-작업과-u-01을-한정-채택한다-2026-10-23)으로 AC-P2-01, AC-P2-02 (가), AC-P2-12·13 (가), AC-P2-15 (가), AC-P2-17 (가)와 T4-01·02·18·30·35가 더해졌다. 같은 D-027 후속으로 AC-P2-17 (나)·(다)와 T4-36, T4-56 (가), AC-P2-03 (가)와 T4-05가 더해졌다. 다른 AC-P2와 T4 행은 인수조건·단계 계획에 아직 들어가지 않았다.

## 1. 이 문서의 위치

Phase 2는 M2가 아니다. M2는 지인 테스트 관문(MVP의 일부)이고 Phase 2는 MVP 위에 덧대는 확장이다. 그래서 다음을 지킨다.

- main에 이미 있는 엔진, 명령 37개, 월간 정산, 재생, 순위는 Phase 2의 바탕이다. Phase 2 성과로 세지 않는다.
- M1·M2·M3 AC는 Phase 2 완료 근거가 될 수 없다. 명령이 아닌 기능의 AC-P2는 MVP 관문에 들어가지 않는다.
- 2026-10-22 소유자 정정([D-022](../product/decisions.md#d-022-mvp-완료에는-모든-명령이-들어간다-2026-10-22))으로 명령에 딸린 작업은 MVP 필수다. §6 상태 칸에 `MVP 필수 (D-022)`로 표시했다. T4·AC-P2 ID는 추적 ID로 그대로 두고 M4 관문을 만들지 않는다. 명령의 완료 판정은 AC-M1-14와 [명령 대응표](../product/command-coverage.json)가 하고 이 문서의 AC-P2 증거는 대응표 단계 증거로 쓴다. D-022는 이 문서의 계약(C1~C20), 미결정(§9), 승인 항목(§8)의 세부 정책을 승인하지 않는다. A-02·A-03·A-04의 명령은 MVP 범위에 들어왔으나 작업 분해는 아직 없다고 PR #67 대응표의 `blockers`에 적혀 있다. 그 19개는 [누락 명령 문서](./mvp-command-gaps.md)의 검토를 거쳐 §6 끝의 T4-57~T4-75로 하나씩 나눴고 대응표 `queueIds`에 같은 ID를 더했다. 미해결 원본 3개(`general:che_NPC능동`, `general:cr_건국`, `general:che_무작위건국`)는 작업 분해 없이 분모 91에 그대로 남는다.
- M2가 요구하는 두 번째 시나리오(PRD §6.4의 공백지 180년, AC-M2-01)는 M2 범위다. 아래 시나리오 추가(AC-P2-24)에서 세지 않는다.
- 계획 작성과 Codex 기술 검토는 구현 완료나 세부 정책 승인이 아니다. 세부 정책은 §9의 결정 목록으로 따로 받는다.
- 작업의 준비 정도는 §6.1의 세 단계로만 말한다. 구현 준비에 이른 T4 작업은 T4-34와 D-027으로 채택한 T4-01·T4-02(규칙 몫)·T4-18·T4-30·T4-35, 그 후속의 T4-36·T4-56 (가)·T4-05다. 이 문서의 계약(C1~C20)도 제안이며 기술 검토가 새 API·DB 계약을 수용한 것이 아니다.

정식 반영은 원 소유자 문서 통합 카드(t_b4277a9e)가 끝난 뒤 별도 PR에서 한정 hunk로 한다. 그때 [단계 계획](../product/phases.md)에 Phase 2 대기열 표, [인수조건](../product/acceptance-criteria.md)에 Phase 2 절, [결정 기록](../product/decisions.md)에 이 분해를 채택하는 결정 한 건을 넣는다. 그 전에는 phases.md에 T4 행을 넣지 않는다 (§3). 2026-10-23 D-027은 이 중 네 작업과 후속 작업만 한정 반영했고 phases.md의 T4 행은 T4-01 도구와 함께 통합한다.

기존 T1~T3 계획, 코드, schema, 패키지는 이 문서에서 고치지 않는다.

## 2. 범위 대조

[단계 계획 Phase 2](../product/phases.md#phase-2-확장-mvp-뒤)의 묶음을 빠짐없이 옮겼다. 원작 근거는 공개 저장소 core2026 고정 커밋 `df6c926`(MIT)의 경로다. 비공개 v1 자료는 쓰지 않았다.

| 묶음 | phases.md 원문 | 원작 공개 근거 (`df6c926`) | AC | 작업 |
| ---- | -------------- | -------------------------- | -- | ---- |
| 명령 틀 | (모든 명령 확장의 공통 바탕) | `resources/turn-commands/default.json` | AC-P2-02 | T4-02~T4-04, T4-17, T4-49~T4-51 |
| 계략 4종 | 계략 | `actions/turn/general/che_화계`·`che_파괴`·`che_선동`·`che_탈취` | AC-P2-03 | T4-05 |
| 전략 명령 8종 | 전략 명령 | `actions/turn/nation/che_백성동원`·`che_이호경식`·`che_급습`(준비 턴 0), `che_필사즉생`·`che_수몰`·`che_의병모집`(2), `che_허보`·`che_피장파장`(1) | AC-P2-04, AC-P2-05 | T4-06~T4-08, T4-53 |
| 특수 병종 연구 9종 | 특수 병종 연구 | `actions/turn/nation/event_극병연구` 등 9개, `eventResearch.ts`(준비 턴 23), `resources/unitset/unitset_event_more_crewtype.json` | AC-P2-06 | T4-09, T4-10, T4-53 |
| 첩보 | 첩보 | `actions/turn/general/che_첩보` | AC-P2-07 | T4-11~T4-13 |
| 강행·방랑 | 강행·방랑 | `che_강행`(거리 3 이내 이동), `che_방랑` | AC-P2-08 | T4-14, T4-48 |
| 선양·모반·해산 | 선양·모반·해산 | `che_선양`, `che_모반시도`(`constraints/general.ts` allowRebellion), `che_해산` | AC-P2-09 | T4-15, T4-52 |
| 국호·국기 변경 | 국호·국기 변경 | `actions/turn/nation/che_국호변경`·`che_국기변경`(국기 = 국가 색 번호) | AC-P2-10 | T4-16, T4-55 |
| 부대 | 부대(집합) | `che_집합`, `troop/management.ts` | AC-P2-11 | T4-19~T4-21 |
| 장비·아이템 | 장비·아이템 | `items/`, `che_장비매매` | AC-P2-12 | T4-18, T4-22~T4-24 |
| 특기 | 특기 | `actionModules/traits/domestic/`(8종), `war/triggers/` | AC-P2-13 | T4-18, T4-25, T4-26 |
| 경매 | 경매 | `auction/` | AC-P2-14 | T4-27~T4-29 |
| 토너먼트 | 토너먼트 | `tournament/` | AC-P2-15 | T4-30~T4-32, T4-54 |
| 전투 시뮬레이터 | 전투 시뮬레이터 | `battleSimulator/`, `docs/architecture/battle-simulator-browser-worker.md` | AC-P2-16 | T4-33, T4-34 |
| D4 천하 타임랩스 | D4 | (우리 기능) `YearbookSnapshot.data.cities`가 달마다 도시 소유를 이미 저장 | AC-P2-17 | T4-35~T4-37, T4-56 |
| D13 정보의 안개 | D13 | (우리 기능) 첩보와 함께 만든다 | AC-P2-18 | T4-38, T4-39 |
| D18 야간 휴전 | D18 | (우리 기능) myosam 셧다운 시간 턴 동결 | AC-P2-19 | T4-40, T4-41 |
| D7 인물 관계망 | D7 | (우리 기능) 데이터 자리 `GeneralRelation`만 정해 둠 | AC-P2-20 | T4-42 |
| D8 역사 사건 선택지 | D8 | (우리 기능) 원작 `resources/scenario/extensions/events/`는 선택지가 없는 사건표 | AC-P2-21 | T4-43 |
| D9 명성과 계보 | D9 | (우리 기능) 원작 `inheritance/`는 능력 혜택이 있어 그대로 쓰지 않음 | AC-P2-22 | T4-44 |
| D14 계략 패 | D14 | (우리 기능) 계략만 패로 묶음, 명령 전체 카드화 아님 | AC-P2-23 | T4-45 |
| 시나리오 추가 | 시나리오 추가 | `resources/scenario/scenario_1010.json` 등 역사모드 | AC-P2-24 | T4-46 |
| 통합 회귀 | (묶음 전체) | — | AC-P2-25 | T4-47 |

## 3. 대기열과 `pnpm next`

`tools/next-task.mjs`는 `| T숫자-두자리 |` 행을 읽고 앞 숫자를 관문 번호로 쓴다. T4 행을 지금 phases.md에 넣으면 세 가지가 어긋난다.

1. 출력의 계획 절에 `M4 N건`으로 찍혀 Phase 2가 네 번째 관문처럼 보인다.
2. 선행 칸의 `M4`가 T4 전체를 뜻하게 된다.
3. 현재 관문 계산이 M3까지 끝나야 T4를 구현 대상으로 보여 준다. 소유자 지시는 MVP와 Phase 2를 오늘 함께 진행하는 것이라 이 계산과 맞지 않는다.

그래서 T4-01이 먼저 `pnpm next`에 Phase 2 절을 따로 둔다. T4 행은 관문 번호 대신 `Phase 2`로 표시하고 현재 관문(M1~M3) 계산에는 넣지 않으며 선행이 끝난 T4 작업은 담당별로 따로 보여 준다. T4 행의 선행 칸에는 T1~T3 작업 ID를 그대로 쓸 수 있다. M1~M3 대기열만 있는 지금의 phases.md로 돌린 출력은 바이트 단위로 같아야 한다. T4-01이 합쳐진 뒤에 phases.md에 Phase 2 표를 넣는다.

## 4. 공통 계약

담당 프로필: Codex 구현은 `opensamguk-implement`, 그 리뷰는 Claude `opensamguk-review`다. Claude 화면 구현은 `opensamguk-frontend-implement`, 그 리뷰는 Codex `opensamguk-frontend-review`다.

| ID | 계약 | 근거 |
| -- | ---- | ---- |
| C1 | 확장 명령은 `packages/rules/src/commands/ext/<기능>/`에 두고 별도 목록(`extensionCommands`)으로 등록한다. 기존 `commandRegistry`의 37개와 `registry.test.ts` 대조는 바꾸지 않는다. 명령 조회·검사·실행은 모두 C13의 월드별 resolver를 지난다 | AC-M1-14 보존 |
| C2 | 확장 명령은 월드 프리셋(T2-02 `World.preset`)의 `commands.general`·`commands.nation` 허용 목록에 key가 명시될 때만 켜진다. 꺼진 명령은 저장·편집, `turns.precheck`, 실행 검사 모두 `COMMAND_DISABLED`로 실패하고 `commands.list`에 나오지 않는다. [T2-02 계획](./T2-02.md)은 허용 목록이 없으면 전체라고 적었다. 없을 때 기본 목록만 켠다는 이 문서의 해석은 T2-02 담당이 아직 수용하지 않은 제안이다. 관문 G-01이 풀리기 전에는 T4-03을 계약 준비로 올리지 않는다 (이 문서는 T2-02를 고치지 않는다) | T2-02 결정 표 |
| C3 | 확장 상태는 확장을 켠 월드에만 생긴다. 끈 월드의 `WorldState`, `ReplayState`, 월간 해시 입력에는 `ext` 키 자체가 없다. 빈 `ext` 객체를 기존 해시에 넣지 않는다. 끈 월드의 상태 해시, v1 재생 기록, 12개월 재생 결과는 지금과 같다. 켠 월드의 저장·복원·재생 경로는 C14다 | AC-M1-13 |
| C4 | 게임 상태는 엔진만 바꾼다. 턴을 쓰지 않는 즉시 행동(부대 가입·탈퇴, 경매 입찰, 토너먼트 참가)은 API가 `InputEvent`로만 기록하고 엔진이 처리해 재생에 남긴다. 수명 계약은 C15이며 C15가 수용되기 전에는 즉시 행동 API와 그 화면을 계약 준비로 올리지 않는다 | AGENTS §6, D-014 |
| C5 | 한 턴과 한 달의 상태 변경, 새 테이블 행, 로그, 예턴 당김은 지금처럼 리스·월드 행을 잠근 한 트랜잭션에 저장한다. 새 저장마다 commit 직전 실패 롤백과 SIGKILL 재시작 시험을 둔다 | FR-ENG-04·05 |
| C6 | 난수는 `packages/shared`의 시드 RNG만 쓴다. 브라우저 전투 시뮬레이터도 같은 RNG와 같은 계산 함수를 쓴다 | NFR-01 |
| C7 | API는 Codex가 `AppRouter`에서 단독 소유한다. 화면은 타입만 import한다. 새 프로시저마다 성공과 무인증·다른 사용자·제재·잘못된 입력 시험을 두고 행위자는 세션에서 정한다. main의 `compareAuthz`(`apps/server/src/authz/coverage.ts:12~52`)는 `AppRouter`의 모든 프로시저에 다섯 범주 증거를 요구하므로 새 프로시저는 같은 PR에서 `authzCase`(`authz/case.ts:6~16`) 증거나 이유 있는 면제(`authz/exemptions.ts`)를 함께 낸다 | AGENTS §7, AC-M3-03 |
| C8 | Prisma schema와 migration은 Codex만 고치고 새 migration만 만든다. 병합은 S1(T4-03) → S2(T4-12) → S3(T4-20) → S4(T4-23) → S5(T4-28) → S6(T4-31) 순서이며 §6 선행 칸에 `병합` 선행으로 적는다. 뒤 PR은 병합 직전 최신 main에서 자기 migration만 다시 만든다. 다른 PR과 공유됐거나 어느 DB에든 적용된 migration은 다시 만들지도 고치지도 않는다 | AGENTS §9 |
| C9 | 다른 국가의 비공개 값은 `apps/server/src/visibility.ts`를 거쳐서만 나간다. 첩보 기록, 타임랩스, 시뮬레이터 기본값도 이 경로를 지난다 | FR-GEN-05, D-019 |
| C10 | 새 수치와 알고리즘은 core2026 `df6c926`의 공개 코드에서 출발하고 파일 경로를 계획에 적는다. 경로를 적었다고 우리 능력치 3종과 tick에 맞춘 비용·확률·효과 환산이 수용된 것은 아니다. 작업별 계획은 단위가 같아 원작 값을 그대로 쓰는 수치와 환산이 필요한 수치를 표로 나눈다. 환산이 필요한 수치와 원작에 없는 수치는 §9 U-19로 보내며 결정 전에는 그 작업을 계약 준비로 올리지 않는다 | D-001, AGENTS §5 |
| C11 | NPC AI는 §9 U-18 결정 전까지 확장 명령을 쓰지 않는다. 새 판단을 넣지 않는 것이며 정책을 정한 것이 아니다. 그래서 확장 실행 증거는 NPC 시뮬레이션이 아니라 C19의 결정적 입력 시나리오로 받는다 | AC-M1-17 보존 |
| C12 | 화면·게임 문구와 문서는 [글쓰기 규칙](../writing-style.md)을 따르고 `pnpm lint:text --strict`가 0건이다. 새 그림(국기 그림, 계략 패)은 만들지 않는다. 국기는 원작처럼 국가 색 번호다 | D-017, D-016 |
| C13~C20 | 경로 계약. §4.1 | R67-1~3, 5, 7~9 |

완료 증거는 작업마다 실제로 돌린 것만 인정한다. 규칙은 `pnpm check`의 단위 시험, 저장은 `pnpm test:int`(실제 PostgreSQL), API는 실제 HTTP 소켓 시험, 화면은 `pnpm e2e`(Chromium), 결정성은 12개월 재생 해시, 성능은 `pnpm sim --seeds 10`의 시간 기록이다. skip이나 mock만으로 통과시키지 않는다. 문서 PR의 기존 CI 통과는 이 문서가 제안한 기능의 구현 증거가 아니다.

### 4.1 경로 계약

아래 계약은 main `2380904`의 실제 경로를 짚고 소유 작업을 정한 제안이다. 처음 짚은 `888a4df` 뒤로 아래 경로 가운데 바뀐 파일은 `apps/engine/src/monthly.ts` 하나이며 인용한 줄은 그대로다. 그 사이 main에 생긴 사실은 §12 끝에 적었다. 각 작업의 상세 계획(`T4-xx.md`)이 입력·출력을 확정하고 반대쪽 기술 검토가 수용해야 계약 준비가 된다.

#### C13 월드별 명령 resolver (R67-1)

지금은 명령 목록을 읽는 곳이 다섯 군데다. `packages/rules/src/commands/registry.ts:20~33`의 `runCommand`는 기본 `commandRegistry`만 찾는다. `apps/server/src/game/slots.ts:7~16`의 `parseSlot`·`displaySlots`는 저장·편집 전에 같은 목록으로 확장 key를 거부한다. `apps/server/src/routers/turns.ts:105~118`의 사전 검사와 `apps/server/src/routers/commands.ts:5~16`의 모듈 전역 목록이 따로 있다. 실제 실행 진입점은 `packages/rules/src/commands/turn.ts:38~44`(국가)와 `:69~75`(장수)다.

- `packages/rules/src/commands/resolve.ts`(새 파일, T4-02)가 `createCommandResolver(enabled)`를 낸다. 입력은 `{ general: string[]; nation: string[] }` 또는 `null`이다. `null`은 끈 월드이며 기본 37개와 같은 결과를 낸다.
- resolver는 `get(key)`, `list(target)`, `precheck(view, actor, key, args)`, `run(view, actor, key, args, rng)`를 낸다. 켜지지 않은 확장 key는 `COMMAND_DISABLED`, 어디에도 없는 key는 지금처럼 `UNKNOWN_COMMAND`다. `Failure.code`에 `COMMAND_DISABLED`를 더하는 것도 T4-02다.
- `runGeneralTurn`은 resolver를 선택 인자로 받는다. 없으면 지금 동작 그대로다. 엔진 턴 실행, 순수 재생(`packages/rules/src/replay.ts`), 시뮬레이터는 같은 `World.preset`에서 만든 resolver를 넘긴다. NPC 분기의 `commandRegistry.get('rest')`류 기본 명령 조회는 바꾸지 않는다.
- package export는 `packages/rules/src/index.ts`의 한 줄이며 §7 반영 순서를 따른다.
- 서버 연결은 T4-03이다. `World.preset`에서 resolver를 만드는 함수 하나를 `parseSlot`, `displaySlots`, `turns.precheck`, `commands.list`가 함께 쓴다. 꺼진 key 저장의 응답 형식은 T4-03 상세 계획에서 Codex가 정한다.
- 일반 명령 예약은 기존 `turns` 라우터(T4-03), 국가 명령 예약은 T2-05의 `nationTurns` 라우터에 resolver를 잇는 T4-50이다. 화면은 일반 명령 인자 T4-04, 국가 명령 인자 T4-51이다.
- 검증은 켠 월드의 실제 HTTP·DB 저장 → 사전 검사 → 실행 → 표시와 끈 월드의 거부 이유다. 일반 명령은 T4-03, 국가 명령은 T4-50이 맡는다.

#### C14 확장 상태의 저장·복원·재생 (R67-2)

지금 `packages/rules/src/model/clone.ts:14~26`과 `model/world.ts:13~23`은 아는 칸만 돌려준다. 엔진 `apps/engine/src/worldLoader.ts:18~37`과 `monthly.ts:8~20, 54~63`이 DB 경로를 따로 가진다. `apps/engine/src/replay.ts:16~35, 77~92`는 version 1과 생성 리소스 해시만 알고 `packages/rules/src/replay.ts:67~105`는 `turns.set`·`general.create`만 적용한다. 모델에 `ext` 칸 하나만 더하면 명령 복제 때 확장 상태가 사라지거나 월간 해시·재생 입력에서 빠진다.

- T4-02(순수 경로): `WorldState.ext`와 확장별 상태 조각(§7) 계약, `cloneWorld`·`toWorldState`·`WorldInit`의 `ext` 복제, 순수 재생 reducer가 `ext`를 그대로 넘기는 것. 끈 월드에는 키가 생기지 않는다(C3).
- T4-03(DB 경로): 월드 생성·bootstrap에서 켠 월드의 `ext` 초기화, `worldLoader`의 `ext` 적재, 턴·월간 저장의 `ext` 쓰기, 월간 정산의 `ext` 처리 → 저장 → `loadReplayState` → `stateHash` 순서.
- 재생 기록 버전: 끈 월드는 지금의 `ReplayOrigin`·`ReplayArchive` version 1과 바이트가 같고 기존 v1 origin과 저장된 해시는 바뀌지 않는다. version 2는 먼저 정상 통합되는 T1-26 종료 기록의 archive v2가 단일 소유한다(총괄 결정, [T4-02 2.4.6](./T4-02.md#246-t4-03과의-경계)). 켠 월드 기록은 T4-03 상세 계획이 그때 main의 형식에 맞춘다. 호환되지 않는 확장이 필요하면 다음 미사용 버전(지금 예상은 v3)을 쓰고 origin에 고정 프리셋 사본과 확장 리소스 사본을 담는다. `resourceHash`는 그 버전에서만 그 둘을 더한다. 읽기 허용 조합과 섞인 모양의 거부도 그 계획에 적는다. 소유는 T4-03이다.
- 검증: 기존 v1·끈 월드 골든 보존(바이트 비교). 켠 월드는 저장 → 엔진 재시작 → 복원 상태 해시 일치와 12개월 순수 재생 동등성을 따로 본다.

#### C15 즉시 행동 InputEvent 수명 (R67-3)

지금 엔진 `apps/engine/src/inputs.ts:16~19`와 `turnLoop.ts:86~105`는 `general.create`만 처리한다. `packages/db/prisma/schema.prisma:267~283`의 멱등 키는 kind별이 아니라 `(worldId, userId, idempotencyKey)` 고유키다. `general.create`도 `create`와 `mine`을 함께 써서 지연 거절을 복구한다(`apps/server/src/routers/general.ts:69~115`). 새 kind는 기록만으로 처리되지 않는다. T2-05도 `personnel.appoint` 즉시 행동을 계획했다.

T4-49가 아래를 상세 계획으로 확정하기 전에는 T4-20, T4-28, T4-31과 그 화면 T4-21, T4-29, T4-32를 계약 준비로 올리지 않는다. 화면을 실제 API에 잇는 작업도 그 뒤다.

- kind 목록, kind별 payload·result 스키마(zod, rules), 상태 `PENDING → APPLIED | REJECTED`.
- 처리 순서: 기존 `general.create`와 같은 반복 머리에서 id 순으로 한 트랜잭션에 하나씩 처리하고 그때 world action sequence를 받는다. 같은 반복에서 턴·월간보다 먼저인지 뒤인지 한 가지로 정한다.
- RNG: `rngFor(seed, 'input', kind, sequence)`처럼 sequence에 묶인 스트림. 접수 시각을 쓰지 않는다.
- 멱등: 기존 고유키는 바꾸지 않는다. 클라이언트 요청 식별자로 `<kind>:<requestId>` 키를 만들고 같은 키·같은 payload 재시도는 기존 결과를, 다른 kind나 payload는 충돌로 거부한다. main의 `protectedProcedure`는 사용자당 분당 변경 요청 120건을 넘으면 `TOO_MANY_REQUESTS`와 `Retry-After`를 낸다(`apps/server/src/trpc.ts:18~26`). 이때는 기록하지 않으므로 화면은 같은 요청 식별자로 다시 보낸다. 입찰처럼 몰리는 행동에 따로 한도를 둘지는 T4-49.md에서 정한다.
- 재접속 조회: 요청 식별자로 자기 입력의 상태·결과만 읽는 조회. 처리 완료 뒤 다시 접속해도 같은 결과를 본다.
- 처리 시점 재검사: 세션·제재, 소속 국가, 직책을 엔진 처리 때 다시 본다. 실패는 REJECTED와 이유 코드다.
- 월드 상태: PAUSED에서는 기록만 받고 재개 뒤 처리한다. ENDED에서는 API가 거부하고 남은 PENDING은 REJECTED로 닫는다.
- 같은 트랜잭션 범위: 부대장 이탈·국가 멸망 때 부대 정리, 입찰금 선차감과 이전 최고 입찰자 환불, 토너먼트 보상의 장수별 1회.
- 재생: 순수 reducer의 kind 분기와 엔진 재생 기록. T2-05의 즉시 행동 처리 경로와 하나로 맞춘다(관문 G-02).

#### C16 공유 파일 단일 소유 (R67-4)

§7에 적는다. 확장마다 상태 조각 파일을 두고 공유 반영 파일은 파일별 반영 순서의 작업만 고친다.

#### C17 방랑 국가 (R67-5)

AC-P2-08은 도시 없는 국가가 살아남는다고 한다. 하지만 `InitialNation.capitalCityKey`는 필수 숫자다(`packages/rules/src/world/bootstrap.ts:32~43`). `apps/engine/src/worldLoader.ts:22~25`는 수도가 null이면 바로 예외를 낸다. `packages/rules/src/commands/attack.ts:145~147`은 마지막 도시가 사라지면 바로 `removeNation`하고 `apps/engine/src/simulation.ts:15~20`의 통일 판정은 남은 국가 수를 센다.

- 강행(T4-14)과 방랑(T4-48)을 나눈다. 강행은 순수 규칙 작업으로 먼저 계획한다. 방랑은 계약을 먼저 쓰는 통합 작업이다.
- T4-48 상세 계획이 정할 것: 방랑 국가 표식, 수도 표현(모델 변경 또는 확장 상태), 소속 장수 위치, 보급과 월간 수입, 점령·멸망 처리, 통일 판정, 도시 재획득·해산 조건, DB 저장과 `worldLoader` 복원.
- 방랑하지 않은 국가의 동작과 끈 월드의 해시는 지금과 같다. 통일 판정과 재획득 조건의 규칙 선택은 U-21이다.
- 검증: 방랑 선택 → 점령 시도 → 월간 정산 → 저장·재시작 → 재획득 또는 해산 전 경로의 엔진 통합 시험과 기본 국가 골든.

#### C18 야간 휴전의 유효 경과 시간 (R67-8)

지금 `packages/rules/src/clock/clock.ts:25~40`은 기준 시각 이후 실제 경과를 전부 tick으로 바꾼다. `apps/engine/src/world/clock.ts:18~33`의 status·pause·resume도 checkpoint하고 `turnLoop.ts:93~97`도 따로 시계를 읽는다. 엔진 실행만 멈추면 휴전이 끝나거나 프로세스가 재시작될 때 휴전 중 시간을 밀린 턴으로 따라잡는다.

- `packages/rules/src/clock/truce.ts`(새 파일, T4-40)의 순수 함수가 기준 시각, 현재 시각, 휴전 설정으로 유효 경과 밀리초를 낸다. `nowTick`, `checkpointClock`, 엔진 시계 명령(status·pause·resume·start), `turnLoop`의 시계 읽기, API 시계 표시가 모두 이 함수를 쓴다.
- 휴전 설정은 고정 프리셋 안의 UTC 오프셋(분)과 시작·끝 시각이다. 서머타임은 다루지 않는다. 구간은 시작 포함·끝 제외이며 자정을 넘는 구간을 허용한다.
- 엔진이 멈춘 사이 지나간 휴전 구간도 빼고 계산한다. 그래서 재시작 뒤에도 휴전 시간을 따라잡지 않는다.
- 수동 pause는 지금처럼 시계를 멈추고 resume은 그 시각부터 유효 경과를 다시 센다. 휴전 안에서 resume해도 휴전이 끝날 때까지 tick은 늘지 않는다. status는 휴전 중임을 함께 돌려준다.
- `clockRevision` 조건부 갱신과 리스 펜싱은 그대로 쓴다. 끈 월드의 `nowTick` 결과는 지금과 같다.
- U-12(기본 시간대와 적용 프리셋)는 기본값 결정이며 이 알고리즘과 별개다.

미래 턴의 예정 시각도 같은 계약에 넣는다(R67-8-R). 지금 `apps/server/src/queries.ts:64~69`의 `nextTurnAt`은 기준 시각 + tick 차 × tick 길이로 시각을 만들고 `routers/home.ts:44`가 이 값을 그대로 낸다. 화면 `apps/web/src/turns/schedule.ts:18~40`의 `slotTimes`는 첫 칸 시각에 칸 번호 × 턴 간격을 더한다. `queries.ts:17~25`의 `worldSelect`에는 휴전 설정이 없다. 이대로면 첫 칸을 고쳐도 뒤 칸은 휴전을 건너뛰지 못한다.

- 역변환: `truce.ts`에 목표 tick → 실제 예정 시각 함수를 함께 둔다. 기준 시각부터 센 유효 경과가 (목표 tick − 기준 tick) × tick 길이에 처음 닿는 실제 시각이다. 휴전 안에서는 유효 경과가 늘지 않으므로 휴전 전에 못 채운 몫은 휴전이 끝난 뒤 이어 센다. 휴전 시작 순간에 딱 닿으면 그 시각이다.
- 체크포인트: `checkpointClock`의 새 기준 시각은 새 기준 tick을 역변환한 시각이다. 지금처럼 tick에 못 미친 잔여 경과는 남긴다. 기준 시각과 현재 사이의 휴전은 유효 경과 함수가 다시 뺀다. pause의 잔여 처리, 기준 tick보다 앞선 목표 tick(밀린 칸)의 값, 밀리초 반올림은 T4-40.md에서 정하되 끈 월드는 지금 값과 같아야 한다.
- 서버 연결(T4-40): `readWorld`가 프리셋의 휴전 설정을 함께 읽는다. `worldSummary`의 현재 tick과 `nextTurnAt`은 위 두 함수를 쓴다.
- 30칸 예정 시각(총괄 결정): 서버가 칸마다 같은 역변환으로 예정 시각을 계산해 응답하고 화면은 그 값을 그대로 보인다(T4-41). 화면에는 휴전 역변환도, 첫 칸 + 칸 번호 × 턴 간격 계산도 두지 않는다. main에서는 D-020에 따라 메인(`apps/web/src/pages/MainPage.tsx:99`)과 단독 편집기(`turns/TurnsPage.tsx:17`)가 같은 `TurnEditor`를 쓰고 30칸 시각은 `turns/TurnEditor.tsx:137`의 `slotTimes` 한 곳에서 나온다. 그래서 이 한 곳을 바꾸면 두 화면이 같은 시각을 보인다. 칸의 연월은 tick으로 세므로 지금 계산을 그대로 쓴다.
- 첫 칸만 쓰는 화면: main의 상단 남은 시간(`layout/GameLayout.tsx:35~36`, `game/countdown.ts`)과 장수 정보의 다음 턴(`main/GeneralInfo.tsx:69`)은 서버 `nextTurnAt`을 그대로 쓴다. 서버 값이 휴전을 반영하면 따로 고칠 계산이 없고 T4-41은 이 두 곳의 휴전 표시 시험만 더한다.
- 지금 첫 칸 `nextTurnAt`의 뜻과 RUNNING이 아니면 null인 경계는 그대로다. 필드 이름, 응답 위치, version은 정하지 않았고 T4-40.md의 API 계약 검토(G-03)에서 정한다. 끈 월드의 첫 칸과 30칸 시각은 지금 API·화면 값과 같다(골든).
- 반례: UTC+0, 휴전 [23:00, 07:00), 턴 간격 60분. 23:00 기준 다음 턴은 08:00이다(지금 main은 00:00). 첫 칸이 22:00이면 둘째 칸은 23:00, 셋째 칸은 다음 날 08:00이다(지금 화면은 00:00).
- 검증: 시계 주입 단위(양 경계, 자정 넘김, 놓친 구간, 역변환의 휴전 직전·직후·안·시작 순간, 체크포인트 기준 시각과 잔여 보존), PostgreSQL 통합(휴전 중 재시작 뒤 따라잡기 없음, 휴전 안 pause·resume, 재시작·pause/resume 뒤 첫 칸과 뒤 칸 예정 시각), HTTP(status, 예정 시각 응답, 끈 월드 `nextTurnAt` 골든), Chromium(메인·단독 편집기 30칸 시각이 HTTP 응답과 같은 tick에 맞음, 끈 월드 30칸 골든).

#### C19 확장 실행 coverage (R67-9)

C11 때문에 NPC는 확장 명령을 고르지 않는다. `apps/engine/src/simulation.ts:30~31`은 NPC 전용이고 `:47~53`은 기본 `rest`에서 NPC가 명령을 고른다. 그래서 프리셋만 켠 10시드는 새 명령을 한 번도 실행하지 않고 통과할 수 있다.

- 확장마다 사람 장수 몫의 예턴과 즉시 행동을 미리 넣은 결정적 입력 시나리오를 둔다. NPC 정책은 바꾸지 않는다.
- coverage 하한: 확장 명령 key마다 엔진 실행에서 성공·대표 실패 1건 이상, 즉시 행동 kind마다 APPLIED·REJECTED 1건 이상. 시험이 실행 횟수를 세어 하한 미달이면 실패한다.
- 확장마다 켠 월드, 모두 켠 월드, 끈 월드에서 DB·HTTP·Chromium·롤백·재생 증거를 모은다.
- `pnpm sim --seeds 10`은 오류 없음과 시간 기록만 본다. hosted 실행기 시간과 개발 PC 인수 시간(AC-M1-18)은 따로 적는다. 공용 자원 승인 없이 로컬 대규모 시험을 시작하지 않는다.
- 최종 관문 T4-47은 모든 T4 작업의 리뷰·실증 결과를 모으거나 미완료 작업을 이유와 함께 적는다.

#### C20 타임랩스 1차의 기존 조회 (R67-7)

main에는 이미 로그인한 사용자가 월간 연감을 읽는 `records.world`가 있다(`apps/server/src/routers/records.ts:37~53`). 응답은 `publicYearbook` 허용 목록(`apps/server/src/visibility.ts:120~131`)만 통과한 국가별 `nationId`·도시 수·장수 수와 도시별 `nationId`이고 tick 내림차순 30행씩 끊는다(`queries.ts:71~74`). 국가 이름·색은 없다. `NationHistory`에는 명령이 남긴 국가 사건 문구(`apps/engine/src/commandPersistence.ts:97~113`)와 월간 요약(`monthly.ts:65~75`)이 같은 행에 합쳐지지만 `records.nation`은 자기 국가 행만 읽는다(`records.ts:18~36`). 다른 국가에 공개된 사건 기록이 아니다.

- T4-35.md는 `records.world`를 그대로 쓸지, 범위 지정 조회를 그 라우터에 더할지, 새 `timelapse` 라우터를 둘지 하나로 정한다. 기술 선택이며 제품 결정이 아니다. 새 라우터를 두면 §7 `router.ts` 순서를 따른다.
- 비공개 국력·국고·군량은 지금처럼 허용 목록 밖에 둔다. 허용 필드를 늘리면 `visibility.ts`와 권한 시험을 같은 PR에서 고친다.
- `NationHistory`의 사건 문구를 그대로 공개 자막으로 쓰지 않는다. 공개할 사건의 투영은 T4-56의 계약이다(A-11).

#### 계약 관문

제품 결정(§9)이 아니라 다른 담당의 수용이 필요한 항목이다.

| ID | 관문 | 막는 작업 | 풀리는 조건 |
| -- | ---- | --------- | ----------- |
| G-01 | T2-02 허용 목록 생략의 뜻 (전체 또는 기본 목록만) | T4-03 | T2-02 담당이 수용한 계약과 그 SHA를 T4-03 계획에 핀한다. 다르면 총괄이 한쪽으로 정한다 |
| G-02 | T2-05 `personnel.appoint`의 즉시 행동 처리 경로 | T4-49 | T2-05의 수용 계약·SHA를 핀하고 C15를 그것과 하나로 맞춘다 |
| G-03 | C13~C20 자체의 기술 검토 수용 | 각 소유 작업 | 해당 `T4-xx.md`의 반대쪽 리뷰 통과 |

## 5. 인수조건 제안

AC-P2-16과 D-027으로 채택한 AC-P2-01, AC-P2-02·03·12·13·15·17의 (가), AC-P2-17의 (나)·(다)는 [인수조건](../product/acceptance-criteria.md#p2) 쪽이 정본이고 상태도 거기서 본다. 그 밖의 행과 몫은 제안이며 미착수다. 정식 반영 때 [인수조건](../product/acceptance-criteria.md) 형식으로 옮긴다. (가)·(나)로 나뉜 AC는 작업이 따로이며 증거도 따로 받는다.

| ID | 조건 | 검증 방법 |
| -- | ---- | --------- |
| AC-P2-01 | `pnpm next`가 T4 작업을 Phase 2 절로 따로 보여 주고 M4로 표시하지 않는다. 지금의 M1~M3 출력과 현재 관문 계산은 그대로다. T4 행의 선행에 T1~T3 ID를 쓸 수 있다 | next-task 단위 시험 + 현재 phases.md 출력 전후 비교 |
| AC-P2-02 | 확장 명령은 월드 프리셋 허용 목록에 key가 있을 때만 예턴에 저장되고 사전 검사를 지나 실행된다. 일반 명령은 `turns`, 국가 명령은 `nationTurns` 경로다. 꺼진 월드에서는 저장·사전 검사·실행이 `COMMAND_DISABLED`로 거부되고 명령 목록에 없다. 꺼진 월드의 명령 37개 대조, v1 재생 기록, 12개월 재생 해시는 바뀌지 않는다. 켠 월드의 확장 상태는 턴·월간과 같은 트랜잭션에 저장되고 재시작 뒤 복원되며 12개월 재생 해시가 같다 | rules 단위 + PostgreSQL 통합(롤백·SIGKILL·재시작·재생) + 실제 HTTP 저장→사전 검사→실행→표시 + E2E |
| AC-P2-03 | 계략 4종(화계·파괴·선동·탈취)이 대상 도시와 장수에 효과를 내고 실패하면 이유가 장수 로그에 남는다. 명령마다 성공·대표 실패 시험이 있고 같은 시드면 결과가 같다. D-027 후속으로 (가) 정의·단위 몫(T4-05)만 인수조건 정본에 올랐다 | rules 단위 + 엔진 통합·재생 |
| AC-P2-04 | 준비 턴이 없는 전략 명령 3종(백성동원·이호경식·급습)은 권한 있는 직책만 실행하고 실행 뒤 재사용 대기 동안 같은 국가가 다시 쓰지 못한다 | rules 단위 + 엔진 통합 + 권한 시험 |
| AC-P2-05 | 준비 턴이 있는 전략 명령 5종(필사즉생·수몰·의병모집·허보·피장파장)이 U-01에서 정한 방식대로 준비·실행된다 | U-01 결정 뒤 확정 |
| AC-P2-06 | 특수 병종 연구 9종 가운데 승인된 병종은 연구를 마친 국가만 모병·징병한다. 기술·도시 조건이 맞지 않으면 사전 검사가 이유를 보인다. 연구 전 국가와 확장을 끈 월드는 기존 병종만 쓴다 | rules 단위 + 엔진 통합·재생 (U-01~U-03 뒤) |
| AC-P2-07 | 첩보하면 대상 도시의 그 시점 정보가 자기 국가에만 보이는 기록으로 남고 기록 시각이 함께 보인다. 다른 국가와 무인증의 조회는 거부된다 | rules 단위 + PostgreSQL + HTTP 권한 + E2E |
| AC-P2-08 | (가) 강행은 원작 근거의 거리 안 도시로 한 턴에 이동한다(T4-14). (나) 방랑을 고른 국가는 도시 없이 남는다. 점령·월간 정산·통일 판정·저장 뒤 재시작을 C17 계약대로 거치고 원작 근거의 조건에서 다시 도시를 얻거나 해산한다(T4-48). 방랑하지 않은 국가의 동작은 지금과 같다 | (가) rules 단위 (나) rules 단위 + 엔진 통합(재시작·재생) + 기본 국가 골든 |
| AC-P2-09 | (가) 선양은 군주 자리를 같은 국가 장수에게 넘기고 해산은 원작 근거 조건에서만 된다(T4-15). (나) 모반은 군주 미접속 기준(U-05)을 넘었을 때만 성공한다(T4-52). 권한 없는 장수의 같은 명령은 거부된다 | rules 단위 + 엔진 통합 + 권한 시험 |
| AC-P2-10 | (가) 변경권이 있는 국가의 군주가 국호와 국가 색을 바꾼다. 건국과 같은 이름 검사를 거치고 변경권을 쓴 뒤에는 다시 못 바꾼다(T4-16). (나) 변경권이 생기는 조건(T4-55, U-04 뒤) | rules 단위 + 엔진 통합 |
| AC-P2-11 | 부대를 만들고 가입·탈퇴하면 C15 계약의 InputEvent로 처리된다. 부대장이 집합을 실행하면 같은 국가 부대원이 부대장 도시로 모인다. 다른 국가 부대 조작은 거부된다 | rules 단위 + PostgreSQL + HTTP 권한 + E2E |
| AC-P2-12 | 장수가 장비를 사고팔고 장착한 장비의 효과가 내정·전투 계산에 들어간다. 장비가 없는 장수의 결과는 지금과 같다(골든) | rules 골든 + 통합 + E2E |
| AC-P2-13 | 장수의 특기가 승인된 범위(U-07)의 내정·전투 계산에 들어간다. 특기가 없는 장수와 확장을 끈 월드의 결과는 지금과 같다(골든) | rules 골든 + 통합 + E2E |
| AC-P2-14 | 경매에 입찰하면 C15 계약의 InputEvent로 기록되고 마감 때 최고 입찰자에게 낙찰된다. 입찰금 차감·낙찰·환불이 한 트랜잭션에 저장되고 재생된다 | rules 단위 + PostgreSQL(롤백·재생) + HTTP 권한 + E2E |
| AC-P2-15 | (가) 같은 시드와 참가자면 대진이 같다(T4-30, 종목 독립). (나) 참가가 C15 계약의 InputEvent로 기록되고 경기 결과가 같은 시드에서 같으며 보상이 한 트랜잭션에 저장된다(T4-54·T4-31, U-09 뒤) | rules 단위 + PostgreSQL + HTTP 권한 + E2E |
| AC-P2-16 | 전투 시뮬레이터에 양쪽 병력·병종·훈련·사기·기술을 넣으면 Web Worker에서 실제 출병과 같은 계산 함수로 결과를 낸다. 같은 입력·시드면 실제 전투와 결과가 같다. 계산 중에도 입력이 막히지 않는다. 다른 국가의 비공개 값을 자동으로 채우지 않는다. (가) T4-34 몫(PR #132 [T4-34 계획](https://github.com/peppone-choi/opensamguk/blob/dce127bebda6d6b657c9f39acffe2398623e6fb5/docs/plans/T4-34.md)의 계약, D-023으로 인수조건에 정식 반영. 정본 문장은 인수조건 쪽이다): 양쪽 병력·병종·훈련·사기·기술(성벽이면 성벽·수비 값)과 시드를 넣으면 Web Worker가 `simulateBattle(input, createRng(seed))`를 한 번 실행해 시드와 양쪽 남은 병력·사기, 입력 가정을 보인다. 같은 입력과 시드면 결과가 같고 계산 중에도 입력이 막히지 않으며 다른 국가의 비공개 값을 조회하거나 자동으로 채우지 않는다. (나) 실제 턴 전투와 같은 결과는 남은 몫이다 | rules 골든 + Chromium E2E. (가)는 Worker 차등 단위 시험 + Chromium E2E |
| AC-P2-17 | 1차 범위. 로그인한 사용자가 기록 화면에서 월드의 달별 도시 소유를 재생한다. main에 이미 있는 `records.world` 조회는 Phase 2 성과로 세지 않는다(§1). 응답에는 도시 소유와 공개 국가 표시값만 있고 국력·국고·군량은 없다. 두 달 끝의 소유 차이로 만든 표시는 추정 변화라고 밝히며 건국·멸망·전투 사건 자막으로 쓰지 않는다. 실제 사건 자막, 과거 이름과 색, 열전 문구, 공유는 2차 범위(T4-56, T4-37)다. 이 AC만으로 D4 완료를 판정하지 않는다(A-11). D-027 후속으로 정한 (나) 재생 화면(T4-36)과 (다) 멸망 국가 보존(T4-56 (가))의 문장은 인수조건 정본에 있다 | PostgreSQL + HTTP 권한 + Chromium E2E |
| AC-P2-18 | 다른 국가 도시의 상세값은 첩보 기록으로만 보이고 몇 개월 전 기록인지 표시된다. 적 병력은 U-11에서 정한 구간으로 보인다 | HTTP 권한 + E2E (U-11 뒤) |
| AC-P2-19 | 휴전 시간대를 정한 월드는 그 시간 동안 tick이 늘지 않고 끝나면 이어서 진행한다. 휴전 중 엔진이 멈췄다 돌아오거나 수동 pause·resume이 겹쳐도 휴전 시간을 밀린 턴으로 따라잡지 않는다. status, 첫 칸과 30칸의 예정 시각은 서버가 C18의 같은 함수로 계산하고 메인·단독 편집기는 그 값을 그대로 보인다. 휴전을 지나는 칸은 휴전 시간을 빼고 이어 센 시각이다. 정하지 않은 월드의 tick, `nextTurnAt`, 30칸 시각은 지금과 같다 | 시계 주입 단위(경계·자정 넘김·역변환·체크포인트 잔여) + PostgreSQL 통합(재시작·pause/resume 뒤 첫 칸·뒤 칸) + HTTP status·예정 시각 + Chromium(30칸 시각과 HTTP 응답 일치, 끈 월드 골든) |
| AC-P2-20 | D7 인물 관계망 | U-13 결정 뒤 확정 |
| AC-P2-21 | D8 역사 사건 선택지 | U-14 결정 뒤 확정 |
| AC-P2-22 | D9 명성과 계보. 다음 기수에는 꾸미기만 반영하고 능력 혜택은 없다 | U-15 결정 뒤 확정 |
| AC-P2-23 | D14 계략 패. 계략만 패로 묶고 다른 명령은 그대로다 | U-16 결정 뒤 확정 |
| AC-P2-24 | 승인된 추가 시나리오마다 월드를 만들면 도시·국가·장수가 저장되고 같은 시드 두 번의 상태 해시가 같다 | 통합 시험 (AC-M1-03 방식) |
| AC-P2-25 | 확장 실행은 C19의 결정적 입력 시나리오로 증명한다. 확장 명령 key마다 엔진에서 성공·대표 실패 1건 이상, 즉시 행동 kind마다 APPLIED·REJECTED 1건 이상이 실행된다. 확장마다 켠 월드, 모두 켠 월드, 끈 월드의 DB·HTTP·Chromium·롤백·재생 증거가 있다. 모두 켠 프리셋으로 `pnpm sim --seeds 10`이 오류 없이 끝나고 시간이 기록된다. 개발 PC 시간은 AC-M1-18 기준으로 따로 적는다. 새 API 전부가 AC-M3-03의 권한 대조(`compareAuthz`)에서 빠진 범주 0건이다. 모든 T4 작업이 완료이거나 미완료 목록에 이유와 함께 있다 | coverage 시험 + sim 기록 + 재생 + 권한 대조 |
| AC-P2-26 | 월드 초기화 자원(지도·시나리오·병종·기본 능력치 규칙·초상 대응표)을 DB의 판으로 읽어 월드를 만든다. 내장 JSON은 초기화 SQL로 같은 키의 불변 판이 되고 저장소에서 지워진다. 이전 전 고정물의 재생 해시와 시뮬레이션 결과가 이전 뒤에도 같다. 같은 키에 다른 내용을 넣으면 실패한다 (D-028, 정식 반영) | PostgreSQL + 재생 고정물 대조 + 공급자 일치 단위 시험 |
| AC-P2-27 | 운영자가 관리자 콘솔에서 자원 판을 복제해 편집하고 검증을 통과한 판만 게시한다. 지도는 지형·도시 위치·연결·도시 추가와 삭제를, 시나리오·병종·능력치 규칙·초상 대응표는 표 편집으로 고친다. 게시한 판은 바뀌지 않고 새 월드를 만들 때 고를 수 있으며 진행 중인 월드는 영향받지 않는다. 권한 없는 계정의 편집·게시는 거부되고 모든 변경이 감사 로그에 남는다 (D-028, 정식 반영) | HTTP 권한 + PostgreSQL + E2E |
| AC-P2-28 | 게시한 지도 판마다 우리 밑그림만 입력으로 만든 도트 바탕 그림과 출처 기록이 있다. 메인·공개 지도는 이 그림을 도시 점과 연결선 아래에 깐다. 그림이 없는 판은 바탕 없이 그린다 (D-028, 정식 반영) | 이미지 출처 기록 + E2E |

## 6. 작업 분해

추정은 한 담당 기준이고 한 줄이 PR 하나 크기다. 선행 칸의 작업 ID는 구현 선행이고 `병합 T4-xx`는 구현은 먼저 해도 되지만 병합은 그 작업 뒤라는 뜻이다(§7 반영 순서에서 기계적으로 나온다). U·A·G는 §9 결정, §8 승인, §4.1 관문이다. 상태 칸은 §6.1의 단계다.

| ID | 작업 | AC | 구현 → 리뷰 | 선행 | 단독 소유 경로 (공유는 §7) | 증거 | 추정 | 상태 |
| -- | ---- | -- | ----------- | ---- | -------------------------- | ---- | ---- | ---- |
| T4-01 | `pnpm next` Phase 2 절 | P2-01 | Claude → Codex | — | `tools/next-task.mjs`, `tools/next-task.test.ts` | 단위 시험, 출력 전후 비교 | 0.5일 | D-027 채택. 계획과 R138-1 수정 계약대로 Claude 구현, 시험 39개 통과. Codex 독립 리뷰 5623645788과 PR #162 exact head `09604e7`의 pull·push CI 39895694550·39895675122를 통과해 main `7de674d`에 병합. 대기열 완료, AC-P2-01 통과 |
| T4-02 | 확장 명령 틀, 월드별 resolver, `ext` 순수 경로 (C13·C14) | P2-02 | Codex → Claude | 병합 T4-30 | `commands/resolve.ts`, `ext/registry.ts`, `ext/state.ts` | 37개 대조 유지, resolver 켬·끔, `ext` 복제·재생 reducer, 끈 월드 재생 해시 불변 | 1일 | D-027 채택(규칙 몫만). 계약 5611758624, 구현 당시 Codex 로컬 시험 114개. 규칙 PR 1은 PR #162 exact head `09604e7`에서 Claude 독립 백엔드 리뷰 5623645649와 pull·push CI 39895694550·39895675122를 통과해 main `7de674d`에 병합. 도구 PR 2(`tools/command-coverage.*`, `025c09c`)는 PR #180 head `c4ef846`의 pull·push CI 39906553467·39906547992 check job 성공. Claude 독립 리뷰는 #207 Codex 지적(참조되지 않는 선언·구조 분해의 부작용을 도구가 보지 않음)을 재현해 수정 필요로 바꿨고 대기열은 구현으로 되돌림. `makeStratagem` 등록 해석과 확장 시험 파일 대조는 T4-17. G-01·서버·엔진·DB·재생 기록 연결은 미채택 · MVP 필수 (D-022) |
| T4-03 | 확장 상태 저장, 명령 켜기, 서버·엔진 연결 (S1, C13·C14) | P2-02 | Codex → Claude | T4-02, T2-02, G-01, T2-26 | 새 migration, `apps/engine/src/extState.ts` | 켠 월드 HTTP 저장→사전 검사→실행→표시, 끈 월드 거부 이유, 롤백·SIGKILL·재시작·재생, v1 골든 | 1.5일 | 선행 대기 (T2-02, G-01, T2-26) · MVP 필수 (D-022). D-029로 형식은 T2-26의 기능 표시 형식 위에 다시 쓴다 |
| T4-04 | 일반 명령 확장 인자 입력 화면 | P2-02 | Claude → Codex | T4-03, T1-16 | `apps/web/src/turns/extArgs.ts` | E2E 켬·끔 월드 | 0.5일 | 선행 대기 · MVP 필수 (D-022) |
| T4-05 | 계략 4종 규칙 | P2-03 | Codex → Claude | T4-02 | `ext/stratagem/` | 명령별 성공·실패, 같은 시드 | 0.5일 | D-027 후속 채택(AC-P2-03 (가), 정의와 단위 시험만). 사용자가 U-19의 이 작업 몫 S0~S7을 승인했고 부모 Codex 독립 계획 검토가 `PASS_PLAN_CONTRACT`로 수용했다. Codex 구현 중. 준비 턴 없음. 등록 T4-17, 엔진·DB·HTTP·재생 T4-03, 화면 T4-04는 미채택 · MVP 필수 (D-022) |
| T4-06 | 전략 명령 3종 규칙 (준비 턴 없음) | P2-04 | Codex → Claude | T4-02 | `ext/strategy/` | 성공·실패·재사용 대기·권한 | 0.5일 | 계획 가능, 계약은 U-19 · MVP 필수 (D-022) |
| T4-07 | 준비 턴 기제 | P2-05 | Codex → Claude | T4-03, 병합 T4-48 | `ext/prepare/`, `apps/engine/src/extPrepare.ts` | 연속 칸·중단·재생 | 1일 | 결정 대기 (U-01) · MVP 필수 (D-022) |
| T4-08 | 전략 명령 5종 규칙 (준비 턴 있음) | P2-05 | Codex → Claude | T4-07 | `ext/strategyPrepared/` | 명령별 성공·실패 | 0.5일 | 결정 대기 (U-01, U-19) · MVP 필수 (D-022) |
| T4-09 | 특수 병종 연구 6종 (보·궁·기 계열) | P2-06 | Codex → Claude | T4-07 | `ext/research/`, `resources/unitset/` 확장 파일 | 연구 전후 모병, 재생 | 0.5일 | 결정 대기 (U-01, U-02) · MVP 필수 (D-022) |
| T4-10 | 특수 병종 3종 (음귀병·무희·화륜차) | P2-06 | Codex → Claude | T4-09 | `ext/research/` 이어서 | 새 계열 상성 | 0.5일 | 결정·승인 대기 (U-03, A-03) · MVP 필수 (D-022) |
| T4-11 | 첩보 규칙 | P2-07 | Codex → Claude | T4-02 | `ext/intel/` | 거리·성공·실패·기록 내용 | 0.5일 | 계획 가능, 계약은 U-19 · MVP 필수 (D-022) |
| T4-12 | 첩보 기록 저장·조회 API (S2) | P2-07 | Codex → Claude | T4-03, T4-11, 병합 T4-35 | `apps/server/src/routers/intel.ts`, 새 migration | PostgreSQL, HTTP 권한 4종 | 0.5일 | 선행 대기 · MVP 필수 (D-022) |
| T4-13 | 첩보 기록 화면 | P2-07 | Claude → Codex | T4-12, 병합 T4-36 | `apps/web/src/intel/` | E2E | 0.5일 | 선행 대기 · MVP 필수 (D-022) |
| T4-14 | 강행 규칙 | P2-08 | Codex → Claude | T4-02 | `ext/forcedMarch/` | 거리·이동·실패 | 0.5일 | 계획 가능, 계약은 U-19 · MVP 필수 (D-022) |
| T4-15 | 선양·해산 규칙 | P2-09 | Codex → Claude | T4-02 | `ext/succession/` | 권한·해산 조건 | 0.5일 | 계획 가능, 계약은 U-19 · MVP 필수 (D-022) |
| T4-16 | 국호·국기 변경 명령과 이름 검사 | P2-10 | Codex → Claude | T4-02 | `ext/nationIdentity/` | 이름 검사, 변경권 없음·사용 뒤 거부 | 0.5일 | 계획 가능 · MVP 필수 (D-022) |
| T4-17 | 확장 명령 1차 반영과 엔진 시험 | P2-03, 04, 07~10 | Codex → Claude | T4-03, T4-05, T4-06, T4-11, T4-14~T4-16 | `apps/engine/src/ext.integration.test.ts` | 실행·롤백·12개월 재생, 일반 명령 HTTP 저장→실행 | 1일 | 선행 대기 · MVP 필수 (D-022) |
| T4-18 | 효과 합산 틀 (장비·특기 공용) | P2-12, P2-13 | Codex → Claude | T4-33, 병합 T4-02 | `packages/rules/src/modifiers/` | 수정자 없을 때 내정·전투 골든 불변 | 0.5일 | D-027 후속 채택(AC-P2-12·13 (가)). T18-Q1 `domestic.score`, T18-Q2 빈 정적 제공자를 부모 Codex가 기술 수용. Codex 구현은 PR #171 exact `e0bb1c5`, 집중 시험 146개와 골든 비교 통과, Claude 독립 리뷰 5623797892 통과. CI 39897983940(단위 91파일 871개, PostgreSQL 23파일 378개, Chromium 75개 skip 0, 빌드)과 simulation 39897842539 성공, main `01af38b` 병합, 병합 CI 39899596746 성공. 대기열 완료이며 AC-P2-12·13 (나)는 남음. 리뷰된 T4-02 소스 위 로컬 병렬 구현 가능, 게시·병합은 T4-02 뒤. U-06·U-07·U-19 미승인 · MVP 필수 (D-022) |
| T4-19 | 부대 규칙과 집합 | P2-11 | Codex → Claude | T4-02 | `ext/troop/` | 집합 이동·국가 경계 | 0.5일 | 계획 가능, 계약은 U-19 · MVP 필수 (D-022) |
| T4-20 | 부대 저장·즉시 행동 API (S3) | P2-11 | Codex → Claude | T4-03, T4-19, T4-49, 병합 T4-12, T4-17 | `apps/server/src/routers/troop.ts`, `apps/engine/src/troopInputs.ts` | InputEvent 재생, HTTP 권한 | 1일 | 선행 대기 (C15) · MVP 필수 (D-022) |
| T4-21 | 부대 화면 | P2-11 | Claude → Codex | T4-20, 병합 T4-13 | `apps/web/src/troop/` | E2E | 0.5일 | 선행 대기 · MVP 필수 (D-022) |
| T4-22 | 장비 목록과 장비매매 규칙 | P2-12 | Codex → Claude | T4-18 | `ext/equipment/`, `resources/items/` | 매매·장착 골든 | 0.5일 | 결정 대기 (U-06, U-19) · MVP 필수 (D-022) |
| T4-23 | 장비 저장·조회 API (S4) | P2-12 | Codex → Claude | T4-03, T4-22, 병합 T4-20, T4-52 | `apps/server/src/routers/equipment.ts`, 새 migration | PostgreSQL, HTTP 권한 | 0.5일 | 선행 대기 · MVP 필수 (D-022) |
| T4-24 | 장비 화면 | P2-12 | Claude → Codex | T4-23, 병합 T4-41 | `apps/web/src/equipment/` | E2E | 0.5일 | 선행 대기 · MVP 필수 (D-022) |
| T4-25 | 특기 효과 규칙과 조회 필드 | P2-13 | Codex → Claude | T4-18, 병합 T4-49 | `packages/rules/src/traits/` | 특기별 골든 | 0.5일 | 결정 대기 (U-07, U-19) |
| T4-26 | 특기 표시 화면 | P2-13 | Claude → Codex | T4-25 | `apps/web/src/general/Traits.tsx` | E2E | 0.5일 | 선행 대기 |
| T4-27 | 경매 규칙 | P2-14 | Codex → Claude | T4-22 | `ext/auction/` | 입찰·낙찰·유찰 | 0.5일 | 결정 대기 (U-08) |
| T4-28 | 경매 저장·입찰 API·마감 (S5) | P2-14 | Codex → Claude | T4-23, T4-27, T4-49, 병합 T4-53 | `apps/server/src/routers/auction.ts`, `apps/engine/src/auction.ts` | 롤백·재생, HTTP 권한 | 1일 | 선행 대기 |
| T4-29 | 경매 화면 | P2-14 | Claude → Codex | T4-28, 병합 T4-24 | `apps/web/src/auction/` | E2E | 0.5일 | 선행 대기 |
| T4-30 | 토너먼트 대진 틀 (종목 독립) | P2-15 | Codex → Claude | 병합 T4-33 | `packages/rules/src/tournament/bracket.ts` | 같은 시드 같은 대진, 부전승·인원 경계 | 0.5일 | D-027 채택(AC-P2-15 (가)). 단판 토너먼트와 기술 상한 1024는 계산기 계약이며 참가 정원·U-09는 미채택. 부모 Codex가 G1~G5를 실제 RNG로 검증했고 Codex 구현·집중 시험 중 |
| T4-31 | 토너먼트 저장·참가 API·진행 (S6) | P2-15 | Codex → Claude | T4-03, T4-30, T4-49, T4-54, 병합 T4-28 | `apps/server/src/routers/tournament.ts`, `apps/engine/src/tournament.ts` | 롤백·재생, HTTP 권한 | 1일 | 결정 대기 (U-09) |
| T4-32 | 토너먼트 화면 | P2-15 | Claude → Codex | T4-31, 병합 T4-29 | `apps/web/src/tournament/` | E2E | 0.5일 | 선행 대기 |
| T4-33 | 기존 출병 전투 계산의 동작 불변 추출 | P2-16 | Codex → Claude | — | `packages/rules/src/battle/simulate.ts` | 출병 결과 골든, 같은 입력·시드 일치, RNG 소비 불변, 끈 월드 12개월 재생 | 0.5일 | main 병합 (PR #129 `ab6f803`, Claude 독립 리뷰 통과). AC-P2-16 (나)의 실제 턴 동등성은 이 작업으로 끝나지 않는다 |
| T4-34 | 전투 시뮬레이터 화면 (Web Worker) | P2-16 | Claude → Codex | T4-33 | `apps/web/src/battleSim/` | Chromium E2E, Worker 실행 | 0.5일 | 구현·독립 기술 리뷰 통과, main 병합 (PR #132 `494272b`). 상세 계약은 Codex 검토 5610239606(head `35b0d7c`)이 수용했고 AC-P2-16 (가)로 정식 반영됐다(D-023). 구현 `4a99437`은 Codex 리뷰 5612224678(head `dce127b`)을 통과했고 main 결합 head `b460bc2`는 독립 판정 5613458039와 필수 CI를 거쳐 병합됐다. 문서 지도 줄은 병합 뒤 넣었다. phases.md 대기열 행은 §3에 따라 T4-01 뒤에 넣는다. AC-P2-16 (나)는 남는다. 명령이 아니라 MVP로 옮기지 않는다 |
| T4-35 | 기존 월간 영토 스냅샷 로그인 조회 API (C20) | P2-17 (1차) | Codex → Claude | — | 새 `apps/server/src/routers/timelapse.ts` 하나 (C20, D-027에서 확정) | 실제 PostgreSQL 월별 자료, HTTP 4종, 비공개 필드 차단, 페이지 경계·빈 기록 | 0.5일 | D-027 채택(AC-P2-17 (가)). 부모 Codex가 상세 계획(Q1·Q2)을 기술 수용했다. PR #162 exact head `09604e7`에서 Claude 독립 백엔드 리뷰 5623645649와 pull·push CI 39895694550·39895675122를 통과해 main `7de674d`에 병합. 대기열 완료이며 AC-P2-17의 다른 몫은 남음. U-10·A-11은 미승인. U-20 정정의 멸망 국가 저장은 T4-56 (가)이며 이 작업의 완료로 세지 않는다 |
| T4-36 | 월간 영토 재생 화면 | P2-17 (1차) | Claude → Codex | T4-35, U-20, 병합 T4-34 | `apps/web/src/timelapse/` | 웹 단위 + 실제 엔진 멸망 흐름 Chromium E2E | 0.5일 | D-027 후속 채택(AC-P2-17 (나) UI 몫). 부모 Codex가 순수 UI 계약을 기술 수용했다. Claude 구현의 순수 UI 시험 19개를 마쳤고 Codex의 U7 delta 4 검토가 PASS였다. 서버 연결·진입점·실제 E2E는 아직 없다. 저장값이 없는 프레임은 국가 기록 누락 오류로 막고 가짜 이름·색·회색 지도로 대신하지 않는다. 재마운트 캐시는 실제 쿼리 정책과 새 달 재조회 회귀 시험으로 고치고 E10 취소 검증은 내리지 않는다. 독립 UI 코드는 병렬로 만들고 실제 E2E와 병합은 T4-35와 T4-56 (가) 보존 조회 뒤다. U-20 정정됨 |
| T4-37 | 타임랩스 공유·내보내기 | P2-17 (2차) | Claude → Codex | T4-36 | `apps/web/src/timelapse/export.ts` | E2E | 0.5일 | 결정 대기 (U-10) |
| T4-38 | 안개 조회 규칙 | P2-18 | Codex → Claude | T4-12, 병합 T4-25 | `apps/server/src/fog.ts` | HTTP 권한, 구간 경계 | 0.5일 | 결정 대기 (U-11) |
| T4-39 | 안개 화면 | P2-18 | Claude → Codex | T4-38 | `apps/web/src/intel/Fog.tsx` | E2E | 0.5일 | 결정 대기 (U-11) |
| T4-40 | 야간 휴전 시계와 예정 시각 역변환 (C18) | P2-19 | Codex → Claude | T2-01, T2-02, 병합 T4-49 | `packages/rules/src/clock/truce.ts`, `apps/engine/src/world/truce.ts` | 시계 주입 경계·역변환·체크포인트 잔여, 재시작 뒤 따라잡기 없음, pause/resume 뒤 첫 칸·뒤 칸, HTTP status·프리셋 조회·현재 tick·칸별 예정 시각, 끈 월드 `nextTurnAt` 골든 | 1.5일 | 선행 대기 (기본 꺼짐, 기본값은 U-12) |
| T4-41 | 휴전 표시와 30칸 예정 시각 화면 | P2-19 | Claude → Codex | T4-40, T1-16, 병합 T4-21, T4-04 | `apps/web/src/layout/TruceNotice.tsx` | E2E, Chromium 메인·단독 편집기 30칸 시각과 HTTP 응답 일치, 끈 월드 30칸 골든 | 0.5일 | 선행 대기 |
| T4-42 | D7 인물 관계망 | P2-20 | 결정 뒤 나눔 | U-13 | — | — | 미정 | 결정 대기 |
| T4-43 | D8 역사 사건 선택지 | P2-21 | 결정 뒤 나눔 | U-14 | — | — | 미정 | 결정 대기 |
| T4-44 | D9 명성과 계보 | P2-22 | 결정 뒤 나눔 | U-15, 기수 결과 보관(FR-REC-03, 대기열 작업 없음) | — | — | 미정 | 결정 대기 |
| T4-45 | D14 계략 패 | P2-23 | 결정 뒤 나눔 | U-16, T4-05, T4-06 | — | — | 미정 | 결정 대기 |
| T4-46 | 시나리오 추가 | P2-24 | Codex → Claude | — | `resources/scenario/` 새 파일, `resources/NOTICE.md` 고지 | 월드 생성·해시 통합 | 0.5일 | 결정 대기 (U-17) |
| T4-47 | Phase 2 통합 회귀와 최종 관문 (C19) | P2-25 | Codex → Claude | 다른 T4 작업 전부 (완료 또는 미완료 목록 등재), 병합 T4-31, T4-48 | `tools/sim/` 확장 프리셋 옵션, `apps/engine/src/ext.coverage.integration.test.ts` | coverage 하한, 확장별·조합·끈 월드 증거, sim 10시드 시간 | 1일 | 선행 대기 |
| T4-48 | 방랑 국가 계약과 통합 (C17) | P2-08 | Codex → Claude | T4-03, T4-14, 병합 T4-18, T4-20, T4-40 | `ext/wander/` | 방랑 국가 전 경로 통합, 기본 국가 골든 | 1일 | 계획 가능, 계약은 U-19·U-21 · MVP 필수 (D-022) |
| T4-49 | 즉시 행동 InputEvent 계약과 처리 틀 (C15) | P2-11, 14, 15 | Codex → Claude | T4-03, G-02, 병합 T4-12, T4-18 | `packages/rules/src/inputs/`, `apps/engine/src/inputs/` | kind별 APPLIED·REJECTED, 멱등 재시도·다른 payload 거부, 재접속 조회, PAUSED·ENDED, 롤백·재생 | 1일 | 계획 가능, 계약은 G-02 · MVP 필수 (D-022) |
| T4-50 | 국가 예턴 resolver 연결 | P2-02 | Codex → Claude | T4-03, T2-05 | `nationTurns` 라우터의 검사 연결 한 곳 (파일은 T2-05 소유) | 켠·끈 월드 국가 명령 HTTP 저장·사전 검사·실행 | 0.5일 | 선행 대기 · MVP 필수 (D-022) |
| T4-51 | 국가 명령 확장 인자 입력 화면 | P2-02 | Claude → Codex | T4-50, T2-06 | T2-06 국가 예턴 화면 옆 `extArgs.ts` (경로는 T2-06 병합 뒤 확정) | E2E 켬·끔 월드 | 0.5일 | 선행 대기 · MVP 필수 (D-022) |
| T4-52 | 모반 규칙 | P2-09 | Codex → Claude | T4-02, T2-13, 병합 T4-48 | `ext/rebellion/` | 미접속 기준·권한 | 0.5일 | 결정 대기 (U-05) · MVP 필수 (D-022) |
| T4-53 | 준비 턴 명령·연구 반영과 엔진 시험 | P2-05, P2-06 | Codex → Claude | T4-07~T4-10, 병합 T4-23 | `apps/engine/src/extPrepared.integration.test.ts` | 연속 칸·중단·재생, 연구 전후 모병 | 0.5일 | 결정 대기 (U-01~U-03) · MVP 필수 (D-022) |
| T4-54 | 토너먼트 경기 규칙 | P2-15 | Codex → Claude | T4-30, 병합 T4-25 | `packages/rules/src/tournament/match.ts` | 같은 시드 같은 결과 | 미정 | 결정 대기 (U-09 종목) |
| T4-55 | 국호·국기 변경권 부여 | P2-10 | Codex → Claude | T4-16 | `ext/nationIdentity/grant.ts` | 부여 조건·1회 | 미정 | 결정 대기 (U-04) · MVP 필수 (D-022) |
| T4-56 | 타임랩스 실제 사건과 과거 이름·색 투영 | P2-17 (2차) | Codex → Claude | T4-35, 병합 T4-31, T4-38 | (가) [T4-56 계획](./T4-56.md) §0의 PR 1·PR 2 파일. (나) 계약 뒤 정함 | 공개 사건 투영 저장·조회, 해산·국호 변경 뒤 과거 프레임 | 미정 | (가) 멸망 국가 보존 저장과 과거 프레임 조회만 D-027 후속 채택(AC-P2-17 (다)). 부모 Codex 2차 기술 검토가 수용했다. PR 1은 로컬 구현을 마쳤고 실제 PostgreSQL 시험 19개, 월간 11개, 전쟁 18개와 빈 DB·기존 DB migration이 통과했다. exact SHA 독립 리뷰와 CI는 아직 없고 main 병합 전이다. PR 2는 로컬 구현을 마쳤고 실제 PostgreSQL 시험 145개, 단위 7개, 타입 검사가 통과했으나 게시 전이다. PR 1은 선행이 없고 PR 2는 T4-35와 PR 1 병합 뒤이며 행 완료는 PR 2까지다. 선행 칸은 (나)의 것이다. (나) 사건 투영·국호 변경은 승인 대기 (A-11), 계약 먼저 |
| T4-57 | [내정 특기 초기화](./mvp-command-gaps.md#t4-57-reset_domestic_trait-내정-특기-초기화) (`reset_domestic_trait`, general) | M1-14 | Codex → Claude | 계약 T4-02, T4-07[준비], T4-25 · 구현 T4-02, T4-07[준비], T4-25 · 연결 T4-03, T4-04 · 결정 U-07, U-01, U-19 | `ext/reset_domestic_trait/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 결정 대기 (U-07) · MVP 필수 (D-022) |
| T4-58 | [전투 특기 초기화](./mvp-command-gaps.md#t4-58-reset_war_trait-전투-특기-초기화) (`reset_war_trait`, general) | M1-14 | Codex → Claude | 계약 T4-02, T4-07[준비], T4-25 · 구현 T4-02, T4-07[준비], T4-25 · 연결 T4-03, T4-04 · 결정 U-07, U-01, U-19 | `ext/reset_war_trait/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 결정 대기 (U-07) · MVP 필수 (D-022) |
| T4-59 | [증여](./mvp-command-gaps.md#t4-59-gift-증여) (`gift`, general) | M1-14 | Codex → Claude | 계약 T4-02 · 구현 T4-02 · 연결 T4-03, T4-04 · 결정 U-19 | `ext/gift/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 계획 가능, 계약은 U-19 · MVP 필수 (D-022) |
| T4-60 | [단련](./mvp-command-gaps.md#t4-60-drill-단련) (`drill`, general) | M1-14 | Codex → Claude | 계약 T4-02 · 구현 T4-02 · 연결 T4-03, T4-04 · 결정 MQ-1, U-19 | `ext/drill/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 결정 대기 (MQ-1) · MVP 필수 (D-022) |
| T4-61 | [숙련전환](./mvp-command-gaps.md#t4-61-convert_proficiency-숙련전환) (`convert_proficiency`, general) | M1-14 | Codex → Claude | 계약 T4-02, T4-60 · 구현 T4-02, T4-60 · 연결 T4-03, T4-04 · 결정 MQ-1, U-19 | `ext/convert_proficiency/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 결정 대기 (MQ-1) · MVP 필수 (D-022) |
| T4-62 | [전투태세](./mvp-command-gaps.md#t4-62-battle_ready-전투태세) (`battle_ready`, general) | M1-14 | Codex → Claude | 계약 T4-02, T4-07[준비], T4-48[방랑] · 구현 T4-02, T4-07[준비], T4-48[방랑] · 연결 T4-03, T4-04 · 결정 U-01, U-19, MQ-1 | `ext/battle_ready/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 결정 대기 (U-01) · MVP 필수 (D-022) |
| T4-63 | [맹훈련](./mvp-command-gaps.md#t4-63-intense_training-맹훈련) (`intense_training`, general) | M1-14 | Codex → Claude | 계약 T4-02, T4-48[방랑] · 구현 T4-02, T4-48[방랑] · 연결 T4-03, T4-04 · 결정 U-19, MQ-1 | `ext/intense_training/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 계획 가능, 계약은 U-19·T4-48 표식 · MVP 필수 (D-022) |
| T4-64 | [견문](./mvp-command-gaps.md#t4-64-travel-견문) (`travel`, general) | M1-14 | Codex → Claude | 계약 T4-02 · 구현 T4-02 · 연결 T4-03, T4-04 · 결정 U-19 | `ext/travel/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 계획 가능, 계약은 U-19 · MVP 필수 (D-022) |
| T4-65 | [은퇴](./mvp-command-gaps.md#t4-65-retire-은퇴) (`retire`, general) | M1-14 | Codex → Claude | 계약 T4-02, T4-07[준비] · 구현 T4-02, T4-07[준비] · 연결 T4-03, T4-04 · 결정 A-08, U-01, U-19 | `ext/retire/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 결정·승인 대기 (A-08) · MVP 필수 (D-022) |
| T4-66 | [인재탐색](./mvp-command-gaps.md#t4-66-scout_talent-인재탐색) (`scout_talent`, general) | M1-14 | Codex → Claude | 계약 T4-02, T4-03 · 구현 T4-02, T4-03 · 연결 T4-04 · 결정 MQ-5, U-19 | `ext/scout_talent/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 계약 먼저 (명령이 만든 장수의 저장) · MVP 필수 (D-022) |
| T4-67 | [물자조달](./mvp-command-gaps.md#t4-67-procure-물자조달) (`procure`, general) | M1-14 | Codex → Claude | 계약 T4-02, T4-48[방랑] · 구현 T4-02, T4-48[방랑] · 연결 T4-03, T4-04 · 결정 U-19 | `ext/procure/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 계획 가능, 계약은 U-19·T4-48 표식 · MVP 필수 (D-022) |
| T4-68 | [장수대상임관](./mvp-command-gaps.md#t4-68-join_general-장수대상임관) (`join_general`, general) | M1-14 | Codex → Claude | 계약 T4-02 · 구현 T4-02 · 연결 T4-03, T4-04 · 결정 MQ-2, U-19(MQ-2에서 임관 경험을 둘 때) | `ext/join_general/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 계획 가능, 계약은 MQ-2·U-19 · MVP 필수 (D-022) |
| T4-69 | [접경귀환](./mvp-command-gaps.md#t4-69-return_border-접경귀환) (`return_border`, general) | M1-14 | Codex → Claude | 계약 T4-02, T4-48[방랑] · 구현 T4-02, T4-48[방랑] · 연결 T4-03, T4-04 · 결정 없음 | `ext/return_border/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 계획 가능, 계약은 T4-48 표식 · MVP 필수 (D-022) |
| T4-70 | [부대 탈퇴 지시](./mvp-command-gaps.md#t4-70-nation_troop_expel-부대-탈퇴-지시) (`nation_troop_expel`, nation) | M1-14 | Codex → Claude | 계약 T4-02, T4-19 · 구현 T4-02, T4-19 · 연결 T4-20, T4-21, T4-50, T4-51 · 결정 T2-05 직책 범위 | `ext/nation_troop_expel/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 선행 대기 (T4-19~T4-21) · MVP 필수 (D-022) |
| T4-71 | [무작위 수도 이전](./mvp-command-gaps.md#t4-71-nation_random_capital-무작위-수도-이전) (`nation_random_capital`, nation) | M1-14 | Codex → Claude | 계약 T4-02, T4-07[준비] · 구현 T4-02, T4-07[준비] · 연결 T4-50, T4-51 · 결정 MQ-4 (UQ-3과 한 묶음), U-01 | `ext/nation_random_capital/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 결정 대기 (MQ-4) · MVP 필수 (D-022) |
| T4-72 | [초토화](./mvp-command-gaps.md#t4-72-nation_scorch-초토화) (`nation_scorch`, nation) | M1-14 | Codex → Claude | 계약 T4-02, T4-07[준비], T2-07[외교] · 구현 T4-02, T4-07[준비], T2-07 또는 T4-03[외교] · 연결 T4-50, T4-51 · 결정 U-01, U-19, MQ-3 | `ext/nation_scorch/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 결정 대기 (U-01) · MVP 필수 (D-022) |
| T4-73 | [증축](./mvp-command-gaps.md#t4-73-nation_expand-증축) (`nation_expand`, nation) | M1-14 | Codex → Claude | 계약 T4-02, T4-07[준비] · 구현 T4-02, T4-07[준비] · 연결 T4-50, T4-51 · 결정 U-01, U-19 | `ext/nation_expand/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 결정 대기 (U-01) · MVP 필수 (D-022) |
| T4-74 | [감축](./mvp-command-gaps.md#t4-74-nation_shrink-감축) (`nation_shrink`, nation) | M1-14 | Codex → Claude | 계약 T4-02, T4-07[준비], T4-73 · 구현 T4-02, T4-07[준비], T4-73 · 연결 T4-50, T4-51 · 결정 U-01, U-19 | `ext/nation_shrink/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 결정 대기 (U-01) · MVP 필수 (D-022) |
| T4-75 | [인구이동](./mvp-command-gaps.md#t4-75-nation_migrate-인구이동) (`nation_migrate`, nation) | M1-14 | Codex → Claude | 계약 T4-02 · 구현 T4-02 · 연결 T4-50, T4-51 · 결정 U-19 | `ext/nation_migrate/` | 명령별 성공·대표 실패, 연결 뒤 대응표 11단계 | 0.5일 | 계획 가능, 계약은 U-19 · MVP 필수 (D-022) |
| T4-76 | [지도 형식 v2(지형 층)와 자원 검증기 (C-M2·C-M3·C-M3a)](./T4-76.md) | P2-27 | Codex → Claude | — | `packages/rules/src/world/map/`, `packages/rules/src/world/validate/` | 종류별 검증 항목 통과·실패, 내장 판 통과 | 1일 | 상세 계획 초안, G-03 전 (D-028) |
| T4-77 | [초기화 자원 카탈로그 DB, 초기화 SQL, JSON 삭제 (C-M1·C-M1a·C-M1b)](./T4-77.md) | P2-26 | Codex → Claude | T4-76, 병합 T4-86, T4-88 (PR 2만) | 새 migration(schema는 §7), `packages/db/sql/resources-init.sql`, `tools/resources-sql/`, `tools/init-resources.ts`, `apps/engine/src/world/resources.ts`, `apps/engine/src/cli/createWorld.ts`, `tools/sim/`, `tools/season-throughput.ts`, `tools/portrait-map/`, JSON 읽는 시험 이전, `tools/run-integration.ts`(한 줄), 루트 `package.json`(script 두 줄), `.github/workflows/simulation.yml`·`ci.yml`·`season-throughput.yml`, `resources/NOTICE.md`, `e2e/rankingSeed.ts`(호출 인자 두 곳, Claude 리뷰) | SQL 두 번 같음, 변환 대조, 이전 전 고정물 재생 해시 같음, DB 시뮬레이터 결과 해시 같음, JSON 0개 | 2.5일 | 상세 계획 초안, G-03 전 (D-028) |
| T4-78 | [자원 초안 저장·판 복제·게시 API와 감사, 모든 종류 (C-M4)](./T4-78.md) | P2-27 | Codex → Claude | T4-77, T3-05 | `apps/server/src/routers/resourceAdmin.ts`, 새 migration(초안 하나 색인과 `baseKey`, schema는 §7) | 권한·제재·무인증 거부, revision 충돌, 게시 판 불변 | 1일 | 상세 계획 초안, G-03 전 (D-028) |
| T4-79 | [월드 생성에서 지도·시나리오 판 고르기](./T4-79.md) | P2-27 | Codex → Claude | T4-78, T2-02 | `apps/engine/src/cli/createWorld.ts` | 새 판으로 월드 생성, 기존 월드 그대로 | 0.5일 | 상세 계획 초안, G-03 전 (D-028) |
| T4-80 | [지도 편집 캔버스 (서버 없이 JSON 가져오기·내보내기, 밑그림 내보내기)](./map-editor.md) | P2-27 | Claude → Codex | T4-76 | `apps/web/src/mapEditor/` | Playwright 도시 추가·이동·삭제, 연결, 지형, 검증 오류, 왕복 | 1.5일 | 계획 가능 (D-028) |
| T4-81 | [편집 캔버스를 관리자 콘솔과 게시 API에 연결](./T4-81.md) | P2-27 | Claude → Codex | T4-80, T4-78, T3-06, T4-76, T3-05, T4-88 | `apps/web/src/admin/maps/`, 관리자 경로 파일은 §7 | E2E 초안 저장·게시, 권한 없는 계정 화면 | 0.5일 | 상세 계획 초안, G-03 전 (D-028) |
| T4-82 | [che 지형 층 초안 그리기](./T4-82.md) | P2-28 | Claude → Codex | T4-80, T4-76 | `tools/map-terrain/che.v2.json`(`resources/` 밖 도구 입력, 도시까지 든 v2 지도), `tools/map-terrain/che.sources.json`, `apps/web/src/mapEditor/terrainSources.ts` | 검증기 통과, 밑그림 내보내기, 래스터 해시 | 1.5일 | 상세 계획 초안, G-03 전 (D-028) |
| T4-83 | [도트 바탕 그림 생성과 출처 기록](./T4-83.md) | P2-28 | Codex → Claude | T4-82, T4-78 | 이미지 저장소 `maps/<정규 키>/base.webp`, `maps/provenance.tsv`, `tools/map-base/` | 밑그림 파일·래스터 해시, 생성 도구·일시 기록, 외부 그림 입력 없음 | 0.5일 | 상세 계획 초안, G-03 전 (D-028) |
| T4-84 | [메인·공개 지도에 바탕 그림 깔기](./T4-84.md) | P2-28 | Claude → Codex | T4-83, T2-25, T4-89 | `apps/web/src/main/WorldMap.tsx` | E2E 그림 있는 판·없는 판 | 0.5일 | 상세 계획 초안, G-03 전 (D-028) |
| T4-85 | [월드의 병종·능력치 규칙 판 조회 API](./T4-85.md) | P2-26 | Codex → Claude | — | `apps/server/src/routers/resources.ts`, 등록 줄은 §7 | 월드별 판 반환, 무인증·다른 월드 범위 시험 | 0.5일 | 상세 계획 초안, G-03 전 (D-028) |
| T4-86 | [전투 시뮬레이터와 E2E가 번들 JSON 대신 API·DB 값 쓰기](./T4-86.md) | P2-26 | Claude → Codex | T4-85 | `apps/web/src/battleSim/`, `e2e/battleSim.spec.ts` | E2E 결과 동일, 번들에 JSON 없음 | 0.5일 | 상세 계획 초안, G-03 전 (D-028) |
| T4-87 | [시나리오·병종·능력치 규칙·초상 대응표 편집 화면](./T4-87.md) | P2-27 | Claude → Codex | T4-78, T3-06, T4-81, T4-76 | `apps/web/src/admin/resources/`, 관리자 경로 파일은 §7 | Playwright 초안 저장·검증 오류·게시, 새 판 월드 생성 | 1.5일 | 상세 계획 초안, G-03 전 (D-028) |
| T4-88 | [편집 캔버스를 rules v2 타입·검증기로 맞추고 che 시험 입력 바꾸기](./map-editor.md#5-작업-순서) | P2-27 | Claude → Codex | T4-76 | `apps/web/src/mapEditor/contract.ts`·`validate.ts`와 그 시험, `e2e/mapEditor.spec.ts` | 편집기 단위·E2E가 rules 타입·검증기로 통과, 화면 소스에 `resources/map/` 경로 없음 | 0.5일 | 계획 가능 (D-028) |
| T4-89 | [`world.map`·`world.publicMaps`의 바탕 그림 칸과 DB 자리](./map-editor.md#4-도트-바탕-지도) | P2-28 | Codex → Claude | T4-78 | `apps/server/src/routers/world.ts`의 두 응답 칸, 새 migration(schema는 §7) | 그림 있는 판·없는 판 응답, 공개 범위 시험이 판 경로 밖의 값을 내지 않음 | 0.5일 | 계획 가능 (D-028) |
| T4-90 | [관리자 월드 생성 양식의 판 고르기](./map-editor.md#5-작업-순서) | P2-27 | Claude → Codex | T4-79, T3-06 | T3-06 관리자 월드 생성 양식의 판 고르기 칸 | E2E 판을 골라 월드 생성, 시나리오의 짝 지도 고정 | 0.5일 | 계획 가능 (D-028) |

`ext/`는 `packages/rules/src/commands/ext/`다. 각 규칙 작업은 명령마다 `<key>.test.ts`에 성공 1건·대표 실패 1건을 두고 T4-02의 확장 대조 시험이 확장 목록과 시험 파일을 자동으로 맞춰 본다.

D7·D8·D9·D14(T4-42~T4-45)와 T4-54~T4-56은 결정이 나면 규칙·조회·화면으로 다시 나누거나 크기를 정한다. 지금 크기를 적으면 근거 없는 숫자가 되므로 미정으로 둔다.

추정이 있는 49개 작업의 합은 한 담당 기준 약 31일이다. Codex 줄이 약 24일, Claude 줄이 약 7일이며 둘은 병렬로 진행한다. 미정 7개는 이 합에 없다.

T4-57~T4-75는 §8 A-02·A-03·A-04에서 온 명령 19개를 [누락 명령 문서](./mvp-command-gaps.md)의 검토(PR #136 `391432c`, 기술 검토 [5611758624](https://github.com/peppone-choi/opensamguk/pull/136#pullrequestreview-5611758624))대로 하나씩 옮긴 행이다. 행마다 상세는 그 문서 5절로 링크했다. 대응표의 key·대상·원본 ID는 PR #67 `5457700`과 같고 `queueIds`에 그 행의 ID만 더했다. 이 편입은 추적 대응이며 제품 정책 승인, 정식 AC 채택, 구현 허가가 아니다.

이 19행의 선행 칸은 그 문서 [4절](./mvp-command-gaps.md#4-19개-대응표)의 세 선행과 결정을 그대로 옮겼다. 계약은 상세 계획이 반대쪽 기술 검토를 통과해야 하는 작업, 구현은 규칙 PR 전에 main에 병합돼 있어야 하는 작업, 연결은 api 이후 단계 증거 전에 병합돼 있어야 하는 작업이다. MQ-1~MQ-5는 그 문서 [7절](./mvp-command-gaps.md#7-소유자-질문-묶음)의 질문이며 §9의 U가 아니다. [준비]는 원작 준비 턴이 있는 8행이 T4-07에 닿는다는 뜻이며 U-01이 준비 턴 없는 한 턴 실행을 고를 때만 빠진다. [방랑]은 4행이 T4-48의 방랑 국가 표식을 기다린다는 뜻이며 국가 규모 0을 방랑으로 읽지 않는다. [외교]는 T4-72가 T2-07 외교 제한 턴 계약을 기다린다는 뜻이며 구현 선행은 그 값의 위치에 따라 T2-07 또는 T4-03이다. 제한 턴 검사와 평시 검사는 빼지 않는다. T4-68의 임관 경험 700·100은 원작 인용이며 MQ-2 (나)에서 경험을 주기로 할 때만 U-19 환산 대상이다.

19행의 추정은 행마다 규칙 PR 하나(0.5일)이며 위 합에 넣지 않았다. T4-66, T4-70, T4-71은 한 PR을 넘을 위험이 있다(그 문서 3.4절).

T4-76~T4-90은 D-028(2026-10-23)로 더한 초기화 자원 DB 이전·지도 편집기·도트 바탕 지도 작업이다. 설계는 [지도 편집기 설계](./map-editor.md)이고 사용자가 같은 날 승인했다. T4-76~T4-79·T4-81~T4-87의 상세 계획은 각 계획 브랜치에 있고 Codex 기술 검토(G-03) 전이라 상태 칸은 계획 준비에 머문다. T4-88~T4-90은 여섯 계획을 대조하며 더한 행이고 상세 계획은 아직 없다. 선행은 [단계 계획](../product/phases.md) Phase 2 표와 같다. T4-77은 PR 1(DB 이전)과 PR 2(JSON 삭제)로 나뉘고 `병합 T4-86, T4-88`은 PR 2에만 걸린다. `e2e/rankingSeed.ts`의 로더 호출 두 곳은 T4-77 PR 1이 고치고 Claude가 리뷰한다(T4-77 Z-5). T4-82 추정은 근거 조사와 네 층 그리기를 반영해 0.5일에서 1.5일로 올렸다(T4-82 MT-5). 추정 합 약 13.5일은 위 합에 넣지 않았다.

### 6.1 준비 단계

| 단계 | 뜻 | 지금 해당 |
| ---- | -- | --------- |
| 계획 준비 | 선행 결정 없이 `T4-xx.md` 상세 계획을 쓸 수 있다 | 상태 칸이 계획 가능인 작업 |
| 계약 준비 | `T4-xx.md`의 입력·출력과 API·DB 계약이 반대쪽 기술 검토를 통과했고 해당 AC-P2가 정식 반영됐다(§1, [작업 계획](./README.md)) | T4-34 (AC-P2-16 (가), D-023). D-027의 T4-01, T4-02 규칙 몫, T4-18, T4-30, T4-35, 후속의 T4-36(AC-P2-17 (나)), T4-56 (가)(AC-P2-17 (다)), T4-05(AC-P2-03 (가)) |
| 구현 준비 | 계약 준비에 더해 구현 선행 작업이 완료됐고 승인·결정·관문이 풀렸다 | T4-34. 구현과 독립 기술 리뷰는 PR #132에서 끝났고 main `494272b`에 병합됐다. D-027의 T4-01·T4-02(규칙 몫)·T4-18·T4-30·T4-35와 T4-56 (가) PR 1. 후속의 T4-05 정의·단위 몫. 이 가운데 T4-01·T4-30·T4-35와 T4-02 규칙 PR 1은 PR #162로 main `7de674d`에, T4-18은 PR #171로 main `01af38b`에 병합됐다. T4-56 PR 2는 T4-35와 PR 1 병합 뒤이고 T4-36의 독립 UI 코드는 병렬로 만들되 실제 E2E와 병합은 T4-35와 T4-56 보존 조회 뒤다 |

상태 칸의 계획 가능은 계획 준비다. 계획 가능 뒤에 붙은 계약 조건은 계약 준비로 올라가기 전에 풀어야 할 것이다. 선행 대기·결정 대기·승인 대기는 아직 계획 준비도 아니다. 계획 준비에 구현 선행의 완료가 필요하지는 않다. T4-48과 T4-49는 선행 작업보다 자기 계약을 먼저 정해야 하는 작업이라 구현 선행이 있어도 계획 가능이다.

T4-15(선양·해산)와 T4-52(모반), T4-16(변경 명령)과 T4-55(변경권 부여), T4-30(대진 틀)과 T4-54(경기), T4-35·T4-36(1차)과 T4-56·T4-37(2차)은 범위와 증거가 따로다. 한쪽의 완료로 같은 AC의 다른 쪽을 완료로 세지 않는다.

## 7. 공유 파일과 반영 순서

확장마다 상태 조각 파일을 둔다(원 작성자 결정, 총괄 확인 필요). `ext/<기능>/state.ts`는 key, 초기값, 복제, 검증을 담은 조각 하나를 내고 `ext/<기능>/commands.ts`는 명령 목록을 낸다. 기능 작업은 자기 폴더에서 개발하고 단위 시험은 조각을 직접 import한다.

아래 공유 반영 파일은 반영 순서 칸의 작업만 고치며 그 순서대로 병합한다. 다른 작업은 이 파일을 고치지 않는다. §6 선행 칸의 `병합` 선행은 이 칸에서 바로 앞 작업이다. 앞 작업이 결정·승인 대기로 막히면 총괄이 이 표를 고쳐 그 작업을 순서 뒤로 옮긴다. S1~S6 순서도 같은 방법으로만 바꾼다.

| 공유 파일 | 반영 순서 | 규칙 |
| --------- | --------- | ---- |
| `packages/db/prisma/schema.prisma`, `migrations/` | T4-56 PR 1 → T4-03 → T4-12 → T4-20 → T4-23 → T4-28 → T4-31 | C8. 기존·공유·적용된 migration은 고치지 않는다. T4-56 PR 1은 `RemovedNation`·`YearbookNation`만 더한다(D-027). T2-24(PR #161 `PublicMapSnapshot`)는 이 표 밖의 기존 작업이며 자기 schema 몫을 그대로 소유한다. 뒤에 병합하는 쪽이 최신 main에서 migration을 새로 만들고 번호 순서는 구현 기록에서 확인한다 |
| 같은 파일, D-028 묶음 | T4-77 PR 1 → T4-78 → T4-89 | T4-77이 `GameResource` 표·enum·CHECK·게시 판 불변 트리거를, T4-78이 초안 하나 부분 유일 색인과 `baseKey` 열을, T4-89가 판마다 바탕 그림 자리를 더한다. 이 묶음은 바로 위 행의 순서와 따로 가며 그 행의 작업과 `병합` 선행을 만들지 않는다. 같은 날 겹치면 뒤에 병합하는 쪽이 최신 main에서 migration을 새로 만든다(T4-77 Z-8, T4-78 Q-06) |
| `apps/server/src/router.ts`, `authz/exemptions.ts`, `tools/authz.integration.test.ts` | T4-35 → T4-12 → T4-49 → T4-20 → T4-23 → T4-28 → T4-31 | 등록 한 줄씩. 권한 증거와 면제는 등록과 같은 PR (C7). T4-56 (가)는 새 절차가 없어 고치지 않는다 |
| 같은 파일, D-028 묶음 | T4-85 → T4-78 (T3-05 뒤) | T4-85는 `resources` 라우터 등록 한 줄과 권한 표, T4-78은 `resourceAdmin` 등록 한 줄, 경로 여섯 줄, 표 두 줄이다. T3-05는 M3 대기열의 작업이라 이 표가 소유하지 않는다. 등록 줄만 더하므로 T4-57~T4-75처럼 병합 직전 최신 main에서 자기 줄을 더하고 바로 위 행의 작업과 `병합` 선행을 만들지 않는다(T4-85 Q1, T4-78 Q-06) |
| T3-06이 만든 관리자 콘솔 경로·메뉴 파일 | T3-06 → T4-81 → T4-87 | 경로·메뉴 한 줄씩. 파일 이름은 T3-06이 정한다. T4-87은 이미 T4-81 뒤라 새 선행이 생기지 않는다. T4-90은 T3-06의 월드 생성 양식 안에 칸을 더하고 경로를 더하지 않는다는 가정이다. 경로가 필요해지면 T4-87 뒤에 둔다(T4-81 Q-81-8) |
| `apps/server/src/visibility.ts` | T4-35 → T4-12 → T4-25 → T4-38 | 비공개 필드 추가는 권한 시험과 같은 PR. T4-56 (가)는 공개 메타데이터만 내므로 고치지 않는다 |
| `apps/server/src/routers/timelapse.ts`, `timelapse.test.ts`, `timelapse.integration.test.ts` | T4-35 → T4-56 PR 2 | T4-56 PR 2는 `items[].nations`만 더하고 라우터 등록·권한·공개 범위는 바꾸지 않는다 |
| `apps/server/src/routers/commands.ts`, `turns.ts`, `game/slots.ts` | T4-03 | resolver 연결은 T4-03 하나만 (C13) |
| T2-05 `nationTurns` 라우터 | T4-50 | 검사 연결 한 곳만. 나머지는 T2-05 소유 |
| `packages/rules/src/commands/ext/registry.ts`, `ext/state.ts` | T4-02 → T4-17 → T4-20 → T4-48 → T4-52 → T4-23 → T4-53 → T4-28 → T4-31 → T4-57~T4-75(ID 오름차순) | 조각 등록만. T4-17이 T4-05·06·11·14·15·16을, T4-53이 T4-08~T4-10을 등록한다. T4-57~T4-75는 등록 줄의 최종 위치일 뿐이다. 각 행은 병합 직전 최신 main에서 자기 줄을 ID 순서 자리에 더하며 이 칸에서 `병합` 선행을 만들지 않는다. 앞 ID의 결정 대기가 뒤 ID의 선행이 되지 않는다 |
| `packages/rules/src/index.ts` | T4-33 → T4-30 → T4-02 → T4-18 → T4-49 → T4-25 → T4-54 | export 한 줄씩. 확장 명령은 `ext/registry.ts` 한 export로 나간다 |
| `packages/rules/src/model/world.ts`, `model/clone.ts`, `replay.ts`, `commands/types.ts`, `commands/turn.ts`, `world/bootstrap.ts` | T4-02 → T4-49 → T4-48 | C13·C14·C15·C17 |
| `packages/rules/src/modifiers/providers.ts` | T4-18 → T4-22 → T4-25 | 등록 한 줄씩. T4-18은 빈 목록으로 만든다(T18-Q2, D-027) |
| `packages/rules/src/commands/attack.ts` | T4-33 → T4-18 → T4-48 | T4-33이 계산을 꺼내고 T4-18은 그 함수에만 수정자 자리를 단다 |
| `packages/rules/src/clock/clock.ts`, `apps/engine/src/world/clock.ts` | T4-40 | C18 |
| `apps/server/src/queries.ts`, 예정 시각을 내는 조회 라우터(지금 `routers/home.ts`, 계약에서 정한 곳) | T4-40 | C18. 휴전 설정 조회, 현재 tick, 첫 칸과 칸별 예정 시각만 |
| `apps/engine/src/turnLoop.ts`, `worldLoader.ts`, `monthly.ts`, `replay.ts`, `persist.ts`, `commandPersistence.ts`, `inputs.ts` | T4-56 PR 1 → T4-03 → T4-49 → T4-40 → T4-48 → T4-07 → T4-28 → T4-31 → T4-47 | 확장 상태 저장은 `extState.ts`, 입력 처리는 `inputs/`에 두고 여기서는 호출만. T4-56 PR 1은 `turnLoop.ts`·`monthly.ts`·`persist.ts`·`commandPersistence.ts`에서 새 `nationArchive.ts` 호출과 `ActionAt` 인자만 더하고 T4-03은 그 인자를 유지한다. T2-24(PR #161)도 `turnLoop.ts`를 고치며 자기 몫을 그대로 소유한다. 뒤에 병합하는 쪽이 `persistEffects` 호출 한 줄을 맞춘다 |
| 엔진·규칙의 입력 처리 목록 (`inputs/` 안, T4-49가 만듦) | T4-49 → T4-20 → T4-28 → T4-31 | kind 등록만 |
| `apps/engine/src/simulation.ts` | T4-48 → T4-47 | 통일 판정은 T4-48, 확장 시나리오 옵션은 T4-47 |
| `apps/web/src/turns/` | T4-04 → T4-41 | T1-15·T1-16 소유. 새 인자 입력은 `extArgs.ts`에 두고 연결 한 곳만 고친다(T4-04). T4-41은 `schedule.ts`의 시각 계산을 서버 예정 시각 표시로 바꾸는 것만 한다(C18). T1-16은 main에서 완료됐다 |
| `apps/web/src/router.tsx`, `layout/GameLayout.tsx` | T4-34 → T4-36 → T4-13 → T4-21 → T4-41 → T4-24 → T4-29 → T4-32 | 경로·메뉴 한 줄씩. D-018과 같은 최소 수정 |
| `tools/command-coverage.test.ts`, `tools/command-coverage.mjs`, `docs/product/command-coverage.json` | D-022 대응표(AC-M1-14) → T4-02 → 각 명령 작업 | T4-02는 확장 목록 대조를 같은 파일에 더한다. 명령 작업은 자기 행의 단계·증거만 고친다 |
| `docs/product/phases.md`, `acceptance-criteria.md`, `decisions.md` | 정식 반영 PR | t_b4277a9e 완료 뒤 한정 hunk. 이 문서의 작업이 직접 고치지 않는다 |

## 8. 승인이 필요한 항목

phases.md Phase 2 목록 밖에 있거나 핵심 규칙을 바꾸는 것, 또는 phases.md 묶음의 범위를 줄이는 것이다. 이 문서의 완료 범위에 넣지도 빼지도 않았다. 넣거나 빼려면 결정 기록에 먼저 남긴다.

| ID | 항목 | 어디에 있나 | 왜 따로 두나 |
| -- | ---- | ----------- | ------------ |
| A-01 | 국가 베팅, 토너먼트 베팅 | 백로그, 원작 `tournament/` | phases.md에 없음. 도박 요소 |
| A-02 | 증여, 인구이동, 증축·감축, 단련·숙련전환·전투태세·맹훈련 | PRD §6.3 | PRD에만 있고 phases.md에 없음 |
| A-03 | 초토화 | PRD §6.3, 원작 화륜차 연구 조건 | phases.md에 없음. 화륜차(T4-10)가 이것을 요구 |
| A-04 | 견문, 은퇴, 인재탐색, 물자조달, 장수대상임관, 특기 초기화, 부대 탈퇴 지시, 무작위 수도 이전, 접경 귀환 | 원작 기본 명령 목록 | 어느 우리 문서에도 없음 |
| A-05 | 동맹 조항(동맹국 땅 출병, 점령지 귀속) | 차별화 D1, T2-07 하지 않는 것 | phases.md Phase 2 목록에 없음 |
| A-06 | 고사 작전, 도시 건설, 국가점수 정책, 통합·합병, 방첩과 발각, 부대 전술, 은퇴 뒤 후계자 | 아이디어 수집 A7·B4·B6·B11·B12·B14·B20 | 백로그 후보 |
| A-07 | 성격 7종·국가 사상 14종의 효과 | 원작 `actionModules/traits/` | phases.md는 특기만 적음 |
| A-08 | 장수 나이·사망, 재해·사건, 기밀실 열람 기록, 상관 지시 덮어쓰기, 국가 단위 방침, 추가 장수 187명 | T1-03·T1-07·T2-09·T2-11·T2-13 하지 않는 것 | 기존 계획이 Phase 2로 미뤘으나 phases.md 목록에 없음 |
| A-09 | 국기 그림, 계략 패 그림 생성 | 백로그 생성 이미지 파이프라인, D-016 | M3 이미지 권리 관문과 묶임 |
| A-10 | 명령 체계 카드 전면 교체, 지도 단위·도시 수 변경, 달력·tick 변경, 능력치 종류 변경, 도시 단위 금·쌀과 도시병사, 여러 턴 행군, 한 국가 여러 군주, 3단계 공방전, 병종 차수, 실시간 전투 | AGENTS §3, 아이디어 수집 B1·B2·B3·B13·A15 | 핵심 규칙 변경. 마감 지시만으로 승인하지 않는다 |
| A-11 | D4를 1차 범위(월간 영토 재생)로 줄여 Phase 2 완료로 셀지, 실제 사건 자막·과거 이름과 색·열전 문구·공유(T4-56, T4-37)를 보류할지 | [차별화 D4](../product/differentiation.md#d4-천하-타임랩스) | 차별화 문서의 D4 기능 목록을 줄이는 범위 변경 |

## 9. 미결정 제품 결정

제품 결정은 이 목록 하나에 모은다. §4 계약과 §8 승인 항목은 여기에 넣지 않는다. 한 줄씩 결정을 받으면 해당 작업이 풀린다. 결정 없이 할 수 있는 범위를 옆 칸에 적었다.

| ID | 결정할 것 | 막는 작업 | 결정 없이 할 수 있는 범위 |
| -- | --------- | --------- | ------------------------- |
| U-01 | 준비 턴 기제를 원작처럼 넣을지(같은 명령을 연속 칸에 예약해야 실행), 준비 턴 없이 한 턴 실행으로 줄일지. 2026-10-23 사용자 직접 결정(D-027): 원작처럼 연속 예약 후 실행. 준비 턴 기간, 명령별 효과·수치, U-02·U-03·U-19는 미결정이며 §6의 [준비] 표시는 남는다. 같은 날 U-19 가운데 T4-05 몫 S0~S7만 정해졌고 T4-05에는 준비 턴이 없다 | T4-07~T4-09, T4-53 | 준비 턴 없는 명령의 계획 (T4-05, T4-06, T4-11, T4-14~T4-16) |
| U-02 | 특수 병종의 전투 특수 효과(원작의 방어력 증가·선제 사격·기병 병종 전투·성벽 부상 무효)를 어디까지 넣을지와 기술 요구치 환산 | T4-09 | 연구 명령의 조건 검사 틀 |
| U-03 | 새 병종 계열(귀병·차병)을 더할지. 병종 체계(A7) 변경이다 | T4-10 | 없음 |
| U-04 | 국호·국기 변경권이 생기는 조건. 원작은 건국 때 국기 1회, 국가 등급 7 도달 때 둘 다인데 우리에게는 국가 등급 상승 규칙이 없다 | T4-55 | T4-16 변경 명령과 이름 검사 |
| U-05 | 모반이 가능한 군주 미접속 기준. 원작은 killturn이고 우리 FR-GEN-04는 아직 확인 대기다 | T4-52 | T4-15 선양·해산 |
| U-06 | 장비 범위: 원작 명마·무기·서적·도구 중 무엇을, 유니크 아이템을 넣을지, 획득 경로 | T4-22 | T4-18 효과 합산 틀 |
| U-07 | 특기 범위(내정 8종, 전투 특기 몇 종)와 새로 만든 장수가 특기를 얻는 규칙 | T4-25 | T4-18 효과 합산 틀 |
| U-08 | 경매 방식: 마감 기준(게임 tick, 실제 시각), 최소 입찰 단위, 유찰, 대상 | T4-27 | 없음 |
| U-09 | 토너먼트 주기, 종목, 보상 | T4-31, T4-54 | T4-30 종목 독립 대진 틀 |
| U-10 | 타임랩스를 로그인 없이 공유할지, 종료된 월드만 공유할지, GIF·영상 내보내기가 필요한지 | T4-37 | T4-35, T4-36 로그인 사용자 재생 |
| U-11 | 안개의 병력 구간 경계와 가릴 항목, 첩보 기록을 몇 개월까지 보여 줄지 | T4-38, T4-39 | T4-11~T4-13 첩보 기록 |
| U-12 | 야간 휴전 기본 시간대와 적용할 프리셋 | T4-40의 기본값 | T4-40 기능 자체(프리셋에서 켤 때만 동작, 기본 꺼짐) |
| U-13 | D7 관계 종류, 자료 출처, 등용·배신·사기 효과 수치 | T4-42 | 없음 |
| U-14 | D8 사건 목록, 선택지, 효과 | T4-43 | 없음 |
| U-15 | D9 칭호 기준과 계정 단위 보관 범위 | T4-44 | 없음 |
| U-16 | D14 패 수, 함정·반격 규칙, 패를 얻는 방법 | T4-45 | 없음 |
| U-17 | 추가할 시나리오 목록. 후보는 지도와 장수 491명 세트가 같은 원작 역사모드(1010·1020·1040·1050·1060·1070·1080·1090·1100·1110·1120) | T4-46 | 후보의 로더 호환 점검 |
| U-18 | NPC가 확장 명령을 쓰게 할지 | NPC 판단 추가 | 확장 명령 전부 (NPC는 지금 판단 그대로) |
| U-19 | 원작 수치를 우리 능력치 3종·tick·금쌀 규모에 옮기는 환산. 작업별 계획이 환산 필요 수치를 표로 올리면 그 표를 받는다 (C10). 2026-10-23 사용자 직접 답(D-027): T4-05 계획 §3의 S0~S7만 승인했다. 다른 작업의 환산과 U-06·U-07은 미결정이다 | T4-05, T4-06, T4-08, T4-11, T4-14, T4-15, T4-19, T4-22, T4-25, T4-48의 계약 | 각 작업의 상세 계획과 원작 그대로 쓰는 수치 |
| U-20 | 타임랩스 1차에서 멸망해 행이 지워진 국가의 프레임 표시(번호만, 공통 색 등). 2026-10-23 사용자 정정(D-027): 멸망한 국가도 저장해 보존한다. 직전의 번호·회색 대체안은 철회됐다. 저장 위치와 DB·API 계약은 Claude 계획과 Codex 기술 검토가 필요하다. 별도 Claude가 T4-56 한정 저장 계획을 작성 중이며 채택 전이다. 같은 날 후속: 부모 Codex 2차 기술 검토가 [T4-56 계획](./T4-56.md) (가)의 저장·조회 계약을 수용해 D-027에 올렸다. 공개 메타데이터(ID·이름·색)만 저장하고 국가의 비공개 상태는 다루지 않는다 | T4-36, 멸망 국가 저장 계약 | T4-35 조회 API |
| U-21 | 방랑 국가가 남아 있을 때의 통일 판정과 도시 재획득·해산 조건 | T4-48의 계약 | T4-14 강행, 방랑 계약의 저장·복원 부분 |

## 10. 지금 계획할 수 있는 것

구현 준비에 이른 작업은 T4-34(D-023)와 D-027으로 채택한 T4-01·T4-02(규칙 몫)·T4-18·T4-30·T4-35, 그 후속의 T4-36·T4-56 (가)·T4-05다. 다른 T4 작업은 모두 `T4-xx.md` 상세 계획과 정식 AC 반영을 먼저 거친다. 채택은 계획 단계이며 AC 통과가 아니다.

상세 계획을 먼저 쓸 후보는 T4-01(next 출력 분리), T4-35(로그인한 사용자의 기존 월간 영토 스냅샷 조회)다. 두 작업은 결정·선행·관문이 없고 새 수치나 전투 규칙을 만들지 않는다. T4-33(기존 출병 전투 계산의 동작 불변 추출)은 PR #129로 main에 병합됐다.

그 밖에 계획 가능인 작업은 T4-02, T4-05, T4-06, T4-11, T4-14~T4-16, T4-19, T4-30, T4-48, T4-49다. T4-02는 C13·C14와 §7 조각 계약을, T4-30은 종목 독립 입력·출력을, T4-49는 G-02를 먼저 정해야 계약 준비가 된다. 규칙 작업 대부분은 U-19 환산을 받아야 계약 준비가 된다.

T4-18은 T4-33 뒤이며 T4-33은 끝났다. T4-34는 T4-33 위에서 구현돼 PR #132로 main에 병합됐다. T4-36의 실제 E2E와 병합은 T4-35와 T4-56 (가) 보존 조회 뒤다. U-20은 D-027으로 정정됐다. 명령을 실제 월드에서 켜는 일(T4-03 이후)은 MVP 작업 T2-02(프리셋)와 G-01을 기다린다. 국가 명령 예약은 T2-05·T2-06, 야간 휴전은 T2-01·T2-02를 기다린다. T1-16은 main에서 완료됐으므로 확장 인자 화면(T4-04)과 휴전 30칸 표시(T4-41)는 T4-03과 T4-40만 기다린다. 결정 대기 작업은 §9 결정이 오기 전에는 착수하지 않는다. D-021의 Phase 2 목표 시각 2026-10-21 23:59:59 KST는 지났고 Phase 2는 완료되지 않았다. 목표 시각은 AC 면제가 아니다.

## 11. 하지 않는 것

- phases.md, acceptance-criteria.md, decisions.md, 기존 T1~T3 계획, 코드, schema, 패키지 수정. 2026-10-22의 D-022 반영은 소유자 정정에 따른 AC-M1-14 작업이며 이 문서의 제안을 정식 반영한 것이 아니다. AC-P2-16의 정식 반영은 D-023의 한정 반영이며 이 문서의 작업이 한 것이 아니다. 2026-10-23 D-027의 네 작업과 T4-18·T4-36·T4-56 (가)·T4-05 후속 반영도 같다
- 원작 코드 복사. 규칙 작업에서 원작을 옮기면 파일 머리에 출처를 적고 `resources/NOTICE.md`에 고지한다
- 비공개 v1 자료 인용·복사
- 새 유료 API, GCP 기동, 운영·게임 초기화, 배포

## 12. 1차 기술 검토 반영

[review 5596831806](https://github.com/peppone-choi/opensamguk/pull/67#pullrequestreview-5596831806)(검토 head `3238c5d`)의 필수 항목을 아래에 반영했다. 이 반영은 기술 계획 보완이며 구현, 제품 정책 승인, 최종 인수가 아니다.

| 항목 | 반영 위치 |
| ---- | --------- |
| R67-1 resolver와 T2-02 허용 목록 | §4 C1·C2, §4.1 C13·G-01, §6 T4-02·T4-03·T4-50·T4-51, AC-P2-02 |
| R67-2 `ext` 저장·복원·재생 | §4 C3, §4.1 C14, §6 T4-02·T4-03 |
| R67-3 즉시 행동 InputEvent | §4 C4, §4.1 C15·G-02, §6 T4-49와 T4-20·T4-28·T4-31 선행 |
| R67-4 공유 파일과 병합 순서 | §4 C8, §4.1 C16, §6 `병합` 선행, §7 |
| R67-5 방랑 | §4.1 C17, §6 T4-14·T4-48, AC-P2-08, U-21 |
| R67-6 미결정과 준비 상태 | §4 C10, §6 상태 칸·§6.1, T4-15·T4-16·T4-30 분리(T4-52·T4-55·T4-54), §9 U-19, §10 |
| R67-7 D4 범위 | §4.1 C20, AC-P2-17, §6 T4-35·T4-36·T4-56, §8 A-11, §9 U-20 |
| R67-8 휴전 시계 | §4.1 C18, AC-P2-19, §6 T4-40·T4-41, §7 `queries.ts`·`apps/web/src/turns/` 행 |
| R67-9 확장 실행 coverage | §4 C11, §4.1 C19, AC-P2-25, §6 T4-47 |

재검토 [review 5597509665](https://github.com/peppone-choi/opensamguk/pull/67#pullrequestreview-5597509665)(검토 head `35e58f6`)의 R67-8-R은 C18의 예정 시각 역변환·체크포인트·서버 연결·30칸 표시, AC-P2-19, T4-40·T4-41, §7 두 행에 반영했다. 30칸 시각을 서버가 계산하는 방식은 총괄 결정이고 필드 이름과 응답 위치는 T4-40.md 계약 검토에서 정한다. T4-40 추정이 1일에서 1.5일로 늘어 합이 31일이 됐다.

main `2380904`까지 병합하면서 main에 생긴 사실을 반영했다. `5432ee8`과 `2380904` 사이에는 문서 문구만 바뀌어 코드 경로는 같다. T1-16 완료와 D-020의 메인 편집기 결합은 C18, §6 T4-41, §7 `apps/web/src/turns/` 행, §10에 넣었다. T3-04의 권한 대조와 요청 제한은 C7, C15, AC-P2-25, §7 `router.ts` 행에 넣었다. 이미 있는 `records.world`와 국가 사건 기록은 C20, AC-P2-17, §6 T4-35에 넣었다. D-021의 목표 시각이 지난 것은 §10에 적었다. 작업 수와 추정 합은 그대로다. 이 반영도 반대쪽 기술 재검토를 받아야 한다.

## 리뷰 (Codex)

- 결과:
- 확인한 것:
- 고칠 것:
