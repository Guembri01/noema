# Noema — Desktop (installable app) & Site (hosted) versions

One codebase, two shipped products:

| | **Site version** | **App version** |
|---|---|---|
| What | the hosted web app | the installable desktop app |
| Runtime | Next.js server + Postgres | Tauri 2 (Rust) shell + a bundled Node runtime running the same Next server |
| Database | Postgres | Postgres (same schema; connection string configurable on first run) |
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
│  │  · picks a free loopback port                          │   │
│  │  · spawns `noema-node` (bundled runtime) on start.cjs  │   │
│  │  · polls /api/health until 200 (90 s budget)            │   │
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

`server/start.cjs` (written by `scripts/desktop/prepare.mjs`) runs
`prisma migrate deploy` and then requires the Next server. Migrations therefore
happen on **every launch**: idempotent, cheap, and it means an app update can
never leave the schema behind the code. If the database is unreachable the server
still boots, `/api/health` reports not-ready, and the app's own bootstrap page
explains it instead of showing a white window.

Other deliberate choices:

- **Loopback only** — the server binds `127.0.0.1` on an ephemeral port chosen by
  the kernel. Nothing is exposed to the network, and two installs run side by side.
- **Readiness is `/api/health`, not `/api/ready`.** `/api/ready` is a
  secret-gated ops endpoint that fails closed (401/503) for an unauthenticated
  caller, so a supervisor polling it would never see the app come up. `/api/health`
  is the documented unauthenticated liveness+readiness probe (`{ ok, db }`, 503 when
  the database is unreachable) — and the supervisor distinguishes the two failures:
  "answered but unhealthy" sends the user to the database field on the bootstrap
  page, "never answered" is a real bug worth a report.
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
| Server exposure | loopback only, ephemeral port, no `0.0.0.0` |
| Webview ↔ server | explicit `APP_ORIGINS` allow-list (the loopback origin) + CSP in `tauri.conf.json` |
| Webview ↔ shell | only the commands in `src-tauri/src/commands.rs`; IPC granted to the loopback origin via a capability with `remote.urls` |
| Secrets | a database password can live in the connection string; it is **redacted** before diagnostics leave the shell (unit-tested in `commands.rs`) |
| Capabilities | `default.json` = least privilege for boot; `desktop-everything.json` = the broad set the product asked for (filesystem, dialogs, shell, opener). Drop it for a hardened build |
| Telemetry | off (`NEXT_TELEMETRY_DISABLED=1`) |
| Updates | **deferred on purpose** — see §9 |

## 3. Data, backup and portability

```
<data dir>/                 (%APPDATA%\app.noema.desktop on Windows)
  logs/                     noema.log — the shell and the server share it
  uploads/                  uploaded files
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

`cargo tauri` is the CLI (`cargo install tauri-cli --version ^2 --locked`), so no
npm dependency has to change to build the app. A JS-driven team can use
`@tauri-apps/cli` instead; the config is identical.

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

## 5. Release process

1. Bump the version in **both** `package.json` and `src-tauri/tauri.conf.json`.
2. `npm run desktop:bundle` (or the `desktop.yml` matrix, which does this on
   Windows, macOS and Linux and uploads the artifacts to a draft release).
3. Ship the NSIS `.exe` (per-user install, no admin prompt) and/or the `.msi`.

The app intentionally ships **unsigned** until certificates exist; §8 explains
what that means for the user (SmartScreen) and what is already wired for signing.

## 6. Testing

| Layer | What runs |
|---|---|
| Rust (shell) | `cargo test` — data-dir layout, loopback URL shape, resource path, env contract (incl. the database URL), restart backoff bounds, free-port behaviour, layout creation, log ring buffer, connection-string redaction |
| Rust (quality) | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` |
| Shared TS | the whole existing suite — the app version adds **no** forked logic |
| Runtime mode | `src/lib/runtime-mode.test.ts` (site vs desktop, API base, data dir, version, capabilities, SSR safety) |
| Packaging | `desktop:preflight` on every run; `site.yml` asserts the site build never emits a standalone server |
| Manual smoke | install → first run → the swap from "starting…" to the workspace → create a note → quit → relaunch (window geometry + theme restored) |

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Window stays on "Noema is starting…" | server not ready | open **Advanced: database connection**, paste a working `DATABASE_URL`, **Save & restart**; **Copy diagnostics** pastes a redacted report |
| `prisma migrate deploy` fails | database missing or unreachable | create the database (e.g. `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine`) or point the app at an existing one |
| `prepare` refuses to stage: "incomplete payload" | a site build replaced `.next/` | rebuild the payload (no `NOEMA_SKIP_BUILD=1`), and never run the two builds together |
| `link.exe not found` | no MSVC toolchain | install VS Build Tools with "Desktop development with C++" |
| `cargo` not found | no Rust | <https://rustup.rs> |
| `binaries/noema-node-…` missing | payload not prepared | `npm run desktop:prepare` |
| Icon error while bundling | icon set not generated | `npm run desktop:icons` |
| Two copies fight over state | same data dir | set `NOEMA_DATA_DIR` per install |

## 8. Verified on a real machine (Windows x64, this repo's environment)

Recorded because "it builds in CI" and "it runs" are different claims:

| Step | Result |
|---|---|
| `npm run desktop:preflight` | all checks pass (rustc 1.99.1, MSVC Build Tools 2026, WebView2 155, icons, runtime, payload) |
| `cargo fmt --check` · `cargo clippy -D warnings` | clean |
| `cargo test --all-features` | 16 tests pass (layout, loopback URLs, env contract incl. the database URL, backoff bounds, free-port behaviour, log ring, connection-string redaction, `Send` guards) |
| `cargo tauri build --bundles nsis,msi` | `Noema_1.4.0_x64-setup.exe` (50.4 MB) + `Noema_1.4.0_x64_en-US.msi` (93.4 MB) |
| `npm run desktop:smoke` | the packaged payload boots on the bundled runtime, migrates the database, and serves `/login` over HTTP |
| site version | `next build` succeeds (40 routes) and emits no `standalone/` output |

## 9. Known limits (honest list)

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
  certificate is installed; `desktop.yml` already threads the signing secrets.
- **macOS**: closing the window hides the app; **File → Quit** (⌘Q) really quits.
  Native, but surprising for Windows users.
- **`desktop-everything.json` is deliberately broad** (product decision). Narrow
  it for an untrusted-user scenario.
- **Verified where**: `cargo build`, `cargo test`, the packaging steps and the
  installer run on a Windows machine with the MSVC toolchain (this repo's
  environment). macOS/Linux installers are produced by `desktop.yml` on native
  runners.

## 10. Deferred, with the design already chosen

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
