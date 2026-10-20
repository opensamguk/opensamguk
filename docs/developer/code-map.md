# 파일 지도

> 상태: 뼈대 · 필요 시점: M1 (코드가 생기면 채움) · 참고: core2026 `docs/developer/code-map.md`
> 이 문서가 답할 질문: 어떤 일을 바꾸려면 어느 파일을 고치나?

## 변경 종류별 위치 (예정)

| 바꾸려는 것             | 고칠 곳                                                     |
| ----------------------- | ----------------------------------------------------------- |
| 새 명령                 | `packages/rules/src/commands/` + 테스트 + 명령 목록 생성     |
| 전투 계산               | `packages/rules/src/war/`                                   |
| 월간 정산               | `packages/rules/src/monthly/` + `apps/engine`의 정산 단계    |
| NPC 판단                | `packages/rules/src/npc/`                                   |
| 새 저장 필드            | `packages/db` schema + 새 migration + 엔진 적재·저장 + 재적재 테스트 |
| 새 API                  | `apps/server/src/routers/` + 권한 테스트                     |
| 새 화면                 | `apps/web/src/routes/`                                      |
| 지도·시나리오·프리셋     | `resources/`                                                |

## 지금 있는 파일 (T1-01~T1-03)

| 경로 | 역할 |
| ---- | ---- |
| `apps/server/src/index.ts` | Fastify 시작, tRPC를 `/trpc`에 연결 |
| `apps/server/src/router.ts` | tRPC `AppRouter` (API 계약). 지금은 `health`만 |
| `apps/engine/src/index.ts` | 엔진 자리 (대기만 함) |
| `apps/web/src/LoginPage.tsx` | 자리표시 로그인 화면과 서버 상태 표시 |
| `apps/web/apiTarget.ts` | dev 프록시가 쓸 API 서버 주소 (`SERVER_PORT`) |
| `apps/web/src/trpc.ts` | tRPC 클라이언트 (`AppRouter` 타입만 import) |
| `packages/db/prisma/schema.prisma` | DB schema. 생성물은 `packages/db/src/generated/` (Git 제외) |
| `packages/shared/src/gameDate.ts` | 게임 달력 |
| `eslint.config.js` | 패키지 경계·결정성 규칙 |
| `tools/next-task.mjs` | `pnpm next`: 다음 작업과 담당 출력 |
| `resources/` | 지정된 core2026 리소스와 `NOTICE.md` 출처 고지 |
| `packages/rules/src/world/` | 리소스 schema와 순수 초기 상태 변환 |
| `packages/shared/src/rng.ts` | FNV-1a + Mulberry32 시드 RNG와 용도별 스트림 |
| `packages/shared/src/node/hashState.ts` | Node 전용 상태 SHA-256 |
| `apps/engine/src/world/` | 리소스 파일 읽기, 초기 상태 저장·재적재와 통합 테스트 |
| `apps/engine/src/cli/createWorld.ts` | `pnpm world:create` |
| `tools/run-integration.ts` | 전용 테스트 DB 준비·migration·통합 테스트 실행 |

## 새 저장 필드를 추가할 때 빠뜨리기 쉬운 것

core2026 지침에서 가져온 체크리스트입니다.

- [ ] schema와 새 migration (기존 migration은 고치지 않음)
- [ ] 도메인 타입
- [ ] 엔진의 월드 적재
- [ ] 변경 추적과 저장
- [ ] 재시작 뒤 다시 읽는 테스트
