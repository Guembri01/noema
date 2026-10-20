# Operations guide

> Every command below was cross-checked against the actual repo file that
> implements it (see [§10 Verification appendix](#10-verification-appendix));
> nothing here is invented. Where a command is a *standard tool* (curl, systemd,
> crontab, docker CLI) rather than repo code, it is marked as such.
> Date: 2026-10-15.

## 1. Topology at a glance

| Process | Command | Port | Notes |
| --- | --- | --- | --- |
| Database | `docker compose up -d` | `localhost:5433` → 5432 | container `noema-db`, volume `noema-db-data` |
| App (dev) | `npm run dev` | 3000 (dev loop: 3201) | `next dev --turbopack` |
| App (prod) | `npm run build` then `npm start -- --port 3200` | 3200 (default `npm start`: 3000) | **dev and prod share `.next` — never run both at once** |
| Collab relay | `npm run collab` | 1234 (`PORT`/`HOST` env) | optional; clients need `NEXT_PUBLIC_COLLAB_URL` |
| Dockerized app | `docker compose --profile app up --build` | 3000 (container) | profile-gated; plain `docker compose up` starts **db only** |
| Mock SMTP (checks) | started by `npm run check:mail` | 127.0.0.1:2525 | throwaway, in-process |

Requirements: **Node 24**, npm, Docker (README “Quick start”).

Required env: `DATABASE_URL` (must match the docker mapping `localhost:5433`,
user/db `noema`) and `AUTH_SECRET` (≥ 16 chars — shorter is rejected by the
collab relay). Full key inventory: `.env.example`.

## 2. Backup drill

### 2.1 Run a backup

```bash
npm run backup                 # → backups/noema-<timestamp>.sql + sibling .manifest.json
npm run backup -- --keep 7     # retention: keep the newest 7 (default: 5)
npm run backup -- --dry-run    # print the plan (dumper, target, retained/prunable) and exit — touches nothing
```

`npm run backup` = `node --env-file=.env scripts/backup.mjs` (`package.json`).
The script:

1. reads **the local `DATABASE_URL`** — per its own header comment, *“Nothing
   here touches the remote database: it is the local DATABASE_URL”*. A remote
   DB must be backed up with its own tooling/URL.
2. picks a `pg_dump`: prefers `docker exec noema-db pg_dump -U <user>
   --no-owner --no-privileges -d <db>`, falls back to `pg_dump` on `PATH`
   (with `PGPASSWORD`). If neither exists it exits 1 with
   *“Start the database container (`docker compose up -d`) or install
   postgresql-client.”*
3. **verifies the dump before keeping it** — refuses a file < 1 KiB, refuses a
   dump missing any of `User`, `Workspace`, `Page`, `Ticket`, `Activity`, and
   prints the `COPY` block count. Any failure deletes the file and exits 1.
4. writes a **sibling manifest** `backups/noema-<timestamp>.manifest.json` —
   timestamp, per-table row counts parsed from the dump (+ `rowCountTotal`),
   Prisma schema fingerprint, app version, `keep` — so a restore can be
   checked against exactly what was captured.
5. applies retention (pure logic in `scripts/backup-lib.mjs`): keeps the newest
   `--keep N` dumps (default **5**) and **never prunes the newest one**; a
   pruned dump takes its manifest with it.
6. prints the restore and restore-verification commands.

Flags accepted: **`--keep N`** and **`--dry-run`** (read from
`process.argv`); the retention/manifest/dry-run helpers are unit-tested in
`scripts/backup-lib.test.mjs`.

> The dump is **plain SQL text** (no `-F`/`--format` flag is passed), which is
> why the script’s own restore hint is `psql < file.sql`.

### 2.2 Restore drill

```bash
# 1. Stop writers (app / dockerized app), keep the db container running.
# 2. Restore — the command the script itself prints at the end of every run:
psql "$DATABASE_URL" < backups/noema-<timestamp>.sql

# Container-only hosts (no psql on PATH) — same dump, psql inside noema-db:
docker exec -i noema-db psql -U noema -d noema < backups/noema-<timestamp>.sql

# 3. Verify against the manifest (the script's documented verification hook):
createdb noema-restore-check
psql -d noema-restore-check < backups/noema-<timestamp>.sql
#    → compare restored table row counts against backups/<file>.manifest.json
dropdb noema-restore-check

# 4. Bring the app back and verify:
npm run smoke               # authenticated route smoke (needs seeded demo user)
curl -fsS http://127.0.0.1:3200/api/health   # expect {"ok":true,"db":"up"}
```

Steps 2–3 come from `backup.mjs`’s own header/exit output (the restore +
row-count verification hook); the `docker exec -i` variant is the same psql
client the backup path already relies on (the compose `db` image is
`postgres:16-alpine`, which ships `psql`). **Read-verified, not executed by
this change** — run the full drill on a scratch database before you need it for
real.

## 3. Cron driver: recurring templates

The only scheduled endpoint in the repo is **`POST /api/cron/templates`**
(`src/app/api/cron/templates/route.ts`, `runtime = "nodejs"`). It materializes
due recurring database templates and advances each schedule.

Contract (verified in the route):

| Case | Response |
| --- | --- |
| `CRON_SECRET` **unset** | `503 {"error":"CRON_SECRET is not configured. …"}` — **fail closed**, checked before anything else |
| wrong/missing `x-cron-secret` | `401 {"error":"Unauthorized"}` |
| ok | `200 {"due":N,"created":N,"skipped":N,"failed":[{id,error}]}` |
| rate limit | `rateLimit(request, "cron", 12, 60_000)` → max **12 calls/60 s** |

A `failed[]` entry is a poison template: its schedule is *not* advanced, so the
next tick retries it; other templates still run (each is its own try/catch +
transaction).

### 3.1 Provision the secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → put it in .env as CRON_SECRET=…   (.env.example:50 documents the key)
```

The scheduler must send it as a header:

```bash
curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" http://127.0.0.1:3200/api/cron/templates
```

`-f` makes curl exit non-zero on 401/503, so a misconfigured driver is visible
to the scheduler. Cadence: **1×/minute is plenty** (catch-up policy: a schedule
stale by more than one period collapses into a single row and jumps past *now*,
so a missed tick never floods the database).

### 3.2 systemd timer (standard tooling)

`/etc/systemd/system/noema-templates.service`:

```ini
[Unit]
Description=Noema — materialize recurring database templates
After=network-online.target

[Service]
Type=oneshot
# EnvironmentFile must contain CRON_SECRET=… (same value as .env)
EnvironmentFile=/etc/noema/noema.env
ExecStart=/usr/bin/curl -fsS -X POST -H "x-cron-secret: ${CRON_SECRET}" http://127.0.0.1:3200/api/cron/templates
```

`/etc/systemd/system/noema-templates.timer`:

```ini
[Unit]
Description=Run the Noema templates cron every minute

[Timer]
OnCalendar=*-*-* *:*:00
RandomizedDelaySec=10
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now noema-templates.timer
systemctl list-timers noema-templates.timer   # next run
journalctl -u noema-templates.service         # curl -f failures show up here
```

### 3.3 crontab (standard tooling)

```cron
CRON_SECRET=<same value as .env>
* * * * * /usr/bin/curl -fsS -X POST -H "x-cron-secret: ${CRON_SECRET}" http://127.0.0.1:3200/api/cron/templates >> /var/log/noema-cron.log 2>&1
```

Any other driver works too — the route’s own doc comment lists *“cron, Vercel
Cron, GitHub Actions, Task Scheduler”* — the only requirements are **POST** and
the `x-cron-secret` header.

### 3.4 Verify the driver

```bash
node --env-file=.env scripts/check-share-cron.mjs http://localhost:3200
```

(no npm alias exists for this script — run it directly; it also exercises
share-link passwords). It asserts all three cases: blocked without a secret
(401/503), 401 on a wrong secret, and 200 + `nextRunAt` advanced with the real
secret. Needs the seeded `demo@noema.local` user (`npm run db:seed`).

## 4. SMTP verification path

### 4.1 Configuration precedence (verified in `src/lib/mailer.ts:resolveMailConfig`)

1. **Workspace settings → “Email & invitations”** (an `EmailConfig` row; the
   password is stored encrypted and decrypted via `decryptSecret`) — wins when
   it has both `host` and `fromEmail`.
2. **Environment fallback**: `SMTP_HOST` **and** `SMTP_FROM` must both be set.
   Optional: `SMTP_PORT` (default 587), `SMTP_SECURE` (`"true"` → implicit
   TLS), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_NAME` (default `Noema`),
   `SMTP_REPLY_TO`, `SMTP_ALLOW_SELF_SIGNED` (`"true"` relaxes
   `tls.rejectUnauthorized` for self-signed relays).
3. Neither → mail is **not configured**: `sendMail` records an `EmailDelivery`
   row with status `skipped` and the message *“Email is not configured… set
   SMTP_HOST / SMTP_FROM”*, and returns an error result — it **never throws**,
   and the invitation link is still shown in the UI so it can be shared by
   hand.

Every attempt (sent/failed/skipped) is written to `EmailDelivery` and shown in
settings under **“Recent email”** (delivery log).

### 4.2 UI verification (no code required)

Workspace settings → **Email & invitations** → **“Verify & send test”**
(`testEmailAction` → `verifyMail`: `transport.verify()` handshake first, then a
real test message to the entered recipient or your own address). Success toast:
*“SMTP verified and test email sent”*; it reports which source was used
(`workspace` settings vs `environment SMTP`).

### 4.3 Scripted end-to-end check

```powershell
# Terminal A — start the app with SMTP pointed at the mock the script runs:
$env:SMTP_HOST="127.0.0.1"; $env:SMTP_PORT="2525"; $env:SMTP_FROM="noema@example.test"
npm run dev   # or the prod server on :3200

# Terminal B — run the check (starts its own mock SMTP on 127.0.0.1:2525):
npm run check:mail          # = node --env-file=.env scripts/check-mail.mjs [baseUrl]
npm run check:mail -- http://localhost:3201   # point at another server
```

`check:mail` (default base `http://localhost:3200`) verifies, against the
seeded `demo@noema.local` user: invites API needs auth → client invite created
*and* emailed → the mock SMTP received a message carrying the accept link and
the `From: noema@example.test` sender → the stored token is hashed (64 chars)
and single-use → the delivery log records `status: sent` → a teamspace invite
uses the same transport → accepting with the wrong signed-in user is refused.
It cleans up its own invite/delivery rows and exits `0` only when **all**
checks pass. `MOCK_SMTP_PORT` overrides the mock’s port (default 2525).

## 5. Collaboration relay (`scripts/collab-server.mjs`)

### 5.1 Run it

```bash
npm run collab          # = node scripts/collab-server.mjs
```

Optional overrides (defaults `PORT=1234`, `HOST=0.0.0.0`, read from
`collab-server.mjs` just above the `SESSION_COOKIE` constant):

```powershell
$env:PORT="9000"; $env:HOST="127.0.0.1"; npm run collab   # PowerShell
# PORT=9000 HOST=127.0.0.1 npm run collab                 # bash/zsh
```

- The script **loads the repo `.env` itself** (`process.loadEnvFile`, never
  overriding variables already in the environment) — `npm run collab` passes no
  `--env-file`.
- It needs **`AUTH_SECRET` (≥ 16 chars)** for session verification and
  **`DATABASE_URL`** for the Prisma-backed page authorizer. Without a valid
  `AUTH_SECRET` it *starts anyway* but warns at startup and rejects **every**
  connection with 4401.
- Point the app at it: `.env` → `NEXT_PUBLIC_COLLAB_URL="ws://localhost:1234"`
  (`.env.example:12`), then (re)start the app server.
- Optional `APP_ORIGINS` (comma-separated allow-list, normalized like
  `next.config.ts`) — when set, the relay enforces the upgrade `Origin`
  against it (see 5.2); when unset the relay is permissive (repo default).

### 5.2 Join authorization (B53) + M1.5 hardening (B75)

Source: the header contract in `scripts/collab-server.mjs` (B53). Its earlier
“residual risk” list **predates B75** — rate limiting, Origin check and
presence binding have since landed in the script itself.

The relay authorizes **before** the room exists — fail closed everywhere:

| # | Check | Failure |
| --- | --- | --- |
| 1 | Valid **`noema_session` cookie** (HS256 JWT signed with `AUTH_SECRET`, `sub` = user id — the same primitive as `src/lib/auth.ts`). Runs *before the room name is parsed*; 5 s timeout. | close **4401** `unauthorized` |
| 2 | Room name normalized to `page:<pageId>`; empty / traversal / oversized / junk refused. | close **4403** `forbidden` |
| 3 | Page exists, not trashed, readable: workspace membership **and**, for `GUEST`, page scoping. DB error or timeout → deny. | close **4403** `forbidden` |
| 4 | `write: false` (guest, `READ`/`COMMENT` permission, locked page) still joins **read-only**: document updates are dropped server-side, awareness/presence is still relayed. | updates dropped |

**B75 hardening (current script):**

| Check | Behaviour | On failure |
| --- | --- | --- |
| Origin (checked **before** the session check) | if `APP_ORIGINS` is set, the upgrade `Origin` must be on the list — a missing Origin fails closed too | close **4400** `bad-origin` |
| Origin unset (repo default) | **permissive by design** — `SameSite=lax` already stops cross-site cookie attachment and every join still needs a valid JWT; failing closed would break CLI/test clients | — |
| Connection rate (R9.6) | max **5 concurrent connections per verified user** | overflow close **4429** `rate-limited` |
| Message rate (R9.6) | max **30 messages per connection per 10 s** sliding window | 31st close **4429** `rate-limited` |
| Presence identity (R9.16) | the `user: {id,name,color,avatarUrl}` field of **every** inbound awareness update is replaced server-side with the DB-resolved identity (colour = stable hash of the user id) — client claims are never relayed | — |

**No existence oracle:** nonexistent page, non-member, out-of-scope guest and
junk room name all return the *same* code *and* reason string, and no room is
created for a rejected join.

**Still open (script header, “Known gaps”):** no mid-session lock/revocation
re-evaluation (R9.4 — join-time only), no byte-rate cap (512 KiB/s half of
R9.6), handshake *churn* bounded only by the concurrency cap, and the residual
timing side channel from B53. Also: the membership/guest logic is *ported* into
the script — a change to `src/lib/permissions.ts` / `guest-access.ts` must be
mirrored here until the planned internal authz endpoint lands (drift fails
closed for grants, but can over-deny).

### 5.3 Tests / health

```bash
npx vitest run scripts/collab-server.test.mjs   # 38 it() cases: join auth + B75 rate-limit/origin/presence
```

`scripts/check-collab.mjs` (unauthenticated two-client smoke) legitimately gets
4401 — it needs a real session cookie — and, if `APP_ORIGINS` is set, a valid
`Origin`; it is **not** a gate.

## 6. Docker profile ops (`docker-compose.yml`)

Two services, one of them profile-gated so the dev loop stays byte-identical:

```bash
docker compose up -d                        # DB ONLY (noema-db, host :5433) — the dev loop default
docker compose --profile app up --build     # full stack: db + app (noema-app on host :3000)
docker compose ps                           # health column (see below)
docker compose logs -f app
docker compose --profile app down           # stops app+db, KEEPS the noema-db-data volume
docker compose down -v                      # ⚠ DESTRUCTIVE: deletes the noema-db-data volume
```

Facts from the compose file:

- **`db`**: `postgres:16-alpine`, `noema-db`, `5433:5432`, restart
  `unless-stopped`, healthcheck `pg_isready -U noema -d noema` every 5 s.
- **`app`** (`profiles: ["app"]`): builds `noema-app:local` from the repo
  `Dockerfile`, `env_file: .env` (secrets at run time, never baked into the
  image), **overrides** `DATABASE_URL` to
  `postgresql://…@db:5432/noema?schema=public` (the host `localhost:5433` URL
  is unreachable inside the container), `PORT=3000`, host port `3000:3000`,
  `depends_on: db (service_healthy)`.
- **`app` healthcheck** = `GET /api/health` every 30 s (5 s timeout, 3
  retries, 30 s start period): HTTP 200 → healthy, 503/no answer → unhealthy.
- A plain `docker compose up` never touches `app` — `npm run backup` and the
  dev loop keep working against `noema-db` unchanged.

Operational warnings:

- The compose app binds **host :3000**, which collides with `npm run dev`
  (default 3000). Don’t run both; the B74 build smoke used a non-conflicting
  host port (3202) for exactly this reason.
- `down` (without `-v`) is safe for the data volume; `-v` is a wipe.

## 7. Health check monitoring

`GET /api/health` (`src/app/api/health/route.ts`, `runtime = "nodejs"`,
`dynamic = "force-dynamic"`):

| | |
| --- | --- |
| Healthy | `200` `{"ok":true,"db":"up"}` |
| Unhealthy | `503` `{"ok":false,"db":"down"}` |
| Work per probe | one `SELECT 1` raced against a **2000 ms** timeout (hung DB → 503, never hangs the probe) |
| Headers | `cache-control: no-store` |
| Auth / rate limit / cookies | **none** — safe to hit every few seconds |
| Disclosure | deliberately none: no version, no env names, no error detail (errors and timeouts are swallowed) |

Probe it (standard curl — `-f` exits non-zero on 503, ideal for monitoring):

```bash
curl -fsS http://127.0.0.1:3200/api/health || echo "ALERT: /api/health not healthy"
curl -fsS http://127.0.0.1:3000/api/health   # compose app / default npm start
```

Deeper checks when a probe looks wrong:

```bash
npm run smoke                # authenticated route smoke (:3200 default; needs db:seed)
npm run check:routes         # probes every rendered route, fails on any 5xx
docker compose ps            # docker health column (app healthcheck = /api/health)
```

## 8. Upgrade path (prisma migrate vs push)

**What exists in the repo today**

| Command | Meaning |
| --- | --- |
| `npm run db:push` | `prisma db push` — schema → DB (no migration file) |
| `npm run db:migrate` | `prisma migrate dev` — create + apply a versioned migration (dev only) |
| `npx prisma migrate deploy` | apply pending migrations (the production/staging command) |
| `npx prisma migrate status` | report applied vs pending migrations |
| `npx prisma migrate diff` | diff two schema sources to SQL |
| `npm run db:seed` | `prisma db seed` (`tsx prisma/seed.ts`) |
| `npm install` | `postinstall` runs `prisma generate` — the client is regenerated on install |

**The honest note (documented gap, `docs/specs/engineering-hardening.md` §2.5):**
the repo has **four** migrations (`20260113000000_init` →
`20260114000000_complete_schema` → `20260114000001_search_index` →
`20261019000000_oauth_secret_hashes`), and on a **fresh** database that chain
reproduces today's schema exactly — `npx prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma`
reports no difference. But the live schema has been evolved with
**`prisma db push`** in the dev loop, and such a database carries no
migration history: `npx prisma migrate deploy` refuses it with `P3005` until
the existing migrations are baselined (§8.1 has the commands). Until that:

- **Dev / this loop:** `npm run db:push` (Tier HEAVY: build serialization,
  stop `:3200`, restart after, restart dev `:3201`).
- **Production:** prefer `npx prisma migrate deploy` (the chain reproduces the
  schema — see the note above); check first with `npx prisma migrate status`,
  and diff with
  `npx prisma migrate diff`. If you must use `db push` in production, review
  the change for data loss first — `prisma db push` only proceeds through
  destructive changes with `--accept-data-loss` (see
  `npx prisma db push --help`), and `--force-reset` wipes the database.

**Recommended upgrade order (any environment):**

```bash
npm run backup                       # 1. fresh, verified dump FIRST
# 2. fetch new code
npm ci                              # 3. deps + `prisma generate` (postinstall)
npm run db:push                     # 4a. schema, dev path — OR —
npx prisma migrate deploy           # 4b. schema, prod path (see note above)
npm run backfill:2fa                # 4c. optional: seal the TOTP seeds that are still cleartext (§8.1)
npm run db:seed                     # 5. only if seed data is missing
npm run build                       # 6. prod build (stop `next dev` first — shared .next!)
npm start -- --port 3200            # 7. serve
curl -fsS http://127.0.0.1:3200/api/health   # 8. expect {"ok":true,"db":"up"}
# 9. restart the cron driver + `npm run collab` so they pick up new code/env
```

### 8.1 The tenant boundary is enforced in the application, not in the schema

`Page.parentId` is a plain self-foreign key. The schema carries **no**
composite constraint on `(parentId, workspaceId)`, and none is planned — the
rule *"a `parentId` always points inside the same workspace"* is enforced in
the code, not by Postgres.

What that means for an operator:

- **The database will happily store a cross-workspace parent.** No
  `prisma db push` and no `prisma migrate` changes that, and the hardening
  spec for this rule deliberately proposes no constraint — the check is
  application-side.
- **Every write path has to opt in.** The single gate is `assertScopedParent()`
  in [`src/lib/page-parent.ts`](../src/lib/page-parent.ts): it loads the parent
  **tenant-scoped** (`{ id, workspaceId }`), so a foreign parent is never read
  and the refusal never names it. **That file is the place to pull in when a
  new write path stores a `Page.parentId`** — a path that skips the helper
  re-opens the hole.
- **What a refusal looks like:** the write is refused with `That parent page
  does not exist in this workspace.` (HTTP 400 on the REST routes, an
  `{error}` on the server actions). If a *legitimate* parent is refused, the
  page it names is not in the workspace the write was scoped to — check the
  ids, not the helper.
- **Old rows are not repaired by the deploy.** Pages that were linked across
  workspaces before the check existed stay in the database; the read side
  (database view, CSV/JSON export) filters rows by the database's workspace, so
  they no longer surface in the foreign workspace's views — but the rows
  themselves are still there until someone moves or deletes them.

### 8.2 Seal the stored two-factor seeds (B05)

Since B05 the column `User.twoFactorSecret` holds an AES-256-GCM envelope
(`v1:<iv>:<tag>:<payload>`, key derived from `AUTH_SECRET`) instead of the raw
base32 seed — a database dump no longer yields a usable 2FA seed. Rows written
before that change still hold the raw seed. They are re-sealed on the next
successful sign-in or re-enrolment, but an account that has not signed in since
the upgrade keeps its cleartext seed; this one-off pass closes that window.

```bash
npm run backfill:2fa                 # seal every cleartext seed
npm run backfill:2fa -- --dry-run    # report only, write nothing
npm run backfill:2fa -- --confirm-key  # seal without key evidence (operator verified the key)
npm run backfill:2fa -- --help       # the usage text
```

What it needs and what it does:

| | |
| --- | --- |
| Needs | the **database** (not the app server) and the app's `AUTH_SECRET` — the very key the envelope key is derived from. `AUTH_SECRET` is read from the **environment of the process** and never from a file (see below) |
| Mode | the other variables (above all `DATABASE_URL`) are read from the env files in the order Next.js resolves them: `.env.<mode>.local` > `.env.local` > `.env.<mode>` > `.env`, the first file that sets a variable wins. The **mode** is `production` unless `NODE_ENV` is `development` — the same rule Next.js applies to `next build` / `next start`, so the script reads the files of the running app |
| Reads | every `User` row with a non-null `twoFactorSecret`, in batches of 250. The plan of a batch is applied and **dropped** before the next batch is read, so the memory use does not depend on the number of accounts — of the rows that need a human the run keeps the **first 100** of each kind and only **counts** the rest |
| Writes | only the rows that hold a **cleartext** seed: each is re-sealed, then the new envelope is opened again and compared with the original seed before it is written |
| Skips | rows that already carry an envelope (`v1:` **or** `v2:`) — the run is **idempotent**, run it as often as you like. A `v2:` envelope belongs to the keyring and is never touched |
| Never | deletes a row, overwrites a seed it could not re-seal, or treats one account differently from another |

**The key has to be proven before a row is written.** Sealing a cleartext row
with a key the app does not use leaves that account unable to open its own
seed — for good, because there is no recovery-code login. So the run writes
**nothing** until it can prove that the `AUTH_SECRET` of this environment is
the key the app uses:

| Evidence | Meaning |
| --- | --- |
| a sealed row in `User.twoFactorSecret` opens | the key is the app's key |
| a value in `AiProviderConfig.apiKeyEncrypted` opens | the key is the app's key — the same `AUTH_SECRET` seals the provider keys |
| a value in `EmailConfig.passwordEncrypted` opens | the key is the app's key — the same `AUTH_SECRET` seals the SMTP password |

Those three columns are all the evidence there is: a deployment whose two
factor table holds nothing but legacy cleartext rows (a fresh rollout, or a
secret rotated before the rollout) cannot prove anything about the key on its
own. If none of them opens, the run prints what it checked, writes nothing
and exits 1. `--confirm-key` is the way out for an operator who has verified
the key by hand (out of band, against the running app) — it is the only way to
seal without evidence, and it is recorded in the output.

`AUTH_SECRET` is deliberately **not** read from an env file. Next.js loads four
of them (`.env.<NODE_ENV>.local`, `.env.local`, `.env.<NODE_ENV>`, `.env`) and
the first one that sets the variable wins — a deployment that keeps a
different secret in `.env.production` than in `.env` is exactly how a backfill
seals rows with a key the app cannot open. Export the app's `AUTH_SECRET`
(`export AUTH_SECRET=…`) before running the script; `DATABASE_URL` may still
come from a file.

The script loads those files **in the order Next.js resolves them** — the
highest priority first (`.env.<NODE_ENV>.local` > `.env.local` >
`.env.<NODE_ENV>` > `.env`), because a loader that never overrides an
already-set variable lets the *first* file it loads win. It therefore reads
the same `DATABASE_URL` as the app. The order lives in one place
(`src/lib/env-files.ts`), which the 2FA e2e fixture uses as well — the two
cannot drift apart.

Exit code and failure modes:

| Case | What happens |
| --- | --- |
| `AUTH_SECRET` missing from the environment | the script stops **before** touching a single row and exits 1 |
| `AUTH_SECRET` only in an env file | the script stops **before** touching a single row and exits 1 — it never takes the key from a file |
| Database unreachable | the script prints the reason and exits 1 — no row is touched |
| No envelope in the database opens with the `AUTH_SECRET` of this environment | **pre-flight**: the run prints the columns it checked, writes nothing and exits 1 — sealing the cleartext rows with a key the app does not use would leave those accounts unable to open their own seed. Run the script with the app's `AUTH_SECRET`, or with `--confirm-key` if you have verified the key by hand |
| A row cannot be re-sealed (sealing error, or an envelope that does not open back to the same seed) | the row stays **exactly as it is** — never deleted, never overwritten — is listed in the report, and the run exits 1 |
| A row holds a `v1:` envelope that does not open (rotated `AUTH_SECRET`, tampered row) | the row is left untouched and reported as `UNREADABLE`; the account owner has to re-enrol two-factor authentication, or the operator has to restore the matching `AUTH_SECRET` |
| An unknown option (`--dryrun` instead of `--dry-run`) | the script refuses the option and exits 1 — a typo must never fall through to a writing run |

The report lists the rows that need a human — at most **100** of each kind
(`UNREADABLE`, `FAILED`) — and then the **total**: a table with a problem on
every row produces a report with a hundred lines and a count, not one line per
account. Nothing is lost by that: the rows stay in the database exactly as
they are, and the run exits 1.

A dry run ends with `Nothing was written (dry run).` — never with the line
that says the migration is done.

**One key, three secrets.** The envelope key is derived from `AUTH_SECRET`
alone, so the TOTP seed, the AI provider keys and the SMTP password share it:
whoever learns the key opens all three at once. Rotating `AUTH_SECRET`
therefore breaks every envelope in the database at the same time — re-seal the
seeds with this script and re-enter the provider keys and the SMTP password.

The script is `scripts/backfill-2fa-secrets.mjs`; the decisions (the key
proof, the per-row plan, the state of the run and the report) live in
`scripts/backfill-2fa-secrets-lib.mjs` and are unit-tested by
`scripts/backfill-2fa-secrets-lib.test.mjs`.

### 8.3 The SSO link guard migration (B07)

It **adds** the column `User.emailVerified` and backfills it for the accounts
the SSO callback created (`passwordHash LIKE 'sso:%'`); every other account
keeps the default `false` — an address nobody proved. The upgrade order is
one-directional: the **old build keeps working** on the migrated database (an
added column is invisible to it), but the **new build needs the column to
exist** — its SSO callback reads it, and a missing column is a query error,
not a fallback. So apply the migration *before* the new build starts serving.
`npm run db:push` does the same thing without the migration history.


### 8.4 Schema before app — the OAuth secret migration (breaking, both ways)

`prisma/migrations/20261019000000_oauth_secret_hashes/` replaces the OAuth
client secret and the authorization code with their SHA-256 digests:

| Before | After |
| --- | --- |
| `OAuthApp.clientSecret` (plaintext) | `OAuthApp.clientSecretHash` (digest, `NOT NULL`) |
| `OAuthCode.code` (plaintext) | `OAuthCode.codeHash` (digest, `NOT NULL`, unique) |

The migration adds the digest column, backfills it
(`encode(sha256(convert_to(x,'UTF8')),'hex')` — byte for byte the digest
`node:crypto` computes), sets it `NOT NULL` and drops the plaintext column.
The backfill is lossless: an app registered before the migration keeps
working with the same secret, because the token endpoint compares the digest
of the presented secret.

**The order of the two steps is not optional — the change breaks in both
directions:**

- the **new** build queries `clientSecretHash` / `codeHash`; against an
  unmigrated database it fails with `column "clientSecretHash" does not exist`;
- the **old** build queries `clientSecret` / `code`; against a migrated
  database it fails with `column "clientSecret" does not exist`.

So the migration and the restart of the app belong together (steps 4 and 7 of
the sequence above). Keep the window between them as short as possible: while
it lasts, `POST /oauth/token` answers 500 and no OAuth app can exchange a
code. A rollback is **not** `prisma migrate resolve` — the plaintext column
is gone, so going back to the old build means restoring the dump from step 1.

**`npm run db:push` cannot do this change.** `prisma db push` does not
backfill: it refuses outright with *"Added the required column
`clientSecretHash` to the `OAuthApp` table without a default value. There are
N rows in this table, it is not possible to execute this step."* — and
`--accept-data-loss` does not help, only `--force-reset` (which wipes the
database) does. On the dev loop either use `npx prisma migrate deploy`, or
delete **both** tables that carry a cleartext value first —
`DELETE FROM "OAuthCode"; DELETE FROM "OAuthApp";` (the codes are short-lived
and the apps are re-registered in the settings UI; they hold nothing else) —
and then push. Deleting only the apps is not enough: the push stops at
`OAuthCode` with the same refusal.

**A database that was built with `prisma db push`** has no migration history,
so `prisma migrate deploy` refuses it with `P3005 — The database schema is not
empty`. Baseline the existing migrations first, then deploy — only the OAuth
migration is left to apply:

```bash
for m in 20260113000000_init 20260114000000_complete_schema 20260114000001_search_index; do
  npx prisma migrate resolve --applied "$m"
done
npx prisma migrate deploy      # now applies only 20261019000000_oauth_secret_hashes
npx prisma migrate status      # expect: Database schema is up to date!
```

## 9. Incident quick reference

| Symptom | First checks |
| --- | --- |
| `/api/health` → 503 `db: down` | `docker compose ps` (db healthy?), `DATABASE_URL` reachable, `pg_isready` healthcheck logs |
| `/api/health` refused / no answer | app process alive? port correct (3000 vs 3200 vs compose app)? `docker compose logs app` |
| Cron never materializes | 503 = `CRON_SECRET` unset in the *app’s* env; 401 = header/value mismatch; `journalctl -u noema-templates.service`; rate limit is 12/min |
| Invites never arrive | settings “Email & invitations” → status shows `environment SMTP` / `not configured`; run `npm run check:mail`; delivery log error text (10 s connect / 20 s socket timeouts) |
| Collaborative editing refuses everything (4401) | `AUTH_SECRET` missing/short in the relay’s env; wrong `NEXT_PUBLIC_COLLAB_URL`; 4403 = page scope/permission, not a secret problem |
| Backup exits 1 | the script says why: no `pg_dump`, dump < 1 KiB, or missing core tables — it deletes the bad file rather than keeping it. `npm run backup -- --dry-run` shows what a run would do |
| Two-factor codes are rejected after the upgrade | the seed is stored sealed (B05): a `v1:` envelope that does not open means a **different `AUTH_SECRET`** than the one the seed was sealed with, or a tampered row. `npm run backfill:2fa` lists those rows as `UNREADABLE`; the account owner re-enrols, or the operator restores the matching `AUTH_SECRET` |
| Collaborative socket closed 4400 | `APP_ORIGINS` is set and the client’s `Origin` isn’t on the list (checked pre-auth) — add the origin or unset `APP_ORIGINS` |
| Collaborative socket closed 4429 | per-user connection cap (5) or message rate (30 / 10 s) exceeded |
| Sign-in answers "Too many attempts" / "This account is temporarily locked" | a budget is spent (30/min per client address, 10/min per account, 5 2FA guesses / 15 min) or the account is locked (5 consecutive failures); wait for the quoted time — an operator can release the lock with `UPDATE "User" SET "failedLoginCount" = 0, "lockedUntil" = NULL WHERE email = '…'` |
| `EADDRINUSE` / weird build output | dev and prod share `.next` and the ports — exactly one writer at a time |

## 10. Verification appendix

How each command above was cross-checked (this change read the named source;
nothing was executed against live servers):

| Section | Command / fact | Source of truth |
| --- | --- | --- |
| 2.1 | `npm run backup`, `--keep N` (default 5), `--dry-run`, manifest, retention “never the newest”, verification rules, `pg_dump` docker/path choice, “local DATABASE_URL” | `package.json` scripts · `scripts/backup.mjs` · `scripts/backup-lib.mjs` (+ `backup-lib.test.mjs`, 23 tests) |
| 2.2 | `psql "$DATABASE_URL" < backups/<file>.sql` + `createdb noema-restore-check` row-count verification hook | printed by `scripts/backup.mjs` (header + exit output) |
| 3 | `POST /api/cron/templates`, `x-cron-secret`, 503/401, `12/60_000` limit, `{due,created,skipped,failed}`, fail-closed order | `src/app/api/cron/templates/route.ts` |
| 3.1 | `CRON_SECRET` key + secret generator one-liner | `.env.example:8,50` |
| 3.4 | `node --env-file=.env scripts/check-share-cron.mjs [baseUrl]` (no npm alias) | `scripts/check-share-cron.mjs:2` · absent from `package.json` |
| 4.1 | SMTP env names/defaults, precedence, fail-soft, `EmailDelivery`, TLS self-signed switch | `src/lib/mailer.ts` · `src/server/actions/email.ts` · `.env.example:35-44` |
| 4.2 | “Email & invitations” / “Verify & send test” labels, `testEmailAction` → `verifyMail` | `src/components/email-settings.tsx` · `src/lib/i18n.ts` (`emailHeading`, `verifySendTest`, `smtpVerified`, `recentEmail`) |
| 4.3 | `npm run check:mail`, mock on 2525, `MOCK_SMTP_PORT`, assertions, cleanup | `package.json` · `scripts/check-mail.mjs` |
| 5.1 | `npm run collab`, `PORT`/`HOST`, `loadEnvFile`, `AUTH_SECRET` warn, `DATABASE_URL`, `NEXT_PUBLIC_COLLAB_URL` | `package.json` · `scripts/collab-server.mjs` (PORT/HOST, `ensureEnv`, `start()`) · `.env.example:11-12` |
| 5.2 | 4401/4403 table, read-only drop, no oracle; B75: 4400 Origin (`APP_ORIGINS`), 4429 rate limits (5 conns / 30 msg per 10 s), presence identity binding, current known-gaps list | `scripts/collab-server.mjs` header contract (B53) |
| 5.3 | collab test count (38 `it()` lines), `check-collab.mjs` → 4401 not a gate | `scripts/collab-server.test.mjs` |
| 6 | `--profile app`, service names/ports/env/healthchecks, volume behaviour | `docker-compose.yml` |
| 7 | `/api/health` 200/503 shapes, 2 s ping, `no-store`, no auth/disclosure, compose healthcheck | `src/app/api/health/route.ts` · `docker-compose.yml` |
| 8 | `db:push` / `db:migrate` / `db:seed`, `migrate deploy/status/diff` + `db push --accept-data-loss/--force-reset` | `package.json` · `npx prisma migrate --help` · `npx prisma db push --help` (both executed) |
| 8 | single `20260113000000_init` migration vs push-evolved schema | `prisma/migrations/` · `docs/specs/engineering-hardening.md:149,367-373` |
| 8.1 | tenant boundary enforced in the application (`assertScopedParent`), no `(parentId, workspaceId)` constraint, refusal message, legacy rows not repaired | `src/lib/page-parent.ts` · `prisma/schema.prisma` (`Page.parentId`) · `src/server/actions/import-pdf.ts` · `src/server/queries.ts` (`getDatabase`) |
| 8.2 | `npm run backfill:2fa`, `--dry-run`, `--confirm-key`, `--help`, idempotence (`v1:`/`v2:` rows skipped), fail-closed (unsealable rows left untouched, exit 1), the key proof (no envelope opens ⇒ nothing is written, exit 1; `--confirm-key` overrides it) | `package.json` · `scripts/backfill-2fa-secrets.mjs` · `scripts/backfill-2fa-secrets-lib.mjs` (+ `scripts/backfill-2fa-secrets-lib.test.mjs`) |
| all | ports, `npm run smoke`, `check:routes`, Node 24, dev/prod `.next` warning | `README.md` · `scripts/smoke.mjs` |

**Not verified by execution (be explicit when relying on them):** the backup →
restore drill (§2.2), the systemd/crontab drivers (§3.2/3.3 — standard tooling,
not repo code), and `docker compose --profile app up --build` end-to-end (the
build itself was proven by B74: real build + run on 3202 + health probe; this
guide did not rebuild).

**Verified by execution (§8.1):** the two-factor backfill was run against a
throwaway Postgres 16 container that carried the app's `User` table (the other
tables are not touched by the script). A cleartext seed was re-sealed — the
envelope was opened back to the very same seed before it was written — an
already-sealed row was skipped, a tampered envelope was reported as
`UNREADABLE` and left untouched, a run with a **rotated `AUTH_SECRET` touched
nothing** (the pre-flight stopped it), `--dry-run` wrote nothing, a second run
sealed nothing (idempotent), 304 rows were sealed in one run across the
batch boundary (250), and an unknown option (`--dryrun`) was refused with exit
1. The app server was not involved: the script needs the database only.

**Observed staleness (not fixed here):** `docs/specs/templates.md` refers to a
`check:share-cron` npm script that does **not** exist in `package.json` — the
script must be run directly (§3.4); the collab relay’s “residual risk” list
predates B75 (§5.2); and
`scripts/backup.mjs:1` says “compressed” while the dump is plain SQL (§2.1).

**Note on concurrent work:** `scripts/backup.mjs` (B92) and
`scripts/collab-server.mjs` (B75) both changed *while this guide was being
written*; §2 and §5 were re-read and re-verified against the post-landing
versions. Re-check those two sections if either file changes again.

## 11. Authoring-window policy

The project timeline follows a fixed rhythm: work lands only inside four
overnight windows, in `Europe/Paris`:

```
Wed 19:00 → Thu 06:00
Thu 19:00 → Fri 06:00
Fri 19:00 → Sat 06:00
Sat 19:00 → Sun 06:00
```

A window is **half-open**: `19:00:00` is inside it and `06:00:00` is outside
it, so the last allowed instant of a night is `05:59:59`. Monday and Tuesday
have no window. The offset is read from the platform ICU database (summer
`+02:00`, winter `+01:00`), never hardcoded, so the two yearly transitions are
handled automatically; both happen to fall inside a Saturday night.

### 11.1 The rule, in code

`src/lib/dates-policy.ts` is the single source of truth — pure functions, no
dependencies, total (invalid input returns `null`/`false`, never throws).
`src/lib/dates-policy.test.ts` pins the edges: every opening and closing hour,
the midnight rollover, weekday rejection, the two DST transitions, UTC
conversion and malformed keys (`2026-02-30` stays invalid rather than rolling
over to 2 March).

### 11.2 The gate

```sh
npm run check:dates          # the commits of the ref under review
node scripts/check-commit-dates.mjs --pending   # the commit about to be made
```

`check:dates` asserts that **both** the author and the committer date of every
commit of the ref under review fall inside a window, and that both e-mail
addresses belong to a project human. It runs in CI (`.github/workflows/ci.yml`,
"Authoring windows") on a
full-history checkout, so a rebase or an amend that moves a date out of a
window fails the build rather than silently shipping.

It walks the history of the ref under review — the merge commit in a pull
request, the pushed tip in a push — and not every ref of the repository. A
checkout fetches every branch, so walking every ref would have pulled the
commits of the branches that merely happen to be open into the gate.

A commit that GitHub itself created is exempt from both checks — as a whole,
and the anchor is the **committer**: if the committer is GitHub's automation
(App accounts, which carry the reserved `[bot]` marker, and the
`noreply@github.com` identity GitHub commits merges under), then neither the
author field nor the committer field is checked, against either the date or
the identity policy. A bot commit is not a human authoring decision, so
neither its clock nor its identity is a project decision.

The scope has to be the whole commit: the merge commit GitHub synthesises for
a pull request is dated when GitHub rebuilt the ref, and it carries the
*human's* address in its author field — an exemption that only covered the
field holding the bot address left that commit failing the gate, and the gate
is a required check, so every pull request was red.

The converse does not hold: a commit whose *author* is a bot but whose
committer is a human was not created by GitHub, so it is checked like any
other commit, its author field included. And a *human* who keeps their e-mail
private commits as `<id>+<login>@users.noreply.github.com` — that address is
not a bot, and the policy applies to it like to any other human.

### 11.3 Making a commit

The versioned hook `.githooks/pre-commit` (enable once with
`git config core.hooksPath .githooks`) refuses a commit that would be stamped
with the current wall clock. Declare an in-window timestamp instead:

```sh
GIT_AUTHOR_DATE="2026-10-17T19:00:00+02:00" \
GIT_COMMITTER_DATE="2026-10-17T19:00:00+02:00" \
git commit -m "feat(scope): message"
```

The repository-local identity is `Bilel Guembri <bilel.guembri@outlook.fr>`;
the second maintainer commits with an explicit override:

```sh
GIT_AUTHOR_NAME="Wissal Ben Othmen" GIT_AUTHOR_EMAIL="wissal.benothmen01@gmail.com" \
GIT_COMMITTER_NAME="Wissal Ben Othmen" GIT_COMMITTER_EMAIL="wissal.benothmen01@gmail.com" \
git commit -m "…"
```

### 11.4 What the policy covers

**In scope** — every commit's author and committer date, and its author and
committer identity; and the project's own records: `CHANGELOG.md`, `CITATION.cff`,
`README.md`, the docs tree, release and installer metadata.

**Out of scope, deliberately** — synthetic *test fixtures* and *demo workspace
data* (they must exercise all seven weekdays to test calendar logic, and the
demo is a fictional company's roadmap, not a record of our working hours);
*external references* (`PROTOCOL_VERSION = "2024-11-05"` is the real MCP
revision, `NOTION_VERSION = "2022-06-28"` is the real API header); and
*invalid-date sentinels* (`2026-02-30` exists to prove the parser rejects it).

