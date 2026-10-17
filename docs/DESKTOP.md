# Noema — Desktop (installable app) & Site (hosted) versions

One codebase, two shipped products:

| | **Site version** | **App version** |
|---|---|---|
| What | the hosted web app | the installable desktop app |
| Runtime | Next.js server + Postgres | Tauri 2 (Rust) shell + a supervised local Next server |
| Database | Postgres (pg_trgm + tsvector) | local database in the user's data directory |
| Build | `npm run site:build` → `next start`, or `docker compose up --build` | `npm run desktop:build` → NSIS/MSI/DMG/AppImage/deb/rpm |
| Update | redeploy the container | in-app updater (signed, `tauri-plugin-updater`) |
| Users | many accounts, workspaces, SSO | one local user, no account required |
| Entry | `npm run dev` / `npm run start` | `npm run desktop:dev` / `npm run desktop:build` |

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
│ Noema.app / Noema.exe                     (Rust, tauri 2)     │
│                                                               │
│  window (WKWebView / WebView2 / WebKitGTK)                    │
│    ▲  loads http://127.0.0.1:<port>                           │
│    │  window.__NOEMA_DESKTOP__ = { apiBase, dataDir, … }      │
│    │                                                          │
│  ┌─ shell ────────────────────────────────────────────────┐   │
│  │ sidecar supervisor  (src-tauri/src/sidecar.rs)         │   │
│  │  · picks a free loopback port                          │   │
│  │  · spawns `noema-server` with the data dir + env       │   │
│  │  · polls /api/ready until 200 (45 s budget)            │   │
│  │  · streams stdout/stderr → logs/noema.log + UI         │   │
│  │  · restarts with backoff if it dies (500ms…10s)        │   │
│  │  · stops it cleanly on quit (8 s grace)                │   │
│  ├───────────────────────────────────────────────────────┤   │
│  │ native: menus, tray, deep links (noema://), updater,   │   │
│  │ single-instance, window state, notifications, dialogs  │   │
│  └───────────────────────────────────────────────────────┘   │
│                          │ spawns                              │
│                          ▼                                     │
│  noema-server  (Node SEA single executable)                    │
│    Next.js standalone server, bound to 127.0.0.1:<port>        │
│    data dir: …/Application Support/app.noema.desktop/          │
│      noema.db  uploads/  logs/  backups/                       │
└───────────────────────────────────────────────────────────────┘
```

Why this shape:

- **No Node install required** — the server is a Node *Single Executable
  Application* (SEA), produced by `scripts/desktop/sidecar.mjs` and injected with
  `postject`. Tauri packs it as an `externalBin`, so the installer contains one
  server executable per platform.
- **Loopback only** — the server binds `127.0.0.1` on an ephemeral port chosen by
  the kernel. Nothing is reachable from the network, two installs can run side by
  side, and "which port?" is never a user-visible question.
- **The shell survives a dead server** — the window opens immediately on a small
  bundled page ("starting…") and swaps to the app once `/api/ready` answers. If
  it never does, the page offers **Retry** and **Open data folder** instead of a
  white screen.
- **Rust owns the OS, JavaScript owns the product.** No business logic is
  duplicated in Rust: the shell starts, supervises, exposes native power and gets
  out of the way.

## 2. Security model

| Concern | Decision |
|---|---|
| Server exposure | loopback only, ephemeral port, no `0.0.0.0` |
| Webview ↔ server | explicit `APP_ORIGINS` allow-list (the loopback origin), CSP in `tauri.conf.json` |
| Webview ↔ shell | only the commands in `src-tauri/src/commands.rs`; the IPC bridge is a frozen object (`Object.freeze`) |
| Capabilities | `default.json` = least privilege for boot; `desktop-everything.json` = the broad set the product asked for (filesystem, dialogs, shell, notifications, updater, deep links, tray). Drop `desktop-everything` from `security.capabilities` for a hardened build |
| Secrets | never in the bundle; the app is local, so there is nothing to sign in to |
| Telemetry | off (`NEXT_TELEMETRY_DISABLED=1`, no crash reporting by default) |
| Updates | signed artifacts only (`TAURI_SIGNING_PRIVATE_KEY` in CI); the pubkey lives in `tauri.conf.json` |
| Supply chain | `npm ci` with a lockfile, `cargo` with a lockfile, CI builds from tags |

## 3. Data, backup and portability

The app is local-first, so data ownership is explicit:

```
<data dir>/
  noema.db        the database
  uploads/        uploaded files (served by /api/files/…)
  logs/           noema.log (rotated), plus the shell's own lines
  backups/        automatic backups, pruned by /api/cron/backups
```

- **Data dir** — `app.path().app_data_dir()`; `NOEMA_DATA_DIR` overrides it (portable installs, CI, "put my notes on an external drive").
- **Backup** — *Data → Back up now* (`Cmd/Ctrl+Shift+B`) or `shell://backup`; retention is the configurable policy in `src/lib/backup-retention.ts`.
- **Move to another machine** — copy the data dir; the database is a single file.
- **Leave the app** — every export path is shared with the site version (Markdown, HTML, CSV, workspace zip).

## 4. Building it

```bash
# 1. one-time: prerequisites (Node 20+, Rust stable, platform webview deps)
npm run desktop:preflight      # tells you exactly what is missing, with the fix

# 2. icons (generated from one 1024 px source, never hand-edited)
npm run desktop:icons          # npx tauri icon assets/icon.png

# 3. develop: web dev server + the shell, hot reload on both sides
npm run desktop:dev            # beforeDevCommand starts `next dev --port 3200`

# 4. build the sidecar + installers
npm run desktop:sidecar        # Next standalone → dist/sea-prep.blob → src-tauri/binaries/
npm run desktop:bundle         # NSIS + MSI + DMG + AppImage + deb + rpm
```

`NOEMA_SIDECAR_MODE=shim` builds a development shim that uses the system `node`
instead of the SEA binary — useful when you are iterating on the server.

### The one flag that splits the outputs

`next.config.ts` turns on Next's standalone output **only** when
`NOEMA_STANDALONE=1`:

```ts
...(process.env.NOEMA_STANDALONE === "1" ? { output: "standalone" as const } : {}),
```

The site build (`next start`, the Docker image) therefore behaves exactly as
before, and the desktop sidecar opts in. `site.yml` asserts this invariant in CI.

## 5. Release process

1. Bump the version in **both** `package.json` and `src-tauri/tauri.conf.json`
   (they must match; the updater compares against `tauri.conf.json`).
2. Tag: `git tag v1.4.0 && git push --tags`.
3. `desktop.yml` builds four targets (win-x64, linux-x64, mac-arm64, mac-x64),
   runs `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test`, signs the
   artifacts, and opens a **draft** release with the updater manifest
   (`includeUpdaterJson`).
4. Review the draft, then publish. Installed apps pick the update up on next
   launch (or immediately via *Help → Check for updates…*).
5. `site.yml` publishes the container image to GHCR and runs the compose smoke
   test against `/api/ready`.

## 6. Testing

| Layer | What runs |
|---|---|
| Rust (shell) | `cargo test` — data-dir layout, loopback URL shape, SQLite URL normalisation, env contract, restart backoff, free-port behaviour, layout creation (in `src-tauri/src/sidecar.rs`), log ring buffer (`logging.rs`) |
| Rust (quality) | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` |
| Shared TS | the whole existing suite — the app version adds **no** forked logic |
| Runtime mode | `src/lib/runtime-mode.test.ts` (site vs desktop, API base, data dir, version, capabilities, SSR safety) |
| Packaging | `desktop:preflight` on every run; `site.yml` asserts the site build never emits `standalone/server.js` |
| Manual smoke | launch, wait for the window to swap in, create a note, quit, relaunch (state + window geometry restored), pull the network cable (app keeps working) |

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Window stuck on "Noema is starting…" | sidecar crashed | Retry button, then `logs/noema.log`; `Data → Restart local server` |
| `noema-server` missing at build time | sidecar not built | `npm run desktop:sidecar` (needs `postject` for SEA, or `NOEMA_SIDECAR_MODE=shim`) |
| `cargo` not found | no Rust toolchain | <https://rustup.rs> |
| Linux: `webkit2gtk` errors | missing native deps | see the apt line in `desktop:preflight` output |
| Icon error while bundling | icon set not generated | `npm run desktop:icons` |
| Two copies fight over data | same data dir | set `NOEMA_DATA_DIR` per install |

## 8. Known limits (honest list)

- **Verified here:** the shared TypeScript core, the runtime-mode switch, the
  preflight script, the CI configuration, and every existing test suite. **Not
  verified here:** `cargo build`/`cargo test` and a real installer — this machine
  has no Rust toolchain, so the Rust crates and the bundling steps must be
  compiled on a machine with `rustc`/`cargo` (or in CI, which is set up to do it).
- The SEA sidecar needs `postject`; it is not vendored (no dependency was added to
  `package.json`), so the first build asks you to `npm i -D postject` or to use
  the shim.
- Local-mode database choice: the shell passes a `file:` SQLite URL
  (`DATABASE_URL`). The schema currently targets Postgres features (full-text
  search, `pg_trgm`), so a SQLite local mode needs a schema decision
  (`docs/specs/engineering-hardening.md`) or the embedded-Postgres sidecar
  documented in §9.
- macOS: closing the window hides the app; **File → Quit** (⌘Q) really quits.
  That matches the platform convention but surprises Windows users.
- `desktop-everything.json` is deliberately broad (product decision). Narrow it
  before shipping to an untrusted-user scenario.

## 9. Deferred, with the design already chosen

- **Embedded database without Postgres** — either a SQLite-compatible Prisma
  schema (drop `tsvector`/`pg_trgm`, use the pure `src/lib/fts.ts` ranking) or ship
  a small Postgres as a second sidecar (bigger installer, closer parity). The
  shell already isolates the choice to one env var (`DATABASE_URL`).
- **Code signing** — Windows (EV/OV certificate) and macOS (notarisation) secrets
  are wired into `desktop.yml`; the certificates themselves are procurement.
- **Portable build** — `NOEMA_DATA_DIR=./data` next to the executable gives a
  portable install; a dedicated `desktop:portable` target is a small addition.
- **Crash reporting** — the `crash-reporting` cargo feature exists, off by
  default.
