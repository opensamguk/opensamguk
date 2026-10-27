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
- 예외: `apps/web`은 `@opensamguk/server/router`에서 tRPC `AppRouter` 타입만 import합니다 (`import type`).
  값 import는 lint가 막습니다.
- 전투 시뮬레이터 예외 두 개 ([T4-34](../plans/T4-34.md)). 둘 다 정확한 파일 하나에만 열고 `tools/lint-boundaries.test.ts`가 확인합니다.
  - E1: `apps/web/src/battleSim/compute.ts`와 `compute.test.ts`만 `@opensamguk/rules`에서 `simulateBattle`·`unitSetSchema`·`BALANCE`·`commanderBattleModifiers` 값과 타입을 import합니다. 통합판 단일 교전은 엔진과 같은 지휘관 보정을 쓰며 관련 없는 세 능력치를 채우지 않습니다.
    `compute.ts`는 Worker 파일만 import하므로 이 코드는 Worker 묶음에만 들어갑니다. 이 두 파일도 `@opensamguk/shared/node`, engine·db 값, server 값, node 내장 모듈은 막힙니다.
  - E2: `apps/web/src/battleSim/publicUnitSet.ts`만 공개 병종표 `resources/unitset/basic.json` 하나를 상대 경로로 import합니다.
    이 파일에서만 `opensamguk/no-cross-package-relative`를 끄고 다른 상대 경로는 `no-restricted-imports`가 막습니다.
- E3 (T4-76): `apps/web/src/mapEditor/**`, `apps/web/src/admin/maps/**`, `apps/web/src/admin/resources/**`는 `@opensamguk/rules/resources`의 값과 타입만 읽습니다. rules 본 경로와 다른 하위 경로, shared/node, engine·db 값, server 값, Node 내장 모듈은 막습니다. 기존 `mapEditor/{contract,validate,sketch}.test.ts` 세 시험만 고정물 읽기와 PNG 해제에 쓰는 `node:fs`·`node:zlib`를 허용합니다. 다른 시험 파일에는 이 예외를 열지 않습니다.
  공개 모듈 `packages/rules/src/world/{map,validate}/`는 zod, 기존 `world/resources.ts`, 두 폴더의 형식·기하·검증 모듈만 읽습니다. 게임 실행 코드나 shared/node를 끌어올 수 없으며 경계 시험이 이를 확인합니다.

지도 편집기 예외 E3 ([T4-76](../plans/T4-76.md)): `apps/web/src/mapEditor/**`에서 `@opensamguk/rules/resource-validation`의 값과 타입만 읽습니다. rules 본 경로와 다른 하위 경로, `shared/node`, engine·db, server 값, Node 내장 모듈과 다른 패키지의 상대 경로 import는 막습니다. 공개 하위 경로는 순수 schema·검증 함수·타입·상수만 내보냅니다. 화면의 기존 임시 검증 코드를 바꾸는 작업은 후속 담당이 맡습니다.

## 패키지별 책임

| 패키지             | 넣는 것                                           | 넣지 않는 것 |
| ------------------ | ------------------------------------------------- | ------------ |
| `packages/shared`  | 타입, zod schema, 시드 RNG, 순수 유틸              | IO, 게임 규칙 |
| `packages/rules`   | 명령 정의, 조건, 전투, 경제, NPC 판단, 월간 정산, 확장 상태 조각 초기화·복제·형식 검사 | DB, 네트워크, 파일, `Date.now()`, `Math.random()` |
| `packages/db`      | Prisma schema, migration, client 생성             | 게임 규칙 |
| `apps/engine`      | 시계, 리스, 월드 메모리 적재, 턴 루프, 저장       | 규칙 계산 자체 |
| `apps/server`      | 인증, 권한, 입력 검증, 조회, 예턴 편집, SSE        | 게임 상태 변경 |
| `apps/web`         | 화면, 상태 표시, 입력                              | 권한 판단 |

확장 상태 처리는 순수 함수이며 DB·현재 시각·RNG를 쓰지 않습니다. `ext/state.ts`는 명령 registry와 명령 정의를 런타임에 읽지 않습니다. 명령이 `cloneWorld`를 부르고 복제가 상태 조각을 읽으므로 이 경계를 지켜야 순환 의존이 생기지 않습니다. 시험용 목록을 받는 내부 helper는 패키지 공개 진입점에서 내보내지 않습니다.

## 검사

`eslint.config.js`가 막고 `tools/lint-boundaries.test.ts`가 규칙이 실제로 동작하는지 확인합니다 (`pnpm check`).

- import 방향: 패키지별 `no-restricted-imports`.
- 상대 경로로 다른 패키지 들어가기: 로컬 규칙 `opensamguk/no-cross-package-relative`가 실제로 풀린 경로로 판단해 막습니다.
- `packages/rules`: `Math.random`, `Date.now`, `new Date()`, `fetch`, node 내장 모듈 전체(`builtinModules`, 하위 경로, `node:` 접두사)를 막습니다.
- `packages/shared`, `apps/engine`: `Math.random`을 막습니다.
