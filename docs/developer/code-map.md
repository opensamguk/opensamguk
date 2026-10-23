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

## 지금 있는 파일

| 경로 | 역할 |
| ---- | ---- |
| `apps/server/src/index.ts` | DB 연결과 HTTP 서버 시작·종료 |
| `apps/server/src/server.ts` | Fastify 생성, 쿠키·인증 context, 비밀값을 제외한 로그 |
| `apps/server/src/auth/` | Argon2id, 세션 토큰 해시·만료·연장, 실제 HTTP·DB 테스트 |
| `apps/server/src/routers/auth.ts` | 가입·로그인·로그아웃·현재 계정 |
| `apps/server/src/trpc.ts` | 공개·인증 필수 procedure |
| `apps/server/src/router.ts` | tRPC `AppRouter` (API 계약): `health`, `auth`, `world`, `home`, `city`, `nation`, `records`, `general`, `turns`, `commands`, `ranking`, `timelapse` |
| `apps/server/src/routers/general.ts`, `turns.ts`, `commands.ts` | 생성 접수·조회, 예턴 편집·사전 검사, 인증 필수 명령 목록 |
| `apps/server/src/game/` | 소유 장수 조회·공개 projection·30칸 정규화와 표시 이름 |
| `apps/engine/src/inputs.ts` | PENDING 생성 재검사·General 저장·완료 결과와 순서 기록 |
| `packages/rules/src/general/create.ts` | 생성 입력 검사·결정적 초기 장수 규칙 |
| `packages/rules/src/tournament/bracket.ts` | 종목 독립 대진 순수 함수. DB·시각·`Math.random`을 쓰지 않는다 |
| `packages/shared/src/editArray.ts` | 범위 덮어쓰기·밀기·당기기·스냅샷 반복의 일반 배열 유틸 |
| `tools/t1-11.test.ts`, `t1-11.integration.test.ts` | 편집·생성 규칙·명령 schema, 실제 HTTP·DB 보안·경합·재시작·재생 시험 |
| `apps/server/src/routers/ranking.ts`, `ranking.integration.test.ts` | 정산 시점 장수 상위 100명·내 순위·국가 전체 순위, 실제 HTTP·DB 권한과 공개 필드 검증 |
| `packages/rules/src/ranking.ts` | 공헌·경험·전공·국가 순위와 공개 국력 계산, 동률 ID 정렬 |
| `apps/engine/src/ranking.ts`, `ranking.integration.test.ts` | 월간 트랜잭션의 순위 캐시 교체, 전공 누계·롤백·재생 호환 검증 |
| `apps/server/src/routers/timelapse.ts`, `timelapse.test.ts`, `timelapse.integration.test.ts` | T4-35: 월간 도시 소유를 오래된 순으로 읽는 로그인 API. 현재 국가 이름·색만 함께 읽고 국력·자원은 내지 않는다 |
| `apps/server/src/routers/world.ts` | 기존 `world.list`, 서버 시계 요약과 공개 94도시 지도 |
| `apps/server/src/routers/home.ts`, `city.ts`, `nation.ts`, `records.ts` | 세션 기준 메인·도시·국가·개인/국가/월드 기록 조회. 국가 기록은 DB JSON 조건으로 월간 요약만 페이지 처리 |
| `apps/server/src/visibility.ts`, `queries.ts` | 공개 필드 허용 목록과 범위 표, strict 입력, 일관된 읽기, 시각·페이지 변환 |
| `apps/server/src/visibility.test.ts`, `routers/reads.integration.test.ts` | 아군·적·재야 공개 범위와 실제 TCP·PostgreSQL 권한·페이지·94도시 성능 검증 |
| `apps/engine/src/index.ts`, `main.ts` | 기본 감독 진입점, `engine:run --world <ID>` 단일 월드 실행, 리스·30초 heartbeat·종료 |
| `apps/engine/src/supervisor.ts` | 10초 월드 발견, 월드별 자식·백오프·반복 크래시 중단·자기 자식 정리 |
| `apps/engine/src/supervisor.integration.test.ts`, `test/supervisorWorker.ts` | 실제 감독·엔진·DB의 수동 3개월·kill·정지·중복 감독·오류 격리 검증 |
| `apps/engine/src/lease.ts` | DB 시각 기준 실행권 획득·갱신·해제·펜싱 |
| `apps/engine/src/worldLoader.ts`, `turnLoop.ts`, `persist.ts` | 현재 상태 적재, manual/realtime 턴 실행, 원자적 저장 |
| `apps/engine/src/turnLoop.integration.test.ts` | 실제 DB, SIGKILL·동시 엔진·재시작·토큰 검증 |
| `apps/web/src/LoginPage.tsx` | 자리표시 로그인 화면과 서버 상태 표시 |
| `apps/web/apiTarget.ts` | dev 프록시가 쓸 API 서버 주소 (`SERVER_PORT`) |
| `apps/web/src/trpc.ts` | tRPC 클라이언트 (`AppRouter` 타입만 import) |
| `apps/web/src/pages/MainPage.tsx` | 메인 작업 화면 (D-020, R1 배치). 지도·명령 목록(T1-15 `TurnEditor`)·도시·국가·장수·기록 칸을 한 화면에 둔다 |
| `apps/web/src/main/` | 메인 칸 부품: `WorldMap`(94도시 SVG), `CityInfo`, `NationInfo`(국가 요약·표), `GeneralInfo`, `Records`(기록 3종 더 보기) |
| `apps/web/src/game/` | 화면 공용: 응답 타입(`types.ts`, 공개 범위 상세 필드), 조회 훅, 다음 턴 카운트다운·0초 재조회(`countdown.ts`), 오류 코드, 기록 연월, 명령·직책 이름 |
| `apps/web/src/layout/GameLayout.tsx` | 위쪽 띠(월드·연월·다음 턴·메뉴)와 본문 |
| `apps/web/src/pages/WorldPages.tsx` | 직접 주소용 보조 화면: 지도·도시·국가·기록 |
| `e2e/main.spec.ts`, `e2e/world.ts` | 실제 엔진 월드로 메인 작업 화면 E2E (턴 1분 월드 생성·시작, 시험 계정 장수 붙이기) |
| `packages/db/prisma/schema.prisma` | DB schema. 생성물은 `packages/db/src/generated/` (Git 제외) |
| `packages/shared/src/gameDate.ts` | 게임 달력 |
| `eslint.config.js` | 패키지 경계·결정성 규칙 |
| `tools/next-task.mjs` | `pnpm next`: 다음 작업과 담당 출력 |
| `resources/` | 지정된 core2026 리소스·초상 대응표와 `NOTICE.md` 출처 고지 |
| `tools/portrait-map/` | 초상 이름 대응 생성기, 원본 스냅샷, 후속 수정용 `manual.json` |
| `packages/rules/src/world/` | 리소스 schema와 순수 초기 상태 변환 |
| `packages/shared/src/rng.ts` | FNV-1a + Mulberry32 시드 RNG와 용도별 스트림 |
| `packages/shared/src/node/hashState.ts` | Node 전용 상태 SHA-256 |
| `apps/engine/src/world/` | 리소스 파일 읽기, 초기 상태 저장·재적재와 통합 테스트 |
| `apps/engine/src/cli/createWorld.ts` | `pnpm world:create` |
| `tools/run-integration.ts` | 전용 테스트 DB 준비·migration·통합 테스트 실행 |

## 공개 지도 (T2-24)

| 위치 | 역할 |
| ---- | ---- |
| `packages/shared/src/publicMap.ts`, `publicMap.test.ts` | 지연·간격 설정의 공통 검사와 기본값 |
| `apps/engine/src/publicMap.ts`, `turnLoop.ts` | 실제 시각 지도 사본 저장·정리, 턴 트랜잭션과 실행권 연결 |
| `apps/server/src/routers/world.ts`, `visibility.ts`, `publicMap.test.ts` | 무인증 지연 조회·공개 필드 투영·설정 시작 거부 검사 |
| `tools/public-map.integration.test.ts` | 실제 HTTP·PostgreSQL의 지연 경계·오염 JSON·리스·롤백·재시작·12개월 재생 검증 |

`packages/db/prisma/migrations/20261023010000_public_map_snapshot/migration.sql`이 `PublicMapSnapshot`을 만듭니다. 실제 HTTP와 엔진을 함께 실행하는 시험은 패키지 사이 상대 import 경계를 지키도록 배포물 밖의 `tools/`에 둡니다. `tools/authz.integration.test.ts`와 서버의 `authz/exemptions.ts`에는 새 공개 조회를 대조 대상으로 등록합니다.

## 새 저장 필드를 추가할 때 빠뜨리기 쉬운 것

순위는 `RankingSnapshot`에 월드별 최신 정산의 공개 필드만 저장한다. API는 캐시를 읽고 세션 장수의 순위를 찾으며 조회 중 캐시를 만들지 않는다.
`General.battleWins`, `General.captures`는 전투 결과에서 집계한 조회용 누계다. 기존 재생 해시를 보존하려고 `worldLoader`와 `world/persistence`의 게임 상태 적재에서는 제외한다. 기존 연감의 비공개 국력 계산은 유지한다.

순위의 공개 국력은 D-019의 자원·기술·보급 도시 내정·장수 능력·경험·공헌 합성값이다. 월별 배율은 국가마다 별도 시드 RNG로 계산한다. 월간 정산의 같은 트랜잭션에서 최종 상태로 계산한 국력만 순위 캐시에 저장하며 계산에 쓴 사유 값은 공개하지 않는다.

core2026 지침에서 가져온 체크리스트입니다.

- [ ] schema와 새 migration (기존 migration은 고치지 않음)
- [ ] 도메인 타입
- [ ] 엔진의 월드 적재
- [ ] 변경 추적과 저장
- [ ] 재시작 뒤 다시 읽는 테스트
