# T2-15 운영 실행 묶음과 Docker 경량화

> 대기열: T2-15 · AC: AC-M2-08 (부분) · 구현: Codex · 리뷰: 독립 Claude · 기준: origin/main `f00ec07e`
> 상위 계획: [T2-15 배포·백업·오류 알림](./T2-15.md) · 운영 문서: [릴리스 운영](../release-operations.md), [런타임](../architecture/runtime.md)

## 계획 (Claude)

### 목표

AC-M2-08은 서버 1대에 명령 하나로 배포하고 이전 버전으로 되돌리는 연습을 한 번 성공하는 것이다. 이 작업은 그중 실행 이미지 몫만 맡는다. 운영 server·engine을 tsx 없이 esbuild `.mjs` 번들로 실행하고 migrate는 최소 Prisma CLI 이미지로 나눈다. 기존 공인 포트 Compose는 그대로 두고 공인 포트가 없는 Cloudflare Tunnel 선택 Compose를 더한다. 모두 통과해도 복귀 리허설과 실제 배포가 남으므로 AC-M2-08은 미완료로 둔다.

### 읽은 코드와 바꿀 곳

| 위치                                                                                                                       | 지금                                                                                                                                         | 바꾸는 것                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `deploy/Dockerfile` runtime 단계                                                                                           | 전체 workspace 설치본 위에서 `node --import tsx apps/*/src/index.ts`. migrate도 같은 설치본을 쓴다                                           | 번들 단계와 slim 실행 단계로 나눈다                                                          |
| `apps/engine/src/supervisor.ts:39` `spawnEngine`                                                                           | `process.execPath --import tsx <src>/index.ts --world <ID>`                                                                                  | 번들이면 자기 파일 `engine.mjs --world <ID>`로 다시 실행한다. 개발 경로는 그대로 둔다        |
| `apps/engine/src/world/resources.ts:5`, `apps/server/src/admin/worldCreateOptions.ts:45`, `apps/server/src/routers/lobby.ts:7` | `new URL('../../../../resources/…', import.meta.url)`. 번들 뒤에는 이 상대 경로가 깨진다                                                     | 명시 환경 루트 `OPENSAMGUK_RESOURCES_ROOT`                                                   |
| `apps/server/src/authz/case.ts`                                                                                            | `.authz/cases.json`을 소스 상대로 쓴다. import하는 곳은 `*.test.ts`, `tools/*authz*`, `tools/run-authz.ts` 같은 시험뿐이다                   | 운영 미사용으로 판정한다. 파일은 두고 번들 metafile에 들어가지 않음을 검사한다               |
| `apps/server/src/auth/password.ts:1`                                                                                       | `argon2` 0.45.1. 패키지에 `prebuilds/linux-x64`가 있고 실행 의존은 `@phc/format`·`node-gyp-build`다                                         | external로 두고 세 패키지만 이미지에 복사한다                                                |
| `packages/db/src/index.ts` `createDb`                                                                                      | Prisma 7.10.1 `prisma-client` 생성물과 `PrismaPg`. WASM은 `query_compiler_*_bg.postgresql.wasm-base64.mjs`에 base64로 들어 있다              | 번들에 포함하고 실제 DB 질의로 확인한다                                                      |
| `apps/server/src/server.ts:58-86`                                                                                          | `TRUST_PROXY=1`이면 `hop === 0`, 곧 직접 연결한 Caddy만 신뢰한다                                                                            | 코드는 그대로다. Tunnel의 Caddy가 XFF를 실제 IP 하나로 다시 써야 한다                        |
| `apps/server/src/index.ts`, `apps/server/src/realtime/index.ts:236`                                                       | `127.0.0.1:3001`만 listen한다. SSE heartbeat는 30초다                                                                                       | 그대로다. heartbeat는 Cloudflare 유휴 제한 100초보다 짧다                                    |
| `tools/release-artifact.ts:207`, `tools/release-target-preflight.ts:344-356, 570`                                         | 네 target을 빌드하고 User·Env·label을 검사한다. target 사전 확인은 `deploy/compose.yml` 바이트를 고정한다                                    | 수정하지 않는다. Tunnel Compose는 target 사전 확인 대상이 아니다                            |

### 범위

| 구분 | 파일                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 도구 | `package.json` (devDependencies `esbuild: 0.28.2` 정확 고정, script `build:runtime`), `pnpm-lock.yaml` importer, `tools/runtime-bundle/build.mjs` (새 파일)                                                          |
| 코드 | `apps/engine/src/supervisor.ts`, `apps/engine/src/index.ts`, `apps/engine/src/world/resources.ts`, `apps/server/src/index.ts`, `apps/server/src/routers/lobby.ts`, `apps/server/src/admin/worldCreateOptions.ts` |
| 공용 | `packages/shared/src/node/resourceRoot.ts` (새 파일), `packages/shared/package.json` exports `./resource-root`                                                                                                    |
| 배포 | `deploy/Dockerfile`, `deploy/compose.tunnel.yml` (새 파일), `deploy/Caddyfile.tunnel` (새 파일)                                                                                                                    |
| 시험 | `apps/engine/src/supervisor.test.ts` 보강, `packages/shared/src/node/resourceRoot.test.ts`, `apps/server/src/routers/lobby.test.ts` 기대 경로, `tools/t2-15-runtime-bundle.test.ts`, `tools/t2-15-compose-tunnel.test.ts` |
| 문서 | `docs/product/decisions.md`, `docs/architecture/runtime.md`, `docs/release-operations.md`, 이 문서의 구현 기록과 검증 표                                                                                           |

### 하지 않는 것

`deploy/compose.yml`, `deploy/Caddyfile`, `deploy/security.caddy`, `deploy/entrypoint.sh`의 바이트를 바꾸지 않는다. target 사전 확인의 Compose 고정값이 그대로 맞아야 한다. 규칙·엔진 턴 로직·DB schema·migration은 손대지 않으며 자체 migration 실행기를 만들지 않고 Prisma CLI `migrate deploy`를 그대로 쓴다. web target과 `build:public`도 그대로다. 복귀 리허설, 실제 운영 배포, 백업·복구 변경, target 사전 확인의 Tunnel 모드 확장은 후속이다. 개발 명령(`pnpm dev`, `engine:run`, `world:*`, `test:int`)은 계속 tsx로 실행한다.

### 결정이 필요한 것

| ID  | 내용                                                                                                                                        | 막는 단계        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| U1  | A13 확장은 2026-11-02 사용자 요청으로 승인했다.                              | 접근 7, 병합     |
| U2  | 소유자가 Tunnel 시험용 Cloudflare zone·hostname과 Tunnel token을 준비한다. 없으면 검증 표의 T 행은 미실행으로 남긴다                         | 검증 6           |

### 접근

1. 번들 도구. 루트 devDependencies에 `"esbuild": "0.28.2"`를 넣는다. lockfile은 이미 vite·tsx 경유로 0.28.2를 쓰므로 importer 줄만 늘어야 하며 해석 버전이 바뀌면 멈춘다. `tools/runtime-bundle/build.mjs`는 esbuild API로 `apps/server/src/index.ts`를 `dist/runtime/server/server.mjs`로, `apps/engine/src/index.ts`를 `dist/runtime/engine/engine.mjs`로 묶는다. 설정은 `platform: 'node'`, `format: 'esm'`, `target: 'node24'`, `bundle`, `metafile`, `external: ['argon2', 'pg-native']`, `createRequire` banner, `define: { __OPENSAMGUK_RUNTIME_BUNDLE__: 'true' }`이다. metafile 입력에 `apps/server/src/authz/`, `*.test.ts`, `tsx`, `vitest`, `prisma/build` 중 하나라도 있으면 실패한다. 그다음 server 출력 아래 `node_modules`에 `argon2`·`@phc/format`·`node-gyp-build`를 realpath로 복사하고 argon2 `prebuilds`는 `linux-x64`만 남긴다. 실행은 `pnpm build:runtime`이다.

2. 감독의 자식 실행. `supervisor.ts`에 순수 함수 `engineChildArgs(bundle, selfUrl, worldId)`를 두고 `spawnEngine`이 이를 쓴다. 번들이면 `[fileURLToPath(selfUrl), '--world', worldId]`를 돌려주는데 `selfUrl`은 번들 안의 `import.meta.url`, 곧 `engine.mjs`다. 번들이 아니면 지금의 `['--import', 'tsx', <src>/index.ts, '--world', worldId]`를 그대로 돌려준다. `declare const __OPENSAMGUK_RUNTIME_BUNDLE__: boolean | undefined`와 `typeof` 검사로 tsx 실행에서는 false가 된다. stdio·env·`stopOwnedChild` 경로는 바꾸지 않는다.

3. resources 루트. `@opensamguk/shared/resource-root`에 Node 전용 `resourceRoot(env)`를 두고 브라우저용 index에서는 내보내지 않는다. `OPENSAMGUK_RESOURCES_ROOT`가 있으면 절대 경로의 디렉터리여야 하며 끝에 `/`를 붙인 file URL을 돌려준다. `NODE_ENV=production`에서 값이 없으면 실패한다. 개발·시험에서 값이 없으면 저장소 `resources/`를 쓴다. 소스 상대 경로는 이 기본값 한 곳에만 남는다. 세 호출부는 모듈 최상위가 아니라 사용 시점에 값을 받는다. server·engine의 `index.ts`는 시작할 때 한 번 불러서 설정이 틀리면 healthz가 열리기 전에 종료한다.

4. Dockerfile. `dependencies`·`public-build`·`web`은 그대로 둔다. 실행 target은 모두 기존과 같은 Node 이미지 digest에서 새로 시작하며 pnpm·corepack·소스·전체 node_modules를 담지 않는다.

   | 단계           | FROM                       | 내용                                                                                                                                               |
   | -------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `bundle`       | `dependencies`             | `pnpm build:runtime`                                                                                                                               |
   | `migrate-pack` | `dependencies`             | `pnpm --filter @opensamguk/db deploy --legacy /opt/migrate` 뒤 `prisma/`, `prisma.config.ts`, `node_modules`만 남긴다. schema-engine `debian-openssl-3.0.x` 파일이 있는지 빌드에서 검사한다 |
   | `runtime-os`   | Node slim digest           | UID/GID 10001, `/run/secrets` 0700, `/app/deploy/entrypoint.sh` 0555                                                                              |
   | `server`       | `runtime-os`               | `/app/server` 번들, 실행 resources, `OPENSAMGUK_RESOURCES_ROOT=/app/resources`, `CMD ["node","/app/server/server.mjs"]`                           |
   | `engine`       | `runtime-os`               | `/app/engine` 번들, 실행 resources, 같은 ENV, `CMD ["node","/app/engine/engine.mjs"]`                                                             |
   | `migrate`      | `runtime-os`와 `openssl`   | `/app/migrate`, `WORKDIR /app/migrate`, `CMD ["node","node_modules/prisma/build/index.js","migrate","deploy"]`                                     |

   실행 resources는 `map/`, `scenario/`, `unitset/`, `portraits/`, `preset/`, `NOTICE.md`이고 `map-drafts/`·`officers/`는 넣지 않는다. 세 실행 target 모두 `SOURCE_REVISION`·`SOURCE_TREE_SHA256` 형식 검사, 두 label, `ENV NODE_ENV=production`, `USER 10001:10001`, `ENTRYPOINT ["/app/deploy/entrypoint.sh"]`를 지금처럼 둔다. entrypoint의 비밀 계약(환경 비밀 거부, 디렉터리 0700·파일 0600·UID 검사, `exec "$@"`)은 바뀌지 않는다. server에 `openssl`이 없어도 되는지는 검증 5에서 실제로 본다.

5. Tunnel 선택 Compose. `deploy/compose.tunnel.yml`은 override가 아닌 독립 파일이다. postgres·server·engine·migrate는 `compose.yml`과 같되 server에 `ports`가 없다. caddy는 `Caddyfile.tunnel`을 쓰고 `cap_add`·`caddy-data` 없이 `/data`를 tmpfs로 둔다. cloudflared는 digest를 고정한 공식 이미지를 `network_mode: service:server`, `read_only`, `cap_drop: [ALL]`, `no-new-privileges`로 띄운다. 명령은 `tunnel --no-autoupdate --metrics 127.0.0.1:20241 run --token-file /run/secrets/tunnel_token`이다. token은 새 external volume `tunnel-secrets`(기존과 같은 owner·target·purpose label 규칙)의 파일로만 넣고 환경·명령 인자·로그에 두지 않는다. 고정한 버전이 `--token-file`을 지원하지 않으면 환경 변수로 돌리지 말고 멈춘다. Cloudflare 쪽 공개 hostname의 서비스 값은 `http://127.0.0.1:8080` 하나이며 3001을 직접 가리키지 않는다.

   `Caddyfile.tunnel`은 기존 HTTPS site의 라우팅·`game_security`·고정 오류 응답을 그대로 옮기고 아래 부분만 다르다.

   ```caddy
   {
     admin off
     persist_config off
     auto_https off
     servers {
       protocols h1
       trusted_proxies static 127.0.0.1/32 ::1/128
       trusted_proxies_strict
       client_ip_headers CF-Connecting-IP
     }
   }

   http://:8080 {
     bind 127.0.0.1
     # 나머지 라우팅은 Caddyfile의 HTTPS site와 같다.
     handle @api {
       reverse_proxy 127.0.0.1:3001 {
         header_up X-Forwarded-For {client_ip}
       }
     }
   }
   ```

6. 보안 계약 검토. `TRUST_PROXY=1`의 Fastify는 직접 연결한 peer 하나만 신뢰하고 XFF의 마지막 값을 `req.ip`로 쓴다. 두 Compose에서 peer는 모두 loopback의 Caddy다.

   | 경로                                  | Caddy가 upstream에 보내는 XFF                                                                         | `req.ip`                                       |
   | ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
   | 공인 포트 Compose (현재)              | 신뢰 proxy가 없어 클라이언트 XFF를 버리고 peer IP 하나만 보낸다                                       | 실제 IP                                        |
   | Tunnel Compose                        | loopback의 cloudflared만 신뢰해 `CF-Connecting-IP`를 client_ip로 잡고 XFF를 그 값 하나로 덮는다      | 실제 IP                                        |
   | Tunnel에서 `header_up` 생략 (금지)    | 들어온 XFF 뒤에 cloudflared의 127.0.0.1이 붙는다                                                     | 127.0.0.1. 모든 사용자가 한 rate limit 버킷   |

   클라이언트가 `CF-Connecting-IP`나 XFF를 위조해도 Cloudflare edge가 앞의 값을 덮고 Caddy는 뒤의 값을 버린다. 이 동작은 검증 6에서 실제로 본다. 3001과 8080은 server namespace의 loopback에만 있고 공인 포트가 없으므로 Cloudflare를 거치지 않고 들어오는 요청은 같은 namespace의 프로세스뿐이다. cloudflared가 침해되면 임의 IP를 지정할 수 있는데 그 영향은 rate limit과 `LoginRecord.ipHash`의 정확도에 그친다. 권한 판정이 IP를 쓰지 않는지는 리뷰에서 확인한다.

7. 문서. `decisions.md`에는 병합 때의 다음 번호로 D-059 「A13을 Cloudflare Tunnel 선택 경로로 넓힌다」를 쓴다. 서버 1대·Compose·Caddy는 유지하고 공인 포트 Compose가 기본이다. Tunnel은 공인 포트 없는 선택 경로로서 Caddy HTTP를 loopback에만 열고 실제 IP를 `CF-Connecting-IP` 한 경로로만 받는다. token은 파일로만 넣고 target 사전 확인은 아직 Tunnel을 다루지 않는다. 2026-11-02 사용자 요청으로 승인했다. `runtime.md`는 §1 프로세스 표에 운영 실행 형태(`server.mjs`, 감독 `engine.mjs`, 자식 `engine.mjs --world <ID>`)를, §2 환경 표에 `OPENSAMGUK_RESOURCES_ROOT`를, §4에 감독 자식 명령의 두 형태를 적는다. `release-operations.md`는 §1 구성에 두 Compose를 적고 공개 실행 이미지(T2-15 B2a) 절을 번들 구성으로 고친다. Tunnel 절에는 token volume 준비, hostname 서비스 값, 공인 포트 없음, target 사전 확인 대상 아님을 쓴다.

### 검증

1. 정적·단위. `pnpm check`를 돌린다. `pnpm exec vitest run`으로 `supervisor.test.ts`, `resourceRoot.test.ts`, `lobby.test.ts`와 새 시험 둘을 돌린다. `tools/t2-15-runtime-bundle.test.ts`는 `build:runtime` 결과의 metafile에 금지 입력이 0건이고 external이 두 개뿐이며 argon2 `linux-x64` prebuild가 있는지 본다. `tools/t2-15-compose-tunnel.test.ts`는 어느 서비스에도 `ports`가 없는지, 공통 네 서비스가 `compose.yml`과 같은지, 이름에 TOKEN·KEY·SECRET·PASSWORD가 든 환경이 없는지, `Caddyfile.tunnel`에 필수 지시어가 있고 라우팅이 `Caddyfile`과 같은지 본다.
2. 통합. Postgres가 있는 Linux에서 `pnpm test:int`(감독 `supervisor.integration.test.ts` 포함)와 `pnpm test:authz`를 돌린다. release 묶음은 `pnpm exec vitest run tools/t2-15-release-preflight.test.ts tools/t2-15-release-target-preflight.test.ts tools/t2-15-release-artifact.test.ts tools/t2-15-release-manifest.test.ts`와 `node --import tsx tools/t2-15-release-target-linux.mts`다. PR head 정확 SHA의 `ci.yml`과 `release-target-preflight.yml`이 녹색이어야 한다.
3. Docker 네 빌드. 이전은 `f00ec07e`, 이후는 PR head에서 같은 Docker로 `server`·`engine`·`migrate`·`web`을 빌드한다. 가능하면 `tools/release-artifact.ts`로 묶어 User·Env·label 검사를 함께 받는다. `docker image inspect`로 User `10001:10001`, 두 label, ENTRYPOINT, 비밀 이름 없는 Env를 기록한다. 검사용으로만 `--entrypoint node`를 써서 이미지 안에 `tsx`·`pnpm`·`apps/*/src`가 없음을 확인한다.
4. 크기·RSS·기동. 이전과 이후의 이미지 크기(`docker image inspect --format '{{.Size}}'`), server 시작부터 `/healthz`가 `ok:true`가 되기까지의 초, 기동 60초 뒤 server·감독·자식 엔진의 RSS(`docker stats --no-stream`와 컨테이너 안 `/proc/<pid>/status`의 VmRSS)를 잰다. 같은 머신과 같은 DB 상태에서 3회씩 재고 중앙값을 적는다.
5. 실행 흐름. 기존 `compose.yml`과 로컬 시험값(127.0.0.1 고포트, 별도 Compose 프로젝트 이름)으로 띄운다. host 도구가 DB에 닿도록 postgres 포트를 여는 것은 저장소 밖 검증용 override 파일로만 한다. migrate profile이 종료 코드 0으로 끝나고 `_prisma_migrations`의 완료 행 수가 `packages/db/prisma/migrations` 디렉터리 수와 같아야 한다. host에서 그 DB로 `pnpm db:init-resources`, `pnpm world:create`, `pnpm world:start`를 실행한다. server가 healthy가 되고 `/healthz`·`/healthz/engine`이 정상인지 본다. 컨테이너 안에서 가입·로그인을 한 번씩 성공시켜 argon2 해시·검증을 확인한다. 감독 로그에 `started`가 남고 `docker top`에 `node /app/engine/engine.mjs --world <ID>`가 보여야 한다. `EngineHeartbeat.lastTick`과 월드 턴이 두 번 이상 늘어나야 한다. `docker compose stop engine` 뒤 20초 안에 감독이 종료 코드 0으로 끝나고 자식 PID가 남지 않으며 `EngineLease.expiresAt <= now()`여야 한다. 다시 `up`하면 같은 월드를 새 `fencingToken`으로 잡아야 한다.
6. Tunnel (U2 필요). `compose.tunnel.yml`로 같은 흐름을 띄운다. `docker compose port` 결과가 비어 있고 host listen 목록에 새 포트가 없음을 기록한다. 공개 hostname에서 정적 첫 화면, 깊은 경로 새로고침(`index.html`과 `Cache-Control: no-store`), `/assets/*` 200을 본다. 로그인 뒤 SSE가 2분 넘게 유지되며 턴 갱신 이벤트를 받는지, 끊은 뒤 다시 연결되는지 본다. 실제 IP 확인으로 같은 망에서 로그인 실패를 한도까지 보내 429를 받는다. 위조 `CF-Connecting-IP`·`X-Forwarded-For`를 붙여도 같은 버킷이어야 하고 다른 망(휴대폰 테더링 등)은 따로 계산돼야 한다. 두 망의 `LoginRecord.ipHash`가 서로 다르고 127.0.0.1의 해시와도 달라야 한다.
7. 리뷰와 PR. 구현하지 않은 독립 Claude 세션이 계획 대비 범위, 패키지 경계, 보안, 문구를 리뷰한다. 필수 지적이 0건이 된 뒤 PR을 열고 본문에는 아래 표의 값과 미실행 행을 그대로 옮긴다.

미실행·skip·mock만의 행이나 미병합 상태가 하나라도 있으면 이 작업을 완료로 보고하지 않는다.

### 주요 위험

| 위험                                                                      | 확인                                   | 막히면                                                            |
| ------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| esbuild가 CJS 의존(fastify·pino·pg)의 동적 require를 풀지 못한다          | banner와 컨테이너 기동                 | 그 패키지만 external로 돌리고 복사 목록과 이유를 이 문서에 남긴다 |
| pino가 worker transport를 쓰면 번들에서 깨진다                            | 현재 transport 없음, 기동 로그         | 멈추고 보고한다                                                   |
| Prisma WASM base64 로딩이나 생성물의 `import.meta.url`이 번들에서 어긋난다 | 컨테이너에서 실제 질의                 | 멈추고 보고한다. 생성기 설정은 이 작업에서 바꾸지 않는다          |
| `pnpm deploy --legacy` 출력이 크거나 schema-engine이 빠진다               | 크기 표와 빌드 중 파일 검사            | prisma 단독 설치를 별도 계획으로 올린다                           |
| cloudflared의 `--token-file` 미지원                                       | 고정 버전에서 `--help`                 | 환경 변수 우회 없이 멈춘다                                        |
| 두 Caddyfile의 라우팅이 어긋난다                                          | `t2-15-compose-tunnel.test.ts`         | 시험이 막는다                                                     |
| Windows 로컬의 CRLF와 공유 DB·포트                                        | Linux에서 실행, 별도 Compose 프로젝트  | 증거는 Linux 실행 결과만 쓴다                                     |
| 다른 작업과 D-059 번호 충돌                                               | 병합 직전 `decisions.md`               | 다음 번호로 다시 매긴다                                           |

### 범위 확장 (2026-11-02 사용자 승인)

A13 Tunnel은 선택 항목으로 두고 Docker 밖의 리팩터링도 이번 범위에 넣는다. 권한을 확인하는 단계는 더 두지 않는다. web·shared 변경은 upstream PR이 맡고 CF worker 채팅은 병합된 upstream 경로를 import한다.

#### 1. HTTP 요청 정책 추출

- 새 경로 `@opensamguk/shared/request-policy`(`packages/shared/src/http/requestPolicy.ts`)를 만든다. 이 파일은 `node:`와 런타임 객체를 import하지 않는 순수 함수만 둔다.
  - `requestGuard({ method, accept, origin, secFetchSite, contentType }, publicOrigin)`는 `{ status: 403 | 415, error } | null`을 돌려준다. 지금 `server.ts:96-107`의 판정 순서와 문구를 그대로 옮긴다. 대상은 POST 또는 SSE이고 Origin을 먼저 보고 Origin이 없으면 `sec-fetch-site: same-origin`을 본다. 403 판정을 415보다 먼저 한다.
  - `/trpc` 경로 필터와 보안 헤더 설정, `reply.code()` 호출은 Fastify 훅에 남긴다.
- 같은 경로에 epoch 창 함수를 둔다.
  - `rateLimitWindows(rules, now)`는 규칙을 검증하고 `{ rule, key, end }`를 계산한다. 계산식은 지금처럼 `key = JSON.stringify([namespace, key, windowMs])`, `end = (floor(now/windowMs)+1)*windowMs`이다.
  - `rateLimitDecision(entries, now)`는 막힌 규칙의 `end` 가운데 가장 늦은 값으로 `retryAfterSeconds`를 올림해 계산한다.
  - `createRateLimiter`는 Map 저장소, 만료 정리, 중복 키를 한 번만 세는 처리를 그대로 가진다. CF는 자기 저장소에 같은 함수를 쓴다. 429 응답과 Retry-After 연결은 기존 호출부에 그대로 둔다.
- 옵션 인자는 새로 만들지 않는다.

시험

- `requestPolicy.test.ts`
  - 다른 출처의 POST와 SSE는 403이다.
  - Origin이 없을 때 same-origin은 통과하고 none·cross-site는 403이다.
  - SSE가 아닌 GET은 null이다.
  - `text/plain` POST는 415이고 `Application/JSON; charset=utf-8`은 통과한다.
  - 출처와 형식이 둘 다 틀리면 403이다.
- 요청 제한 시험
  - 한도에 닿으면 막힌다.
  - 창 경계 1ms 전에는 retry가 1초이고 경계 시각에는 초기화된다.
  - 규칙 여럿 가운데 가장 긴 대기를 돌려준다.
  - 잘못된 규칙은 예외를 던진다.
- 기존 server 403·415·429 시험은 고치지 않고 회귀 증거로 쓴다.

#### 2. 게임 이미지 분리

- 이미지는 모두 `opensamguk/opensamguk-images`로 옮긴다. 공개 초상은 지금처럼 fallback만 쓴다. `portraits/` 경로는 계속 금지한다.
- 주소는 전체 40자리 커밋 SHA로 고정한다. 권장 형식은 `https://cdn.jsdelivr.net/gh/opensamguk/opensamguk-images@<SHA>/<path>`이다. raw.githubusercontent는 SVG를 `text/plain`으로 보내 그림이 표시되지 않으므로 쓰지 않는다. jsDelivr는 CORS(`*`)를 주므로 CSS `mask-image`도 동작한다.
- 승인 목록은 shared에 `{ path, url, sha256, provenance }` 형태로 둔다. 지금의 `publicMapImages.ts`를 넓혀 쓴다.
  - web은 SVG·PNG 바이너리 import를 이 상수의 URL로 바꾼다.
  - eslint `no-restricted-imports`로 이미지 확장자 import를 막는다.
- 빌드
  - `assetsInlineLimit: 0`을 유지한다.
  - `public-build.json`의 `images`는 `[]`이어야 한다. dist의 이미지 파일은 0개이다.
- `manifest/public-assets.json`
  - `bundledImages`·`mapImages`를 `remoteImages`로 바꾼다. 각 항목은 `{ url, sha256, source, license }`이다.
  - `externalAssetOrigins`는 빈 배열로 유지한다.
- 검사기
  - 허용 목록 URL은 문자열이 정확히 같을 때만 통과시킨다.
  - 다른 호스트, `@main`·태그·짧은 SHA, 목록에 없는 경로, 그 밖의 `opensamguk-images` 문자열은 실패시킨다.
  - `security.caddy`의 `img-src`가 `'self'` 하나와 정확한 이미지 출처 하나인지 확인한다.
  - 원격 바이트 대조는 이미지 저장소 CI가 맡는다. 이 검사기는 네트워크 없이 형식·목록·해시 기록만 확인한다.
- D-031을 고치는 결정 기록을 새로 추가한다. 출처는 NOTICE에 남긴다.

시험

- `check.test.ts`
  - 이미지가 0개인 dist는 통과하고 이미지 파일이 하나라도 있으면 실패한다.
  - 정확한 URL이 JS·CSS·HTML 어디에 있어도 통과한다.
  - SHA나 경로가 틀린 URL과 다른 호스트는 실패한다.
  - CSP가 다르면 실패한다.
  - manifest가 잘못되면 실패한다.
- `pnpm build --mode public` 뒤 검사기를 실제로 실행한다.

#### 위험

- CDN이 멈추면 fallback 초상도 보이지 않는다. CSS 배경색을 마지막 대비책으로 둔다.
- 이미지 저장소 SHA를 바꿀 때 manifest·shared·CSP를 함께 고쳐야 한다. shared 상수 하나를 원본으로 삼아 셋을 맞춘다.

## 구현 기록 (담당)

- 바꾼 것:
- 계획과 달라진 점과 이유:
- 검증 결과: 아래 표에 채운다.

## 리뷰 (독립 Claude)

- 결과:
- 확인한 것:
- 고칠 것:

## 검증 증거

결과 칸에는 통과·실패·미실행 중 하나만 쓴다. 증거 위치는 커밋하지 않는 로그 경로나 CI 실행 URL이다.

| #   | 항목                                       | 명령·방법                                       | 통과 기준                                                     | 대상 SHA | 결과   | 증거 위치 |
| --- | ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------- | -------- | ------ | --------- |
| S1  | 전체 검사                                  | `pnpm check`                                    | 종료 코드 0                                                   |          | 미실행 |           |
| S2  | 번들 metafile                              | `tools/t2-15-runtime-bundle.test.ts`            | 금지 입력 0, external 2                                      |          | 미실행 |           |
| S3  | Tunnel Compose 정적 검사                   | `tools/t2-15-compose-tunnel.test.ts`            | ports 0, 공통 서비스 동일, 비밀 환경 0                        |          | 미실행 |           |
| I1  | 감독 통합                                  | `pnpm test:int`                                 | FAIL·skip 0                                                   |          | 미실행 |           |
| I2  | 권한 통합                                  | `pnpm test:authz`                               | FAIL·skip 0                                                   |          | 미실행 |           |
| I3  | release 묶음                               | 검증 2의 vitest 네 파일과 Linux fixture         | FAIL·skip 0                                                   |          | 미실행 |           |
| I4  | 정확 SHA CI                                | `ci.yml`, `release-target-preflight.yml`        | 모두 녹색                                                     |          | 미실행 |           |
| D1  | Docker 네 빌드                             | 검증 3                                          | 네 target 성공, User·label·ENTRYPOINT 유지                    |          | 미실행 |           |
| D2  | 이미지 내용                                | 검증 3                                          | `tsx`·`pnpm`·소스 없음                                        |          | 미실행 |           |
| R1  | migrate                                    | 검증 5                                          | 종료 0, 완료 행 수 = migration 수                             |          | 미실행 |           |
| R2  | healthz·argon2                             | 검증 5                                          | `ok:true`, 가입·로그인 성공                                   |          | 미실행 |           |
| R3  | 감독 자식                                  | 검증 5                                          | `engine.mjs --world <ID>` 자식 확인                           |          | 미실행 |           |
| R4  | 턴 진행                                    | 검증 5                                          | heartbeat·턴 2회 이상 증가                                    |          | 미실행 |           |
| R5  | 종료·리스 해제                             | 검증 5                                          | 20초 안 종료 0, 자식 없음, `expiresAt <= now()`               |          | 미실행 |           |
| T1  | 공인 포트 없음                             | 검증 6                                          | `docker compose port` 비어 있음, 새 listen 없음               |          | 미실행 |           |
| T2  | 정적·새로고침                              | 검증 6                                          | 첫 화면, 깊은 경로, `/assets/*` 200                           |          | 미실행 |           |
| T3  | SSE                                        | 검증 6                                          | 2분 넘게 유지, 이벤트 수신, 재연결                            |          | 미실행 |           |
| T4  | 실제 IP rate limit                         | 검증 6                                          | 위조 헤더 무시, 망별 버킷, `ipHash` 상이                      |          | 미실행 |           |
| V1  | 독립 Claude 리뷰                           | 검증 7                                          | 필수 지적 0                                                   |          | 미실행 |           |
| V2  | PR 병합                                    | 보호 규칙                                       | 병합 SHA 기록                                                 |          | 미실행 |           |

크기·RSS·기동 비교는 3회 중앙값이다. migrate는 healthz 칸에 시작부터 종료까지 걸린 초를 적는다.

| 대상               | 크기 이전 | 크기 이후 | healthz까지 초 이전 | 이후 | RSS MiB 이전 | 이후 |
| ------------------ | --------- | --------- | ------------------- | ---- | ------------ | ---- |
| server             |           |           |                     |      |              |      |
| engine 감독        |           |           | 해당 없음           |      |              |      |
| engine 자식 (1월드) | 해당 없음 | 해당 없음 | 해당 없음           |      |              |      |
| migrate            |           |           |                     |      | 해당 없음    |      |
| web                |           |           | 해당 없음           |      | 해당 없음    |      |
