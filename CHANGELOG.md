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
- The "Authoring windows" check no longer fails for every pull request. It
  collected its commits with `git log --all`, and CI checks out with
  `fetch-depth: 0`, which fetches every branch — so the open Dependabot
  branches, authored by a bot, made the required check fail with identity
  violations that had nothing to do with the pull request under review. It
  now walks the commits of the ref under review. A commit that GitHub itself
  created is exempt as a whole — the anchor is its **committer** (an App
  account, or the `noreply@github.com` identity GitHub commits merges under),
  so neither its author field nor its committer field is checked, against
  either the date or the identity policy. The scope has to be the whole
  commit: the merge commit GitHub synthesises for a pull request is dated when
  GitHub rebuilt the ref and carries the *human's* address in its author
  field, so an exemption that only covered the field holding the bot address
  still failed the gate. The converse does not hold: a bot author with a
  human committer was not created by GitHub and is checked like any other
  commit. A human's no-reply address is not a bot and still has to pass.
- A failed AI call handed the workspace's provider key to the client. On a
  non-2xx answer the provider's error body was sliced to 200 characters and
  returned verbatim in the `error` field, and several OpenAI-compatible
  gateways (vLLM, LiteLLM, Ollama, Azure API Management) fill that body with
  the API key the request was sent with — "Incorrect API key provided:
  sk-live-…" — so anyone who could trigger a failed call saw the workspace's
  own key. A provider failure is now reduced to a class: the upstream status
  plus a stable code (`invalid_api_key`, `rate_limited`, …), and only a code
  that looks like an identifier is taken over, so a code can never be free
  text or markup. A code that carries the key we sent is refused as well — not
  only the whole key, but a run of eight of its characters in any spelling
  (masked, truncated, re-cased or a piece of it), because a provider does not
  choose such a spelling freely. The chat, skills and transcription routes answer
  with that class, the streamed chat answer carries it in-band, and the body
  itself reaches neither the client nor the server-side log — the log keeps the
  status and the same code as its anchor, plus the workspace, the provider and
  the model the call went to, so that a failure is attributable in an
  installation with several workspaces. A value is written only when it is
  safe to write: one that carries the key we sent is left out — the model can
  *be* the key when a deployment points it there — and so is a workspace id
  that is not an id of the app's own shape, because two of the AI routes take
  that id from the request body. Nothing else of the failure is written.
- A transport failure is a class as well. The runtime's own message can carry
  the request header — an invalid header value is reported as
  `Headers.append: "Bearer <key>" is an invalid header value.` — and that
  header carries the workspace's key. Scrubbing the message is not enough
  here: the scrubber knows a fixed set of credential shapes, and the tail of a
  key with an interior newline (`…def`) is no shape at all, so it survived
  every form-based scrubber and reached the client and the database. The model
  list, the chat call, the transcription and the streamed chat answer report
  "could not reach the provider" instead of the runtime's text; the streamed
  answer carries that class in-band *and* in the persisted assistant row.
  In that path neither the key nor any part of it leaves the server — not in
  the answer, not in the persisted chat row, not in the log. The log keeps the
  status and the code of a provider failure and the class of a transport
  failure, together with the workspace, the provider and the model the call
  went to, and nothing else.

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
