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

- The AI proxy routes `/api/ai` and `/api/ai/skills` resolved a workspace's
  stored provider — its endpoint and its decrypted API key — for whatever
  `workspaceId` the client sent, so any signed-in account could name a
  workspace it did not belong to and have the server call that workspace's
  provider with that workspace's key and token budget. A workspace's provider
  is now used only when the caller actually has access to that workspace; the
  environment configuration applies otherwise, and the foreign provider row is
  not even read. Both routes validate their request body with Zod as well, so
  a `mode` outside `ask` / `summarize` / `autofill`, or a body that does not
  fit the schema, is refused with 400 before the request reaches the provider.
  The id format is deliberately not part of that check: a foreign or malformed
  workspace id is answered by the access check, not by a 400.

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
