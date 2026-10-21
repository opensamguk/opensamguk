# 런타임

> 상태: 로컬 실행 초안 (T1-02) · 서버 배포는 M2 · 참고: core2026 `docs/architecture/runtime.md`
> 이 문서가 답할 질문: 어떤 프로세스가 몇 개 뜨고 무엇을 설정하고 어떻게 켜고 끄나?

## 1. 프로세스

| 프로세스      | 개수                         | 역할 |
| ------------- | ---------------------------- | ---- |
| `server`      | 1                            | API, SSE, 정적 화면 제공 |
| `engine`      | 프로세스 하나가 월드 하나 담당 | 리스가 있는 프로세스만 턴 실행 |
| PostgreSQL    | 1                            | 저장 |
| Caddy         | 1                            | HTTPS, 프록시 |

`pnpm engine:run --world <ID>`로 월드를 지정합니다. `pnpm dev`의 엔진은 생성 시각·ID 순으로 첫 RUNNING 월드를 고르고 계속 맡습니다. 대상이 없으면 1초마다 다시 찾습니다. 여러 월드의 프로세스 감독은 M2(T2-01)에서 연결합니다.

## 2. 환경변수

루트 `.env`에 둡니다 (`.env.example`을 복사). 비밀값은 운영에서 파일(`/run/secrets`)로만 넣습니다.

| 이름                  | 의미                     | 기본값 (로컬)                                                  | 비밀 | 상태 |
| --------------------- | ------------------------ | -------------------------------------------------------------- | ---- | ---- |
| `DATABASE_URL`        | PostgreSQL 연결          | `postgresql://opensamguk:opensamguk@127.0.0.1:5433/opensamguk` | 예   | 사용 중 |
| `SERVER_PORT`         | API 서버 포트            | `3001`                                                         | 아니오 | 사용 중 |
| `PUBLIC_ORIGIN` | 화면·API의 단일 출처. 경로·끝 슬래시 없이 지정 | `http://127.0.0.1:5173` | 아니오 | 운영 필수, HTTPS만 허용 |
| `TRUST_PROXY` | 운영 Caddy 한 단계만 신뢰 (`1`), 소켓 IP만 사용 (`0`) | `0` | 아니오 | 사용 중 |
| `SESSION_SECRET`      | 사용하지 않음. 무작위 토큰의 SHA-256을 DB에서 조회 | — | — | 불필요 (T1-10) |
| `VITE_IMAGE_BASE_URL` | 초상 이미지 base URL     | 비우면 jsDelivr 고정 커밋 주소 ([이미지 자산 §2](../image-assets.md#2-초상-id와-경로)) | 아니오 (공개값) | 사용 중 |

세션 쿠키 `sid`는 HttpOnly·SameSite=Lax·Path=/이며 `NODE_ENV=production`에서 Secure를 붙입니다.
DB에는 토큰 원문 대신 SHA-256만 저장하고 성공한 활동의 응답에서 DB와 쿠키 모두 30일로 연장합니다. 거부한 요청은 갱신 대상 시점이어도 세션 만료를 바꾸지 않습니다.
계정 상태가 ACTIVE가 아니거나 세션이 만료되면 인증하지 않습니다. 요청 로그에는 URL·본문·쿠키·원본 오류를 기록하지 않습니다.

운영 설정에서 Secure를 끄면 서버가 시작하지 않습니다. `/trpc` POST와 SSE 요청은 `Origin`이 `PUBLIC_ORIGIN`과 같아야 합니다. Origin이 없을 때만 `Sec-Fetch-Site: same-origin`을 받습니다. 잘못된 Origin을 다른 헤더로 덮어 허용하지 않습니다. 변경 요청은 `application/json`(선택적 charset 허용)만 받고 다른 형식은 415입니다. Origin 거부는 403이며 인증·본문 처리보다 먼저 실행합니다. CORS를 열지 않습니다.

개발 화면도 Vite의 같은 출처 `/trpc` 프록시를 씁니다. `localhost`로 접속하려면 `PUBLIC_ORIGIN=http://localhost:5173`을 정확히 맞춥니다. HTTP 시험 클라이언트는 같은 화면 출처의 Origin과 JSON을 명시하며 시험용 예외 목록은 두지 않습니다.

`TRUST_PROXY=1`은 Caddy 바로 뒤의 한 단계만 믿는 설정입니다. API는 loopback에 바인딩하며 외부에서 직접 접속할 수 없게 유지합니다. 개발에서는 기본값 `0`으로 두므로 `X-Forwarded-For`로 한도를 바꿀 수 없습니다. 앞단 프록시가 늘면 이 값을 무작정 늘리지 말고 연결 경계를 다시 검토합니다.

프로세스마다 메모리 계수기가 하나입니다. 로그인 IP 30회/15분, 실패한 이메일·IP 조합 5회/15분, 가입 IP 10회/시간, 인증 변경 사용자 120회/분입니다. 창은 epoch 기준이고 재시작하면 계수가 비며 여러 서버 사이에는 공유하지 않습니다. 차단 응답은 429와 정수 초 `Retry-After`, tRPC `TOO_MANY_REQUESTS`, `data.reason=null`입니다. 키·IP·이메일·토큰은 로그·파일·DB에 저장하지 않습니다. 계수기는 T3-04 단독 소유이고 T3-02는 같은 공개형을 import만 합니다.

서버 응답에는 `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`를 붙입니다. CSP·HSTS의 검토용 Caddy 소스와 적용 경계는 [릴리스 운영](../release-operations.md#5-프록시-경로)에 있습니다.

## 3. 로컬 실행

```sh
cp .env.example .env   # 처음 한 번
pnpm install
pnpm generate          # Prisma client 생성
pnpm db:up             # PostgreSQL 18, 127.0.0.1:5433
pnpm db:migrate        # 저장소의 migration 적용
pnpm dev               # web 127.0.0.1:5173 · server 127.0.0.1:3001 · engine
pnpm e2e               # 스모크 테스트 (dev 서버가 없으면 자동으로 켬)
pnpm db:down           # DB 끄기 (데이터는 볼륨에 남음)
```

월드 생성 (T1-03):

```sh
pnpm world:create --scenario 1030 --map che --seed demo --turn-term 10 --name 군웅할거
```

생성된 월드 ID와 초기 상태 SHA-256을 출력합니다. 상태는 `PREOPEN`, 초기 tick은 0입니다.
이름과 턴 간격(1~2147483647분)을 검사하고 리소스 검사나 DB 저장 실패 시 부분 월드를 남기지 않습니다.
월드 시작·일시정지·재개는 아래 월드 상태 전환 명령을 사용합니다.

- web은 `/trpc` 요청을 server로 프록시합니다. 프록시 대상 포트는 server와 같은 `SERVER_PORT`를 따릅니다
  (프로세스 환경변수 → 루트 `.env` → 3001, `apps/web/apiTarget.ts`).
- server·engine은 `tsx watch`로 실행합니다. Node `--watch`는 macOS에서 파일 감시 한도를 넘어 실패했습니다.
- Claude 실행 환경의 sandbox는 Docker 소켓과 로컬 포트를 막습니다. 그 환경에서는 sandbox 밖에서 실행하거나
  `sandbox.network.allowLocalBinding`을 켭니다.

## 4. 엔진 수명 주기

1. 월드별 `EngineLease`를 획득합니다. 없거나 DB 시각 기준으로 만료된 리스만 가져오며 fencingToken을 증가시킵니다. 획득하지 못하면 1초마다 재시도합니다.
2. 만료 시간은 15초, 갱신은 5초마다입니다. 게임 시계의 manual/realtime 여부와 관계없이 리스는 DB UTC 시각을 씁니다.
3. 리스 행과 월드 행을 잠그고 시계·실행할 장수를 확인합니다. 실행할 턴이 있을 때만 DB에서 전체 월드 상태·현재 예턴을 읽습니다. 장수는 `nextTurnTick`, ID 오름차순으로 실행합니다. 빈 예턴은 휴식입니다. 밀린 턴은 제한 없이 따라잡고 다음 조회까지 100ms 기다립니다. 턴이 없는 realtime 폴링은 전체 적재를 생략하고 시계만 5초마다 체크포인트합니다. 이 간격은 프로세스의 monotonic 시각으로 재며 PAUSED/PREOPEN/ENDED에서는 쓰지 않습니다.
4. 상태 변경·로그·예턴 당김·다음 턴·시계 체크포인트를 한 트랜잭션에 저장합니다. commit 직전에 소유자·토큰·만료를 다시 검사합니다. 리스 행 잠금은 commit/rollback까지 유지되어 실행권 이전과 낡은 쓰기가 겹치지 않습니다.
5. 갱신 실패·토큰 불일치·리스 만료는 프로세스 오류 종료입니다. 실행권 상실은 `LeaseLostError` 이름·이유를 출력하고 DB 오류 원문은 연결 정보 보호를 위해 출력하지 않습니다. SIGINT/SIGTERM은 처리 중 트랜잭션을 취소하고 리스를 해제한 뒤 DB 연결을 닫습니다. 리스 해제는 만료 시각만 바꾸고 토큰을 지우지 않습니다.

테스트·시뮬레이터는 `TurnLoop.advanceTo(tick)`으로 게임 시간을 직접 주입합니다. 운영은 `poll()`로 DB 시각과 월드 기준 시각에서 tick을 계산합니다. PAUSED/PREOPEN/ENDED에서는 턴을 처리하지 않습니다.

## 5. 월드 상태 전환

`pnpm world:start --world <ID>`로 시작합니다. `world:pause`, `world:resume`, `world:status`도 같은 인자를 받습니다. 정지 중에는 tick이 고정됩니다. 엔진과 운영 명령은 DB의 UTC 시각(`clock_timestamp()`)을 rules에 인자로 주입하며 기준 시각·tick·revision을 저장합니다. 테스트만 시각을 명시적으로 주입합니다. 운영 명령도 먼저 월드 행을 `FOR UPDATE`로 잠근 뒤 최신 상태와 DB 시각을 읽습니다. 실행 중인 턴·체크포인트를 기다려 직렬화하므로 엔진의 revision 증가 때문에 정상 정지·재개가 거부되지 않습니다. 이미 정지한 월드를 다시 정지하는 등 잘못된 상태 전환은 계속 거부합니다.
