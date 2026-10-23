# opensamguk

여러 사람이 장수 한 명씩을 맡아 나라를 키우고 천하를 다투는 **턴 예약형 삼국지 웹 전략 게임**입니다.
원작 「삼국지 모의전투」([devsam/core2026](https://gitea.hided.net/devsam/core2026))의 핵심 루프를
참고하되, 규칙을 새로 단순하게 짜고 차별화 기능을 더한 새 게임입니다.

> 2026년 5~10월의 이전 opensamguk(Kotlin/Spring)과는 코드를 공유하지 않습니다. 이미지 자산만 승계합니다.

## 지금 어디쯤인가

| 관문                         | 완료 조건                                                    | 상태 |
| ---------------------------- | ------------------------------------------------------------ | ---- |
| 기획                         | PRD·요구사항·인수조건·차별화 선택                            | ✅ v0.2 (가정 원장 일부 남음) | <!-- lint-text-ignore C-5 -->
| M1 혼자 + NPC로 한 판 완주   | [AC-M1 22개](docs/product/acceptance-criteria.md#m1) 통과    | 진행 중 (✅ 19 · 🟨 2 · ⬜ 1) | <!-- lint-text-ignore C-5 -->
| M2 지인 테스트 (참가자는 같은 수의 독립 에이전트로 대체, [D-021](docs/product/decisions.md#d-021-지인-참가-시험을-독립-에이전트-참가-시험으로-바꾸고-공개를-승인한다-2026-10-21)) | [AC-M2 20개](docs/product/acceptance-criteria.md#m2) 통과    | 진행 중 (✅ 2 · 🟨 0 · ⬜ 18) | <!-- lint-text-ignore C-5 -->
| M3 공개 오픈 = MVP 완료      | [AC-M3 16개](docs/product/acceptance-criteria.md#m3) 통과    | 진행 중 (✅ 0 · 🟨 1 · ⬜ 15) | <!-- lint-text-ignore C-5 -->

MVP는 M1·M2·M3 전체이며 M1만 끝나도 MVP 완료가 아닙니다. Phase 2(확장)는 M2와 다른 범위입니다 ([단계 계획](docs/product/phases.md)).
Phase 2 인수조건의 정식 범위는 [인수조건 P2](docs/product/acceptance-criteria.md#p2)와 D-023·D-027에서 봅니다. AC-P2-16과 AC-P2-01·02·12·13·15·17의 한정 몫이 올라 있으며 전체 Phase 2는 미완료입니다. 수동 입력으로 전투를 한 번 계산하는 몫(가)은 계약과 독립 기술 리뷰를 거쳐 PR [#132](https://github.com/peppone-choi/opensamguk/pull/132)로 main에 병합됐습니다. 실제 턴과 같은 결과를 내는 몫(나)이 남아 AC-P2-16은 진행 중입니다. 위 관문 집계와 MVP 진행률에는 넣지 않습니다.

진행률의 기준은 [인수조건](docs/product/acceptance-criteria.md)의 상태 하나뿐입니다.
위 숫자는 main [`76d56d0`](https://github.com/peppone-choi/opensamguk/commit/76d56d0db57f0e8d8686938591781632c71b2a20)의 AC-M1-22·AC-M2-01 수용과 PR [#67](https://github.com/peppone-choi/opensamguk/pull/67)의 D-022에 따른 AC-M1-14 재개(✅ → 🟨)를 합친 인수조건 문서에서 AC 행 58개(M1 22·M2 20·M3 16)의 상태 칸을 다시 센 값입니다. <!-- lint-text-ignore C-5 -->
문서에 기록된 상태를 센 것이며 새로 돌린 제품 전체 QA 결과가 아닙니다. 관문은 그 관문의 AC가 전부 ✅일 때만 통과합니다. <!-- lint-text-ignore C-5 -->
AC 57개 기준의 통과 비율은 옛 범위의 집계일 뿐 MVP 전체 진행률이 아닙니다. 2026-10-22 소유자 정정([D-022](docs/product/decisions.md#d-022-mvp-완료에는-모든-명령이-들어간다-2026-10-22))으로 MVP는 모든 명령을 완료해야 합니다. AC-M1-14도 다시 진행 중입니다. 명령 진행은 [명령 대응표](docs/product/command-coverage.json)를 `node tools/command-coverage.mjs`로 세어 봅니다. 2026-10-22 출력은 원작 비교 분모 90개, 정본 분모 91개, 전 단계 완료 0개입니다. <!-- lint-text-ignore C-5 -->
누가 무엇을 할 차례인지는 `pnpm next`로 봅니다 (계획 Claude → 구현 담당 → 리뷰 반대쪽).

## 문서

| 알고 싶은 것          | 문서                                                   |
| --------------------- | ------------------------------------------------------ |
| 무엇을 왜 만드나      | [PRD](docs/product/prd.md)                             |
| 언제 끝났다고 하나    | [인수조건](docs/product/acceptance-criteria.md)        |
| 어떤 순서로 하나      | [단계 계획](docs/product/phases.md)                    |
| 작업 규칙 (사람·AI)   | [AGENTS.md](AGENTS.md)                                 |
| 전체 문서 지도        | [docs/index.md](docs/index.md)                         |

## 기술 스택 (계획)

TypeScript · Node.js 24 · pnpm workspace · Fastify · tRPC · zod · React · Vite · TanStack Query ·
PostgreSQL · Prisma · Vitest · Playwright · Docker Compose · Caddy

## 저장소 구성 (계획)

| 경로               | 책임                                              |
| ------------------ | ------------------------------------------------- |
| `apps/web`         | 로비와 게임 화면 (React SPA)                      |
| `apps/server`      | 계정·로비·게임 API, SSE                           |
| `apps/engine`      | 월드별 턴 엔진, NPC AI, 월간 정산                 |
| `packages/rules`   | 순수 게임 규칙 (명령, 전투, 경제). DB·IO 없음     |
| `packages/shared`  | 공통 타입, zod schema, 결정적 RNG                 |
| `packages/db`      | Prisma schema, migration, DB client               |
| `resources/`       | 지도, 시나리오, 병종, 월드 프리셋                 |
| `tools/`           | 시뮬레이터, 문서 생성, 검사 스크립트              |
| `docs/`            | 제품·아키텍처·개발·플레이어·운영 문서             |

## 참고와 라이선스

- **core2026** (MIT, © 2025 devsam): 구조와 규칙을 참고합니다. 코드나 리소스를 옮길 때는 출처와 MIT 고지를 남깁니다.
- **이미지**: [이미지 자산](docs/image-assets.md)을 보세요. 공개 전에 라이선스 관문(AC-M3-06)을 통과해야 합니다.
- 이 저장소의 코드와 문서는 [MIT](LICENSE)입니다. 옮겨 온 리소스의 출처와 원 라이선스는 [resources/NOTICE.md](resources/NOTICE.md)에 있습니다.
  이미지 저장소의 그림은 이 라이선스에 포함되지 않습니다 ([이미지 자산](docs/image-assets.md) §3).
