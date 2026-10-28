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
| `apps/server/src/auth/` | Argon2id, 세션·계정 토큰 해시·만료·원자 소비, 재설정의 비밀번호·세션 폐기와 실제 HTTP·DB 테스트 |
| `apps/server/src/mail/`, `routers/account.ts` | 인증·재설정 메일과 개발 capture, 본인 계정 조회·재발급·토큰 소비 API. 운영 전송·가입 동의·미인증 게임 변경 차단·탈퇴는 후속 |
| `tools/t3-02-account-api.integration.test.ts`, `t3-02-session-lock.integration.test.ts`, `t3-02-mail-startup.test.ts` | 실제 계정 API 권한·메일함·두 API의 SSE 폐기, 재설정/메시지·SSE 교착 회귀와 운영 시작 거부 |
| `apps/server/src/routers/auth.ts` | 가입·로그인·로그아웃·현재 계정 |
| `apps/server/src/trpc.ts` | 공개·인증 필수 procedure |
| `apps/server/src/router.ts` | tRPC `AppRouter` (API 계약): `health`, `auth`, `world`, `home`, `city`, `nation`, `records`, `general`, `turns`, `commands`, `ranking`, `timelapse`, `message`, `notice`, `lobby` |
| `apps/server/src/routers/lobby.ts`, `lobby.test.ts` | 공개 월드 목록·로비 공지, 내 장수·생성 대기와 시나리오 이름 조회 |
| `apps/server/src/routers/message.ts`, `notice.ts`, `apps/server/src/messaging.ts` | 현재 세션·소속·직책 기준 메시지·공지, 읽음과 revision, DB 잠금 전송 제한 |
| `apps/server/src/realtime/` | 전용 LISTEN 연결과 SSE, 현재 권한 재검사, 하트비트·재구독·세션 종료 |
| `packages/db/src/realtime.ts` | 저장 commit 뒤 별도 SQL로 알림 전송. 송신 실패가 저장 결과를 바꾸지 않는다 |
| `tools/notice-publish.ts`, `t2-09.integration.test.ts` | 로비·월드 공지와 운영자 WORLD 메시지 작성, 실제 PostgreSQL·HTTP·SSE 시험 |
| `apps/server/src/routers/general.ts`, `turns.ts`, `commands.ts` | 생성 접수·조회, 예턴 편집·사전 검사, 인증 필수 명령 목록 |
| `apps/server/src/game/` | 소유 장수 조회·공개 projection·30칸 정규화와 표시 이름 |
| `apps/engine/src/inputs.ts` | PENDING 생성 재검사·General 저장·완료 결과와 순서 기록 |
| `packages/rules/src/general/create.ts` | 생성 입력 검사·결정적 초기 장수 규칙 |
| `packages/rules/src/general/creationBlock.ts`, `creationBlock.test.ts` | 로비·생성 접수·엔진이 같이 쓰는 장수 생성 판정 순서 |
| `packages/rules/src/tournament/bracket.ts` | 종목 독립 대진 순수 함수. DB·시각·`Math.random`을 쓰지 않는다 |
| `packages/rules/src/modifiers/` | 효과 합산과 빈 제공자 목록. 투자 점수·전투 피해·출병 전달 세 곳에 연결한다 |
| `packages/shared/src/editArray.ts` | 범위 덮어쓰기·밀기·당기기·스냅샷 반복의 일반 배열 유틸 |
| `tools/t1-11.test.ts`, `t1-11.integration.test.ts` | 편집·생성 규칙·명령 schema, 실제 HTTP·DB 보안·경합·재시작·재생 시험 |
| `apps/server/src/routers/ranking.ts`, `ranking.integration.test.ts` | 정산 시점 장수 상위 100명·내 순위·국가 전체 순위, 실제 HTTP·DB 권한과 공개 필드 검증 |
| `packages/rules/src/ranking.ts` | 공헌·경험·전공·국가 순위와 공개 국력 계산, 동률 ID 정렬 |
| `apps/engine/src/ranking.ts`, `ranking.integration.test.ts` | 월간 트랜잭션의 순위 캐시 교체, 전공 누계·롤백·재생 호환 검증 |
| `apps/engine/src/nationArchive.ts`, `nationArchive.integration.test.ts`, `cli/backfillYearbookNations.ts` | T4-56 (가) PR1: 삭제 직전 국가 표시값과 월간 프레임의 이름·색 저장, 실제 PostgreSQL 롤백·재시작·재생과 legacy 백필 검증 |
| `apps/server/src/routers/timelapse.ts`, `timelapse.test.ts`, `timelapse.integration.test.ts` | T4-35·T4-56 (가): 월간 도시 소유를 오래된 순으로 읽는 로그인 API. 프레임마다 저장한 국가 이름·색과 별도의 현재 표시값을 읽고 국력·자원은 내지 않는다 |
| `apps/server/src/routers/world.ts` | 기존 `world.list`, 서버 시계 요약과 공개 94도시 지도 |
| `apps/server/src/routers/home.ts`, `city.ts`, `nation.ts`, `records.ts` | 세션 기준 메인·도시·국가·개인/국가/월드 기록 조회. 국가 기록은 DB JSON 조건으로 월간 요약만 페이지 처리 |
| `apps/server/src/visibility.ts`, `queries.ts` | 공개 필드 허용 목록과 범위 표, strict 입력, 일관된 읽기, 시각·페이지 변환 |
| `apps/server/src/visibility.test.ts`, `routers/reads.integration.test.ts` | 아군·적·재야 공개 범위와 실제 TCP·PostgreSQL 권한·페이지·94도시 성능 검증 |
| `apps/engine/src/index.ts`, `main.ts` | 기본 감독 진입점, `engine:run --world <ID>` 단일 월드 실행, 리스·30초 heartbeat·종료 |
| `apps/engine/src/supervisor.ts` | 10초 월드 발견, 월드별 자식·백오프·반복 크래시 중단·자기 자식 정리 |
| `apps/engine/src/process-lifecycle.ts`, `process-lifecycle.test.ts`, `test/shutdownFixture.ts` | POSIX 신호·Windows IPC 종료 요청, 소유 자식의 5초 강제 종료와 실제 프로세스 시험 |
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
| `apps/web/src/timelapse/` | 기록의 영토 재생 탭 (T4-36): `timelapse.frames` 페이지 잇기, 프레임별 저장 국가값 출처, 재생 상태, 누를 수 없는 재생 지도. E2E는 `e2e/timelapse.spec.ts`·`e2e/timelapseSeed.ts` |
| `apps/web/src/timelapse/export.ts`, `exportCanvas.ts`, `SharedTimelapsePage.tsx`, `sharedSource.ts` | T4-37: 지금 달 PNG 그리기 명령(순수 함수)과 캔버스·내려받기, 종료 월드 공유 화면, 공개 조회 응답에서 재생 입력 칸만 고르는 함수. 재생 부품의 지도는 `frames.ts`의 `TimelapseMapCity`(이름·좌표·연결)만 받는다 |
| `e2e/main.spec.ts`, `e2e/world.ts` | 실제 엔진 월드로 메인 작업 화면 E2E (턴 1분 월드 생성·시작, 시험 계정 장수 붙이기) |
| `packages/db/prisma/schema.prisma` | DB schema. 생성물은 `packages/db/src/generated/` (Git 제외) |
| `packages/db/sql/resources-init.sql` | T4-77 생성물. 내장 다섯 자원 1판의 원본 JSON과 `resources/NOTICE.md` 출처를 담은 초기화 SQL이며 손으로 고치지 않는다. DB 적용 초기화 도구의 소스는 준비됐지만 실제 DB 초기화는 검증되지 않았고 공유 script에도 연결되지 않았다. 월드 생성은 지금도 `resources/` 파일을 읽는다 |
| `tools/resources-sql/convert.ts`, `generate.ts`, `convert.test.ts` | 다섯 자원을 검증해 위 SQL을 만드는 순수 변환·생성기와 단위 시험. 구분자·NUL 거부, S0 `contentHash` 고정, 출처 고지를 본다. DB를 쓰지 않는다 |
| `tools/init-resources.ts`, `resource-init.integration.test.ts` | T4-77 S2b 준비. 위 SQL을 한 트랜잭션에서 실행하고 같은 트랜잭션에서 S0 해시를 후검증하는 초기화 도구(C4)와 P1~P12·P29 실제 PostgreSQL 시험. 실제 PG 실행은 아직 하지 않았다 |
| `tools/resources-sql/generate-scenarios.ts`, `packages/db/sql/resources-scenarios.sql` | T4-46 A9의 별도 생성기·SQL. 기존 S2의 다섯 판과 SQL은 고치지 않고 준비된 시나리오만 검증·해시 대조 뒤 한 DO 문으로 만든다. 태그·NUL·내장 키를 거부한다 |
| `tools/init-scenarios.ts` | 내장 다섯 판을 확인하고 A9 SQL 실행과 저장 행의 해시·출처 대조를 한 트랜잭션에서 처리한다. `pnpm db:init-scenarios`는 삽입·기존 행 수와 실패 키만 출력한다 |
| `tools/fixtures/t4-46-scenarios.json`, `tools/scenarios.test.ts`, `tools/scenarios.integration.test.ts` | 출처·준비 상태 83행과 A9 원문·최소 수정·고정 해시, 단위 및 실제 PG 시험. 출처 완전성·원형 복원·재현성·SQL 문자열화·원자 거부·DB 합성·한 달 정산을 검증한다. 준비 상태로 AC 완료를 판정하지 않는다 |
| `packages/shared/src/gameDate.ts` | 게임 달력 |
| `eslint.config.js` | 패키지 경계·결정성 규칙 |
| `tools/next-task.mjs` | `pnpm next`: 다음 작업과 담당 출력 |
| `resources/` | 지정된 core2026 리소스·초상 대응표와 `NOTICE.md` 출처 고지 |
| `tools/portrait-map/` | 초상 이름 대응 생성기, 원본 스냅샷, 후속 수정용 `manual.json` |
| `packages/rules/src/world/` | 리소스 schema와 순수 초기 상태 변환. `map/`은 지도 v2 형식·변환, `validate/`는 자원 5종 순수 검증과 한도 |
| `packages/rules/src/world/resourceEditor/`, `tools/resource-editor-validate.test.ts`, `tools/resource-editor-boundaries.test.ts` | PR233 편집기용 지도 형식·기하·검증과 원본 시험. 공개 경로는 `@opensamguk/rules/resources`이며 기존 `resource-validation`의 보고 계약과 구분한다 |
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

관리자 공지의 엄격 입력·잠금·멱등·감사는 `apps/server/src/admin/notices.ts`에 있다. `routers/admin.ts`의 네 절차가 사용하며 `lobby.notices`·`notice.world.list`는 숨김 필터만 추가한다. `tools/t3-05-admin-notices.integration.test.ts`는 실제 HTTP·권한·경합·두 정식 월드 격리를 검사하고 `t3-05-notice-migration.integration.test.ts`는 기존 모든 행·sequence와 null 제목·고정 공지를 새 migration 전후로 대조한다. 두 운영 표는 게임 상태·재생 해시에 넣지 않는다.

관리자 공지와 월드 조회의 잠금 뒤 현재 권한 확인은 `apps/server/src/admin/access.ts`가 맡는다. `admin/worlds.ts`의 `admin.world.list`는 명시한 월드·사람 수·heartbeat를 같은 스냅샷에서 읽고 오류 원문을 응답하지 않는다. `tools/t3-05-admin-worlds.integration.test.ts`는 실제 두 정식 월드·사람30칸과 HTTP 권한·잠금 대기 뒤 회수·게임 행 불변을 대조한다. 월드 제어 실행기나 화면의 완료 근거를 대신하지 않는다.

관리자 월드 조회 화면은 `apps/web/src/admin/AdminWorlds.tsx`이며 기존 `usePrivateRead.ts`로 현재 신원과 지연 응답을 검사한다. `e2e/admin-worlds.spec.ts`는 두 정식 월드·사람30칸·행 불변과 수동 조회·네 폭·실제 권한 회수·전송 실패·지연 중 관리자 전환을 검사한다. 실제 검사와 독립 리뷰·보호 병합은 진행 중이다.

T4-56의 `RemovedNation`과 `YearbookNation`은 공개 표시값 보관이며 `WorldState`·재생 해시·보관 파일에는 넣지 않는다. 기존 프레임의 백필은 `pnpm db:migrate` 뒤 `pnpm --filter @opensamguk/engine yearbook:backfill`으로 보고를 확인하고 `--apply`로 실행한다. 현재 국가·삭제 보존·생성 기록의 이름과 색이 모두 일치할 때만 채운다. 근거가 없으면 부분 프레임으로 남기고 충돌이면 그 월드 전체를 롤백한다. 이름·색 변경을 넣는 T4-16은 같은 PR에서 이 CLI와 script를 지워야 한다.

`timelapse.frames`는 한 RepeatableRead 트랜잭션에서 월간 도시 소유와 `YearbookNation`을 읽는다. 각 프레임의 `nations`에는 그 달 도시를 소유한 국가의 저장된 ID·이름·색만 담는다. `currentNations`에는 이 페이지의 도시 소유 ID 가운데 지금 살아 있는 국가의 표시값을 따로 담는다. 과거 저장값이 없으면 해당 국가를 `nations`에서 생략하며 현재값이나 회색으로 채우지 않는다. `RemovedNation`은 이 조회로 공개하지 않는다.

순위는 `RankingSnapshot`에 월드별 최신 정산의 공개 필드만 저장한다. API는 캐시를 읽고 세션 장수의 순위를 찾으며 조회 중 캐시를 만들지 않는다.
`General.battleWins`, `General.captures`는 전투 결과에서 집계한 조회용 누계다. 기존 재생 해시를 보존하려고 `worldLoader`와 `world/persistence`의 게임 상태 적재에서는 제외한다. 기존 연감의 비공개 국력 계산은 유지한다.

순위의 공개 국력은 D-019의 자원·기술·보급 도시 내정·장수 능력·경험·공헌 합성값이다. 월별 배율은 국가마다 별도 시드 RNG로 계산한다. 월간 정산의 같은 트랜잭션에서 최종 상태로 계산한 국력만 순위 캐시에 저장하며 계산에 쓴 사유 값은 공개하지 않는다.

core2026 지침에서 가져온 체크리스트입니다.

- [ ] schema와 새 migration (기존 migration은 고치지 않음)
- [ ] 도메인 타입
- [ ] 엔진의 월드 적재
- [ ] 변경 추적과 저장
- [ ] 재시작 뒤 다시 읽는 테스트
