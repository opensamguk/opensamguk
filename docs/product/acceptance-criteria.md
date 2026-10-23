# 인수조건

> 상태: 초안 v0.1 (2026-10-20) · 근거: [요구사항](./requirements.md) · 순서: [단계 계획](./phases.md)

**이 문서가 진행률의 유일한 기준입니다.** "얼마나 됐어?"의 답은 아래 요약표의 숫자입니다.
보고서·커밋 메시지·느낌으로 완료를 판단하지 않습니다.

## 쓰는 법

- 상태: ⬜ 미착수 · 🟨 진행 중(검증 통과 뒤 리뷰 대기 포함) · ✅ 통과 <!-- lint-text-ignore C-5 -->
- **✅는 검증이 통과하고 구현하지 않은 쪽의 리뷰까지 끝나야** 붙습니다 ([작업 흐름](./phases.md#작업-흐름)). <!-- lint-text-ignore C-5 -->
- ✅로 바꿀 때는 **증거** 칸에 테스트 이름, 명령, 커밋, 녹화 중 하나를 적습니다. 증거 없는 ✅는 무효입니다. <!-- lint-text-ignore C-5 -->
- 누가 무엇을 할 차례인지는 `pnpm next`로 봅니다. 기준은 [단계 계획의 작업 대기열](./phases.md)입니다.
- AC를 고치거나 지우려면 [결정 기록](./decisions.md)에 이유를 남깁니다. 통과하기 어렵다고 기준을 낮추지 않습니다.
- 관문은 그 관문의 AC가 **전부** ✅일 때만 통과합니다. <!-- lint-text-ignore C-5 -->

## 요약

| 관문                           | 전체 | ✅ | 🟨 | ⬜ | <!-- lint-text-ignore C-5 -->
| ------------------------------ | ---- | -- | -- | -- |
| M1 혼자 + NPC로 한 판 완주     | 22   | 19 | 2  | 1  |
| M2 지인 테스트 | 20 | 2 | 0 | 18 |
| M3 공개 오픈 = MVP 완료 | 16 | 0 | 1 | 15 |

차별화 기능 AC: M2-06(D1), M2-14(D16), M2-15(D2), M2-16(D11), M2-17(D12), M2-18(D6), M3-12(D17), M3-13(D3), M3-14(D15), M3-15(D10)

<a id="m1"></a>

## M1. 혼자 + NPC로 한 판 완주

**관문 데모:** 독립 에이전트 1명이 실제 브라우저로 장수를 만들어 임관·내정·모병·출병·점령까지 가속 전 15분 이상 하고 가속해서
같은 판이 끝나는 것(천하통일 또는 종료 연도)까지 본다 ([D-024](./decisions.md#d-024-m1-완주-데모의-참가자와-기수-종료-규칙을-정한다-2026-10-22)).

### 기반

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M1-01  | 새로 클론한 저장소에서 `pnpm install` 다음 `pnpm check`(lint·타입·테스트)가 통과한다 | 깨끗한 폴더에서 명령 실행 로그 | ✅ | 2026-10-20 Codex 재리뷰 통과. 수정 커밋 `6336033`을 포함한 `40738ec`의 Git 추적 파일만 빈 폴더에 풀어 `pnpm install --frozen-lockfile` → `pnpm check` 통과 (Prisma 생성, lint 0건, 타입 6개 패키지, 테스트 17개). 이전 지적을 포함한 독립 ESLint 검사도 통과. [T1-01 리뷰](../plans/T1-01.md#리뷰-codex). T1-21 설정 추가도 Codex 리뷰 통과: prettier 3.9.9 고정·제외 목록·frozen 설치 확인, 현재 작업 트리 `pnpm check` 단위 103개 통과. [T1-21 리뷰](../plans/T1-21.md#리뷰-codex). T1-22 Codex 독립 리뷰 통과: 포맷 전 `03300fd`·후 `4505937`에 같은 CI만 추가한 실행 39414531777·39414535326에서 frozen 설치·check 단위106·DB33·E2E24·웹 빌드 결과가 같다. 최신 원본 `3a526e5`의 실행39413811270은 check 단위110·DB33·E2E24 통과. 들여쓰기 반례 실행39414541369에서 check exit1 확인 후 원본 tree로 복원. [T1-22 리뷰](../plans/T1-22.md#리뷰-codex) | <!-- lint-text-ignore C-5 -->
| AC-M1-02  | `docker compose up`으로 DB를 띄우고 `pnpm dev`로 web·server·engine을 켜면 브라우저에 로그인 화면이 나온다 | Playwright 스모크 테스트 | ✅ | 2026-10-20 Codex 재리뷰 통과 (`c367e6c`). 기존 dev 리스너 없이 실제 PostgreSQL 18로 `pnpm db:up` → `pnpm e2e` 1개 통과, `SERVER_PORT=3002 pnpm e2e` 1개 통과. 두 실행 모두 로그인 화면과 서버·DB 정상 표시 확인. `pnpm check`도 테스트 21개 통과. [T1-02 리뷰](../plans/T1-02.md#리뷰-codex) | <!-- lint-text-ignore C-5 -->

### 월드·시나리오

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M1-03  | 「군웅할거(191)」와 `map_che`로 월드를 만들면 도시 94개, 시나리오의 국가·장수 491명이 저장된다. 같은 시드로 두 번 만들면 상태 해시가 같다 | 통합 테스트 | ✅ | 2026-10-20 Claude 리뷰 통과 ([T1-03 리뷰](../plans/T1-03.md#리뷰-claude)). `pnpm test:int` 실제 PostgreSQL 18 전용 DB에서 5개 통과: 도시 94·국가 21·장수 491·외교 7쌍 저장, 같은 시드 두 월드와 메모리·재적재 해시 일치, 롤백·월드 격리·잘못된 옵션·CLI 검증. `pnpm check` 단위 41개, `pnpm e2e` 1개 통과. [T1-03 구현 기록](../plans/T1-03.md#구현-기록-codex) | <!-- lint-text-ignore C-5 -->
| AC-M1-04  | 월드를 만들 때 턴 간격(분)과 시드를 정하고 명령줄로 일시정지·재개할 수 있다. 일시정지 동안 게임 시간이 흐르지 않는다 | 통합 테스트 (시계 주입) | ✅ | 2026-10-20 Claude 리뷰 통과: 정지 중 tick 고정, 재개 이어짐, 동시 정지 1회 적용, 시각 역행 시 감소 없음. 단위(clock) + 통합 8개. [T1-04 리뷰](../plans/T1-04.md#리뷰-claude) | <!-- lint-text-ignore C-5 -->

### 계정·장수

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M1-05  | 이메일과 비밀번호로 가입·로그인·로그아웃이 된다. DB에는 argon2id 해시만 있고 원문 비밀번호는 어디에도 없다 | API 테스트 + DB 조회 | ✅ | T1-10 API는 2026-10-20 Claude 리뷰 통과: 실제 HTTP·DB 인증 4개, argon2id 저장·원문/토큰 로그 미노출·쿠키 속성 확인. [T1-10 리뷰](../plans/T1-10.md#리뷰-claude). T1-14 화면도 Codex 재리뷰 통과: 실제 E2E 24개·전체 단위 106개·운영 빌드 통과. 다른 탭 로그아웃·인증 쿠키 상실 뒤 가드 재확인, 네트워크 실패 뒤 수정한 입력 재전송을 검증했다. [T1-14 재리뷰](../plans/T1-14.md#재리뷰-codex-2026-10-20). 로그인 뒤 이동에 쓰는 T1-20 `world.list`도 Claude 리뷰 통과: 구현 head `1b765d1`, 실제 소켓·PostgreSQL 탐침 5개와 구현 시험 7개로 RUNNING 필터·만든 순서·공개 필드 3개·무인증·제재·잘못된 입력을 확인했다 (CI 39419020620, 39413908880). [T1-20 리뷰](../plans/T1-20.md#리뷰-claude) | <!-- lint-text-ignore C-5 -->
| AC-M1-06  | 이름·능력치·초상 ID로 장수를 만든다. 같은 월드에서 두 번째 장수 생성은 거부된다. 능력치 합계 규칙을 어기면 거부된다 | API 테스트 | ✅ | API는 T1-11 Claude 리뷰 통과(PR #39 `1ffde70`): `tools/t1-11.integration.test.ts` 실제 TCP·PostgreSQL에서 엔진 단독 생성, 두 번째 생성 거부, 능력치·이름·초상 거부, 동시 동명 접수 하나만 생성(CI 39540683895, 39540688461). 화면은 T1-15 Codex 재리뷰 통과(`422229a`): `e2e/turns.spec.ts` 합계 초과·정상 생성·두 번째 생성 거부, pending 뒤 실제 엔진 거절·폼/입력 복귀·이름 수정 후 재시도, pending 중 새로고침을 검증했다. 독립 CI 39557351030(check313·PG126·Chromium40, skip0). [T1-15 리뷰](../plans/T1-15.md#리뷰-codex) | <!-- lint-text-ignore C-5 -->

### 예턴

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M1-07  | 30칸에 명령과 인자를 저장하고 여러 칸 한꺼번에 넣기·당기기·밀기가 된다. 빈칸은 휴식으로 채워진다 | 단위 테스트 + E2E | ✅ | API는 T1-11 Claude 리뷰 통과(PR #39 `1ffde70`): 30칸 저장, put·shift·repeat, 빈칸 휴식, 장수 명령 27개의 strict 인자와 국가 명령 거부. 화면은 T1-15 Codex 재리뷰 통과(`422229a`): `turns.test.ts` 14개와 실제 `e2e/turns.spec.ts`의 2~5칸 넣기·저장·새로고침, 명령 인자, 밀기·당기기·반복·휴식 채움, 키보드 3칸 저장. 독립 CI 39557351030(check313·PG126·Chromium40, skip0). 단독 편집기 증거이며 메인 결합은 T1-16에서 본다. [T1-15 리뷰](../plans/T1-15.md#리뷰-codex) | <!-- lint-text-ignore C-5 -->
| AC-M1-08  | 다른 탭에서 먼저 저장했다면 오래된 revision의 저장은 거부되고 화면이 최신 목록을 다시 불러온다 | 통합 테스트 | ✅ | API는 T1-11 Claude 리뷰 통과(PR #39 `1ffde70`): 실제 PostgreSQL STALE·최신 30칸 반환과 엔진/API 경합 revision. 화면은 T1-15 Codex 재리뷰 통과(`422229a`): `두 탭에서 저장하면 늦은 탭에 충돌 안내와 최신 목록을 보이고, 내 편집을 다시 적용해 저장한다` 실제 E2E로 최신 목록·내 편집 보존·재적용·재저장을 확인했다. 독립 CI 39557351030(PG126·Chromium40, skip0), 충돌 PNG 직접 확인. [T1-15 리뷰](../plans/T1-15.md#리뷰-codex) | <!-- lint-text-ignore C-5 -->
| AC-M1-09  | 넣을 때 조건이 안 맞으면 경고가 보인다. 실행 때 다시 검사해서 실패하면 실패 이유가 장수 로그에 남는다 | 단위 테스트 | ✅ | API는 T1-11 Claude 리뷰 통과(PR #39 `1ffde70`): 병종·다음 턴 tick·등용 제안 사전 검사, 모병·징병·출병의 실제 실행 결과·실패 로그·12개월 재생. 화면은 T1-15 Codex 재리뷰 통과(`422229a`): `2~5칸 선택 → 농지 개간 → 경고가 있어도 저장 → 새로고침 후 유지`, `턴이 실행되면 실패 이유가 최근 실행 결과에 남고 예턴이 한 칸 당겨진다` 실제 E2E 통과. 독립 CI 39557351030(PG126·Chromium40, skip0), 현재 실패 이유·당김 PNG 직접 확인. [T1-15 리뷰](../plans/T1-15.md#리뷰-codex) | <!-- lint-text-ignore C-5 -->

### 엔진

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M1-10  | 장수의 턴 시각이 되면 예턴 1칸이 실행되고 결과가 로그에 남고 예턴이 한 칸 당겨진다 | 통합 테스트 (시계 주입) | ✅ | 2026-10-20 Claude 재리뷰 통과: `apps/engine/src/turnLoop.integration.test.ts` `시계 주입: 턴 시각에 농업·금·로그·30칸 당김·revision을 함께 저장한다`, `밀린 턴은 tick 우선, 같은 tick은 장수 ID 순서로 처리한다`, `실행 시 재검사 실패는 실패 로그를 남기고 턴과 예턴을 진행한다`. `pnpm test:int` 33개 통과. [T1-06 재리뷰](../plans/T1-06.md#재리뷰-claude-2026-10-20) | <!-- lint-text-ignore C-5 -->
| AC-M1-11  | 턴 처리 중 엔진을 강제 종료하고 다시 켜도 그 턴이 두 번 실행되거나 빠지지 않는다. 엔진 둘을 동시에 띄우면 하나만 실행권을 가진다 | 통합 테스트 (kill 시나리오) | ✅ | 2026-10-20 Claude 재리뷰 통과: 같은 파일의 `실제 프로세스 둘을 띄우면 한 쪽만 턴을 저장한다`, `리스 만료 후 새 엔진만 commit하고 이전 엔진의 갱신·commit을 거부한다`, `commit 직전 오류는 엔티티·로그·예턴·시계·메모리 사본을 모두 롤백한다`, 실제 SIGKILL(commit 직전·직후) 재시작 검증. `pnpm test:int` 33개 통과. [T1-06 재리뷰](../plans/T1-06.md#재리뷰-claude-2026-10-20) | <!-- lint-text-ignore C-5 -->
| AC-M1-12  | 달이 바뀌면 세금·봉급 → 인구·민심 → 보급 → 외교 기한 → 연감 순서로 처리된다 | 골든 테스트 (고정 시드로 1개월 진행 후 기대 스냅샷 비교) | ✅ | 2026-10-21 Claude 재리뷰 통과(PR #9 `cbfbf7f`): `apps/engine/src/monthly.test.ts` `고정 시드 1개월 골든과 단계별 합성이 같다`, `반기 세입 %i월, 수입은 인구 증가 전에 계산한다`, `apps/engine/src/monthly.integration.test.ts` `앞선 턴 → 정산 → 같은 tick 턴, 국가 기록·소유권·해시를 한 번만 저장한다`, `정산 commit 직전 %s이면 상태·연감·국가 기록·순서·메모리를 모두 롤백한다`, `실제 SIGKILL %s 후 월 정산은 정확히 한 번 반영된다`. main `d8b7ae1` 병합 CI [39528316796](https://github.com/peppone-choi/opensamguk/actions/runs/39528316796) 단위 126개·PostgreSQL 57개 통과. [T1-07 재리뷰](../plans/T1-07.md#재리뷰-claude-2026-10-21) | <!-- lint-text-ignore C-5 -->
| AC-M1-13  | 같은 시드와 같은 입력 기록으로 12개월을 다시 돌리면 상태 해시가 같다. 게임 로직에 `Math.random()`이 없다 | 재생 테스트 + lint 규칙 | ✅ | 2026-10-21 Claude 재리뷰 통과(PR #9 `cbfbf7f`): `apps/engine/src/monthly.integration.test.ts` `턴 사이 예턴 편집·거부·장수 생성과 12개월 해시, 실제 CLI를 검증한다`, `DB는 중복 멱등 키·sequence와 미완료/완료 결과 불일치를 거부한다`, `apps/engine/src/monthly.test.ts` `같은 시드 12개월을 비교하고 변조·누락·순서·revision 오류를 거부한다`, `tools/lint-boundaries.test.ts` `rules에서 Math.random을 막는다`·`engine에서도 Math.random을 막는다`. 같은 CI [39528316796](https://github.com/peppone-choi/opensamguk/actions/runs/39528316796). [T1-07 재리뷰](../plans/T1-07.md#재리뷰-claude-2026-10-21) | <!-- lint-text-ignore C-5 -->

### 규칙

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M1-14  | 2026-10-22 소유자 정정([D-022](./decisions.md#d-022-mvp-완료에는-모든-명령이-들어간다-2026-10-22)): MVP의 모든 명령이 완료된다. core2026 `df6c926`의 원본 90개(장수 55·국가 35)마다 [명령 대응표](./command-coverage.json)에 우리 명령이나 미해결 항목이 하나씩 있다. 명령마다 화면·API·권한·엔진·효과·비용·실패·저장·재시작·재생·독립 리뷰·exact SHA 검증·병합이 증거로 확인되거나 이유 있는 해당 없음이다. 원래 조건(MVP 명령 37개 각각에 성공 1건과 대표 실패 1건 테스트가 있고 명령 목록과 테스트 목록이 자동으로 대조된다)은 부분집합으로 계속 지킨다 | `node tools/command-coverage.mjs`(대응표 정합, registry·문서 대조) + `node tools/command-coverage.mjs --require-complete`(제품 전체 완료) + 기존 rules 단위 테스트·대조 스크립트 | 🟨 | 전체 명령: 미완료. 2026-10-22 대응표 정합 통과, 정본 분모 91(명령 88 + 미해결 원본 3), 전 단계 완료 0. 숫자는 위 명령의 출력이 기준이다. 37개 부분집합 이력: 2026-10-21 Claude 재리뷰 통과(PR #38 `81ffd1b`): `packages/rules/src/commands/registry.test.ts` `37개 key, 장수27·국가10과 행동 검사 목록이 정확히 일치한다`, `tools/command-coverage.test.ts` `AC-M1-14 모든 registry key에 성공·실패 행동 테스트 파일이 있다`, `war.test.ts` `37종 잘못된 인자를 거부하고 국가 명령은 군주·대상을 따로 검사한다`, 기존 9종 `tools/commands.test.ts` 27개. exact head CI [39537902044](https://github.com/peppone-choi/opensamguk/actions/runs/39537902044) 단위 291개 통과. [T1-08 재리뷰](../plans/T1-08.md#재리뷰-claude-2026-10-21) | <!-- lint-text-ignore C-5 -->
| AC-M1-15  | 출병하면 수비 장수와 차례로 싸우고 성벽을 거쳐 점령한다. 마지막 도시를 잃은 국가는 멸망하고 소속 장수는 재야가 된다 | 시나리오 테스트 | ✅ | 2026-10-21 Claude 재리뷰 통과(PR #38 `81ffd1b`): `packages/rules/src/commands/war.test.ts` `수비2명·성벽 순서, 마지막 도시 멸망·재야·국가 예턴 삭제와 같은 시드 결과`, `apps/engine/src/war.integration.test.ts` `국가포상·수비2명·성벽·멸망·재야·국가예턴 삭제와 로그를 한 번 저장하고 12개월 재생한다`, `전투 저장 직전 %s이면 소유권·국가·양쪽 로그·예턴·메모리를 모두 롤백한다`. exact head CI [39537902044](https://github.com/peppone-choi/opensamguk/actions/runs/39537902044) PostgreSQL 91개 통과. [T1-08 재리뷰](../plans/T1-08.md#재리뷰-claude-2026-10-21) | <!-- lint-text-ignore C-5 -->
| AC-M1-16  | 수도와 끊긴 도시는 보급 끊김으로 표시되고 월간 손해를 본다. 연결을 되찾으면 풀린다 | 단위 테스트 | ✅ | 2026-10-21 Claude 재리뷰 통과(PR #38 `81ffd1b`): `packages/rules/src/commands/war.test.ts` `회랑 점령 직후 단절 표시, 월간 손해, 재점령 직후 회복과 다음 달 손해 중단`, `수도 함락 뒤 인구 $populations 기준 수도 $capital에서 보급하고 반격한다`, `apps/engine/src/war.integration.test.ts` `회랑 점령·단절 월간 손해·재점령 회복을 저장하고 2개월 재생한다`, `수도 함락 %s 뒤 자동 천도·보급·반격·역사를 저장하고 롤백·재생한다`. exact head CI [39537902044](https://github.com/peppone-choi/opensamguk/actions/runs/39537902044) 단위 291개·PostgreSQL 91개 통과. [T1-08 재리뷰](../plans/T1-08.md#재리뷰-claude-2026-10-21) | <!-- lint-text-ignore C-5 -->

### NPC

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M1-17  | 사람 없이 NPC만으로 10개 시드를 돌리면 10개 모두 오류 없이 천하통일 또는 종료 연도에 이른다 (가정 A18) | `pnpm sim --seeds 10` 결과 | ✅ | 2026-10-21 Claude 재리뷰 통과(PR #45 `afab6be`): [simulation 39548309088](https://github.com/peppone-choi/opensamguk/actions/runs/39548309088)의 `pnpm sim --seeds 10 --output simulation.jsonl`에서 1030·94도시·491명·종료 연도 300으로 10개 모두 300년 12월 도달, 예외 0, 통일 0. seed 1 보조 ON·OFF 각 두 번 반복 해시 `fab04343…07f4` 일치. 같은 코드 `8c273f0`의 [simulation 39547027632](https://github.com/peppone-choi/opensamguk/actions/runs/39547027632)와 10시드 해시·집계 일치. 판단 단위 시험 `packages/rules/src/npc/npc.test.ts` 11개와 `apps/engine/src/simulation.test.ts` 3개, exact head CI 단위 310·PostgreSQL 129 통과. 표는 [테스트 정책 §4](../testing-policy.md#t1-09-측정), [T1-09 재리뷰](../plans/T1-09.md#재리뷰-claude-2026-10-21) | <!-- lint-text-ignore C-5 -->
| AC-M1-18  | 위 시뮬레이션 1판이 개발 PC에서 15분 안에 끝난다 (가정 A18) | 같은 명령의 시간 기록 | 🟨 | hosted 실행기만 측정했다(개발 PC 증거 아님). PR #45 `afab6be`의 [simulation 39548309088](https://github.com/peppone-choi/opensamguk/actions/runs/39548309088) 14판 최장 65.128초(Intel Xeon Platinum 8573C, 4 vCPU), `8c273f0` 최장 38.803초. 개발 PC에서 같은 명령의 최장 시간과 CPU·메모리·Node 버전 기록이 오면 통과로 바꾼다. [T1-09 재리뷰](../plans/T1-09.md#재리뷰-claude-2026-10-21) | <!-- lint-text-ignore C-5 -->

### 화면·이미지

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M1-19  | 핵심 화면 6개가 동작한다. 메인(장수·도시·국가 요약, 다음 턴 시각, 최근 로그), 지도(94도시, 소유국 색, 연결선, 보급), 예턴 편집, 도시 정보, 국가 정보, 기록. 2026-10-21 소유자 정정([D-020](./decisions.md#d-020-메인-한-화면에서-지도와-예턴을-함께-다룬다-2026-10-21)): 지도·예턴 편집·도시·국가·장수 정보·기록이 메인 한 화면에 함께 있다. 지도 도시 선택·예턴 입력·저장·충돌 안내·턴 결과 확인을 메인을 떠나지 않고 한다. 다른 주소는 보조 화면이다 | 실제 DB·서버·엔진·Chromium Playwright + 지도와 예턴이 같은 메인에 보이는 스크린샷. 주소 6개가 열리는 것만으로는 통과가 아니다 | ✅ | T1-16 Codex 독립 리뷰 통과(PR #48 `8f0ea5f`, 2026-10-22). [독립 exact CI 39713702326](https://github.com/peppone-choi/opensamguk/actions/runs/39713702326): 단위 392개·실제 PostgreSQL 282개·Chromium 60/60개(skip 0)·웹 빌드 통과. `e2e/main.spec.ts`에서 같은 메인의 지도와 실제 30칸 편집기, 지도 선택·재조회 뒤 초안/선택 유지, 입력·저장·STALE 재적용, 실제 턴 뒤 칸 당김·기록 갱신, 94도시·공개 범위·0초 재조회와 보조 주소를 확인했다. 추가 기록 3종 30/60/65건·권한·지도 키보드는 [탐침 39715955457](https://github.com/peppone-choi/opensamguk/actions/runs/39715955457) 실제 DB·HTTP·Chromium 1/1개로 통과했다(격리 PREOPEN fixture, 엔진 결과와 구분). 직접 본 새 스크린샷은 `39714339317` artifact `12398792225`의 `01-main.png`~`12-main-turn-result.png` 12장과 페이지 탐침 artifact `12399725290`의 `review-pagination-keyboard.png`다. 앞 탐침은 기존 60개 통과·리뷰어 CLI 준비 1개 실패였고 수정 뒤 집중 검증을 통과했다. 병합은 별도. [T1-16 리뷰](../plans/T1-16.md#리뷰-codex). 이전 T1-13 `a6d59c1` 레퍼런스·화면 기반과 T1-12 `b99adef` 공개 범위·실제 조회 시험은 각 계획의 리뷰에 남긴다. | <!-- lint-text-ignore C-5 -->
| AC-M1-20  | 초상은 초상 ID와 설정된 base URL로 해석된다. 없으면 기본 이미지가 나온다. base URL 환경변수만 바꿔도 전부 교체된다 | 단위 테스트 + 스크린샷 2장 | ✅ | T1-19: 초상 대응 429/491 (87.37%), 이름 대응 단위 4개·실제 DB 저장·재적재 통과. 동명이인 12명·미대응 50명은 후속 보완. T1-17 Codex 독립 리뷰 통과 (`1b31c233`): 초상 단위 12개, base A·B 교체와 404 기본 이미지 E2E 2개, 스크린샷 3장 직접 확인. [독립 CI](https://github.com/peppone-choi/opensamguk/actions/runs/39415368920)에서 `pnpm check`·웹 빌드·통합 33개·E2E 26개 통과. [리뷰](../plans/T1-17.md#리뷰-codex). AC-M3-06 공개 권리 승인은 별도 | <!-- lint-text-ignore C-5 -->

### 글쓰기

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M1-22  | 문서, 화면 문구, 게임 문구, 서버 오류 메시지가 [글쓰기 규칙](../writing-style.md)을 따른다. 자동 검사에서 S1 패턴이 0건이다 | `pnpm lint:text` + 반대쪽 리뷰 | ✅ | 문구 정리 세 단계가 main에 있다: T1-25 PR #6 `ce0560a`, T1-24 PR #64 `6105638`, T1-23 PR #128 `2380904`. strict 연결은 PR #130 Codex 구현(`19c9bac`)을 Claude가 head `0407469`에서 리뷰 통과했다(2026-10-22). `pnpm check`의 lint 뒤에 `pnpm lint:text --strict`만 들어갔다. 전체 195파일(문서 91, web 50, rules 28, server 26) 0건, 기본 대상 밖 엔진·shared·db·tools 39파일 탐침 0건, 예외 주석 188곳 대조. 구현자 로컬에서 A-7 반례 문서 하나로 `pnpm check`가 strict 단계 종료 코드 1. exact-head CI [39730834565](https://github.com/peppone-choi/opensamguk/actions/runs/39730834565)·[39730839018](https://github.com/peppone-choi/opensamguk/actions/runs/39730839018): frozen 설치, 단위 458개, 실제 PostgreSQL 328개, Chromium 60/60개(skip 0), 웹 빌드 통과. 병합은 별도. [T1-23 최종 리뷰](../plans/T1-23.md#최종-strict-연결-리뷰-claude) | <!-- lint-text-ignore C-5 -->

### 관문 데모

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M1-21  | 턴 간격 1분 월드에서 구현·증거 작성자와 분리된 독립 에이전트 1명이 장수 생성 → 임관 → 내정 → 모병 → 출병 → 점령까지 실제 브라우저 화면으로 가속 전 15분 이상 진행한다. 이어 같은 월드를 가속 모드로 그 판의 종료까지 가고 종료 화면에 승자(종료 연도 도달이면 승자 없음)와 연도가 나온다 (A17, D-024) | 녹화 + 체크리스트 | ⬜ | | <!-- lint-text-ignore C-5 -->

<a id="m2"></a>

## M2. 지인 테스트

**관문 데모:** 독립 에이전트 참가자 5명 이상이 서로 다른 월드 2개에 들어가 한 기수(합의한 기간)를 끝까지 한다. 지인 참가자는 같은 수의 독립 에이전트로 바뀌었다 ([D-021](./decisions.md#d-021-지인-참가-시험을-독립-에이전트-참가-시험으로-바꾸고-공개를-승인한다-2026-10-21)).

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M2-01  | 월드 2개(시나리오·턴 간격이 다름)가 동시에 진행된다. 한 월드를 멈추거나 그 엔진을 죽여도 다른 월드는 계속 진행된다 | 통합 테스트 | ✅ | T2-01 Claude 독립 리뷰 통과(PR #66 `48c4db1`, 2026-10-22). `apps/engine/src/supervisor.integration.test.ts` 7개가 실제 PostgreSQL·감독·엔진 자식 프로세스에서 A(1030, 10분)·B(시작 연도를 바꾼 fixture, 60분)의 manual 3개월 독립 진행, B SIGKILL 동안 A 진행과 B 백오프 재시작, A 정지 중 tick 고정과 B 진행, 5분 안 5회 종료 중단, 종료·삭제 월드 정리, 중복 감독의 리스 펜싱, 30초 heartbeat와 재생 해시 불변을 확인했다. exact-head CI [39742317016](https://github.com/peppone-choi/opensamguk/actions/runs/39742317016)·[39742320690](https://github.com/peppone-choi/opensamguk/actions/runs/39742320690): 단위 460개, 실제 PostgreSQL 335개, Chromium 61/61개(skip 0), 웹 빌드 통과. 병합은 별도. [T2-01 리뷰](../plans/T2-01.md#리뷰-claude) | <!-- lint-text-ignore C-5 -->
| AC-M2-02  | 로그인 뒤 로비에서 월드 목록(상태·시나리오·턴 간격·인원·시작일)을 보고 참가할 수 있다 | E2E | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-03  | 규칙 프리셋 파일 하나로 턴 간격·시작 조건·명령 세트·NPC 설정이 바뀐다 (D5) | 단위 테스트 + 프리셋 2종으로 월드 생성 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-04  | 개인·국가·외교 메시지를 주고받고 읽음이 표시된다. 공개 범위 밖 메시지 조회는 거부된다 | API 권한 테스트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-05  | 군주가 수뇌를 임명하고 포상·몰수·발령을 한다. 권한 없는 장수의 같은 요청은 거부된다 | API 권한 테스트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-06  | **(D1 조약서 외교)** 조항(불가침 기간·통행·정기 원조·교역 허용·도시 이양·만료 조건)을 골라 제안하고 상대가 수락하면 서버가 조항을 자동 집행한다. 종전도 조약으로 맺는다. 파기하면 신의 기록이 남고 다른 국가가 볼 수 있다. 권한 없는 장수의 제안·수락은 거부된다 | 조항별 시나리오 테스트 + 권한 테스트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-07  | 내 턴 결과와 새 메시지가 새로고침 없이 2초 안에 화면에 보인다 | E2E (SSE) | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-08  | 서버 1대에 명령 하나로 배포된다. 이전 버전으로 되돌리는 절차를 한 번 연습해 성공한다 | 리허설 기록 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-09  | 매일 DB를 백업한다. 백업으로 새 DB를 복구해 월드가 이어서 진행되는 것을 한 번 확인한다 | 복구 리허설 기록 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-10  | 서버·엔진 오류가 기록된다. 엔진이 5분 넘게 멈추면 디스코드로 알림이 온다 | 엔진을 멈춰 알림 확인 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-11  | 플레이어 가이드 9개 초안이 있고 명령 목록 문서가 코드에서 자동 생성된다 | 문서 + 생성 명령 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-12  | 계정·세션이 서로 다른 독립 에이전트 참가자 5명 이상이 실제 화면이나 HTTP로 월드 2개에 참가해 한 기수(합의한 기간)를 진행한다. NPC와 같은 에이전트의 요청 수는 참가자로 세지 않는다. 오류 때문에 상태를 되돌린 일이 0번이고 참가자별 행동·결과·피드백이 목록으로 정리된다 | 테스트 회고 문서 (참가자별 기록, [T2-18](../plans/T2-18.md)) | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-13  | 테스트가 끝날 때 치명(P0) 버그가 0건이고 중대(P1) 버그는 전부 담당 AC나 백로그에 연결된다 | 이슈 목록 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-14  | **(D16 교역)** 교역 허용 조약이 있는 이웃 나라 도시와 교역하면 금·쌀과 내정치가 오른다. 조약이 끝나거나 교전 중이면 실패하고 이유가 로그에 남는다 | 단위 테스트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-15  | **(D2 국가 작전판)** 수뇌가 작전(목표 도시, 목표 연월, 참여 장수)을 만들면 참여 장수들의 턴 시각과 예턴이 한 타임라인에 보이고 목표 전에 출병이 실행되지 않거나 병력·훈련·사기가 기준 미달인 장수가 표시된다. "작전 참여"를 누르면 제안 예턴을 확인 후 채운다. 관직자는 국가원 전원의 예턴·훈련·사기 표를 본다. 다른 국가는 작전을 볼 수 없다 | E2E + 권한 테스트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-16  | **(D11 발령 응답)** 발령받은 사람 장수가 턴을 쓰지 않고 수락·거절한다. 기한 안에 답이 없으면 수락으로 처리된다. NPC 군주는 정해진 주기마다 사람 장수에게 발령·포상하고 이유를 로그에 남긴다 | 시나리오 테스트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-17  | **(D12 기본 방침)** 기본 방침을 정한 장수의 빈 예턴 칸은 휴식 대신 방침에 맞는 명령으로 실행된다. 그 명령이 실패하면 휴식으로 대신하고 이유가 로그에 남는다. 장기 미접속 장수는 방침 범위 안에서만 AI가 고른다 | 단위 + 시나리오 테스트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-18  | **(D6 턴 알림)** 디스코드 웹훅을 등록한 사용자는 예턴 실패, 공격받음, 외교 제안 도착, 예턴 남은 칸 3칸 이하를 1분 안에 받는다. 같은 일로 두 번 보내지 않고 웹훅이 실패해도 게임 진행은 멈추지 않는다 | 통합 테스트 (가짜 웹훅 서버) + 실제 디스코드 1회 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M2-19  | 장수 순위(공헌·경험·전공)와 국가 순위(도시·장수·국력)를 볼 수 있다. 공개 범위 밖 수치는 보이지 않는다 | API 테스트 + E2E | ✅ | T2-22 Claude 리뷰 통과(PR #47 `67e5b68`, D-019 후속 `ffacd1f`), T2-23 Codex 리뷰 통과(PR #46 `89f0082`, run750). `apps/server/src/routers/ranking.integration.test.ts` 실제 TCP·PostgreSQL 17개에서 기준 6개의 정렬·동률 ID 순, 상위 100명과 내 순위, 캐시의 비공개 필드 제거, 무인증·제재·잘못된 입력 거부를 확인했다. 엔진 순위 통합 2개는 월간 캐시 교체·롤백과 전공 누계·D-019 국력을 본다. rules 순위 시험은 기술 등급 역산 회귀와 배율 범위를 본다. `e2e/ranking.spec.ts` 6개는 실제 정산 뒤 정렬 주소·새로고침, 내 행·100위 밖 표시, 비공개 열·응답 키 제거, 정산 전·새 장수 상태와 숫자 머리글 정렬을 확인한다. exact-head CI `39558493251`·`39558490644`: 단위 350개, 실제 PostgreSQL 148개, Chromium 32개와 웹 빌드 통과. 국력은 응답 값을 그대로 표시한다. main 결합 뒤 9개 실패는 공용 E2E 월드를 seed 전에 준비한 `096b5ce`에서 Codex run768이 재검토했다. 필수 CI `39568039365`·`39568046840`와 독립 실행 `39569245076`은 이 head에서 단위 368개·실제 PostgreSQL 148개·Chromium 46/46개(skip 0)·웹 빌드 통과. 과거 run750을 새 head 승인으로 승계하지 않았다. 리뷰 환경의 로컬 재실행은 자원 제한으로 못 했으며 PR 병합은 별도다. [T2-22 리뷰](../plans/T2-22.md#리뷰-claude) · [T2-23 리뷰](../plans/T2-23.md#리뷰-codex) | <!-- lint-text-ignore C-5 -->
| AC-M2-20  | 로그인 화면과 로비에서 진행 중인 월드를 탭으로 골라 일정 시간 전에 찍어 둔 지도(도시 소유 색과 국가 이름)를 하나씩 본다. 지연 시간 안의 변화와 장수·병력 정보는 보이지 않는다 (D-026) | API 테스트 + E2E | ⬜ | | <!-- lint-text-ignore C-5 -->

<a id="m3"></a>

## M3. 공개 오픈 = MVP 완료

**관문 데모:** 처음 보는 사람이 도메인에 들어와 가입하고 월드를 골라 장수를 만들고 첫 턴 결과를 본다.

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-M3-01  | 가입할 때 이메일 인증을 거친다. 비밀번호 재설정 링크는 1회용이고 30분 뒤 만료된다 (가정 A14) | E2E (테스트 메일함) | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-02  | 약관·개인정보처리방침 동의가 버전과 함께 기록된다. 탈퇴하면 개인정보가 지워지고 게임 기록은 익명이 된다 | API 테스트 + DB 조회 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-03  | 로그인 요청 제한, 세션 쿠키(HttpOnly·Secure·SameSite), CSRF 방어가 있다. 모든 API에 무인증·타인·제재·잘못된 입력 테스트가 있다 | 권한 테스트 목록과 API 목록 자동 대조 | 🟨 | 현재 API 부분: T3-04 Claude 재리뷰 통과(PR #93 `2ebc395`, 구현 `511862f`). `tools/authz.integration.test.ts`가 실제 `appRouter` 절차 23개를 HTTP·PostgreSQL로 실행해 사례 97개, 사유 있는 면제 18개, 누락 0개를 출력한다. 요청 제한·429·`Retry-After`, Origin·JSON 415, 운영 Secure 시작 검사, 보안 헤더, 거부 시 DB·쿠키 불변도 같은 실행에서 본다(CI 39571672741, 39571664050). T3-02 메일 절차와 M2에서 더할 API가 같은 대조를 통과하면 통과로 바꾼다. [T3-04 재리뷰](../plans/T3-04.md#재리뷰-claude-2026-10-21) | <!-- lint-text-ignore C-5 -->
| AC-M3-04  | 관리자 화면에서 월드 생성·일시정지·재개·종료·초기화, 공지, 사용자 조회·제재·해제를 한다. 모든 조치가 감사 로그에 남는다 | E2E + 감사 로그 조회 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-05  | 로그인 IP와 기기 해시가 기록되고 관리자가 같은 월드에서 IP·기기를 공유하는 계정 목록을 볼 수 있다 | API 테스트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-06  | 공개할 이미지 세트(와 장수 데이터 출처)가 결정 기록에 남아 있고 공개 빌드가 승인되지 않은 이미지 경로를 참조하지 않는다 (가정 A8) | 결정 기록 + 자동 검사 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-07  | 월드 2개 × 장수 600 × 동시 접속 100 부하에서 API p95가 300ms 미만, 턴 처리 지연이 10초 미만이다 (가정 A19) | 부하 테스트 리포트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-08  | 375px 폭에서 로비와 핵심 화면 6개를 가로 스크롤 없이 쓴다. 누르는 대상은 44px 이상이다 | Playwright 모바일 뷰포트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-09  | 사이트 가동 확인, 엔진 하트비트, 디스크·DB 용량 알림이 동작한다 | 알림 발생 테스트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-10  | [릴리스 운영](../release-operations.md)과 [관리자 콘솔](../admin-console.md) 문서의 절차가 실제와 맞는다 | 문서대로 리허설 1회 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-11  | 공개 전 독립 에이전트 참가자 5명 이상(D-021)으로 오픈 리허설을 한 번 한다. 가입부터 첫 턴 결과까지 막힌 참가자가 0명이다 | 리허설 회고 (참가자별 기록, [T3-15](../plans/T3-15.md)) | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-12  | **(D17 관직 주재 효과)** 태수·군사가 담당 도시에 머물면 월간 정산에 정해진 보정이 붙고 떠나면 다음 정산부터 빠진다. 중앙 관직의 주재 효과는 설정 파일 하나에 표로 있다 | 골든 테스트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-13  | **(D3 군사 조언)** 장수 화면에 추천 예턴 3개와 이유가 보이고 누르면 예턴에 들어간다. 같은 상태면 같은 추천이 나온다(NPC AI 판단 재사용). 국가 작전·공지 지시가 있으면 그것을 먼저 추천한다. 재야 장수에게는 나라를 추천한다 | 단위 테스트 + E2E | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-14  | **(D15 역할별 입장)** 입장 화면에서 시나리오 인물을 역할(군주·중견·부하·재야)별로 보고 골라 시작한다. 이미 사람이 맡은 인물은 목록에서 빠진다. 직접 만드는 방식도 그대로 된다 | E2E | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-15  | **(D10 월단평)** 달이 바뀔 때 그달의 공개 평판 순위와 한 줄 평이 월드 정세에 나온다. 같은 사건 종류는 장수당 한 달에 한 번만 센다 | 골든 테스트 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-M3-16  | 도메인과 HTTPS로 누구나 가입해 참가할 수 있고 첫 공개 월드가 시작된다. 공개에 대한 소유자 승인은 D-021에 있으나 승인만으로 통과하지 않는다 | 공개 URL 접속 기록 | ⬜ | | <!-- lint-text-ignore C-5 -->

<a id="p2"></a>

## P2. Phase 2 확장 (MVP 관문 밖)

Phase 2 AC는 M1~M3 관문이 아니다. 위 요약표, README 관문 집계, MVP 진행률에 넣지 않는다. 지금 정식으로 오른 것은 AC-P2-16([D-023](./decisions.md#d-023-ac-p2-16을-인수조건에-올리고-수동-1회-계산-몫만-계약으로-채택한다-2026-10-22))과 2026-10-23 [D-027](./decisions.md#d-027-사용자-맥북에서-phase-2를-재개하고-t4-네-작업과-u-01을-한정-채택한다-2026-10-23)의 AC-P2-01, AC-P2-02·03·12·13·15의 한 몫씩, AC-P2-17의 세 몫((가)·(나)·(다))이다. 채택하지 않은 몫은 각 행에 적었고 미완료다. 나머지 AC-P2는 [Phase 2 명세 §5](../plans/phase2-expansion.md#5-인수조건-제안)의 제안 그대로다. 상태와 증거 규칙은 위 쓰는 법과 같다.

| ID        | 조건 | 검증 방법 | 상태 | 증거 |
| --------- | ---- | --------- | ---- | ---- |
| AC-P2-01  | `pnpm next`가 T4 작업을 Phase 2 절로 따로 보여 주고 M4로 표시하지 않는다. 지금의 M1~M3 출력과 현재 관문 계산은 그대로다. T4 행의 선행에 T1~T3 ID를 쓸 수 있다 (T4-01) | next-task 단위 시험 + 현재 phases.md 출력 전후 비교 | ✅ | 2026-10-23 통과. D-027 채택. 계약은 [T4-01 계획](../plans/T4-01.md)과 R138-1 수정이다. Claude 구현의 `tools/next-task.test.ts` 시험 39개가 통과했고 Codex 독립 리뷰 [5623645788](https://github.com/peppone-choi/opensamguk/pull/162#pullrequestreview-5623645788)을 통과했다. PR #162 exact head [`09604e7`](https://github.com/peppone-choi/opensamguk/commit/09604e71806b1f22012ab6df9026e02085d80a38)의 pull CI [39895694550](https://github.com/peppone-choi/opensamguk/actions/runs/39895694550)에서 check job 120225519862(단위 88파일 814개, strict 232파일 0건, 타입·lint·포맷·빌드)와 DB·브라우저 job 120225519659가 성공했고 push CI [39895675122](https://github.com/peppone-choi/opensamguk/actions/runs/39895675122)도 같다. main [`7de674d`](https://github.com/peppone-choi/opensamguk/commit/7de674dea4795ed2b2264c94e3b8478ad29d542a)에 병합됐고 병합 SHA의 CI [39897759727](https://github.com/peppone-choi/opensamguk/actions/runs/39897759727)은 check와 DB·브라우저가 성공했다. 이 AC는 Phase 2 관문이 아니며 Phase 2 완료를 뜻하지 않는다 | <!-- lint-text-ignore C-5 -->
| AC-P2-02  | 확장 명령은 월드 프리셋 허용 목록에 key가 있을 때만 예턴에 저장되고 사전 검사를 지나 실행된다. 일반 명령은 `turns`, 국가 명령은 `nationTurns` 경로다. 꺼진 월드에서는 저장·사전 검사·실행이 `COMMAND_DISABLED`로 거부되고 명령 목록에 없다. 꺼진 월드의 명령 37개 대조, v1 재생 기록, 12개월 재생 해시는 바뀌지 않는다. 켠 월드의 확장 상태는 턴·월간과 같은 트랜잭션에 저장되고 재시작 뒤 복원되며 12개월 재생 해시가 같다. (가) 순수 규칙 몫(T4-02, AC-M1-14 후속): 월드마다 켠 확장 명령만 조회·사전 검사·실행되고 끈 월드(`enabled = null`)는 기존 명령 37개의 결과·RNG 소비·상태 해시가 지금과 바이트 단위로 같다. 켠 월드의 확장 상태 `ext`는 명령 복제·월간 정산·순수 재생을 지나도 사라지지 않고 끈 월드에는 `ext` 키 자체가 없다. (나) 나머지(T4-03, T4-50, T4-51, G-01)는 채택하지 않았다 | (가) rules 단위(37개 대조, resolver 켬·끔, `ext` 복제·재생). (나) PostgreSQL 통합(롤백·SIGKILL·재시작·재생) + 실제 HTTP 저장→사전 검사→실행→표시 + E2E | 🟨 | 미완료. D-027으로 (가)만 채택. 계약은 [T4-02 계획](../plans/T4-02.md) 규칙 몫과 Codex 검토 5611758624(`PASS_PLAN_CONTRACT`, `391432c`)다. 구현 당시 Codex 로컬 시험 114개를 마쳤다. 이후 규칙 PR 1이 PR #162 exact head `09604e7`에서 Claude 독립 백엔드 리뷰 [5623645649](https://github.com/peppone-choi/opensamguk/pull/162#pullrequestreview-5623645649)(`PASS_IMPLEMENTATION_SCOPE`)와 pull CI [39895694550](https://github.com/peppone-choi/opensamguk/actions/runs/39895694550)·push CI [39895675122](https://github.com/peppone-choi/opensamguk/actions/runs/39895675122)를 통과해 main `7de674d`에 병합됐다. 계획의 도구 PR 2(`tools/command-coverage.*` 확장 key 대조)가 남아 (가)도 미완료다. G-01과 T2-02 허용 목록 생략 정책, 서버·엔진·DB와 재생 기록 연결은 (나)이며 미채택이다 | <!-- lint-text-ignore C-5 -->
| AC-P2-03  | 계략 4종(화계·파괴·선동·탈취)이 대상 도시와 장수에 효과를 내고 실패하면 이유가 장수 로그에 남는다. 명령마다 성공·대표 실패 시험이 있고 같은 시드면 결과가 같다. (가) 순수 규칙 몫(T4-05, AC-M1-14 후속): 네 명령의 `CommandDef` 정의가 U-19 S0~S7 승인값으로 검사·효과·RNG 순서를 내고 단위 골든과 반례가 같은 시드에서 같다. 준비 턴은 없다. (나) 확장 목록 등록과 엔진 통합(T4-17), 저장·서버·엔진·재생 연결(T4-03), 인자 화면(T4-04)은 채택하지 않았다 | (가) `pnpm exec vitest run packages/rules/src/commands/ext/stratagem/stratagem.test.ts --maxWorkers 2`. (나) 엔진 통합·재생 + PostgreSQL + HTTP + E2E | 🟨 | 미완료. D-027 후속으로 (가)만 채택. 사용자가 U-19의 T4-05 몫 S0~S7을 승인했고 부모 Codex 독립 계획 검토가 `PASS_PLAN_CONTRACT`로 수용했다. Codex 구현 중이며 증거는 아직 없다. (나)가 남아 이 AC 전체는 미완료다 | <!-- lint-text-ignore C-5 -->
| AC-P2-12  | 장수가 장비를 사고팔고 장착한 장비의 효과가 내정·전투 계산에 들어간다. 장비가 없는 장수의 결과는 지금과 같다(골든). (가) 순수 공통 기반(T4-18, AC-P2-13과 공용): 수정자가 하나도 없으면 기존 내정·출병 계산의 결과와 난수 소비가 지금과 비트 단위로 같다. 내정 수정자는 `domestic.score`에 걸리고 경험·공헌이 같은 score를 따른다(T18-Q1). 제공자는 빈 정적 목록 `modifiers/providers.ts`다(T18-Q2). (나) 장비 목록·매매·장착 효과와 화면(T4-22~T4-24, U-06·U-19)은 채택하지 않았다 | (가) rules 골든(수정자 없을 때 내정·전투 결과와 RNG 소비 불변). (나) rules 골든 + 통합 + E2E | 🟨 | 미완료. D-027 후속으로 (가)만 채택. 부모 Codex가 T4-18 계획의 T18-Q1·Q2를 순수 기술 계약으로 수용했다. Codex 구현은 PR #171 exact [`e0bb1c5`](https://github.com/peppone-choi/opensamguk/commit/e0bb1c5b7cf2e0fdbf8376dc1561aceab028b173)이며 집중 시험 146개와 골든 비교가 통과했다. Claude 독립 리뷰 [5623797892](https://github.com/peppone-choi/opensamguk/pull/171#pullrequestreview-5623797892)(`PASS_IMPLEMENTATION_SCOPE`)를 통과했다. CI [39897983940](https://github.com/peppone-choi/opensamguk/actions/runs/39897983940)에서 check job 120232735604(단위 91파일 871개)와 DB·브라우저 job 120232735893(PostgreSQL 23파일 378개, 권한 절차 24개·실행 101건·면제 19건·누락 0, Chromium 75개 skip 0, 빌드)이 성공했고 simulation [39897842539](https://github.com/peppone-choi/opensamguk/actions/runs/39897842539)도 성공했다. main [`01af38b`](https://github.com/peppone-choi/opensamguk/commit/01af38b893833da34b7fcab580203c6e1af72c91)에 병합됐고 병합 CI [39899596746](https://github.com/peppone-choi/opensamguk/actions/runs/39899596746)이 성공했다. (가) 순수 공통 기반은 끝났고 (나)가 남아 AC는 미완료다. 실제 장비와 수치는 미승인이며 이 몫으로 AC를 닫지 않는다 | <!-- lint-text-ignore C-5 -->
| AC-P2-13  | 장수의 특기가 승인된 범위(U-07)의 내정·전투 계산에 들어간다. 특기가 없는 장수와 확장을 끈 월드의 결과는 지금과 같다(골든). (가) AC-P2-12 (가)와 같은 순수 공통 기반(T4-18). (나) 특기 목록·효과·획득과 화면(T4-25, T4-26, U-07·U-19)은 채택하지 않았다 | (가) rules 골든(수정자 없을 때 내정·전투 결과와 RNG 소비 불변). (나) rules 골든 + 통합 + E2E | 🟨 | 미완료. D-027 후속으로 (가)만 채택. AC-P2-12 (가)와 증거를 함께 쓴다(PR #171, main `01af38b`). 실제 특기와 수치는 미승인이며 이 몫으로 AC를 닫지 않는다 | <!-- lint-text-ignore C-5 -->
| AC-P2-15  | (가) 같은 시드와 참가자면 대진이 같다(T4-30, 종목 독립). (나) 참가가 C15 계약의 InputEvent로 기록되고 경기 결과가 같은 시드에서 같으며 보상이 한 트랜잭션에 저장된다(T4-54·T4-31, U-09 뒤) | (가) rules 단위. (나) rules 단위 + PostgreSQL + HTTP 권한 + E2E | 🟨 | 미완료. D-027으로 (가)만 채택. 부모 Codex가 G1~G5를 실제 RNG로 검증했다. (가)는 PR #162 exact head `09604e7`에서 Claude 독립 백엔드 리뷰 [5623645649](https://github.com/peppone-choi/opensamguk/pull/162#pullrequestreview-5623645649)(`PASS_IMPLEMENTATION_SCOPE`)와 pull CI [39895694550](https://github.com/peppone-choi/opensamguk/actions/runs/39895694550)·push CI [39895675122](https://github.com/peppone-choi/opensamguk/actions/runs/39895675122)를 통과해 main `7de674d`에 병합됐다. (나)가 남아 AC는 미완료다. 계약은 T4-30 계획의 단판 토너먼트 순수 대진이며 기술 상한 1024는 계산기 한계다. 실제 게임 참가 정원, 실경기, 보상, 참가 API, U-09는 (나)이며 미채택이다 | <!-- lint-text-ignore C-5 -->
| AC-P2-16  | 전투 시뮬레이터에 양쪽 병력·병종·훈련·사기·기술을 넣으면 Web Worker에서 실제 출병과 같은 계산 함수로 결과를 낸다. 같은 입력·시드면 실제 전투와 결과가 같다. 계산 중에도 입력이 막히지 않는다. 다른 국가의 비공개 값을 자동으로 채우지 않는다. 증거는 두 몫으로 따로 받는다. (가) 수동 입력 1회 계산(T4-34). 입력은 지금 `BattleInput`의 양쪽 `crew`·`crewType`·`train`·`atmos`, `attackerTech`·`defenderTech`, 성벽일 때만 `defence`, 다듬지 않은 시드 문자열과 저장소의 공개 basic 병종표뿐이다. 실제 Web Worker가 `simulateBattle(input, createRng(seed))`를 한 번 실행해 시드, 양쪽 남은 병력·사기, 입력 가정을 보인다. 같은 입력과 시드면 결과가 같다. 잘못된 입력은 화면과 Worker가 함께 막고 오래된 답은 버린다. 취소·오류·화면 이탈 때 Worker를 닫고 메인 30칸의 저장하지 않은 초안은 그대로다. 계산 코드는 별도 Worker 묶음에만 있고 배포 CSP 아래에서 동작한다. 새 API·DB, 비공개 값 조회와 자동 채움, 새 전투 수치·승률은 없다. (나) 실제 턴 동등성. 턴 RNG 흐름, 교전 전 군량 소비, 수비 장수 여럿과 성벽으로 이어지는 교전까지 실제 출병과 같은 결과를 낸다 | (가) Worker 차등 단위 시험 + 실제 빌드 Worker의 Chromium E2E + 묶음 확인. (나) rules 골든 + Chromium E2E | 🟨 | 전체 미완료. 2026-10-22 [D-023](./decisions.md#d-023-ac-p2-16을-인수조건에-올리고-수동-1회-계산-몫만-계약으로-채택한다-2026-10-22)으로 이 항목과 (가) 계약을 정식 반영했다. (가) 계약 원문은 PR #132의 [T4-34 계획](https://github.com/peppone-choi/opensamguk/blob/dce127bebda6d6b657c9f39acffe2398623e6fb5/docs/plans/T4-34.md)이며 Codex 계획 검토 [5610239606](https://github.com/peppone-choi/opensamguk/pull/132#pullrequestreview-5610239606)(head `35b0d7c`, `PASS_PLAN_CONTRACT`)이 수용했다. 구현 `4a99437`은 Codex 독립 리뷰 [5612224678](https://github.com/peppone-choi/opensamguk/pull/132#pullrequestreview-5612224678)(head `dce127b`, `PASS_IMPLEMENTATION_SCOPE`)을 통과했다. exact head CI [39755838684](https://github.com/peppone-choi/opensamguk/actions/runs/39755838684)·[39755844932](https://github.com/peppone-choi/opensamguk/actions/runs/39755844932)에서 단위 508개, 실제 PostgreSQL·HTTP 328개, Chromium 67개(skip 0), strict 202파일 0건, 웹 빌드가 통과했고 구현 SHA의 독립 CI [39751385485](https://github.com/peppone-choi/opensamguk/actions/runs/39751385485)도 단위·PostgreSQL·Chromium 수와 웹 빌드가 같다. 비병합 검증 [39755050739](https://github.com/peppone-choi/opensamguk/actions/runs/39755050739)(`16fdb6c`)은 실제 빌드 Worker에 시드 240개로 장수·성벽 480건을 보내 직접 함수와 같음을 확인하고 잘못된 요청 4건을 막았다. `deploy/security.caddy`의 CSP를 건 Chromium에서 위반 0건이었다. 이 수치는 PR #132 source의 기존 증거이며 정본 반영 문서 PR의 CI가 아니다. PR #132는 최신 main 결합 head [`b460bc2`](https://github.com/peppone-choi/opensamguk/commit/b460bc26d968a7e2f024c121d83d8117f5889c06)의 독립 판정 [5613458039](https://github.com/peppone-choi/opensamguk/pull/132#pullrequestreview-5613458039)(`1aa7dc4` 판정 [5613293573](https://github.com/peppone-choi/opensamguk/pull/132#pullrequestreview-5613293573)·[5613443686](https://github.com/peppone-choi/opensamguk/pull/132#pullrequestreview-5613443686) 위의 main 결합분)과 head CI [39770806819](https://github.com/peppone-choi/opensamguk/actions/runs/39770806819)·[39770808437](https://github.com/peppone-choi/opensamguk/actions/runs/39770808437)를 거쳐 main [`494272b`](https://github.com/peppone-choi/opensamguk/commit/494272b4bddbe966e359aff1f440d9828622c589)에 병합됐다. 병합 SHA의 CI [39772472368](https://github.com/peppone-choi/opensamguk/actions/runs/39772472368)은 `EXPECTED_SHA`가 병합 SHA와 같고 단위 530개(78파일), 실제 PostgreSQL·HTTP 337개(18파일), Chromium 67개(전투 시뮬레이터 6개 포함), 웹 빌드의 Worker 묶음 `battle.worker-DtWfSL2b.js`가 통과했다. 병합 SHA로 배포 CSP 검증을 새로 하지는 않았다. (가)는 main에 통합됐고 (나)는 남아 있다. (가)를 따로 완료 AC로 세지 않는다 | <!-- lint-text-ignore C-5 -->
| AC-P2-17  | 1차 범위. 로그인한 사용자가 기록 화면에서 월드의 달별 도시 소유를 재생한다. main에 이미 있는 `records.world` 조회는 Phase 2 성과로 세지 않는다. 응답에는 도시 소유와 공개 국가 표시값만 있고 국력·국고·군량은 없다. 두 달 끝의 소유 차이로 만든 표시는 추정 변화라고 밝히며 건국·멸망·전투 사건 자막으로 쓰지 않는다. 실제 사건 자막, 과거 이름과 색, 열전 문구, 공유는 2차 범위(T4-56, T4-37)다. 이 AC만으로 D4 완료를 판정하지 않는다(A-11). (가) 1차의 로그인 조회 API 몫(T4-35): 로그인한 사용자가 월드의 달별 도시 소유를 오래된 달부터 차례로 받는다. 응답에는 도시 소유와 지금 국가 행의 공개 표시값(이름·색)만 있고 국력·국고·군량과 비공개 필드는 없다. (나) 재생 화면 몫(T4-36): 기록 탭에서 들어가 페이지를 이어 받고 달을 재생하며 지도는 누를 수 없고 키보드·화면 낭독기로 쓸 수 있다. 저장값이 없는 국가가 있는 프레임은 지도 대신 국가 기록 누락 오류를 보이고 가짜 이름·색이나 회색 지도로 대신하지 않는다. 다른 정상 달로는 옮겨 갈 수 있다. 다시 붙인 화면은 새 달을 다시 받는다. (다) 멸망 국가 보존 몫(T4-56 (가), U-20 정정): 국가 행을 지우는 엔진 트랜잭션이 그 국가의 ID·이름·색을 남기고 월간 정산이 같은 트랜잭션에서 프레임 국가 값을 남긴다. 첫 정산 전이나 같은 달 안에 멸망한 국가도 남는다. 조회는 프레임마다 저장값을 낸다. 저장값은 공개 메타데이터뿐이고 국가의 비공개 상태는 없다. 사건 자막·공유·열전 문구 등 2차 나머지는 채택하지 않았다 | (가) PostgreSQL + HTTP 권한. (나) 웹 단위 + 실제 엔진 정산·출병 멸망 흐름의 Chromium E2E. (다) PostgreSQL 통합(롤백·같은 트랜잭션·백필) + HTTP 권한 | 🟨 | 미완료. D-027으로 (가)를 채택했다. (가)는 PR #162의 T4-35다. exact head `09604e7`에서 Claude 독립 백엔드 리뷰 [5623645649](https://github.com/peppone-choi/opensamguk/pull/162#pullrequestreview-5623645649)(`PASS_IMPLEMENTATION_SCOPE`)와 pull CI [39895694550](https://github.com/peppone-choi/opensamguk/actions/runs/39895694550)(PostgreSQL 23파일 378개, 권한 절차 24개·실행 101건·누락 0, Chromium 75개 skip 0 포함)·push CI [39895675122](https://github.com/peppone-choi/opensamguk/actions/runs/39895675122)를 통과해 main `7de674d`에 병합됐다. D-027 후속으로 (나)·(다)를 한정 채택했다. (다)는 부모 Codex 2차 기술 검토가 [T4-56 계획](../plans/T4-56.md) 저장·조회 계약을 수용했다. PR 1(보존 저장)은 로컬 구현을 마쳤고 실제 PostgreSQL 시험 19개, 월간 11개, 전쟁 18개와 빈 DB·기존 DB의 migration이 통과했다. exact SHA 독립 리뷰와 CI는 아직 없고 main 병합 전이다. PR 2(프레임 조회)는 로컬 구현을 마쳤고 실제 PostgreSQL 시험 145개, 단위 7개, 타입 검사가 통과했으나 아직 게시 전이다. (나)는 부모 Codex가 T4-36 순수 UI 계약을 기술 수용했다. Claude 구현의 순수 UI 시험 19개를 마쳤고 Codex의 U7 delta 4 검토가 PASS였다. 서버 연결·진입점·실제 E2E는 아직 없다. 쿼리 재마운트 캐시는 실제 정책으로 고치고 새 달 재조회 회귀 시험을 둔다. E10 취소 검증은 내리지 않는다. (나)의 실제 E2E와 병합은 T4-35와 T4-56 보존 조회 뒤이며 그 통합 전에는 이 AC 전체를 PASS로 보지 않는다. 공유·GIF(U-10), 사건 자막, 열전 문구, A-11 전체는 미채택·미승인이다. 정정 직후 기록: U-20 정정(D-027)으로 멸망한 국가도 저장해야 했고 그때는 저장 계약이 없었다. `currentNations` 조회로는 충족하지 않는다. (다) 저장은 (가) 완료로 세지 않는다 | <!-- lint-text-ignore C-5 -->

| AC-P2-26  | 월드 초기화 자원(지도·시나리오·병종·기본 능력치 규칙·초상 대응표)을 DB의 판으로 읽어 월드를 만든다. 내장 JSON은 초기화 SQL로 같은 키의 불변 판이 되고 저장소에서 지워진다. 이전 전 고정물의 재생 해시와 시뮬레이션 결과가 이전 뒤에도 같다. 같은 키에 다른 내용을 넣으면 실패한다 (D-028) | PostgreSQL + 재생 고정물 대조 + 공급자 일치 단위 시험 | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-P2-27  | 운영자가 관리자 콘솔에서 자원 판을 복제해 편집하고 검증을 통과한 판만 게시한다. 지도는 지형·도시 위치·연결·도시 추가와 삭제를, 시나리오·병종·능력치 규칙·초상 대응표는 표 편집으로 고친다. 게시한 판은 바뀌지 않고 새 월드를 만들 때 고를 수 있으며 진행 중인 월드는 영향받지 않는다. 권한 없는 계정의 편집·게시는 거부되고 모든 변경이 감사 로그에 남는다 (D-028) | HTTP 권한 + PostgreSQL + E2E | ⬜ | | <!-- lint-text-ignore C-5 -->
| AC-P2-28  | 게시한 지도 판마다 우리 밑그림만 입력으로 만든 도트 바탕 그림과 출처 기록이 있다. 메인·공개 지도는 이 그림을 도시 점과 연결선 아래에 깐다. 그림이 없는 판은 바탕 없이 그린다 (D-028) | 이미지 출처 기록 + E2E | ⬜ | | <!-- lint-text-ignore C-5 -->
