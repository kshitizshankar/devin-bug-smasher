# syntax=docker/dockerfile:1
# One image for the service. The build stage installs the locked toolchain and builds the dashboard
# frontend; the runtime keeps only the TypeScript sources Node runs directly, prompts, the replay
# recording and the built frontend. No credential is read at build time or stored in any layer.

ARG NODE_IMAGE=node:22.18.0-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:29-cli

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY web ./web
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
  && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Docker client only: verification runs target tests in sibling containers of the host daemon.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json package-lock.json ./
COPY src ./src
COPY prompts ./prompts
COPY replay ./replay
COPY --from=build /build/dist/web ./dist/web
ENV NODE_ENV=production \
  BUG_SMASHER_CONTAINER=true \
  HOST=0.0.0.0 \
  PORT=8080
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/server/main.ts"]
