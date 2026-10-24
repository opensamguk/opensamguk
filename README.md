# opensamguk

여러 사람이 장수 한 명씩을 맡아 나라를 키우고 천하를 다투는 턴 예약형 삼국지 웹 전략 게임입니다.
원작 「삼국지 모의전투」([devsam/core2026](https://gitea.hided.net/devsam/core2026))의 핵심 루프와 기존 명령을 재사용하면서 현재 구조에 맞게 옮깁니다.

v1의 기존 명령 구현을 재사용해 TypeScript 엔진·API에 이식·연결합니다. 원본 동작과 회귀 사례를 대조하고 승인된 규칙 차이를 반영합니다.

## 지금 어디쯤인가

| 범위 | 전체 AC | 통과 |
| --- | ---: | ---: |
| M1 혼자와 NPC로 한 판 완주 | 22 | 20 |
| M2 독립 에이전트 참가 시험 | 20 | 4 |
| M3 공개 오픈 | 16 | 0 |
| Phase 2 확장 | 28 | 1 |

완료 판정과 검증 증거는 [인수조건](docs/product/acceptance-criteria.md)에서 확인합니다. MVP는 M1·M2·M3의 58개 AC이며 Phase 2의 28개는 별도로 집계합니다. 모든 명령은 D-022에 따라 MVP 범위에 포함됩니다. 명령별 진행은 [명령 대응표](docs/product/command-coverage.json)와 `node tools/command-coverage.mjs`로 확인합니다. 다음 작업과 선행은 `pnpm next`와 [단계 계획](docs/product/phases.md)에서 봅니다.

집계 기준은 2026-10-24에 확인한 [인수조건](docs/product/acceptance-criteria.md)의 상태입니다.

## 문서

| 알고 싶은 것          | 문서                                                   |
| --------------------- | ------------------------------------------------------ |
| 무엇을 왜 만드나      | [PRD](docs/product/prd.md)                             |
| 언제 끝났다고 하나    | [인수조건](docs/product/acceptance-criteria.md)        |
| 어떤 순서로 하나      | [단계 계획](docs/product/phases.md)                    |
| 작업 규칙 (사람·AI)   | [AGENTS.md](AGENTS.md)                                 |
| 전체 문서 지도        | [docs/index.md](docs/index.md)                         |

## 기술 스택

TypeScript · Node.js 24 · pnpm workspace · Fastify · tRPC · zod · React · Vite · TanStack Query ·
PostgreSQL · Prisma · Vitest · Playwright · Docker Compose · Caddy

## 저장소 구성

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

## 개발

Node.js 24 이상과 pnpm을 씁니다. 로컬 실행의 배경은 [T1-02](docs/plans/T1-02.md), 코드와 검증 규칙은 [개발자 핸드북](docs/developer/index.md)과 [테스트 정책](docs/testing-policy.md)에 있습니다.

| 명령 | 용도 |
| --- | --- |
| `pnpm install` | 의존성 설치 |
| `pnpm check` | Prisma 생성, lint, 글·포맷 검사, 타입 검사, 단위 시험, 다음 작업 출력 |
| `pnpm format` | Prettier로 포맷 수정 |
| `pnpm format:check` | 포맷 검사 |
| `pnpm next` | 다음 작업과 담당 확인 |
| `pnpm db:up` | 로컬 PostgreSQL 시작 |
| `pnpm dev` | web·server·engine 개발 서버 실행 |
| `pnpm e2e` | Playwright 시험 |
| `pnpm test:int` | 전용 PostgreSQL DB 통합 시험 |
| `pnpm db:migrate` | DB migration 적용 |
| `pnpm db:init-resources` | 내장 자원을 GameResource에 초기화 |
| `pnpm db:init-scenarios` | 준비된 추가 시나리오 9개를 DB에 초기화 |
| `pnpm sim` | NPC 시뮬레이터 실행 |

DB 자원 초기화는 `pnpm db:init-resources` 다음 `pnpm db:init-scenarios` 순서로 합니다. 일반 월드 생성 CLI와 순수 시뮬레이터는 현재 JSON을 읽으며 DB 기반 생성·편집 경로는 별도로 있습니다.

`pnpm sim` 실행만으로 개발 PC 시간 기준인 AC-M1-18이 통과한 것은 아닙니다. 완료 여부는 인수조건의 상태와 증거로 확인합니다.


## 관련 저장소와 공개 이미지

이미지 저장소는 [opensamguk/opensamguk-images](https://github.com/opensamguk/opensamguk-images), 기존 배포 저장소는 [opensamguk/opensamguk-docker](https://github.com/opensamguk/opensamguk-docker)로 이전했습니다. 이미지 개발용 고정 커밋 `48163bd1ce8d54c54c94fb5484b05f9db9e50c62`와 초상 ID·경로 계약은 유지합니다.

공개 자산은 기존 기본 SVG(`apps/web/src/portrait/fallback.svg`)만 쓰기로 승인했습니다. 원작 초상은 공개 세트에서 빼고 현재 1030 장수 이름·능력치와 NOTICE는 보존합니다. 외부 초상을 공개하지 않는 승인 목록은 `imageRepoCommit: null`, `imageBaseUrls: []`, `portraitIds: []`입니다. 저장소 이전은 그림의 공개 이용 허락을 뜻하지 않습니다. 공개 빌드·자산 검사·배포와 이미지 서버 직접 제공 정책의 검증은 [T3-13](docs/plans/T3-13.md)과 AC-M3-06에서 따로 확인합니다.


## 참고와 라이선스

- core2026 (MIT, © 2025 devsam): 구조와 규칙을 참고합니다. 코드나 리소스를 옮길 때는 출처와 MIT 고지를 남깁니다.
- 이미지: [이미지 자산](docs/image-assets.md)을 보세요. 공개 전에 라이선스 관문(AC-M3-06)을 통과해야 합니다.
- 이 저장소의 코드와 문서는 [MIT](LICENSE)입니다. 옮겨 온 리소스의 출처와 원 라이선스는 [resources/NOTICE.md](resources/NOTICE.md)에 있습니다.
  이미지 저장소의 그림은 이 라이선스에 포함되지 않습니다 ([이미지 자산](docs/image-assets.md) §3).

v1 원본은 [peppone-choi/opensamguk-v1](https://github.com/peppone-choi/opensamguk-v1)의 커밋 `bc053629710711d4c5dfa50683bae78f4baeca95`입니다. 비공개 참고 저장소이며 라이선스는 MIT입니다. 원 고지는 `Copyright (c) 2026 빼뽀네 (peppone-choi) and OpenSamguk contributors`입니다. 코드를 옮길 때 파일 출처와 원 MIT 고지를 남깁니다.
