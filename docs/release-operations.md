# 릴리스 운영

> 상태: 뼈대 · 필요 시점: M2 · 관련 AC: M2-08, M2-09, M2-10, M3-09, M3-10
> 참고: core2026 `release-operations.md`, `e2e-caddy-routing.md`, `developer/game-clock-recovery.md` (셋을 합침)
> 이 문서가 답할 질문: 서버 1대에 어떻게 배포하고 되돌리고 백업하고 장애에 대응하나?

## 1. 구성 (가정 A13)

서버 1대 + Docker Compose (PostgreSQL, server, engine, Caddy) + Cloudflare(DNS·CDN)

<!-- TODO(M2): compose 파일 위치와 서비스 목록. -->

## 2. 배포

### 배포 관리 호스트

`tools/release-console-host.ps1 -Config <절대경로> -Watch`를 운영 호스트에서 PowerShell 7로 실행한다. `-Watch`를 생략하면 현재 판과 승인 목록을 게시하고 대기 중인 요청 한 건을 검사한다. 구성과 실행 기록 디렉터리는 저장소 및 웹 프로세스의 쓰기 범위 밖에 둔다. 서버와 엔진 이미지의 현재 판이 같고 PostgreSQL 컨테이너 ID·시스템 ID·DB OID가 일치해야 한다.

호스트 설정은 `dockerExecutable`, `project`, `databaseContainer`, `database`, `dbUser`, `databaseSystemId`, `databaseOid`, `runDirectory`, `drivers`, `candidates`를 받는다. 경로는 절대 경로이며 DB 식별값은 문자열이다. `drivers`의 키는 `DEPLOY`, `ROLLBACK`이며 승인한 실행기의 `path`와 `sha256`을 지정한다. `candidates`는 최대32행이며 각 행에 `fromRevision`, `revision`, `operation`, `manifest`, `manifestSha256`, `receipt`, `receiptSha256`을 넣는다. 호스트는 검증된 산출물 영수증과 등록한 해시가 모두 일치하는 대상만 게시한다.

호스트는 요청 만료, 관리자 자격, 현재 버전, 승인 목록을 다시 확인해 한 건만 실행한다. 실행기에 `-Operation`, `-ExpectedRevision`, `-Revision`, `-ManifestPath`, `-PreflightReceiptPath`, `-RequestId`를 전달한다. 실행기에는 사유를 넘기지 않는다. 웹에는 Docker 접근 권한, 호스트 파일 경로, 실행 로그를 전달하지 않는다. 새 버전의 서버와 엔진을 확인한 뒤 성공을 기록한다. 실행 중 호스트가 종료되거나 오류가 발생하면 자동 재실행을 차단한다. 운영 상태와 실행 기록을 확인한 운영자가 `-ResolveRequest <UUID>`로 실제 이전 판 또는 대상 판과 결과를 대조해 이력을 확정한다.

저장소의 Compose 배포 실행기는 `tools/release-compose-driver.ps1`이다. `OPENSAMGUK_RELEASE_COMPOSE_CONFIG`가 가리키는 호스트 설정에는 위 DB·프로젝트·Docker 항목과 `bashExecutable`, `backupScript`, `backupScriptSha256`, `backupDirectory`, `backupDockerConfig`, `runtimeDirectory`, `publicOrigin`을 지정한다. 현재 서비스 정지, 기존 `backup.sh`로 백업, 새 migration 적용, 서비스와 공개 HTML 해시 확인 순서로 실행한다. migration 시도 또는 새 writer 기동 뒤 실패하면 서비스를 정지하고 호스트 점검을 기다린다.

되돌리기는 현재 DB를 그대로 쓰는 경우에 같은 실행기를 등록한다. Compose 설정의 `rollbackPairs`에는 소유자가 애플리케이션 데이터 호환성을 검토한 `fromRevision`, `revision`, `currentManifest`, `currentManifestSha256`, `targetManifestSha256`을 지정한다. 실행기는 양쪽 산출물의 migration 이름·해시와 자원 SQL 해시, 현재 이미지 ID, 실제 DB의 적용 기록을 모두 확인한다. 서비스 정지와 백업 뒤 같은 DB로 이전 이미지를 기동하고 공개 화면을 확인한다. DB 스키마 또는 자료 계약이 다르면 별도 DB 복원과 전환 절차를 검증한 뒤 승인한다. 현재 `restore.sh`의 운영 대상은 접근 권한과 전환 절차가 정해질 때까지 보류한다.
<!-- TODO(M2): 명령 하나로 배포 (AC-M2-08). migration 적용 → server·engine 재시작 → 상태 확인. -->

### 로컬 산출물 사전 확인 (T2-15 B2b3a)

기존 `release-artifact.ts`의 산출물을 `bash tools/deploy.sh --preflight /absolute/preflight.json`으로 확인합니다. Node와 프로젝트의 tsx 설치가 필요합니다. 입력 JSON에는 `manifestPath`, `manifestSha256`, `sourceRevision`, `receiptDirectory` 네 값만 넣습니다. 경로는 절대 경로이고 마지막 값은 아직 없는 새 디렉터리여야 합니다. manifest 해시는 빌드 때 보관한 값, revision은 같은40자 소스 SHA를 사용합니다. DB URL이나 비밀값은 넣지 않습니다.

명령은 final manifest와 체크섬, 이미지·web archive, 공개 파일 전체, 원본 source archive/context, migration·resources·공개 자산 정책의 해시를 대조합니다. 현재 producer가 보존한 `.partial-<UUID>/source.tar`와 `context`가 필요합니다. 링크·경로 탈출·미지원 형식·누락·변조·다른 SHA·이미 있는 출력은 거부합니다. 원본 산출물을 다시 빌드하거나 덮지 않습니다.

통과하면 새 디렉터리에 `receipt.json`을 쓰며 결과는 `artifact-preflight-passed`입니다. 완료한 임시 파일을 최종 이름에 연결할 때 기존 파일을 덮지 않습니다. 실패 도중 남은 자기 디렉터리·partial은 보존합니다. receipt는 런타임 산출물이므로 Git에 넣지 않습니다. 이 명령은 배포 시작·이미지 load·DB 조회·서비스 변경·`current` 교체를 수행하지 않습니다. `dataContract`는 `unknown`이고 복귀를 허용하지 않습니다. 운영 대상 확인과 T2-15 단계2~6, 실제 배포·복귀 리허설, AC-M2-08·AC-M3-10 전체 인수는 후속입니다.

### 운영 대상 metadata 사전 확인 (T2-15 B2b3b)

`bash tools/deploy.sh --target-preflight /absolute/target.json`은 Linux의 로컬 Docker에서 이미지·volume·Compose 메타데이터만 읽습니다. 입력에는 버전1과 `artifact`, `target`, `receiptDirectory`를 명시합니다. `artifact`에는 기존 네 입력 중 산출물 경로·해시·revision과 이전 `preflightReceiptPath`·`preflightReceiptSha256`을 넣습니다. 이전 receipt의 해시를 대조한 뒤 같은 산출물을 새 `artifact-recheck` receipt로 다시 확인합니다. 과거 receipt만으로 현재 파일을 채택하지 않습니다.

`target`에는 root 소유·다른 사용자가 쓸 수 없는 Docker 실행 파일, `dockerHost: unix:///var/run/docker.sock`, 자기 소유0700의 빈 `dockerConfigDirectory`, 소유자가 따로 기록한 `expectedDaemonId`, `ownerId`, `targetId`, `projectName`을 넣습니다. Docker context나 환경의 원격 daemon을 탐색하지 않습니다. `composeFile`·`composeSha256`은 해당 산출물 context의 이번 검토된 `deploy/compose.yml` 바이트와 같아야 합니다. `environmentFile`·`environmentSha256`은 별도 일반 파일이며 기존 예제의16개 비밀 아닌 키만 받습니다. 원문 비밀·알 수 없는 키·중복·환경 확장은 거부합니다.

`volumes`의 `appSecrets`, `pgSecrets`, `pgData`, `caddyData`에는 미리 만든 서로 다른 정확한 이름을 넣습니다. driver와 scope는 모두 `local`이어야 합니다. 네 volume은 `org.opensamguk.owner=<ownerId>`, `org.opensamguk.target=<targetId>`, `org.opensamguk.purpose=<용도>` 세 label이 필요하며 용도는 각각 `app-secrets`, `pg-secrets`, `pg-data`, `caddy-data`입니다. 이름만 일치하거나 표지가 없으면 거부하고 기존 volume에 표지를 추가하지 않습니다. 생성 시각·표지·mountpoint 메타데이터를 검사 전후 대조하지만 volume 안의 파일은 열지 않습니다.

명령은 manifest의 세 이미지 ID·소스 표지·UID10001 설정과 고정한 공식 PG/Caddy 이미지의 로컬 metadata를 대조합니다. 이미지를 pull하거나 load하지 않습니다. 명시한16개 설정으로 렌더한 Compose의 이미지·사용자·읽기 전용 mount·권한·두 공개 포트·내부 network·수동 migrate 구성을 확인합니다. 각 native 명령은10초, 검사 전체는120초이며 취소 뒤 native 종료·양쪽 출력 종료를 최대60초 기다립니다. 원문 Docker 출력과 환경 설정을 로그로 내보내지 않습니다.

새 출력은 `target-metadata-preflight-passed`를 기록합니다. `operationalReady`, `secretUidModeVerified`, `dbQueried`, `secretsRead`, `deploymentStarted`, `currentChanged`, `rollbackAuthorized`는 모두 `false`입니다. 비밀 파일 내용·UID·권한, DB 대상·migration, 배포·복귀·서비스 기동은 후속입니다. 서버·도메인·메일·실제 owner inventory 값은 여전히 미정이며 `.invalid` 시험 값은 운영 확정값이 아닙니다. 새 전용 Linux CI는 자기 이미지·volume으로 이 metadata 경계만 검사하고 앱·DB를 기동하지 않습니다. 실제 CI·독립 리뷰·보호 병합과 전체 AC 인수는 아직 남아 있습니다.

### 공개 실행 이미지 (T2-15 B2a)

후보의 확장 설정·성별 자원 적재만 확인할 때는 기존 CI를 수동 실행합니다. `gh workflow run ci.yml --ref <후보 브랜치> -f runtime_resources_expected_sha=<같은 후보의 40자 SHA>`를 사용합니다. 선택한 ref·dispatch SHA·checkout HEAD가 모두 같아야 하며 formal load 입력과 함께 사용할 수 없습니다. 일반 PR·병합 대기열과 무입력 수동 CI의 검사는 그대로 실행됩니다.

이 경로는 Git blob과 알려진 내부 링크를 검증한 후보 스냅샷으로 `app-runtime`을 실제 빌드합니다. 같은 스냅샷의 실제 자원 loader를 읽기 전용·네트워크 없는 UID10001 컨테이너에서 실행해 확장 설정과 성별3파일의 원문·내용 해시를 대조합니다. 자기 owner 표지가 있는 종료된 컨테이너와 이미지 ID만 정리합니다. 불명확하거나 실행 중인 대상은 보존하고 실패합니다. CI artifact의 receipt는 `release:false`이며 소스 지문·이미지 ID·실제 관찰·정리 결과를 기록합니다. server·engine·migrate·web 최종 이미지, 운영 배포·복귀 또는 전체 AC 인수의 증거로 쓰지 않습니다.

`deploy/Dockerfile`은 Node24 공식 이미지의 digest와 pnpm10.33.0을 고정하고 lockfile 설치·Prisma 생성을 실행합니다. `server`·`engine`은 `.mjs` 번들과 필요한 운영 파일만 받습니다. `migrate`는 Prisma CLI와 migration 전용 의존성을 받습니다. `web` 대상은 `build:public`·자산 검사를 거친 정적 파일만 `/web`으로 내보냅니다. API와 엔진은 UID/GID10001로 실행하고 진입점이 실제 Node 프로세스를 `exec`합니다. API의 기존 loopback 바인딩을 유지합니다.

빌드 입력은 검토한 Git archive의 별도 디렉터리입니다. Dockerfile 옆의 `Dockerfile.dockerignore`가 package·lock·앱·패키지·도구·문서·필수 manifest·resources만 받고 `.git`·`.env*`·private·호스트 의존성·백업·로그·시험 산출물을 제외합니다. stdin tar는 이 필터의 검증으로 세지 않습니다. `SOURCE_REVISION`은 실제 기준 커밋40자이고 `SOURCE_TREE_SHA256`은 후보 소스 경로·파일 바이트의 SHA-256입니다. 두 값은 이미지 label에 남으며 후보 해시를 확정 릴리스로 선언하지 않습니다. 깨끗한 소스의 선택·해시 생성·manifest·배포 receipt·current 교체 명령은 B2 후속에 남아 있습니다.

실행 비밀 디렉터리 `/run/secrets`는 UID10001 소유·0700이어야 하고 `database_url`·`mail_api_key`·`audit_hash_config`는 같은 소유자·0600의 일반 파일이어야 합니다. 디렉터리를 read-only로 마운트하며 기본0444 Compose secret은 그대로 사용할 수 없습니다. 파일은1~4096바이트의 UTF-8로 줄바꿈·NUL 없이 저장하고 심볼릭 링크를 쓰지 않습니다. DB 파일에는 인증 정보와 DB 경로를 갖춘 PostgreSQL URL을 넣습니다. URL은 진입점의 exec 환경에만 전달하며 `DATABASE_URL`·`MAIL_API_KEY`·`RESEND_API_KEY`를 호스트 환경에서 전달하면 빈 값도 거부합니다. Git·명령 인자·build ARG·이미지 환경·로그·`VITE_*`에는 비밀값을 넣지 않습니다.

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

### Tunnel 선택 구성

T2-15·AC-M2-08의 선택 파일 `deploy/compose.tunnel.yml`은 기본 Compose에서 postgres·server·engine·migrate·Caddy 설정을 상속한다. server의 publish를 지우고 HTTP 전용 `Caddyfile.tunnel`을 쓴다. 기본 `deploy/compose.yml`과 기존 HTTPS Caddyfile의 바이트는 유지한다. Compose의 `!reset`·`!override`를 지원하는 Docker Compose 2.24.4 이상이 필요하다.

리허설에서 server만 `docker restart`한 뒤 Caddy가 이전 network namespace에 남는 것을 확인했다. server를 직접 재시작했다면 Caddy와 cloudflared도 재시작하고 healthz·SSE를 다시 확인한다. Compose로 server를 재생성할 때도 namespace를 공유하는 서비스가 함께 재생성되는지 확인한다.

```sh
docker compose --env-file /secure/production.env -f deploy/compose.tunnel.yml config --quiet
docker compose --env-file /secure/production.env -f deploy/compose.tunnel.yml up -d --wait postgres
docker compose --env-file /secure/production.env -f deploy/compose.tunnel.yml run --rm migrate
docker compose --env-file /secure/production.env -f deploy/compose.tunnel.yml up -d server engine caddy cloudflared
```

기존 이미지·자료·메일·비밀 볼륨 설정에 `TUNNEL_SECRETS_VOLUME`을 더한다. 해당 external volume의 `/run/secrets`를 UID/GID10001 소유·0700으로, `tunnel_token`을 0600으로 준비하고 읽기 전용으로 연결한다. token 값은 환경·명령 인자·Git·로그에 두지 않는다. 고정 cloudflared 2026.10.7은 `--token-file`을 지원한다. Cloudflare의 공개 hostname 서비스는 `http://127.0.0.1:8080`을 가리켜야 하며 API3001로 직접 연결하지 않는다. 공인 포트는 열지 않는다.

Caddy는 loopback 프록시에서 온 `CF-Connecting-IP`만 client IP로 해석하고 XFF를 그 IP 하나로 덮어쓴다. 따라서 로그인·가입 제한은 API의 `TRUST_PROXY=1` 계약을 유지한다. Tunnel·Caddy·server namespace에 임의 프로세스를 추가하면 이 신뢰 경계가 넓어진다. 기존 target 사전 확인 도구는 기본 Compose만 심사하므로 Tunnel 구성을 그 receipt로 승인하지 않는다. 실제 정식 Tunnel의 SSE·화면 새로고침과 두 공인 IP 검증을 별도로 남긴다. 도메인·token·두 접속 경로가 없는 이번 환경에서는 이 종단 인수는 미완료다. Quick Tunnel은 SSE를 지원하지 않는다.

server 이미지는 `AUDIT_HASH_CONFIG_FILE=/run/secrets/audit_hash_config`를 기본으로 둔다. 이 파일에 UTF-8 한 줄 JSON의 `key`와 `version`을 함께 저장한다. 키는 UTF-8 32바이트 이상, 버전은 1~2147483647의 정수다. BOM·NUL·줄바꿈·추가 필드는 거부하며 디렉터리0700·파일0600·같은 UID·일반 파일·심볼릭 링크 금지 계약을 확인한다. 실제 키는 Git·명령 인자·로그에 쓰지 않는다. 기존 `AUDIT_HASH_KEY` 또는 `AUDIT_HASH_KEY_VERSION`이 정의돼 있으면 파일을 열지 않고 기존 환경 검증을 먼저 하므로 운영에서는 두 설정 방식을 섞지 않는다. 개발 미설정은 기존처럼 비수집이며 engine·migrate에는 이 파일이 필요 없다. 기본 Compose와 `entrypoint.sh`의 바이트는 바꾸지 않았다.

키를 교체할 때 같은 디렉터리의 임시 파일을10001 소유·0600으로 준비하고 키와 버전을 함께 원자적으로 rename한다. server는 재시작 때 파일을 읽는다. namespace를 공유하는 Caddy·cloudflared도 함께 재시작하고 healthz·SSE와 새 로그인 기록의 버전을 확인한다. 준비와 실제 검증은 [조사 키 파일 설정](./plans/T2-15-audit-secret-file.md)에 기록한다.

### 운영 번들과 이미지

`pnpm build:runtime`은 esbuild 0.28.2로 server·engine `.mjs`와 검토용 metafile을 만든다. 앱 이미지는 Node slim·실행 번들·필수 resources·LICENSE/NOTICE만 담고 server에만 argon2 실행 파일과 해당 플랫폼의 native prebuild를 더한다. TypeScript 소스·tsx·빌드 도구·pnpm 다운로드 캐시는 없다. migrate는 lockfile의 별도 `@opensamguk/migrate-runtime` 설치본에서 Prisma CLI·schema·migrations·config만 가져온다. Prisma CLI의 전이 실행 의존성은 보존한다.

네 Docker target 이름과 SOURCE_REVISION·SOURCE_TREE_SHA256 검사·label, UID/GID10001, 읽기 전용·cap_drop 설정은 유지한다. web target은 실제 공개 빌드·검사를 거친 정적 파일만 내보낸다. D-060으로 이미지 바이트는 web에 넣지 않고 shared의 고정 커밋 URL·승인 해시 목록으로 읽는다. `pnpm assets:verify-remote`는 이미지 저장소의 실제 바이트·MIME·CORS를 검사한다. 배포 전에 이미지 저장소 PR과 게임 PR을 함께 검토해야 한다.

`deploy/compose.yml`은 검증한 release 이미지와 external volume을 연결하는 T2-15 B2b2 구성입니다. PostgreSQL은 내부 network에만 두며 server의 loopback3001은 Caddy와 같은 namespace에서만 접근합니다. server의8080/8443을 명시한 호스트 주소와 HTTP/HTTPS 포트로 연결합니다. Caddy는 공개 web을 읽기 전용으로 제공합니다. `/trpc`·`/trpc/*`·`/sse`·`/healthz`·`/healthz/engine`만 API로 넘깁니다. 그 밖의 화면 주소는 SPA의 index로 돌아오며 없는 `/assets/*`와 확장자 파일은404로 남습니다.

`PUBLIC_HOST`는 인증서 hostname이고 `PUBLIC_ORIGIN`은 실제 외부 HTTPS 주소입니다. 운영 ACME에는 외부80/443에서 내부8080/8443으로의 전달이 필요합니다. HTTP 리디렉션은 내부8443을 주소에 넣지 않고 `PUBLIC_ORIGIN`과 요청 URI를 잇습니다. 로컬 고포트 리허설은 별도의 internal issuer 설정과 요청에만 전달하는 private CA를 사용합니다. 호스트 truststore나 운영 TLS 검증을 끄지 않습니다.

기동 전에 manifest 이미지 ID·web 해시·migration과 external volume의 정확한 이름·용도·owner label·UID·권한을 확인해야 합니다. app secret 디렉터리는10001 소유0700이며 `database_url`·`mail_api_key`·`audit_hash_config` 파일은0600입니다. PG 비밀 디렉터리/`pg_password`와 자료 volume은70 소유, Caddy 자료는10001 소유로 준비합니다. 기존 volume을 이름만 보고 채택하지 않습니다. 실제 비밀은 보안 입력으로 미리 준비하며 `deploy/.env.production.example`에는 비밀이 아닌 입력 이름만 있습니다. 비밀 입력·소유 대조·배포 receipt/current를 수행하는 운영 명령은 후속입니다.

Compose 대상은 항상 절대 경로의 `--env-file`, `-f`와 `--project-name`을 명시합니다. 예를 들어 `docker compose --project-name <확인한 대상> --env-file <실제 설정 절대 경로> -f <checkout 절대 경로>/deploy/compose.yml config --quiet`로 필수 설정을 먼저 검사합니다. 이 검사는 secret 파일이나 DB의 migration 상태를 인수하지 않습니다. migration은 수동 tools profile이며 일반 기동에 숨기지 않습니다. 운영 실행은 T2-15의 writer 정지·백업·migration·확인·receipt 계약을 구현한 뒤 수행합니다.

`deploy/Caddyfile`은 `deploy/security.caddy`의 `game_security` snippet을 import합니다. CSP는 `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' https://raw.githubusercontent.com https://rawcdn.githack.com; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`입니다. D-060에 따라 승인한 고정 이미지 주소만 빌드 검사로 허용하며 원작 초상과 data 이미지는 거부합니다. 국가 색 등 동적 style 속성만 `style-src-attr`로 허용하며 인라인 script와 style 요소는 허용하지 않습니다. HSTS는 `max-age=31536000`이며 `includeSubDomains`와 preload는 넣지 않습니다. access log와 debug는 켜지 않고 upstream 장애는 고정 오류 응답으로 처리해 query·쿠키가 기본 오류 로그에 남는 경로를 막습니다. [Caddy 프록시](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [포트 설정](https://caddyserver.com/docs/caddyfile/options), [Compose 서비스](https://docs.docker.com/reference/compose-file/services/)

운영 API는 `NODE_ENV=production`, 정확한 HTTPS `PUBLIC_ORIGIN`, `TRUST_PROXY=1`로 Caddy 바로 뒤의 loopback에 둡니다. 직접 외부 API 포트를 열지 않습니다. Secure를 끄거나 잘못된 공개 출처를 지정하면 시작하지 않습니다. CORS를 열어 화면·API 출처를 분리하지 않습니다. 요청 제한은 단일 서버 메모리 계수이며 재시작 시 초기화됩니다. 서버를 늘리거나 재시작을 반복하는 운영 방식은 현재 계수기 보장을 벗어납니다.

공식 Caddy binary의 file capability 때문에 Caddy에만 `NET_BIND_SERVICE`를 허용합니다. UID10001·다른 권한 제거·읽기 전용 root·`no-new-privileges`는 유지합니다. API·엔진은 추가 권한이 없고 PostgreSQL은 UID70입니다. 이미지는 manifest의 config ID와 고정한 공식 digest를 사용하며 Compose는 자동으로 pull하지 않습니다.

2026-10-29 별도 Linux Compose의 실제 PostgreSQL·정식 두 월드와 production API로 위 경계를 검증했습니다. 공개106파일은 manifest와 HTTPS 바이트가 같았고 없는 자산404·정확한 외부 주소 리디렉션·보안 헤더·Secure 로그인·CSRF·정책 미승인503·닫힌 upstream의502와 query/쿠키 로그 비노출을 확인했습니다. TLS 요청에만 private CA를 전달했으며 호스트 truststore와 인증서 검증은 바꾸지 않았습니다. 별도 생성자 시험 정책의 인증/동의와 사람 장수 생성·SSE 종료도 통과했고 실제 정책 승인이나 외부 메일 수신으로 세지 않았습니다. 세 서비스 종료0·DB 연결0·정리 오류0이며 사용자 점검 환경은 보존했습니다. 운영 공개 도메인·ACME 인증서·배포/복귀 자동화·전체 AC 인수는 남아 있습니다.

## 6. 장애 대응

<!-- TODO(M2): 엔진이 멈췄을 때 (알림 → 로그 확인 → 리스 상태 → 재시작). 월드 일시정지 기준. -->

## 7. 모니터링 (M3)

`Public uptime` 워크플로는 main에서 UTC 매시7·17·27·37·47·57분에 기존 `tools/monitor/uptime.ts`를 실행합니다. 수동 실행도 main만 허용합니다. PUBLIC_URL 저장소 변수가 비면 확인 요청과 원격 상태 입출력 없이 꺼짐 성공이며 변수·secret 등록은 이 변경에 포함하지 않습니다. 의존성 설치와 실제 사이트 확인은 구분합니다.

활성화 전에 운영자가 공개 HTTPS 주소, 기존 `ops/uptime-state` ref의 내용·legacy 상태 의미와 보호 규칙, 외부 알림 대상을 확인합니다. CLI는 `refs/heads/ops/uptime-state`만 쓰며 prod 키의 fast-forward 상태 저장을 사용합니다. 워크플로를 우회해 다른 ref를 허용하거나 강제 push하지 않습니다. OPS_DISCORD_WEBHOOK secret이 없으면 기존 계약대로 판정만 저장하며 외부 수신 완료로 세지 않습니다. 토큰·웹훅 원문을 명령 인자·로그·요약·산출물에 넣지 않습니다.

예약과 입력 없는 수동 실행은 같은 prod concurrency로 진행 취소 없이 직렬화합니다. 기본 대기 실행은 한 개이므로 오래 걸리면 뒤 예약이 교체될 수 있습니다. 각 job은10분으로 제한합니다. GitHub 예약은 혼잡 때문에 늦어질 수 있고 공개 저장소 활동이60일 없으면 자동 중지됩니다. 중지되면 Actions의 해당 워크플로에서 다시 활성화하고 실제 다음 실행을 확인합니다. 예약은 기본 브랜치에 병합된 뒤에만 동작합니다. [예약 실행](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [직렬화](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

로컬 후보는 실제 CLI/Git/HTTP142건·별도 Linux 권한7건과 전체5385건·공개 자산110개·실제 공개 Chromium4건을 통과했습니다. 코드·집중·Linux 근거 리뷰는 승인됐으며 전체 근거·문서의 최종 리뷰와 새 필수CI·정상 보호 병합은 남아 있습니다. 보호 병합 뒤의 미설정 URL 수동 실행,500·500·500·200 장애·회복 drill, 실제 공개 주소와 외부 수신, 디스크·DB 용량 감시와 전체 AC-M3-09 인수도 아직 남아 있습니다. 사용자 점검용5200의 계정·월드는 유지합니다.

### 서버 디스크·DB 용량 감시

용량 감시는 기본으로 꺼집니다. `CAPACITY_MONITOR_ENABLED`를 비우거나 `0`으로 두면 용량 조회·타이머·알림 전송을 추가하지 않습니다. 켜려면 서버 프로세스에 아래 값을 모두 지정합니다. 운영 경로와 DB 임계값, 수신자는 운영자가 정해야 합니다.

| 설정 | 값 |
| ---- | ---- |
| `CAPACITY_MONITOR_ENABLED` | `1` |
| `MONITOR_DISK_PATHS` | 서버에서 직접 읽을 수 있는 서로 다른 절대 경로의 JSON 배열. 최대16개이며 입력한 경로 그대로 `statfs`로 읽습니다 |
| `DB_SIZE_WARN_BYTES` | 양의 정수 바이트. 기본 임계값은 없습니다 |
| `OPS_DISCORD_WEBHOOK_URL` | 서버용 Discord 웹훅 비밀값. GitHub의 `OPS_DISCORD_WEBHOOK`과 별도로 지정합니다 |

Fastify가 준비되면 첫 조회를 시작하고 이후5분마다 확인합니다. 디스크는 전체 블록 중 실행 계정이 쓸 수 없는 블록의 비율을 읽어80% 이상이면 경고,90% 이상이면 위험을 알립니다. 예약 공간도 사용 불가 용량에 포함합니다. DB는 읽기 전용 트랜잭션에서 `pg_database_size(current_database())`만 읽어 지정한 바이트 이상일 때 경고합니다. 두 감시는 월드·게임 상태나 RNG를 바꾸지 않습니다. 한 경로를 읽지 못해도 다른 경로와 DB는 각각 판정합니다.

알림의 디스크 번호는 배열 순서의 `disk-1`부터이며 DB는 `database`입니다. 경로 원문·월드 ID·DB 주소·이메일·웹훅 원문과 원본 오류는 본문과 진단 로그에 넣지 않습니다. 경로는 서버 계정에서 읽을 수 있어야 하며 PostgreSQL이 다른 호스트나 컨테이너에 있으면 그 호스트의 디스크 사용량으로 대신 표시하지 않습니다. 실제 자료·백업 파일시스템을 서버의 읽기 경로에 연결하는 운영 구성은 별도로 확인합니다.

같은 상태의 전송 시도는30분마다 한 번입니다. 경고가 위험으로 바뀌면 바로 알리고 정상으로 돌아오면 회복을 알립니다. 발송이 실패한 회복도30분 뒤 재시도하며 성공한 회복은 반복하지 않습니다. 상태는 서버 메모리에 두므로 서버를 재시작하면 이어지는 장애를 한 번 더 알릴 수 있습니다. 알림의2xx 판정은 실제 수신자의 확인을 대신하지 않습니다.

조회 제한은10초입니다. 제한을 넘긴 파일시스템 조회는 취소됐다고 기록하지 않고 실제 Promise가 끝날 때까지 보유하며 다음 주기를 시작하지 않습니다. 서버 종료 때 새 조회를 막고 알림을 중단한 뒤 진행 중 작업의 정착을 기다립니다.10초 안에 확인하지 못하면 고정 오류로 종료 실패를 알립니다. 이 경우 서버가 정상 종료했다고 기록하거나 감시 작업을 정착한 것으로 간주하지 않습니다.

이 연결은 AC-M3-09의 구현 준비 범위입니다. 전용 PostgreSQL·실제 파일시스템·로컬 수신 경로의 결합 검사, 디스크 경계 환경과 실제 운영 수신 검증은 아직 남아 있습니다. 사용자 드라이브를 채워 경고를 시험하지 않습니다.

### 운영 경로와 분리한 드릴

보호 main에 드릴 구현이 병합된 뒤 `Public uptime`의 수동 실행에서 `drill_key`와 `drill_status`를 함께 입력합니다. 키는 ASCII 영숫자·밑줄·하이픈 1~64자이고 상태는200 또는500입니다. 두 입력을 비우면 기존 운영 경로입니다. 부분 입력은 실패하며 운영 URL·웹훅을 드릴에 전달하지 않습니다. 드릴은 자기 HTTP 서버를 열어 기존 확인 경로로 관찰하고 같은 ref의 `drill-<키>` 상태만 바꿉니다. 외부 수신을 성공으로 꾸미는 시험이 아닙니다.

먼저 상태 ref의 legacy 의미·보호 규칙과 기존 키를 확인하고 백업합니다. 같은 새 연습 키로500을 세 번,200을 한 번 순서대로 실행하고 각 workflow run의 정확 main SHA·시각·HTTP 판정·결정·저장 결과를 남깁니다. 첫 실패는 누적하고 두 번째 연속 실패에서 장애를 판정합니다. 장애 판정 뒤30분 미만의 세 번째 실패는 중복 알림을 억제하고 네 번째 성공은 회복을 판정해야 합니다. 세 번째 실행이30분 뒤라면 중복 억제 검증을 통과로 기록하지 않습니다. prod와 다른 키의 blob 바이트가 전후 같고 자기 키만 바뀌었는지 확인합니다. ref를 지우거나 강제 갱신하지 않습니다. 필요하면 자기 연습 키만 정상 CAS로 정리하고 그 변경도 기록합니다.

로컬의 실제 HTTP·bare Git147건과 격리 Linux12건은 통과했고 독립 근거 리뷰도 승인됐습니다. 초기 Linux hook 반례 실패는 시험 tmpfs의 기본 실행 금지를 재현해 바로잡았으며 원래 반례와 실패 증거를 보존했습니다. 결합 후보의 전체 검사·보호 병합과 실제 원격 드릴은 아직 실행 전입니다. 실제 공개 주소·외부 수신·용량 감시·전체 AC-M3-09를 통과로 바꾸지 않습니다.

### 격리 부하의 수동 실행 준비

`Formal isolated load`와 `Smoke isolated load`는 수동 실행만 받습니다. Actions에서 선택한 소스의40자리 SHA를 `expected_sha`에 입력합니다. 실행은 같은 저장소의 정확한 commit을 checkout하고 자격 정보를 남기지 않습니다. 두 워크플로의 권한은 `contents: read`이며 별도 secret이나 외부 서비스 계정은 필요하지 않습니다. 이 연결은 AC-M3-07의 구현 준비입니다. 실제 수동 실행·독립 근거 검토와 보호 병합은 남아 있습니다.

Node24.22.0·pnpm10.33.0을 준비한 뒤 의존성 없는 `bootstrap.mjs`가 실제 Ubuntu24.04, GitHub 실행기 환경과 `Runner.Worker` 조상을 확인합니다. 선택된 Docker context가 정확한 로컬 Unix 소켓인지 검사하고 이후 Docker 명령에 같은 endpoint를 명시합니다. 공용 풀 설정이 없는 환경과 Windows에서는 기존 종료75 거부를 유지합니다. 환경변수를 꾸민 로컬 Linux를 정식 실행 장소로 세지 않습니다.

설치 전에 호스트의 실제60초 CPU, 메모리·cgroup 조상과 Docker 자료/근거 파일시스템 두 곳의 여유를1 CPU·2GiB·4GiB 예산으로 심사합니다. 의존성 설치는 새 systemd scope에서 CPU100%·메모리2GiB·추가 swap0으로 제한합니다. scope 내부에서 비root UID, 실제 조상과 커널 제한을 다시 확인한 뒤 설치하고 종료·잔여 scope를 확인합니다. 설치 전 점검과 설치·정리는 합계5분 안에 마쳐야 합니다. scope가 조상 관계를 끊거나 실제 제한을 확인하지 못하면 실패합니다.

설치 뒤에는 기존 심사 코드로 다시 확인하고 전용 BuildKit builder를 만듭니다. 공식 `moby/buildkit:v0.34.1`의 고정 digest, 실제1 CPU·2GiB 제한과 로컬 커널의 parent를 확인한 뒤 기존 `deploy/Dockerfile`의 runtime을 빌드합니다. 이 builder는 공식 Docker container driver의 privileged 동작을 사용하므로 사용자 서버에서 실행하지 않습니다. 임시 GitHub VM 안에서만 쓰고 측정 전 정상 종료·삭제를 확인합니다. 공식 [driver 동작](https://docs.docker.com/build/builders/drivers/docker-container/)과 [고정 release](https://github.com/moby/buildkit/releases/tag/v0.34.1)를 참고합니다.

BuildKit와 PostgreSQL 고정 이미지의 pull·압축 해제는 Docker daemon이 수행하며 builder의 CPU·메모리 제한 밖입니다. 이를 제한된 작업으로 표시하지 않습니다. 두 고정 digest의 실제 image ID와 플랫폼을 검증하고 준비 뒤 호스트·cgroup·두 디스크를 재심사합니다. 이미지 준비·재심사·빌드의 합계 제한은15분, 자기 builder 정리는2분입니다. 실제 준비 IO나 자원 부족 때문에 이 한도를 넘기면 실패로 남깁니다.

정식 부하는 두 월드 각각491 NPC와 실제 API로 만든 사람 장수109명, 합계 시험 계정218개와 예턴6540칸을 준비합니다. 월드별 시계는1분·2분이고 동시 SSE100개, 준비 운동120초와 측정900초를 유지합니다. API p95는300ms 미만, 턴 저장 지연의 보수적 상계는10초 미만이어야 합니다. 시험 생성자의 명시 정책만 쓰며 운영 정책 승인이나 메일 수신을 대신하지 않습니다. smoke는 동시 SSE10개·준비 운동1초·측정60초의 연결 확인이며 정식 통과로 세지 않습니다.

`pnpm load:m3`와 `pnpm load:smoke`는 기존 실행기 `run.ts`의 직접 진입점입니다. 직접 실행하려면 검증한 이미지 ID와 `--source-head`, `--source-sha256`, 승인된 장소의 `--site github-hosted`가 필요합니다. 수동 워크플로의 `ci.ts`가 설치·빌드·입장 심사·직접 실행을 순서대로 연결합니다. 실행기의 준비180초·실행1200초·정리300초는 바꾸지 않습니다. 워크플로75분은 설치5분, 빌드 전 심사11분, 이미지 준비·빌드15분, builder 정리2분, 측정 심사와 실행·정리36분, 요약2분의71분 상계와 action 준비4분을 합한 값입니다.

원자료는 실행기의 `.load-reports/`에 보존하고 공개 Actions 산출물로 업로드하지 않습니다. 공개 저장소에서는 소유자만 내려받도록 보장할 수 없기 때문입니다. 공개 job summary에는 소스 SHA·판정·개수·지연 수치와 정리 확인만 씁니다. 계정·월드 UUID, 로그·쿠키·연결 문자열·volume 내용은 내보내지 않습니다. 임시 VM이 없어지면 상세 실패 근거도 소실되므로 재현 실행이나 별도 승인한 비공개 보관 경로가 필요합니다. 정상 종료·같은 DB OID·연결0·소유 자원 정리·원자료 재집계 중 하나라도 확인하지 못하면 공개 성공으로 표시하지 않습니다. 기존 사용자 점검용5200과 기존 DB는 이 경로에서 사용하지 않습니다.
