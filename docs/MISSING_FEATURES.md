# Noema — remaining work

> Generated from `docs/FEATURE_MATRIX.md` by `npm run docs:gaps`. Do not edit by hand.

**Scoreboard:** 563 feature rows — 191 implemented · 142 partial · 216 planned · 14 deliberately out of scope.

This file lists the **358** rows that are not finished, area by area, plus 14 intentional divergences.

## Read this first — highest-leverage gaps

| # | Gap | Why it matters | Area |
| --- | --- | --- | --- |
| 1 | **Sub-tickets & dependency tree** | Parent/child issues already exist in the schema; the nesting UI and roll-up of child estimates do not. | Projects, tickets & planning |
| 2 | **Saved views** | Named filter/sort/group presets for databases and tickets. | 3. Databases |
| 3 | **Cycles & sprints** | Time-boxed iterations with a burndown of the estimate remaining. | 20. Projects, tickets & planning |
| 4 | **Realtime collaboration** | CRDT + presence + live cursors on the editor (today: opt-in websocket rooms without text CRDT). | 7. Collaboration |
| 5 | **Suggestions mode** | Propose edits for approval with a diff overlay. | 7. Collaboration |
| 6 | **Comment depth** | Resolve, reactions, mentions and thread replies on pages. | 7. Collaboration |
| 7 | **Notification inbox & preferences** | The inbox route exists; per-user delivery preferences and digests are missing. | 7. Collaboration |
| 8 | **Full-text search at Postgres level** | Search works through SQL LIKE today; tsvector/trigram indexes and ranking are pending. | 11. Search |
| 9 | **Pagination everywhere** | Databases, tickets and audit lists load bounded sets; cursor pagination is pending. | 17. Data model & platform |
| 10 | **Audit log UI** | Activity is recorded per ticket/page; a workspace-wide, filterable audit view is missing. | 8. Sharing & permissions |
| 11 | **Object storage & backups** | Uploads and scheduled backups to S3-compatible storage. | 17. Data model & platform |
| 12 | **SAML SSO** | OIDC is implemented and tested; SAML needs a provider-agnostic strategy layer. | 8. Sharing & permissions |
| 13 | **Guests** | Limited external collaborators with scoped access. | 7. Collaboration |
| 14 | **Formula engine depth** | Rollups, relations and formulas exist; broader function coverage and error reporting are partial. | 5. Formulas |
| 15 | **i18n string extraction** | Five locales ship; remaining hard-coded English strings need extraction into the message catalogue. | 16. Navigation & UX |

## By area

### 1. Editor & blocks

44 done · 46 partial · 8 planned · 2 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Toggle heading | Heading that doubles as a toggle. | 🟡 | Composite of heading + toggle planned. |
| Pull quote / large quote | Display-scale quotation styling. | 🟡 | Planned as a quote variant. |
| Code block line numbers | Optional gutter numbering. | 🟡 | Planned as a code-block setting. |
| Code block caption | Caption text under a code block. | 🟡 | Planned. |
| Inline equation | Small LaTeX expression inside a text line. | 🟡 | KaTeX renderer wired; editing UX rough. |
| Block equation | Centered display equation. | 🟡 | Renders via KaTeX; edit/preview split unstable. |
| KaTeX/LaTeX support | Math syntax engine for equations. | 🟡 | KaTeX chosen; macro support limited. |
| Math editor UX | Popover to compose equations with symbols. | 🟡 | Planned composer with symbol palette. |
| Columns (2/3/4/5) | Arrange blocks side by side. | 🟡 | Two-column layout works; add/remove columns UI missing. Spec: docs/specs/editor-deep.md (R84.1-R84.3; cap is 4 today — custom-blocks.tsx:240). |
| Simple table block | Grid of rows and columns in a page. | 🟡 | Basic table; no header styling controls yet. Spec: docs/specs/editor-deep.md (R84.4-R84.6). |
| Table header row/column | Designate header row/column. | 🟡 | Toggle exists in logic; styling minimal. Spec: docs/specs/editor-deep.md (R84.4-R84.6; in-table toolbar binds the unbound TableKit commands, th scope in the read-only renderer). |
| Table cell colors | Background color for cells. | 🟡 | Planned. |
| Table of contents | Auto-generated page outline with links. | 🟡 | Lists headings; scroll-spy navigation partial. Spec detail: docs/specs/editor-deep.md §5 (R84.16); live close: B96 (e2e/toc.spec.ts). |
| Breadcrumb block | Shows the page's ancestor path. | 🟡 | Renders path; deep-tree linking rough. |
| Synced block | Mirror one block's content in many places. | 🟡 | Planned via reference ids; editing propagation needs care. |
| Button block | Interactive button triggering configured actions. | 🟡 | Planned; depends on automations. |
| Two-column page property layout | Place properties side by side. | 🟡 | Planned with property panel rework. |
| Video block | Embed or upload video. | 🟡 | Drops insert a download link the browser plays; provider embeds (YouTube/Vimeo) ship through the embed block instead. No `<video>` node in `src/` today — spec docs/specs/editor-deep.md R84.7 (T84.6, editor slot); honest partial. |
| Audio block | Embed or upload audio. | 🟡 | Drops insert a download link; no `<audio>` player and no waveform yet — spec docs/specs/editor-deep.md R84.7/R84.9 (T84.6); honest partial. |
| File block | Attach an arbitrary file for download. | 🟡 | Upload/download works; non-image uploads insert a download link, so preview types stay limited (no dedicated file node yet). |
| Embed block | Generic iframe embed by URL. | 🟡 | Config half shipped (B20): `EMBED_HOST_ALLOWLIST` + `isEmbedHostAllowed()` is the single gate over `detectEmbed()` (spec R84.15), provider meta drives iframe title/aspect/`allow`, and CSP `frame-src` mirrors the outputs. Still provider-only — no arbitrary-URL iframe and no `sandbox` attribute; UI half R84.13-R84.15 stays open. |
| Map block | Embedded map for an address. | 🟡 | Planned; provider-agnostic embed. |
| Twitter/X embed | Rich post embed. | 🟡 | Planned via oEmbed-style resolution. |
| Figma embed | Live design embed. | 🟡 | Planned. |
| CodePen/CodeSandbox embed | Interactive code embeds. | 🟡 | Planned. |
| Google Drive preview | Preview a linked Drive document. | 🟡 | Planned. |
| Inline database block | A database rendered inside a page. | 🟡 | Renders a collection view inline; view config incomplete. |
| Page link mention | Inline link to another page. | 🟡 | `@` picker inserts a page link node. |
| Block reference / mention | Inline reference to a specific block. | 🟡 | Planned; block-id resolution needed. |
| Person mention | Inline user chip. | 🟡 | Renders user; notifications on mention minimal. |
| Unlinked mention | Detects the page name typed without a link. | 🟡 | Planned as a backlink-discovery pass. |
| Drag to another page | Move a block into a different page. | 🟡 | Planned. |
| Multi-block selection | Select a range of blocks. | 🟡 | Shift+click works; select-all edge cases. Spec: docs/specs/editor-deep.md (R84.10-R84.12 for the range edges; select-all subset owned by B18). |
| Copy block link | Copy a deep link to a block. | 🟡 | Planned. |
| Page icon | Emoji or image as a page icon. | 🟡 | Emoji icons work; image icons limited. |
| Page cover | Banner image on a page. | 🟡 | Upload works; reposition/resize missing. |
| Cover reposition | Drag the cover image position. | 🟡 | Planned. |
| Callout icon picker | Choose the callout's icon. | 🟡 | Planned. [B84 audit] Ships today — in-block icon picker at src/components/editor/extensions/custom-blocks.tsx:104-116; glyph left for orchestrator re-baseline. |
| Sub-pages section | Auto-list of child pages on a parent. | 🟡 | Inline listing exists; reorder partial. |
| Full-width toggle | Expand content to the full viewport width. | 🟡 | Toggle works per page; persisted. |
| Small text | Reduce body font size for a page. | 🟡 | Planned page-level style setting. [B84 audit] Ships today — src/app/w/[slug]/[pageId]/page.tsx:115,130 + src/components/page-title.tsx:270-273; glyph left for orchestrator re-baseline. |
| Page fonts | Choose from preset font families. | 🟡 | Planned; ships three classic pairings. |
| Line spacing | Control paragraph line-height. | 🟡 | Planned as a page/appearance option. |
| Page locking | Prevent edits to a page. | 🟡 | Planned; depends on permission layer. [B84 audit] Ships today — Page.locked + topbar toggle (src/app/w/[slug]/[pageId]/page.tsx:88; src/components/page-title.tsx:279-281); server-side enforcement gap tracked as D6 in docs/specs/realtime-collab.md §2.3; glyph left for orchestrator re-baseline. |
| Page description | Short summary surfaced in previews. | 🟡 | Planned; used by search previews. |
| Page breadcrumb header | Ancestor path in the page header. | 🟡 | Renders; interactions partial. |
| Column resize | Drag the divider to change column width. | 🧭 | Planned with persisted widths. |
| Synced block source marker | Visual marker of the canonical source. | 🧭 | Planned. |
| Template button block | Reusable set of blocks inserted on click. | 🧭 | Planned; depends on template subsystem. |
| Ask-AI block | Prompt-driven AI block inside a page. | 🧭 | Planned; depends on AI layer and provider keys. |
| PDF preview block | Inline PDF viewer. | 🧭 | Planned; needs a viewer component. |
| Linked view of a database | Re-display an existing database elsewhere. | 🧭 | Planned; requires stable view model. |
| Synced/reference content | Reference that mirrors another block. | 🧭 | Shares machinery with synced blocks. |
| Copy as Markdown | Copy selection as Markdown text. | 🧭 | Planned. |
| Comment block (doc annotation) | Pulls comments conceptually into flow. | ⛔ | Superseded by the inline comment model; not a block. |
| Table merge/split cells | Combine or split cells. | ⛔ | High complexity for low demand; revisit if requested. |

### 2. Text formatting

10 done · 8 partial · 3 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Link editing | Change or remove a link. | 🟡 | Remove works; inline edit popover basic. |
| Link title on hover | Show URL on hover. | 🟡 | Tooltip present; styling minimal. |
| Highlight/background color | Marker-style background on text. | 🟡 | Background works; palette limited. |
| Text color | Colored text spans. | 🟡 | Palette limited; some hues missing. |
| Inline math | LaTeX span inside text. | 🟡 | KaTeX renderer; inline edit rough. |
| Paste with formatting | Preserve rich formatting on paste. | 🟡 | HTML paste works; style cleanup partial. |
| Paste without formatting | Strip styles on paste. | 🟡 | Shortcut present; some wrappers leak. |
| Ligatures & smart quotes | Typographic niceties while typing. | 🟡 | Planned as an editor option. |
| Clear formatting | Reset marks on a range. | 🧭 | Planned as a keyboard action. |
| Subscript | Baseline-lowered text. | 🧭 | Planned if demand justifies. |
| Superscript | Baseline-raised text. | 🧭 | Planned if demand justifies. |
| Small caps / all caps | Display transforms for text. | ⛔ | Rarely used in prose; not planned. |

### 3. Databases

15 done · 32 partial · 6 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Board view | Kanban grouped by a property. | 🟡 | Planned; grouping engine needed. Renderer + grouping landed (B15); depth gaps spec'd: docs/specs/database-deep.md (R89.7). |
| List view | Compact single-line list. | 🟡 | Planned. Renderer landed (B15); grouped/compact depth spec'd: docs/specs/database-deep.md (R89.8). |
| Gallery view | Card grid with previews. | 🟡 | Planned. Card grid + first-image banner landed (B15); cover/content-preview depth spec'd: docs/specs/database-deep.md (R89.9). |
| Calendar view | Rows on a month/week calendar. | 🟡 | Planned; needs date property engine. Month grid landed but single-day only (B15); week scale + multi-day spans + date-property picker spec'd: docs/specs/database-deep.md (R89.10). |
| Chart view | Aggregate charts over the database. | 🟡 | Planned; aggregation dependency. Count-only bars landed (B15); chart type/measure/group-by over ROLLUP_FUNCTIONS spec'd: docs/specs/database-deep.md (R89.12). |
| Form view | Public/Internal form that creates rows. | 🟡 | Planned. No ViewType.FORM exists yet; builder + submit path spec'd: docs/specs/database-deep.md (R89.29). |
| AND/OR filter groups | Boolean combination of filters. | 🟡 | Planned as a filter tree. FilterNode tree already evaluates (database-query.ts:66); tree UI spec'd: docs/specs/database-deep.md (R89.2). |
| Nested filter groups | Arbitrary-depth boolean nesting. | 🟡 | Planned after flat groups. Spec'd with the tree UI: docs/specs/database-deep.md (R89.2). |
| Groups | Bucket rows by a property. | 🟡 | Planned; mainly for board/list. groupRows() exists (database-query.ts:580); generalized grouping + order/collapse spec'd: docs/specs/database-deep.md (R89.3). |
| Group aggregation | Show a summary per group. | 🟡 | Planned. Spec'd over rollup aggregate(): docs/specs/database-deep.md (R89.4). |
| Hidden groups | Collapse or hide groups. | 🟡 | Planned. Persisted collapse spec'd: docs/specs/database-deep.md (R89.3). |
| Conditional formatting | Color rows/cells by rule. | 🟡 | Planned. ColorRule already modelled in view config (database-query.ts:68); rule editor + evaluation spec'd: docs/specs/database-deep.md (R89.5). |
| Row color rules | Two-tone row backgrounds. | 🟡 | Planned subset of conditional formatting. Spec'd: docs/specs/database-deep.md (R89.5). |
| Quick filter from header | Filter directly from a column header. | 🟡 | Planned. Spec'd as an entry point into the filter panel: docs/specs/database-deep.md (R89.6). |
| Open row as page | Full-page row view. | 🟡 | Route, editor blocks and comments work, and the table/peek offer one-click *Open as page*; a properties strip + back-to-database breadcrumb on the row page needs `app/w/[slug]/[pageId]/page.tsx`, outside B15's ownership (queued for the page-route batch). |
| Inline database | Database embedded in a page body. | 🟡 | Renders through the editor's linked-database node view; its height/scroll shell lives in `src/components/editor/**` (editor slot), so the scroll fix is queued there rather than patched from B15. |
| Row reordering | Drag rows in a view order. | 🟡 | Planned with manual order property. Page.position already orders rows (queries.ts:155-157); drag UI + moveRowAction spec'd: docs/specs/database-deep.md (R89.19). |
| Column resize/reorder | Resize and reorder columns. | 🟡 | Planned. Per-view width/order in view config spec'd: docs/specs/database-deep.md (R89.13). |
| Calculations/footer | Aggregations under columns. | 🟡 | Planned (count, sum, average, etc.). Spec'd over rollup ROLLUP_FUNCTIONS: docs/specs/database-deep.md (R89.4). |
| Database lock | Prevent schema edits. | 🟡 | Planned; depends on permissions. Database-scoped capability split (readRows/editRows/editSchema) + schemaLocked flag spec'd: docs/specs/database-deep.md (R89.23, R89.24). |
| Duplicate database | Copy a database with structure. | 🟡 | Planned. Atomic structure copy (properties/views/templates, optional rows) spec'd: docs/specs/database-deep.md (R89.22). |
| Sub-items / sub-tasks | Parent-child rows inside a database. | 🟡 | Planned; tree ordering needed. Page.subOfId (depth cap 1) spec'd independent of relations: docs/specs/database-deep.md (R89.30). |
| Dependencies | Blocking/blocked-by between rows. | 🟡 | Planned; mainly for timeline. RowDependency join model with cycle guard spec'd: docs/specs/database-deep.md (R89.31). |
| Timeline dependencies | Draw dependency arrows on timeline. | 🟡 | Planned. Arrow rendering inside the gantt depth spec: docs/specs/database-deep.md (R89.31 with R89.11). |
| Calendar multi-day events | Span events across days. | 🟡 | Planned. Span-day expansion replaces today's single-day match (view-renderers.tsx:624-634): docs/specs/database-deep.md (R89.10). |
| Gallery previews | Show cover or page content on cards. | 🟡 | Planned. First-image banner landed (B15); cover property + page-content preview spec'd: docs/specs/database-deep.md (R89.9). |
| Board grouping | Group board columns by property. | 🟡 | Planned. groupBy + status buckets landed (B15); group-by picker, order, collapse and per-column create spec'd: docs/specs/database-deep.md (R89.7). |
| Buttons in databases | Row actions via buttons. | 🟡 | Planned; depends on automations. Property shell (label/style/config) spec'd: docs/specs/database-deep.md (R89.26); action execution owned by docs/specs/automations.md (R27.x). |
| Database templates | Pre-filled row templates. | 🟡 | Planned. Minimal CRUD shipped (save row as template / instantiate / recurrence, database.ts:464-588); depth (default, preview, edit) integration spec'd: docs/specs/database-deep.md (R89.16) with docs/specs/templates.md (R31.x). |
| Default template | Auto-apply a template to new rows. | 🟡 | Planned. Flag + semantics owned by docs/specs/templates.md (R31.13); createRowAction application + New-row split button spec'd: docs/specs/database-deep.md (R89.16). |
| Recurring templates | Create rows on a schedule. | 🟡 | Planned; depends on a scheduler. Core (resolver/nextRun/cron driver) owned by docs/specs/templates.md (R31.18-R31.23); database-side surfacing + system-actor materialization spec'd: docs/specs/database-deep.md (R89.17). |
| Unique ID property | Human-readable per-row id. | 🟡 | Planned; see Properties. Today derived as row.id.slice(-8) (database-view.tsx:424); monotonic Property.seq + prefix/pad spec'd: docs/specs/database-deep.md (R89.25). |
| Timeline view | Rows on a horizontal time axis. | 🧭 | Planned. Static bars landed (B15, fixed window); zoom/drag/dates spec'd: docs/specs/database-deep.md (R89.11). |
| Open row in side peek | Preview row in a side drawer. | 🧭 | Planned; needs drawer shell. Spec: docs/specs/navigation-ux.md. |
| Linked database | Reuse a database elsewhere. | 🧭 | Planned; requires view identity model. Read-only node exists (linked-database.tsx, attrs = databasePageId only); view identity, per-instance overrides and synced mode spec'd: docs/specs/database-deep.md (R89.14, R89.15). |
| Database description | Intro text above a database. | 🧭 | Planned. Page.description column + toolbar editor spec'd: docs/specs/database-deep.md (R89.21). |
| CSV import | Import rows from CSV. | 🧭 | Planned; header mapping UI. Mapping step + create-database import owned by docs/specs/import-export.md (R23.1, R23.2); database-toolbar wiring spec'd: docs/specs/database-deep.md (R89.20). |
| CSV export | Export rows to CSV. | 🧭 | Planned. Toolbar entry + GET /api/export/database/:id already exist; round-trip contract owned by docs/specs/import-export.md (R23.5); wiring spec'd: docs/specs/database-deep.md (R89.20). |

### 4. Properties

19 done · 3 partial · 13 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Date range | Start and end date. | 🟡 | Planned. |
| Last edited by | Last editor. | 🟡 | Tracked from property/table edits via the activity log (falls back to creator); content/title edits outside the database view not yet recorded. |
| Unique ID property | Monotonic per-database id. | 🟡 | Planned. |
| Date reminders | Notify at a chosen time. | 🧭 | Planned; depends on scheduler. |
| Date time zone | Time-zone-aware timestamps. | 🧭 | Planned; store as UTC + zone. |
| Formula property | Computed value from an expression. | 🧭 | Planned; see Formulas. |
| Relation property | Link rows across databases. | 🧭 | Planned. Spec: docs/specs/relations-rollups.md. |
| Relation (single) | One linked row. | 🧭 | Planned. Spec: docs/specs/relations-rollups.md. |
| Relation (multi) | Many linked rows. | 🧭 | Planned. Spec: docs/specs/relations-rollups.md. |
| Two-way relation | Reciprocal relation property. | 🧭 | Planned; requires pair metadata. Spec: docs/specs/relations-rollups.md. |
| Rollup property | Aggregate across a relation. | 🧭 | Planned; depends on relations. Spec: docs/specs/relations-rollups.md. |
| Rollup functions | Count, sum, average, min/max, join, etc. | 🧭 | Planned function set. Spec: docs/specs/relations-rollups.md. |
| Button property | Trigger actions from a row. | 🧭 | Planned. |
| Place/location property | Address with map preview. | 🧭 | Planned. |
| Verification property | Verified-by-owner marker. | 🧭 | Planned; wiki-oriented. |
| AI autofill property | AI-generated value per row. | 🧭 | Planned; depends on AI layer. |
| Property type change | Convert a property's type. | ⛔ | Lossy conversions; only safe transforms planned later. |

### 5. Formulas

0 done · 0 partial · 16 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Formula editor | Author expressions with autocomplete. | 🧭 | Planned; expression parser first. Spec: docs/specs/formula-engine.md. |
| Arithmetic operators | `+ - * / %` and precedence. | 🧭 | Planned. Spec: docs/specs/formula-engine.md. |
| Comparison operators | `== != < <= > >=`. | 🧭 | Planned. Spec: docs/specs/formula-engine.md. |
| Boolean operators | `and`, `or`, `not`. | 🧭 | Planned. Spec: docs/specs/formula-engine.md. |
| Property references | Reference other properties by name. | 🧭 | Planned. Spec: docs/specs/formula-engine.md. |
| Math functions | `abs`, `round`, `ceil`, `floor`, `min`, `max`, etc. | 🧭 | Planned function library. Spec: docs/specs/formula-engine.md. |
| Text functions | `concat`, `length`, `slice`, `replace`, `lower`, `upper`, etc. | 🧭 | Planned. Spec: docs/specs/formula-engine.md. |
| Logic functions | `if`, `ifs`, `and`/`or` helpers. | 🧭 | Planned. Spec: docs/specs/formula-engine.md. |
| Date functions | `now`, `dateAdd`, `dateBetween`, `formatDate`, etc. | 🧭 | Planned. Spec: docs/specs/formula-engine.md. |
| List functions | `map`, `filter`, `sort`, `join`, `length`. | 🧭 | Planned; depends on rollups. Spec: docs/specs/formula-engine.md. |
| Regex functions | `match`, `replace` with patterns. | 🧭 | Planned; sandboxed engine. Spec: docs/specs/formula-engine.md. |
| Regex extraction | Capture groups into values. | 🧭 | Planned. Spec: docs/specs/formula-engine.md. |
| Rollups in formulas | Reference rollup results. | 🧭 | Planned; ordering dependency. Spec: docs/specs/formula-engine.md. |
| Formula error states | Friendly errors for bad expressions. | 🧭 | Planned. Spec: docs/specs/formula-engine.md. |
| Formula result caching | Recompute efficiently on change. | 🧭 | Planned; dependency graph. Spec: docs/specs/formula-engine.md. |
| Named constants | Reuse of workspace-level values. | 🧭 | Planned nicety. Spec: docs/specs/formula-engine.md. |

### 6. Templates

1 done · 5 partial · 3 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Page templates | Duplicate a page for reuse. | 🟡 | Duplicate-page works; gallery UI missing. Spec: docs/specs/templates.md. |
| Database templates | Pre-filled rows from a template. | 🟡 | Planned. Spec: docs/specs/templates.md. |
| Default template | Auto-apply to new rows. | 🟡 | Planned. Spec: docs/specs/templates.md. |
| Recurring templates | Scheduled row creation. | 🟡 | Planned; needs scheduler. Spec: docs/specs/templates.md. |
| Template duplication | Clone a template into a page. | 🟡 | Planned. Spec: docs/specs/templates.md. |
| Template button | Insert template content in a page. | 🧭 | Planned. Spec: docs/specs/templates.md. |
| Save page as template | Convert a page into a template. | 🧭 | Planned. Spec: docs/specs/templates.md. |
| Template locking | Keep templates read-only. | 🧭 | Planned. Spec: docs/specs/templates.md. |
| Template from selection | Turn a block selection into a template. | ⛔ | Uncommon flow; skip initially. B80 blocked-row triage: docs/specs/templates.md:308 + docs/specs/workspaces-structure.md §4 (editor-slot dependency). |

### 7. Collaboration

13 done · 5 partial · 8 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Presence | See who is viewing a page. | 🟡 | Planned. |
| Avatars | Per-user avatars in the UI. | 🟡 | Avatar field exists; presence UI pending. |
| Page comments | Comment threads on a page. | 🟡 | Data model basic; UI minimal. B79 audit: threads/resolve/reactions/mentions all live; deepest gaps are server-side depth validation, block anchors and dispatch scoping (see rows below). Spec: docs/specs/collaboration-deep.md. |
| Suggestions mode | Propose edits for approval. | 🟡 | Planned; diff overlay needed. |
| Notification inbox | Central list of notifications. | 🟡 | Planned. B79 audit: route already exists at `/w/<slug>/inbox` (`inbox/page.tsx:17-99`, newest-first `take 50`, unread dot, sidebar badge) fed by `comment.reply`/`page.mention`; the `page.shared` label has no writer, labels are hardcoded English, and links stop at the page (no `commentId`/anchor). Glyph left as-is per append-only rule — orchestrator re-baseline candidate (O79.5). R79.3e, R79.4f-g. B82 spec `docs/specs/notifications.md` owns delivery: rows gain `workspaceId`/`actorId`/payload actor+title (D2/D9), inbox gets workspace filter + cursor paging + `t()` labels (D3), badge semantics frozen — R82.2, R82.21-R82.26. |
| Real-time multiplayer editing | Multiple users edit simultaneously. | 🧭 | Planned; local-first CRDT then sync. Spec: docs/specs/realtime-collab.md. |
| CRDT data model | Conflict-free replicated structures. | 🧭 | Planned (automerge/Yjs-style). Spec: docs/specs/realtime-collab.md. |
| Live cursors | Remote carets and selections. | 🧭 | Planned; needs presence transport. |
| Accept/reject suggestion | Resolve proposed changes. | 🧭 | Planned. |
| Following pages | Follow a page for updates. | 🧭 | Planned. B79 audit: the page-follow bell already ships (row state from `PageFollow` via `page-title.tsx:338-356`, toggle `pages.ts:463-481`, read `page.tsx:58-61`) but no mutation ever consults `PageFollow` — following dispatches zero notifications (see Notification inbox). R79.5. |
| Notification preferences | Control what triggers alerts. | 🧭 | Planned. B82 spec `docs/specs/notifications.md`: `NotificationPreference` rows resolved page → workspace → user default, gate enforced inside the dispatcher itself (`none` cannot be bypassed, `always`-class exceptions documented) — R82.15-R82.20. |
| Lock editing | Freeze a page while editing. | 🧭 | Planned; permission-linked. |
| Coarse edit locks | Prevent simultaneous structural edits. | 🧭 | Planned fallback before full CRDT. |

### 8. Sharing & permissions

2 done · 5 partial · 15 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Workspace roles | Owner/admin/member/guest roles. | 🟡 | Roles modeled; enforcement partial. |
| Owner role | Full control of the workspace. | 🟡 | Modeled; transfer flows missing. |
| Admin role | Manage members and settings. | 🟡 | Modeled; UI partial. |
| Page sharing | Grant a user access to a page. | 🟡 | Basic share record; UI minimal. |
| Allow editing toggle | Choose edit vs read-only shares. | 🟡 | Planned. |
| Guest role | Limited-scope collaborator. | 🧭 | Planned. |
| Public web link | Share a page publicly. | 🧭 | Planned; local-first tension to resolve. |
| Password-protected link | Require a password for shared pages. | 🧭 | Planned. |
| Link expiration | Time-limit a share link. | 🧭 | Planned. |
| Share to web | Publish a page to the web. | 🧭 | Planned; opt-in per page. |
| Per-page permissions | Independent access per page. | 🧭 | Planned; inheritance model needed. |
| Allow comments toggle | Permit comments on shares. | 🧭 | Planned. |
| Allow duplicate toggle | Let viewers copy the page. | 🧭 | Planned. |
| Search-engine indexing toggle | Allow crawlers on public pages. | 🧭 | Planned. |
| Publish to web | Public rendering route. | 🧭 | Planned. |
| Transfer page ownership | Hand a page to another user. | 🧭 | Planned. |
| Move pages across workspaces | Relocate content between workspaces. | 🧭 | Planned; id-remap complexity. |
| Export-restricted pages | Disable export for sensitive pages. | 🧭 | Planned. |
| Permission inheritance | Child pages inherit parent access. | 🧭 | Planned. |
| Access audit view | See who can access a page. | 🧭 | Planned. |

### 9. Workspaces & structure

6 done · 6 partial · 11 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Page tree | Hierarchical page nesting. | 🟡 | Nesting works; B66 extracted the pure logic (flatten/group/expand/moveCandidates) to `src/lib/page-tree.ts` with 22 unit tests over a synthetic 1000-node tree — cycle guard, expand-state invariants, perf smoke (render plan 0.6 ms median ≪ 100 ms). React DOM render at 1000 nodes still unmeasured (no e2e by design). B80: bulk move + `movePageAction` containment guards specced (R80.7/R80.8) — docs/specs/workspaces-structure.md. |
| Trash / recently deleted | Deleted pages list. | 🟡 | Soft delete exists; trash UI partial. |
| Restore from trash | Undo a deletion. | 🟡 | Planned. |
| Permanent delete | Permanently remove an item. | 🟡 | Planned; purge job needed. |
| Sidebar collapse | Collapse the sidebar. | 🟡 | Toggle works. |
| Duplicate page | Clone a page with children. | 🟡 | Works; relation remap partial. B80 audit: copies the single page only — no children walk (`src/server/actions/page-menu.ts:229-281`); subtree clone is R80.10. Spec: docs/specs/workspaces-structure.md. |
| Multiple workspaces | Belong to several workspaces. | 🧭 | Planned; single-workspace first. B80 audit: the data path already exists (`getUserWorkspaces` + create, `src/app/app/page.tsx:10-17`) — glyph to reconcile (orchestrator). Spec: docs/specs/workspaces-structure.md. |
| Workspace switcher | Move between workspaces. | 🧭 | Planned. B80 audit: ships (`src/components/sidebar.tsx:119-125`, `sidebar/workspace-switcher.tsx`); gaps are organizational, not existence. Spec: docs/specs/workspaces-structure.md. |
| Recent pages | Recently visited list. | 🧭 | Planned. B80: no visit source modeled (0 hits for `visitedAt`/`PageVisit`); server-side recency is R80.11 (schema, M3). Spec: docs/specs/workspaces-structure.md. |
| Quick find | Ctrl/Cmd+P page switcher. | 🧭 | Planned. B80 audit: implemented and guest-scoped (`src/components/quick-find.tsx`, `search.ts:20-36`, sidebar `Ctrl K` at `sidebar.tsx:126-136`) — glyph stale, orchestrator to reconcile. Spec: docs/specs/workspaces-structure.md. |
| Backlinks | Pages linking to this page. | 🧭 | Planned; derived from page mentions. B80 audit: ships (`getBacklinks` `src/server/queries.ts:369-389`) but the page route omits guest scoping (`[pageId]/page.tsx:56`) — R80.12. Spec: docs/specs/workspaces-structure.md. |
| Linked references | Grouped backlink list with context. | 🧭 | Planned. B80 audit: panel renders (`src/components/backlinks.tsx`, `page.tsx:213`); grouping/context thin, glyph to reconcile. Spec: docs/specs/workspaces-structure.md. |
| Page history | See per-page versions. | 🧭 | Planned; see Version history. Owner spec: docs/specs/version-history-v2.md (§10 rows) — B80 cross-ref only. |
| Page favorites reorder | Reorder favorites. | 🧭 | Planned. |
| Move page | Reparent a page in the tree. | 🧭 | Planned. B80 audit: shipped (`movePageAction` `src/server/actions/pages.ts:285-323`; UI `sidebar/page-tree.tsx:373`, `page-title.tsx:204`) and duplicates §7 "Page re-parenting" — glyph to reconcile (orchestrator). Spec: docs/specs/workspaces-structure.md. |
| Workspace settings | Members, billing, security. | 🧭 | Planned. B80 audit: settings shell ships (members/teamspaces/security/activity in `settings/page.tsx`); billing belongs to docs/specs/plans-licensing.md. Spec: docs/specs/workspaces-structure.md. |
| Trash retention policy | How long trash is kept. | 🧭 | Planned; see platform. |

### 10. Version history

0 done · 0 partial · 9 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Per-page history | List of prior versions. | 🧭 | Planned; snapshot store first. Spec: docs/specs/version-history-v2.md. |
| Restore version | Revert a page to a version. | 🧭 | Planned. Spec: docs/specs/version-history-v2.md. |
| Version diff | Show changes between versions. | 🧭 | Planned; block-level diff. Spec: docs/specs/version-history-v2.md. |
| Named versions | Label a saved point. | 🧭 | Planned. Spec: docs/specs/version-history-v2.md. |
| Auto-snapshot cadence | Periodic version capture. | 🧭 | Planned. Spec: docs/specs/version-history-v2.md. |
| Retention window | How long versions persist. | 🧭 | Planned; configurable. Spec: docs/specs/version-history-v2.md. |
| Version authorship | Who made each version. | 🧭 | Planned. Spec: docs/specs/version-history-v2.md. |
| Trash recovery window | Restore window for deleted pages. | 🧭 | Planned. Spec: docs/specs/version-history-v2.md. |
| Block-level attribution | Which block changed. | 🧭 | Planned; CRDT history dependency. Spec: docs/specs/version-history-v2.md. |

### 11. Search

3 done · 2 partial · 6 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Content search | Match block content. | 🟡 | Basic; no ranking. Spec: docs/specs/search.md. |
| Search keyboard nav | Arrow/enter navigation. | 🟡 | Planned. Spec: docs/specs/search.md. |
| Search filters | Narrow by area or type. | 🧭 | Planned. Spec: docs/specs/search.md. |
| Search by type | Pages, databases, etc. | 🧭 | Planned. Spec: docs/specs/search.md. |
| Recently visited | Filter to recent items. | 🧭 | Planned. Spec: docs/specs/search.md. |
| Command palette | Keyboard command runner. | 🧭 | Planned; single entry point. Spec: docs/specs/search.md. |
| Search preview snippets | Show matched context. | 🧭 | Planned. Spec: docs/specs/search.md. |
| Search ranking | Relevance ordering. | 🧭 | Planned (Postgres FTS or trigram). Spec: docs/specs/search.md. |

### 12. Import & export

0 done · 2 partial · 20 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Import Markdown | Bring in `.md` files. | 🟡 | Basic parser; frontmatter partial. Spec: docs/specs/import-export.md. |
| Export Markdown | Page as `.md`. | 🟡 | Basic export; nested content partial. Spec: docs/specs/import-export.md. |
| Import CSV | Create databases from CSV. | 🧭 | Planned. Spec: docs/specs/import-export.md. |
| Import HTML | Import HTML documents. | 🧭 | Planned. |
| Import from another Notion-class workspace | Migrate an external export. | 🧭 | Planned; mapping to blocks. Spec: docs/specs/import-export.md. |
| Import Word (.docx) | Import documents. | 🧭 | Planned; docx parser needed. Spec: docs/specs/import-export.md. |
| Import Trello | Boards into databases. | 🧭 | Planned. Spec: docs/specs/import-export.md. |
| Import Asana | Tasks into databases. | 🧭 | Planned. |
| Import Evernote | Notes into pages. | 🧭 | Planned. |
| Import Google Docs | Docs into pages. | 🧭 | Planned. |
| Import PDF | Extract PDF into a page. | 🧭 | Planned; text-layer only first. |
| Import Confluence | Spaces into pages. | 🧭 | Planned. |
| Import progress/status | Show import job state. | 🧭 | Planned. Spec: docs/specs/import-export.md. |
| Import rollback | Undo a failed import. | 🧭 | Planned. Spec: docs/specs/import-export.md. |
| Export CSV | Database as CSV. | 🧭 | Planned. Spec: docs/specs/import-export.md. |
| Export HTML | Page as static HTML. | 🧭 | Planned. Spec: docs/specs/import-export.md. |
| Export PDF | Page as PDF. | 🧭 | Planned; headless render. Spec: docs/specs/import-export.md. |
| Bulk export | Export a whole workspace. | 🧭 | Planned. Spec: docs/specs/import-export.md. |
| Export with subpages | Include child pages. | 🧭 | Planned. Spec: docs/specs/import-export.md. |
| Export without subpages | Exclude children. | 🧭 | Planned. Spec: docs/specs/import-export.md. |
| Export as zip | Bundle in an archive. | 🧭 | Planned. Spec: docs/specs/import-export.md. |
| Export with attachments | Include media files. | 🧭 | Planned. Spec: docs/specs/import-export.md. |

### 13. Integrations & API

0 done · 4 partial · 18 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| API pagination | Cursor-based list endpoints. | 🟡 | Planned. Spec: docs/specs/integrations-api.md. |
| Google Calendar sync | Two-way calendar sync. | 🟡 | ICS subscription import (read-only); no two-way OAuth sync yet. |
| Outlook Calendar sync | Two-way calendar sync. | 🟡 | Works through the published ICS URL; native OAuth pending. |
| Public embed oEmbed | Resolve third-party link metadata. | 🟡 | Basic title/favicon fetch. |
| Public REST API | Programmatic access to content. | 🧭 | Planned; route handlers first. Spec: docs/specs/integrations-api.md. |
| API tokens | Per-user/per-integration keys. | 🧭 | Planned; hashed at rest. Spec: docs/specs/integrations-api.md. |
| API rate limits | Throttle abusive clients. | 🧭 | Planned. Spec: docs/specs/integrations-api.md. |
| Webhooks | Push events to external URLs. | 🧭 | Planned; signed payloads. Spec: docs/specs/integrations-api.md. |
| OAuth apps | Third-party authorization flow. | 🧭 | Planned. Spec: docs/specs/integrations-api.md. |
| OAuth scopes | Fine-grained permissions. | 🧭 | Planned. Spec: docs/specs/integrations-api.md. |
| Automation engine | Trigger/condition/action rules. | 🧭 | Planned. |
| Database automations | Automations over databases. | 🧭 | Planned. |
| Button actions | Buttons that run actions. | 🧭 | Planned. |
| Embedded integrations | Vendored third-party widgets. | 🧭 | Planned. |
| Zapier-style connectors | No-code automation bridge. | 🧭 | Planned; via webhooks first. Spec: docs/specs/integrations-api.md. |
| Slack integration | Unfurl and post links. | 🧭 | Planned. |
| GitHub integration | Link commits/PRs. | 🧭 | Planned. |
| Figma integration | Preview design files. | 🧭 | Planned; embed only. |
| Google Drive integration | Link/preview Drive files. | 🧭 | Planned. |
| AI connectors | Connect model providers. | 🧭 | Planned; BYO key. |
| MCP server | Expose workspace to AI agents. | 🧭 | Planned; read-first, then write. |
| Inbound webhooks | Accept events from outside. | 🧭 | Planned. |

### 14. AI

4 done · 3 partial · 9 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| AI writing assist | Draft, rewrite, and refine text. | 🟡 | “Ask AI” skills submenu in the selection toolbar and block menu; BYO provider key. Spec: docs/specs/ai-surface.md. |
| Transcription | Speech-to-text for audio. | 🟡 | `POST /api/ai/transcribe` with its own provider config (`AI_TRANSCRIBE_API_KEY`); sidebar “Transcribe audio” creates a page. Spec: docs/specs/ai-surface.md. |
| Prompt library | Reusable saved prompts. | 🟡 | Seven built-in AI skills with server-side prompts (`src/lib/ai-skills.ts`); user-defined prompts pending. Spec: docs/specs/ai-surface.md. |
| AI autofill property | Generate row values. | 🧭 | Planned. Spec: docs/specs/ai-surface.md. |
| AI block | Prompt block that generates content. | 🧭 | Planned. Spec: docs/specs/ai-surface.md. |
| Summarization | Summarize a page or section. | 🧭 | Planned. Spec: docs/specs/ai-surface.md. |
| Translation | Translate selection or page. | 🧭 | Planned. Spec: docs/specs/ai-surface.md. |
| Continue writing | Extend text from context. | 🧭 | Planned. Spec: docs/specs/ai-surface.md. |
| Explain/Simplify | Rewrite for clarity. | 🧭 | Planned. Spec: docs/specs/ai-surface.md. |
| Local model support | Run models without a cloud. | 🧭 | Planned; aligns with self-hosting. Spec: docs/specs/ai-surface.md. |
| AI cost controls | Token budgets per workspace. | 🧭 | Planned. Spec: docs/specs/ai-surface.md. |
| AI data boundaries | Guarantee no training on your data. | 🧭 | Planned; documented policy. Spec: docs/specs/ai-surface.md. |

### 15. Media & embeds

9 done · 4 partial · 8 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Video upload | Store and play video. | 🟡 | Local playback (a drop inserts a link the browser plays); no transcoding and no video node — docs/specs/editor-deep.md R84.7, honest partial. |
| Audio upload | Store and play audio. | 🟡 | Local playback (a drop inserts a link); player/waveform UI absent — docs/specs/editor-deep.md R84.7/R84.9, honest partial. |
| Paste image from clipboard | Insert a copied image. | 🟡 | Works for many sources. |
| Iframe embeds | Generic sandboxed iframes. | 🟡 | Provider-only: every iframe passes `isEmbedHostAllowed()` (plus CSP `frame-src`) and carries a provider-specific `allow` list, `referrerPolicy` and title — arbitrary-URL iframes stay refused (bookmark fallback) and no `sandbox` attribute ships yet. |
| File size limits | Cap uploads per plan. | 🧭 | Planned; per-workspace config. |
| PDF preview | Inline PDF viewing. | 🧭 | Planned. |
| Code embed | Embed executable snippets. | 🧭 | Planned. |
| Maps embed | Show a location map. | 🧭 | Planned. |
| Tweet embed | Embed a post. | 🧭 | Planned. |
| Figma embeds | Live design embed. | 🧭 | Planned. |
| Animated GIF/devices | Play GIFs and device previews. | 🧭 | Planned. |
| Media garbage collection | Remove orphaned assets. | 🧭 | Planned. |

### 16. Navigation & UX

25 done · 7 partial · 15 planned · 2 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Breadcrumbs | Ancestor path in header. | 🟡 | Renders; interactions partial. |
| Page tree navigation | Expand/collapse tree. | 🟡 | Works; state persistence partial. |
| Keyboard shortcuts | Global and editor shortcuts. | 🟡 | Core subset implemented. |
| Focus management | Visible focus and traps. | 🟡 | Global `:focus-visible` ring everywhere; B45 hardened `ui/dialog` — Tab/Shift+Tab cycle inside with wrap, explicit `aria-modal="true"`, initial focus in-dialog, and focus restored to the invoker even for trigger-less controlled dialogs — plus `ui/dropdown-menu` (Escape → focus back to its trigger); both locked by `e2e/focus.spec.ts`. Still partial: hand-rolled feature overlays bypass the primitive entirely — `topbar/actions-menu`, `who-has-access`, `version-history`, `tickets/ticket-drawer`, `editor/equation-editor` have no Tab trap, Escape only works in the actions menu and equation editor, and `version-history` / `ticket-drawer` also lack `aria-modal` → feature-level follow-up (feature components are off-limits to B45). |
| RTL support | Right-to-left layouts. | 🟡 | Arabic sets `dir="rtl"` and logical CSS; mixed-direction blocks untested. |
| Notifications / toasts | Transient status messages. | 🟡 | Planned. B82 spec `docs/specs/notifications.md` §9 standardizes the surface (202 `toast.*` sites / 41 files audited): one `<Toaster>`, `toast.info` banned by `check:coherence`, all strings via `t()` (51 literals → 0), shared catalog + `check-toasts.mjs`, durations 4 s/8 s — R82.30-R82.36. |
| Actions menu: Notify me → Comments submenu | Per-page comment notification level (All/Mentions/None). | 🟡 | Radio submenu ships and persists per page — but in localStorage only; no server-side model/enforcement yet (B11 partial). B82 spec `docs/specs/notifications.md` closes it: the level becomes a server `NotificationPreference` row that `notify()` itself enforces (today `comment.reply`/`page.mention` ignore it — D6/D7); `noema:page-notify:*` survives only as a one-time hydration source — R82.15-R82.18. |
| Mobile layout | Responsive small-screen UI. | 🧭 | Planned; dedicated shell. |
| Side peek | Preview in a side drawer. | 🧭 | Planned. Spec: docs/specs/navigation-ux.md. |
| Back/forward navigation | History within the app. | 🧭 | Planned; router-driven. Spec: docs/specs/navigation-ux.md. |
| Tabs for pages | Multiple open pages as tabs. | 🧭 | Planned; optional UX. Spec: docs/specs/navigation-ux.md. |
| Shortcut: quick find | Cmd/Ctrl+P. | 🧭 | Planned. |
| Shortcut: new page | Cmd/Ctrl+N. | 🧭 | Planned. |
| Shortcut: search | Cmd/Ctrl+K or similar. | 🧭 | Planned. |
| Shortcut: toggle sidebar | Cmd/Ctrl+\\. | 🧭 | Planned. |
| Shortcut: duplicate block | Cmd/Ctrl+D. | 🧭 | Planned. |
| Custom fonts | Choose font pairing. | 🧭 | Planned. |
| Undo/redo (global) | App-wide undo beyond editor. | 🧭 | Planned. |
| Offline mode | Work without connectivity. | 🧭 | Planned; core to local-first goal. |
| Reduced-motion support | Respect motion preferences. | 🧭 | Planned. |
| High-contrast support | Stronger contrast theme. | 🧭 | Planned. |
| Command palette | Unified action launcher. | 🧭 | Planned. |
| Actions menu: Turn into wiki | Convert page to a wiki. | ⛔ | Data model lacks wiki type; blocked pending spec. B11 ships the entry as a disabled menu item with tooltip "Wiki coming soon" — not faked. |
| Open in desktop app | "Open in Windows app" entry. | ⛔ | No desktop app; N/A for web parity. |

### 17. Data model & platform

6 done · 9 partial · 22 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Stable block ids | Every block has a durable id. | 🟡 | Ids exist; not enforced on all operations. Spec: docs/specs/engineering-hardening.md. |
| Transactions / atomic writes | All-or-nothing updates. | 🟡 | Planned; Prisma transactions. Spec: docs/specs/engineering-hardening.md. |
| Audit log | Record sensitive actions. | 🟡 | Planned. |
| Soft delete | Mark-deleted rather than purge. | 🟡 | `deletedAt` columns used. |
| Multi-tenancy | Isolate workspaces. | 🟡 | Workspace scoping modeled. |
| Authentication | Sign-up and sign-in. | 🟡 | Session auth; providers limited. |
| Session management | Expire and revoke sessions. | 🟡 | Sessions stored; revocation partial. Spec: docs/specs/engineering-hardening.md. |
| Secret handling | Manage keys safely. | 🟡 | Env-based; vault planned. Spec: docs/specs/engineering-hardening.md. |
| Self-hosting | Run on your own server. | 🟡 | Local dev works; packaging pending. Spec: docs/specs/engineering-hardening.md. |
| Page snapshots | Versioned page state. | 🧭 | Planned; basis for history. |
| Incremental syncing | Sync only changed blocks. | 🧭 | Planned; op-log approach. |
| Offline cache | Local store for offline use. | 🧭 | Planned (IndexedDB/SQLite). |
| Sync conflict handling | Merge concurrent edits. | 🧭 | Planned; CRDT. |
| Trash retention | Auto-purge after a window. | 🧭 | Planned; scheduled job. |
| Rate limiting | Throttle API/site traffic. | 🧭 | Planned; middleware. |
| Restore from backup | Recover data. | 🧭 | Planned. |
| Observability | Logs, metrics, traces. | 🧭 | Planned; OpenTelemetry. |
| Error tracking | Capture and triage errors. | 🧭 | Planned. |
| Two-factor auth (2FA) | TOTP second factor. | 🧭 | Planned. |
| OIDC support | OpenID Connect providers. | 🧭 | Planned. |
| Encryption at rest | Encrypt stored data. | 🧭 | Planned; DB/disk encryption. |
| Encryption in transit | TLS everywhere. | 🧭 | Planned; reverse-proxy TLS. |
| Docker images | Containerized deployment. | 🧭 | Planned; multi-stage build. Spec: docs/specs/engineering-hardening.md. |
| Docker Compose | One-command stack. | 🧭 | Planned; app + Postgres. Spec: docs/specs/engineering-hardening.md. |
| Reverse-proxy guidance | nginx/Caddy docs. | 🧭 | Planned. Spec: docs/specs/engineering-hardening.md. |
| Health checks | Liveness/readiness endpoints. | 🧭 | Planned. |
| Feature flags | Gate in-progress features. | 🧭 | Planned. |
| Background jobs | Async task runner. | 🧭 | Planned; queue for imports/AI. |
| WebSocket/SSE gateway | Realtime transport. | 🧭 | Planned for collaboration. |
| Data export portability | Take your data out. | 🧭 | Planned; see export. |
| GDPR data controls | Delete/export personal data. | 🧭 | Planned; admin tooling. |

### 18. Pricing & plan-gated features

0 done · 0 partial · 14 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Free plan | Basic single-user/or small-team tier. | 🧭 | Planned; core features ungated. Spec: docs/specs/plans-licensing.md. |
| Personal plan | Individual power user. | 🧭 | Planned. Spec: docs/specs/plans-licensing.md. |
| Team plan | Shared workspace features. | 🧭 | Planned. Spec: docs/specs/plans-licensing.md. |
| Enterprise plan | SSO, audit, controls. | 🧭 | Planned; SSO/audit gated. Spec: docs/specs/plans-licensing.md. |
| Plan gates | Restrict features by plan. | 🧭 | Planned; feature-flag driven. Spec: docs/specs/plans-licensing.md. |
| Guest limits by plan | Cap external guests. | 🧭 | Planned. Spec: docs/specs/plans-licensing.md. |
| File upload limits by plan | Cap storage per plan. | 🧭 | Planned. Spec: docs/specs/plans-licensing.md. |
| Version-history retention by plan | Longer history on paid plans. | 🧭 | Planned. Spec: docs/specs/plans-licensing.md. |
| AI usage limits by plan | Token budget per plan. | 🧭 | Planned. Spec: docs/specs/plans-licensing.md. |
| Self-hosted license option | Run enterprise features locally. | 🧭 | Planned; open-core consideration. Spec: docs/specs/plans-licensing.md. |
| Billing integration | Payment provider hooks. | 🧭 | Planned; provider-agnostic. Spec: docs/specs/plans-licensing.md. |
| Seat management | Add/remove billed seats. | 🧭 | Planned. Spec: docs/specs/plans-licensing.md. |
| Plan change proration | Upgrade/downgrade billing. | 🧭 | Planned. Spec: docs/specs/plans-licensing.md. |
| Usage metering | Track consumption per plan. | 🧭 | Planned. Spec: docs/specs/plans-licensing.md. |

### 19. Known limitations & quirks

0 done · 0 partial · 8 planned · 7 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Limited export fidelity | Exports lose some structure. | 🧭 | Noema targets lossless round-trips. |
| Steep permissions model | Complex inheritance surprises. | 🧭 | Noema makes inheritance explicit and previewable. |
| Performance on huge pages | Very large pages degrade. | 🧭 | Noema virtualizes blocks and lags less. |
| Formula language quirks | Subtle type/precedence gotchas. | 🧭 | Noema documents semantics precisely. |
| Two-way relation setup friction | Relations confuse new users. | 🧭 | Noema offers guided relation creation. |
| Recurring template scheduler | Limited scheduling control. | 🧭 | Noema exposes cron-style control. |
| Search relevance opacity | Ranking is hard to tune. | 🧭 | Noema exposes ranking knobs. |
| Mandatory accounts for sharing | Viewers may need accounts. | 🧭 | Noema plans lightweight guest viewing. |
| Cloud-only history depth | Some tiers limit history length. | ⛔ | Noema keeps configurable local history; divergence. |
| No offline-first guarantee | Some apps require connectivity. | ⛔ | Noema is local-first by design; divergence. |
| Vendor data residency | Content lives on vendor servers. | ⛔ | Self-hosting keeps data on your infra; divergence. |
| Opaque sync conflicts | Silent last-writer-wins behavior. | ⛔ | Noema uses CRDT with visible provenance. |
| Migration lock-in | Hard to leave the platform. | ⛔ | Noema prioritizes portable data; divergence. |
| AI vendor lock-in | AI options tied to one vendor. | ⛔ | Noema supports BYO/local models; divergence. |
| Third-party tracking | Hosted analytics on public pages. | ⛔ | Noema ships no trackers by default; divergence. |

### 20. Projects, tickets & planning

27 done · 1 partial · 4 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Roadmap view | Timeline across projects. | 🟡 | Project Gantt exists; a cross-project roadmap view is pending. |
| Automations | Rules on status/label changes. | 🧭 | Planned. Spec: docs/specs/automations.md. |
| Recurring tickets | Repeat on a schedule. | 🧭 | Planned; template recurrence exists for page templates. Spec: docs/specs/automations.md. |
| Workload & capacity | Per-person load planning. | 🧭 | Planned; assignee + estimate data is available. |
| Per-project role editor | Fine-grained project roles. | 🧭 | Planned; workspace roles exist today. |

