# Changelog

Notable changes to Noema. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Noema was developed privately before its first public release, so versions
earlier than 1.4.0 are not catalogued here. What exists today is tracked row by
row in [`docs/FEATURE_MATRIX.md`](./docs/FEATURE_MATRIX.md), and what does not is
in [`docs/MISSING_FEATURES.md`](./docs/MISSING_FEATURES.md).

## [Unreleased]

### Security

- A stored bookmark URL is no longer rendered as a link without a scheme check.
  The editor's bookmark card took the stored `attrs.url` straight into an
  anchor `href`, so a document stored before the write-time href gate existed
  — or written through the MCP `append_blocks` tool, which does not run the
  document sanitiser — could put a hostile URL into the card's link target for
  every member who opened the page. A `data:` URL reached the `href` verbatim
  (a literal `javascript:` URL is neutralised by React itself; a `data:` URL is
  not). The stored URL now passes the shared href allowlist (`http`, `https`,
  `mailto`, `tel` and safe relative paths) before it reaches an `href` — in the
  editor as well as in the read-only renderer.
- **The rate limits and the IP allowlist no longer trust `X-Forwarded-For`
  blindly.** The number of reverse-proxy hops in front of the app is declared
  with `TRUSTED_PROXY_HOPS`, and without that declaration the forwarding
  headers are ignored entirely — a client can no longer buy a fresh budget
  (or slip past the allowlist) with a made-up `X-Forwarded-For`. With
  `TRUSTED_PROXY_HOPS=N` the Nth-from-last hop is used. The bucket store is
  bounded and prunes expired entries, and every rate-limited route that knows
  its caller additionally spends a **per-user** budget keyed on the
  session/API-token user id, which cannot be spoofed at all. The per-user
  budget lives in its **own** store, so a flood of forged client addresses
  cannot evict it and cannot reset an exhausted user window.

### Changed

- **Operational note:** without `TRUSTED_PROXY_HOPS` all clients of a scope
  share one budget, and a configured IP allowlist makes the admin/private
  surfaces answer 403 for everybody until the proxy is declared. Set
  `TRUSTED_PROXY_HOPS` to the number of proxies between the internet and the
  app (1 for a single nginx/Caddy). Because the IP allowlist lives in the Edge
  runtime, where `process.env` is frozen at build time, the variable has to be
  set for the **build**, not only for the start.

## [1.4.1] — 2026-10-17

Repository housekeeping after the first public release. No product behaviour
changed, and the desktop build is the same code as 1.4.0.

### Changed

- Sample URLs in the `src/lib` link fixtures and their JSDoc examples no longer
  name `noema.app`, a domain the project does not own. They use
  `https://noema.example.com`, which RFC 2606 reserves for documentation and
  which the rest of the suite already used.

## [1.4.0] — 2026-10-16

The first public release: the site, the desktop app, and the parity tracker.

### Added

- **Desktop app.** A Tauri 2 shell around a bundled Node runtime and an
  embedded PostgreSQL (PGlite), packaged as a per-user NSIS installer and an
  MSI. It needs nothing else on the machine, and keeps its database in
  `%APPDATA%\app.noema.desktop`. One codebase, two builds: the desktop is the
  site build with `NOEMA_STANDALONE=1`.
- **The workspace itself.** Nested pages, a TipTap block editor (callouts,
  toggles, columns, tables, equations, bookmarks, synced views, mentions,
  uploads), typed databases with Table / Board / List / Gallery / Calendar /
  Timeline / Chart views, filters, sorts, grouping, formulas, relations and
  rollups.
- **Collaboration.** Page comments with quotes and reactions, `@`-mentions,
  notifications, an inbox, version history with restore, and optional Yjs
  realtime with live cursors.
- **Projects, tickets and cycles.** A Linear-style tracker with workspace keys,
  labels, estimates, sub-tickets, relations, an activity log, Gantt timelines,
  milestones, sprints with burndown and velocity.
- **AI, on your own key.** Grounded workspace chat with streaming answers, an
  Ask AI block, database autofill, seven editor skills, and transcription —
  against any OpenAI-compatible provider, configured per workspace with keys
  encrypted at rest.
- **Sharing and administration.** Public page shares with password and expiry,
  per-member page permissions, guests scoped to what they were given, teamspaces,
  invitations by email, OIDC SSO, API tokens and a public REST API, signed
  webhooks, audit activity, and a data-and-privacy export.
- **Import and export.** Notion, Trello, Markdown, Markdown `.zip`, Word `.docx`
  and CSV imports; Markdown, JSON, HTML, CSV, PDF and whole-workspace `.zip`
  exports.
- **Five locales** (en, fr, es, de, ar) with correct `lang` and `dir`.

### Changed

- The desktop shell treats its port as a preference rather than a contract, so
  the app survives a port change without losing state.

### Fixed

- The accessibility focus ring no longer frames the writing area. ProseMirror
  carries `tabindex="0"`, so the global `:focus-visible` outline matched the
  editor body; the writing surfaces now opt out. A page is *written* there, and
  an accent box around the caret reads as a selection.
- The route progress bar no longer settles at 100% and then creeps back to a
  full bar. Trickling from an idle state could resurrect a finished bar; the
  interval is now cleared when the bar completes.

### Security

- Session cookies are HS256 JWTs in httpOnly cookies; passwords are bcrypt
  (cost 12). Every server action and API route re-derives workspace access from
  the session.
- `npm run check:secrets` fails on any credential-shaped value in a tracked
  file, and on any tracked `.env`.

[Unreleased]: https://github.com/Guembri01/noema/compare/v1.4.1...HEAD
[1.4.1]: https://github.com/Guembri01/noema/releases/tag/v1.4.1
[1.4.0]: https://github.com/Guembri01/noema/releases/tag/v1.4.0
