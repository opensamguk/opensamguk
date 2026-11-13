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

`deploy/compose.yml`, `deploy/Caddyfile`, `deploy/entrypoint.sh`의 바이트를 바꾸지 않는다. CSP는 이후 승인된 D-060에 따라 바꾼다. target 사전 확인의 Compose 고정값이 그대로 맞아야 한다. 규칙·엔진 턴 로직·DB schema·migration은 손대지 않으며 자체 migration 실행기를 만들지 않고 Prisma CLI `migrate deploy`를 그대로 쓴다. web target 이름은 유지하며 D-060 외부 이미지 계약을 빌드에 반영한다. 복귀 리허설, 실제 운영 배포, 백업·복구 변경, target 사전 확인의 Tunnel 모드 확장은 후속이다. 개발 명령(`pnpm dev`, `engine:run`, `world:*`, `test:int`)은 계속 tsx로 실행한다.

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
- 주소는 전체 40자리 커밋 SHA로 고정한다. PNG·WebP는 `https://raw.githubusercontent.com/opensamguk/opensamguk-images/<SHA>/<path>`, SVG는 `https://rawcdn.githack.com/opensamguk/opensamguk-images/<SHA>/<path>`를 쓴다. 실제 MIME·CORS·해시와 브라우저 표시를 확인한다.
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
- D-031을 고치는 결정 기록을 새로 추가한다. 출처는 NOTICE에 남긴다. 2026-11-13 D-086이 공개 빌드 초상 부분을 고쳤다.

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

## 구현 기록

운영 server·engine은 esbuild0.28.2로 만든 `.mjs`를 실행한다. 감독은 같은 번들을 `--world`로 실행하며 소스 실행의 tsx 경로는 유지한다. 자료 루트는 `OPENSAMGUK_RESOURCES_ROOT`로 받는다. argon2의 Linux native prebuild는 external로 복사하고 Prisma WASM query compiler는 번들에 포함한다. migrate는 전용 workspace의 Prisma 운영 의존성·schema·migration·config만 받는다.

사용자가 추가로 요청한 공통 이미지 분리와 범위 밖 리팩터링은 Workers 담당과 협의했다. IO 없는 Origin·JSON 요청 검사와 요청 제한 창 계산을 shared로 옮겼다. 게임 규칙·턴 처리·저장소 구현은 바꾸지 않았다. 공개 그림97개와 개발·편집 입력11개는 `opensamguk-images`의 `b7efb438b70058aefdfa2fbc4693ca7db259bbc6`으로 고정했다. PNG·WebP는 GitHub raw, SVG는 rawcdn.githack.com을 쓴다. jsDelivr의 SVG는 실제 요청에서403이어서 채택하지 않았다. 생성기 출력과 출처 기록도 이미지 저장소로 옮겼다.

프론트 구현은 사용자 인계에 따라 Claude Code가 맡았다. 외부 바탕 그림의 canvas 읽기에 `crossOrigin='anonymous'`를 넣고 처리 오류가 promise를 거부하도록 고쳤다. 실제 Chromium 비교에서 수정 전 `SecurityError`, 수정 후 픽셀700000바이트 읽기를 확인했다. 디자인 변경은 하지 않았으며 이후 디자인은 사용자 지정 Claude 도구가 맡고 이미지 생성은 Codex가 맡는다.

기본 Compose·HTTPS Caddyfile·비밀 진입점의 바이트는 유지했다. 선택 Tunnel 파일은 기본 서비스를 상속하고 HTTP Caddy와 cloudflared를 같은 namespace에서 실행한다. 실제 Compose 해석 결과 여섯 서비스의 공개 포트는0개다. Caddy는 loopback cloudflared의 CF-Connecting-IP만 신뢰하고 XFF를 클라이언트 IP 하나로 덮어쓴다. `TRUST_PROXY=1` 계약을 유지한다.

### 계획에서 바뀐 점

- D-060 승인으로 이미지 바이트를 외부 저장소로 옮기면서 web 빌드·자산 검사·CSP도 바꿨다. target 이름과 기존 공개 승인 목록은 유지했다.
- Tunnel 정적 파일 대조 시험 대신 실제 `docker compose config --format json` 결과의 포트·권한·비밀 환경 계약을 검사하고 실제 Caddy 요청으로 IP 전달을 확인했다.
- 권한 판정 분기는 직접 바꾸지 않아 전체 authz 묶음은 실행하지 않았다. 영향받는 감독·security·session-renewal·preset 통합85개와 release 관련193개를 실행했다.
- 기존 기본 Compose에는 필수 `AUDIT_HASH_KEY` 전달이 없다. 기준판도 그대로는 시작하지 못한다. 이 작업은 기본 파일을 보존하므로 격리 리허설의 별도 command override에서 비밀 파일을 읽어 전달했다. 운영 적용 전 이 기존 간극을 해결해야 한다.
- 승인된 Tunnel 도메인·토큰과 서로 다른 두 공인 클라이언트가 없다. Quick Tunnel은 SSE를 지원하지 않으므로 공개 Tunnel 종단 시험을 완료로 세지 않았다. 아래 T행의 실제 Caddy 리허설과 구별한다.

## 독립 리뷰

Claude의 최초 독립 리뷰는 P2 두 건을 지적했다. 관 성벽 생성기의 삭제된 입력 경로와 운영 문서의 오래된 CSP 설명이었다. 생성기를 외부 저장소로 옮기고 중복 출처 사본을 지웠으며 CSP·출처 설명을 고쳤다. Claude 재리뷰는 두 건 해결과 새 P1/P2 없음으로 판정했다. 구현 담당 Codex가 리뷰 결과를 고쳤다.

프론트 인계 후 Claude Code가 구현한 CORS 처리와 새로고침 시험은 Codex가 독립 확인했다. CORS 설정이 `src` 대입보다 앞에 있고 오류가 정착하며 기존 요청·그림 목록 제한을 유지하는 것을 확인했다. 실행 증거는 별도 artifact에 보관한다. 초기 PR CI에서 드러난 인라인 fallback 가정과 외부 요청0개 가정도 Claude Code가 D-060 계약에 맞춰 고쳤다. 승인 fallback URL·바이트 해시·실제 표시를 확인하는 Chromium2개와 승인 이미지 외 script·fetch·다른SHA·원작·개발 그림을 거부하는 정책6개를 통과했다. 이 수정도 Codex가 독립 확인했다.

## 검증 증거

로그 기준 위치는 `E:\codex-artifacts\opensamguk\t2-15-runtime-bundles`다. 로그·비밀·리허설 DB는 Git에 넣지 않는다. skip 또는 mock 결과를 실제 API·엔진 증거로 세지 않는다.

| 항목 | 결과 | 실제 증거와 범위 |
| --- | --- | --- |
| `pnpm check` | 통과 | `check-release.log`, 전체6484개 통과·종료0. 최초 시작 검사9건의 순서 회귀는 수정 후11개 통과. 다음 전체 검사는 기존 uptimeDrill의 PID 종료 관측1건 실패. 해당 파일5개는 단독 재실행 통과. |
| 번들·자료 루트·감독 인자 | 통과 | `focused.log`, 4파일21개. WASM metafile·금지 입력·native argon2 확인. |
| shared·공개 정책 | 통과 | `shared-focused.log`, 6파일99개. |
| 감독·security·session·preset 실제 DB | 통과 | `integration-final.log`, 4파일85개, skip0. |
| release·공개 산출물 검사 | 통과 | `release-focused.log`, 7파일193개. |
| Docker 네 target | 통과 | `reviewed-{server,engine,migrate,web}-build.log`. 프론트 최종 수정의 web은 `frontend-full-web-build.log`. |
| 런타임 내용·label·UID | 통과 | 실제 image inspect와 파일 목록. server·engine의 TypeScript·tsx·Vitest·esbuild·pnpm store0. migrate의 `.pnpm`은 운영 의존성 링크 구조이며 다운로드 store가 아니다. |
| 비밀 파일 권한 | 통과 | 실제 Linux 컨테이너 `/run/secrets`700, database_url·mail_api_key600, 소유10001:10001. 기존 진입점 바이트 동일. |
| migrate·API·Prisma·argon2 | 통과 | `final-migrate.log`, `reviewed-migrate.log`. 기준판39개 migration 적용, 이후 재실행0. 실제 native 해시 생성과 로그인200, healthz200. |
| 감독·턴·정상 종료·리스 | 통과 | `reviewed-tunnel-rehearsal-result.json`. 번들 자식 확인, monthlyTick40000·actionSequence12, 271ms 안 exit0, 리스 해제. |
| 선택 Compose 보안 | 통과 | `tunnel-config-check.log`. 실제 렌더링의 여섯 서비스 ports0·read_only·cap_drop·사용자·원문 DB 환경 거부 계약. |
| Caddy 정적 경로·SSE·IP | 통과 | `reviewed-tunnel-rehearsal-result.json`. SPA 깊은 경로200, 없는 asset404, SSE125초·heartbeat4회·턴 이벤트·재연결. 가짜 trusted-edge IP A429/B200, XFF 위조429, 로그인 ipHash가 CF IP의 HMAC과 일치. 공개 Cloudflare 시험은 아님. |
| 원격 이미지 | 통과 | `remote-images.log`, 실제108개 GET의 해시·MIME·CORS. |
| Chromium 공개 자산·새로고침 | 통과 | `frontend-claude-handoff.txt`, 실제 Chromium5개. API·SSE503 mock은 자산 격리에만 사용. |
| 생성기 | 통과 | Python compile과 외부 저장소 fixture의 성벽 출력4개·출처 경로 확인. 게임 저장소에 PNG를 다시 만들지 않음. |
| cloudflared 옵션 | 통과 | 고정2026.10.7 digest의 `cloudflared-help.log`, `--token-file` 지원 확인. |
| named Tunnel 공개 SSE·두 공인 IP | 미실행 | 승인된 도메인·토큰·클라이언트 없음. |
| 전체 authz 묶음 | 미실행 | 영향 통합85개와 구분. |
| 정확 PR SHA CI | PR Checks 참조 | PR head와 merge queue의 필수 검사 결과는 PR에 기록한다. |

### 크기·RSS·기동 시간

기준 소스는 `f00ec07e04744f607b9c4bb94dc20b87b3e737f3`, 수정 실행 이미지는 `6dcc81ae796dfbd323dd49b153d0639bce76bdad`, 최종 프론트 web은 `5906dad992ef258e3ff93b0c139d52f1094c669d`다. git archive의 파일 바이트·blob을 대조한 깨끗한 context로 빌드했다. source-tree SHA-256은 각각 `ca9061a33f0d7874d870dd2522e68a94264912469a2c1cb7717f18ba69efd248`, `71444e8a8755c496587d47ba6d95356e798538434c2cb47970e14bbb5aebd261`, `37893aa8c37459aae6723a5150fe8ba7e5917eb3b2188e11fa752cb39b2b4a47`이다. 보호된 main 전용 정식 release producer를 우회하지 않은 후보 리허설이다.

Docker Desktop Linux에서 같은 DB·실행 중 월드1개·활성 장수2명·고정 clock 조건으로 세 번 재시작했다. 기동은 Docker StartedAt부터 server listen 로그 또는 engine 첫 heartbeat까지다. healthz 성공을 따로 확인했다. 매번60초 뒤 `/proc`의 RSS를 측정하며 측정용 Node는 제외했다. 아래는 세 번의 중앙값이다. `docker image inspect .Size`의 비압축 크기이며 web은 scratch export의 정적 파일 합계다.

| 대상 | 크기 이전 MiB | 이후 MiB | 감소 | RSS 이전 MiB | 이후 MiB | 기동 이전 ms | 이후 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| server | 905.27 | 230.65 | 74.5% | 246.44 | 187.10 | 1937 | 664 |
| engine 전체 | 905.27 | 228.55 | 74.8% | 489.38 | 461.01 | 1958 | 759 |
| engine 감독 | 해당 없음 | 해당 없음 | 해당 없음 | 195.19 | 175.11 | 해당 없음 | 해당 없음 |
| engine 자식1개 | 해당 없음 | 해당 없음 | 해당 없음 | 274.75 | 285.89 | 해당 없음 | 해당 없음 |
| migrate | 905.27 | 457.96 | 49.4% | 해당 없음 | 해당 없음 | 해당 없음 | 해당 없음 |
| web export | 6.65 | 6.22 | 6.4% | 해당 없음 | 해당 없음 | 해당 없음 | 해당 없음 |

전체 RSS는 기준판의 tsx/esbuild 보조 프로세스도 포함한다. 각 프로세스의 중앙값 합과 전체 중앙값은 다를 수 있다. server RSS는24.1%, engine 전체는5.8% 줄었다. engine 자식만 보면4.1% 늘었으므로 모든 프로세스의 메모리가 줄었다고 판단하지 않는다. 작은 fixture와3회 측정이며 운영 부하의 메모리 상한이나 처리량 증거가 아니다. 원시 값은 `baseline-final-metrics.json`, `reviewed-final-metrics.json`, `comparison.json`에 있다.

### 의존성 고지 보존

최종 이미지에는 번들 입력에 포함된 npm 패키지의 metadata·LICENSE·NOTICE·COPYING을 `THIRD_PARTY_NOTICES.txt`로 함께 넣었다. upstream에 별도 파일이 없으면 배포된 README를 보존한다. 서버 고지는255416바이트, 엔진 고지는110747바이트다. 실제 pg LICENSE 원문 포함 시험과 독립 Claude 리뷰를 통과했다.

이 최종 네 target은 `b3c0f3f92820658641b3ecca458ff649a4c4a9f2`, source-tree SHA-256 `6d47f5b7bc0db4e6548edaa2eb5490e22da513be7497716e9084e981b01b9315`로 다시 빌드했다. 위 크기 표는 고지 파일을 포함한 최종 크기다. `licensed-payload-proof.json`에서 최종 이미지의 server·engine `.mjs` SHA-256이 RSS 측정판과 각각 같은 것을 확인했다. 실행 코드가 같아 측정 결과를 유지했다. 최종 이미지의 migrate·healthz·engine healthz·감독 자식도 다시 확인하고 리허설 컨테이너를 종료했다.
### 인수 상태

이 기록은 실행 이미지와 공통 자산 분리의 검증이다. 공개 named Tunnel·두 공인 IP, 기존 audit 키 전달 간극, 실제 운영 배포·복귀 리허설은 남아 있다. AC-M2-08 전체를 완료로 바꾸지 않는다. 이미지 PR은 [opensamguk-images#48](https://github.com/opensamguk/opensamguk-images/pull/48)로 머지했다. 코드 PR과 최종 CI·병합 결과는 후속 기록한다.

조사 키 전달 간극은 [후속 파일 설정](./T2-15-audit-secret-file.md)에서 기본 Compose·entrypoint를 보존해 해결·검증한다. 위 초기 리허설의 override 사용 기록은 당시 증거로 남긴다.
