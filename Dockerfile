#
# Multi-stage build for the standalone GenOffice web-server.
#
#   1. builder   — full dev toolchain (Node 22, pnpm) compiles the bundle.
#   2. runtime   — minimal Node 22 base; the bundle + a startup script.
#
# Build:    docker build -t genoffice/web:latest .
# Run:      docker run -p 8080:8080 genoffice/web:latest

# ── Stage 1: builder ──
FROM node:22.12-bookworm-slim AS builder

# pnpm via corepack (ships with Node 22)
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /repo

# Copy lockfile + manifests first so dependency install is cacheable.
COPY package.json pnpm-lock.yaml ./
COPY apps/web-server/package.json apps/web-server/
COPY packages ./packages
COPY apps ./apps

# Install all workspace deps.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# Bundle the web-server. The bundle script also runs tsc + esbuild; we
# don't run the test gate here because that lives in CI's `test` job.
RUN pnpm --filter @genoffice/web-server bundle

# ── Stage 2: runtime ──
FROM node:22.12-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="GenOffice Web Server"
LABEL org.opencontainers.image.description="Standalone web server for the GenOffice AI office suite."
LABEL org.opencontainers.image.source="https://github.com/genspark-ai/genoffice"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Run as the unprivileged `node` user that the base image provides.
WORKDIR /app

# Copy just the bundle + a small startup wrapper.
COPY --from=builder /repo/apps/web-server/dist/bundle/ ./bundle/
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Persistent volume for FILES_DIR + recents + webhooks.json.
RUN mkdir -p /data
VOLUME ["/data"]

# Default ports.
ENV PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    FILES_DIR=/data/files \
    NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
