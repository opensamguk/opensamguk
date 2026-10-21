# 아키텍처 개요

> 상태: 초안 · 필요 시점: M1 · 참고: core2026 `docs/architecture/overview.md`
> 관련 결정: D-003(TS+React), D-006(다중 월드)

프로그램들의 책임을 한눈에 보는 지도입니다. 세부 실행 설정은 [런타임](./runtime.md)에 있습니다.

## 시스템 경계

```text
browser (apps/web, React SPA)
   │  tRPC (HTTP) + SSE
   ▼
apps/server ── 계정·세션·로비·게임 API·관리자 API
   │   ├─ 읽기: PostgreSQL에서 직접 조회
   │   └─ 쓰기: 예턴 편집, InputEvent 기록 (게임 상태는 직접 바꾸지 않음)
   ▼
PostgreSQL (하나의 DB, 모든 게임 데이터에 worldId)
   ▲   └─ LISTEN/NOTIFY ──▶ apps/server가 SSE로 화면에 알림
   │
apps/engine ── 월드마다 실행자 하나 (EngineLease + 펜싱 토큰)
   ├─ 월드 상태를 메모리에 올림
   ├─ 턴 실행, NPC AI, 월간 정산, InputEvent 처리
   └─ 한 턴의 결과를 한 트랜잭션으로 저장

packages/rules ── 순수 게임 규칙 (engine과 server가 함께 씀)
```

## core2026과 다른 점

| core2026                                         | 이 프로젝트                                  | 이유 |
| ------------------------------------------------ | -------------------------------------------- | ---- |
| gateway-api + game-api + game-engine, profile별 배포 | server 하나 + engine (월드별 실행자)      | 1인 운영. 같은 버전이 여러 월드를 돌린다 (D-006) |
| Gateway orchestrator (commit별 worktree, PM2)    | 없음                                         | 배포는 서버 1대에 한 버전 |
| profile마다 PostgreSQL schema                    | 한 schema, `worldId` 열                       | 단순함 |
| Redis (세션, pub/sub, worker)                    | 없음. 세션은 DB, 알림은 LISTEN/NOTIFY (가정 A11) | 구성 요소 하나 줄이기 |
| Vue 3                                            | React                                        | D-003 |
| 원작 PHP와 차등 검증                             | 결정성·재생 테스트                           | D-001 |

## 데이터 소유권

| 데이터                       | 기준 저장소                  | 바꾸는 쪽         |
| ---------------------------- | ---------------------------- | ----------------- |
| 계정·세션·제재·감사          | PostgreSQL                   | server            |
| 예턴                         | PostgreSQL (`GeneralTurn`, `NationTurn`) | server (revision 비교) |
| 월드·국가·도시·장수·외교     | PostgreSQL                   | engine만          |
| 요청 기록과 처리 결과        | PostgreSQL `InputEvent`      | server 기록, engine 처리 |
| 엔진 실행권                  | PostgreSQL `EngineLease`     | engine            |
| 지도·시나리오·병종·프리셋    | `resources/` 파일            | 빌드 시 포함      |
| 이미지                       | 외부 이미지 서버 (base URL)  | 별도 저장소       |

## 한 요청이 처리되는 흐름

```text
예턴 저장:   web ─▶ server: revision 비교 후 GeneralTurn 저장 ─▶ 응답
즉시 행동:   web ─▶ server: InputEvent(멱등 키) 기록 ─▶ engine이 처리 ─▶ 결과 저장 ─▶ NOTIFY ─▶ SSE
턴 실행:     engine 시계 ─▶ 예턴 1칸 실행 ─▶ 상태·로그·예턴 당김을 한 트랜잭션 ─▶ NOTIFY ─▶ SSE
```

자세한 저장 순서와 재시도는 [요청·턴·저장 흐름](../developer/request-turn-persistence.md)에 씁니다.

## 구현을 찾는 순서 (코드가 생기면)

1. `apps/web`의 route와 query에서 사용자 흐름을 찾습니다.
2. `apps/server`의 tRPC router에서 입력 검증과 권한을 찾습니다.
3. `apps/engine`의 턴 처리기에서 실행 순서를 찾습니다.
4. `packages/rules`에서 명령·조건·전투 계산을 찾습니다.
5. `packages/db`의 schema와 엔진의 저장 단계에서 저장 경계를 찾습니다.
