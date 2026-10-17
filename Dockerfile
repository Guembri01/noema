# syntax=docker/dockerfile:1
# =============================================================================
# B62 — Noema app image (spec R28.22): deps -> builder -> minimal runner.
#
# NON-STANDALONE on purpose: `output: "standalone"` lives in next.config.ts,
# which B61 owns this phase — follow-up: switch this file to the standalone
# server (copy .next/standalone + standalone node_modules, CMD
# `node server.js`) once B61 has landed and the flag is safe to add.
#
# Secrets: .env is excluded via .dockerignore — it is NEVER baked into any
# layer. At run time it is injected by compose (`env_file: .env`) or
# `docker run --env-file .env`.
# B74: the first REAL `docker build` + `docker run` smoke was executed in this
# batch; the fake build-time dummies below are what the build actually needs
# (see each stage) and contain no real secret material.
# =============================================================================
ARG NODE_VERSION=24

# --- Stage 1: dependencies ---------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
# package.json's `postinstall` runs `prisma generate`, so the schema must
# exist before `npm ci`.
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/
# B74: `postinstall` runs `prisma generate`, which resolves env("DATABASE_URL")
# during schema validation. .env is dockerignored, so provide a FAKE URL —
# nothing connects during install; this only satisfies env resolution.
RUN DATABASE_URL="postgresql://noema:build-dummy@127.0.0.1:5432/noema?schema=public" npm ci

# --- Stage 2: builder -------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
# Dependencies come from the cached `deps` layer; build-time deps
# (typescript, eslint) stay in this stage only.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# B74: build-time dummies, exported for BOTH steps below. `prisma generate`
# needs DATABASE_URL for schema env resolution; `next build` prerenders server
# modules that read AUTH_SECRET at module scope. Both values are FAKE — the
# real secrets live in .env (dockerignored) and are injected at run time.
RUN export DATABASE_URL="postgresql://noema:build-dummy@127.0.0.1:5432/noema?schema=public" \
      AUTH_SECRET="b74-build-time-dummy-secret-not-a-real-key" \
  && npx prisma generate \
  && npm run build \
  && rm -rf .next/cache

# --- Stage 3: runner (non-root, prod deps only) -----------------------------
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node prisma/schema.prisma ./prisma/
# WORKDIR /app was created root-owned by Docker; hand it (and the two files
# above) to `node` so the install below can create ./node_modules there.
RUN chown -R node:node /app
# Prod dependencies only. `postinstall` regenerates the Prisma client for
# this image's platform (linux-musl).
USER node
# B74: same fake DATABASE_URL as the deps stage — `postinstall` regenerates the
# Prisma client here and resolves env("DATABASE_URL") again (validation only).
RUN export DATABASE_URL="postgresql://noema:build-dummy@127.0.0.1:5432/noema?schema=public" \
  && npm ci --omit=dev \
  && npm cache clean --force
# `next start` transpiles next.config.ts at boot and requires the `typescript`
# package to be resolvable — without it Next tries to npm-install inside the
# running container. typescript has zero dependencies, so copying it is enough
# (tsconfig.json is optional: Next falls back to default compiler options).
COPY --chown=node:node --from=builder /app/node_modules/typescript ./node_modules/typescript
COPY --chown=node:node --from=builder /app/next.config.ts ./next.config.ts
COPY --chown=node:node --from=builder /app/public ./public
# `.next/cache` was pruned in the builder stage.
COPY --chown=node:node --from=builder /app/.next ./.next

EXPOSE 3000
# Liveness/readiness per R28.24 — status code only, node fetch needs no tools.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Non-standalone: serve the regular `next start` output.
CMD ["node_modules/.bin/next", "start"]
