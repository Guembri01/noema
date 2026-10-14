# Noema — remaining work

> Generated from `docs/FEATURE_MATRIX.md` by `npm run docs:gaps`. Do not edit by hand.

**Scoreboard:** 563 feature rows — 174 implemented · 89 partial · 286 planned · 14 deliberately out of scope.

This file lists the **375** rows that are not finished, area by area, plus 14 intentional divergences.

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

34 done · 29 partial · 35 planned · 2 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Inline equation | Small LaTeX expression inside a text line. | 🟡 | KaTeX renderer wired; editing UX rough. |
| Block equation | Centered display equation. | 🟡 | Renders via KaTeX; edit/preview split unstable. |
| KaTeX/LaTeX support | Math syntax engine for equations. | 🟡 | KaTeX chosen; macro support limited. |
| Columns (2/3/4/5) | Arrange blocks side by side. | 🟡 | Two-column layout works; add/remove columns UI missing. |
| Simple table block | Grid of rows and columns in a page. | 🟡 | Basic table; no header styling controls yet. |
| Table header row/column | Designate header row/column. | 🟡 | Toggle exists in logic; styling minimal. |
| Table of contents | Auto-generated page outline with links. | 🟡 | Lists headings; scroll-spy navigation partial. |
| Breadcrumb block | Shows the page's ancestor path. | 🟡 | Renders path; deep-tree linking rough. |
| Image block | Embed an uploaded or linked image. | 🟡 | Upload, caption and alt text work; drag-to-resize and align controls are the remaining gap. |
| Video block | Embed or upload video. | 🟡 | Local file playback; provider embeds limited. |
| Audio block | Embed or upload audio. | 🟡 | Local playback; waveform UI missing. |
| File block | Attach an arbitrary file for download. | 🟡 | Upload/download works; preview types limited. |
| Bookmark block | Rich link preview card. | 🟡 | Fetches title/favicon; no thumbnail metadata yet. |
| Embed block | Generic iframe embed by URL. | 🟡 | Sandboxed iframe; provider allowlist pending. |
| YouTube embed | Video embed by URL. | 🟡 | Recognized and embedded; uses generic iframe path. |
| Inline database block | A database rendered inside a page. | 🟡 | Renders a collection view inline; view config incomplete. |
| Page link mention | Inline link to another page. | 🟡 | `@` picker inserts a page link node. |
| Date mention | Inline date chip. | 🟡 | Inserted by mention menu; formatting limited. |
| Person mention | Inline user chip. | 🟡 | Renders user; notifications on mention minimal. |
| Multi-block selection | Select a range of blocks. | 🟡 | Shift+click works; select-all edge cases. |
| Markdown shortcuts | Type `#`, `-`, `>`, `` ` ``, `[]`, etc. to convert. | 🟡 | Core shortcuts work; many missing. |
| `@` mention menu | Mention pages, people, dates. | 🟡 | Page/date/person entries; scoping partial. |
| Emoji picker | Insert emoji via `:` or picker. | 🟡 | Picker works; shortcode expansion partial. |
| Page icon | Emoji or image as a page icon. | 🟡 | Emoji icons work; image icons limited. |
| Page cover | Banner image on a page. | 🟡 | Upload works; reposition/resize missing. |
| Sub-pages section | Auto-list of child pages on a parent. | 🟡 | Inline listing exists; reorder partial. |
| Full-width toggle | Expand content to the full viewport width. | 🟡 | Toggle works per page; persisted. |
| Page breadcrumb header | Ancestor path in the page header. | 🟡 | Renders; interactions partial. |
| Favorite page | Star a page for the sidebar. | 🟡 | Stored; sidebar section UI partial. |
| Toggle heading | Heading that doubles as a toggle. | 🧭 | Composite of heading + toggle planned. |
| Pull quote / large quote | Display-scale quotation styling. | 🧭 | Planned as a quote variant. |
| Code block line numbers | Optional gutter numbering. | 🧭 | Planned as a code-block setting. |
| Code block caption | Caption text under a code block. | 🧭 | Planned. |
| Math editor UX | Popover to compose equations with symbols. | 🧭 | Planned composer with symbol palette. |
| Column resize | Drag the divider to change column width. | 🧭 | Planned with persisted widths. |
| Table cell colors | Background color for cells. | 🧭 | Planned. |
| Synced block | Mirror one block's content in many places. | 🧭 | Planned via reference ids; editing propagation needs care. |
| Synced block source marker | Visual marker of the canonical source. | 🧭 | Planned. |
| Template button block | Reusable set of blocks inserted on click. | 🧭 | Planned; depends on template subsystem. |
| Button block | Interactive button triggering configured actions. | 🧭 | Planned; depends on automations. |
| Ask-AI block | Prompt-driven AI block inside a page. | 🧭 | Planned; depends on AI layer and provider keys. |
| Two-column page property layout | Place properties side by side. | 🧭 | Planned with property panel rework. |
| Image resize | Drag handles to change displayed width. | 🧭 | Planned. |
| PDF preview block | Inline PDF viewer. | 🧭 | Planned; needs a viewer component. |
| Map block | Embedded map for an address. | 🧭 | Planned; provider-agnostic embed. |
| Twitter/X embed | Rich post embed. | 🧭 | Planned via oEmbed-style resolution. |
| Vimeo embed | Video embed by URL. | 🧭 | Planned. |
| Figma embed | Live design embed. | 🧭 | Planned. |
| CodePen/CodeSandbox embed | Interactive code embeds. | 🧭 | Planned. |
| Google Drive preview | Preview a linked Drive document. | 🧭 | Planned. |
| Linked view of a database | Re-display an existing database elsewhere. | 🧭 | Planned; requires stable view model. |
| Block reference / mention | Inline reference to a specific block. | 🧭 | Planned; block-id resolution needed. |
| Synced/reference content | Reference that mirrors another block. | 🧭 | Shares machinery with synced blocks. |
| Unlinked mention | Detects the page name typed without a link. | 🧭 | Planned as a backlink-discovery pass. |
| Drag to another page | Move a block into a different page. | 🧭 | Planned. |
| Copy block link | Copy a deep link to a block. | 🧭 | Planned. |
| Copy as Markdown | Copy selection as Markdown text. | 🧭 | Planned. |
| Cover reposition | Drag the cover image position. | 🧭 | Planned. |
| Callout icon picker | Choose the callout's icon. | 🧭 | Planned. |
| Small text | Reduce body font size for a page. | 🧭 | Planned page-level style setting. |
| Page fonts | Choose from preset font families. | 🧭 | Planned; ships three classic pairings. |
| Line spacing | Control paragraph line-height. | 🧭 | Planned as a page/appearance option. |
| Page locking | Prevent edits to a page. | 🧭 | Planned; depends on permission layer. |
| Page description | Short summary surfaced in previews. | 🧭 | Planned; used by search previews. |
| Comment block (doc annotation) | Pulls comments conceptually into flow. | ⛔ | Superseded by the inline comment model; not a block. |
| Table merge/split cells | Combine or split cells. | ⛔ | High complexity for low demand; revisit if requested. |

### 2. Text formatting

9 done · 8 partial · 4 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Link editing | Change or remove a link. | 🟡 | Remove works; inline edit popover basic. |
| Link title on hover | Show URL on hover. | 🟡 | Tooltip present; styling minimal. |
| Highlight/background color | Marker-style background on text. | 🟡 | Background works; palette limited. |
| Text color | Colored text spans. | 🟡 | Palette limited; some hues missing. |
| Inline math | LaTeX span inside text. | 🟡 | KaTeX renderer; inline edit rough. |
| Markdown shortcut detection | Live conversion of typed syntax. | 🟡 | Core syntax covered; edge cases missing. |
| Paste with formatting | Preserve rich formatting on paste. | 🟡 | HTML paste works; style cleanup partial. |
| Paste without formatting | Strip styles on paste. | 🟡 | Shortcut present; some wrappers leak. |
| Clear formatting | Reset marks on a range. | 🧭 | Planned as a keyboard action. |
| Subscript | Baseline-lowered text. | 🧭 | Planned if demand justifies. |
| Superscript | Baseline-raised text. | 🧭 | Planned if demand justifies. |
| Ligatures & smart quotes | Typographic niceties while typing. | 🧭 | Planned as an editor option. |
| Small caps / all caps | Display transforms for text. | ⛔ | Rarely used in prose; not planned. |

### 3. Databases

15 done · 2 partial · 36 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Open row as page | Full-page row view. | 🟡 | Route, editor blocks and comments work, and the table/peek offer one-click *Open as page*; a properties strip + back-to-database breadcrumb on the row page needs `app/w/[slug]/[pageId]/page.tsx`, outside B15's ownership (queued for the page-route batch). |
| Inline database | Database embedded in a page body. | 🟡 | Renders through the editor's linked-database node view; its height/scroll shell lives in `src/components/editor/**` (editor slot), so the scroll fix is queued there rather than patched from B15. |
| Board view | Kanban grouped by a property. | 🧭 | Planned; grouping engine needed. |
| List view | Compact single-line list. | 🧭 | Planned. |
| Gallery view | Card grid with previews. | 🧭 | Planned. |
| Calendar view | Rows on a month/week calendar. | 🧭 | Planned; needs date property engine. |
| Timeline view | Rows on a horizontal time axis. | 🧭 | Planned. |
| Chart view | Aggregate charts over the database. | 🧭 | Planned; aggregation dependency. |
| Form view | Public/Internal form that creates rows. | 🧭 | Planned. |
| AND/OR filter groups | Boolean combination of filters. | 🧭 | Planned as a filter tree. |
| Nested filter groups | Arbitrary-depth boolean nesting. | 🧭 | Planned after flat groups. |
| Groups | Bucket rows by a property. | 🧭 | Planned; mainly for board/list. |
| Group aggregation | Show a summary per group. | 🧭 | Planned. |
| Hidden groups | Collapse or hide groups. | 🧭 | Planned. |
| Conditional formatting | Color rows/cells by rule. | 🧭 | Planned. |
| Row color rules | Two-tone row backgrounds. | 🧭 | Planned subset of conditional formatting. |
| Quick filter from header | Filter directly from a column header. | 🧭 | Planned. |
| Open row in side peek | Preview row in a side drawer. | 🧭 | Planned; needs drawer shell. |
| Linked database | Reuse a database elsewhere. | 🧭 | Planned; requires view identity model. |
| Row reordering | Drag rows in a view order. | 🧭 | Planned with manual order property. |
| Column resize/reorder | Resize and reorder columns. | 🧭 | Planned. |
| Calculations/footer | Aggregations under columns. | 🧭 | Planned (count, sum, average, etc.). |
| Database description | Intro text above a database. | 🧭 | Planned. |
| Database lock | Prevent schema edits. | 🧭 | Planned; depends on permissions. |
| Duplicate database | Copy a database with structure. | 🧭 | Planned. |
| Sub-items / sub-tasks | Parent-child rows inside a database. | 🧭 | Planned; tree ordering needed. |
| Dependencies | Blocking/blocked-by between rows. | 🧭 | Planned; mainly for timeline. |
| Timeline dependencies | Draw dependency arrows on timeline. | 🧭 | Planned. |
| Calendar multi-day events | Span events across days. | 🧭 | Planned. |
| Gallery previews | Show cover or page content on cards. | 🧭 | Planned. |
| Board grouping | Group board columns by property. | 🧭 | Planned. |
| Buttons in databases | Row actions via buttons. | 🧭 | Planned; depends on automations. |
| Database templates | Pre-filled row templates. | 🧭 | Planned. |
| Default template | Auto-apply a template to new rows. | 🧭 | Planned. |
| Recurring templates | Create rows on a schedule. | 🧭 | Planned; depends on a scheduler. |
| CSV import | Import rows from CSV. | 🧭 | Planned; header mapping UI. |
| CSV export | Export rows to CSV. | 🧭 | Planned. |
| Unique ID property | Human-readable per-row id. | 🧭 | Planned; see Properties. |

### 4. Properties

19 done · 1 partial · 15 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Last edited by | Last editor. | 🟡 | Tracked from property/table edits via the activity log (falls back to creator); content/title edits outside the database view not yet recorded. |
| Date range | Start and end date. | 🧭 | Planned. |
| Date reminders | Notify at a chosen time. | 🧭 | Planned; depends on scheduler. |
| Date time zone | Time-zone-aware timestamps. | 🧭 | Planned; store as UTC + zone. |
| Formula property | Computed value from an expression. | 🧭 | Planned; see Formulas. |
| Relation property | Link rows across databases. | 🧭 | Planned. Spec: docs/specs/relations-rollups.md. |
| Relation (single) | One linked row. | 🧭 | Planned. Spec: docs/specs/relations-rollups.md. |
| Relation (multi) | Many linked rows. | 🧭 | Planned. Spec: docs/specs/relations-rollups.md. |
| Two-way relation | Reciprocal relation property. | 🧭 | Planned; requires pair metadata. Spec: docs/specs/relations-rollups.md. |
| Rollup property | Aggregate across a relation. | 🧭 | Planned; depends on relations. Spec: docs/specs/relations-rollups.md. |
| Rollup functions | Count, sum, average, min/max, join, etc. | 🧭 | Planned function set. Spec: docs/specs/relations-rollups.md. |
| Unique ID property | Monotonic per-database id. | 🧭 | Planned. |
| Button property | Trigger actions from a row. | 🧭 | Planned. |
| Place/location property | Address with map preview. | 🧭 | Planned. |
| Verification property | Verified-by-owner marker. | 🧭 | Planned; wiki-oriented. |
| AI autofill property | AI-generated value per row. | 🧭 | Planned; depends on AI layer. |
| Property type change | Convert a property's type. | ⛔ | Lossy conversions; only safe transforms planned later. |

### 5. Formulas

0 done · 0 partial · 16 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Formula editor | Author expressions with autocomplete. | 🧭 | Planned; expression parser first. |
| Arithmetic operators | `+ - * / %` and precedence. | 🧭 | Planned. |
| Comparison operators | `== != < <= > >=`. | 🧭 | Planned. |
| Boolean operators | `and`, `or`, `not`. | 🧭 | Planned. |
| Property references | Reference other properties by name. | 🧭 | Planned. |
| Math functions | `abs`, `round`, `ceil`, `floor`, `min`, `max`, etc. | 🧭 | Planned function library. |
| Text functions | `concat`, `length`, `slice`, `replace`, `lower`, `upper`, etc. | 🧭 | Planned. |
| Logic functions | `if`, `ifs`, `and`/`or` helpers. | 🧭 | Planned. |
| Date functions | `now`, `dateAdd`, `dateBetween`, `formatDate`, etc. | 🧭 | Planned. |
| List functions | `map`, `filter`, `sort`, `join`, `length`. | 🧭 | Planned; depends on rollups. |
| Regex functions | `match`, `replace` with patterns. | 🧭 | Planned; sandboxed engine. |
| Regex extraction | Capture groups into values. | 🧭 | Planned. |
| Rollups in formulas | Reference rollup results. | 🧭 | Planned; ordering dependency. |
| Formula error states | Friendly errors for bad expressions. | 🧭 | Planned. |
| Formula result caching | Recompute efficiently on change. | 🧭 | Planned; dependency graph. |
| Named constants | Reuse of workspace-level values. | 🧭 | Planned nicety. |

### 6. Templates

1 done · 2 partial · 6 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Page templates | Duplicate a page for reuse. | 🟡 | Duplicate-page works; gallery UI missing. |
| Template duplication | Clone a template into a page. | 🟡 | Planned. |
| Database templates | Pre-filled rows from a template. | 🧭 | Planned. |
| Template button | Insert template content in a page. | 🧭 | Planned. |
| Default template | Auto-apply to new rows. | 🧭 | Planned. |
| Recurring templates | Scheduled row creation. | 🧭 | Planned; needs scheduler. |
| Save page as template | Convert a page into a template. | 🧭 | Planned. |
| Template locking | Keep templates read-only. | 🧭 | Planned. |
| Template from selection | Turn a block selection into a template. | ⛔ | Uncommon flow; skip initially. |

### 7. Collaboration

13 done · 2 partial · 11 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Avatars | Per-user avatars in the UI. | 🟡 | Avatar field exists; presence UI pending. |
| Page comments | Comment threads on a page. | 🟡 | Data model basic; UI minimal. |
| Real-time multiplayer editing | Multiple users edit simultaneously. | 🧭 | Planned; local-first CRDT then sync. Spec: docs/specs/realtime-collab.md. |
| CRDT data model | Conflict-free replicated structures. | 🧭 | Planned (automerge/Yjs-style). Spec: docs/specs/realtime-collab.md. |
| Presence | See who is viewing a page. | 🧭 | Planned. |
| Live cursors | Remote carets and selections. | 🧭 | Planned; needs presence transport. |
| Suggestions mode | Propose edits for approval. | 🧭 | Planned; diff overlay needed. |
| Accept/reject suggestion | Resolve proposed changes. | 🧭 | Planned. |
| Following pages | Follow a page for updates. | 🧭 | Planned. |
| Notification inbox | Central list of notifications. | 🧭 | Planned. |
| Notification preferences | Control what triggers alerts. | 🧭 | Planned. |
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

5 done · 7 partial · 11 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Page tree | Hierarchical page nesting. | 🟡 | Nesting works; large-tree performance untested. |
| Favorites | Pinned pages section. | 🟡 | Modeled; sidebar rendering partial. |
| Trash / recently deleted | Deleted pages list. | 🟡 | Soft delete exists; trash UI partial. |
| Restore from trash | Undo a deletion. | 🟡 | Planned. |
| Permanent delete | Permanently remove an item. | 🟡 | Planned; purge job needed. |
| Sidebar collapse | Collapse the sidebar. | 🟡 | Toggle works. |
| Duplicate page | Clone a page with children. | 🟡 | Works; relation remap partial. |
| Multiple workspaces | Belong to several workspaces. | 🧭 | Planned; single-workspace first. |
| Workspace switcher | Move between workspaces. | 🧭 | Planned. |
| Recent pages | Recently visited list. | 🧭 | Planned. |
| Quick find | Ctrl/Cmd+P page switcher. | 🧭 | Planned. |
| Backlinks | Pages linking to this page. | 🧭 | Planned; derived from page mentions. |
| Linked references | Grouped backlink list with context. | 🧭 | Planned. |
| Page history | See per-page versions. | 🧭 | Planned; see Version history. |
| Page favorites reorder | Reorder favorites. | 🧭 | Planned. |
| Move page | Reparent a page in the tree. | 🧭 | Planned. |
| Workspace settings | Members, billing, security. | 🧭 | Planned. |
| Trash retention policy | How long trash is kept. | 🧭 | Planned; see platform. |

### 10. Version history

0 done · 0 partial · 9 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Per-page history | List of prior versions. | 🧭 | Planned; snapshot store first. |
| Restore version | Revert a page to a version. | 🧭 | Planned. |
| Version diff | Show changes between versions. | 🧭 | Planned; block-level diff. |
| Named versions | Label a saved point. | 🧭 | Planned. |
| Auto-snapshot cadence | Periodic version capture. | 🧭 | Planned. |
| Retention window | How long versions persist. | 🧭 | Planned; configurable. |
| Version authorship | Who made each version. | 🧭 | Planned. |
| Trash recovery window | Restore window for deleted pages. | 🧭 | Planned. |
| Block-level attribution | Which block changed. | 🧭 | Planned; CRDT history dependency. |

### 11. Search

3 done · 2 partial · 6 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Content search | Match block content. | 🟡 | Basic; no ranking. |
| Search keyboard nav | Arrow/enter navigation. | 🟡 | Planned. |
| Search filters | Narrow by area or type. | 🧭 | Planned. |
| Search by type | Pages, databases, etc. | 🧭 | Planned. |
| Recently visited | Filter to recent items. | 🧭 | Planned. |
| Command palette | Keyboard command runner. | 🧭 | Planned; single entry point. |
| Search preview snippets | Show matched context. | 🧭 | Planned. |
| Search ranking | Relevance ordering. | 🧭 | Planned (Postgres FTS or trigram). |

### 12. Import & export

0 done · 2 partial · 20 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Import Markdown | Bring in `.md` files. | 🟡 | Basic parser; frontmatter partial. |
| Export Markdown | Page as `.md`. | 🟡 | Basic export; nested content partial. |
| Import CSV | Create databases from CSV. | 🧭 | Planned. |
| Import HTML | Import HTML documents. | 🧭 | Planned. |
| Import from another Notion-class workspace | Migrate an external export. | 🧭 | Planned; mapping to blocks. |
| Import Word (.docx) | Import documents. | 🧭 | Planned; docx parser needed. |
| Import Trello | Boards into databases. | 🧭 | Planned. |
| Import Asana | Tasks into databases. | 🧭 | Planned. |
| Import Evernote | Notes into pages. | 🧭 | Planned. |
| Import Google Docs | Docs into pages. | 🧭 | Planned. |
| Import PDF | Extract PDF into a page. | 🧭 | Planned; text-layer only first. |
| Import Confluence | Spaces into pages. | 🧭 | Planned. |
| Import progress/status | Show import job state. | 🧭 | Planned. |
| Import rollback | Undo a failed import. | 🧭 | Planned. |
| Export CSV | Database as CSV. | 🧭 | Planned. |
| Export HTML | Page as static HTML. | 🧭 | Planned. |
| Export PDF | Page as PDF. | 🧭 | Planned; headless render. |
| Bulk export | Export a whole workspace. | 🧭 | Planned. |
| Export with subpages | Include child pages. | 🧭 | Planned. |
| Export without subpages | Exclude children. | 🧭 | Planned. |
| Export as zip | Bundle in an archive. | 🧭 | Planned. |
| Export with attachments | Include media files. | 🧭 | Planned. |

### 13. Integrations & API

0 done · 3 partial · 19 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Google Calendar sync | Two-way calendar sync. | 🟡 | ICS subscription import (read-only); no two-way OAuth sync yet. |
| Outlook Calendar sync | Two-way calendar sync. | 🟡 | Works through the published ICS URL; native OAuth pending. |
| Public embed oEmbed | Resolve third-party link metadata. | 🟡 | Basic title/favicon fetch. |
| Public REST API | Programmatic access to content. | 🧭 | Planned; route handlers first. |
| API tokens | Per-user/per-integration keys. | 🧭 | Planned; hashed at rest. |
| API pagination | Cursor-based list endpoints. | 🧭 | Planned. |
| API rate limits | Throttle abusive clients. | 🧭 | Planned. |
| Webhooks | Push events to external URLs. | 🧭 | Planned; signed payloads. |
| OAuth apps | Third-party authorization flow. | 🧭 | Planned. |
| OAuth scopes | Fine-grained permissions. | 🧭 | Planned. |
| Automation engine | Trigger/condition/action rules. | 🧭 | Planned. |
| Database automations | Automations over databases. | 🧭 | Planned. |
| Button actions | Buttons that run actions. | 🧭 | Planned. |
| Embedded integrations | Vendored third-party widgets. | 🧭 | Planned. |
| Zapier-style connectors | No-code automation bridge. | 🧭 | Planned; via webhooks first. |
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
| AI writing assist | Draft, rewrite, and refine text. | 🟡 | “Ask AI” skills submenu in the selection toolbar and block menu; BYO provider key. |
| Transcription | Speech-to-text for audio. | 🟡 | `POST /api/ai/transcribe` with its own provider config (`AI_TRANSCRIBE_API_KEY`); sidebar “Transcribe audio” creates a page. |
| Prompt library | Reusable saved prompts. | 🟡 | Seven built-in AI skills with server-side prompts (`src/lib/ai-skills.ts`); user-defined prompts pending. |
| AI autofill property | Generate row values. | 🧭 | Planned. |
| AI block | Prompt block that generates content. | 🧭 | Planned. |
| Summarization | Summarize a page or section. | 🧭 | Planned. |
| Translation | Translate selection or page. | 🧭 | Planned. |
| Continue writing | Extend text from context. | 🧭 | Planned. |
| Explain/Simplify | Rewrite for clarity. | 🧭 | Planned. |
| Local model support | Run models without a cloud. | 🧭 | Planned; aligns with self-hosting. |
| AI cost controls | Token budgets per workspace. | 🧭 | Planned. |
| AI data boundaries | Guarantee no training on your data. | 🧭 | Planned; documented policy. |

### 15. Media & embeds

4 done · 7 partial · 10 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Video upload | Store and play video. | 🟡 | Local playback; transcoding absent. |
| Audio upload | Store and play audio. | 🟡 | Local playback. |
| Image captions | Caption under an image. | 🟡 | Field exists. |
| Paste image from clipboard | Insert a copied image. | 🟡 | Works for many sources. |
| Drag-drop files | Drop files onto a page. | 🟡 | Works; upload progress minimal. |
| Iframe embeds | Generic sandboxed iframes. | 🟡 | Allowed with a sandbox. |
| YouTube/Vimeo embeds | Video embeds by URL. | 🟡 | Generic embed path; providers limited. |
| File size limits | Cap uploads per plan. | 🧭 | Planned; per-workspace config. |
| Image resize | Change displayed dimensions. | 🧭 | Planned. |
| Alignment controls | Left/center/right media. | 🧭 | Planned. |
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
| Focus management | Visible focus and traps. | 🟡 | Basic focus ring; modal traps partial. |
| RTL support | Right-to-left layouts. | 🟡 | Arabic sets `dir="rtl"` and logical CSS; mixed-direction blocks untested. |
| Notifications / toasts | Transient status messages. | 🟡 | Planned. |
| Actions menu: Notify me → Comments submenu | Per-page comment notification level (All/Mentions/None). | 🟡 | Radio submenu ships and persists per page — but in localStorage only; no server-side model/enforcement yet (B11 partial). |
| Mobile layout | Responsive small-screen UI. | 🧭 | Planned; dedicated shell. |
| Side peek | Preview in a side drawer. | 🧭 | Planned. |
| Back/forward navigation | History within the app. | 🧭 | Planned; router-driven. |
| Tabs for pages | Multiple open pages as tabs. | 🧭 | Planned; optional UX. |
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

6 done · 8 partial · 23 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Stable block ids | Every block has a durable id. | 🟡 | Ids exist; not enforced on all operations. |
| Transactions / atomic writes | All-or-nothing updates. | 🟡 | Planned; Prisma transactions. |
| Soft delete | Mark-deleted rather than purge. | 🟡 | `deletedAt` columns used. |
| Multi-tenancy | Isolate workspaces. | 🟡 | Workspace scoping modeled. |
| Authentication | Sign-up and sign-in. | 🟡 | Session auth; providers limited. |
| Session management | Expire and revoke sessions. | 🟡 | Sessions stored; revocation partial. |
| Secret handling | Manage keys safely. | 🟡 | Env-based; vault planned. |
| Self-hosting | Run on your own server. | 🟡 | Local dev works; packaging pending. |
| Page snapshots | Versioned page state. | 🧭 | Planned; basis for history. |
| Incremental syncing | Sync only changed blocks. | 🧭 | Planned; op-log approach. |
| Offline cache | Local store for offline use. | 🧭 | Planned (IndexedDB/SQLite). |
| Sync conflict handling | Merge concurrent edits. | 🧭 | Planned; CRDT. |
| Audit log | Record sensitive actions. | 🧭 | Planned. |
| Trash retention | Auto-purge after a window. | 🧭 | Planned; scheduled job. |
| Rate limiting | Throttle API/site traffic. | 🧭 | Planned; middleware. |
| Restore from backup | Recover data. | 🧭 | Planned. |
| Observability | Logs, metrics, traces. | 🧭 | Planned; OpenTelemetry. |
| Error tracking | Capture and triage errors. | 🧭 | Planned. |
| Two-factor auth (2FA) | TOTP second factor. | 🧭 | Planned. |
| OIDC support | OpenID Connect providers. | 🧭 | Planned. |
| Encryption at rest | Encrypt stored data. | 🧭 | Planned; DB/disk encryption. |
| Encryption in transit | TLS everywhere. | 🧭 | Planned; reverse-proxy TLS. |
| Docker images | Containerized deployment. | 🧭 | Planned; multi-stage build. |
| Docker Compose | One-command stack. | 🧭 | Planned; app + Postgres. |
| Reverse-proxy guidance | nginx/Caddy docs. | 🧭 | Planned. |
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
| Free plan | Basic single-user/or small-team tier. | 🧭 | Planned; core features ungated. |
| Personal plan | Individual power user. | 🧭 | Planned. |
| Team plan | Shared workspace features. | 🧭 | Planned. |
| Enterprise plan | SSO, audit, controls. | 🧭 | Planned; SSO/audit gated. |
| Plan gates | Restrict features by plan. | 🧭 | Planned; feature-flag driven. |
| Guest limits by plan | Cap external guests. | 🧭 | Planned. |
| File upload limits by plan | Cap storage per plan. | 🧭 | Planned. |
| Version-history retention by plan | Longer history on paid plans. | 🧭 | Planned. |
| AI usage limits by plan | Token budget per plan. | 🧭 | Planned. |
| Self-hosted license option | Run enterprise features locally. | 🧭 | Planned; open-core consideration. |
| Billing integration | Payment provider hooks. | 🧭 | Planned; provider-agnostic. |
| Seat management | Add/remove billed seats. | 🧭 | Planned. |
| Plan change proration | Upgrade/downgrade billing. | 🧭 | Planned. |
| Usage metering | Track consumption per plan. | 🧭 | Planned. |

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
| Automations | Rules on status/label changes. | 🧭 | Planned. |
| Recurring tickets | Repeat on a schedule. | 🧭 | Planned; template recurrence exists for page templates. |
| Workload & capacity | Per-person load planning. | 🧭 | Planned; assignee + estimate data is available. |
| Per-project role editor | Fine-grained project roles. | 🧭 | Planned; workspace roles exist today. |

