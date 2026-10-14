# Roadmap

Ordered by dependency and impact. Every item maps to rows in
[`FEATURE_MATRIX.md`](./FEATURE_MATRIX.md).

## Milestone 0 — Foundation (done)

- [x] Auth, workspaces, roles
- [x] Nested page tree, icons, favorites, trash
- [x] TipTap block editor with autosave, `/` menu, version snapshots
- [x] Databases: properties + Table/Board/List views
- [x] Full-text search, comments (threaded), dark mode
- [x] Prisma domain model, Docker Postgres, seed script, docs

## Milestone 1 — Editor depth

- [x] Block hover handle + pointer drag-and-drop reordering (TipTap drag handle)
- [x] Selection bubble menu (bold/italic/underline/strike/code/link)
- [x] Text color + highlight marks
- [x] Keyboard-driven `/` slash menu
- [x] Callout, toggle, columns, table block, table of contents
- [x] Inline + block equations (KaTeX)
- [x] Inline mentions (@person, @page, @date)
- [x] Image/File uploads (local disk); captions/alt-text/resizing + an S3 driver still planned
- [x] Breadcrumb block
- [x] Embeds + bookmark cards (YouTube, Vimeo, Loom, Spotify, SoundCloud, Figma, CodePen; SSRF-guarded link preview)
- [x] Synced view (read-only page transclusion)
- [x] Template buttons (built-in templates) · [x] "ask AI" block (ask + summarize)
- [x] Page settings: full-width, small text, font
- [x] Markdown shortcuts hardening + paste/drop file handling
- [x] Undo/redo surfaced in UI
- [x] Block context menu (right-click: turn into, colour, Ask AI, move, duplicate, comment, copy link, delete)
- [x] Notion-style caret + selection styling

## Milestone 2 — Databases complete

- [x] View tabs + add-view menu
- [x] Per-property menus (rename, duplicate, delete)
- [x] Open row as a page, List view
- [x] Gallery + Calendar view renderers
- [x] Filters, sorts and grouping (saved per view, with UI)
- [x] Timeline + Chart view renderers
- [x] Filters (AND/OR mode + nested trees), sorts, grouping, conditional colors
- [x] Formula properties (expression engine) + unique ID + system properties + **relations + rollups** (14 aggregation functions)
- [x] Row side-peek (with open-as-page) · [ ] sub-items, dependencies, calculations footer
- [x] Database templates (save a row as a template, create rows from templates)
- [x] Linked databases (embedded read-only views) · [x] recurring templates (cron materializer) · [ ] view config
- [x] CSV import/export · [x] database locking + button properties (basic automations)

## Milestone 3 — Collaboration & sharing

- [x] Realtime multiplayer with Yjs CRDT + awareness/cursors — opt-in (`npm run collab` + `NEXT_PUBLIC_COLLAB_URL`)
- [ ] Inline block comments with anchors, reactions, suggestions mode
- [x] Public share links (read-only, **optional password + expiry**) + page-level permissions (per-member READ/EDIT)
- [x] Teamspaces / wiki (creation, membership, **email invitations**, sidebar grouping, per-page assignment) · [ ] guests, transfer pages between workspaces
- [x] Per-workspace AI provider settings (OpenAI / DeepSeek / Gemini / custom, model list, encrypted key, test connection)
- [x] Playwright end-to-end suite (`npm run e2e`, 11 tests: save, selection toolbar, block menu, move up/down, equations, comments, chat + grounded AI reply, sidebar right-click, projects, invites, AI settings)
- [x] SMTP email: per-workspace config, client/guest invitations, delivery log, verify + test send (`npm run check:mail` against a mock SMTP server)
- [x] Projects & milestones (progress, Gantt timeline, attach notes, client invites, `/w/<slug>/projects`)
- [x] **Tickets** (issues): workspace labels, estimates + rollups, start/due dates → timeline, board/list/timeline views, relations, comments, activity log, bulk edits, from-page creation, `GET/POST /api/tickets`
- [x] Chat: draft-first threads, note-pinned discussions, `/ask` grounded replies
- [x] Version history slide-over with author, summary, delta and restore
- [x] Workspace chat (discussions with messages; sidebar Chat tab + `GET/POST /api/chat`)
- [x] Calendar subscriptions (ICS import + refresh; sidebar Meetings tab + meeting notes) · [ ] two-way Google/Outlook OAuth sync
- [x] Backlinks / linked references
- [x] Notifications inbox UI
- [x] Following pages · [x] transfer pages between workspaces

## Milestone 4 — Platform

- [x] Import/export: Markdown + JSON + HTML (pages), CSV (databases), Markdown import, CSV import, bulk workspace export (.zip)
- [x] PDF export · [x] Trello + Markdown-archive + Word (.docx) import · [x] Notion-API import (`POST /api/import/notion`, integration token + nested pages)
- [x] Public REST API (`/api/v1`) + API tokens (Bearer auth) + token management UI
- [x] Webhooks (HMAC-SHA256 signed; delivery log + retries) · [x] OAuth apps (authorization-code flow → API tokens)
- [ ] Object storage, backups/restore, audit log UI
- [ ] Performance: Postgres full-text (`tsvector`), pagination, caching
- [x] 2FA (TOTP) + API rate limiting · [x] SSO (OIDC authorization-code + JWKS, JIT provisioning, `SSO_*` env) · [ ] SAML, secret handling
- [x] AI: provider route (OpenAI-compatible incl. DeepSeek) + "Ask AI" block (ask + summarize) + **AI autofill property**
- [x] AI: **workspace grounding** (keyword extraction + relevance-scored pages) · **AI skills** (`POST /api/ai/skills`) · prompts centralised in `src/lib/ai-skills.ts`
- [x] AI: transcription (`POST /api/ai/transcribe`, own provider via `AI_TRANSCRIBE_API_KEY`; sidebar “Transcribe audio”)
- [x] Verification: `npm run check:ai` (live provider, 7/7 skills) · `npm run check:routes` (no 5xx) · `npm run check:ui` (22 checks)
- [x] i18n/RTL (5 locales + direction + app chrome) · [x] responsive mobile shell + focus rings/skip link · [x] WCAG audit (`npm run check:a11y`)
- [x] Home template gallery (empty page/database + 6 workflow templates + other templates; `POST /api/templates`)
- [x] Sidebar chrome (Home/Chat/Meetings tabs, search with Ctrl K, Library, Teamspaces, Private pages, Add, Customize) + Library page

## Non-goals (for now)

- Proprietary Notion code/assets or branding.
- Exact byte-for-byte UI clone; Noema aims for feature parity, not visual imitation.
