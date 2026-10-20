# 패키지 경계

> 상태: 초안 · 필요 시점: M1 · 참고: core2026 `docs/architecture/package-boundaries.md`
> 이 규칙은 M1 첫 주에 자동 검사(lint 또는 스크립트)로 만듭니다 (AC-M1-01).

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
- `apps/web`은 `packages/rules`를 import하지 않습니다 ⚠️. 화면의 사전 검사는 server API로 받습니다.
  (예외가 필요하면 순수 함수만 골라 `packages/shared`로 옮깁니다.)

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

- import 방향: 스크립트 또는 lint 규칙으로 CI에서 막습니다.
- `packages/rules` 안의 `Math.random`, `Date.now`, `new Date()`, `fs`, `fetch` 사용: lint로 막습니다.
