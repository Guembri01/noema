# Roadmap

Ordered by dependency and impact. Every item maps to rows in
[`FEATURE_MATRIX.md`](./FEATURE_MATRIX.md).

**How to read this roadmap (2026-10-15):**

- **Marks:** `[x]` delivered · `[~]` delivered in code but its matrix row still reads
  🟡/🧭 — queued for maintainer re-verification (counts/`docs:gaps` are
  maintainer-owned; **where this file and the matrix disagree, the matrix wins**) ·
  `[ ]` not built.
- **Status:** **174 ✅ / 89 🟡 / 286 🧭 / 14 ⛔ of 563** feature rows — 375 still open.
- Known drift of this class was already confirmed by spec audit B21: the formula /
  relation / rollup engines, version history, the REST API + tokens, webhooks + OAuth
  apps, 2FA + rate limiting and much of the import/export suite exist in `src/**` while
  their matrix rows still read 🧭. Those rows are re-verified by the maintainers, not
  flipped by this document.

## Milestone 0 — Foundation (done)

- [x] Auth, workspaces, roles
- [x] Nested page tree, icons, favorites, trash
- [x] TipTap block editor with autosave, `/` menu, version snapshots
- [x] Databases: properties + Table/Board/List views (renderers ship; see `[~]` note in M2)
- [x] Full-text search (now Postgres FTS), comments (threaded), dark mode
- [x] Prisma domain model, Docker Postgres, seed script, docs

## Milestone 1 — Editor depth

- [x] Block hover handle + pointer drag-and-drop reordering (TipTap drag handle)
- [x] Selection bubble menu (bold/italic/underline/strike/code/link)
- [~] Text color + highlight marks — renders; palettes still limited (matrix 🟡)
- [x] Keyboard-driven `/` slash menu (tiered ranking shipped in the first block pass)
- [x] Callout (in-block emoji picker verified) · toggle (state proven to persist by e2e)
- [~] Columns (2/3/4/5), simple table block, table of contents — render; add/remove-column
  UI, header styling and scroll-spy are thin (matrix 🟡)
- [~] Inline + block equations (KaTeX) — render; edit/preview UX rough (matrix 🟡)
- [~] Inline mentions (@person, @page, @date) — picker inserts; scoping/formatting partial
- [x] Image/File uploads (local disk) with captions + alt text · [ ] drag-to-resize/align ·
  [ ] S3 driver (see M8)
- [~] Breadcrumb block — renders; deep-tree linking rough (matrix 🟡)
- [~] Embeds + bookmark cards (YouTube, Vimeo, Loom, Spotify, SoundCloud, Figma, CodePen
  recognized; SSRF-guarded link preview) — generic sandboxed iframe path, provider
  allowlist pending (matrix 🟡)
- [x] Synced block / source marker — source link, same-page live propagation, cross-page refresh, detach (matrix ✅); synced *view* is the separate page embed
- [ ] Ask-AI **block** (matrix 🧭) · [~] Ask AI in the selection toolbar + block menu
  (ask/summarize/translate via the docked chat; matrix 🟡)
- [~] Page settings: full-width (works, persisted) · [ ] small text + page fonts
- [x] Paste/drop file handling + copy/cut/paste cross-page fidelity (B02) ·
  [ ] markdown-shortcut / mention / emoji completeness (B18 in flight; matrix 🟡)
- [x] Undo/redo surfaced in UI + restore-deleted-block via snapshot + Undo toast (B03)
- [x] Block context menu (turn-into complete vs Notion, nine-tint block backgrounds)
- [x] Notion-style caret + selection styling
- [x] First-round editor polish: code-block language picker (35 languages) + syntax
  highlighting (B01), nested text-colour fix (B03)

## Milestone 2 — Databases complete

- [x] View tabs + add-view menu + per-view type switcher (TABLE ↔ BOARD/LIST/GALLERY/
  CALENDAR/TIMELINE/CHART)
- [x] Per-property menus (rename, duplicate, delete)
- [~] Open row as page (route + editor + comments work; properties strip + breadcrumb
  pending, matrix 🟡) · [~] List/Gallery/Calendar/Timeline/Chart renderers (they render
  from `view-renderers.tsx` / `timeline-chart-views.tsx`; matrix rows still 🧭 — B15-class
  re-verification)
- [x] Filters (flat conditions + match all/any, operator catalogue) and sorts (priority
  keys, ↑/↓, rows-without-value last) persisted per view
- [~] Grouping + conditional/row colour rules (Colour/Group controls live in the view
  toolbar; matrix rows 🧭) · [ ] AND/OR filter *groups* + nested trees (tree is
  unit-tested and ready; UI pending)
- [x] Per-view configuration (B15: filters/sorts/group/colour/visible columns/frozen
  column all survive reload — this was the `[ ] view config` line)
- [~] Formula properties + unique ID + system properties + relations + rollups (14
  aggregation functions) — engines exist (`src/lib/formula.ts`, `rollup.ts`, schema
  FORMULA/RELATION/ROLLUP) while matrix section 5 reads 0/16 (B21's audit finding) →
  re-verify, then deepen per `relations-rollups.md` / `formula-engine.md`
- [x] Row side-peek (labelled property panel with inline editors) · [ ] sub-items,
  dependencies, calculations footer
- [~] Database templates (create-from-template + template manager wired) — matrix 🧭
- [x] Linked databases (source-view binding, filters/sorts, per-node synced/detached
  overrides, stale-id fallback, detached-only in-block filter/sort editing, and
  create/edit/delete rows through the existing database actions + authz)
  · [~] recurring templates (`POST /api/cron/templates`, fail-closed materializer;
  matrix 🧭 pending scheduler rows) · [x] view config (above)
- [~] CSV import/export (Export/Import CSV live in the full-page database toolbar +
  `src/lib/importers.ts`; matrix section-3 rows 🧭)
- [ ] Database lock · [~] button properties (per-row button config UI exists) + basic
  automations (template cron)
- [x] First database round (B15, 13 flips): sticky first column, freeze/show-hide
  columns, delete/restore rows via the *Deleted rows* panel, keyset pagination on the
  ticket tracker, stale-write race fix in `setViewConfig`, soft-delete semantics for rows

## Milestone 3 — Collaboration & sharing

- [~] Realtime multiplayer — the opt-in Yjs relay runs (`npm run collab` +
  `NEXT_PUBLIC_COLLAB_URL`, TipTap collaboration extensions), **but** B09's spec audit
  found `collab-server.mjs` has zero auth and memory-only docs; matrix rows stay 🧭 until
  **CRDT M1 (security slice)** ships (M6 below)
- [x] Inline block comments with anchors, reactions, mentions, resolve/replies ·
  [ ] suggestions mode (matrix 🧭; diff overlay needed)
- [~] Share links (read-only, optional password + expiry at `/s/[token]` + `/unlock`) and
  per-member READ/EDIT permissions — matrix section 8 still reads “public web link 🧭 /
  password 🧭 / per-page permissions 🧭” → re-verify; **anonymous publish-to-web** [ ]
- [x] Teamspaces / wiki (creation, membership, email invitations, sidebar grouping,
  per-page assignment) · [x] guests (scope proven by an e2e: shared page opens, private
  page 404s and never appears in search) · [~] transfer pages between workspaces (matrix 🧭)
- [x] Per-workspace AI provider settings (OpenAI / DeepSeek / Gemini / custom, model list,
  encrypted key, test connection)
- [x] Playwright end-to-end suite — grown from the original 11 tests to a ~57-test full
  suite, `workers: 1` against the shared demo DB, quarantine list + one-rerun policy,
  targeted `-g` runs in the inner loop; **B16** root-kills the remaining spec-side flakes
  and sets the clean-suite baseline
- [x] SMTP email: per-workspace config, client/guest invitations, delivery log, verify +
  test send (`npm run check:mail` against a mock SMTP server)
- [x] Projects & milestones (progress, Gantt timeline, attach notes, client invites)
- [x] **Tickets** (issues): labels, estimates + rollups, start/due dates → timeline,
  board/list/timeline views, relations, comments, activity log, bulk edits, from-page
  creation, `GET/POST /api/tickets`
- [x] Chat: draft-first threads, note-pinned discussions, `/ask` grounded replies,
  **streaming answers** (`/api/chat/stream`, `check:chat-stream`) + **Regenerate**
- [~] Version history slide-over (author, summary, delta, restore — `version-history.tsx`)
  — matrix section 10 reads 0/9 → re-baseline; B30's *version history v2* spec is drafted
- [x] Workspace chat (discussions with messages; sidebar Chat tab + `GET/POST /api/chat`)
- [x] Calendar subscriptions (ICS import + refresh; sidebar Meetings tab) ·
  [ ] two-way Google/Outlook OAuth sync (matrix 🟡 — ICS read-only today)
- [~] Backlinks / linked references (`Backlinks` component + `getBacklinks` query exist;
  matrix 🧭)
- [~] Notifications inbox UI (route + sidebar entry exist; per-user delivery preferences
  and digests still [ ], matrix 🧭)
- [~] Following pages (follow control in the topbar; matrix 🧭)

## Milestone 4 — Platform

- [~] Import/export: Markdown + JSON + HTML (pages), CSV (databases), Markdown import,
  bulk workspace export (.zip) — `/api/export/{page,database,workspace}` +
  `src/lib/importers.ts` ship while matrix section 12 reads 0 done → re-baseline
- [~] PDF export · Trello + Markdown-archive + Word (.docx) import · Notion-API import
  (`POST /api/import/notion`, integration token + nested pages) — same re-verify
- [~] Public REST API (`/api/v1`: pages, search, workspaces) + API tokens (hashed) +
  token management UI — matrix 🧭; spec `integrations-api.md` (B24) now on disk
- [~] Webhooks (HMAC `x-noema-signature`, delivery log + retries) · OAuth apps
  (authorization-code flow → API tokens) — matrix 🧭, re-verify
- [ ] Object storage — the S3-compatible driver is written and unit-tested (AWS4 signing,
  `check:storage`) but uploads still go to local disk · [ ] scheduled backups + documented
  restore rehearsal · [x] audit-log UI (Settings → Activity; the structured
  sensitive-action row stays 🧭) → **M8**
- Performance: [x] Postgres full-text (`searchText` mirror + GIN/`tsvector`, `ts_rank`,
  prefix type-ahead, `ts_headline`; `check:search` 9/9) · [~] pagination (tickets
  keyset + *Load more*; databases bounded) · [ ] caching
- [~] 2FA (TOTP, RFC-6238-vector-tested) + API rate limiting (`src/lib/rate-limit.ts`) —
  matrix 🧭, re-verify · [x] SSO via OIDC (authorization-code + JWKS, JIT provisioning,
  `SSO_*` env) · [ ] **SAML** — spec done (`saml-sso.md`), implementation **T10.1** → M6 ·
  [~] secret handling (env + AES-256-GCM provider keys; vault story planned)
- [x] AI: provider route (OpenAI-compatible incl. DeepSeek) + Ask AI (selection/block
  menu, ask + summarize) · [~] AI autofill property (wired in the database UI + `/api/ai`
  `autofill` mode; matrix 🧭)
- [x] AI: workspace grounding (keyword extraction + relevance-scored pages) · AI skills
  (`POST /api/ai/skills`) · prompts centralised in `src/lib/ai-skills.ts`
- [~] AI transcription (`POST /api/ai/transcribe`, own provider key; matrix 🟡)
- [x] Verification scripts: `check:ai` (live provider, 7/7 skills), `check:routes`,
  `check:ui`, plus `check:mail` / `check:search` / `check:tickets` / `check:chat-stream` /
  `check:storage` / `check:a11y`
- [x] i18n/RTL (5 locales + direction + app chrome, coverage ratchet ≥ 71 files in the
  coherence gate) · [x] responsive mobile shell + focus rings/skip link · [x] WCAG audit
  (`npm run check:a11y`)
- [x] Home template gallery (empty page/database + 6 workflow templates + other templates;
  `POST /api/templates`)
- [x] Sidebar chrome (Home/Chat/Meetings tabs, search with Ctrl K, Library, Teamspaces,
  Private pages, Add, Customize) + Library page

## Milestone 5 — Parallel work phases (Oct 2026)

- [ ] **Phases 1–3 land:** B11 (Actions ⋯ closeout), B17 properties family (13 partials),
  B18 editor micro-slice, B19 sharing/permissions, B20 media/embeds · unit net B33–B36 ·
  e2e net B38–B41 · feature slices B42–B44 (trash restore + permanent delete, command
  palette, favorites section) — fast gates + targeted e2e per change; one full-suite gate
  plus a docs regeneration when each phase lands.
- [ ] **Phases 4–5 land (audit remediation):** B29 navigation spec · B45 focus traps ·
  B46 a11y audit · **B53 collab-server M1 auth** (audit C1) · B54 session list + revoke ·
  B57 template-cron D3/D4/D7 · B58 AI draft/regenerate-loss · B59 href-XSS + calendar-SSRF
  · B60 guest scoping + upload hardening (queued behind B42) · B55 export hardening ·
  B56 webhook outbox.
- [x] Spec cycle **done** — all 12 specs on disk: realtime-collab, saml-sso,
  relations-rollups, formula-engine, import-export, integrations-api, ai-surface,
  plans-licensing, automations, engineering-hardening, templates, version-history-v2.
- [x] Documentation published — README refresh (B47), REST API reference (B48, 31
  endpoints).
- [ ] **B16** — spec-side flake cleanup + DB pollution + **one quiet-window full-suite
  baseline** (3 consecutive green runs, or one green + documented reasoning): the reference
  every later phase is judged against. Still queued — it needs a quiet window.
- [ ] **Status pressure:** convert the **89 🟡 partials** to ✅ first — they are
  wiring/test gaps, not greenfield (change-size cap: 2–3 rows or 1 refactor).

## Milestone 6 — Collaboration security & SSO depth (Oct–Nov 2026)

- [ ] **CRDT M1 — security slice** — **chartered as B53** (phase 4):
  server-side room-join authz in `collab-server.mjs` (session + workspace membership +
  guest page scoping, fail-closed, no existence oracle) per `realtime-collab.md` §M1 and
  the audit's C1 critical. Gates the matrix's multiplayer/presence/cursor rows.
- [x] **SAML T10.1 (env-level slice)** — `@node-saml/node-saml`, start/ACS/metadata/SLO,
  signed RelayState, `SamlAssertionSeen` replay cache, JIT/linking and real signed-fixture
  tests [R10.1, R10.2, R10.3, R10.4, R10.5, R10.6, R10.14, R10.16].
- [x] **SAML T10.2/T10.4** — `SsoConnection` persistence, admin CRUD actions, signed
  connection-aware RelayState, `?connection=` start/metadata/ACS, group→role mapping and
  workspace auto-join.
- [x] **SAML T10.9 (domain half)** — `VerifiedDomain` persistence, DNS TXT add/verify/delete
  actions and verified-domain auto-join.
- [x] **SAML T10.7 (rotation half)** — guarded metadata-URL refresh, IdP metadata parsing and
  24-hour previous-certificate overlap.
- [x] **SAML SLO** — POST/redirect logout-message validation with audit, while always ending
  the local session.
- [x] **SAML T10.5/T10.6** — admin SSO settings section: connection CRUD, metadata refresh and
  verified-domain TXT workflow.
- [x] **SAML T10.8 (Users half)** — SCIM 2.0 Users endpoints with one-time hashed tokens,
  pagination, JIT membership, deprovisioning and owner protection.
- [x] **SAML T10.8 (Groups half)** — SCIM Groups map to teamspaces (list/get/create/member
  add/remove/replace/delete).
- [ ] **SAML post-M3** — map SCIM group membership onto workspace roles.
- [ ] CRDT M2 — persisted documents + text CRDT; M3 — cursors/awareness UX. Honest scope:
  M2/M3 only if M1 lands clean this year — otherwise multiplayer rows stay 🧭 into 2027.

## Milestone 7 — Database & property depth (Nov 2026)

- [ ] Relations + rollups M1–M3 per `relations-rollups.md` (B21: engines exist, six matrix
  notes appended — re-verify rows first, then two-way pairs, cell correctness, e2e).
- [ ] Formula engine M1–M3 per `formula-engine.md` (B22): editor UX + autocomplete,
  function coverage, error states, caching — section 5 reads 0/16 today.
- [ ] Groups/aggregation + calculations footer, sub-items/dependencies,
  linked-database write path, database-template rows.
- [ ] Closes B17's 13 property partials and flips section 4's remaining 🟡/🧭.

## Milestone 8 — Platform hardening (Nov–Dec 2026)

- [ ] S3-compatible object storage wired to uploads + scheduled backups + a documented
  restore rehearsal.
- [ ] Cursor pagination everywhere (databases, audit lists) + a caching layer + a
  structured sensitive-action audit log.
- [ ] Docker image (multi-stage) + Compose polish, health checks, reverse-proxy guidance,
  logs/error tracking basics.
- [ ] Secret handling beyond env (vault decision) — matrix 🟡 → scope it or keep env-based
  and say so.

## Milestone 9 — Release candidate (Dec 2026)

- [ ] The B16 full-suite baseline held green through the cycle (one suite per change, lock
  discipline, quarantine list empty or root-caused).
- [ ] Re-baseline: `docs:counts` / `docs:gaps` regen + stale-🧭 verification
  (the B21/B23/B25 class — formula engines, docx/trello importers, AI block + autofill),
  and the i18n QA (B51) fixes applied.
- [x] Documentation published: README refresh (B47), REST API reference (B48),
  security audit (B49) + performance audit (B50) — their remediation is chartered as
  B53–B60 (M5).
- [ ] Honest status summary target: close most of the 89 🟡, stretch ✅ from 174 toward
  ~230–250, ⛔ stays 14 — **full parity (286 planned rows) is explicitly not a 2026
  commitment.**
- [ ] `check:coherence` green with ratchets holding (unwrapped ≤ 11 and shrinking,
  i18n ≥ 71 files).

## Backlog (not 2026)

- Pricing / plan-gated features (14 rows) — needs a billing/product decision + an
  external payment provider.
- Two-way Google/Outlook calendar OAuth sync — external provider app credentials.
- Integrations: Slack / GitHub / Figma / Google Drive, MCP server, inbound webhooks —
  external partner apps; webhooks-out and OAuth apps already ship.
- Automations engine + recurring tickets implementation (spec B27 first; template cron is
  the precedent).
- GDPR admin tooling, encryption at rest/in transit (deployment-topology decision),
  observability (OpenTelemetry).
- Suggestions mode, offline-mode hardening, desktop app (⛔ row: no desktop shell exists).

## Non-goals (for now)

- Proprietary Notion code/assets or branding.
- Exact byte-for-byte UI clone; Noema aims for feature parity, not visual imitation.
