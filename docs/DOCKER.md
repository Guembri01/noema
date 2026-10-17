# Docker

Noema ships as a prebuilt multi-arch container image:

```
ghcr.io/guembri01/noema
```

The image is a standalone Next.js build (no dev tooling, no source tree), runs
as a non-root user, carries a healthcheck, and runs `prisma migrate deploy` on
start-up. It is published by [`.github/workflows/site.yml`](../.github/workflows/site.yml)
on every push to `main` and on every `v*` tag.

That workflow has two image jobs, and the split is a security boundary. The
`image` job is the pull-request path: it builds the pull request's own image
for `linux/amd64`, loads it, scans it and smoke-tests it, with `contents: read`
and no other scope. The `publish` job is the only one that may push to GHCR and
the only one that may mint the OIDC token cosign signs with; its gate names the
events that may publish (`push` and `workflow_dispatch`), so no pull-request
event — not even `pull_request_target` — can reach it. The gate
`npm run check:workflow-permissions` keeps that shape.

## Pull and run

The fastest path is the compose file in the repository root: it starts
Postgres, wires the in-network `DATABASE_URL`, and mounts the app's writable
state as a named volume.

```bash
cp .env.example .env          # then set a real AUTH_SECRET
docker compose --profile app pull app   # fetch the published image
docker compose --profile app up -d
# http://localhost:3202
```

`docker compose up` on its own still starts **only** Postgres: the app service
is profile-gated so the development loop is unchanged. Add `--build` to compile
the image from the current checkout instead:

```bash
docker compose --profile app up -d --build
```

### Without compose

```bash
docker network create noema

docker run -d --name noema-db --network noema \
  -e POSTGRES_USER=noema -e POSTGRES_PASSWORD=noema -e POSTGRES_DB=noema \
  -v noema-db:/var/lib/postgresql/data \
  postgres:16-alpine

docker run -d --name noema --network noema \
  --init -p 3000:3000 \
  -e DATABASE_URL='postgresql://noema:noema@noema-db:5432/noema?schema=public' \
  -e AUTH_SECRET=$(openssl rand -hex 32) \
  -e APP_ORIGINS='http://localhost:3000' \
  -v noema-data:/data \
  ghcr.io/guembri01/noema:latest
```

Open <http://localhost:3000>. The first boot creates the schema; the workspace
is empty until you sign up.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | PostgreSQL connection string. |
| `AUTH_SECRET` | recommended | generated into `/data` | Session-cookie signing key. Set it explicitly on a server so a container rebuild does not sign everyone out. |
| `APP_ORIGINS` | behind a proxy | — | Comma-separated `host:port` values the browser uses. The boot wrapper folds these into the Server Action origin allowlist at **run** time. |
| `TRUSTED_PROXY_HOPS` | behind a proxy | `0` | Number of trusted reverse-proxy hops. `0` ignores `X-Forwarded-For`/`X-Real-IP`. The Edge middleware reads it at **build** time, so pass it as a build arg as well. |
| `HSTS_MAX_AGE` | no | `31536000` | The `Strict-Transport-Security` max-age in **seconds** (`31536000` = one year). `0` = no HSTS header. The header list is written into the build, so pass it as a build arg as well. |
| `PORT` | no | `3000` | Listen port. |
| `HOSTNAME` | no | `0.0.0.0` | Listen address. |
| `NOEMA_SKIP_MIGRATE` | no | — | Set to `1` to skip `prisma migrate deploy` (use with an external migration job). |
| `NOEMA_NO_EMBEDDED_DB` | no | — | Set to `1` to disable the embedded-Postgres fallback; with `DATABASE_URL` set it is never used. |
| `STORAGE_DIR` | no | `/data/uploads` | Uploaded files. |
| `SESSION_STORE_PATH` | no | `/data/sessions.json` | Session store. |
| `BACKUP_DIR` | no | `/data/backups` | Backup output directory. |

AI, SSO, SMTP and the other optional integrations read the same variables as a
source checkout — see [`.env.example`](../.env.example) and
[`OPERATIONS.md`](./OPERATIONS.md).

### State

Mount a volume at `/data`. It holds uploads, the session store, backups, and —
when `AUTH_SECRET` is not set — the generated signing secret. Losing it loses
the files and signs everyone out.

The compose service runs with a read-only root filesystem, `no-new-privileges`
and all capabilities dropped. `/tmp` and `/app/.next/cache` are `tmpfs`;
Next's image optimizer needs the latter to be writable.

### Reverse proxy

Terminate TLS at the proxy and forward `Host` unchanged, then set:

```bash
APP_ORIGINS="https://noema.example.com"
```

Without it, a Server Action sent from the public hostname can be rejected as a
cross-origin request and the UI silently stops saving. `localhost:3000`,
`localhost:3200`, `127.0.0.1` and `[::1]` are always allowed.

If the app sits behind a reverse proxy, also set `TRUSTED_PROXY_HOPS` to the
number of proxies between the internet and the container (`1` for a single
nginx/Caddy). The rate limits and the admin IP allowlist use it to pick the
real client address; with `0` the forwarding headers are ignored and every
client shares one `scope:local` bucket. Because the Edge middleware reads the
value at **build** time, pass it both as a build arg and as a runtime variable:

```bash
docker build --build-arg TRUSTED_PROXY_HOPS=1 -t noema:local .
docker run --rm -p 3000:3000 -e TRUSTED_PROXY_HOPS=1 ... noema:local
```

With compose, put `TRUSTED_PROXY_HOPS=1` in `.env`; the compose file passes it
to the build and to the running container.

### HTTPS and HSTS

The container speaks plain HTTP — TLS is terminated at the proxy in front of
it. The browser sees HTTPS, and the app tells it to pin HTTPS: every response
carries `Strict-Transport-Security: max-age=31536000` (one year). A browser
ignores that header when it arrives over plain HTTP, so an installation
without TLS is not affected by it.

`HSTS_MAX_AGE=0` is the way out for an installation that is deliberately
served over plain HTTP: no `Strict-Transport-Security` header at all.
`HSTS_MAX_AGE=<seconds>` sets the max-age (the two-year cap a browser honours
is `63072000`). The header list is written into the build, so the value is a
build arg:

```bash
docker build --build-arg HSTS_MAX_AGE=0 -t noema:local .
```

With compose, put `HSTS_MAX_AGE=0` in `.env`; the compose file passes it to
the build. `HSTS_INCLUDE_SUBDOMAINS=1` additionally binds every subdomain of
the host to HTTPS — off by default, because it breaks a sibling that is still
HTTP-only.

### Migrations

`start.cjs` runs `prisma migrate deploy` before the server starts. That is
idempotent and is the right default for a single instance. For a rolling
deployment, run migrations once and set `NOEMA_SKIP_MIGRATE=1` on the replicas:

```bash
docker run --rm --network noema \
  -e DATABASE_URL='postgresql://noema:noema@noema-db:5432/noema?schema=public' \
  ghcr.io/guembri01/noema:latest \
  node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
```

If the database already has tables but no migration history, the boot wrapper
falls back to `prisma db push --skip-generate` (additive only; it refuses
destructive changes).

## Tags

| Tag | Moves | Use |
| --- | --- | --- |
| `latest` | every `v*` tag and `main` | Default. |
| `edge` | every push to `main` | Newest unreleased code. |
| `1.4.2`, `1.4`, `1` | never | Reproducible releases. |
| `sha-<short>` | never | Exact commit. |
| `pr-<n>` | never | Pull-request builds (loaded locally in CI, not pushed). |

Pin a digest for production:

```bash
docker pull ghcr.io/guembri01/noema@sha256:…
```

## Verify an image

Images are signed with [cosign](https://github.com/sigstore/cosign) using
GitHub's OIDC identity (no long-lived key), and carry SBOM and SLSA provenance
attestations.

```bash
cosign verify ghcr.io/guembri01/noema:latest \
  --certificate-identity-regexp '^https://github.com/Guembri01/noema/.github/workflows/site.yml@refs/.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify-attestation --type spdxjson \
  ghcr.io/guembri01/noema:latest \
  --certificate-identity-regexp '^https://github.com/Guembri01/noema/.github/workflows/site.yml@refs/.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

`docker buildx imagetools inspect ghcr.io/guembri01/noema:latest` shows the
attached manifests.

## Build locally

```bash
docker build -t noema:local .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://noema:noema@host.docker.internal:5432/noema?schema=public' \
  -e AUTH_SECRET=$(openssl rand -hex 32) \
  noema:local
```

The build is multi-stage and pins the Node base image by digest. The `.env`
file is excluded from the build context by `.dockerignore` and is never copied
into a layer; only the fake build-time values inside the Dockerfile are
present.

## Publishing the package (one-time)

The workflow pushes to the GitHub Container Registry with the repository's
`GITHUB_TOKEN`, so no extra secret is needed. New packages are **private** by
default even on a public repository. To make the image publicly pullable, open
**Packages → noema → Package settings → Change visibility → Public** once after
the first successful run.
