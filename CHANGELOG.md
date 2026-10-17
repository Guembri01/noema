## [Unreleased]

### Security

- The "Authoring windows" check no longer fails for every pull request. It
  collected its commits with `git log --all`, and CI checks out with
  `fetch-depth: 0`, which fetches every branch — so the open Dependabot
  branches, authored by a bot, made the required check fail with identity
  violations that had nothing to do with the pull request under review. It
  now walks the commits of the ref under review. GitHub's own automation is
  exempt, because an App account commits at its own clock and the merge
  commit GitHub synthesises for a pull request is dated when it rebuilt the
  ref; a human's no-reply address is not a bot and still has to pass.

- The unlock state of a password-protected share link is no longer a client
  cookie whose value is the constant `"1"`. Any client could send
  `Cookie: share_<token>=1` and read the protected page — the password was
  never enforced. The value is now an HMAC-SHA256 over the share token and an
  expiry, keyed by `AUTH_SECRET` under its own domain separation, and it is
  verified server-side in constant time. Every verification path fails closed.

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

- The desktop shell's broad capability gave the file-system plugin a scope
  covering the whole user directory (`$HOME/**` plus Desktop, Documents,
  Downloads, Pictures, Video and Audio) together with `remove`, `rename` and
  `copy` — a script in the web view could read, overwrite or delete the
  user's files. Nothing used the plugin's JavaScript face (the shell reads
  and writes its files server-side, in Rust), so the broad capability now
  grants no file-system permission at all; the app's own data directories
  stay covered by the narrow `fs:default` in the local-only `default`
  capability.

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

- A stored file URL is no longer rendered as a link without a scheme check.
  The FILES property value and the media "file" block took a user-controlled
  URL straight into an anchor `href`, so a stored `javascript:` URL ran in the
  app's origin for every member who opened the table or the page. Every
  stored URL now passes the shared href allowlist before it reaches an `href`
  (`http`, `https`, `mailto`, `tel` and safe relative paths).

- The `URL:` property of a subscribed calendar feed was stored as it came and
  rendered as a link in the meetings sidebar. A feed is third-party input, so
  a `javascript:` URL in it became a live link in the app's own origin — a
  click on an event title ran attacker-controlled script. The parser now keeps
  only `http`, `https`, `mailto` and `tel` URLs (and relative paths) and drops
  every other scheme before the value is stored, and the sidebar checks the
  scheme again before it builds the `href`, so an event stored before the fix
  can no longer become a link. The stored value is checked again on the way
  out: the calendar API and the ICS export leave out a URL that is not on the
  allowlist, so it never leaves the server — neither as a link, nor in the
  API response, nor in the downloaded feed.

- `GET /api/invites` enforced workspace membership only, while its own contract
  said "admins only": a guest or a plain member received `200` with an empty
  delivery list instead of a `403`. The route now asks the role matrix
  (`inviteMember`, i.e. owner/admin) before it lists anything and answers
  `403 Forbidden` to everyone below admin, so the endpoint no longer relies on
  the second, weaker gate inside `listEmailDeliveries` to stay closed.

- The "Ask AI" grounding search honours the guest page scope. A guest's prompt
  is now answered only from the pages that were shared with them — page titles
  and text no longer leak from the rest of the workspace through the model
  context — while a member still grounds in the whole workspace.

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

- The link preview no longer follows a redirect into an internal service, and
  no longer believes a hostname that points at one. The route checked only the
  literal hostname of the requested URL and then fetched it with
  `redirect: "follow"`, so a name like `169.254.169.254.nip.io` and a `302`
  to `169.254.169.254` both reached the cloud metadata address; the fetched
  title and description were reflected into the preview card, and the internal
  URL became the card's image — a request the victim's own browser then made.
  The route now uses the shared guard (`safeFetchGuarded` in
  `src/lib/feed-guard.ts`): the target is resolved through DNS and every
  answer must be public, redirects are followed manually with every hop
  re-validated, and the URL the response was finally read from is checked
  again. The card's image and icon go through the same gate, because the
  browser fetches them. A refused target answers `400 "Blocked host"`.

- An outbound webhook can no longer be pointed at an internal service. Only
  the URL scheme was checked when a hook was created, so a workspace admin
  could store `http://10.0.0.5:8080/admin` and every later page edit made
  the server POST to that internal host — and the HTTP status ended up in the
  delivery log, which turned the webhook settings into a status oracle for
  the internal network. The target is now checked when the hook is created
  and again before every delivery attempt: private, reserved and cloud
  metadata addresses are refused, including host names that resolve into
  private space (DNS rebinding). A refused target is never contacted, and its
  delivery record carries no status code, so the delivery history leaks
  nothing about the internal network. Every refusal answers the same
  message. The production default refuses a loopback target as well; an
  operator who really has a receiver on the same machine can open the
  loopback range explicitly with `NOEMA_ALLOW_LOOPBACK_TARGETS=1`, and that
  opt-in covers the loopback range only — RFC1918, link-local, cloud metadata
  and `.internal`/`.local` names stay refused.

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

- The sign-in, the sign-up and the 2FA check are now rate-limited, counted
  and locked out. They are server actions, so they never reached the API rate
  limit: the password could be guessed as fast as bcrypt allowed, no failure
  was ever counted, and the two-factor code — three valid ones per 30-second
  window — could be searched at will. Every attempt now costs a budget per
  client address and one per account, the account budget keyed on the
  submitted e-mail address, which a client cannot forge; the two-factor
  guesses have a budget of their own. Five consecutive failures lock the
  account for 15 seconds, the lock doubles with every further failure up to
  15 minutes, and a successful sign-in clears both. The counter and the lock
  live on the account (`User.failedLoginCount`, `User.lockedUntil`, added by
  the migration `20260115000000_auth_lockout`), so they survive a restart.

- The lock belongs to the account and not to the client address, so a
  deliberate run of failed sign-ins locks the account of the person being
  targeted. The sign-up shares the account budget with the sign-in (both are
  keyed on the submitted address), so a sign-up naming someone else's address
  also spends that address's sign-in budget. That is a property of the model,
  named here so operators know it before they meet it.

- The Playwright end-to-end suite signs in about ninety times, mostly as the
  same seeded account from the same address, so it now exhausts the new
  budgets and is refused from the eleventh sign-in on. The suite is not part of
  CI and needs a running application and a database, but it is a documented
  gate of the repository — the budgets have to be raised for it, or the suite
  has to use more than one account, before `npm run e2e` is green again.

- An OAuth authorization code could be exchanged more than once. The token
  endpoint read the code, checked the `used` flag and only afterwards marked
  the code as used with a second statement, so requests that ran in parallel
  all passed that check and every one of them received its own access token —
  one captured code, many live API tokens. The code is now consumed with a
  conditional update (`UPDATE … WHERE used = false`), and a token is minted
  only when that update matched exactly one row; the loser of the race is
  answered with `invalid_grant`, as RFC 6749 §4.1.2 requires. A refused
  exchange — a wrong client, a wrong redirect URI, a wrong PKCE verifier —
  still leaves the code untouched and usable.

- The sign-up and the sign-in no longer disclose whether an address is
  registered. The sign-up named the situation outright ("An account with that
  email already exists."), the sign-in skipped the password comparison
  altogether when no account existed and so answered in a fraction of the time,
  and a wrong two-factor code carried a message of its own — three channels
  that turned the login form into an account-existence oracle. A sign-up now
  answers with one neutral text for every way it can fail: an address that is
  already taken answers exactly like a sign-up that loses the race against a
  concurrent sign-up for the same address. The sign-in always runs a bcrypt
  comparison — against a dummy cost-12 hash when the address is unknown or
  the stored value is not a bcrypt hash — so it costs the same whether or not
  the account exists, and every failed sign-in answers with the same text, a
  wrong two-factor code included.

- The sign-in and sign-up actions never consulted the strategy registry, so
  `AUTH_PASSWORD=disabled` and the `AUTH_STRATEGIES` allow-list were enforced
  by the two SSO routes only: a deployment that had switched the local password
  strategy off still accepted a direct POST to `/login` and `/signup` with the
  credentials of a local account. Both switches are now enforced by the
  actions themselves — with the password strategy off, every sign-in and every
  sign-up is refused before an account is looked up — and `AUTH_PASSWORD` and
  `AUTH_STRATEGIES` are documented in `.env.example`, the README and
  `SECURITY.md`.

- An admin could invite further admins. The role matrix grants an actor only
  the roles strictly below their own — an admin hands out member and guest,
  and only the owner grants the admin role — but the invitation path never
  consulted it: it checked the role against a hard-coded list, persisted it
  unchanged, and `POST /api/invites` had the same gap. An admin could
  therefore mint an invitation that turned its recipient into a workspace
  admin, exactly the escalation the role change path refuses. The role an
  invitation carries is now a grant like any other: `sendWorkspaceInviteAction`
  asks the matrix (`canGrantRole`) before it writes anything, so only the
  workspace owner can invite an admin and an admin is refused with `Only the
  workspace owner can invite an admin.`

- The workspace export and the trash purge now refuse storage keys that belong
  to another workspace. A page can reference an upload of a different
  workspace — a URL that leaked through a share link, a copied image — and the
  export bundled every `/api/files/…` reference it found, so another tenant's
  bytes ended up in the zip; purging that page then deleted the other
  tenant's file from storage. A storage key is now accepted only when it
  belongs to the workspace being exported or purged, so a foreign reference is
  skipped and a foreign upload is never removed. The check fails closed: a
  caller that cannot name its workspace gets nothing.

- Uploads are written owner-only — a `0600` file inside a `0700` directory —
  instead of the umask default, so no other user on the host can read another
  tenant's uploads. The mode is applied when the file is created: uploads
  written before this change keep the permissions they were created with and
  have to be rewritten to get the new ones.

- The share-link unlock endpoint now has a rate limit whose scope names the
  share link, and it counts failed password attempts per share token, so a
  share password can no longer be brute-forced by rotating the forwarded IP.
  A link is locked for 15 minutes after 10 failed attempts, and no password is
  compared at all while it is locked.

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

- **The REST API enforces the scope grant of the bearer token.** The
  `/api/v1/*` routes check the scopes the token was granted: a token without
  `read:pages` (respectively `write:pages`) gets `403 insufficient_scope`
  instead of full access. The scope check runs *before* the workspace check, so
  a token without the scope gets `403` without any information about the
  workspace.

- **OAuth tokens carry an explicit scope list.** The token endpoint mints the
  token with the read and write scopes of the catalogue (without
  `admin:workspace`) and returns that list in the `scope` field of the
  response, instead of the hard-coded `"read write"`. Such a token can now
  also be used on the MCP transport (`/api/mcp`), which checks the same grant:
  before, the empty grant it carried was refused by every MCP tool.

- **The settings UI stores the scopes it asks for.** A token created on
  `/w/[slug]/settings` used to be persisted without any scope at all, so it
  would have been unable to call the API once the grant was enforced. The
  picked scopes are now stored with the token.
**Note for existing tokens:** a token that was created without a scope keeps
its (empty) grant — no migration hands out permissions behind the operator's
back — so it has to be re-created with the scopes it needs. Until then it is
refused with `403 insufficient_scope` by every `/api/v1/*` route; the token
list marks it as **No access**.

- The two-factor seed is now sealed at rest (AES-256-GCM, `v1:iv:tag:payload`,
  key derived from `AUTH_SECRET`) instead of being stored in cleartext in
  `User.twoFactorSecret`; a database dump no longer yields a usable 2FA seed.
  Existing plaintext seeds are re-sealed on the next sign-in or re-enrolment,
  and a one-off backfill (`npm run backfill:2fa`) seals the rows that are still
  plaintext — it never deletes or overwrites a row it cannot seal, and it
  writes nothing at all unless it can prove that the `AUTH_SECRET` of this
  environment is the key the app uses: it probes the sealed AI-provider keys
  and the sealed SMTP password for that (the same `AUTH_SECRET` seals them),
  and an operator who has verified the key by hand can pass `--confirm-key`.

### Changed

- The app's own write path accepts only the app's own `/api/files/...` asset
  URLs for a FILES value. A FILES entry whose URL is not an app-owned asset
  path is therefore **removed** from the cell the next time a file is
  attached to it, without a notice. Such an entry can come from a client
  that writes the property directly (the API or the MCP tool) — the entry is
  never rendered as a link, whatever wrote it.

- The MCP `update_property_value` tool writes a FILES value again. A write
  gate that accepted only app-owned asset URLs made the tool refuse every
  FILES value, because the MCP surface has no upload tool and therefore
  cannot produce such a URL. The render gate is the security boundary
  instead: a stored `javascript:`, `data:` or protocol-relative URL never
  becomes an anchor, whichever client wrote it.

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
