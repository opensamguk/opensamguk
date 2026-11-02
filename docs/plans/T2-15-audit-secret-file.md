# T2-15 로그인 조사 키 파일 설정

> 대기열: T2-15 · AC: AC-M2-08 (부분), 기존 계약 AC-M3-05 · 구현: Codex · 리뷰: 구현하지 않은 Claude · 기준: main `9ab06108`
> 선행: [T2-15 운영 실행 묶음과 Docker 경량화](./T2-15-runtime-bundles.md) (PR #334 병합) · 운영 문서: [릴리스 운영](../release-operations.md), [런타임](../architecture/runtime.md)

## 계획 (Claude)

### 목표와 계약

PR #334의 실제 리허설은 기본 `deploy/compose.yml`이 로그인 조사 키와 버전을 server에 넘기지 않아 별도 command override로만 시작했다. 이 작업은 기본 Compose와 `entrypoint.sh`의 바이트를 그대로 두고 override 없이 server가 health·로그인·SSE를 열고 engine이 턴을 진행하게 한다. 운영 배포와 복귀 리허설, 공개 named Tunnel의 두 공인 IP 검증은 도메인·토큰이 없어 계속 미완료로 남기므로 AC-M2-08 상태는 바꾸지 않는다.

키는 `/run/secrets/audit_hash_config` 한 파일에 한 줄 JSON `{"key":"<32바이트 이상>","version":<1..2147483647>}`로 둔다. 키와 버전이 한 파일이라 같은 디렉터리의 임시 파일을 `rename`하면 원자적으로 바뀌고 server 재시작 때 새 값을 읽는다. 기존 `LoginRecord`의 HMAC·DB 열·actor 판정과 `resolveLoginAudit` 검증 기준은 바꾸지 않는다.

설정 우선순위는 셋이다. `AUDIT_HASH_KEY`나 `AUDIT_HASH_KEY_VERSION`이 하나라도 정의돼 있으면 파일을 열지 않고 지금의 환경 검증 경로를 탄다(개발·기존 주입 유지). 둘 다 없고 `AUDIT_HASH_CONFIG_FILE`이 정의돼 있으면 파일을 읽는다. 셋 다 없으면 지금처럼 운영은 실패하고 개발은 수집하지 않는다.

파일 검사는 entrypoint의 비밀 파일 기준과 맞춘다. 경로는 절대 경로여야 하고 상위 디렉터리는 `lstat`으로 심볼릭 링크가 아닌 디렉터리, 0700, 현재 UID 소유여야 한다. 파일은 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`로 열고 같은 fd의 `fstat`으로 일반 파일, 0600, 현재 UID, 1~4096바이트를 확인한다. 읽기는 검사한 크기보다 한 바이트까지만 제한하고 실제 길이가 달라지면 거부한다. `TextDecoder('utf-8',{fatal:true,ignoreBOM:true})`로 디코드하고 NUL·CR·LF가 있으면 거부한다. JSON 최상위는 `key`·`version` 두 키만 가진 객체여야 하며 값 검사는 `resolveLoginAudit({}, true, 파싱값)`을 그대로 부른다. `process.getuid`나 `O_NOFOLLOW`가 없는 플랫폼(Windows)은 검사를 건너뛰지 않고 파일 설정을 거부한다. 모든 오류는 기존 문구 `로그인 조사 키 설정을 확인하세요.` 하나로 던지며 키·파일 내용·경로·원래 오류(`cause` 포함)를 붙이지 않는다.

### 파일별 범위

| 파일 | 바꾸는 것 |
| --- | --- |
| `apps/server/src/config/loginAudit.ts` (새 파일) | `loadLoginAuditOptions(env): LoginAuditOptions \| undefined`. 위 우선순위와 파일 검사만 둔다. Node `fs`는 이 파일에만 있다 |
| `apps/server/src/index.ts` | `resourceRoot()` 다음, API·Prisma 동적 import 전에 호출하고 결과를 `buildServer`의 선택 `loginAudit` 인자에 넘긴다 |
| `deploy/Dockerfile` | `server` target에만 `ENV AUDIT_HASH_CONFIG_FILE=/run/secrets/audit_hash_config`. `runtime`·`engine`·`migrate`는 그대로 |
| `apps/server/src/config/loginAudit.test.ts` (새 파일) | 정상·우선순위·거부 단위 시험. POSIX 시험은 Linux에서, Windows 거부 시험은 Windows에서 실제로 실행한다 |
| `tools/t2-15-audit-startup.test.ts` (새 파일) | 기존 `mail-startup-dependency-guard.mjs`로 시작 순서와 적재 전 거부를 본다. server 전용 ENV는 별도 Docker image inspect 증거로 확인한다 |
| `docs/release-operations.md`, `docs/architecture/runtime.md` | 113행의 간극 문구를 실제 설정 설명으로 고친다. 43행 비밀 파일 목록과 125행 준비 절차에 `audit_hash_config`를, runtime 환경 표에 `AUDIT_HASH_CONFIG_FILE`을 더한다 |
| `docs/plans/T2-15-runtime-bundles.md`, `docs/index.md` | 기존 기록 문장은 두고 인수 상태 끝에 이 계획 링크와 상태 한 줄을 덧붙인다. 지도에 이 계획을 등록한다 |

`deploy/compose.yml`, `deploy/compose.tunnel.yml`, `deploy/entrypoint.sh`, `apps/server/src/auth/loginAudit.ts`, `server.ts`, `mail/*`, shared·web·engine·Worker, DB schema·migration, 의존성, 게임 규칙과 결정 기록은 바꾸지 않는다. `mail/resend.ts`의 키 파일 리더는 메일 서비스 선택과 묶여 있고 권한 검사가 약하므로 재사용하거나 고치지 않는다. 새 adapter를 작게 쓴다. release 도구는 기존 시험이 깨질 때만 보고하고 고치지 않는다.

### 구현 순서

1. 단위 시험을 먼저 쓰고 adapter를 구현한다. 모드·UID 검사는 상수 하나로 묶지 않고 entrypoint와 같은 비교식으로 쓴다.
2. `index.ts`를 연결한다. 시작 검사 순서는 `DATABASE_URL` → 메일 → `resourceRoot` → 조사 키 파일 → API·Prisma 적재다. 오류 출력은 `DATABASE_URL` 분기처럼 고정 문구 후 종료 코드 1이다.
3. Dockerfile server target에 ENV 한 줄을 넣는다. engine·migrate는 파일을 요구하지 않는다.
4. 문서를 고치고 `pnpm lint:text docs`로 S1 패턴을 확인한다.
5. Windows와 실제 Linux Docker에서 아래 검증을 실행하고 증거 표를 채운 뒤 리뷰를 요청한다.

### 검증

정상 경로. 파일 값으로 server가 시작하고 `LoginRecord.hashKeyVersion`이 파일 버전과 같다. 환경 키가 있으면 잘못된 파일 경로가 있어도 파일을 열지 않는다. 개발 기본값(셋 다 없음)과 기존 환경 주입은 지금처럼 동작한다. 원자적 교체 뒤 server를 재시작하면 새 로그인 기록의 `ipHash`가 새 키의 HMAC이고 버전이 바뀐다.

오류 경로. 디렉터리 0755·다른 UID·심볼릭 링크, 파일 0644·0400·다른 UID·심볼릭 링크·FIFO(열기 대기 없음)·디렉터리, 0바이트·4097바이트, 잘못된 UTF-8·BOM·NUL·CR·LF, JSON 문법 오류·배열·추가 키·키 누락, 31바이트 키, 버전 0·1.5·문자열·2147483648, 빈 `AUDIT_HASH_CONFIG_FILE`, 상대 경로를 거부한다. 각 경우 종료 코드 1, 고정 문구 한 줄, 출력에 키·내용·경로 없음, `Server listening`과 의존성 적재 표지 없음을 확인한다. `DATABASE_URL` 누락과 메일 오류는 파일 검사보다 먼저 기존 문구로 실패해야 한다.

명령. `pnpm check`, `pnpm exec vitest run apps/server/src/config/loginAudit.test.ts apps/server/src/auth/loginAudit.test.ts tools/t3-02-mail-startup.test.ts tools/t2-15-audit-startup.test.ts`, Postgres가 있는 Linux에서 `tools/t3-05-login-audit.integration.test.ts`·`tools/t3-05-investigation.integration.test.ts`·`tools/security.integration.test.ts`, release 묶음 `tools/t2-15-release-*.test.ts`와 `node --import tsx tools/t2-15-release-target-linux.mts`를 실행한다. Linux 단위 시험은 Linux 컨테이너나 WSL의 비root 사용자로 돌려 POSIX 분기가 skip 0건인지 기록한다.

실제 Docker. PR head로 server·engine·migrate를 빌드하고 `docker image inspect`로 server만 새 ENV를 갖는지 본다. 별도 project name과 127.0.0.1 고포트의 저장소 밖 env 파일로 기본 `compose.yml`을 `-f` 하나만 주고 띄운다. app-secrets volume에 `database_url`·`mail_api_key`·`audit_hash_config`를 10001 소유로 준비하고 외부 메일은 보내지 않는다. 시험 계정은 DB에서 인증 완료로 만든다. 거부 사례는 같은 이미지에서 volume 내용만 바꿔 server 기동이 실패하는지 본다.

| 항목 | 결과 | 증거 |
| --- | --- | --- |
| `pnpm check` | 통과 | Windows 390파일·6520시험, pnpm-check-final.log |
| 단위·시작 순서 (Windows) | 통과 | 4파일·58시험. 파일 설정은 미지원 거부를 확인 |
| 단위 POSIX (Linux 비root) | 통과 | UID10001 실제 FS 29시험·skip0, linux-file-tests-final.log |
| 어댑터의 다른 UID 직접 거부 | 통과 | 별도 root 시험의 DAC override로 읽을 수 있는 다른 UID 디렉터리·파일도 거부. 양성 대조 포함3사례, 제품 권한과 구분 |
| 기존 mail startup | 통과 | 위 58시험에 기존 11시험 포함 |
| loginAudit·조사·security 통합 (실제 DB) | 통과 | Linux PostgreSQL18.6, 앞 두 파일19시험과 security42시험. 최종 각 파일 skip0 |
| release 계약 | 로컬 통과·CI gate | 4파일111시험. 실제 Linux metadata fixture는 필수 GitHub Actions에서 확인 |
| server ENV·engine/migrate 미설정 | 통과 | image inspect와 파일을 숨긴 채 migrate·engine 자식 기동 모두 성공 |
| compose.yml·entrypoint.sh 바이트 | 통과 | main9ab와 동일, Tunnel 파일도 동일. default-contract-proof.json |
| 기본 Compose 기동, override 없음 | 통과 | primary -f 한 개로 migrate→server health200→engine. CMD·ENTRYPOINT 원본 일치, raw audit ENV 없음 |
| 로그인 200과 ipHash·버전 대조 | 통과 | native argon2·Prisma WASM 실쿼리, 파일 HMAC·버전7 일치 |
| SSE 이벤트·재연결 | 통과 | 실제 Caddy+API 125067ms, heartbeat4·ready·턴 이벤트·재연결 |
| 엔진 턴 2회 이상·정상 종료·리스 해제 | 통과 | .mjs 자식, 월 경계2회·actionSequence0→6, 종료281ms·exit0·리스 만료 |
| 원자적 교체와 재시작 | 통과 | 파일 rename 뒤 기존 프로세스7 유지, server·Caddy 재기동 뒤 새 키 HMAC·버전8·SSE ready |
| Docker 거부 사례 | 통과 | UID10001 18사례 모두 exit1·고정 오류, 원문·경로·리스닝 로그 없음. 상위 디렉터리 오류는 기존 entrypoint 문구 |
| 공개 named Tunnel·두 공인 IP | 미실행 | 도메인·토큰 없음. 이 작업에서 완료로 세지 않는다 |

로그·비밀·리허설 DB는 `E:\codex-artifacts\opensamguk\t2-15-audit-secret-file`에 두고 Git에 넣지 않는다. skip·mock만의 행이나 미병합 상태를 완료로 보고하지 않는다.

### 독립 리뷰 gate

구현하지 않은 Claude 세션이 이 계획 대비 범위, 우선순위와 시작 순서, 파일 검사의 fd 재사용과 fail-closed, 오류 비노출, 고정 파일 바이트, 문구를 리뷰한다. 필수 지적이 0건이고 PR head 정확 SHA의 필수 CI가 녹색이며 증거 표의 미실행 행이 위 Tunnel 한 줄뿐일 때 병합 후보로 올린다. 필수 CI와 병합 결과는 PR 검사·증거 댓글로 기록하며 공개 Tunnel의 미완료 상태는 유지한다.

## 구현 기록

Node 전용 config 어댑터를 bootstrap에서 DB/API 동적 import 전에 읽고 기존 `LoginAuditOptions`로 전달했다. 파일은 같은 fd로 최대 검사 크기+1바이트까지만 읽는다. 기존 환경 주입·게임 규칙·공개 API·Workers·프론트는 바꾸지 않았다. JSON 중복 필드는 표준 `JSON.parse`의 마지막 값 선택을 따르며 별도 문자열 파서는 추가하지 않았다.

### 후속 이미지와 성능 재측정

측정 후보는 `9daa33e1`, 원본은 `f00ec07e`다. 같은 전용 DB·월드1개·활성 장수2명에서 각각3회 재시작하고60초 뒤 `/proc` RSS를 읽었다. server와 engine 모두 node·tsx의 esbuild 프로세스를 합산한 중앙값이며 engine의 자식도 포함한다. 원본 server만 기존 조사 키 전달 누락 때문에 역사적 명령 override를 썼다. 후보는 기본 Compose 그대로다. 원문은 `baseline-metrics.json`·`audit-file-metrics.json`·`comparison.json`이다.

| 항목 | 원본 | 파일 설정 포함 번들 |
| --- | ---: | ---: |
| server 이미지 (MiB) | 905.27 | 230.65 |
| engine 이미지 (MiB) | 905.27 | 228.55 |
| migrate 이미지 (MiB) | 905.27 | 457.96 |
| web 이미지 (MiB) | 6.65 | 6.22 |
| server RSS 합계 (MiB) | 244.91 | 185.82 |
| engine RSS 합계 (MiB) | 491.46 | 443.91 |
| engine 부모 RSS (MiB) | 205.11 | 158.39 |
| engine 자식 RSS (MiB) | 267.93 | 285.51 |
| server listen (ms) | 1547 | 569 |
| engine 새 heartbeat (ms) | 1788 | 631 |

자식 RSS는6.6% 늘었으며 engine 전체는9.7% 줄었다. 작은 표본의 중앙값이므로 장기 부하 결과로 세지 않는다. 네 타깃은 실제 Docker로 빌드했고 후보의 server는241853116 B, engine239653818 B, migrate480201944 B, web6525611 B다. SOURCE_REVISION·정규화한 소스 지문 label과 UID10001·read_only·cap_drop을 대조했다.

### 임시 공개 Tunnel의 제한된 증거

계정·도메인 없이 Quick Tunnel을 잠깐 열어 공개 HTTPS의 정적 경로 새로고침, Chromium 폼 표시·재로딩과 오류0을 확인했다. 실제 접속 공인 IP를 메모리에서만 읽고 파일 키의 HMAC과 `LoginRecord` 버전8을 대조했다. 같은 실제 IP의 요청 제한429와 위조 X-Forwarded-For의429도 확인했다. 원문 IP·비밀번호·세션·키는 결과 로그에 넣지 않았다. 서비스·cloudflared의 publish 포트는0개였고 시험 후 임시 Tunnel을 제거했다. 결과는 `quick-result.json`·`quick-login-refresh.png`다.

이 공개 검증은 실제 클라이언트1개뿐이다. [Cloudflare 공식 제한](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)상 Quick Tunnel은 SSE를 지원하지 않으므로 로컬 Caddy의125초 SSE를 공개 Tunnel 성공으로 세지 않는다. named Tunnel·서로 다른 두 공인 IP 조건은 계속 남는다.

## 독립 리뷰

읽기 전용 Claude 세션이 소스·계획·실제 원문과 이미지의 소스 복사본을 대조해 승인했다. P0·P1·필수 P2는0건이다. fd 크기 제한, 기존 환경 우선순위, DB·메일·audit 시작 순서, 고정 오류, 실제 Linux 분기와 제한된 공개 증거를 확인했다. 다른 UID 비교의 보완 시험은 `adapter-uid-probe.mjs`·`adapter-uid-result.json`에 따로 남겼다. 이 시험만 root와 DAC override를 써 파일이 실제로 읽히는 상태에서도 UID 비교로 거부함을 확인했다. 제품의 UID10001·cap_drop ALL 검증과 섞지 않았다. 상태 줄을 갱신했고 원문은 `claude-final-review.log`다. 정확한 PR head의 필수 CI·Linux metadata fixture·merge queue는 병합 전 gate로 남는다.
