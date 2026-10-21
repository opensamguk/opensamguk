# Phase 2 확장 기술 명세 (제안)

> 상태: 제안 초안 (2026-10-21) · 기준 main `888a4df` · 계획: Claude · 기술 검토: Codex
> 근거: [단계 계획 Phase 2](../product/phases.md#phase-2-확장-mvp-뒤), [백로그](../product/backlog.md), [차별화 기능 후보](../product/differentiation.md), [요구사항 §4](../product/requirements.md#4-범위-밖), [PRD §6.3](../product/prd.md)
> 이 문서의 AC-P2와 T4 작업은 **제안**이다. 인수조건·단계 계획·결정 기록에는 아직 들어가지 않았다.

## 1. 이 문서의 위치

Phase 2는 M2가 아니다. M2는 지인 테스트 관문(MVP의 일부)이고 Phase 2는 MVP 위에 덧대는 확장이다. 그래서 다음을 지킨다.

- main에 이미 있는 엔진, 명령 37개, 월간 정산, 재생, 순위는 Phase 2의 바탕이다. Phase 2 성과로 세지 않는다.
- M1·M2·M3 AC는 Phase 2 완료 근거가 될 수 없다. 반대로 AC-P2는 MVP 관문에 들어가지 않는다.
- M2가 요구하는 두 번째 시나리오(PRD §6.4의 공백지 180년, AC-M2-01)는 M2 범위다. 아래 시나리오 추가(AC-P2-24)에서 세지 않는다.
- 계획 작성과 Codex 기술 검토는 구현 완료나 세부 정책 승인이 아니다. 세부 정책은 §9의 결정 목록으로 따로 받는다.

정식 반영은 원 소유자 문서 통합 카드(t_b4277a9e)가 끝난 뒤 별도 PR에서 한정 hunk로 한다. 그때 [단계 계획](../product/phases.md)에 Phase 2 대기열 표, [인수조건](../product/acceptance-criteria.md)에 Phase 2 절, [결정 기록](../product/decisions.md)에 이 분해를 채택하는 결정 한 건을 넣는다. 그 전에는 phases.md에 T4 행을 넣지 않는다 (§3).

기존 T1~T3 계획, 코드, schema, 패키지는 이 문서에서 고치지 않는다.

## 2. 범위 대조

[단계 계획 Phase 2](../product/phases.md#phase-2-확장-mvp-뒤)의 묶음을 빠짐없이 옮겼다. 원작 근거는 공개 저장소 core2026 고정 커밋 `df6c926`(MIT)의 경로다. 비공개 v1 자료는 쓰지 않았다.

| 묶음 | phases.md 원문 | 원작 공개 근거 (`df6c926`) | AC | 작업 |
| ---- | -------------- | -------------------------- | -- | ---- |
| 명령 틀 | (모든 명령 확장의 공통 바탕) | `resources/turn-commands/default.json` | AC-P2-02 | T4-02~T4-04, T4-17 |
| 계략 4종 | 계략 | `actions/turn/general/che_화계`·`che_파괴`·`che_선동`·`che_탈취` | AC-P2-03 | T4-05 |
| 전략 명령 8종 | 전략 명령 | `actions/turn/nation/che_백성동원`·`che_이호경식`·`che_급습`(준비 턴 0), `che_필사즉생`·`che_수몰`·`che_의병모집`(2), `che_허보`·`che_피장파장`(1) | AC-P2-04, AC-P2-05 | T4-06~T4-08 |
| 특수 병종 연구 9종 | 특수 병종 연구 | `actions/turn/nation/event_극병연구` 등 9개, `eventResearch.ts`(준비 턴 23), `resources/unitset/unitset_event_more_crewtype.json` | AC-P2-06 | T4-09, T4-10 |
| 첩보 | 첩보 | `actions/turn/general/che_첩보` | AC-P2-07 | T4-11~T4-13 |
| 강행·방랑 | 강행·방랑 | `che_강행`(거리 3 이내 이동), `che_방랑` | AC-P2-08 | T4-14 |
| 선양·모반·해산 | 선양·모반·해산 | `che_선양`, `che_모반시도`(`constraints/general.ts` allowRebellion), `che_해산` | AC-P2-09 | T4-15 |
| 국호·국기 변경 | 국호·국기 변경 | `actions/turn/nation/che_국호변경`·`che_국기변경`(국기 = 국가 색 번호) | AC-P2-10 | T4-16 |
| 부대 | 부대(집합) | `che_집합`, `troop/management.ts` | AC-P2-11 | T4-19~T4-21 |
| 장비·아이템 | 장비·아이템 | `items/`, `che_장비매매` | AC-P2-12 | T4-18, T4-22~T4-24 |
| 특기 | 특기 | `actionModules/traits/domestic/`(8종), `war/triggers/` | AC-P2-13 | T4-18, T4-25, T4-26 |
| 경매 | 경매 | `auction/` | AC-P2-14 | T4-27~T4-29 |
| 토너먼트 | 토너먼트 | `tournament/` | AC-P2-15 | T4-30~T4-32 |
| 전투 시뮬레이터 | 전투 시뮬레이터 | `battleSimulator/`, `docs/architecture/battle-simulator-browser-worker.md` | AC-P2-16 | T4-33, T4-34 |
| D4 천하 타임랩스 | D4 | (우리 기능) `YearbookSnapshot.data.cities`가 달마다 도시 소유를 이미 저장 | AC-P2-17 | T4-35~T4-37 |
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
| C1 | 확장 명령은 `packages/rules/src/commands/ext/`에 두고 별도 목록(`extensionCommands`)으로 등록한다. 기존 `commandRegistry`의 37개와 `registry.test.ts` 대조는 바꾸지 않는다 | AC-M1-14 보존 |
| C2 | 확장 명령은 월드 프리셋(T2-02 `World.preset`)의 `commands.general`·`commands.nation` 허용 목록에 key가 명시될 때만 켜진다. 허용 목록이 없을 때의 전체는 기본 목록만 뜻한다. 꺼진 명령은 `turns.precheck`와 실행 검사 모두 `COMMAND_DISABLED`로 실패하고 `commands.list`에 나오지 않는다. T2-02 구현이 이 해석과 다르면 Codex 기술 검토가 T2-02 담당에 연결한다 (이 문서는 T2-02를 고치지 않는다) | T2-02 결정 표 |
| C3 | 확장 상태는 확장을 켠 월드에만 생긴다. 끈 월드의 `WorldState`에는 새 칸이 없어 상태 해시와 12개월 재생 결과가 지금과 같다 | AC-M1-13 |
| C4 | 게임 상태는 엔진만 바꾼다. 턴을 쓰지 않는 즉시 행동(부대 가입·탈퇴, 경매 입찰, 토너먼트 참가)은 API가 `InputEvent`로만 기록하고 엔진이 처리해 재생에 남긴다 | AGENTS §6, D-014 |
| C5 | 한 턴과 한 달의 상태 변경, 새 테이블 행, 로그, 예턴 당김은 지금처럼 리스·월드 행을 잠근 한 트랜잭션에 저장한다. 새 저장마다 commit 직전 실패 롤백과 SIGKILL 재시작 시험을 둔다 | FR-ENG-04·05 |
| C6 | 난수는 `packages/shared`의 시드 RNG만 쓴다. 브라우저 전투 시뮬레이터도 같은 RNG와 같은 계산 함수를 쓴다 | NFR-01 |
| C7 | API는 Codex가 `AppRouter`에서 단독 소유한다. 화면은 타입만 import한다. 새 프로시저마다 성공과 무인증·다른 사용자·제재·잘못된 입력 시험을 두고 행위자는 세션에서 정한다 | AGENTS §7 |
| C8 | Prisma schema와 migration은 Codex만 고치고 새 migration만 만든다. 병합은 S1(T4-03) → S2(T4-12) → S3(T4-20) → S4(T4-23) → S5(T4-28) → S6(T4-31) 순서로 직렬화한다. 뒤 PR은 병합 직전 최신 main에서 migration을 다시 만든다 | AGENTS §9 |
| C9 | 다른 국가의 비공개 값은 `apps/server/src/visibility.ts`를 거쳐서만 나간다. 첩보 기록, 타임랩스, 시뮬레이터 기본값도 이 경로를 지난다 | FR-GEN-05, D-019 |
| C10 | 새 수치와 알고리즘은 core2026 `df6c926`의 공개 코드에서 출발하고 파일 경로를 계획에 적는다. 우리 능력치 3종과 tick 체계에 맞게 줄인 부분은 설계 문서에 한 줄씩 남긴다. 원작에 없는 수치는 정하지 않고 §9 결정으로 보낸다 | D-001, AGENTS §5 |
| C11 | NPC AI는 §9 U-18 결정 전까지 확장 명령을 쓰지 않는다. 새 판단을 넣지 않는 것이며 정책을 정한 것이 아니다 | AC-M1-17 보존 |
| C12 | 화면·게임 문구와 문서는 [글쓰기 규칙](../writing-style.md)을 따르고 `pnpm lint:text --strict`가 0건이다. 새 그림(국기 그림, 계략 패)은 만들지 않는다. 국기는 원작처럼 국가 색 번호다 | D-017, D-016 |

완료 증거는 작업마다 실제로 돌린 것만 인정한다. 규칙은 `pnpm check`의 단위 시험, 저장은 `pnpm test:int`(실제 PostgreSQL), API는 실제 HTTP 소켓 시험, 화면은 `pnpm e2e`(Chromium), 결정성은 12개월 재생 해시, 성능은 `pnpm sim --seeds 10`의 시간 기록이다. skip이나 mock만으로 통과시키지 않는다.

## 5. 인수조건 제안

상태는 모두 제안이며 미착수다. 정식 반영 때 [인수조건](../product/acceptance-criteria.md) 형식으로 옮긴다.

| ID | 조건 | 검증 방법 |
| -- | ---- | --------- |
| AC-P2-01 | `pnpm next`가 T4 작업을 Phase 2 절로 따로 보여 주고 M4로 표시하지 않는다. 지금의 M1~M3 출력과 현재 관문 계산은 그대로다. T4 행의 선행에 T1~T3 ID를 쓸 수 있다 | next-task 단위 시험 + 현재 phases.md 출력 전후 비교 |
| AC-P2-02 | 확장 명령은 월드 프리셋 허용 목록에 key가 있을 때만 예턴에 넣고 실행된다. 꺼진 월드에서는 사전 검사·실행 모두 거부되고 명령 목록에 없다. 꺼진 월드의 명령 37개 대조와 12개월 재생 해시는 바뀌지 않는다. 확장 상태는 턴과 같은 트랜잭션에 저장되고 재생된다 | rules 단위 + PostgreSQL 통합(롤백·SIGKILL·재생) + HTTP 권한 + E2E |
| AC-P2-03 | 계략 4종(화계·파괴·선동·탈취)이 대상 도시와 장수에 효과를 내고 실패하면 이유가 장수 로그에 남는다. 명령마다 성공·대표 실패 시험이 있고 같은 시드면 결과가 같다 | rules 단위 + 엔진 통합·재생 |
| AC-P2-04 | 준비 턴이 없는 전략 명령 3종(백성동원·이호경식·급습)은 권한 있는 직책만 실행하고 실행 뒤 재사용 대기 동안 같은 국가가 다시 쓰지 못한다 | rules 단위 + 엔진 통합 + 권한 시험 |
| AC-P2-05 | 준비 턴이 있는 전략 명령 5종(필사즉생·수몰·의병모집·허보·피장파장)이 U-01에서 정한 방식대로 준비·실행된다 | U-01 결정 뒤 확정 |
| AC-P2-06 | 특수 병종 연구 9종 가운데 승인된 병종은 연구를 마친 국가만 모병·징병한다. 기술·도시 조건이 맞지 않으면 사전 검사가 이유를 보인다. 연구 전 국가와 확장을 끈 월드는 기존 병종만 쓴다 | rules 단위 + 엔진 통합·재생 (U-01~U-03 뒤) |
| AC-P2-07 | 첩보하면 대상 도시의 그 시점 정보가 자기 국가에만 보이는 기록으로 남고 기록 시각이 함께 보인다. 다른 국가와 무인증의 조회는 거부된다 | rules 단위 + PostgreSQL + HTTP 권한 + E2E |
| AC-P2-08 | 강행은 원작 근거의 거리 안 도시로 한 턴에 이동한다. 방랑을 고른 국가는 도시 없이 남고 원작 근거의 조건에서 다시 도시를 얻거나 해산한다 | rules 단위 + 엔진 통합·재생 |
| AC-P2-09 | 선양은 군주 자리를 같은 국가 장수에게 넘긴다. 모반은 군주 미접속 기준(U-05)을 넘었을 때만 성공한다. 해산은 원작 근거 조건에서만 된다. 권한 없는 장수의 같은 명령은 거부된다 | rules 단위 + 엔진 통합 + 권한 시험 |
| AC-P2-10 | 변경권이 있는 국가의 군주가 국호와 국가 색을 바꾼다. 건국과 같은 이름 검사를 거치고 변경권을 쓴 뒤에는 다시 못 바꾼다 | rules 단위 + 엔진 통합 |
| AC-P2-11 | 부대를 만들고 가입·탈퇴하면 InputEvent로 처리된다. 부대장이 집합을 실행하면 같은 국가 부대원이 부대장 도시로 모인다. 다른 국가 부대 조작은 거부된다 | rules 단위 + PostgreSQL + HTTP 권한 + E2E |
| AC-P2-12 | 장수가 장비를 사고팔고 장착한 장비의 효과가 내정·전투 계산에 들어간다. 장비가 없는 장수의 결과는 지금과 같다(골든) | rules 골든 + 통합 + E2E |
| AC-P2-13 | 장수의 특기가 승인된 범위(U-07)의 내정·전투 계산에 들어간다. 특기가 없는 장수와 확장을 끈 월드의 결과는 지금과 같다(골든) | rules 골든 + 통합 + E2E |
| AC-P2-14 | 경매에 입찰하면 InputEvent로 기록되고 마감 때 최고 입찰자에게 낙찰된다. 낙찰·환불이 한 트랜잭션에 저장되고 재생된다 | rules 단위 + PostgreSQL(롤백·재생) + HTTP 권한 + E2E |
| AC-P2-15 | 토너먼트 참가가 InputEvent로 기록되고 같은 시드면 대진과 결과가 같다. 보상이 한 트랜잭션에 저장된다 | rules 단위 + PostgreSQL + HTTP 권한 + E2E |
| AC-P2-16 | 전투 시뮬레이터에 양쪽 병력·병종·훈련·사기·기술을 넣으면 Web Worker에서 실제 출병과 같은 계산 함수로 결과를 낸다. 같은 입력·시드면 실제 전투와 결과가 같다. 계산 중에도 입력이 막히지 않는다. 다른 국가의 비공개 값을 자동으로 채우지 않는다 | rules 골든 + Chromium E2E |
| AC-P2-17 | 기록 화면에서 월드의 달별 도시 소유 변화를 재생하고 건국·멸망·점령을 자막으로 본다. 자막은 달별 연감의 소유 차이로 만든다. 응답에 국고·군량 같은 비공개 값이 없다 | PostgreSQL + HTTP 권한 + Chromium E2E |
| AC-P2-18 | 다른 국가 도시의 상세값은 첩보 기록으로만 보이고 몇 개월 전 기록인지 표시된다. 적 병력은 U-11에서 정한 구간으로 보인다 | HTTP 권한 + E2E (U-11 뒤) |
| AC-P2-19 | 휴전 시간대를 정한 월드는 그 시간에 게임 시계가 멈추고 끝나면 이어서 진행한다. 정하지 않은 월드는 지금과 같다 | 시계 주입 통합 + 재시작 시험 |
| AC-P2-20 | D7 인물 관계망 | U-13 결정 뒤 확정 |
| AC-P2-21 | D8 역사 사건 선택지 | U-14 결정 뒤 확정 |
| AC-P2-22 | D9 명성과 계보. 다음 기수에는 꾸미기만 반영하고 능력 혜택은 없다 | U-15 결정 뒤 확정 |
| AC-P2-23 | D14 계략 패. 계략만 패로 묶고 다른 명령은 그대로다 | U-16 결정 뒤 확정 |
| AC-P2-24 | 승인된 추가 시나리오마다 월드를 만들면 도시·국가·장수가 저장되고 같은 시드 두 번의 상태 해시가 같다 | 통합 시험 (AC-M1-03 방식) |
| AC-P2-25 | 확장을 모두 켠 프리셋으로 `pnpm sim --seeds 10`이 오류 없이 끝나고 최장 시간이 AC-M1-18 기준 안이다. 확장을 끈 기본 월드의 재생 해시가 바뀌지 않는다. 새 API 전부가 AC-M3-03의 권한 대조 목록에 들어 있다 | sim 기록 + 재생 + 권한 대조 |

## 6. 작업 분해

추정은 한 담당 기준이고 한 줄이 PR 하나 크기다. 오늘 칸의 뜻: 가능은 선행이 없거나 오늘 끝날 Phase 2 선행만 있음, 선행 대기는 MVP 작업이 끝나야 함, 결정 대기는 §9 결정이 있어야 함.

| ID | 작업 | AC | 구현 → 리뷰 | 선행 | 단독 소유 경로 (공유는 §7) | 증거 | 추정 | 오늘 |
| -- | ---- | -- | ----------- | ---- | -------------------------- | ---- | ---- | ---- |
| T4-01 | `pnpm next` Phase 2 절 | P2-01 | Claude → Codex | — | `tools/next-task.mjs`, `tools/next-task.test.ts` | 단위 시험, 출력 전후 비교 | 0.5일 | 가능 |
| T4-02 | 확장 명령 틀 (순수 규칙) | P2-02 | Codex → Claude | — | `packages/rules/src/commands/ext/registry.ts`, `ext/state.ts` | 37개 대조 유지, 끈 월드 재생 해시 불변 | 0.5일 | 가능 |
| T4-03 | 확장 상태 저장과 명령 켜기 (S1) | P2-02 | Codex → Claude | T4-02, T2-02 | 새 migration, `apps/engine/src/extState.ts` | 롤백·SIGKILL·재생, HTTP 권한 | 1일 | 선행 대기 |
| T4-04 | 확장 명령 인자 입력 화면 | P2-02 | Claude → Codex | T4-03, T1-16 | `apps/web/src/turns/extArgs.ts` | E2E 켬·끔 월드 | 0.5일 | 선행 대기 |
| T4-05 | 계략 4종 규칙 | P2-03 | Codex → Claude | T4-02 | `ext/stratagem.ts` | 명령별 성공·실패, 같은 시드 | 0.5일 | 가능 |
| T4-06 | 전략 명령 3종 규칙 (준비 턴 없음) | P2-04 | Codex → Claude | T4-02 | `ext/strategy.ts` | 성공·실패·재사용 대기·권한 | 0.5일 | 가능 |
| T4-07 | 준비 턴 기제 | P2-05 | Codex → Claude | T4-03 | `ext/prepare.ts`, `apps/engine/src/extPrepare.ts` | 연속 칸·중단·재생 | 1일 | 결정 대기 (U-01) |
| T4-08 | 전략 명령 5종 규칙 (준비 턴 있음) | P2-05 | Codex → Claude | T4-07 | `ext/strategyPrepared.ts` | 명령별 성공·실패 | 0.5일 | 결정 대기 (U-01) |
| T4-09 | 특수 병종 연구 6종 (보·궁·기 계열) | P2-06 | Codex → Claude | T4-07 | `ext/research.ts`, `resources/unitset/` 확장 파일 | 연구 전후 모병, 재생 | 0.5일 | 결정 대기 (U-01·U-02) |
| T4-10 | 특수 병종 3종 (음귀병·무희·화륜차) | P2-06 | Codex → Claude | T4-09 | `ext/research.ts` 이어서 | 새 계열 상성 | 0.5일 | 결정 대기 (U-03, A-03) |
| T4-11 | 첩보 규칙 | P2-07 | Codex → Claude | T4-02 | `ext/intel.ts` | 거리·성공·실패·기록 내용 | 0.5일 | 가능 |
| T4-12 | 첩보 기록 저장·조회 API (S2) | P2-07 | Codex → Claude | T4-03, T4-11 | `apps/server/src/routers/intel.ts`, 새 migration | PostgreSQL, HTTP 권한 4종 | 0.5일 | 선행 대기 |
| T4-13 | 첩보 기록 화면 | P2-07 | Claude → Codex | T4-12 | `apps/web/src/intel/` | E2E | 0.5일 | 선행 대기 |
| T4-14 | 강행·방랑 규칙 | P2-08 | Codex → Claude | T4-02 | `ext/movement.ts`, `ext/wander.ts` | 거리·방랑 국가 수명 | 0.5일 | 가능 |
| T4-15 | 선양·모반·해산 규칙 | P2-09 | Codex → Claude | T4-02, T2-13 | `ext/succession.ts` | 권한·미접속 기준 | 0.5일 | 선행 대기 (모반만), 선양·해산은 가능 |
| T4-16 | 국호·국기 변경 규칙 | P2-10 | Codex → Claude | T4-02 | `ext/nationIdentity.ts` | 이름 검사·변경권 | 0.5일 | 가능 (변경권은 U-04) |
| T4-17 | 확장 명령 엔진 연결 시험 | P2-03, 04, 07~10 | Codex → Claude | T4-03, T4-05, T4-06, T4-11, T4-14~T4-16 | `apps/engine/src/ext.integration.test.ts` | 실행·롤백·12개월 재생 | 0.5일 | 선행 대기 |
| T4-18 | 효과 합산 틀 (장비·특기 공용) | P2-12, P2-13 | Codex → Claude | T4-33 | `packages/rules/src/modifiers/` | 수정자 없을 때 내정·전투 골든 불변 | 0.5일 | 가능 (T4-33 뒤) |
| T4-19 | 부대 규칙과 집합 | P2-11 | Codex → Claude | T4-02 | `ext/troop.ts` | 집합 이동·국가 경계 | 0.5일 | 가능 |
| T4-20 | 부대 저장·즉시 행동 API (S3) | P2-11 | Codex → Claude | T4-03, T4-19 | `apps/server/src/routers/troop.ts`, `apps/engine/src/troopInputs.ts` | InputEvent 재생, HTTP 권한 | 1일 | 선행 대기 |
| T4-21 | 부대 화면 | P2-11 | Claude → Codex | T4-20 | `apps/web/src/troop/` | E2E | 0.5일 | 선행 대기 |
| T4-22 | 장비 목록과 장비매매 규칙 | P2-12 | Codex → Claude | T4-18 | `ext/equipment.ts`, `resources/items/` | 매매·장착 골든 | 0.5일 | 결정 대기 (U-06) |
| T4-23 | 장비 저장·조회 API (S4) | P2-12 | Codex → Claude | T4-03, T4-22 | `apps/server/src/routers/equipment.ts`, 새 migration | PostgreSQL, HTTP 권한 | 0.5일 | 선행 대기 |
| T4-24 | 장비 화면 | P2-12 | Claude → Codex | T4-23 | `apps/web/src/equipment/` | E2E | 0.5일 | 선행 대기 |
| T4-25 | 특기 효과 규칙과 조회 필드 | P2-13 | Codex → Claude | T4-18 | `packages/rules/src/traits/` | 특기별 골든 | 0.5일 | 결정 대기 (U-07) |
| T4-26 | 특기 표시 화면 | P2-13 | Claude → Codex | T4-25 | `apps/web/src/general/Traits.tsx` | E2E | 0.5일 | 선행 대기 |
| T4-27 | 경매 규칙 | P2-14 | Codex → Claude | T4-22 | `ext/auction.ts` | 입찰·낙찰·유찰 | 0.5일 | 결정 대기 (U-08) |
| T4-28 | 경매 저장·입찰 API·마감 (S5) | P2-14 | Codex → Claude | T4-23, T4-27 | `apps/server/src/routers/auction.ts`, `apps/engine/src/auction.ts` | 롤백·재생, HTTP 권한 | 1일 | 선행 대기 |
| T4-29 | 경매 화면 | P2-14 | Claude → Codex | T4-28 | `apps/web/src/auction/` | E2E | 0.5일 | 선행 대기 |
| T4-30 | 토너먼트 규칙 (대진과 경기) | P2-15 | Codex → Claude | — | `packages/rules/src/tournament/` | 같은 시드 같은 대진 | 0.5일 | 가능 (주기·보상은 U-09) |
| T4-31 | 토너먼트 저장·참가 API·진행 (S6) | P2-15 | Codex → Claude | T4-03, T4-30 | `apps/server/src/routers/tournament.ts`, `apps/engine/src/tournament.ts` | 롤백·재생, HTTP 권한 | 1일 | 결정 대기 (U-09) |
| T4-32 | 토너먼트 화면 | P2-15 | Claude → Codex | T4-31 | `apps/web/src/tournament/` | E2E | 0.5일 | 선행 대기 |
| T4-33 | 전투 계산 공개 함수 | P2-16 | Codex → Claude | — | `packages/rules/src/battle/simulate.ts` | 출병 결과와 골든 일치 | 0.5일 | 가능 |
| T4-34 | 전투 시뮬레이터 화면 (Web Worker) | P2-16 | Claude → Codex | T4-33 | `apps/web/src/battleSim/` | Chromium E2E, Worker 실행 | 0.5일 | 가능 (T4-33 뒤) |
| T4-35 | 타임랩스 조회 API | P2-17 | Codex → Claude | — | `apps/server/src/routers/timelapse.ts` | PostgreSQL, HTTP 권한, 응답 시간 | 0.5일 | 가능 |
| T4-36 | 타임랩스 재생 화면 | P2-17 | Claude → Codex | T4-35 | `apps/web/src/timelapse/` | Chromium E2E | 0.5일 | 가능 (T4-35 뒤) |
| T4-37 | 타임랩스 공유·내보내기 | P2-17 | Claude → Codex | T4-36 | `apps/web/src/timelapse/export.ts` | E2E | 0.5일 | 결정 대기 (U-10) |
| T4-38 | 안개 조회 규칙 | P2-18 | Codex → Claude | T4-12 | `apps/server/src/fog.ts` | HTTP 권한, 구간 경계 | 0.5일 | 결정 대기 (U-11) |
| T4-39 | 안개 화면 | P2-18 | Claude → Codex | T4-38 | `apps/web/src/intel/Fog.tsx` | E2E | 0.5일 | 결정 대기 (U-11) |
| T4-40 | 야간 휴전 시계 | P2-19 | Codex → Claude | T2-01, T2-02 | `apps/engine/src/world/truce.ts` | 시계 주입·재시작 | 0.5일 | 선행 대기 (기본 꺼짐, 기본 시간대는 U-12) |
| T4-41 | 휴전 표시 화면 | P2-19 | Claude → Codex | T4-40 | `apps/web/src/layout/TruceNotice.tsx` | E2E | 0.5일 | 선행 대기 |
| T4-42 | D7 인물 관계망 | P2-20 | 결정 뒤 나눔 | U-13 | — | — | 미정 | 결정 대기 |
| T4-43 | D8 역사 사건 선택지 | P2-21 | 결정 뒤 나눔 | U-14 | — | — | 미정 | 결정 대기 |
| T4-44 | D9 명성과 계보 | P2-22 | 결정 뒤 나눔 | U-15, 기수 결과 보관(FR-REC-03, 대기열 작업 없음) | — | — | 미정 | 결정 대기 |
| T4-45 | D14 계략 패 | P2-23 | 결정 뒤 나눔 | U-16, T4-05, T4-06 | — | — | 미정 | 결정 대기 |
| T4-46 | 시나리오 추가 | P2-24 | Codex → Claude | — | `resources/scenario/` 새 파일, `resources/NOTICE.md` 고지 | 월드 생성·해시 통합 | 0.5일 | 결정 대기 (U-17) |
| T4-47 | Phase 2 통합 회귀 | P2-25 | Codex → Claude | T4-17, T4-20, T4-23, T4-28, T4-31, T4-40 | `tools/sim/` 확장 프리셋 옵션 | sim 10시드 시간, 재생, 권한 대조 | 0.5일 | 선행 대기 |

`ext/`는 `packages/rules/src/commands/ext/`다. 각 규칙 작업은 명령마다 `<key>.test.ts`에 성공 1건·대표 실패 1건을 두고 T4-02의 확장 대조 시험이 확장 목록과 시험 파일을 자동으로 맞춰 본다.

D7·D8·D9·D14(T4-42~T4-45)는 결정이 나면 규칙·조회·화면으로 다시 나눈다. 지금 크기를 적으면 근거 없는 숫자가 되므로 미정으로 둔다.

추정이 있는 43개 작업의 합은 한 담당 기준 약 24일이다. Codex 줄이 약 17.5일, Claude 줄이 약 6.5일이며 둘은 병렬로 진행한다. D7·D8·D9·D14는 이 합에 없다.

## 7. 공유 파일과 반영 순서

| 공유 파일 | 고치는 작업 | 규칙 |
| --------- | ----------- | ---- |
| `packages/db/prisma/schema.prisma`, `migrations/` | T4-03, T4-12, T4-20, T4-23, T4-28, T4-31 | C8 순서대로 병합. 기존 migration은 고치지 않는다 |
| `apps/server/src/router.ts` | T4-12, T4-20, T4-23, T4-28, T4-31, T4-35 | 등록 한 줄씩. 병합 직전 최신 main에 다시 맞춘다 |
| `apps/server/src/visibility.ts` | T4-12, T4-25, T4-38 | 비공개 필드 추가는 권한 시험과 같은 PR |
| `apps/server/src/routers/commands.ts`, `turns.ts` | T4-03 | 확장 켜기 검사는 T4-03 하나만 넣는다 |
| `packages/rules/src/model/world.ts` | T4-02 | 선택 칸 `ext`만 추가. 이후 작업은 `ext/state.ts` 안의 자기 칸만 고친다 |
| `packages/rules/src/commands/ext/registry.ts` | T4-05, 06, 08~11, 14~16, 19, 22, 27 | 목록 한 줄씩. 충돌 나면 뒤 PR이 다시 맞춘다 |
| `packages/rules/src/commands/attack.ts` | T4-33, T4-18 | T4-33이 계산을 꺼내고 T4-18은 그 함수에만 수정자 자리를 단다. T4-33 먼저 |
| `apps/engine/src/persist.ts`, `commandPersistence.ts` | T4-03 | 확장 상태 저장은 `extState.ts`에 두고 여기서는 호출만 한다 |
| `apps/web/src/turns/` | T4-04 | T1-15·T1-16 소유. 새 인자 입력은 `extArgs.ts`에 두고 연결 한 곳만 고친다. T1-16 병합 뒤 착수 |
| `apps/web/src/router.tsx`, `layout/GameLayout.tsx` | T4-13, 21, 24, 29, 32, 34, 36, 41 | 경로·메뉴 한 줄씩. D-018과 같은 최소 수정 |
| `tools/command-coverage.test.ts` | T4-02 | 확장 목록 대조를 같은 파일에 더한다 |
| `docs/product/phases.md`, `acceptance-criteria.md`, `decisions.md` | 정식 반영 PR | t_b4277a9e 완료 뒤 한정 hunk. 이 문서의 작업이 직접 고치지 않는다 |

## 8. 승인이 필요한 항목

phases.md Phase 2 목록 밖에 있거나 핵심 규칙을 바꾸는 것이다. 이 문서의 완료 범위에 넣지도 빼지도 않았다. 넣으려면 결정 기록에 먼저 남긴다.

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

## 9. 미결정 제품 결정

한 줄씩 결정을 받으면 해당 작업이 풀린다. 결정 없이 할 수 있는 범위를 옆 칸에 적었다.

| ID | 결정할 것 | 막는 작업 | 결정 없이 할 수 있는 범위 |
| -- | --------- | --------- | ------------------------- |
| U-01 | 준비 턴 기제를 원작처럼 넣을지(같은 명령을 연속 칸에 예약해야 실행), 준비 턴 없이 한 턴 실행으로 줄일지 | T4-07~T4-09 | 준비 턴 없는 명령 전부 (T4-05, T4-06, T4-11, T4-14~T4-16) |
| U-02 | 특수 병종의 전투 특수 효과(원작의 방어력 증가·선제 사격·기병 병종 전투·성벽 부상 무효)를 어디까지 넣을지와 기술 요구치 환산 | T4-09 | 연구 명령의 조건 검사 틀 |
| U-03 | 새 병종 계열(귀병·차병)을 더할지. 병종 체계(A7) 변경이다 | T4-10 | 없음 |
| U-04 | 국호·국기 변경권이 생기는 조건. 원작은 건국 때 국기 1회, 국가 등급 7 도달 때 둘 다인데 우리에게는 국가 등급 상승 규칙이 없다 | T4-16의 변경권 부여 | 변경 명령 자체와 이름 검사 |
| U-05 | 모반이 가능한 군주 미접속 기준. 원작은 killturn이고 우리 FR-GEN-04는 아직 확인 대기다 | T4-15의 모반 | 선양·해산 |
| U-06 | 장비 범위: 원작 명마·무기·서적·도구 중 무엇을, 유니크 아이템을 넣을지, 획득 경로 | T4-22 | T4-18 효과 합산 틀 |
| U-07 | 특기 범위(내정 8종, 전투 특기 몇 종)와 새로 만든 장수가 특기를 얻는 규칙 | T4-25 | T4-18 효과 합산 틀 |
| U-08 | 경매 방식: 마감 기준(게임 tick, 실제 시각), 최소 입찰 단위, 유찰, 대상 | T4-27 | 없음 |
| U-09 | 토너먼트 주기, 종목, 보상 | T4-31 | T4-30 대진·경기 규칙 |
| U-10 | 타임랩스를 로그인 없이 공유할지, 종료된 월드만 공유할지, GIF·영상 내보내기가 필요한지 | T4-37 | T4-35, T4-36 로그인 사용자 재생 |
| U-11 | 안개의 병력 구간 경계와 가릴 항목, 첩보 기록을 몇 개월까지 보여 줄지 | T4-38, T4-39 | T4-11~T4-13 첩보 기록 |
| U-12 | 야간 휴전 기본 시간대와 적용할 프리셋 | T4-40의 기본값 | T4-40 기능 자체(프리셋에서 켤 때만 동작, 기본 꺼짐) |
| U-13 | D7 관계 종류, 자료 출처, 등용·배신·사기 효과 수치 | T4-42 | 없음 |
| U-14 | D8 사건 목록, 선택지, 효과 | T4-43 | 없음 |
| U-15 | D9 칭호 기준과 계정 단위 보관 범위 | T4-44 | 없음 |
| U-16 | D14 패 수, 함정·반격 규칙, 패를 얻는 방법 | T4-45 | 없음 |
| U-17 | 추가할 시나리오 목록. 후보는 지도와 장수 491명 세트가 같은 원작 역사모드(1010·1020·1040·1050·1060·1070·1080·1090·1100·1110·1120) | T4-46 | 후보의 로더 호환 점검 |
| U-18 | NPC가 확장 명령을 쓰게 할지 | NPC 판단 추가 | 확장 명령 전부 (NPC는 지금 판단 그대로) |

## 10. 오늘 착수 가능한 것

선행도 결정도 필요 없는 작업은 T4-01, T4-02, T4-18, T4-30, T4-33, T4-35다. 이어서 T4-02가 합쳐지면 T4-05, T4-06, T4-11, T4-14, T4-16, T4-19와 T4-15의 선양·해산 부분, T4-33 뒤 T4-34, T4-35 뒤 T4-36이 오늘 가능하다.

명령을 실제 월드에서 켜는 일(T4-03 이후)은 MVP 작업 T2-02(프리셋)가 끝나야 한다. 야간 휴전은 T2-01·T2-02, 확장 인자 화면은 T1-16을 기다린다. 결정 대기 작업은 §9 결정이 오기 전에는 착수하지 않는다. 그래서 오늘 안에 Phase 2 전체가 완료되지는 않는다. 오늘 끝낼 수 있는 것은 순수 규칙·조회·화면 묶음과 공통 틀까지다.

## 11. 하지 않는 것

- phases.md, acceptance-criteria.md, decisions.md, 기존 T1~T3 계획, 코드, schema, 패키지 수정
- 원작 코드 복사. 규칙 작업에서 원작을 옮기면 파일 머리에 출처를 적고 `resources/NOTICE.md`에 고지한다
- 비공개 v1 자료 인용·복사
- 새 유료 API, GCP 기동, 운영·게임 초기화, 배포

## 리뷰 (Codex)

- 결과:
- 확인한 것:
- 고칠 것:
