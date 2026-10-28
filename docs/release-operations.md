# 릴리스 운영

> 상태: 뼈대 · 필요 시점: M2 · 관련 AC: M2-08, M2-09, M2-10, M3-09, M3-10
> 참고: core2026 `release-operations.md`, `e2e-caddy-routing.md`, `developer/game-clock-recovery.md` (셋을 합침)
> 이 문서가 답할 질문: 서버 1대에 어떻게 배포하고 되돌리고 백업하고 장애에 대응하나?

## 1. 구성 (가정 A13)

서버 1대 + Docker Compose (PostgreSQL, server, engine, Caddy) + Cloudflare(DNS·CDN)

<!-- TODO(M2): compose 파일 위치와 서비스 목록. -->

## 2. 배포

<!-- TODO(M2): 명령 하나로 배포 (AC-M2-08). migration 적용 → server·engine 재시작 → 상태 확인. -->

### 공개 실행 이미지 (T2-15 B2a)

`deploy/Dockerfile`은 Node24 공식 이미지의 digest와 pnpm10.33.0을 고정하고 lockfile 설치·Prisma 생성을 실행합니다. `server`·`engine`·`migrate` 대상은 같은 소스를 쓰며 `web` 대상은 `build:public`·자산 검사를 거친 정적 파일만 `/web`으로 내보냅니다. API와 엔진은 UID/GID10001로 실행하고 진입점이 실제 Node 프로세스를 `exec`합니다. API의 기존 loopback 바인딩을 유지합니다.

빌드 입력은 검토한 Git archive의 별도 디렉터리입니다. Dockerfile 옆의 `Dockerfile.dockerignore`가 package·lock·앱·패키지·도구·문서·필수 manifest·resources만 받고 `.git`·`.env*`·private·호스트 의존성·백업·로그·시험 산출물을 제외합니다. stdin tar는 이 필터의 검증으로 세지 않습니다. `SOURCE_REVISION`은 실제 기준 커밋40자이고 `SOURCE_TREE_SHA256`은 후보 소스 경로·파일 바이트의 SHA-256입니다. 두 값은 이미지 label에 남으며 후보 해시를 확정 릴리스로 선언하지 않습니다. 깨끗한 소스의 선택·해시 생성·manifest·배포 receipt·current 교체 명령은 B2 후속에 남아 있습니다.

실행 비밀 디렉터리 `/run/secrets`는 UID10001 소유·0700이어야 하고 `database_url`·`mail_api_key`는 같은 소유자·0600의 일반 파일이어야 합니다. 디렉터리를 read-only로 마운트하며 기본0444 Compose secret은 그대로 사용할 수 없습니다. 파일은1~4096바이트의 UTF-8로 줄바꿈·NUL 없이 저장하고 심볼릭 링크를 쓰지 않습니다. DB 파일에는 인증 정보와 DB 경로를 갖춘 PostgreSQL URL을 넣습니다. URL은 진입점의 exec 환경에만 전달하며 `DATABASE_URL`·`MAIL_API_KEY`·`RESEND_API_KEY`를 호스트 환경에서 전달하면 빈 값도 거부합니다. Git·명령 인자·build ARG·이미지 환경·로그·`VITE_*`에는 비밀값을 넣지 않습니다.

메일 후보를 선택한 뒤 `MAIL_TRANSPORT=resend`·인증한 `MAIL_FROM`을 설정합니다. 키는 `/run/secrets/mail_api_key`의 경로만 기존 `MAIL_API_KEY_FILE` 계약으로 전달합니다. 운영 모드의 미설정 메일·capture는 시작 실패가 정상이며 개발 capture 기동을 운영 메일 인수로 세지 않습니다. 서버·도메인·메일 선택과 실제 수신 확인은 아직 남아 있습니다.

2026-10-28 로컬 Linux Docker에서 실제 디렉터리 입력으로4개 대상을 빌드하고 공개102파일·승인 이미지6개·외부 초상0개를 확인했습니다. 내보낸 Linux web의 실제 Chromium4건도5.5초에 통과했습니다. 비밀 canary8경로의 제외, 이미지 설정·history와 저장한 layer998,077,087바이트의 비노출을 검사했습니다. 실제 Linux에서 누락·빈 파일·0444·잘못된 디렉터리/소유자·링크·잘못된 UTF-8·NUL·줄바꿈·4097바이트와 원문 환경의 거부를 확인했습니다. 전용 PostgreSQL의 두 정식191년 월드는42국·982NPC·29,460예약으로 초기화됐고 API·두 엔진의 상태, 정상 종료0·DB 연결0·자기 컨테이너/volume/network 정리를 확인했습니다. 운영 메일·원격 배포·되돌리기·매일 백업·전체 AC-M2-08·09는 미완료입니다.

### 로컬 산출물 manifest (T2-15 B2b1)

서버·도메인 선택 전에도 `node --import tsx tools/release-artifact.ts /secure/release-build.json`으로 로컬 산출물을 준비할 수 있습니다. 입력은 아래 세 값만 받으며 먼저 origin/main을 fetch하고 해당 소스의 보호 병합·필수 CI·독립 리뷰를 확인합니다. 도구는 fetch·공개 배포·서비스 재시작을 수행하지 않습니다.

```json
{
  "sourceRevision": "보호 main 이력의 실제 커밋 40자",
  "outputDirectory": "/secure/releases",
  "dockerExecutable": "/usr/bin/docker"
}
```

출력 부모는 기존 일반 디렉터리이며 모든 checkout 밖이어야 합니다. 쉼표·따옴표·줄바꿈 경로는 Docker 출력 옵션이 달라지지 않도록 거부합니다. 도구는 `<outputDirectory>/<sourceRevision>`을 독점 생성하고 기존 빈 디렉터리도 덮어쓰지 않습니다. 실패한 자기 partial과 빌드 기록을 자동 삭제하지 않습니다. 성공 전에는 manifest.json이 없습니다.

검증한 Git tree의 경로·종류·알려진 내부 링크만 받아 archive로 추출하고 모든 파일을 원본 blob과 대조합니다. 경로는 `/`로 잇고 UTF-8 바이트 순서로 정렬해 소스 해시와 파일 목록을 만듭니다. Windows의 전역 줄바꿈 설정은 사용하지 않으며 작업 트리의 수정·미추적 파일은 섞지 않습니다. 실제 server·engine·migrate·web를 빌드하고 세 이미지의 ID·소스 label·실행 사용자를 확인합니다. 이미지 archive와 공개 web의 실제 바이트·해시, migration 목록·SQL 해시, 초기화 자료·승인 자산 manifest 해시를 기록합니다. 체크섬을 먼저 쓰고 다시 확인한 뒤 manifest.json을 마지막에 확정합니다.

자료 계약은 아직 `unknown`이며 이를 근거로 되돌리기를 허용하지 않습니다. manifest는 로컬 정적 산출물의 근거이며 DB 대상·사전 백업·실행 단계·current 변경을 담을 배포 receipt를 대신하지 않습니다. Compose/Caddy·전송·배포/복귀 명령과 실제 운영 리허설은 후속입니다.

2026-10-28 보호 main `d82becb`에서 실제4대상 빌드와 소스1293개 Git blob 대조, image archive와 공개 web103파일(자산102개·metadata1개)·migration32개의 기록 바이트/해시를 확인했습니다. 같은 이미지 ID의 실제 Linux에서 정식191년 두 월드·8개 원본 규칙·API/엔진 health·정상 종료와 자기 자원 정리, 내보낸 web의 Chromium4건도 통과했습니다. 도구21건과 전체 check5317건·독립 코드 리뷰의 근거이며 CI·보호 병합과 운영 배포 완료를 뜻하지 않습니다.

## 3. 되돌리기

<!-- TODO(M2): 이전 이미지 태그로 되돌리는 절차. migration이 있으면 어떻게 하나. 리허설 기록 남기기. -->

## 4. 백업과 복구

T2-15 B1의 로컬 fixture 리허설은 검증했습니다. `tools/backup.sh`와 `tools/restore.sh`는 지정한 기존 컨테이너만 사용합니다. 컨테이너 ID64자와 PostgreSQL `system_identifier`를 대조하며 compose를 탐색하거나 컨테이너를 기동하지 않습니다. `DOCKER_HOST`는 로컬 daemon으로 명시하고 `DOCKER_CONFIG`는 소유 빈 디렉터리로 지정합니다. 비밀번호나 연결 URL을 인자로 주지 않습니다. 컨테이너 안 local socket 인증이 맞지 않으면 멈춥니다.

```sh
bash tools/backup.sh --docker <docker 절대 경로> --container <64자 ID> --system-identifier <숫자> --db-user <role> --admin-db <카탈로그 DB> --source-db <원본 DB> --backup-dir <절대 경로> --reason rehearsal --release-sha <검토한 실제 소스 커밋 40자 SHA>
bash tools/restore.sh --docker <docker 절대 경로> --container <64자 ID> --system-identifier <숫자> --db-user <role> --admin-db <카탈로그 DB> --archive <dump 절대 경로> --manifest <manifest 절대 경로> --target-db <새 t215_dst_UUID32_test 이름>
```

Windows 시험은 PATH의 Bash 대신 `C:/Program Files/Git/bin/bash.exe`를 사용합니다. `rehearsal`·`pre-deploy` 백업은 다른 연결이 없고 유효한 엔진 리스가 없는 원본만 받습니다. 덤프 전후의 표·sequence 내용 해시도 같아야 합니다. `daily`는 덤프 snapshot을 기준으로 하며 내용 해시는 남기지 않습니다. 바이너리는 Bash 파일 redirection으로 전달합니다.

dump와 성공 manifest가 한 쌍이어야 백업 성공입니다. manifest에는 아카이브 SHA-256과 같은 snapshot의 적용 migration 목록을 남깁니다. 성공 실행 뒤에만 7일보다 오래된 성공 백업을 정리합니다. 외부 복사는 `not-configured`입니다. 매일 실행할 일정 설치와 외부 복사는 아직 하지 않았습니다.

복구는 새 리허설 대상만 받으며 기존 DB를 덮어쓰지 않습니다. 복원 실패 시 이번 실행이 만든 대상의 OID와 연결 0을 확인해야 삭제합니다. 운영 복구 대상의 비밀 파일·cutover 계약은 B2·B3 배정 전이므로 운영 복구는 거부합니다.

리허설의 준비와 각 진행 단계는 자체20초 기한을 둡니다. 기한을 넘기면 다음 진행을 막고 남은 작업의 종료를 기다린 뒤 자기 DB만 정리합니다. 기존 시험의30초 상한은 늘리지 않습니다.

2026-10-28 부모가 배정한 기존 전용 PG 슬롯·`T215_*` 입력과 깨끗한 소스로 실제 리허설11단계를 통과했습니다. 소스 archive·오프라인 설치·Prisma 생성·fixture 준비·실제 custom dump·stdin 복구·다음 월 진행·동일 시드 재생·원본 보존 대조를 확인했습니다. 각 단계는20초 안에 끝났고 정리 오류는0건이었습니다. Windows에서 실행한 이 증거만으로 Linux POSIX 권한이나 매일 백업·외부 보관·운영 cutover를 인수하지 않습니다.

backup의 필수 `--release-sha`는40자리16진 문자열을 그대로 manifest에 기록합니다. 누락·형식 오류는 Docker 호출과 파일 생성 전에 거부하며 Git fallback은 없습니다. B1은 검토한 실제 소스 HEAD를 전달해 manifest와 대조하며 추적 수정이 있으면 시험을 거부합니다. B2가 운영 current SHA를 얻어 전달할 방법을 정합니다. 전체 AC-M2-09는 미완료입니다.

## 5. 프록시 경로

<!-- TODO(M2): Caddy 경로 계약. /api, /sse, 정적 화면, 직접 주소 접근과 새로고침. -->

T3-04의 검토용 헤더 소스는 `deploy/security.caddy`입니다. T2-15가 HTTPS site 블록에서 `game_security` snippet을 import합니다. 이 파일만으로 배포하거나 Caddy를 기동하지 않습니다. 라우팅·인증서·배포 자동화는 T2-15 범위이며 여기서는 실제 운영을 바꾸지 않았습니다.

CSP는 `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' https://cdn.jsdelivr.net data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`입니다. 기존 화면의 국가 색 등 동적 style 속성만 `style-src-attr`로 허용하며 인라인 script와 style 요소는 허용하지 않습니다. 기존 개발 초상 출처 jsDelivr만 명시했으며 이미지 공개 권리 승인과는 별개입니다. 공개 이미지 출처가 확정되면 그 출처만 바꾸고 실제 빌드·브라우저 CSP 위반을 다시 확인합니다. HSTS는 `max-age=31536000`이며 다른 서브도메인까지 강제하는 `includeSubDomains`와 preload는 넣지 않습니다.

운영 API는 `NODE_ENV=production`, 정확한 HTTPS `PUBLIC_ORIGIN`, `TRUST_PROXY=1`로 Caddy 바로 뒤의 loopback에 둡니다. 직접 외부 API 포트를 열지 않습니다. Secure를 끄거나 잘못된 공개 출처를 지정하면 시작하지 않습니다. CORS를 열어 화면·API 출처를 분리하지 않습니다. 요청 제한은 단일 서버 메모리 계수이며 재시작 시 초기화됩니다. 서버를 늘리거나 재시작을 반복하는 운영 방식은 현재 계수기 보장을 벗어납니다.

## 6. 장애 대응

<!-- TODO(M2): 엔진이 멈췄을 때 (알림 → 로그 확인 → 리스 상태 → 재시작). 월드 일시정지 기준. -->

## 7. 모니터링 (M3)

<!-- TODO(M3): 가동 확인, 엔진 하트비트, 디스크·DB 용량 알림 (AC-M3-09). -->
