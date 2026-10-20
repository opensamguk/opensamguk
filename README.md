# opensamguk

여러 사람이 장수 한 명씩을 맡아 나라를 키우고 천하를 다투는 **턴 예약형 삼국지 웹 전략 게임**입니다.
원작 「삼국지 모의전투」([devsam/core2026](https://gitea.hided.net/devsam/core2026))의 핵심 루프를
참고하되, 규칙을 새로 단순하게 짜고 차별화 기능을 더한 새 게임입니다.

> 2026년 5~10월의 이전 opensamguk(Kotlin/Spring)과는 코드를 공유하지 않습니다. 이미지 자산만 승계합니다.

## 지금 어디쯤인가

| 관문                         | 완료 조건                                                    | 상태 |
| ---------------------------- | ------------------------------------------------------------ | ---- |
| 기획                         | PRD·요구사항·인수조건·차별화 선택                            | ✅ v0.2 (가정 원장 일부 남음) |
| M1 혼자 + NPC로 한 판 완주   | [AC-M1 21개](docs/product/acceptance-criteria.md#m1) 통과    | 🟨 3/21 |
| M2 지인 테스트               | [AC-M2 17개](docs/product/acceptance-criteria.md#m2) 통과    | ⬜ 0/17 |
| M3 공개 오픈 = MVP 완료      | [AC-M3 16개](docs/product/acceptance-criteria.md#m3) 통과    | ⬜ 0/16 |

진행률의 기준은 [인수조건](docs/product/acceptance-criteria.md)의 상태 하나뿐입니다.
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
- 이 저장소의 라이선스는 아직 정하지 않았습니다.
