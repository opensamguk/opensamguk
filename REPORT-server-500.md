# 시험 서버 500·엔진 정지 조사 보고

2026-11-15. 요청은 `D:/codex-artifacts/int29-server-500-20261115/REQUEST.md`이며, AC-INT-28의 D-104·D-105 적용 뒤 서버·엔진 인수 경로를 조사했다. AC 상태는 바꾸지 않았다.

## 결과

요청은 미완료다. 원인을 숨기는 로그 경로는 수정했지만, 지정된 시험 DB에 접근하지 못해 기존 월드 자료와 새 규칙의 불일치를 확인하거나 고치지 못했다. 두 월드의 `home.get` 200과 `general.create`의 `created` 전환도 검증하지 못했다. 실제 개발 서버의 `lobby.worlds`는 마지막 확인에서도 HTTP 500이었다.

## 확인한 원인과 접근 제한

서버의 tRPC 오류 처리기는 `error.code`만 기록했다. `lobby`의 시나리오 조회는 원래 오류를 버리고 새 `TRPCError`를 던졌다. 엔진의 최상위 오류 처리기는 실행권 상실을 제외한 오류를 같은 안내문으로 바꿨다. 감독은 자식 프로세스의 stderr를 버렸으며, 실행 진입점은 감독 이벤트의 월드 ID·종료 정보를 출력하지 않았다. 이 경로들이 상세 원인을 가렸다.

현재 실행 환경에서 `127.0.0.1:3001`의 서버는 접근되지만 `127.0.0.1:5561`의 DB에는 연결되지 않는다. `.env`의 연결 정보를 출력하지 않고 DB 이름만 `opensamguk_int27_test`로 지정해 두 월드의 조회 경로와 엔진 적재 경로를 검사하려 했으나, 첫 World 조회에서 Prisma `P1001`이 발생했다. 별도의 TCP 검사도 실패했다. `wsl --list --quiet`는 `Wsl/E_ACCESSDENIED`로 거부됐다. 이 결과만으로 개발 서버 자체의 DB 연결 상태나 최초 장애 원인을 단정할 수는 없다.

월드 `c3786c85-71c2-4766-a633-287ad912b954`와 `140079f7-5747-49a9-bf9b-3f50f0bd169a`의 자료를 읽지 못했으므로 성별·능력치·보급·물류 원장 가운데 무엇이 잘못됐는지는 미확정이다. 추측으로 원장이나 재생 해시를 바꾸는 이행은 넣지 않았다. DB 접근 문제는 작업 중 사용자에게 알렸다.

## 바꾼 파일

| 파일 | 변경 |
| --- | --- |
| `packages/shared/src/node/errorDiagnostic.ts` | 오류 종류, DB·시스템 오류 코드, 최대 5개 코드 위치, Zod 검증 코드와 최대 3단계 cause를 추출한다. 원본 메시지·입력값·SQL·접속 URL은 출력하지 않는다. 검증 경로의 문자열 필드명도 가린다. Windows·POSIX 경로를 처리한다. |
| `packages/shared/src/node/hashState.ts` | 기존 Node 전용 공개 경로에서 진단 함수를 내보낸다. 해시 계산은 그대로다. |
| `packages/shared/src/node/errorDiagnostic.test.ts` | 검증 실패·Windows 경로·DB 코드·순환 cause·민감값 제외를 검사한다. |
| `apps/server/src/server.ts` | 등록된 tRPC 경로와 안전한 원인 진단을 기록한다. HTTP 오류 응답 계약은 유지한다. |
| `apps/server/src/serverErrors.test.ts` | 서버 주입 요청으로 500 응답과 내부 진단 로그를 검사하고 민감값·진단 정보가 응답에 나오지 않는지 확인한다. DB 실패는 시험에서 주입한다. |
| `apps/server/src/routers/lobby.ts` | 시나리오 조회 실패의 원래 cause를 보존한다. |
| `apps/engine/src/main.ts` | 기존 일반 안내문 대신 안전한 오류 진단을 출력한다. |
| `apps/engine/src/main.test.ts` | 실행권 오류와 접속 정보 비노출을 검사한다. |
| `apps/engine/src/supervisor.ts` | 자식 stderr를 전달하고 감독 실패 이벤트에 안전한 원인·종료 코드·종료 신호를 추가한다. 재시도 횟수와 간격은 바꾸지 않는다. |
| `apps/engine/src/supervisor.test.ts` | 가짜 자식의 시작 실패로 월드 ID·시스템 오류 코드 기록과 민감값 제외를 검사한다. 실제 프로세스를 종료하지 않는다. |
| `apps/engine/src/index.ts` | 시작 로그에 월드를 넣고 감독 이벤트의 전체 구조를 출력한다. |
| `docs/index.md` | 이 보고서를 등록한다. 기존 변경을 보존한다. |

진단 로그는 원본 오류 문장을 남기지 않는다. `diagnostic.name`, `code`, `issues`, `locations`, `cause`로 실패 종류와 코드 위치를 확인한다. 임의 입력이 섞인 메시지를 기록해 비밀번호·토큰이 노출되는 것을 피하기 위한 제한이다.

## 시험 결과

| 검사 | 결과 |
| --- | --- |
| `pnpm.cmd next` | 실행. 최신 사용자 인계에 따라 이번 장애 조사를 수행했다. |
| 관련 단위·서버 요청 주입·패키지 경계 시험 | 6파일 37건 통과. 아래 명령 참조. |
| shared·server·engine 타입 검사 | 통과. 이후 서버 시험 추가와 로그 경로 제한을 반영한 server·engine 검사도 재실행했다. |
| 변경 TypeScript ESLint·Prettier | 통과. |
| `pnpm.cmd check` | Prisma 생성·명령 문서 확인 통과. lint에서 기존 `apps/web/.tmp-model/drafts.tsx`, `patchCatalog.ts`, `ui-stage.tsx`의 오류 25건으로 중단. 이후 전체 검사 단계는 실행되지 않았다. |
| 지정 DB 자료 조회 | 첫 World 조회에서 `P1001`. 월드 적재·입력 처리 본문에 도달하지 못했다. |
| 개발 서버 `GET /trpc/lobby.worlds` | HTTP 500. 인증 없는 조회 결과이며 시험 계정 로그인 검증은 아니다. |
| DB TCP 연결 재확인 | `127.0.0.1:5561` 실패. |

통과한 관련 시험 명령은 다음과 같다.

```text
pnpm.cmd exec vitest run packages/shared/src/node/errorDiagnostic.test.ts apps/engine/src/main.test.ts apps/engine/src/supervisor.test.ts apps/server/src/serverErrors.test.ts apps/server/src/trpc.test.ts tools/lint-boundaries.test.ts
```

실행 Node는 v22.23.2이며 프로젝트 요구 버전은 24 이상이다. pnpm은 버전 경고를 냈다.

## 남은 작업과 미검증

지정 DB에 연결되는 환경에서 두 월드의 `readView`·`loadWorld` 오류와 새 진단 로그를 먼저 확인해야 한다. 그 원인을 확정한 뒤 필요하면 기존 원장의 이행 또는 읽기 호환 처리를 구현하고 회귀 시험을 추가해야 한다. 실제 시험 계정의 `home.get`, `advice.get`, `lobby.worlds`와 `general.create` 접수·처리 결과, 실제 감독 자식의 stderr 전달, DB 통합·E2E, Node 24 이상 실행, 독립 리뷰는 미검증이다. 단위 시험 통과를 월드 복구 증거로 세지 않았다.

`apps/web`·`e2e`는 수정하지 않았다. 커밋·푸시·PR·stash, 프로세스 종료·수동 서버 재시작, Docker 재시작, DB 쓰기·삭제는 하지 않았다. 진단용으로 새로 만든 임시 스크립트는 삭제했고 기존 임시 파일은 보존했다.
