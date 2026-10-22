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

<!-- TODO(M2): 매일 pg_dump, 7일 보관 (NFR-14). 복구 리허설 절차 (AC-M2-09). -->

## 5. 프록시 경로

<!-- TODO(M2): Caddy 경로 계약. /api, /sse, 정적 화면, 직접 주소 접근과 새로고침. -->

T3-04의 검토용 헤더 소스는 `deploy/security.caddy`입니다. T2-15가 HTTPS site 블록에서 `game_security` snippet을 import합니다. 이 파일만으로 배포하거나 Caddy를 기동하지 않습니다. 라우팅·인증서·배포 자동화는 T2-15 범위이며 여기서는 실제 운영을 바꾸지 않았습니다.

CSP는 `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' https://cdn.jsdelivr.net data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`입니다. 기존 화면의 국가 색 등 동적 style 속성만 `style-src-attr`로 허용하며 인라인 script와 style 요소는 허용하지 않습니다. 기존 개발 초상 출처 jsDelivr만 명시했으며 이미지 공개 권리 승인과는 별개입니다. 공개 이미지 출처가 확정되면 그 출처만 바꾸고 실제 빌드·브라우저 CSP 위반을 다시 확인합니다. HSTS는 `max-age=31536000`이며 다른 서브도메인까지 강제하는 `includeSubDomains`와 preload는 넣지 않습니다.

운영 API는 `NODE_ENV=production`, 정확한 HTTPS `PUBLIC_ORIGIN`, `TRUST_PROXY=1`로 Caddy 바로 뒤의 loopback에 둡니다. 직접 외부 API 포트를 열지 않습니다. Secure를 끄거나 잘못된 공개 출처를 지정하면 시작하지 않습니다. CORS를 열어 화면·API 출처를 분리하지 않습니다. 요청 제한은 단일 서버 메모리 계수이며 재시작 시 초기화됩니다. 서버를 늘리거나 재시작을 반복하는 운영 방식은 현재 계수기 보장을 벗어납니다.

## 6. 장애 대응

<!-- TODO(M2): 엔진이 멈췄을 때 (알림 → 로그 확인 → 리스 상태 → 재시작). 월드 일시정지 기준. -->

## 7. 모니터링 (M3)

<!-- TODO(M3): 가동 확인, 엔진 하트비트, 디스크·DB 용량 알림 (AC-M3-09). -->
