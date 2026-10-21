# 패키지 경계

> 상태: 초안 · 자동 검사 적용됨 (AC-M1-01) · 참고: core2026 `docs/architecture/package-boundaries.md`

## 의존 방향

```text
apps/web ──────────▶ packages/shared
apps/server ───────▶ packages/rules ──▶ packages/shared
apps/engine ───────▶ packages/rules
          └────────▶ packages/db ─────▶ packages/shared
apps/server ───────▶ packages/db
tools/* ───────────▶ 무엇이든 (배포물에 포함되지 않음)
```

- 화살표 반대 방향 import는 금지입니다.
- `apps/*`끼리는 서로 import하지 않습니다. 공유할 것은 `packages/`로 옮깁니다.
- `apps/web`은 `packages/rules`를 import하지 않습니다. 화면의 사전 검사는 server API로 받습니다.
  (예외가 필요하면 순수 함수만 골라 `packages/shared`로 옮깁니다.)
- 예외 하나: `apps/web`은 `@opensamguk/server/router`에서 tRPC `AppRouter` 타입만 import합니다 (`import type`).
  값 import는 lint가 막습니다.

## 패키지별 책임

| 패키지             | 넣는 것                                           | 넣지 않는 것 |
| ------------------ | ------------------------------------------------- | ------------ |
| `packages/shared`  | 타입, zod schema, 시드 RNG, 순수 유틸              | IO, 게임 규칙 |
| `packages/rules`   | 명령 정의, 조건, 전투, 경제, NPC 판단, 월간 정산 계산 | DB, 네트워크, 파일, `Date.now()`, `Math.random()` |
| `packages/db`      | Prisma schema, migration, client 생성             | 게임 규칙 |
| `apps/engine`      | 시계, 리스, 월드 메모리 적재, 턴 루프, 저장       | 규칙 계산 자체 |
| `apps/server`      | 인증, 권한, 입력 검증, 조회, 예턴 편집, SSE        | 게임 상태 변경 |
| `apps/web`         | 화면, 상태 표시, 입력                              | 권한 판단 |

## 검사

`eslint.config.js`가 막고 `tools/lint-boundaries.test.ts`가 규칙이 실제로 동작하는지 확인합니다 (`pnpm check`).

- import 방향: 패키지별 `no-restricted-imports`.
- 상대 경로로 다른 패키지 들어가기: 로컬 규칙 `opensamguk/no-cross-package-relative`가 실제로 풀린 경로로 판단해 막습니다.
- `packages/rules`: `Math.random`, `Date.now`, `new Date()`, `fetch`, node 내장 모듈 전체(`builtinModules`, 하위 경로, `node:` 접두사)를 막습니다.
- `packages/shared`, `apps/engine`: `Math.random`을 막습니다.
