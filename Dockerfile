#
# The GenOffice web-server image.
#
#   1. builder   — Node 22 + the npm workspace install; builds every renderer
#                  the server can serve, the server bundle, and the SDK.
#   2. runtime   — Node 22 base, the artefacts above, and nothing else. No
#                  node_modules: the server bundle is self-contained.
#
# This is the ONLY Dockerfile. It replaces a pair that had drifted apart:
# `apps/web-server/Dockerfile` (which release.yml published) shipped one
# renderer and no SDK bytes, while this one shipped neither — so
# `/static/sdk/*` and six of seven editors were 404 in every released image,
# and even the files it did copy resolved to the wrong path inside the
# container (see the ENV pins below). One build path, one image (sdk1.md
# §11.125).
#
# Build:  docker build -t genoffice/web:latest .
# Run:    docker run -p 8080:8080 -e WEB_TOKEN=$(openssl rand -hex 32) genoffice/web:latest
#
# WEB_TOKEN is not optional: the image binds 0.0.0.0, and the server refuses
# to start on a non-loopback bind without a shared secret
# (apps/web-server/src/common/startup-checks.ts). Without it the container
# exits 1 and prints what to set.

# ── Stage 1: builder ──
FROM node:22.12-bookworm-slim AS builder

WORKDIR /repo

# npm is this repo's package manager (package-lock.json) and what every CI job
# uses. The `pnpm-lock.yaml` sitting next to it has no workspace importers, so
# installing from it produced a root-only node_modules and none of the apps'
# dependencies. `--ignore-scripts` skips `postinstall: install-electron`: the
# renderer builds need the `electron` package resolvable, not its ~100 MB
# binary.
#
# The root package.json's two `@rollup/rollup-linux-*` optionalDependencies are
# load-bearing — do not remove them. Rollup ships its parser as a per-platform
# optional dependency, and npm only records the *generating* platform's variant
# when it writes a lockfile (this one was generated on darwin, which is why
# `rollup` resolves here but `@esbuild/*` — locked earlier, all 26 platforms —
# does not help). Without these entries `npm ci` on linux installs no rollup
# binding at all, and the first `electron-vite build` dies with
# `MODULE_NOT_FOUND ... rollup/dist/native.js`. Declaring the linux variants of
# the root manifest is what forces them into the lockfile for both build
# targets: x64 for CI, arm64 for a Docker Desktop build.
#
# `tsconfig.base.json` is here because every workspace tsconfig extends
# `../../tsconfig.base.json`. It is a root file, so it does not arrive with
# `COPY apps` or `COPY packages`, and without it the first renderer build dies
# in 8 ms with `failed to resolve "extends":"../../tsconfig.base.json"`.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY docs/package.json docs/
COPY tools ./tools

# The registry is a build argument rather than a literal because reaching
# registry.npmjs.org is not a given: on a network that truncates those
# responses, `npm ci` dies with EINTEGRITY (a 0-byte body fails the lockfile's
# integrity check) or TAR_BAD_ARCHIVE, and it dies partway through npm's
# parallel fetch, so the failing package name differs run to run. CI keeps the
# default; a build on such a network passes its mirror:
#   docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ .
# npm rewrites the lockfile's `resolved` hosts to the configured registry
# (replace-registry-host defaults to doing this for the npm registry), so the
# committed lockfile stays canonical and this does not fork it. Do NOT bake a
# ~/.npmrc in here instead: a developer's .npmrc is not only network config, it
# commonly carries registry auth tokens.
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts \
      --registry="$NPM_REGISTRY" \
      --fetch-retries=5 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000 \
      --no-audit --no-fund

# Renderer bundles for all seven apps, then the server bundle. The server
# bundle also builds the host SDK and stages it at `dist/static/sdk/`, so that
# directory is produced by this step rather than by a manual SDK build that no
# image build ever ran.
RUN npm run build:web

# Assemble exactly what the runtime needs into /out. Copying from a staging
# directory rather than from the repo keeps source, node_modules and any
# stale `out/` from the build host out of the runtime image — a leftover
# renderer on the host must never be able to stand in for a broken build.
RUN mkdir -p /out/apps && \
    for app in docs sheets slides pdf markdown html shell; do \
      mkdir -p "/out/apps/$app/out" && \
      cp -R "apps/$app/out/renderer" "/out/apps/$app/out/renderer"; \
    done && \
    mkdir -p /out/apps/shell/build && \
    cp apps/shell/build/icon.png /out/apps/shell/build/icon.png && \
    cp -R apps/web-server/dist /out/dist

# ── Stage 1b: xlsx sidecar ──
# /sheets 的 xlsx 解析/保存走 Rust 子进程 xlsx-sidecar：缺它时 workbook:open-path
# 返回 422「xlsx-sidecar binary not found」，编辑器里是空表。musl 静态二进制在
# glibc（bookworm）运行时里也能直接跑，所以阶段用 alpine 不影响运行时基底。
FROM rust:1-alpine AS xlsx-sidecar
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY apps/sheets/native/xlsx-engine/Cargo.toml apps/sheets/native/xlsx-engine/Cargo.lock ./
COPY apps/sheets/native/xlsx-engine/src ./src
RUN cargo build --release --locked

# ── Stage 2: runtime ──
FROM node:22.12-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="GenOffice Web Server"
LABEL org.opencontainers.image.description="Standalone web server for the GenOffice AI office suite."
LABEL org.opencontainers.image.source="https://github.com/genspark-ai/genoffice"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Run as the unprivileged `node` user that the base image provides.
WORKDIR /app

COPY --from=builder /out/dist/bundle/ ./bundle/
COPY --from=builder /out/dist/static/ ./dist/static/
# `apps/shell/build/icon.png` is served as /favicon.ico, which is why the shell
# app's build assets travel with the renderer bundles.
COPY --from=builder /out/apps/ ./apps/
# sheets 的原生 sidecar；sidecar.ts 无 XLSX_SIDECAR_PATH 时按源码树深度推导会落空，
# 所以和 WEB_STATIC_ROOT 一样在下面钉死。
COPY --from=xlsx-sidecar /src/target/release/xlsx-sidecar ./bin/xlsx-sidecar
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Persistent volume for FILES_DIR + recents + webhooks.json. Owned by `node`:
# the process drops privileges before the entrypoint runs, and a fresh Docker
# volume inherits this directory's ownership.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# WEB_STATIC_ROOT / WEB_SDK_BUNDLE_DIR are pinned because the path ladder in
# src/common/paths.ts is wrong inside this layout. `paths.ts` derives ROOT from
# the first ancestor containing an `apps` directory; here that is /app, so the
# derived locations are /app/apps (correct, by luck of the layout) and
# /app/apps/web-server/dist/static/sdk (wrong — the SDK bytes are at
# /app/dist/static/sdk). A container could therefore hold every file and still
# answer 404. Pin both, and the startup check verifies they resolve.
ENV PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    FILES_DIR=/data/files \
    NODE_ENV=production \
    WEB_STATIC_ROOT=/app/apps \
    WEB_SDK_BUNDLE_DIR=/app/dist/static/sdk \
    XLSX_SIDECAR_PATH=/app/bin/xlsx-sidecar

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
