# Noema — remaining work

> Generated from `docs/FEATURE_MATRIX.md` by `npm run docs:gaps`. Do not edit by hand.

**Scoreboard:** 563 feature rows — 453 implemented · 88 partial · 0 planned · 22 deliberately out of scope.

This file lists the **88** rows that are not finished, area by area, plus 22 intentional divergences.

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

76 done · 22 partial · 0 planned · 2 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Toggle heading | Heading that doubles as a toggle. | 🟡 | Composite of heading + toggle planned. |
| Pull quote / large quote | Display-scale quotation styling. | 🟡 | Planned as a quote variant. |
| Code block line numbers | Optional gutter numbering. | 🟡 | Planned as a code-block setting. |
| Code block caption | Caption text under a code block. | 🟡 | Planned. |
| Inline equation | Small LaTeX expression inside a text line. | 🟡 | KaTeX renderer wired; editing UX rough. |
| Block equation | Centered display equation. | 🟡 | Renders via KaTeX; edit/preview split unstable. |
| KaTeX/LaTeX support | Math syntax engine for equations. | 🟡 | KaTeX chosen; macro support limited. |
| Column resize | Drag the divider to change column width. | 🟡 | Planned with persisted widths. |
| Synced block | Mirror one block's content in many places. | 🟡 | Planned via reference ids; editing propagation needs care. |
| Synced block source marker | Visual marker of the canonical source. | 🟡 | Planned. |
| Template button block | Reusable set of blocks inserted on click. | 🟡 | Planned; depends on template subsystem. |
| Button block | Interactive button triggering configured actions. | 🟡 | Planned; depends on automations. |
| Ask-AI block | Prompt-driven AI block inside a page. | 🟡 | Planned; depends on AI layer and provider keys. |
| Two-column page property layout | Place properties side by side. | 🟡 | Planned with property panel rework. |
| Inline database block | A database rendered inside a page. | 🟡 | Renders a collection view inline; view config incomplete. |
| Linked view of a database | Re-display an existing database elsewhere. | 🟡 | Planned; requires stable view model. |
| Drag to another page | Move a block into a different page. | 🟡 | Planned. |
| Multi-block selection | Select a range of blocks. | 🟡 | Shift+click works; select-all edge cases. Spec: docs/specs/editor-deep.md (R84.10-R84.12 for the range edges; select-all subset owned by B18). |
| Page cover | Banner image on a page. | 🟡 | Upload works; reposition/resize missing. |
| Sub-pages section | Auto-list of child pages on a parent. | 🟡 | Inline listing exists; reorder partial. |
| Full-width toggle | Expand content to the full viewport width. | 🟡 | Toggle works per page; persisted. |
| Page breadcrumb header | Ancestor path in the page header. | 🟡 | Renders; interactions partial. |
| Comment block (doc annotation) | Pulls comments conceptually into flow. | ⛔ | Superseded by the inline comment model; not a block. |
| Table merge/split cells | Combine or split cells. | ⛔ | High complexity for low demand; revisit if requested. |

### 2. Text formatting

19 done · 2 partial · 0 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Paste with formatting | Preserve rich formatting on paste. | 🟡 | HTML paste works; style cleanup partial. |
| Paste without formatting | Strip styles on paste. | 🟡 | Shortcut present; some wrappers leak. |
| Small caps / all caps | Display transforms for text. | ⛔ | Rarely used in prose; not planned. |

### 3. Databases

38 done · 15 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Form view | Public/Internal form that creates rows. | 🟡 | Planned. No ViewType.FORM exists yet; builder + submit path spec'd: docs/specs/database-deep.md (R89.29). |
| AND/OR filter groups | Boolean combination of filters. | 🟡 | Planned as a filter tree. FilterNode tree already evaluates (database-query.ts:66); tree UI spec'd: docs/specs/database-deep.md (R89.2). |
| Nested filter groups | Arbitrary-depth boolean nesting. | 🟡 | Planned after flat groups. Spec'd with the tree UI: docs/specs/database-deep.md (R89.2). |
| Groups | Bucket rows by a property. | 🟡 | Planned; mainly for board/list. groupRows() exists (database-query.ts:580); generalized grouping + order/collapse spec'd: docs/specs/database-deep.md (R89.3). |
| Group aggregation | Show a summary per group. | 🟡 | Planned. Spec'd over rollup aggregate(): docs/specs/database-deep.md (R89.4). |
| Hidden groups | Collapse or hide groups. | 🟡 | Planned. Persisted collapse spec'd: docs/specs/database-deep.md (R89.3). |
| Conditional formatting | Color rows/cells by rule. | 🟡 | Planned. ColorRule already modelled in view config (database-query.ts:68); rule editor + evaluation spec'd: docs/specs/database-deep.md (R89.5). |
| Row color rules | Two-tone row backgrounds. | 🟡 | Planned subset of conditional formatting. Spec'd: docs/specs/database-deep.md (R89.5). |
| Quick filter from header | Filter directly from a column header. | 🟡 | Planned. Spec'd as an entry point into the filter panel: docs/specs/database-deep.md (R89.6). |
| Inline database | Database embedded in a page body. | 🟡 | Renders through the editor's linked-database node view; its height/scroll shell lives in `src/components/editor/**` (editor slot), so the scroll fix is queued there rather than patched from B15. |
| Linked database | Reuse a database elsewhere. | 🟡 | Planned; requires view identity model. Read-only node exists (linked-database.tsx, attrs = databasePageId only); view identity, per-instance overrides and synced mode spec'd: docs/specs/database-deep.md (R89.14, R89.15). |
| Column resize/reorder | Resize and reorder columns. | 🟡 | Planned. Per-view width/order in view config spec'd: docs/specs/database-deep.md (R89.13). |
| Calculations/footer | Aggregations under columns. | 🟡 | Planned (count, sum, average, etc.). Spec'd over rollup ROLLUP_FUNCTIONS: docs/specs/database-deep.md (R89.4). |
| Gallery previews | Show cover or page content on cards. | 🟡 | Planned. First-image banner landed (B15); cover property + page-content preview spec'd: docs/specs/database-deep.md (R89.9). |
| Unique ID property | Human-readable per-row id. | 🟡 | Planned; see Properties. Today derived as row.id.slice(-8) (database-view.tsx:424); monotonic Property.seq + prefix/pad spec'd: docs/specs/database-deep.md (R89.25). |

### 4. Properties

30 done · 5 partial · 0 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Last edited by | Last editor. | 🟡 | Tracked from property/table edits via the activity log (falls back to creator); content/title edits outside the database view not yet recorded. |
| Unique ID property | Monotonic per-database id. | 🟡 | Planned. |
| Button property | Trigger actions from a row. | 🟡 | Planned. |
| Place/location property | Address with map preview. | 🟡 | Planned. |
| Verification property | Verified-by-owner marker. | 🟡 | Planned; wiki-oriented. |
| Property type change | Convert a property's type. | ⛔ | Lossy conversions; only safe transforms planned later. |

### 5. Formulas

15 done · 1 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Formula editor | Author expressions with autocomplete. | 🟡 | Planned; expression parser first. Spec: docs/specs/formula-engine.md. |

### 6. Templates

7 done · 2 partial · 0 planned · 1 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Page templates | Duplicate a page for reuse. | 🟡 | Duplicate-page works; gallery UI missing. Spec: docs/specs/templates.md. |
| Template button | Insert template content in a page. | 🟡 | Planned. Spec: docs/specs/templates.md. |
| Template from selection | Turn a block selection into a template. | ⛔ | Uncommon flow; skip initially. B80 blocked-row triage: docs/specs/templates.md:308 + docs/specs/workspaces-structure.md §4 (editor-slot dependency). |

### 7. Collaboration

22 done · 4 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Avatars | Per-user avatars in the UI. | 🟡 | Avatar field exists; presence UI pending. |
| Page comments | Comment threads on a page. | 🟡 | Data model basic; UI minimal. B79 audit: threads/resolve/reactions/mentions all live; deepest gaps are server-side depth validation, block anchors and dispatch scoping (see rows below). Spec: docs/specs/collaboration-deep.md. |
| Following pages | Follow a page for updates. | 🟡 | Planned. B79 audit: the page-follow bell already ships (row state from `PageFollow` via `page-title.tsx:338-356`, toggle `pages.ts:463-481`, read `page.tsx:58-61`) but no mutation ever consults `PageFollow` — following dispatches zero notifications (see Notification inbox). R79.5. |
| Coarse edit locks | Prevent simultaneous structural edits. | 🟡 | Planned fallback before full CRDT. |

### 8. Sharing & permissions

16 done · 6 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Workspace roles | Owner/admin/member/guest roles. | 🟡 | Roles modeled; enforcement partial. |
| Owner role | Full control of the workspace. | 🟡 | Modeled; transfer flows missing. |
| Admin role | Manage members and settings. | 🟡 | Modeled; UI partial. |
| Page sharing | Grant a user access to a page. | 🟡 | Basic share record; UI minimal. |
| Allow editing toggle | Choose edit vs read-only shares. | 🟡 | Planned. |
| Move pages across workspaces | Relocate content between workspaces. | 🟡 | Planned; id-remap complexity. |

### 9. Workspaces & structure

18 done · 5 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Page tree | Hierarchical page nesting. | 🟡 | Nesting works; B66 extracted the pure logic (flatten/group/expand/moveCandidates) to `src/lib/page-tree.ts` with 22 unit tests over a synthetic 1000-node tree — cycle guard, expand-state invariants, perf smoke (render plan 0.6 ms median ≪ 100 ms). React DOM render at 1000 nodes still unmeasured (no e2e by design). B80: bulk move + `movePageAction` containment guards specced (R80.7/R80.8) — docs/specs/workspaces-structure.md. |
| Trash / recently deleted | Deleted pages list. | 🟡 | Soft delete exists; trash UI partial. |
| Restore from trash | Undo a deletion. | 🟡 | Planned. |
| Permanent delete | Permanently remove an item. | 🟡 | Planned; purge job needed. |
| Sidebar collapse | Collapse the sidebar. | 🟡 | Toggle works. |

### 12. Import & export

17 done · 5 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Import Asana | Tasks into databases. | 🟡 | Planned. |
| Import Evernote | Notes into pages. | 🟡 | Planned. |
| Import Google Docs | Docs into pages. | 🟡 | Planned. |
| Import Confluence | Spaces into pages. | 🟡 | Planned. |
| Export Markdown | Page as `.md`. | 🟡 | Basic export; nested content partial. Spec: docs/specs/import-export.md. |

### 13. Integrations & API

15 done · 7 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Google Calendar sync | Two-way calendar sync. | 🟡 | ICS subscription import (read-only); no two-way OAuth sync yet. |
| Outlook Calendar sync | Two-way calendar sync. | 🟡 | Works through the published ICS URL; native OAuth pending. |
| Figma integration | Preview design files. | 🟡 | Planned; embed only. |
| Google Drive integration | Link/preview Drive files. | 🟡 | Planned. |
| MCP server | Expose workspace to AI agents. | 🟡 | Planned; read-first, then write. |
| Inbound webhooks | Accept events from outside. | 🟡 | Planned. |
| Public embed oEmbed | Resolve third-party link metadata. | 🟡 | Basic title/favicon fetch. |

### 14. AI

13 done · 3 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| AI writing assist | Draft, rewrite, and refine text. | 🟡 | “Ask AI” skills submenu in the selection toolbar and block menu; BYO provider key. Spec: docs/specs/ai-surface.md. |
| Transcription | Speech-to-text for audio. | 🟡 | `POST /api/ai/transcribe` with its own provider config (`AI_TRANSCRIBE_API_KEY`); sidebar “Transcribe audio” creates a page. Spec: docs/specs/ai-surface.md. |
| Local model support | Run models without a cloud. | 🟡 | Planned; aligns with self-hosting. Spec: docs/specs/ai-surface.md. |

### 15. Media & embeds

15 done · 6 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Video upload | Store and play video. | 🟡 | Local playback (a drop inserts a link the browser plays); no transcoding and no video node — docs/specs/editor-deep.md R84.7, honest partial. |
| Audio upload | Store and play audio. | 🟡 | Local playback (a drop inserts a link); player/waveform UI absent — docs/specs/editor-deep.md R84.7/R84.9, honest partial. |
| Paste image from clipboard | Insert a copied image. | 🟡 | Works for many sources. |
| PDF preview | Inline PDF viewing. | 🟡 | Planned. |
| Iframe embeds | Generic sandboxed iframes. | 🟡 | Provider-only: every iframe passes `isEmbedHostAllowed()` (plus CSP `frame-src`) and carries a provider-specific `allow` list, `referrerPolicy` and title — arbitrary-URL iframes stay refused (bookmark fallback) and no `sandbox` attribute ships yet. |
| Animated GIF/devices | Play GIFs and device previews. | 🟡 | Planned. |

### 16. Navigation & UX

44 done · 3 partial · 0 planned · 2 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Back/forward navigation | History within the app. | 🟡 | Planned; router-driven. Spec: docs/specs/navigation-ux.md. |
| RTL support | Right-to-left layouts. | 🟡 | Arabic sets `dir="rtl"` and logical CSS; mixed-direction blocks untested. |
| Undo/redo (global) | App-wide undo beyond editor. | 🟡 | Planned. |
| Actions menu: Turn into wiki | Convert page to a wiki. | ⛔ | Data model lacks wiki type; blocked pending spec. B11 ships the entry as a disabled menu item with tooltip "Wiki coming soon" — not faked. |
| Open in desktop app | "Open in Windows app" entry. | ⛔ | No desktop app; N/A for web parity. |

### 17. Data model & platform

35 done · 2 partial · 0 planned

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Authentication | Sign-up and sign-in. | 🟡 | Session auth; providers limited. |
| Self-hosting | Run on your own server. | 🟡 | Local dev works; packaging pending. Spec: docs/specs/engineering-hardening.md. |

### 19. Known limitations & quirks

0 done · 0 partial · 0 planned · 15 out of scope

| Feature | What it should do | Status | Notes |
| --- | --- | --- | --- |
| Cloud-only history depth | Some tiers limit history length. | ⛔ | Noema keeps configurable local history; divergence. |
| No offline-first guarantee | Some apps require connectivity. | ⛔ | Noema is local-first by design; divergence. |
| Vendor data residency | Content lives on vendor servers. | ⛔ | Self-hosting keeps data on your infra; divergence. |
| Opaque sync conflicts | Silent last-writer-wins behavior. | ⛔ | Noema uses CRDT with visible provenance. |
| Limited export fidelity | Exports lose some structure. | ⛔ | Noema targets lossless round-trips. |
| Steep permissions model | Complex inheritance surprises. | ⛔ | Noema makes inheritance explicit and previewable. |
| Performance on huge pages | Very large pages degrade. | ⛔ | Noema virtualizes blocks and lags less. |
| Formula language quirks | Subtle type/precedence gotchas. | ⛔ | Noema documents semantics precisely. |
| Two-way relation setup friction | Relations confuse new users. | ⛔ | Noema offers guided relation creation. |
| Recurring template scheduler | Limited scheduling control. | ⛔ | Noema exposes cron-style control. |
| Search relevance opacity | Ranking is hard to tune. | ⛔ | Noema exposes ranking knobs. |
| Migration lock-in | Hard to leave the platform. | ⛔ | Noema prioritizes portable data; divergence. |
| AI vendor lock-in | AI options tied to one vendor. | ⛔ | Noema supports BYO/local models; divergence. |
| Third-party tracking | Hosted analytics on public pages. | ⛔ | Noema ships no trackers by default; divergence. |
| Mandatory accounts for sharing | Viewers may need accounts. | ⛔ | Noema plans lightweight guest viewing. |

