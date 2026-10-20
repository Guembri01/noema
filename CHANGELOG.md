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
- The site workflow no longer lets a pull request run with a token that can
  publish. The `image` job — the one that builds the container image — held
  `packages: write` (it pushes to GHCR) and `id-token: write` (it mints the
  OIDC token cosign signs with), and a pull request reached that job, so the
  pull request's own `Dockerfile` was built with a publishing token in hand.
  `actions/checkout` also left the token in `.git/config`, where the code the
  pull request controls could read it — a path from "any pull request" to "a
  tampered image in GHCR that every user of the published container pulls".
  The workflow is split in two now: the `image` job is the pull-request path
  (build linux/amd64, load it, scan it, smoke it) and holds `contents: read`
  and nothing else, the `publish` job is the only one that may push and sign,
  and its gate names the events that may publish — `push` and
  `workflow_dispatch` — so that no pull-request event can reach it, not even
  `pull_request_target`. Every checkout in the workflow uses
  `persist-credentials: false`, so the token does not outlive the checkout.
- A new gate, `npm run check:workflow-permissions` (and the test CI runs),
  keeps that from coming back. It fails when a workflow grants a publishing
  scope (`packages: write`, `id-token: write`) outside a job that no
  pull-request event can reach — the gate is evaluated, not matched, so
  `github.event_name != 'pull_request'` does not count: a
  `pull_request_target` event satisfies it — when a job a pull request can
  reach does not spell out its `permissions:` block, or when the checkout of
  such a job keeps its token on disk. `contents: write` is tracked separately
  as issue #65.
- The desktop workflow no longer runs pull-request code with a write token. It
  declared `contents: write` at the workflow level, so every job — the ones a
  pull request reaches included — held a token that `actions/checkout` kept in
  `.git/config` while `npm ci` ran the repository's own `postinstall`, with the
  Apple and Windows signing secrets in the same job's environment. A pull
  request opened from a branch of this repository that touched `package.json`
  could read the token and the signing keys (a pull request from a fork gets a
  read-only token and no repository secrets from GitHub in any case). The token
  is read-only everywhere a pull request can reach now, the write scope and the
  signing secrets live in a release job that only a tag push runs, and no
  checkout keeps its credentials.
- The desktop shell's broad capability gave the file-system plugin a scope
  covering the whole user directory (`$HOME/**` plus Desktop, Documents,
  Downloads, Pictures, Video and Audio) together with `remove`, `rename` and
  `copy` — a script in the web view could read, overwrite or delete the
  user's files. Nothing used the plugin's JavaScript face (the shell reads
  and writes its files server-side, in Rust), so the broad capability now
  grants no file-system permission at all; the app's own data directories
  stay covered by the narrow `fs:default` in the local-only `default`
  capability.
- The desktop shell's broad capability was bound to the **served** web app's
  origin as well as to the shell's own page. It carried `shell:allow-execute`
  for the bundled Node sidecar with `"args": true` — no argument checking at
  all — so any script running in that origin (an XSS in the app, or a page
  that grabbed the port first) could run arbitrary code as the desktop user.
  The broad set is now local-only, for the shell's own page; the served app
  gets its own capability with the five shell commands it calls and the two
  `core:event` permissions it needs to subscribe to the shell's menu events —
  no filesystem, shell, store, opener, dialog, `os` or `log`, and no
  `core:default` either (that set expands to an unscoped file-read plugin and
  to the menu/tray plugins, whose item ids the shell dispatches on raw).
- The release workflow now promotes the release tags only after the Trivy
  scan, the cosign signature and the container smoke test pass. The build
  pushes a staging tag first, so a failing scan cannot leave `latest`/`edge`
  pointing at a vulnerable image. The image also accepts
  `TRUSTED_PROXY_HOPS` as a build arg for the Edge middleware, and the compose
  stack passes it to both the build and the running container.
- The guest scope is now applied to every surface that hands workspace content
  to a `GUEST`, not only to the API routes. A guest could list, search, read
  and export every page and database of the workspace, including the ones
  never shared with them; the API and export routes resolve the role scope and
  filter on it, a page outside the scope answers 404, and a guest's export
  answers 403. The same question is now asked behind the UI: the server
  actions behind the page-content read, the page-snapshot list and restore
  plan, the page menu, the template gallery, the library and move page trees
  and the ticket pagination and activity trail refuse a page outside the
  scope; the library, trash and home pages list only the pages in it; the page
  route hands out neither the member directory nor a foreign database title;
  and the tracker pages (tickets, archived tickets, cycles, roadmap, projects)
  answer 404 for a guest, exactly like `GET /api/tickets` answers 403. The
  member directory and the workspace management reads (the member roster, the
  SMTP and AI configuration, the automations, the recurring schedules, the
  ownership history) ask the permission their write path already required. The
  datasets the page scope cannot narrow — tickets, discussions, calendar
  events — are role-gated on their routes. Still open (not covered by this
  branch): the MCP read tools (#105), the empty-`q` branch of the v1 search
  (#105's body describes the MCP route; the branch that closes the empty-`q`
  branch is B88), the AI grounding (#104), the workspace layout's chat and
  calendar payload (#69), the linked-database server actions (#107) and the
  asset route `/api/files/**` (#117). The workspace layout (#69) still hands a
  guest its chat threads, its calendar feeds and their private `icsUrl`, the
  open-ticket count, the project list and the teamspace names; that payload is
  a finding of its own.
- The MCP server's read tools now honour the guest page scope. A guest is a
  member of the workspace, so the endpoint's membership check passed and
  `search_pages`, `get_page`, `list_databases`, `query_database_rows`,
  `get_comments` and the `notion://` resource templates returned every page of
  the workspace — content included — to a guest who had been shared a handful
  of pages. The scope is resolved from the caller's role, exactly as the
  workspace UI resolves it, and a page outside that scope answers "not found"
  rather than "forbidden", so the endpoint cannot be used to find out which
  pages exist. The scope is bound in the query layer, so a blank search — the
  "recent pages" window — lists the guest's pages and not the workspace's. The
  same bearer token still authenticates `/api/v1/*`, where the page scope is a
  separate fix: MCP is not worse than before, it is strictly narrower.
- An API token can no longer widen the role that owns it. The scopes a token
  is allowed to use are capped by the caller's workspace role on every MCP
  request, so a guest's token cannot reach a write tool even when it carries
  an administrative scope. The stored token itself is unchanged — the same
  bearer token still authenticates `/api/v1/*`.
- The "Ask AI" grounding search honours the guest page scope. A guest's prompt
  is now answered only from the pages that were shared with them — page titles
  and text no longer leak from the rest of the workspace through the model
  context — while a member still grounds in the whole workspace.
- The workspace shell no longer hands a guest the workspace's chat log, its
  calendar subscriptions and events, the project list or the open-ticket count.
  Those datasets are workspace-wide rather than shared page by page, so they are
  now scoped by the viewer's role before they reach the client payload. The
  teamspace names are scoped rather than withheld: a guest sees the teamspaces
  their own pages live in — the sidebar draws a page under the section of its
  teamspace, so an empty list dropped the very pages that were shared with the
  guest — and not the workspace's other teamspaces, neither in the shell nor in
  the page route. The private calendar feed URL — the address of a personal
  calendar, which often carries a secret token in its path — stays on the
  server, which reads the feed itself. The sidebar offers a guest no action the
  server refuses: neither "new discussion" nor "connect a calendar".
- The asset route is now a full-member surface. `GET /api/files/**` asked only
  for workspace membership, so a guest could fetch any asset of the workspace
  by name; an asset cannot be scoped to a page (`Asset.pageId` is never
  populated), so the route is now reserved for full members and answers `403`
  to a `GUEST` — before the storage driver is asked, so the refusal carries no
  bytes, no asset `content-type`, no `etag` and no `cache-control`. A missing
  asset gets the same answer, so the route is no longer an existence oracle for
  a guest. A member still receives the file. **The consequence
  is deliberate and fail-closed: a guest reads the text of the pages shared
  with them, but none of their media** — every image block, the page cover,
  the page icon and every database attachment of a shared page now answers
  `403` for a guest, in the app and on the public share page `/s/[token]`.
  Still open (not covered by this branch): the asset-to-page link —
  `Asset.pageId` is never written, so "the assets of the pages shared with
  this guest" cannot be answered; until that link exists the surface stays
  closed to guests. A guest can still obtain the attachment bytes through the
  workspace export zip — that is a separate finding (B02, #16), not closed
  here.

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
