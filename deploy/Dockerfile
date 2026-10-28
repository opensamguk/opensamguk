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

FROM dependencies AS runtime
ARG SOURCE_REVISION
ARG SOURCE_TREE_SHA256
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

FROM runtime AS server
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]

FROM runtime AS engine
CMD ["node", "--import", "tsx", "apps/engine/src/index.ts"]

FROM runtime AS migrate
WORKDIR /app/packages/db
CMD ["node", "/app/packages/db/node_modules/prisma/build/index.js", "migrate", "deploy"]
