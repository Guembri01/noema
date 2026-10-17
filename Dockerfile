# syntax=docker/dockerfile:1.7
# =============================================================================
# Noema — production container image.
#
# This is a *standalone* Next.js build, staged by the project's own packager
# (`scripts/desktop/prepare.mjs`). Reusing that packager is deliberate: the
# desktop app already proves the payload shape (standalone server + static
# assets + Prisma CLI + migrations + the boot wrapper), so the container does
# not grow a second, subtly different copy of that logic.
#
# The boot wrapper is what makes the image deployable behind a reverse proxy:
# it recomputes the Server Action origin allowlist from APP_ORIGINS at *run*
# time instead of freezing the build machine's interfaces into the bundle.
#
# Stages:
#   deps    -> full dependency tree (npm ci, which runs `prisma generate`)
#   builder -> `next build` with NOEMA_STANDALONE=1, then stage the payload
#   runner  -> non-root, production-only payload + healthcheck
#
# Secrets: .env is excluded by .dockerignore and never enters a layer. The
# build-time values below are fake; real values are injected at run time.
# =============================================================================

# Pinned by digest so a rebuilt tag cannot silently change the runtime. The
# digest is the multi-arch index (linux/amd64 + linux/arm64).
# Renovate/Dependabot can bump this line without changing anything else.
FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# libc6-compat is required by Next's native dependencies; OpenSSL is what
# Prisma's query engine links against on musl.
RUN apk add --no-cache libc6-compat openssl

# --- Stage 1: dependencies ---------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
# package.json's `postinstall` runs `prisma generate`, so the schema must exist
# before `npm ci`. DATABASE_URL is a build-time dummy: generate only parses the
# schema and never connects.
COPY prisma/schema.prisma ./prisma/
RUN --mount=type=cache,target=/root/.npm \
    DATABASE_URL="postgresql://noema:build-dummy@127.0.0.1:5432/noema?schema=public" \
    npm ci

# --- Stage 2: builder --------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Standalone output is opt-in (next.config.ts). The site build still defaults
# to `next start`; only the container/desktop payloads switch this on.
ENV NOEMA_STANDALONE=1
# `prisma generate` needs DATABASE_URL for schema env resolution, and
# `next build` prerenders server modules that read AUTH_SECRET at module scope.
# Both values are fake; .env is dockerignored.
RUN DATABASE_URL="postgresql://noema:build-dummy@127.0.0.1:5432/noema?schema=public" \
    AUTH_SECRET="b74-build-time-dummy-secret-not-a-real-key" \
    npm run build
# Reuse the desktop packager to copy .next/static + public/ + Prisma CLI +
# migrations into .next/standalone, write start.cjs, strip any .env/runtime
# state, and validate the payload. It does not rebuild (NOEMA_SKIP_BUILD=1).
RUN DATABASE_URL="postgresql://noema:build-dummy@127.0.0.1:5432/noema?schema=public" \
    AUTH_SECRET="b74-build-time-dummy-secret-not-a-real-key" \
    NOEMA_SKIP_BUILD=1 node scripts/desktop/prepare.mjs

# --- Stage 3: runner (non-root, no build tooling) ----------------------------
FROM base AS runner
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG BUILD_DATE=1970-01-01T00:00:00Z
LABEL org.opencontainers.image.title="Noema" \
      org.opencontainers.image.description="Open-source, self-hosted workspace for notes, docs and databases." \
      org.opencontainers.image.url="https://github.com/Guembri01/noema" \
      org.opencontainers.image.source="https://github.com/Guembri01/noema" \
      org.opencontainers.image.documentation="https://github.com/Guembri01/noema/blob/main/docs/DOCKER.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NOEMA_DATA_DIR=/data \
    STORAGE_DIR=/data/uploads \
    SESSION_STORE_PATH=/data/sessions.json \
    BACKUP_DIR=/data/backups \
    HOME=/data

# The package manager is build-only. Deleting it here removes its bundled
# dependency tree — and the vulnerability surface that comes with it — from the
# runtime image. Nothing at run time shells out to npm: the boot wrapper invokes
# the bundled Prisma CLI directly with `node`.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Fixed UID/GID makes volume permissions predictable on the host. The base
# image already ships a `node` user; a dedicated user keeps the old image's
# UID out of any bind-mounted data.
RUN addgroup -S -g 10001 nextjs \
 && adduser -S -D -H -u 10001 -G nextjs -s /sbin/nologin -h /data nextjs

WORKDIR /app
# The payload is self-contained: server.js, .next/static, public/, prisma/,
# the traced node_modules, the Prisma CLI closure, and start.cjs.
COPY --from=builder --chown=nextjs:nextjs /app/src-tauri/server ./
# /data is the only writable state: uploads, sessions, backups and the
# per-install auth secret fallback. .next/cache is writable because Next's
# image optimizer writes there and the compose file runs with a read-only root.
RUN mkdir -p /data/uploads /data/backups /app/.next/cache \
 && chown -R nextjs:nextjs /data /app/.next

USER nextjs
EXPOSE 3000
STOPSIGNAL SIGTERM

# Liveness/readiness: status code only, no shell tools required.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# start.cjs resolves DATABASE_URL, runs `prisma migrate deploy` (idempotent),
# recomputes the Server Action origins and starts the standalone server in the
# same process. Use `docker compose` (init: true) or `docker run --init`.
CMD ["node", "start.cjs"]
