# 릴리스 운영

> 상태: 뼈대 · 필요 시점: M2 · 관련 AC: M2-08, M2-09, M2-10, M3-09, M3-10
> 참고: core2026 `release-operations.md`, `e2e-caddy-routing.md`, `developer/game-clock-recovery.md` (셋을 합침)
> 이 문서가 답할 질문: 서버 1대에 어떻게 배포하고, 되돌리고, 백업하고, 장애에 대응하나?

## 1. 구성 ⚠️ A13

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

## 6. 장애 대응

<!-- TODO(M2): 엔진이 멈췄을 때 (알림 → 로그 확인 → 리스 상태 → 재시작). 월드 일시정지 기준. -->

## 7. 모니터링 (M3)

<!-- TODO(M3): 가동 확인, 엔진 하트비트, 디스크·DB 용량 알림 (AC-M3-09). -->
