# 릴리스 운영

> 상태: 뼈대 · 필요 시점: M2 · 관련 AC: M2-08, M2-09, M2-10, M3-09, M3-10
> 참고: core2026 `release-operations.md`, `e2e-caddy-routing.md`, `developer/game-clock-recovery.md` (셋을 합침)
> 이 문서가 답할 질문: 서버 1대에 어떻게 배포하고 되돌리고 백업하고 장애에 대응하나?

## 1. 구성 (가정 A13)

서버 1대 + Docker Compose (PostgreSQL, server, engine, Caddy) + Cloudflare(DNS·CDN)

<!-- TODO(M2): compose 파일 위치와 서비스 목록. -->

## 2. 배포

<!-- TODO(M2): 명령 하나로 배포 (AC-M2-08). migration 적용 → server·engine 재시작 → 상태 확인. -->

## 3. 되돌리기

<!-- TODO(M2): 이전 이미지 태그로 되돌리는 절차. migration이 있으면 어떻게 하나. 리허설 기록 남기기. -->

## 4. 백업과 복구

T2-15 B1은 검토 중입니다. `tools/backup.sh`와 `tools/restore.sh`는 지정한 기존 컨테이너만 사용합니다. 컨테이너 ID 64자와 PostgreSQL `system_identifier`를 대조하며 compose를 탐색하거나 컨테이너를 기동하지 않습니다. `DOCKER_HOST`는 로컬 daemon으로 명시하고 `DOCKER_CONFIG`는 소유 빈 디렉터리로 지정합니다. 비밀번호나 연결 URL을 인자로 주지 않습니다. 컨테이너 안 local socket 인증이 맞지 않으면 멈춥니다.

```sh
bash tools/backup.sh --docker <docker 절대 경로> --container <64자 ID> --system-identifier <숫자> --db-user <role> --admin-db <카탈로그 DB> --source-db <원본 DB> --backup-dir <절대 경로> --reason rehearsal --release-sha <검토한 실제 소스 커밋 40자 SHA>
bash tools/restore.sh --docker <docker 절대 경로> --container <64자 ID> --system-identifier <숫자> --db-user <role> --admin-db <카탈로그 DB> --archive <dump 절대 경로> --manifest <manifest 절대 경로> --target-db <새 t215_dst_UUID32_test 이름>
```

Windows 시험은 PATH의 Bash 대신 `C:/Program Files/Git/bin/bash.exe`를 사용합니다. `rehearsal`·`pre-deploy` 백업은 다른 연결이 없고 유효한 엔진 리스가 없는 원본만 받습니다. 덤프 전후의 표·sequence 내용 해시도 같아야 합니다. `daily`는 덤프 snapshot을 기준으로 하며 내용 해시는 남기지 않습니다. 바이너리는 Bash 파일 redirection으로 전달합니다.

dump와 성공 manifest가 한 쌍이어야 백업 성공입니다. manifest에는 아카이브 SHA-256과 같은 snapshot의 적용 migration 목록을 남깁니다. 성공 실행 뒤에만 7일보다 오래된 성공 백업을 정리합니다. 외부 복사는 `not-configured`입니다. 매일 실행할 일정 설치와 외부 복사는 아직 하지 않았습니다.

복구는 새 리허설 대상만 받으며 기존 DB를 덮어쓰지 않습니다. 복원 실패 시 이번 실행이 만든 대상의 OID와 연결 0을 확인해야 삭제합니다. 운영 복구 대상의 비밀 파일·cutover 계약은 B2·B3 배정 전이므로 운영 복구는 거부합니다.

리허설의 준비와 각 진행 단계는 자체 20초 기한을 둡니다. 기한을 넘기면 다음 진행을 막고 남은 작업의 종료를 기다린 뒤 자기 DB만 정리합니다. 기존 시험의 30초 상한은 늘리지 않습니다. 실제 준비·정리 시간은 아직 확인하지 않았습니다.

실제 리허설은 아직 실행하지 않았습니다. 부모가 기존 전용 PG 슬롯과 `T215_*` 입력을 배정해야 합니다. local 인증, stdin 순차 `pg_restore`, archive 사본의 오프라인 설치·generate 30초 내 완료는 미검증입니다. backup의 필수 `--release-sha`는 40자리 16진 문자열을 그대로 manifest에 기록합니다. 누락·형식 오류는 Docker 호출과 파일 생성 전에 거부하며 Git fallback은 없습니다. B1은 검토한 실제 소스 HEAD를 전달해 manifest와 대조합니다. B2가 운영 current SHA를 얻어 전달할 방법을 정합니다. 추적 수정이 없는 시험 대상 커밋이 필요하며 현재 작업은 커밋하지 않았습니다. 단위·정적 검증만으로 AC-M2-09를 완료 처리하지 않습니다.

## 5. 프록시 경로

<!-- TODO(M2): Caddy 경로 계약. /api, /sse, 정적 화면, 직접 주소 접근과 새로고침. -->

T3-04의 검토용 헤더 소스는 `deploy/security.caddy`입니다. T2-15가 HTTPS site 블록에서 `game_security` snippet을 import합니다. 이 파일만으로 배포하거나 Caddy를 기동하지 않습니다. 라우팅·인증서·배포 자동화는 T2-15 범위이며 여기서는 실제 운영을 바꾸지 않았습니다.

CSP는 `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' https://cdn.jsdelivr.net data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`입니다. 기존 화면의 국가 색 등 동적 style 속성만 `style-src-attr`로 허용하며 인라인 script와 style 요소는 허용하지 않습니다. 기존 개발 초상 출처 jsDelivr만 명시했으며 이미지 공개 권리 승인과는 별개입니다. 공개 이미지 출처가 확정되면 그 출처만 바꾸고 실제 빌드·브라우저 CSP 위반을 다시 확인합니다. HSTS는 `max-age=31536000`이며 다른 서브도메인까지 강제하는 `includeSubDomains`와 preload는 넣지 않습니다.

운영 API는 `NODE_ENV=production`, 정확한 HTTPS `PUBLIC_ORIGIN`, `TRUST_PROXY=1`로 Caddy 바로 뒤의 loopback에 둡니다. 직접 외부 API 포트를 열지 않습니다. Secure를 끄거나 잘못된 공개 출처를 지정하면 시작하지 않습니다. CORS를 열어 화면·API 출처를 분리하지 않습니다. 요청 제한은 단일 서버 메모리 계수이며 재시작 시 초기화됩니다. 서버를 늘리거나 재시작을 반복하는 운영 방식은 현재 계수기 보장을 벗어납니다.

## 6. 장애 대응

<!-- TODO(M2): 엔진이 멈췄을 때 (알림 → 로그 확인 → 리스 상태 → 재시작). 월드 일시정지 기준. -->

## 7. 모니터링 (M3)

<!-- TODO(M3): 가동 확인, 엔진 하트비트, 디스크·DB 용량 알림 (AC-M3-09). -->
