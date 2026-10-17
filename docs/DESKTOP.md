# Noema — Desktop (installable app) & Site (hosted) versions

One codebase, two shipped products:

| | **Site version** | **App version** |
|---|---|---|
| What | the hosted web app | the installable desktop app |
| Runtime | Next.js server + Postgres | Tauri 2 (Rust) shell + a bundled Node runtime running the same Next server |
| Database | Postgres | Postgres (same schema) — **embedded (PGlite) and provisioned on first run**, or pointed anywhere via a connection string |
| Build | `npm run site:build` → `next start`, or `docker compose up --build` | `npm run desktop:bundle` → `Noema_x.y.z_x64-setup.exe` (NSIS) + `.msi` |
| Users | many accounts, workspaces, SSO | one local user, no account required |
| Entry | `npm run dev` | `npm run desktop:dev` / `npm run desktop:build` |

Everything under `src/**` — components, engines, database code, AI — is shared.
Only four things differ, and they are resolved in **one module**
(`src/lib/runtime-mode.ts`), so no feature code branches on "is this the app?":

1. where the API lives — `resolveApiBase()` / `apiUrl()`
2. where user data lives — `resolveDataDir()`
3. whether the OS draws the window chrome — `desktopChrome()`
4. which native powers exist — `nativeCapabilities()`

---

## 1. Architecture of the app version

```
┌───────────────────────────────────────────────────────────────┐
│ Noema.exe / Noema.app                      (Rust, tauri 2)    │
│                                                               │
│  window (WebView2 / WKWebView / WebKitGTK)                    │
│    ▲  loads http://127.0.0.1:<port>                           │
│    │  window.__NOEMA_DESKTOP__ = { apiBase, dataDir, … }      │
│    │                                                          │
│  ┌─ shell ────────────────────────────────────────────────┐   │
│  │ sidecar supervisor  (src-tauri/src/sidecar.rs)         │   │
│  │  · keeps this install's port (free if taken)           │   │
│  │  · spawns `noema-node` (bundled runtime) on start.cjs  │   │
│  │  · polls /api/health until it carries our token        │   │
│  │  · streams stdout/stderr → logs/noema.log + UI         │   │
│  │  · restarts with backoff if it dies (500ms…10s)        │   │
│  │  · stops it cleanly on quit                            │   │
│  ├───────────────────────────────────────────────────────┤   │
│  │ native: menus, tray, window state, single instance,    │   │
│  │ dialogs, filesystem, notifications-ready hooks         │   │
│  └───────────────────────────────────────────────────────┘   │
│                          │ spawns                              │
│                          ▼                                     │
│  noema-node.exe  (the Node runtime we built with)              │
│    runs <resources>/server/start.cjs                           │
│      1. `prisma migrate deploy`  (idempotent, every launch)     │
│      2. require('./server.js')   — the Next standalone server   │
│    bound to 127.0.0.1:<port>                                   │
└───────────────────────────────────────────────────────────────┘
```

The port is a **preference, not a constant**: the shell asks for the one this
install served on last time (remembered as `lastPort` in `preferences.json`) and
falls back to a fresh ephemeral one when something else has taken it. That is not
about the port itself — it is about the **origin**. Everything the app keeps in
the browser (the theme preference, sidebar width, open tabs, recent pages, and
the offline cache with its pending-mutation queue) is keyed by
`http://127.0.0.1:<port>`, so a new port every launch silently reset all of it.
Either way the server stays loopback-only.

The port says nothing about *which* version is running. The server answers that
separately, by rendering `<html data-noema-runtime="desktop">` into the document
(`src/lib/runtime-mode.ts` reads it back) — the shell's own
`window.__NOEMA_DESKTOP__` object is evaluated into the page it then replaces, so
it is not there by the time the app runs.

### Why a bundled runtime and not a Node SEA single executable

The first design folded the server into a Node *Single Executable Application*.
That cannot work here, and the build proves it rather than hoping:

- `next build --output standalone` keeps its dependency graph in `node_modules`
  and loads it with **dynamic `require`** — a SEA blob only exposes built-in
  modules and its own embedded assets, so `require("next/dist/…")` fails.
- Prisma loads a **native query engine** (`.node`/`.dll.node`) from disk.

So the app ships the Node runtime itself (`noema-node-<triple>[.exe]`, a real
`node` copied from the machine that built it, declared as a Tauri `externalBin`).
The result still requires **nothing of the user** — no Node install, no PATH
surgery, no admin rights — and the installer stays a single double-click.

### Why a boot wrapper

`server/start.cjs` (written by `scripts/desktop/prepare.mjs`, from
`scripts/desktop/boot-wrapper.cjs`) is what the shell launches — **not**
`server.js`. It resolves a database first (a configured `DATABASE_URL`, else the
embedded PGlite engine, else a Docker-managed Postgres), runs
`prisma migrate deploy`, and only then requires the Next server **in the same
process**, so there is no second process to orphan. Migrations therefore happen on
**every launch**: idempotent, cheap, and it means an app update can never leave the
schema behind the code. If the database is unreachable the server still boots,
`/api/health` reports not-ready, and the app's own bootstrap page explains it
instead of showing a white window.

Other deliberate choices:

- **Loopback only** — the server binds `127.0.0.1`, on the port this install used
  last time when it is free and an ephemeral one otherwise (see above). Nothing is
  exposed to the network, and two installs still run side by side. Remembering the
  port does not widen that: loopback is scannable either way, and authentication is
  unchanged.
- **Readiness is `/api/health`, not `/api/ready`.** `/api/ready` is a
  secret-gated ops endpoint that fails closed (401/503) for an unauthenticated
  caller, so a supervisor polling it would never see the app come up. `/api/health`
  is the documented unauthenticated liveness+readiness probe (`{ ok, db }`, 503 when
  the database is unreachable) — and the supervisor distinguishes the two failures:
  "answered but unhealthy" sends the user to the database field on the bootstrap
  page, "never answered" is a real bug worth a report.
- **The readiness handshake is authenticated.** The port is picked by binding
  `127.0.0.1:0`, reading the port and closing the socket again, so another program
  on the same machine can take the port before the server does — and it only has
  to answer `200` to be believed. The window would then load *that* page, on an
  origin the Tauri capability covers, with the app's IPC rights. So the shell
  generates a random token per start (`NOEMA_SHELL_TOKEN`, 32 bytes from the
  system CSPRNG), hands it to the server through the environment, and accepts a
  server only when the health response echoes it in the `x-noema-shell-token`
  header. The token never reaches the log or the frozen health body. It is a
  response header, so the app's own origin (and any local process that queries
  the running server) can read it; that is not the squatting attack, because a
  program that grabs the port before the server starts never sees a response
  from the server at all. The token is per start, and a restart issues a new one
  before the shell trusts the port again, so a token read from a running server
  cannot be replayed against the next start.
- **The payload ships no `.env`.** Next's standalone output copies `.env` files
  into `.next/standalone` by itself, so `prepare.mjs` strips them — and fails the
  build if one would still ship. Without that step the installer carried the
  developer's `DATABASE_URL` (which is why an install used to insist on a Postgres
  on `localhost:5433`) and the AI keys.
- **Uploads, sessions and backups live in the data directory, not beside the
  code.** The shell passes `STORAGE_DIR`, `SESSION_STORE_PATH` and `BACKUP_DIR`
  (`src/lib/storage.ts`, `src/lib/session-store.ts`,
  `src/app/api/cron/backups/route.ts`) pointing inside `<data dir>`, because all
  three fall back to the *working* directory — the program folder, for a packaged
  install, where an update or an uninstall takes them. For the same
  reason `prepare.mjs` strips `uploads/`, `.data/` and `backups/` from the payload
  (Next copies them in on a machine where the app has been used) and fails the
  build if they would still ship, the way it does for `.env`.
- **The session secret is generated per install.** With no shipped `AUTH_SECRET`
  the wrapper writes a 32-byte secret to `<data dir>/auth-secret` (`0600`) on first
  launch and reuses it afterwards, so sessions survive a restart while one
  install's cookies are worthless on another. A configured `AUTH_SECRET`, like a
  configured database, still wins.
- **The Server Action origin allowlist is recomputed at launch, not shipped.**
  Next only accepts a Server Action when the request's `Origin` matches its `Host`
  (CSRF), so this machine's own addresses must be listed — next.config.ts gets the
  list from `scripts/desktop/allowed-origins.cjs`. Next serializes that config
  *into* the build (`.next/required-server-files.json`, and the literal in the
  standalone `server.js`), which would make an install inherit the network
  interfaces of whatever machine built it: a VPN adapter that appears later, or a
  build on someone else's PC, would leave the app refusing its own address, and
  the failure is silent (saving spins forever, comments do nothing). The boot
  wrapper therefore rebuilds the config from that file with the allowlist computed
  now — including the runtime `APP_ORIGINS`, which a standalone payload otherwise
  ignores — and falls back to the generated entry if the file is not the shape it
  expects. `prepare.mjs` counts `next.config.ts` as a build input, so
  `NOEMA_SKIP_BUILD=1` cannot re-stage a payload with the previous list.
- **Migrations are self-healing.** The boot wrapper runs `prisma migrate deploy`
  and, on `P3005` (tables without migration history — what `prisma db push`
  leaves behind), falls back to `db push` so an existing database is adopted
  instead of refused.
- **The shell survives a dead server** — the window opens immediately on a
  bundled page and swaps to the app once `/api/health` answers. If it never does,
  that page offers **Retry**, **Open data folder**, **Copy diagnostics**, and a
  **database connection** field.
- **Rust owns the OS, JavaScript owns the product.** No business logic is
  duplicated in Rust: the shell starts, supervises, exposes native power and gets
  out of the way.

## 2. Security model

| Concern | Decision |
|---|---|
| Server exposure | loopback only, no `0.0.0.0`; the port is this install's own (stable origin) or a free ephemeral one when it is taken |
| Webview ↔ server | explicit `APP_ORIGINS` allow-list (the loopback origin) + CSP in `tauri.conf.json` |
| Webview ↔ shell | only the commands in `src-tauri/src/commands.rs`; the served app's IPC is granted to the loopback origin by `desktop-remote.json` (a capability with `remote.urls`) |
| Secrets | a database password can live in the connection string; it is **redacted** before it leaves the shell at all — `database_url` hands out the redacted form, and `get_pref` refuses the key outright (unit-tested in `commands.rs`) |
| Capabilities | `default.json` = least privilege for boot; `desktop-everything.json` = the broad set the product asked for (dialogs, shell, opener) — **local only**, for the shell's own page; `desktop-remote.json` = the served app's narrow set (the five shell commands it calls + the two `core:event` permissions `listenShell` needs), **no** filesystem, shell, store, opener, dialog, `os` or `log` — and no `core:default` either. The **store plugin is granted to nobody**: `tauri-plugin-store` does no scope check of its own (`store|load` takes any path), the shell reaches the store through Rust — which the ACL does not gate — and the store's `preferences.json` holds the unredacted connection string. Drop `desktop-everything.json` for a hardened build |
| Telemetry | off (`NEXT_TELEMETRY_DISABLED=1`) |
| Updates | **deferred on purpose** — see §9 |

### App commands are behind the ACL too, and the served app counts as remote

The window shows the *served* app, whose origin (`http://127.0.0.1:<port>`) is
not the shell's own (`http://tauri.localhost`). Tauri treats that as a **remote
origin** and refuses every application command from it unless a capability
grants the command by name — the failure is `Command … not allowed by ACL`, and
it is per-command, not per-window.

So a new shell command needs three things, not one:

1. the `#[tauri::command]` itself, registered in `invoke_handler`;
2. its name in `build.rs`'s `APP_COMMANDS`, which declares the app manifest and
   autogenerates an `allow-<command>` permission into
   `permissions/autogenerated/` (gitignored, rebuilt by cargo).
   `commands::tests` keeps this list and the attributes in step;
3. the permission listed in `src-tauri/permissions/default.toml` (the shell's
   own page: the whole surface) and/or in a capability — the served app's set
   lives in `capabilities/desktop-remote.json`.

The served app's capability is deliberately narrow, because a capability bound
to a remote URL hands its permissions to *every* script that runs in that
origin — an XSS in the app, or a page that grabbed the port first. It carries
exactly two things: the five commands the app actually calls (`desktop_info`,
`recent_logs`, `set_theme`, `backup_now`, `check_update` — `invokeShell` in
`src/lib/runtime-mode.ts`) and `core:event:allow-listen` /
`core:event:allow-unlisten`, which `listenShell` needs to subscribe to the
shell's menu events. No filesystem, no shell, no store, no opener, no dialog,
no `os`, no `log` — and deliberately **not** `core:default` either: that set
expands to the image plugin (`plugin:image|from_path` is a bare
`std::fs::read` with no scope check), to the menu and tray plugins (a forged
menu-item id reaches the commands in `src-tauri/src/shell.rs`, which dispatches
on the raw id) and to the path plugin (it resolves the user's home directory).
The broad set stays with the shell's own page in
`capabilities/desktop-everything.json`, which grants no remote URL.

The **store plugin** is the one permission no origin holds at all — not the
served app, not the shell's own page. `tauri-plugin-store` checks no scope of
its own: `store|load` takes any path (an absolute one is used as it is), so
`store:default` would be a read — and `store|save` a write — primitive over
any JSON file on the machine. The store this app keeps holds the **unredacted**
connection string, and nothing needs the plugin's JavaScript face: the shell
reads and writes the store through Rust (`state::set_pref`), which the ACL does
not gate. The preference store stays reachable for the shell's own page — as
the audited app commands `get_pref`/`set_pref`.

`scripts/desktop/capabilities.test.mjs` pins the split — across the capability
**files** *and* the capabilities declared inline in `tauri.conf.json`
(`CapabilityEntry::Inlined`), which the ACL assembles just like the files and
which therefore have to obey the same rules. A split that only constrains the
files could be undone by appending one object to the config.

Declaring the app manifest is not free: it switches the ACL on for **local**
origins as well, which until then reached every command implicitly. That is why
`capabilities/default.json` asks for `default` — dropping it would break the
shell's own first-run and diagnostics page.

The served page must also be able to *reach* the IPC endpoint, so the document
CSP admits it (`connect-src` gains `ipc:` and `http://ipc.localhost`) in
`src/lib/security-headers.ts`, scoped to `NOEMA_RUNTIME=desktop` /
`NOEMA_STANDALONE=1`. The hosted site keeps `connect-src 'self'`: in a browser
`ipc.localhost` resolves to loopback, which is why the widening is conditional.

## 3. Data, backup and portability

```
<data dir>/                 (%APPDATA%\app.noema.desktop on Windows)
  logs/                     noema.log — the shell and the server share it
  uploads/                  uploaded files
  sessions.json             this machine's session store
  backups/                  automatic backups
  preferences.json          window state, theme, database URL
```

- **Data dir** — `app.path().app_data_dir()`; `NOEMA_DATA_DIR` overrides it
  (portable installs, CI, "put my notes on an external drive").
- **Database** — the workspace data lives in Postgres, so "where is my data" has
  two honest answers: app files in the data dir, content in the database. §8
  explains the trade-off and the plan.
- **Backup** — *Data → Back up now* (`Cmd/Ctrl+Shift+B`); retention is the policy
  in `src/lib/backup-retention.ts`.
- **Leave the app** — every export path is shared with the site version
  (Markdown, HTML, CSV, workspace zip).

## 4. Building it

```bash
# 0. one-time prerequisites (Node 20+, Rust stable, MSVC Build Tools on Windows)
npm run desktop:preflight      # tells you exactly what is missing, with the fix
npm run desktop:icons          # generates every icon size from assets/icon.png

# 1. package the payload: next build (standalone) + static/public + Prisma CLI
#    + the Node runtime copied into src-tauri/binaries/
npm run desktop:prepare

# 2. develop: web dev server + the shell, hot reload on both sides
npm run desktop:dev            # beforeDevCommand starts `next dev --port 3200`

# 3. build the installers
npm run desktop:bundle         # NSIS .exe + .msi
```

`cargo tauri` is the CLI (`cargo install tauri-cli --version 2.12.3 --locked`,
the exact version CI installs), so no npm dependency has to change to build
the app. A JS-driven team can use `@tauri-apps/cli` instead; the config is
identical.

### The one flag that splits the outputs

`next.config.ts` turns on Next's standalone output **only** when
`NOEMA_STANDALONE=1`:

```ts
...(process.env.NOEMA_STANDALONE === "1" ? { output: "standalone" as const } : {}),
```

The site build (`next start`, the Docker image) therefore behaves exactly as
before, and the desktop build opts in. `scripts/desktop/prepare.mjs` sets the
flag; `site.yml` asserts the invariant that a site build never emits
`standalone/server.js`.

### Build hygiene (learned the hard way)

**Never run the site build and the desktop payload build at the same time.** They
share `.next/`: a plain `next build` rewrites the directory and removes
`standalone/server.js`, while `prepare` with `NOEMA_SKIP_BUILD=1` will happily
copy whatever is left. That produced an installer that built cleanly, weighed
50 MB, and would have booted to nothing.

**Neither may a dev server share `.next/` with a production build.** The same
directory holds two incompatible outputs, so a running `next dev` keeps serving while
*its own* chunks start 404ing (`_next/static/chunks/main-app.js` → `text/plain`,
refused) and pages fail with `Cannot read properties of undefined (reading 'call')`.
The visible symptom is the one that costs the most time: **every page renders but
nothing hydrates** — the markup is fine, so it looks like a component bug, and it is
not. Measured end-to-end while building the motion harness. If a dev server starts
behaving like that, stop it, delete `.next`, and start it again; and stop it before
running `desktop:prepare` or `cargo tauri build`.

Two guards make that class of mistake impossible now:

- `prepare` validates the payload against a required list (`server.js`,
  `.next/static`, `node_modules/next`, `public`, `prisma/schema.prisma`,
  `start.cjs`) and refuses to stage an incomplete one, with the fix in the error;
- `npm run desktop:smoke` boots the staged payload on the bundled runtime and
  fetches real pages over HTTP, so a broken payload fails before it is bundled.

Recommended order:

```bash
npm run desktop:prepare     # build the payload (serially)
npm run desktop:smoke       # prove it boots + migrates + serves
npm run desktop:bundle      # bundle (prepare re-runs, validated)
```

## 5. The database — embedded by default

The schema is Postgres (full-text search), so a desktop install needs a Postgres.
Rather than asking you to install one, the desktop build **carries one inside
itself**:

1. **A configured URL always wins** — `NOEMA_DATABASE_URL`, or the value saved in
   the app's settings / pasted on the bootstrap page. That is how you point the app
   at a shared server, at the compose stack you already run, or at a managed
   database.
2. **Otherwise the app runs an embedded PostgreSQL** — [PGlite](https://pglite.dev),
   real Postgres compiled to WebAssembly, started by the boot wrapper and exposed
   on loopback so Prisma connects over the ordinary wire protocol. Data lives in
   `pgdata/` inside the app's data directory, so updates and uninstalls leave it
   alone. **Nothing has to be installed: no Postgres, no Docker, no service.**
3. **Otherwise** it manages a container: `noema-postgres` (`postgres:16-alpine`)
   with its own named volume `noema-pgdata`. Docker is started automatically if the
   engine is not running (Windows: Docker Desktop). This stays available — and is
   the path `NOEMA_NO_EMBEDDED_DB=1` selects — for anyone who wants a full server
   engine without configuring one.
4. **Otherwise** the conventional `postgresql://postgres:postgres@127.0.0.1:5432/noema`,
   so an existing local Postgres still works and the bootstrap page can take over.

### Migrations are the schema — verified, not assumed

Two defects lived here, both invisible to the test suite, and both fatal to a real
install:

| Defect | Why nothing caught it |
|---|---|
| `prisma migrate deploy` created **17 of 45 tables** and left **28 columns** off the existing ones (`Page.searchText`, page font/width/locked, 2FA, share-link indexing, recurring templates…) | unit tests mock Prisma; dev and e2e databases are built by `db push`, which syncs everything. Only the *app's own* path was malformed — `relation "ticket" does not exist`, 221 call sites |
| No **full-text GIN index** — `setup:search` created it by hand in dev, and no migration ever did | search still answered, by falling back to a capped scan: correct results, no index |

Both are fixed by migrations (`20260114000000_complete_schema`,
`20260114000001_search_index`) and guarded by two commands you should run before
believing anything:

```bash
npm run check:schema     # migrations describe the schema, and a fresh database gets every model
npm run check:features   # boot the shipped payload on a migrate-built database and run every live check
```

`check:schema` replays the migrations in a shadow database and fails on any drift,
then applies them for real and fails unless **every `model` in the schema has a
table** — the assertion that was missing. `check:features` is the end-to-end one: it
creates a database with `prisma migrate deploy`, seeds it, starts the packaged
payload with the bundled runtime, and runs all sixteen live checks through real
routes, APIs and Server Actions. That is the combination that catches "the installer
boots but half the features are broken".

The desktop smoke test was also strengthened for the same reason: it compared a
database against a magic number (`> 10 tables`) and now compares it against the
schema's own model list. A floor is not an assertion.

### Limits of the embedded engine (worth knowing before you rely on it)

| Limit | Consequence, and what to do |
|---|---|
| **One session, shared by every client** | PGlite queues every connection onto a single PostgreSQL session, so anything that *names* its prepared statements collides with the previous client: a second process running `PREPARE s0` failed with `42P05: prepared statement "s0" already exists`, which broke the seed after a build and every second process to touch the database. The generated URL carries `pgbouncer=true` (§5), which stops Prisma naming statements, so several Prisma clients — the app, a seed, the screenshot harness — coexist. A *non-Prisma* client (psql, an admin script) is still one session at a time: stop the app, or point it at a real Postgres with `NOEMA_DATABASE_URL`. |
| **No `pg_dump`** | it is a WebAssembly engine, not a server with binaries beside it, so `npm run backup` (which shells out to `pg_dump`) cannot dump it. The backup unit is the **data directory** (`pgdata/` inside the app data folder) — copy it while the app is stopped. Point the app at a real Postgres if you need `pg_dump`-style dumps and GFS retention. |
| **First launch initialises it** | a few seconds once, on the machine's disk, with no network. Later launches reuse `pgdata/`. |
| **Not for multiple machines** | it is a local file-backed database. For shared workspaces use a real Postgres via `NOEMA_DATABASE_URL`. |

### The socket server needed two fixes before it was trustworthy

The engine is served over the Postgres wire protocol by
`@electric-sql/pglite-socket`, and that server had two failure modes no unit test
could reach — `cargo test` cannot see it, and the app cannot be launched in CI.
Both were found by driving a real engine, and both are now reproduced by
`npm run check:embedded-db`:

| Failure | What it looked like | Fix |
|---|---|---|
| A client that reset mid-handshake **killed the process** | `Error: read ECONNRESET`, and the whole database process exited — taking the session's data with it. Node treats an unhandled `error` event as fatal, and the server attaches its own listener only *after* accepting a connection, so a socket that goes away before that is unguarded. | `scripts/desktop/embedded-db.cjs` listens on the server's `connection` event — which runs before its deferred accept — and attaches an `error` listener to every socket. |
| Ten aborted handshakes **wedged it forever** | The server creates a handler per accepted connection and removes it on the handler's `close` event, but a socket that dies before `attach` runs has *already* fired `close`: the handler leaked, the count climbed to `maxConnections` (10), and every later client was answered `Too many connections`. The database was unreachable until restart. | The wrapper reclaims any handler whose socket is gone, and checks as each connection arrives — *before* the server decides whether there is room. A wedged engine heals on the next client instead of needing a restart. |

Both are worth reading as a pattern: the embedded engine is a *server inside the
app's own process*, so a bug there is not a failed request, it is a dead app.

### Why the embedded engine is the default

The spike (and then the real smoke test) answered the questions that mattered, so
this is measured rather than assumed: PostgreSQL semantics including `tsvector` and
GIN indexes, JSON columns, enums, cascades, and the project's **own migration**
applied cleanly with zero schema changes. The one gap the spike found was
`pg_trgm`, which this app no longer uses — the fuzzy-match tier is pure TypeScript
(`src/lib/fts.ts`).

Two constraints fell out of building it, and both are load-bearing:

| Constraint | Why |
|---|---|
| The Prisma CLI must be spawned **asynchronously** | the database runs *in the boot wrapper's process*, so `spawnSync` would block the event loop and the CLI's own connection could never be answered — the first attempt failed with `P1001: Can't reach database server` for exactly this reason |
| The shell must **not** inject a default `DATABASE_URL` | `server_env` omits it when nothing is configured. An injected `localhost:5432` would take branch 1 and the embedded engine would never start |

Why the other decisions are what they are:

| Decision | Reason |
|---|---|
| Embedded data in `pgdata/` under the **data directory** | an update or uninstall must not take the user's data with it, and the install directory is not writable per-user on every machine |
| `connection_limit=1` in the generated URL | PGlite executes one query at a time; a wider pool would only queue |
| Graceful close on `SIGINT`/`SIGTERM`/`SIGHUP` | Postgres recovers from WAL after a hard kill, but a clean close leaves no recovery work |
| Container `noema-postgres`, volume `noema-pgdata` | **never** the project's own `noema-db`: a desktop install must not adopt, restart or delete the developer's database |
| Docker chooses the host port (`-p 127.0.0.1::5432`) | any fixed port can collide — the compose stack publishes 5433, the first candidate — and the install would fail with "port is already allocated" |
| A **generated** password, stored in the data directory | a local database with `postgres/postgres` is a habit worth not having |
| The volume is never removed; a stopped container is started, a broken one recreated | the user's data outlives the app's lifecycle decisions |
| `--restart unless-stopped` | the database comes back with the machine, without the app running |

Inspect or pre-provision the Docker path without launching the app:

```bash
npm run desktop:db          # docker? engine up? container? credentials? port?
npm run desktop:db:ensure   # create/start it now and print the URL
npm run desktop:smoke:embedded  # empty data dir → embedded PostgreSQL → migrate → serve (nothing installed)
npm run desktop:smoke:fresh # empty database → Docker → migrate → serve (end to end)
```

## 6. Installing what you built

The build produces two installers in `src-tauri/target/release/bundle/`:

| Artifact | Size | Notes |
|---|---|---|
| `nsis/Noema_1.4.1_x64-setup.exe` | 73.36 MiB | Per-user install — **no admin prompt**, no UAC |
| `msi/Noema_1.4.1_x64_en-US.msi` | 131.35 MiB | For managed deployment (MSI/GPO) |

Verify the *installed* result rather than the build output — they are not the same
thing, and every failure this project has had in the installer only ever appeared in
the installed app:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/desktop/verify-install.ps1 `
  -Setup src-tauri\target\release\bundle\nsis\Noema_1.4.1_x64-setup.exe -UninstallFirst
```

It installs silently, starts the shell, finds the supervised server's loopback port,
checks `/api/health`, serves a real page with its stylesheets, proves a second launch
does not start a second server, refuses to pass if a panic was logged, and captures the
window to `%TEMP%\noema-verify\noema-window.png` so the design can be *looked at*.

Three checks that only make sense against the running app, because each of them has
failed *only* in a production build:

```bash
# the installed app serves the nonce-based CSP it claims to
npm run check:csp -- --base http://127.0.0.1:<the app's loopback port>

# every popup attaches to the control that opened it (the app has no browser chrome,
# so a mis-anchored menu has nowhere to hide)
npm run check:popovers -- --base http://127.0.0.1:<port>
```

The port is the one `verify-install.ps1` prints (`supervised server listening on
loopback — port …`) — the app picks a free one, so it must be read, not assumed.

> **Windows PowerShell 5.1 note.** These scripts are UTF-8 and contain em-dashes, so
> they must keep a **UTF-8 BOM**. Without it, `powershell` (5.1, the only interpreter
> on a stock Windows box — there is no `pwsh`) decodes them as ANSI and fails at
> *parse* time with a wall of "missing string terminator" errors. That happened; the
> BOM is the fix and a `.ps1` added here should get one too.

Both contain the whole app: the Rust shell, the Next standalone server, the Prisma
CLI, and a Node runtime. **Nothing has to be installed first.**

First run:

1. The window opens immediately on the shell's own page ("Noema is starting…").
2. The bundled server starts on a loopback port and migrates the database.
3. As soon as `/api/health` answers 200 the window swaps to your workspace.

If step 3 does not happen, the page stays useful: open **Advanced: database
connection**, paste a `DATABASE_URL`, and press **Save & restart**. **Copy
diagnostics** puts a redacted report (host, port, app version, recent log lines —
password never included) on the clipboard.

Three environment variables are honoured, which is how a portable install or a
support session works without touching the UI:

```
NOEMA_DATABASE_URL   the Postgres connection string
NOEMA_DATA_DIR       where logs/ and backups/ live
NOEMA_ALLOW_LOOPBACK_TARGETS  1 = allow an outbound webhook to point at the
                                loopback range (127.0.0.0/8, ::1, localhost);
                                unset = refused (the default). The opt-in
                                opens the loopback range only — see SECURITY.md
```

Uninstall: **Settings → Apps → Noema → Uninstall**, or the `uninstall.exe` in the
install directory. Your data directory is left behind on purpose.

### A local database in one line

The desktop app talks to Postgres (see §10 for why, and the plan to remove that):

```bash
docker run -d --name noema-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
```

Then the app's default `postgresql://postgres:postgres@127.0.0.1:5432/noema`
works as-is once the `noema` database exists (`docker exec noema-db createdb -U postgres noema`).

## 7. Release process

1. Bump the version in **both** `package.json` and `src-tauri/tauri.conf.json`.
2. `npm run desktop:bundle` (or push the `v*` tag, which runs the
   `desktop.yml` matrix on Windows, macOS and Linux and uploads the artifacts
   to a draft release).
3. Ship the NSIS `.exe` (per-user install, no admin prompt) and/or the `.msi`.

The app intentionally ships **unsigned** until certificates exist; §8 explains
what that means for the user (SmartScreen) and what is already wired for signing.

A tag push runs the workflow's `release` job: it is the only job that holds a
write-scoped token (to open the draft release) and the signing secrets (the
bundle is signed while it is built). Everything a pull request can reach runs
with a read-only token and no secret at all, and no checkout keeps its
credentials — a pull request must never be able to read a token or a signing
key out of the tree it ships.

## 8. Testing

| Layer | What runs |
|---|---|
| Rust (shell) | `cargo test` — data-dir layout, loopback URL shape, resource path, env contract (incl. the database URL and the handshake token), restart backoff bounds, free-port behaviour and the preferred-port fallback, the readiness handshake (a response is ours only when it carries the token), layout creation, log ring buffer, connection-string redaction |
| Rust (quality) | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` |
| Shared TS | the whole existing suite — the app version adds **no** forked logic |
| Desktop wiring | `scripts/desktop/capabilities.test.mjs`, `scripts/desktop/fs-capability.test.mjs` and `scripts/desktop/shell-handshake.test.mjs` — the capability split and the handshake between the shell and the server (both sides must agree on the token's name and its header, and neither may drop the check) |
| Runtime mode | `src/lib/runtime-mode.test.ts` (site vs desktop, the mode the server renders into the document, the Tauri fallback, API base, data dir, version, capabilities, SSR safety) and `src/app/a11y-layout.test.ts` (the attribute the layout renders for the site, `NOEMA_RUNTIME` and `NOEMA_STANDALONE`) |
| Packaging | `desktop:preflight` on every run; `site.yml` asserts the site build never emits a standalone server |
| Embedded database | `npm run check:embedded-db` — starts a real PGlite engine in a throwaway data directory, aborts 24 handshakes mid-flight, and proves the engine still serves a second and a third Prisma client. No Postgres, no Docker, no Tauri. Run in CI's `payload-smoke` job. |
| Manual smoke | install → first run → the swap from "starting…" to the workspace → create a note → quit → relaunch (same origin, so window geometry, theme and the rest of the browser-side state are still there) |

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Window stays on "Noema is starting…" | server not ready | open **Advanced: database connection**, paste a working `DATABASE_URL`, **Save & restart**; **Copy diagnostics** pastes a redacted report |
| `prisma migrate deploy` fails | database missing or unreachable | create the database (e.g. `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine`) or point the app at an existing one |
| `prepare` refuses to stage: "incomplete payload" | a site build replaced `.next/` | rebuild the payload (no `NOEMA_SKIP_BUILD=1`), and never run the two builds together |
| App starts and dies instantly, no window | a Rust panic — `panic = "abort"` makes it silent | read `%TEMP%\noema-panic.log` (also written to `<data dir>/logs/panic.log`); the shell installs a panic hook precisely so this is never traceless |
| Panic: `invalid type: map, expected unit` for a plugin | Tauri v2 plugins such as `single-instance` and `window-state` declare **no** config object, so `"plugins": { "single-instance": {} }` fails deserialization | drop the entry; move any options into the Rust builder where they are type-checked |
| Panic: `a webview with label main already exists` | the window is declared in `tauri.conf.json` *and* built in `setup()` | declare it in one place only — this app declares it in config and fetches it in code |
| `link.exe not found` | no MSVC toolchain | install VS Build Tools with "Desktop development with C++" |
| `cargo` not found | no Rust | <https://rustup.rs> |
| `binaries/noema-node-…` missing | payload not prepared | `npm run desktop:prepare` |
| Icon error while bundling | icon set not generated | `npm run desktop:icons` |
| Two copies fight over state | same data dir | set `NOEMA_DATA_DIR` per install |

## 10. Verified on a real machine (Windows x64, this repo's environment)

Recorded because "it builds in CI" and "it runs" are different claims. Every row
below was executed, not inferred.

| Step | Result |
|---|---|
| `npm run desktop:preflight` | all checks pass (rustc 1.99.1, MSVC Build Tools 2026, WebView2 155, icons, bundled runtime, payload) |
| `cargo fmt --check` · `cargo clippy -D warnings` | clean |
| `cargo test --all-features` | 26 tests pass (layout, loopback URLs, env contract, backoff bounds, free-port behaviour and the preferred-port fallback, log ring, connection-string redaction and quote-normalisation, preferred-port plausibility, `Send` guards, readiness messaging) |
| `npm run desktop:prepare` | 369.0 MB payload staged and validated |
| `npm run desktop:smoke` | boots the packaged payload on the bundled runtime, migrates, serves `/api/health` 200 and `/login` 200 |
| `cargo tauri build` | `Noema_1.4.1_x64-setup.exe` (73.36 MiB) + `Noema_1.4.1_x64_en-US.msi` (131.35 MiB) |
| **Installed the NSIS installer** | exit 0, per-user, **no admin prompt** → `%LOCALAPPDATA%\Noema\` + Start Menu shortcut + `uninstall.exe` |
| **Launched the installed app** | supervised server on a loopback port, `/api/health → 200 {"ok":true,"db":"up"}`, `/login → 200` (16,903 bytes) |
| **Relaunched the installed app** | same loopback port (61621 → 61621), so the app's browser-side state survives a restart; with that port occupied it logs `port 61621 is in use, serving on 62537 instead` and re-points the preference |
| **Launched with no env vars at all** | `db: up` from `preferences.json`, and the shell created `logs/ uploads/ backups/` |
| Failure path | with a bad database URL the app stayed on the bootstrap page and logged "the local server is running but reports unhealthy (HTTP 503)" instead of showing an empty window |
| site version | `next build` succeeds (40 routes) and emits no `standalone/` output |

Two environment notes worth keeping:

- **Running the app is the only way to find boot bugs.** Compilation, `clippy` and
  the test suite were all green while the installed app crashed instantly three
  separate times (invalid plugin config, duplicate window label, quoted URL).
- **`panic = "abort"` hides everything.** The panic hook exists because the first
  installed run died with `0xC0000409` and wrote no log at all.

## 11. Known limits (honest list)

- **The desktop app currently talks to Postgres.** The schema uses Postgres
  full-text search (`tsvector`, `pg_trgm`), so a self-contained desktop build
  needs either a SQLite-compatible schema or an embedded Postgres. Until that
  lands, the installer expects a reachable Postgres — a local container is enough
  — and the first-run screen makes that configurable without a reinstall. This is
  the single biggest remaining gap between "installable" and "no prerequisites".
- **No auto-updater yet.** The updater needs a signing key pair and a release
  endpoint; shipping one that cannot verify a signature would be worse than
  shipping none, so the menu item resolves to "up to date" and `docs/DESKTOP.md`
  §9 records the plan.
- **Unsigned binaries.** Windows SmartScreen will warn until a code-signing
  certificate is installed; the desktop workflow's `release` job (tag pushes
  only) already threads the signing secrets.
- **macOS**: closing the window hides the app; **File → Quit** (⌘Q) really quits.
  Native, but surprising for Windows users.
- **`desktop-everything.json` is deliberately broad** (product decision) and
  **local only**: it applies to the shell's own page, never to the served web
  app, which has its own narrow capability (`desktop-remote.json`). Narrow it
  further for an untrusted-user scenario.
- **Verified where**: `cargo build`, `cargo test`, the packaging steps and the
  installer run on a Windows machine with the MSVC toolchain (this repo's
  environment). macOS/Linux installers are produced by `desktop.yml` on native
  runners.

## 12. Embedded database — the plan, with the spike already done

**Goal:** the installer must work on a machine with **nothing** installed — no
Postgres, no Docker. Today it provisions a Postgres via Docker when Docker Desktop
is present, and otherwise falls back to a local URL (§5).

**Spike verdict (measured on Windows x64, PGlite 0.5.10 / PostgreSQL 18.6):**

| Question | Result |
|---|---|
| Real Postgres semantics? | **Yes** — reports `PostgreSQL 18.6 … wasm32-unknown-emscripten` |
| `to_tsvector` / `plainto_tsquery` (the core of search) | **works** |
| GIN index over `to_tsvector` | **works** |
| JSON operators (all page content) | **works** |
| Prisma `db push` of the real 45-model schema | **works** — and the schema needs **no changes** (no `extensions`, no native `@db.*`, no preview features) |
| Prisma CRUD, nested writes, relation includes, joins, `groupBy`, `$transaction`, raw `tsvector` search, cascade deletes | **all work** over the wire protocol |
| `pg_trgm` | **NOT available** — PGlite ships a limited extension set |

**Two connection details that make it work** (both required):

```
postgresql://postgres:postgres@127.0.0.1:<port>/postgres?pgbouncer=true&connection_limit=1
```

- `connection_limit=1` — PGlite is a single in-process engine;
- `pgbouncer=true` — without it Prisma's *named prepared statements* collide on
  the long-lived engine and every query fails with
  `42P05: prepared statement "s0" already exists`.

**Remaining work for the embedded database:**

1. Replace the `pg_trgm` dependency (raw SQL only): `src/lib/fts.ts`,
   `src/server/queries.ts`, `src/lib/search-ranking.ts`, and the GIN/trgm index in
   `scripts/setup-search.mjs`. Keep `tsvector` ranking, do the fuzzy scoring in
   TypeScript (the ranking layer is already pure), and keep `ILIKE` fallbacks.
   This is the *only* behaviour-affecting change, and it is testable against the
   existing search tests.
2. Ship `@electric-sql/pglite` (+ its socket server) inside the payload and start
   it from the boot wrapper when no external URL is configured — no child Postgres
   process, no `initdb`, ~13 MB.
3. Resolution order becomes: configured URL → **embedded PGlite** → (Docker, kept
   as an option for people who want their own server) → setup page.
4. The `--managed` desktop smoke test gains a `--embedded` mode that proves a
   clean machine works with Docker stopped.

**Why not SQLite:** it would need a forked schema and a rewrite of the same search
layer, with more semantics lost (no `tsvector`, no enums, no `Json` operators) —
strictly worse than PGlite, which is real Postgres.

**Why not bundled PostgreSQL binaries:** ~90 MB and a second process to
`initdb`/supervise/upgrade, for no capability PGlite does not already provide.


## 13. Not yet implemented (honest list)

- **Embedded database (the big one)** — two options, both already scoped:
  1. **SQLite**: a `schema.desktop.prisma` with `provider = "sqlite"`, replace
     `tsvector`/`pg_trgm` search with the pure `src/lib/fts.ts` ranking, and swap
     the GIN-index setup for `LIKE`-backed ranking. Cheapest to ship, loses
     Postgres-specific query plans.
  2. **Bundled Postgres**: ship the Postgres binaries as resources and have the
     shell `initdb` a cluster in the data dir and start it as a second sidecar.
     Bigger installer (~80 MB), exact feature parity, no schema fork.
  The shell already isolates the choice to one env var (`DATABASE_URL`), and the
  first-run screen already accepts a connection string — so either path is a
  packaging change, not a rewrite.
- **Auto-updater** — `tauri-plugin-updater` + `createUpdaterArtifacts`, a pubkey
  in `tauri.conf.json`, and `TAURI_SIGNING_PRIVATE_KEY` in CI.
- **Deep links** (`noema://`) — `tauri-plugin-deep-link` plus the
  `single-instance` deep-link feature; the shell already focuses the existing
  window when a second instance launches.
- **Portable build** — `NOEMA_DATA_DIR=./data` beside the executable.
