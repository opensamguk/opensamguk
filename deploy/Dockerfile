# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm generate

FROM dependencies AS public-build
RUN pnpm build:public

# 정적 화면은 실제 공개 빌드와 자산 검사를 통과한 파일만 내보낸다.
FROM scratch AS web
COPY --from=public-build /app/apps/web/dist/ /web/

FROM dependencies AS bundle
RUN pnpm build:runtime

FROM dependencies AS migrate-pack
RUN pnpm --filter @opensamguk/migrate-runtime deploy --prod --legacy /opt/migrate \
    && test -f /opt/migrate/node_modules/prisma/build/index.js \
    && test -n "$(find /opt/migrate/node_modules -name schema-engine-debian-openssl-3.0.x -print -quit)"

# 빌드 도구·소스·pnpm store가 없는 공통 실행 기반이다.
FROM node:24-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS runtime
WORKDIR /app
ARG SOURCE_REVISION
ARG SOURCE_TREE_SHA256
COPY deploy/entrypoint.sh /app/deploy/entrypoint.sh
COPY LICENSE NOTICE /app/
RUN node -e 'if(!/^[a-f0-9]{40}$/.test(process.argv[1])||!/^[a-f0-9]{64}$/.test(process.argv[2]))process.exit(1)' "$SOURCE_REVISION" "$SOURCE_TREE_SHA256" \
    && groupadd --gid 10001 opensamguk \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin opensamguk \
    && install -d -o 10001 -g 10001 -m 0700 /run/secrets \
    && chmod 0555 /app/deploy/entrypoint.sh
LABEL org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opensamguk.source-tree-sha256="$SOURCE_TREE_SHA256"
ENV NODE_ENV=production
USER 10001:10001
ENTRYPOINT ["/app/deploy/entrypoint.sh"]

FROM runtime AS app-runtime
COPY resources/map /app/resources/map
COPY resources/scenario /app/resources/scenario
COPY resources/unitset /app/resources/unitset
COPY resources/portraits /app/resources/portraits
COPY resources/preset /app/resources/preset
COPY resources/NOTICE.md /app/resources/NOTICE.md
ENV OPENSAMGUK_RESOURCES_ROOT=/app/resources

FROM app-runtime AS server
ENV AUDIT_HASH_CONFIG_FILE=/run/secrets/audit_hash_config
COPY --from=bundle /app/dist/runtime/server/server.mjs /app/server/server.mjs
COPY --from=bundle /app/dist/runtime/server/THIRD_PARTY_NOTICES.txt /app/server/THIRD_PARTY_NOTICES.txt
COPY --from=bundle /app/dist/runtime/server/node_modules /app/server/node_modules
CMD ["node", "/app/server/server.mjs"]

FROM app-runtime AS engine
COPY --from=bundle /app/dist/runtime/engine/engine.mjs /app/engine/engine.mjs
COPY --from=bundle /app/dist/runtime/engine/THIRD_PARTY_NOTICES.txt /app/engine/THIRD_PARTY_NOTICES.txt
CMD ["node", "/app/engine/engine.mjs"]

FROM runtime AS migrate
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=migrate-pack /opt/migrate/node_modules /app/migrate/node_modules
COPY packages/db/prisma /app/migrate/prisma
COPY packages/db/prisma.config.ts /app/migrate/prisma.config.ts
WORKDIR /app/migrate
USER 10001:10001
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
