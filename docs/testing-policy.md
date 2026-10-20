# 테스트 정책

> 상태: 뼈대 · 필요 시점: M1 · 참고: core2026 `docs/testing-policy.md`, `integration-tests.md`, `architecture/npc-unification-timing-benchmark.md`

## 1. 원칙

- 테스트는 AC의 증거입니다. AC마다 어떤 테스트가 증거인지 [인수조건](./product/acceptance-criteria.md)에 적습니다.
- 시계, 시드, fixture를 고정합니다. 테스트에서 현재 시각과 `Math.random()`을 쓰지 않습니다.
- skip된 테스트, 환경이 없어 건너뛴 통합 테스트, mock만으로 한 검증은 통과로 세지 않습니다.
- 원작과 1:1 비교는 하지 않습니다 (D-001). 대신 **우리 자신과의** 재생 일치를 검사합니다.

## 2. 테스트 종류

| 종류         | 대상                              | 도구        | 실행 |
| ------------ | --------------------------------- | ----------- | ---- |
| 단위         | `packages/rules`, `packages/shared` | Vitest    | `pnpm check` |
| 골든         | 월간 정산 등 순서가 중요한 계산   | Vitest + 스냅샷 | `pnpm check` |
| 재생         | 시드 + 입력 기록 → 같은 상태 해시 | Vitest      | `pnpm check` |
| 통합         | 실제 PostgreSQL 트랜잭션, 리스, 재적재, 권한 | Vitest + Docker DB | `pnpm test:int` |
| 시뮬레이션   | NPC만으로 한 판                   | 헤드리스 시뮬레이터 | `pnpm sim` |
| E2E          | 화면 흐름                         | Playwright  | `pnpm e2e` |
| 부하         | 서비스 성능 (M3)                  | 미정        | 별도 |

## 3. 권한 테스트

API마다 다섯 가지를 확인합니다 (NFR-05).

- [ ] 성공
- [ ] 로그인 안 함
- [ ] 다른 사용자의 장수·국가
- [ ] 제재된 계정
- [ ] 잘못된 입력과 경계값

M3 전에 API 목록과 권한 테스트 목록을 자동으로 대조합니다 (AC-M3-03).

## 4. 시뮬레이션 기준

core2026 측정값을 참고합니다. 장수 880명·도시 94개를 NPC만으로 무보정 진행하면 747개월(약 62년)에
통일했고, 메모리 안 계산으로 약 470초가 걸렸습니다 (2026-08-15, Ryzen 7 9800X3D).

우리 기준(AC-M1-17·18): 10개 시드 전부 오류 없이 완주, 1판 15분 이내 ⚠️ A18

<!-- TODO(M1): 시뮬레이터 명령, 출력 형식 (종료 연월, 통일 국가, 상태 해시, 소요 시간). -->

## 5. 통합 테스트 준비

```sh
pnpm db:up
pnpm test:int
```

`tools/run-integration.ts`가 전용 DB를 만들고 migration을 적용한 뒤 테스트를 실행합니다.
기본 대상은 같은 PostgreSQL의 `opensamguk_test`입니다. 다른 대상은 `.env`의 `TEST_DATABASE_URL`로 지정합니다.
DB 생성 권한이 없으면 해당 계정의 전용 테스트 DB를 먼저 준비해야 합니다.

테스트 DB 이름은 소문자·숫자·밑줄로 구성하고 `_test`로 끝나야 합니다.
개발 `DATABASE_URL`과 호스트·포트·DB 이름이 같으면 시작 전에 거부합니다.
테스트는 이 전용 DB의 월드 데이터를 시작·종료 시 지웁니다. 개발 DB는 비우지 않습니다.

통합 파일은 `*.integration.test.ts`이며 `pnpm check`의 단위 테스트에서 제외합니다.
DB가 없거나 migration·테스트가 실패하면 명령이 실패하고, skip으로 통과시키지 않습니다.
