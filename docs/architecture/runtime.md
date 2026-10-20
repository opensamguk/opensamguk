# 런타임

> 상태: 로컬 실행 초안 (T1-02) · 서버 배포는 M2 · 참고: core2026 `docs/architecture/runtime.md`
> 이 문서가 답할 질문: 어떤 프로세스가 몇 개 뜨고, 무엇을 설정하고, 어떻게 켜고 끄나?

## 1. 프로세스

| 프로세스      | 개수                         | 역할 |
| ------------- | ---------------------------- | ---- |
| `server`      | 1                            | API, SSE, 정적 화면 제공 |
| `engine`      | 월드마다 1 (또는 하나가 여러 월드) ⚠️ | 턴 실행 |
| PostgreSQL    | 1                            | 저장 |
| Caddy         | 1                            | HTTPS, 프록시 |

<!-- TODO(M1): engine을 월드마다 프로세스 하나로 띄울지, 한 프로세스가 여러 월드를 돌릴지 정한다. AC-M2-01(한 월드 장애가 다른 월드에 안 번짐)을 기준으로. -->

## 2. 환경변수

루트 `.env`에 둡니다 (`.env.example`을 복사). 비밀값은 운영에서 파일(`/run/secrets`)로만 넣습니다.

| 이름                  | 의미                     | 기본값 (로컬)                                                  | 비밀 | 상태 |
| --------------------- | ------------------------ | -------------------------------------------------------------- | ---- | ---- |
| `DATABASE_URL`        | PostgreSQL 연결          | `postgresql://opensamguk:opensamguk@127.0.0.1:5433/opensamguk` | 예   | 사용 중 |
| `SERVER_PORT`         | API 서버 포트            | `3001`                                                         | 아니오 | 사용 중 |
| `SESSION_SECRET`      | 세션 서명                | —                                                              | 예   | T1-10에서 |
| `VITE_IMAGE_BASE_URL` | 초상 이미지 base URL     | —                                                              | 아니오 (공개값) | T1-17에서 |

## 3. 로컬 실행

```sh
cp .env.example .env   # 처음 한 번
pnpm install
pnpm db:up             # PostgreSQL 18, 127.0.0.1:5433
pnpm dev               # web 127.0.0.1:5173 · server 127.0.0.1:3001 · engine
pnpm e2e               # 스모크 테스트 (dev 서버가 없으면 자동으로 켬)
pnpm db:down           # DB 끄기 (데이터는 볼륨에 남음)
```

- web은 `/trpc` 요청을 server로 프록시합니다.
- server·engine은 `tsx watch`로 실행합니다. Node `--watch`는 macOS에서 파일 감시 한도를 넘어 실패했습니다.
- Claude 실행 환경의 sandbox는 Docker 소켓과 로컬 포트를 막습니다. 그 환경에서는 sandbox 밖에서 실행하거나
  `sandbox.network.allowLocalBinding`을 켭니다.

## 4. 엔진 수명 주기

<!-- TODO(M1): 시작 → 리스 획득 → 월드 적재 → 턴 루프 → 리스 갱신 → 종료. 리스를 잃으면 즉시 멈춤. -->

## 5. 월드 상태 전환

<!-- TODO(M1): PREOPEN → RUNNING ⇄ PAUSED → ENDED. 누가 어떤 명령으로 바꾸나. -->
