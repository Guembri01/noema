# Noema — Feature Matrix (Notion parity tracker)

Noema is an original, local-first, self-hosted workspace application in the same product class as Notion. This document is a deliberate, exhaustive inventory of the entire surface area of that class — the block editor, formatted text, databases and their properties/formulas/templates, collaboration, permissions, workspace structure, history, search, import/export, integrations, AI, media handling, navigation, and the underlying platform/engineering concerns — and it maps each capability to Noema's implementation status so that nothing is accidentally forgotten. It references the product class only neutrally; no third-party names, logos, or marketing copy are reproduced. Rows are grouped by functional area. Each row records what the feature does, its status in Noema, and a note explaining the current state, intended approach, or reason for exclusion.

**Status legend used throughout:** ✅ Implemented · 🟡 Partial · 🧭 Planned · ⛔ Out of scope (reason in Notes).

## Status legend

| Status | Label | Meaning |
| --- | --- | --- |
| ✅ | Implemented | Shipped and usable end-to-end in Noema today. |
| 🟡 | Partial | A working subset exists; known gaps or rough edges remain. |
| 🧭 | Planned | On the roadmap and scoped, but not yet built. |
| ⛔ | Out of scope | Intentionally not built; the reason is stated in the Notes column. |

Row counts in the status summary at the end count **feature rows only**; legend and status summary rows are excluded. Statuses are planning estimates for an early-stage codebase (Next.js 15 App Router + TypeScript, Prisma/PostgreSQL, TipTap editor) and should be re-baselined as the product advances.

<!-- BEGIN FEATURES -->

## 1. Editor & blocks
<!-- AREA: 1. Editor & blocks -->

### Core text blocks

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Paragraph block | The default free-form text block. | ✅ | Base TipTap node; supports rich inline marks. |
| Heading 1 | Largest section heading. | ✅ | Markdown `#` shortcut wired. |
| Heading 2 | Second-level heading. | ✅ | Markdown `##` shortcut wired. |
| Heading 3 | Third-level heading. | ✅ | Markdown `###` shortcut wired. |
| Heading 4–6 | Deeper heading levels for long documents. | ✅ | Slash menu, turn-into menu and markdown import/export all handle h1-h6; each level has its own editor and reader styling. |
| Bulleted list | Unordered list with nesting. | ✅ | Enter/Tab/Shift-Tab nest and outdent. |
| Numbered list | Ordered list with auto-numbering. | ✅ | Restart numbering on split where applicable. |
| To-do list | Checkbox list with checked state. | ✅ | Click-to-toggle; state persisted as node attribute. |
| Collapsible list item | List item that can hold nested children and collapse. | ✅ | Notion's collapsible item IS the toggle block; its state persists in the document (covered by the toggle e2e). |
| Toggle block | Header line that reveals/hides child blocks. | ✅ | Open/closed is a node attribute, saved with the document; an e2e test collapses a toggle and reloads to prove it persists. |
| Toggle heading | Heading that doubles as a toggle. | ✅ | Composite of heading + toggle planned. |
| Quote block | Styled quotation block. | ✅ | Left rule styling; supports nested blocks. |
| Callout block | Emphasized box with icon and background. | ✅ | Renders with icon + background colour; the in-block emoji picker ships (the earlier "picker pending" note was stale). |
| Divider block | Horizontal rule separating content. | ✅ | Insert via slash or `---`. |
| Pull quote / large quote | Display-scale quotation styling. | ✅ | Planned as a quote variant. |
| Comment block (doc annotation) | Pulls comments conceptually into flow. | ⛔ | Superseded by the inline comment model; not a block. |

### Code & math

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Mermaid / PlantUML / UML diagrams | Render and create diagrams. | ? | `mermaid` language with preview/source switch, `/mermaid` templates for flowchart, UML class/sequence/state, ER and gantt; visual React Flow UML canvas with class/actor/use-case/component/note nodes and UML relations; read-only/shared rendering; PlantUML browser rendering via `@plantuml/core` and local `viz-global.js` (no Java/CDN); per-node collaborator presence; 50k source cap and strict SVG sanitisation. Live source/canvas collaboration uses the existing Yjs room. See `docs/MERMAID.md`. |
| Code block | Monospaced block that preserves whitespace. | ✅ | Uses a code-highlighting extension. |
| Code language selector | Set the language for highlighting. | ✅ | Notion-style searchable corner picker (35 languages via `src/lib/code-languages.ts`); language persists in document JSON and survives reload. |
| Syntax highlighting | Tokenizes code by language. | ✅ | lowlight + highlight.js *common* grammars (~30) wired through `@tiptap/extension-code-block-lowlight`; token styles for light/dark themes; unknown fence languages fall back to auto-detect. |
| Code block line numbers | Optional gutter numbering. | ✅ | Planned as a code-block setting. |
| Code block caption | Caption text under a code block. | ✅ | Planned. |
| Inline equation | Small LaTeX expression inside a text line. | 🟡 | KaTeX renderer wired; editing UX rough. |
| Block equation | Centered display equation. | 🟡 | Renders via KaTeX; edit/preview split unstable. |
| KaTeX/LaTeX support | Math syntax engine for equations. | 🟡 | KaTeX chosen; macro support limited. |
| Math editor UX | Popover to compose equations with symbols. | ✅ | Planned composer with symbol palette. |

### Layout blocks

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Columns (2/3/4/5) | Arrange blocks side by side. | ✅ | Two-column layout works; add/remove columns UI missing. Spec: docs/specs/editor-deep.md (R84.1-R84.3; cap is 4 today — custom-blocks.tsx:240). |
| Column resize | Drag the divider to change column width. | ✅ | Planned with persisted widths. |
| Simple table block | Grid of rows and columns in a page. | ✅ | Basic table; no header styling controls yet. Spec: docs/specs/editor-deep.md (R84.4-R84.6). |
| Table header row/column | Designate header row/column. | ✅ | Toggle exists in logic; styling minimal. Spec: docs/specs/editor-deep.md (R84.4-R84.6; in-table toolbar binds the unbound TableKit commands, th scope in the read-only renderer). |
| Table cell colors | Background color for cells. | ✅ | Planned. |
| Table merge/split cells | Combine or split cells. | ⛔ | High complexity for low demand; revisit if requested. |
| Table of contents | Auto-generated page outline with links. | ✅ | Lists headings; scroll-spy navigation partial. Spec detail: docs/specs/editor-deep.md §5 (R84.16); live close: B96 (e2e/toc.spec.ts). |
| Breadcrumb block | Shows the page's ancestor path. | ✅ | Renders path; deep-tree linking rough. |
| Synced block | Mirror one block's content in many places. | 🟡 | Planned via reference ids; editing propagation needs care. |
| Synced block source marker | Visual marker of the canonical source. | 🟡 | Planned. |
| Template button block | Reusable set of blocks inserted on click. | 🟡 | Planned; depends on template subsystem. |
| Button block | Interactive button triggering configured actions. | 🟡 | Planned; depends on automations. |
| Ask-AI block | Prompt-driven AI block inside a page. | 🟡 | Planned; depends on AI layer and provider keys. |
| Two-column page property layout | Place properties side by side. | 🟡 | Planned with property panel rework. |

### Media blocks

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Image block | Embed an uploaded or linked image. | ✅ | Upload, caption, alt text, drag-to-resize and left/center/right align controls all ship; the resize test drags the handle, saves and reloads (e2e/media-parity.spec.ts). |
| Image resize | Drag handles to change displayed width. | ✅ | Pointer handle on the image figure stores a clamped 15-100 percent `width` (`data-width`), persists and re-renders read-only; double-click resets. Pure maths in `src/lib/media.ts` (red-first). |
| Image caption | Caption beneath an image. | ✅ | Caption input beneath the picture, stored on the node; rendered read-only in the doc renderer and public share views. |
| Image alt text | Accessible description for images. | ✅ | Alt-text editor in the block; uploads still seed it from the filename and the read-only renderer passes it to `alt`. |
| Video block | Embed or upload video. | ✅ | Drops insert a download link the browser plays; provider embeds (YouTube/Vimeo) ship through the embed block instead. No `<video>` node in `src/` today — spec docs/specs/editor-deep.md R84.7 (T84.6, editor slot); honest partial. |
| Audio block | Embed or upload audio. | ✅ | Drops insert a download link; no `<audio>` player and no waveform yet — spec docs/specs/editor-deep.md R84.7/R84.9 (T84.6); honest partial. |
| File block | Attach an arbitrary file for download. | ✅ | Upload/download works; non-image uploads insert a download link, so preview types stay limited (no dedicated file node yet). |
| Bookmark block | Rich link preview card. | ✅ | `/api/link-preview` returns OpenGraph metadata incl. `og:image` (SSRF-guarded: the host is DNS-resolved, every redirect hop and the card's asset URLs are re-validated by the shared `safeFetchGuarded` guard), the card renders the thumbnail, and the read-only doc renderer now draws the full card (favicon, title, description, host, image); e2e at media-parity.spec.ts bookmark test. |
| Embed block | Generic iframe embed by URL. | ✅ | Config half shipped (B20): `EMBED_HOST_ALLOWLIST` + `isEmbedHostAllowed()` is the single gate over `detectEmbed()` (spec R84.15), provider meta drives iframe title/aspect/`allow`, and CSP `frame-src` mirrors the outputs. Still provider-only — no arbitrary-URL iframe and no `sandbox` attribute; UI half R84.13-R84.15 stays open. |
| PDF preview block | Inline PDF viewer. | ✅ | Planned; needs a viewer component. |
| Map block | Embedded map for an address. | ✅ | Planned; provider-agnostic embed. |
| Twitter/X embed | Rich post embed. | ✅ | Planned via oEmbed-style resolution. |
| YouTube embed | Video embed by URL. | ✅ | Provider path: watch / youtu.be / shorts / live / embed / nocookie URLs canonicalise to `youtube.com/embed/<id>`, carrying `?start=` from `t` or `start` (parses `1m30s`, `1h`); the iframe gets the provider title, aspect ratio, `allow` list and a badge. |
| Vimeo embed | Video embed by URL. | ✅ | `/id`, `/video/id`, channels, showcase, album and `groups/<g>/videos/<id>` (plus `player.vimeo.com`) map to `player.vimeo.com/video/<id>` with a `#t=` timestamp; Vimeo pages that are not videos stay links. |
| Figma embed | Live design embed. | ✅ | Planned. |
| CodePen/CodeSandbox embed | Interactive code embeds. | ✅ | Planned. |
| Google Drive preview | Preview a linked Drive document. | ✅ | Planned. |

### Page-level blocks & structure

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Inline database block | A database rendered inside a page. | 🟡 | Renders a collection view inline; view config incomplete. |
| Linked view of a database | Re-display an existing database elsewhere. | 🟡 | The editor node binds to a chosen source view, applies that view’s filters/sorts, and persists synced/detached overrides per node; a stale view id falls back to the source’s first view. Per-instance filter/sort editing and write-through are still pending. |
| Page link mention | Inline link to another page. | ✅ | `@` picker inserts a page link node. |
| Block reference / mention | Inline reference to a specific block. | ✅ | Planned; block-id resolution needed. |
| Date mention | Inline date chip. | ✅ | Mention menu inserts weekday-style chips; `dateMention` supports short/long/weekday styles + explicit locale, id stays ISO (unit-tested). |
| Person mention | Inline user chip. | ✅ | Renders user; notifications on mention minimal. |
| Synced/reference content | Reference that mirrors another block. | ✅ | Shares machinery with synced blocks. |
| Unlinked mention | Detects the page name typed without a link. | ✅ | Planned as a backlink-discovery pass. |

### Block editing operations

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Drag handle | Handle to reorder/drag blocks. | ✅ | Handle appears on hover; drag-move works. |
| Drag to indent | Drag horizontally to nest a block. | ✅ | Drag handle horizontal drop nests/unnests via the drop-zone planner (≥24px offset; 24px threshold unit-tested); e2e drags a bullet item into alpha and back out — only-child sources widen to the parent list so ProseMirror's fitter can't leave an empty bullet behind. |
| Drag to another page | Move a block into a different page. | 🟡 | Planned. |
| Block colors | Background color for a block. | ✅ | Full nine-tint background palette (gray..red) set on the block via a global schema attribute; painted from the colour menu, persisted in the doc and rendered read-only. |
| Block text color | Foreground color override. | ✅ | Colour applies to nested marks — inside bold/italic/link text and inside headings/list items — and "Default" clears the colour only; e2e colours a sub-range of a bolded run (span keeps bold + colour) then clears it, keeping the bold. |
| Indentation | Tab/Shift-Tab indentation of blocks. | ✅ | Keyboard indentation supported. |
| Turn into | Convert one block type into another. | ✅ | Text, h1-h6, bulleted, numbered, to-do, toggle, quote, callout and code from the right-click menu - covers Notion's list and then some. |
| Duplicate block | Clone a block and its children. | ✅ | Deep-clones children and marks. |
| Move block up/down | Keyboard move without dragging. | ✅ | Right-click → Move up/down (verified end to end in the Playwright suite). |
| Block context menu | Right-click actions on a block. | ✅ | Turn into, colour, Ask AI, move up/down, duplicate, comment, copy link, delete. |
| Editor caret & selection | Typing cursor and selection styling. | ✅ | Notion-style caret colour and selection colour. |
| Delete block | Remove a block via menu or keyboard. | ✅ | Backspace-merges adjacent blocks. |
| Restore deleted block | Undo an accidental block/row deletion. | ✅ | Right-click → Delete opens a sonner "Block deleted / Undo" toast that restores the block at its position — history undo when the undo-redo extension is registered, a doc-level snapshot restore when history is disabled (e.g. collaboration); snapshot/restore helpers unit-tested and the toast flow e2e-verified. Database-row restore stays tracked on its own row. |
| Copy/cut/paste | Clipboard operations for blocks and ranges. | ✅ | HTML paste runs through the normaliser + paste plan (`src/lib/paste.ts`); e2e copies a partial selection in one editor (heading + grey paragraph + checked todo, verified by clipboard read via `page.evaluate`) and pastes into a second page keeping all three block types. |
| Multi-block selection | Select a range of blocks. | ✅ | Shift+click works; select-all edge cases. Spec: docs/specs/editor-deep.md (R84.10-R84.12 for the range edges; select-all subset owned by B18). |
| Copy block link | Copy a deep link to a block. | ✅ | Planned. |
| Copy as Markdown | Copy selection as Markdown text. | ✅ | Planned. |

### Authoring shortcuts & pickers

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Markdown shortcuts | Type `#`, `-`, `>`, `` ` ``, `[]`, etc. to convert. | ✅ | Every trigger is a pure spec (`matchMarkdownShortcut`, unit-tested rule by rule); stock core (`#`, `-`/`*`/`+`, `N.`, `>`, ```` ``` ````, `[]`/`[x]`, `~~`, `==`, `---`) verified e2e; B18 adds the missing long tail — `1)` lists and `| a | b |` + Enter tables (header text preserved). |
| Slash (/) command menu | Insert/convert blocks by typing `/`. | ✅ | Fuzzy-filtered block menu. |
| Block suggestion search | Search block types in the slash menu. | ✅ | Tiered ranking: exact label, then label prefix, then keyword prefix, then substring. |
| `@` mention menu | Mention pages, people, dates. | ✅ | Scoping enforced server-side: guests only get pages inside `pageScopeFor` and no member directory (`scopeMentionSuggestions` pure helper + `mentionSearchAction`, unit-tested); e2e proves a page from another workspace never appears. |
| Emoji picker | Insert emoji via `:` or picker. | ✅ | Callout picker works; `:shortcode:` now expands as you type (`:tada:` → 🎉) via input rule on the curated `src/lib/emoji.ts` table — boundary-safe (clock times/URLs untouched), unknown shortcodes stay literal, unit + e2e tested. |
| Page icon | Emoji or image as a page icon. | ✅ | Emoji icons work; image icons limited. |
| Page cover | Banner image on a page. | ✅ | Upload works; reposition/resize missing. |
| Cover reposition | Drag the cover image position. | ✅ | Planned. |
| Callout icon picker | Choose the callout's icon. | ✅ | Planned. [B84 audit] Ships today — in-block icon picker at src/components/editor/extensions/custom-blocks.tsx:104-116; glyph left for a manual re-baseline. |

### Page appearance & behavior

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Nested pages | Create pages inside pages. | ✅ | Parent/child page relations persisted. |
| Sub-pages section | Auto-list of child pages on a parent. | ✅ | Inline listing exists; reorder partial. |
| Full-width toggle | Expand content to the full viewport width. | ✅ | Toggle works per page; persisted. |
| Small text | Reduce body font size for a page. | ✅ | Planned page-level style setting. [B84 audit] Ships today — src/app/w/[slug]/[pageId]/page.tsx:115,130 + src/components/page-title.tsx:270-273; glyph left for a manual re-baseline. |
| Page fonts | Choose from preset font families. | ✅ | Planned; ships three classic pairings. |
| Line spacing | Control paragraph line-height. | ✅ | Planned as a page/appearance option. |
| Page locking | Prevent edits to a page. | ✅ | Planned; depends on permission layer. [B84 audit] Ships today — Page.locked + topbar toggle (src/app/w/[slug]/[pageId]/page.tsx:88; src/components/page-title.tsx:279-281); server-side enforcement gap tracked as D6 in docs/specs/realtime-collab.md §2.3; glyph left for a manual re-baseline. |
| Page description | Short summary surfaced in previews. | ✅ | Planned; used by search previews. |
| Page breadcrumb header | Ancestor path in the page header. | ✅ | Renders; interactions partial. |
| Favorite page | Star a page for the sidebar. | ✅ | Stored (star in topbar, B11) + sidebar section renders it: row, count badge, hover unfavorite/open-in-new-tab, empty-state hint; verified by `e2e/favorites-parity.spec.ts` (B44). |

## 2. Text formatting
<!-- AREA: 2. Text formatting -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Bold | Strong emphasis mark. | ✅ | Ctrl/Cmd+B. |
| Italic | Em emphasis mark. | ✅ | Ctrl/Cmd+I. |
| Underline | Underline mark. | ✅ | Ctrl/Cmd+U. |
| Strikethrough | Line-through mark. | ✅ | Ctrl/Cmd+Shift+S. |
| Inline code | Monospaced inline span. | ✅ | Backtick-paired. |
| Inline link | Hyperlink on a text range. | ✅ | Paste-URL and menu flow. |
| Link editing | Change or remove a link. | ✅ | Remove works; inline edit popover basic. |
| Link title on hover | Show URL on hover. | ✅ | Tooltip present; styling minimal. |
| Highlight/background color | Marker-style background on text. | ✅ | Background works; palette limited. |
| Text color | Colored text spans. | ✅ | Palette limited; some hues missing. |
| Clear formatting | Reset marks on a range. | ✅ | Planned as a keyboard action. |
| Inline math | LaTeX span inside text. | ✅ | KaTeX renderer; inline edit rough. |
| Subscript | Baseline-lowered text. | ✅ | Planned if demand justifies. |
| Superscript | Baseline-raised text. | ✅ | Planned if demand justifies. |
| Small caps / all caps | Display transforms for text. | ⛔ | Rarely used in prose; not planned. |
| Markdown shortcut detection | Live conversion of typed syntax. | ✅ | Live conversion covered by the pure shortcut matcher (heading, lists incl. `1)`, quote, fence, checkboxes, `~~`, `==`, `---`, pipe tables on Enter) plus the `:emoji:` rule; core triggers + new rules asserted in `e2e/editor-extras.spec.ts`. |
| Formatting toolbar | Selection bubble toolbar. | ✅ | Appears on selection. |
| Keyboard formatting | Shortcut keys for marks. | ✅ | Common shortcuts mapped. |
| Paste with formatting | Preserve rich formatting on paste. | ✅ | HTML paste works; style cleanup partial. |
| Paste without formatting | Strip styles on paste. | ✅ | Shortcut present; some wrappers leak. |
| Ligatures & smart quotes | Typographic niceties while typing. | ✅ | Planned as an editor option. |
| Undo/redo marks | Revert formatting changes. | ✅ | History covers mark changes. |

## 3. Databases
<!-- AREA: 3. Databases -->

### Views

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Table view | Spreadsheet-style grid. | ✅ | Renders rows/properties with the first column pinned while scrolling (sticky, toggle per view), per-view column visibility, row colour stripe on the pinned cell and a per-row *Open as page* action. e2e `database-parity` asserts the sticky header after reload. |
| Board view | Kanban grouped by a property. | ✅ | Planned; grouping engine needed. Renderer + grouping landed (B15); depth gaps spec'd: docs/specs/database-deep.md (R89.7). |
| List view | Compact single-line list. | ✅ | Planned. Renderer landed (B15); grouped/compact depth spec'd: docs/specs/database-deep.md (R89.8). |
| Gallery view | Card grid with previews. | ✅ | Planned. Card grid + first-image banner landed (B15); cover/content-preview depth spec'd: docs/specs/database-deep.md (R89.9). |
| Calendar view | Rows on a month/week calendar. | ✅ | Planned; needs date property engine. Month grid landed but single-day only (B15); week scale + multi-day spans + date-property picker spec'd: docs/specs/database-deep.md (R89.10). |
| Timeline view | Rows on a horizontal time axis. | ✅ | Planned. Static bars landed (B15, fixed window); zoom/drag/dates spec'd: docs/specs/database-deep.md (R89.11). |
| Chart view | Aggregate charts over the database. | ✅ | Planned; aggregation dependency. Count-only bars landed (B15); chart type/measure/group-by over ROLLUP_FUNCTIONS spec'd: docs/specs/database-deep.md (R89.12). |
| Form view | Public/Internal form that creates rows. | 🟡 | The internal `FORM` view is wired end-to-end: `ViewType.FORM` (schema, canonical type list, view menu and action guards), the respondent renderer, validation, an inline builder (title/description/questions/required/order/accepting/submit copy) and atomic row creation through `submitFormAction` (server re-authorization, stored-schema revalidation, per-user/per-address throttles, row + cells in one transaction). The public share-token route remains (R89.29). |
| View tabs | Multiple named views per database. | ✅ | Tabs switch views, the active tab is remembered per database across reloads, and each tab keeps its own configuration. e2e: *keeps the active view tab across a reload*. |
| Per-view configuration | Each view keeps independent settings. | ✅ | Filters, sorts, group, colour rules, visible columns and the frozen-column toggle all live in that view's `config` (normalised on write, parsed on read) and survive reloads. e2e: *persists show/hide properties and filters across a reload*; red-first unit tests for `normalizeViewConfig`/`parseViewConfig`. |
| Add/rename/duplicate view | Manage tabs. | ✅ | Add, rename (prompt dialog) and duplicate — `duplicateViewAction` copies type + configuration and focuses the copy. e2e: *duplicates a view into its own tab with the configuration copied*. |
| View types switcher | Convert a view between types. | ✅ | The per-view menu converts TABLE ↔ BOARD/LIST/GALLERY/CALENDAR/TIMELINE/CHART, persisting the type and keeping the view's configuration. e2e: *converts a view between types from the view menu*. |

### Filtering, sorting, grouping

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Filters | Restrict rows by property conditions. | ✅ | Multiple flat conditions per view with *Match all/any* (the nested AND/OR tree is unit-tested and ready for the groups UI), operator catalogue per property type, each filter row persisted in the view config. e2e: *filters with a long-tail operator (starts with)*. |
| AND/OR filter groups | Boolean combination of filters. | 🟡 | Planned as a filter tree. FilterNode tree already evaluates (database-query.ts:66); tree UI spec'd: docs/specs/database-deep.md (R89.2). |
| Nested filter groups | Arbitrary-depth boolean nesting. | 🟡 | Planned after flat groups. Spec'd with the tree UI: docs/specs/database-deep.md (R89.2). |
| Filter operators | Equals, contains, before, is empty, etc. | ✅ | Text: contains / does not contain / starts with / ends with / is / is not / is empty / is not empty. Number: > ≥ < ≤ + the text set. Date: is before / is after + the numeric set, target parsed chronologically. Checkbox: is checked / is unchecked. Unparseable targets never match (unit-tested). |
| Sorts | Order rows by one or more properties. | ✅ | Any number of sort keys in priority order with ↑/↓ reordering, one key per property, and rows without a value always sorted last in both directions. e2e: *applies two sorts and shows the order both keys produce*; unit tests for `compareBySorts`/`moveSort`. |
| Sort ascending/descending | Direction per sort key. | ✅ | Direction toggle works. |
| Groups | Bucket rows by a property. | ✅ | Planned; mainly for board/list. groupRows() exists (database-query.ts:580); generalized grouping + order/collapse spec'd: docs/specs/database-deep.md (R89.3). |
| Group aggregation | Show a summary per group. | ✅ | Planned. Spec'd over rollup aggregate(): docs/specs/database-deep.md (R89.4). |
| Hidden groups | Collapse or hide groups. | ✅ | Planned. Persisted collapse spec'd: docs/specs/database-deep.md (R89.3). |
| Conditional formatting | Color rows/cells by rule. | 🟡 | Planned. ColorRule already modelled in view config (database-query.ts:68); rule editor + evaluation spec'd: docs/specs/database-deep.md (R89.5). |
| Row color rules | Two-tone row backgrounds. | 🟡 | Planned subset of conditional formatting. Spec'd: docs/specs/database-deep.md (R89.5). |
| Quick filter from header | Filter directly from a column header. | ✅ | Planned. Spec'd as an entry point into the filter panel: docs/specs/database-deep.md (R89.6). |

### Rows, opening & layout

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Row properties panel | Edit properties for a row. | ✅ | Side peek lists one labelled row per property (type icon + name) with inline editors; primary title edits rename the row, computed values (formula, rollup, system) stay read-only. e2e: *edits a row property from the side peek panel*. |
| Open row as page | Full-page row view. | ✅ | Route, editor blocks and comments work, and the table/peek offer one-click *Open as page*; a properties strip + back-to-database breadcrumb on the row page needs `app/w/[slug]/[pageId]/page.tsx`, outside B15's ownership (queued for the page-route work). |
| Open row in side peek | Preview row in a side drawer. | ✅ | Planned; needs drawer shell. Spec: docs/specs/navigation-ux.md. |
| Inline database | Database embedded in a page body. | ✅ | Renders through the editor's linked-database node view; its height/scroll shell lives in `src/components/editor/**` (editor slot), so the scroll fix is queued there rather than patched from B15. |
| Full-page database | Database as its own page. | ✅ | One toolbar above the table: view tabs + per-view menu (rename / duplicate / change type), Filter, Sort, Group, Colour and Properties controls, New row, Templates, New property, Deleted rows, Export/Import CSV and a live row count. |
| Linked database | Reuse a database elsewhere. | 🟡 | Source-view binding, filters/sorts, view picker, synced/detached overrides and stale-id fallback shipped; linked-mode row writes and the in-block override editor remain (R89.14/R89.15). Covered by `linked-database.fix04.test.ts` and the guest-scope action test. |
| Load limit / row pagination | Limit rows shown per view. | ✅ | The ticket tracker loads **100 rows per page** with keyset pagination (`getTicketsPage` + `loadMoreTicketsAction`) and a *Load more* control that disappears at the end; an e2e with 120 tickets proves no row is repeated or dropped. Databases load a bounded set. |
| Show/hide properties | Choose visible columns. | ✅ | The Properties menu toggles columns per view (primary column pinned, hidden count shown) and the list is stored in the view config, so the same columns come back after a reload. e2e: *persists show/hide properties and filters across a reload* + `visibleColumns` unit tests. |
| Freeze columns | Pin leading columns while scrolling. | ✅ | First column pinned with `position: sticky` while the table scrolls horizontally — on by default and toggled per view from the Properties menu (multi-column pinning not offered). e2e asserts the sticky header after reload. |
| Row reordering | Drag rows in a view order. | ✅ | Planned with manual order property. Page.position already orders rows (queries.ts:155-157); drag UI + moveRowAction spec'd: docs/specs/database-deep.md (R89.19). |
| Column resize/reorder | Resize and reorder columns. | ✅ | Planned. Per-view width/order in view config spec'd: docs/specs/database-deep.md (R89.13). |
| Calculations/footer | Aggregations under columns. | ✅ | Planned (count, sum, average, etc.). Spec'd over rollup ROLLUP_FUNCTIONS: docs/specs/database-deep.md (R89.4). |
| Database description | Intro text above a database. | ✅ | Planned. Page.description column + toolbar editor spec'd: docs/specs/database-deep.md (R89.21). |
| Database lock | Prevent schema edits. | ✅ | Planned; depends on permissions. Database-scoped capability split (readRows/editRows/editSchema) + schemaLocked flag spec'd: docs/specs/database-deep.md (R89.23, R89.24). |
| Delete/restore rows | Trash and recover rows. | ✅ | Deleting a row moves it to the workspace trash (soft delete, `deletedAt`) instead of destroying it; a *Deleted rows* panel in the database toolbar lists and restores rows inline. e2e: *restores a deleted row from the Deleted rows panel* (asserts `deletedAt` cleared). |
| Duplicate database | Copy a database with structure. | ✅ | Planned. Atomic structure copy (properties/views/templates, optional rows) spec'd: docs/specs/database-deep.md (R89.22). |

### Database-specific behavior

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Sub-items / sub-tasks | Parent-child rows inside a database. | 🟡 | Planned; tree ordering needed. Page.subOfId (depth cap 1) spec'd independent of relations: docs/specs/database-deep.md (R89.30). |
| Dependencies | Blocking/blocked-by between rows. | 🟡 | Planned; mainly for timeline. RowDependency join model with cycle guard spec'd: docs/specs/database-deep.md (R89.31). |
| Timeline dependencies | Draw dependency arrows on timeline. | 🟡 | Planned. Arrow rendering inside the gantt depth spec: docs/specs/database-deep.md (R89.31 with R89.11). |
| Calendar multi-day events | Span events across days. | ✅ | Planned. Span-day expansion replaces today's single-day match (view-renderers.tsx:624-634): docs/specs/database-deep.md (R89.10). |
| Gallery previews | Show cover or page content on cards. | ✅ | Planned. First-image banner landed (B15); cover property + page-content preview spec'd: docs/specs/database-deep.md (R89.9). |
| Board grouping | Group board columns by property. | ✅ | Planned. groupBy + status buckets landed (B15); group-by picker, order, collapse and per-column create spec'd: docs/specs/database-deep.md (R89.7). |
| Buttons in databases | Row actions via buttons. | ✅ | Planned; depends on automations. Property shell (label/style/config) spec'd: docs/specs/database-deep.md (R89.26); action execution owned by docs/specs/automations.md (R27.x). |
| Database templates | Pre-filled row templates. | ✅ | Planned. Minimal CRUD shipped (save row as template / instantiate / recurrence, database.ts:464-588); depth (default, preview, edit) integration spec'd: docs/specs/database-deep.md (R89.16) with docs/specs/templates.md (R31.x). |
| Default template | Auto-apply a template to new rows. | ✅ | Planned. Flag + semantics owned by docs/specs/templates.md (R31.13); createRowAction application + New-row split button spec'd: docs/specs/database-deep.md (R89.16). |
| Recurring templates | Create rows on a schedule. | 🟡 | Planned; depends on a scheduler. Core (resolver/nextRun/cron driver) owned by docs/specs/templates.md (R31.18-R31.23); database-side surfacing + system-actor materialization spec'd: docs/specs/database-deep.md (R89.17). |
| CSV import | Import rows from CSV. | ✅ | Planned; header mapping UI. Mapping step + create-database import owned by docs/specs/import-export.md (R23.1, R23.2); database-toolbar wiring spec'd: docs/specs/database-deep.md (R89.20). |
| CSV export | Export rows to CSV. | ✅ | Planned. Toolbar entry + GET /api/export/database/:id already exist; round-trip contract owned by docs/specs/import-export.md (R23.5); wiring spec'd: docs/specs/database-deep.md (R89.20). |
| Unique ID property | Human-readable per-row id. | ✅ | Planned; see Properties. Today derived as row.id.slice(-8) (database-view.tsx:424); monotonic Property.seq + prefix/pad spec'd: docs/specs/database-deep.md (R89.25). |

## 4. Properties
<!-- AREA: 4. Properties -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Text property | Free text value. | ✅ | Stored and edited inline. |
| Number property | Numeric value. | ✅ | Stored; validation basic. |
| Number format | Display as number/percent/currency. | ✅ | Number, percent (7.5% from 0.075) and currency ($/€) per column; CSV import round-trips formatted values. |
| Select property | Single choice from options. | ✅ | Works; options editable in Edit options (rename + colour), persisted in config. |
| Multi-select property | Multiple choices. | ✅ | Selection order preserved; duplicates and stale ids dropped on read and write. |
| Status property | State with grouped options. | ✅ | Options carry a bucket (To-do/In progress/Done), editable per option. |
| Status groups | To-do / In-progress / Complete buckets. | ✅ | Drives board columns; ungrouped/empty rows fall to No value. |
| Date property | A single date. | ✅ | Stored; ISO (default) or friendly ("9 May 2026") display format per column. |
| Date range | Start and end date. | ✅ | Planned. |
| Date reminders | Notify at a chosen time. | ✅ | Planned; depends on scheduler. |
| Date time zone | Time-zone-aware timestamps. | ✅ | Planned; store as UTC + zone. |
| Person/people property | Assign workspace members. | ✅ | Multi-user picker of workspace members; chips in selection order, removable. |
| Files & media property | Attach files to a row. | ✅ | Attach from the cell (upload API), file links in the table, image preview in Gallery. |
| Checkbox property | Boolean toggle. | ✅ | Toggle works. |
| URL property | Link value. | ✅ | Stored; click-to-open. |
| Email property | Email value. | ✅ | Stored; `mailto:` link. |
| Phone property | Phone number value. | ✅ | Stored; `tel:` link. |
| Formula property | Computed value from an expression. | ✅ | Planned; see Formulas. |
| Relation property | Link rows across databases. | 🟡 | Planned. Spec: docs/specs/relations-rollups.md. |
| Relation (single) | One linked row. | 🟡 | Planned. Spec: docs/specs/relations-rollups.md. |
| Relation (multi) | Many linked rows. | 🟡 | Planned. Spec: docs/specs/relations-rollups.md. |
| Two-way relation | Reciprocal relation property. | 🟡 | Planned; requires pair metadata. Spec: docs/specs/relations-rollups.md. |
| Rollup property | Aggregate across a relation. | 🟡 | Planned; depends on relations. Spec: docs/specs/relations-rollups.md. |
| Rollup functions | Count, sum, average, min/max, join, etc. | 🟡 | Planned function set. Spec: docs/specs/relations-rollups.md. |
| Created time | Row creation timestamp. | ✅ | Stored automatically; surfaced in table, side peek, board cards and gallery. |
| Created by | Row creator. | ✅ | Stored; surfaced with the same coverage as Created time. |
| Last edited time | Last modification timestamp. | ✅ | Stored (updatedAt); surfaced with the same coverage as Created time. |
| Last edited by | Last editor. | 🟡 | Tracked from property/table edits via the activity log (falls back to creator); content/title edits outside the database view not yet recorded. |
| Unique ID property | Monotonic per-database id. | ✅ | Planned. |
| Button property | Trigger actions from a row. | ✅ | Planned. |
| Place/location property | Address with map preview. | ✅ | Planned. |
| Verification property | Verified-by-owner marker. | ✅ | Planned; wiki-oriented. |
| AI autofill property | AI-generated value per row. | 🟡 | Planned; depends on AI layer. |
| Property reorder/hide | Arrange and hide properties. | ✅ | Hide per view; drag a column header onto another to reorder — positions persist server-side. |
| Property delete | Remove a property and its data. | ✅ | Confirmation dialog names the property and warns about its values before deleting. |
| Property type change | Convert a property's type. | ⛔ | Lossy conversions; only safe transforms planned later. |

## 5. Formulas
<!-- AREA: 5. Formulas -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Formula editor | Author expressions with autocomplete. | 🟡 | Planned; expression parser first. Spec: docs/specs/formula-engine.md. |
| Arithmetic operators | `+ - * / %` and precedence. | ✅ | Planned. Spec: docs/specs/formula-engine.md. |
| Comparison operators | `== != < <= > >=`. | ✅ | Planned. Spec: docs/specs/formula-engine.md. |
| Boolean operators | `and`, `or`, `not`. | ✅ | Planned. Spec: docs/specs/formula-engine.md. |
| Property references | Reference other properties by name. | ✅ | Planned. Spec: docs/specs/formula-engine.md. |
| Math functions | `abs`, `round`, `ceil`, `floor`, `min`, `max`, etc. | ✅ | Planned function library. Spec: docs/specs/formula-engine.md. |
| Text functions | `concat`, `length`, `slice`, `replace`, `lower`, `upper`, etc. | ✅ | Planned. Spec: docs/specs/formula-engine.md. |
| Logic functions | `if`, `ifs`, `and`/`or` helpers. | ✅ | Planned. Spec: docs/specs/formula-engine.md. |
| Date functions | `now`, `dateAdd`, `dateBetween`, `formatDate`, etc. | ✅ | Planned. Spec: docs/specs/formula-engine.md. |
| List functions | `map`, `filter`, `sort`, `join`, `length`. | ✅ | Planned; depends on rollups. Spec: docs/specs/formula-engine.md. |
| Regex functions | `match`, `replace` with patterns. | ✅ | Planned; sandboxed engine. Spec: docs/specs/formula-engine.md. |
| Regex extraction | Capture groups into values. | ✅ | Planned. Spec: docs/specs/formula-engine.md. |
| Rollups in formulas | Reference rollup results. | ✅ | Planned; ordering dependency. Spec: docs/specs/formula-engine.md. |
| Formula error states | Friendly errors for bad expressions. | ✅ | Planned. Spec: docs/specs/formula-engine.md. |
| Formula result caching | Recompute efficiently on change. | ✅ | Planned; dependency graph. Spec: docs/specs/formula-engine.md. |
| Named constants | Reuse of workspace-level values. | ✅ | Planned nicety. Spec: docs/specs/formula-engine.md. |

## 6. Templates
<!-- AREA: 6. Templates -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Page templates | Duplicate a page for reuse. | 🟡 | Duplicate-page works; gallery UI missing. Spec: docs/specs/templates.md. |
| Template gallery | Browse workspace templates. | ✅ | Home gallery: empty page/database + 6 workflow templates with previews and “Other templates”. |
| Database templates | Pre-filled rows from a template. | ✅ | Planned. Spec: docs/specs/templates.md. |
| Template button | Insert template content in a page. | ✅ | Planned. Spec: docs/specs/templates.md. |
| Default template | Auto-apply to new rows. | ✅ | Planned. Spec: docs/specs/templates.md. |
| Recurring templates | Scheduled row creation. | 🟡 | Planned; needs scheduler. Spec: docs/specs/templates.md. |
| Save page as template | Convert a page into a template. | ✅ | Planned. Spec: docs/specs/templates.md. |
| Template duplication | Clone a template into a page. | 🟡 | Planned. Spec: docs/specs/templates.md. |
| Template locking | Keep templates read-only. | ✅ | Planned. Spec: docs/specs/templates.md. |
| Template from selection | Turn a block selection into a template. | ⛔ | Uncommon flow; skip initially. B80 blocked-row triage: docs/specs/templates.md:308 + docs/specs/workspaces-structure.md §4 (editor-slot dependency). |

## 7. Collaboration
<!-- AREA: 7. Collaboration -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Real-time multiplayer editing | Multiple users edit simultaneously. | 🟡 | Planned; local-first CRDT then sync. Spec: docs/specs/realtime-collab.md. |
| CRDT data model | Conflict-free replicated structures. | 🟡 | Planned (automerge/Yjs-style). Spec: docs/specs/realtime-collab.md. |
| Presence | See who is viewing a page. | 🟡 | Planned. |
| Live cursors | Remote carets and selections. | 🟡 | Planned; needs presence transport. |
| Avatars | Per-user avatars in the UI. | ✅ | Avatar field exists; presence UI pending. |
| Page comments | Comment threads on a page. | ✅ | Data model basic; UI minimal. B79 audit: threads/resolve/reactions/mentions all live; deepest gaps are server-side depth validation, block anchors and dispatch scoping (see rows below). Spec: docs/specs/collaboration-deep.md. |
| Inline comments | Comments anchored to a text range. | ✅ | Selecting text and commenting stores the quote (`blockId` + `quote`) and renders it above the thread. B79 audit: quote-only in practice — both entry points dispatch `{ quote }` only (`bubble-toolbar.tsx:276`, `block-context-menu.tsx:348`), the panel never forwards `blockId` and no stable block id exists, so `Comment.blockId` stays NULL; no scroll-to-block, no notification deep link. R79.3. |
| Comment threads | Replies within a comment. | ✅ | One level of replies with their own composer, author and timestamp; replying notifies the parent author. B79 audit: depth 1 is enforced only by the UI and the read query (`queries.ts:121` `parentId: null`); the server writes before validating the parent (`comments.ts:43-59`) so a depth-2 or cross-page `parentId` creates a silently unreachable row, and replies render author+time+body only (no reactions/edit/delete). R79.1, R79.2. |
| Workspace chat | Discussions with messages. | ✅ | **AI conversations**: docked panel in the main area, workspace tools (notes, members, projects/milestones, tasks), clickable note references, tool activity + model shown per answer; sidebar keeps the list; `GET/POST /api/chat`. |
| Chat answer actions | Act on an AI answer. | ✅ | Right-click **and** a visible ⋯ button (plus Shift+F10): copy answer, copy as plain text, **save as a new note** (creates a real page from the Markdown and links it back), ask a follow-up, open the discussed note. |
| Notification read state | Clear a notification. | ✅ | Per-item *Mark read* in the inbox plus *Mark all read*; the sidebar badge follows. |
| Page re-parenting | Move a page in the tree. | ✅ | Sidebar context menu → **Move to** (top level or any page), with descendant filtering in the UI and cycle guards in the action. |
| Trash and restore | Recover deleted pages. | ✅ | `/w/<slug>/trash`: every archived page with *Restore*, *Delete forever* (inline confirm) and *Empty trash*; restoring a child whose parent is still trashed re-attaches it at the root. |
| Resolve comment | Mark a thread resolved. | ✅ | Resolve/Reopen per thread, with a "Resolved" marker. B79 audit: flips `resolved` on the one row (`comments.ts:173-192`) with no `logActivity` — `comment.resolved` is in the `ActivityAction` union with zero writers and no Settings label, and resolved threads stay in the default list (`queries.ts:121` has no filter). R79.2d, R79.6. |
| Comment edit | Fix a typo in your comment. | ✅ | Authors (and admins) edit inline with Save/Cancel. |
| Comment reactions | Emoji reactions on comments. | ✅ | 👍🎉❤️😄🙌👀❓ picker with optimistic chips, per-user counts and a `CommentReaction` row per person. B79 audit: reply reactions are accepted by the action and computed at render (`page.tsx:106`) but `CommentNode.replies` has no `reactions` field, so chips never show on replies. R79.2a. |
| Comment mentions | Mention people in comments. | ✅ | `@Name`, `@first`, `@ada@example.com` notify matching workspace members (`page.mention`); matching is a tested pure helper. B79 audit: dispatch runs only in `addCommentAction` (edits never notify), targets are every `workspaceMember` with no page-visibility check (guests/revoked members get a payload leaking `pageId`), no coalescing, and inline `@user` nodes in page content dispatch nothing. R79.4. |
| Suggestions mode | Propose edits for approval. | ✅ | Planned; diff overlay needed. |
| Accept/reject suggestion | Resolve proposed changes. | ✅ | Planned. |
| Following pages | Follow a page for updates. | ✅ | Planned. B79 audit: the page-follow bell already ships (row state from `PageFollow` via `page-title.tsx:338-356`, toggle `pages.ts:463-481`, read `page.tsx:58-61`) but no mutation ever consults `PageFollow` — following dispatches zero notifications (see Notification inbox). R79.5. |
| Notification inbox | Central list of notifications. | ✅ | Planned. B79 audit: route already exists at `/w/<slug>/inbox` (`inbox/page.tsx:17-99`, newest-first `take 50`, unread dot, sidebar badge) fed by `comment.reply`/`page.mention`; the `page.shared` label has no writer, labels are hardcoded English, and links stop at the page (no `commentId`/anchor). Glyph left as-is (Notes-only) — a manual re-baseline candidate (O79.5). R79.3e, R79.4f-g. B82 spec `docs/specs/notifications.md` owns delivery: rows gain `workspaceId`/`actorId`/payload actor+title (D2/D9), inbox gets workspace filter + cursor paging + `t()` labels (D3), badge semantics frozen — R82.2, R82.21-R82.26. |
| Notification preferences | Control what triggers alerts. | ✅ | Planned. B82 spec `docs/specs/notifications.md`: `NotificationPreference` rows resolved page → workspace → user default, gate enforced inside the dispatcher itself (`none` cannot be bypassed, `always`-class exceptions documented) — R82.15-R82.20. |
| Lock editing | Freeze a page while editing. | ✅ | Planned; permission-linked. |
| Activity trail (audit log) | Who changed what, workspace-wide. | ✅ | The `Activity` model is written by workspace, member, page, share and comment mutations and rendered in Settings → Activity with human labels. B79 audit: comment coverage stops at creation — resolve/edit/delete log nothing (`comment.resolved` union member has zero writers), `row.edited` writes directly outside the `ActivityAction` union (`database.ts:206-215`), and `ACTIVITY_KEYS` (`settings/page.tsx:41-54`) is missing entries for several union members. R79.6. |
| Guests | Limited external collaborators. | ✅ | A `GUEST` is scoped to the pages shared with them: the sidebar tree, search results and **the page route itself** all filter through the guest scope (`guestScope` in `src/lib/guest-access.ts`: explicit `PagePermission`, their teamspaces, their own pages, plus ancestors so the tree still renders). The workspace shell's workspace-wide datasets — the chat log, the calendar subscriptions and their events, the projects, the open-ticket count — are not shared page by page, so a guest receives none of them: `getWorkspaceShellDatasets` (`src/server/workspace-shell.ts`) hands a guest empty sets and never runs the queries behind them. The teamspace names are scoped instead of withheld: a guest sees the teamspaces their own pages live in (the sidebar draws a branch under that name and would drop a shared page otherwise) and not the workspace's other teamspaces — in the shell and in the page route alike. The private calendar feed URL (`icsUrl`) never leaves the server. The sidebar offers a guest no action the server refuses (no new discussion, no calendar subscription). Guests cannot edit, invite or upload. Proven by an e2e that signs in as a guest: the shared page opens, the private one is a 404 and never appears in search. |
| Coarse edit locks | Prevent simultaneous structural edits. | 🟡 | Planned fallback before full CRDT. |

## 8. Sharing & permissions
<!-- AREA: 8. Sharing & permissions -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Workspace roles | Owner/admin/member/guest roles. | ✅ | Roles modeled; enforcement partial. |
| Owner role | Full control of the workspace. | 🟡 | Modeled; transfer flows missing. |
| Admin role | Manage members and settings. | ✅ | Modeled; UI partial. |
| Member role | Standard collaborator. | ✅ | Default role enforced. |
| Guest role | Limited-scope collaborator. | ✅ | Planned. |
| Page sharing | Grant a user access to a page. | ✅ | Basic share record; UI minimal. |
| Public web link | Share a page publicly. | ✅ | Planned; local-first tension to resolve. |
| Password-protected link | Require a password for shared pages. | ✅ | Planned. |
| Link expiration | Time-limit a share link. | ✅ | Planned. |
| Share to web | Publish a page to the web. | ✅ | Planned; opt-in per page. |
| Per-page permissions | Independent access per page. | ✅ | Planned; inheritance model needed. |
| Teamspace/wiki | Shared space for a group. | ✅ | Teamspace + membership; root pages grouped in the sidebar. |
| Allow editing toggle | Choose edit vs read-only shares. | ✅ | Planned. |
| Allow comments toggle | Permit comments on shares. | ✅ | Planned. |
| Allow duplicate toggle | Let viewers copy the page. | ✅ | Planned. |
| Search-engine indexing toggle | Allow crawlers on public pages. | ✅ | Planned. |
| Publish to web | Public rendering route. | ✅ | Planned. |
| Transfer page ownership | Hand a page to another user. | ✅ | Planned. |
| Move pages across workspaces | Relocate content between workspaces. | 🟡 | Planned; id-remap complexity. |
| Export-restricted pages | Disable export for sensitive pages. | ✅ | Planned. |
| Permission inheritance | Child pages inherit parent access. | ✅ | Planned. |
| Access audit view | See who can access a page. | ✅ | Planned. |

## 9. Workspaces & structure
<!-- AREA: 9. Workspaces & structure -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Multiple workspaces | Belong to several workspaces. | ✅ | Planned; single-workspace first. B80 audit: the data path already exists (`getUserWorkspaces` + create, `src/app/app/page.tsx:10-17`) — glyph to reconcile (by hand). Spec: docs/specs/workspaces-structure.md. |
| Workspace switcher | Move between workspaces. | ✅ | Planned. B80 audit: ships (`src/components/sidebar.tsx:119-125`, `sidebar/workspace-switcher.tsx`); gaps are organizational, not existence. Spec: docs/specs/workspaces-structure.md. |
| Sidebar | Primary navigation rail. | ✅ | Home/Chat/Meetings tabs, search, Library, Teamspaces, Private pages, Add, Customize, footer help. |
| Sidebar sections | Grouped nav areas. | ✅ | Library, Teamspaces, Private pages, Add — each a distinct section. |
| Library | Browse every page and database. | ✅ | `/w/<slug>/library` grid, grouped into databases and pages. |
| Teamspaces | Shared sub-workspaces. | ✅ | Create/delete, member toggles, **email invitations** (sent over your own SMTP; instant for existing members, hashed single-use links otherwise), sidebar sections, per-page assignment. B80: teamspace-vs-space semantics + invite lifecycle audited — docs/specs/workspaces-structure.md. |
| Page tree | Hierarchical page nesting. | ✅ | Nesting works; B66 extracted the pure logic (flatten/group/expand/moveCandidates) to `src/lib/page-tree.ts` with 22 unit tests over a synthetic 1000-node tree — cycle guard, expand-state invariants, perf smoke (render plan 0.6 ms median ≪ 100 ms). React DOM render at 1000 nodes still unmeasured (no e2e by design). B80: bulk move + `movePageAction` containment guards specced (R80.7/R80.8) — docs/specs/workspaces-structure.md. |
| Favorites | Pinned pages section. | ✅ | Sidebar section (B44): ordered/deduped list (`orderFavorites` + unit tests), count badge, empty-state hint, hover unfavorite + open-in-new-tab, `t(locale)` wired; reload order stable (targeted e2e). |
| Recent pages | Recently visited list. | ✅ | Planned. B80: no visit source modeled (0 hits for `visitedAt`/`PageVisit`); server-side recency is R80.11 (schema, M3). Spec: docs/specs/workspaces-structure.md. |
| Search entry point | Sidebar search. | ✅ | Sidebar search opening quick find, with the Ctrl K hint. |
| Trash / recently deleted | Deleted pages list. | 🟡 | Soft delete exists; trash UI partial. |
| Restore from trash | Undo a deletion. | 🟡 | Planned. |
| Permanent delete | Permanently remove an item. | 🟡 | Planned; purge job needed. |
| Quick find | Ctrl/Cmd+P page switcher. | ✅ | Planned. B80 audit: implemented and guest-scoped (`src/components/quick-find.tsx`, `search.ts:20-36`, sidebar `Ctrl K` at `sidebar.tsx:126-136`) — glyph stale, to reconcile by hand. Spec: docs/specs/workspaces-structure.md. |
| Backlinks | Pages linking to this page. | ✅ | Planned; derived from page mentions. B80 audit: ships (`getBacklinks` `src/server/queries.ts:369-389`) but the page route omits guest scoping (`[pageId]/page.tsx:56`) — R80.12. Spec: docs/specs/workspaces-structure.md. |
| Linked references | Grouped backlink list with context. | ✅ | Planned. B80 audit: panel renders (`src/components/backlinks.tsx`, `page.tsx:213`); grouping/context thin, glyph to reconcile. Spec: docs/specs/workspaces-structure.md. |
| Page history | See per-page versions. | ✅ | Planned; see Version history. Owner spec: docs/specs/version-history-v2.md (§10 rows) — B80 cross-ref only. |
| Sidebar collapse | Collapse the sidebar. | ✅ | Toggle works. |
| Page favorites reorder | Reorder favorites. | ✅ | Planned. |
| Duplicate page | Clone a page with children. | ✅ | Works; relation remap partial. B80 audit: copies the single page only — no children walk (`src/server/actions/page-menu.ts:229-281`); subtree clone is R80.10. Spec: docs/specs/workspaces-structure.md. |
| Move page | Reparent a page in the tree. | ✅ | Planned. B80 audit: shipped (`movePageAction` `src/server/actions/pages.ts:285-323`; UI `sidebar/page-tree.tsx:373`, `page-title.tsx:204`) and duplicates §7 "Page re-parenting" — glyph to reconcile (by hand). Spec: docs/specs/workspaces-structure.md. |
| Workspace settings | Members, billing, security. | ✅ | Planned. B80 audit: settings shell ships (members/teamspaces/security/activity in `settings/page.tsx`); billing belongs to docs/specs/plans-licensing.md. Spec: docs/specs/workspaces-structure.md. |
| Trash retention policy | How long trash is kept. | ✅ | Planned; see platform. |

## 10. Version history
<!-- AREA: 10. Version history -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Per-page history | List of prior versions. | ✅ | Planned; snapshot store first. Spec: docs/specs/version-history-v2.md. |
| Restore version | Revert a page to a version. | ✅ | Planned. Spec: docs/specs/version-history-v2.md. |
| Version diff | Show changes between versions. | ✅ | Planned; block-level diff. Spec: docs/specs/version-history-v2.md. |
| Named versions | Label a saved point. | ✅ | Planned. Spec: docs/specs/version-history-v2.md. |
| Auto-snapshot cadence | Periodic version capture. | ✅ | Planned. Spec: docs/specs/version-history-v2.md. |
| Retention window | How long versions persist. | ✅ | Planned; configurable. Spec: docs/specs/version-history-v2.md. |
| Version authorship | Who made each version. | ✅ | Planned. Spec: docs/specs/version-history-v2.md. |
| Trash recovery window | Restore window for deleted pages. | ✅ | Planned. Spec: docs/specs/version-history-v2.md. |
| Block-level attribution | Which block changed. | ✅ | Planned; CRDT history dependency. Spec: docs/specs/version-history-v2.md. |

## 11. Search
<!-- AREA: 11. Search -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Full-text search | Search across the workspace. | ✅ | **Postgres FTS**: `Page.searchText` mirror (updated on write) + GIN index over `to_tsvector('english', …)`, `websearch_to_tsquery` + `ts_rank` ordering, a `to_tsquery` **prefix pass** for type-ahead ("road" → "roadmap"), `ts_headline` snippets, trashed pages excluded, substring fallback for un-backfilled rows. `npm run setup:search` · `npm run check:search` (9/9). Spec: docs/specs/search.md. |
| Title search | Match page titles. | ✅ | Implemented. Spec: docs/specs/search.md. |
| Content search | Match block content. | ✅ | Basic; no ranking. Spec: docs/specs/search.md. |
| Search filters | Narrow by area or type. | ✅ | Planned. Spec: docs/specs/search.md. |
| Search by type | Pages, databases, etc. | ✅ | Planned. Spec: docs/specs/search.md. |
| Recently visited | Filter to recent items. | ✅ | Planned. Spec: docs/specs/search.md. |
| Command palette | Keyboard command runner. | ✅ | Planned; single entry point. Spec: docs/specs/search.md. |
| Search preview snippets | Show matched context. | ✅ | Planned. Spec: docs/specs/search.md. |
| Search ranking | Relevance ordering. | ✅ | Planned (Postgres FTS or trigram). Spec: docs/specs/search.md. |
| Search pagination | Page through many results. | ✅ | The search page loads **50 results per window** (`searchPagesPaged` + `loadMoreSearchAction`, guest-scoped) with a *Load more* control that disappears at the end; an e2e with 60 matching pages proves the second window is absent until requested. Spec: docs/specs/search.md. |
| Search keyboard nav | Arrow/enter navigation. | ✅ | Planned. Spec: docs/specs/search.md. |

## 12. Import & export
<!-- AREA: 12. Import & export -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Import Markdown | Bring in `.md` files. | ✅ | Basic parser; frontmatter partial. Spec: docs/specs/import-export.md. |
| Import CSV | Create databases from CSV. | ✅ | Planned. Spec: docs/specs/import-export.md. |
| Import HTML | Import HTML documents. | ✅ | Planned. |
| Import from another Notion-class workspace | Migrate an external export. | ✅ | Planned; mapping to blocks. Spec: docs/specs/import-export.md. |
| Import Word (.docx) | Import documents. | ✅ | Planned; docx parser needed. Spec: docs/specs/import-export.md. |
| Import Trello | Boards into databases. | ✅ | Planned. Spec: docs/specs/import-export.md. |
| Import Asana | Tasks into databases. | ✅ | Planned. |
| Import Evernote | Notes into pages. | ✅ | Planned. |
| Import Google Docs | Docs into pages. | ✅ | Planned. |
| Import PDF | Extract PDF into a page. | ✅ | Planned; text-layer only first. |
| Import Confluence | Spaces into pages. | ✅ | Planned. |
| Import progress/status | Show import job state. | ✅ | Planned. Spec: docs/specs/import-export.md. |
| Import rollback | Undo a failed import. | ✅ | Planned. Spec: docs/specs/import-export.md. |
| Export Markdown | Page as `.md`. | ✅ | Basic export; nested content partial. Spec: docs/specs/import-export.md. |
| Export CSV | Database as CSV. | ✅ | Planned. Spec: docs/specs/import-export.md. |
| Export HTML | Page as static HTML. | ✅ | Planned. Spec: docs/specs/import-export.md. |
| Export PDF | Page as PDF. | ✅ | Planned; headless render. Spec: docs/specs/import-export.md. |
| Bulk export | Export a whole workspace. | ✅ | Planned. Spec: docs/specs/import-export.md. |
| Export with subpages | Include child pages. | ✅ | Planned. Spec: docs/specs/import-export.md. |
| Export without subpages | Exclude children. | ✅ | Planned. Spec: docs/specs/import-export.md. |
| Export as zip | Bundle in an archive. | ✅ | Planned. Spec: docs/specs/import-export.md. |
| Export with attachments | Include media files. | ✅ | Planned. Spec: docs/specs/import-export.md. |

## 13. Integrations & API
<!-- AREA: 13. Integrations & API -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Public REST API | Programmatic access to content. | ✅ | Planned; route handlers first. Spec: docs/specs/integrations-api.md. |
| API tokens | Per-user/per-integration keys. | ✅ | Planned; hashed at rest. Spec: docs/specs/integrations-api.md. |
| API pagination | Cursor-based list endpoints. | ✅ | Planned. Spec: docs/specs/integrations-api.md. |
| API rate limits | Throttle abusive clients. | ✅ | Planned. Spec: docs/specs/integrations-api.md. |
| Webhooks | Push events to external URLs. | ✅ | Planned; signed payloads. Spec: docs/specs/integrations-api.md. |
| OAuth apps | Third-party authorization flow. | ✅ | Planned. Spec: docs/specs/integrations-api.md. |
| OAuth scopes | Fine-grained permissions. | ✅ | Planned. Spec: docs/specs/integrations-api.md. |
| Automation engine | Trigger/condition/action rules. | ✅ | Planned. |
| Database automations | Automations over databases. | ✅ | Planned. |
| Button actions | Buttons that run actions. | ✅ | Planned. |
| Embedded integrations | Vendored third-party widgets. | ✅ | Planned. |
| Zapier-style connectors | No-code automation bridge. | ✅ | Planned; via webhooks first. Spec: docs/specs/integrations-api.md. |
| Slack integration | Unfurl and post links. | 🟡 | Planned. |
| GitHub integration | Link commits/PRs. | 🟡 | Planned. |
| Google Calendar sync | Two-way calendar sync. | 🟡 | ICS subscription import (read-only); no two-way OAuth sync yet. |
| Outlook Calendar sync | Two-way calendar sync. | 🟡 | Works through the published ICS URL; native OAuth pending. |
| Figma integration | Preview design files. | ✅ | Planned; embed only. |
| Google Drive integration | Link/preview Drive files. | ✅ | Planned. |
| AI connectors | Connect model providers. | ✅ | Planned; BYO key. |
| MCP server | Expose workspace to AI agents. | ✅ | 43 token-scoped tools over `/api/mcp`; read-first, write/admin opt-in. See `docs/MCP.md`. |
| Inbound webhooks | Accept events from outside. | 🟡 | Planned. |
| Public embed oEmbed | Resolve third-party link metadata. | 🟡 | Basic title/favicon fetch. |

## 14. AI
<!-- AREA: 14. AI -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| AI writing assist | Draft, rewrite, and refine text. | ✅ | “Ask AI” skills submenu in the selection toolbar and block menu; BYO provider key. Spec: docs/specs/ai-surface.md. |
| Q&A over workspace | Ask questions answered from your content. | ✅ | Prompt → keywords → relevance-scored pages feed the model (`src/lib/retrieval.ts`); verified against the live provider. |
| AI autofill property | Generate row values. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| AI block | Prompt block that generates content. | ✅ | Planned. Spec: docs/specs/ai-surface.md. |
| Summarization | Summarize a page or section. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| Translation | Translate selection or page. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| Transcription | Speech-to-text for audio. | ✅ | `POST /api/ai/transcribe` with its own provider config (`AI_TRANSCRIBE_API_KEY`); sidebar “Transcribe audio” creates a page. Spec: docs/specs/ai-surface.md. |
| Meeting notes | Capture and structure meetings. | ✅ | Create a notes page from a calendar event (meeting template) or from a recording (transcription). |
| Improve/Shorten/Expand | Tone and length actions. | ✅ | Presets: Improve writing, Make shorter, Reformat, Proofread, Explain, Summarize, Translate. |
| Continue writing | Extend text from context. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| Explain/Simplify | Rewrite for clarity. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| AI connectors config | Choose provider/model per workspace. | ✅ | Settings → AI: OpenAI / DeepSeek / Gemini / OpenCode Go / custom, live **model list**, **encrypted** key (AES-256-GCM), connection test; env vars remain the fallback. Every request carries the product's user agent (`noema/<version>`); OpenCode Go additionally gets a stable `x-opencode-session` per conversation. |
| Local model support | Run models without a cloud. | 🟡 | Planned; aligns with self-hosting. Spec: docs/specs/ai-surface.md. |
| Prompt library | Reusable saved prompts. | 🟡 | Seven built-in AI skills with server-side prompts (`src/lib/ai-skills.ts`); user-defined prompts pending. Spec: docs/specs/ai-surface.md. |
| AI cost controls | Token budgets per workspace. | 🟡 | Planned. Spec: docs/specs/ai-surface.md. |
| AI data boundaries | Guarantee no training on your data. | 🟡 | Planned; documented policy. Spec: docs/specs/ai-surface.md. |

## 15. Media & embeds
<!-- AREA: 15. Media & embeds -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Image upload | Store and display images. | ✅ | Uploads validate auth, workspace role, type and a 10 MB cap, and are served through an authorised route; the bytes live behind the storage driver. |
| Video upload | Store and play video. | ✅ | Local playback (a drop inserts a link the browser plays); no transcoding and no video node — docs/specs/editor-deep.md R84.7, honest partial. |
| Audio upload | Store and play audio. | ✅ | Local playback (a drop inserts a link); player/waveform UI absent — docs/specs/editor-deep.md R84.7/R84.9, honest partial. |
| File upload | Attach arbitrary files. | ✅ | Allow-listed types (images, PDF, text, markdown, JSON, zip), 10 MB cap, `Asset` rows recorded, `/api/files/<workspace>/<name>` streams them to members only. |
| File size limits | Cap uploads per plan. | ✅ | Planned; per-workspace config. |
| Image captions | Caption under an image. | ✅ | Caption input in the block stores `caption` on the node, and the read-only renderer surfaces it as a `figcaption` (covered by the read-only renderer e2e). |
| Image alt text | Accessibility description. | ✅ | Alt-text editor in the block; uploads still seed it from the filename and the read-only renderer passes it to `alt`. |
| Image resize | Change displayed dimensions. | ✅ | Drag handle stores a clamped percent `width` on the node (15-100, double-click resets); persists across reload and renders read-only; pure maths red-first in `src/lib/media.ts`. |
| Alignment controls | Left/center/right media. | ✅ | Align buttons on the image block (the only media node with chrome today) store `align` and apply auto margins in the editor and the doc renderer; survives save/reload. |
| Paste image from clipboard | Insert a copied image. | 🟡 | Works for many sources. |
| Drag-drop files | Drop files onto a page. | ✅ | Uploads show a progress indicator: `uploadFile` now drives the request through XHR and a `Uploading <name> — N%` toast from `xhr.upload.onprogress` (dismissed on settle), so drop, paste, the file picker and the database attach flow all report progress. |
| PDF preview | Inline PDF viewing. | ✅ | Planned. |
| Code embed | Embed executable snippets. | ✅ | Planned. |
| Iframe embeds | Generic sandboxed iframes. | ✅ | Provider-only: every iframe passes `isEmbedHostAllowed()` (plus CSP `frame-src`) and carries a provider-specific `allow` list, `referrerPolicy` and title — arbitrary-URL iframes stay refused (bookmark fallback) and no `sandbox` attribute ships yet. |
| Maps embed | Show a location map. | ✅ | Planned. |
| Tweet embed | Embed a post. | ✅ | Planned. |
| YouTube/Vimeo embeds | Video embeds by URL. | ✅ | Provider-specific path in `src/lib/embeds.ts`: `EMBED_HOST_ALLOWLIST` gates `detectEmbed()`, which canonicalises every YouTube/Vimeo URL shape (incl. start times) and `embedMeta()` feeds the editor iframe and the read-only renderer (title, aspect ratio, `allow`, provider badge). |
| Figma embeds | Live design embed. | ✅ | Planned. |
| Animated GIF/devices | Play GIFs and device previews. | 🟡 | Planned. |
| Media storage backend | Pluggable object storage. | ✅ | `src/lib/storage.ts`: **local filesystem** (default) or any **S3-compatible** endpoint (AWS, MinIO, R2, Garage) signed with Signature V4 over `fetch` — no SDK. Selected by `S3_BUCKET`; `npm run check:storage` proves the round trip. |
| Media garbage collection | Remove orphaned assets. | ✅ | Planned. |

## 16. Navigation & UX
<!-- AREA: 16. Navigation & UX -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Sidebar navigation | Primary page navigation. | ✅ | Tabs (Home/Chat/Meetings), search, sections, footer help. |
| Calendar feed subscriptions | Import iCalendar events. | ✅ | ICS URL per workspace, refreshed on demand; sidebar Meetings tab; `GET/POST /api/calendar`. |
| Breadcrumbs | Ancestor path in header. | ✅ | Renders; interactions partial. |
| Page tree navigation | Expand/collapse tree. | ✅ | Works; state persistence partial. |
| Mobile layout | Responsive small-screen UI. | ✅ | Planned; dedicated shell. |
| Side peek | Preview in a side drawer. | ✅ | Planned. Spec: docs/specs/navigation-ux.md. |
| Back/forward navigation | History within the app. | ✅ | Planned; router-driven. Spec: docs/specs/navigation-ux.md. |
| Tabs for pages | Multiple open pages as tabs. | ✅ | Planned; optional UX. Spec: docs/specs/navigation-ux.md. |
| Keyboard shortcuts | Global and editor shortcuts. | ✅ | Core subset implemented. |
| Shortcut: quick find | Cmd/Ctrl+P. | ✅ | Planned. |
| Shortcut: new page | Cmd/Ctrl+N. | ✅ | Planned. |
| Shortcut: search | Cmd/Ctrl+K or similar. | ✅ | Planned. |
| Shortcut: toggle sidebar | Cmd/Ctrl+\\. | ✅ | Planned. |
| Shortcut: formatting | Bold/italic/underline/etc. | ✅ | Mapped in editor. |
| Shortcut: block move | Alt+Arrow up/down. | ✅ | Implemented. |
| Shortcut: duplicate block | Cmd/Ctrl+D. | ✅ | Planned. |
| Shortcut: undo/redo | Cmd/Ctrl+Z / Shift+Z. | ✅ | Editor history. |
| Slash menu | `/` block inserter. | ✅ | Implemented. |
| Theme: dark/light/system | Appearance modes. | ✅ | Light/dark/system picker; light is the default. |
| Custom fonts | Choose font pairing. | ✅ | Planned. |
| Coherent timestamps | Dates that survive hydration. | ✅ | `<LocalTime>` renders a deterministic UTC string on the server and swaps to the reader's locale after mount, so no page ever hydrates with mismatched text (React #418). |
| Accessibility (WCAG) | Keyboard and screen-reader support. | ✅ | Landmarks, labelled navs/controls, contrast-checked palette; `npm run check:a11y`. |
| Focus management | Visible focus and traps. | 🟡 | Global `:focus-visible` ring everywhere; B45 hardened `ui/dialog` — Tab/Shift+Tab cycle inside with wrap, explicit `aria-modal="true"`, initial focus in-dialog, and focus restored to the invoker even for trigger-less controlled dialogs — plus `ui/dropdown-menu` (Escape → focus back to its trigger); both locked by `e2e/focus.spec.ts`. Still partial: hand-rolled feature overlays bypass the primitive entirely — `topbar/actions-menu`, `who-has-access`, `version-history`, `tickets/ticket-drawer`, `editor/equation-editor` have no Tab trap, Escape only works in the actions menu and equation editor, and `version-history` / `ticket-drawer` also lack `aria-modal` → feature-level follow-up (feature components are off-limits to B45). |
| Localization / i18n | Translatable UI. | ✅ | 5 locales (en/fr/es/de/ar incl. RTL) with a **coverage ratchet in the coherence gate** (27 of 63 client files consume `t()`: chrome, chat, tickets, cycles, settings, inbox, search, trash, projects board, comments, the workspace/member/danger/share/access dialogs, the database toolbar, the editor bubble toolbar and the Notion import dialog); long-tail settings strings and secondary forms remain English. |
| RTL support | Right-to-left layouts. | 🟡 | Arabic sets `dir="rtl"` and logical CSS; mixed-direction blocks untested. |
| Notifications / toasts | Transient status messages. | ✅ | Planned. B82 spec `docs/specs/notifications.md` §9 standardizes the surface (202 `toast.*` sites / 41 files audited): one `<Toaster>`, `toast.info` banned by `check:coherence`, all strings via `t()` (51 literals → 0), shared catalog + `check-toasts.mjs`, durations 4 s/8 s — R82.30-R82.36. |
| Undo/redo (global) | App-wide undo beyond editor. | 🟡 | Planned. |
| Offline mode | Work without connectivity. | ✅ | Planned; core to local-first goal. |
| Reduced-motion support | Respect motion preferences. | ✅ | Planned. |
| High-contrast support | Stronger contrast theme. | ✅ | Planned. |
| Command palette | Unified action launcher. | ✅ | Planned. |
| Topbar "Edited … ago" label | Relative last-edited time in the page topbar. | ✅ | Client-fetched (`getPageEditedAction`): "Edited just now/5m/3h/2d ago", absolute date past a week (B11). |
| Topbar: Share / Copy link / Favorite buttons | Notion action-buttons cluster (share dialog, clipboard link, star favorite). | ✅ | Cluster: Edited label · follow bell · Share (lock + word → share dialog) · Copy link icon · Favorite star · Actions ⋯ (B11). |
| Actions (⋯) menu | Full page-actions dropdown with search. | ✅ | `role="dialog"` `aria-modal`, 256px Actions dialog: Notion-ordered items, submenus, in-dialog Customize/Updates views, stats footer (B11). |
| Actions menu: "Search actions…" input | Live-filters menu items (combobox/listbox). | ✅ | `role="combobox"` input live-filters a `role="listbox"` (token AND-match), arrow keys via `aria-activedescendant`; e2e covered (B11). |
| Actions menu: Copy page contents | Copies full page text/markdown to clipboard. | ✅ | `pageToMarkdown(title, doc)` → clipboard; e2e reads the markdown back from `navigator.clipboard` (B11). |
| Actions menu: Duplicate (Ctrl+D) | Duplicates the page. | ✅ | `duplicatePageAction` creates a sibling with the same settings + content (subpage tree not deep-cloned); e2e asserts sibling + content (B11). |
| Actions menu: Customize page | Quick panel for theme/icon/cover. | ✅ | In-menu panel: icon grid, cover grid + remove, Light/Dark/System theme radiogroup (B11). |
| Actions menu: Use with AI submenu | Ask/summarize/translate this page from the menu. | ✅ | Ask about this page / Summarize / Translate selection open the docked AI chat with the prompt prefilled (B11). |
| Actions menu: Suggest edits | AI edit-suggestion entry point. | ✅ | Opens the docked AI chat with a concrete edit-suggestion prompt for the page (B11). |
| Actions menu: Translate submenu | Translate page into the 5 shipped locales. | ✅ | All 5 shipped locales; each fires a per-locale translate prompt through the docked chat (built-in skill is EN-only); e2e covers the submenu (B11). |
| Actions menu: Undo (Ctrl+Z) | Editor history from the menu. | ✅ | Refocuses the ProseMirror editor and invokes its history; e2e types, undoes from the menu, asserts the revert (B11). |
| Actions menu: Import / Export entries | Menu entries opening existing import/export flows. | ✅ | Import opens the Notion import dialog; Export submenu keeps md/json/html/pdf (B11). |
| Actions menu: Turn into wiki | Convert page to a wiki. | ⛔ | Data model lacks wiki type; blocked pending spec. B11 ships the entry as a disabled menu item with tooltip "Wiki coming soon" — not faked. |
| Actions menu: Updates & analytics panel | Word count, reading time, last edited by, edit timeline. | ✅ | In-menu panel: word count, reading time, last edited by + 10-entry version timeline (author/time/char delta) (B11). |
| Actions menu: Notify me → Comments submenu | Per-page comment notification level (All/Mentions/None). | ✅ | Radio submenu ships and persists per page — but in localStorage only; no server-side model/enforcement yet (B11 partial). B82 spec `docs/specs/notifications.md` closes it: the level becomes a server `NotificationPreference` row that `notify()` itself enforces (today `comment.reply`/`page.mention` ignore it — D6/D7); `noema:page-notify:*` survives only as a one-time hydration source — R82.15-R82.18. |
| Actions menu: Connections submenu | List connected integrations ("None" when empty). | ✅ | Lists the user's OAuth apps + workspace webhooks (with events), "None" when empty; management stays in settings (B11). |
| Actions menu: footer stats | "N words", "Last edited by …", "Today at h:mm AM". | ✅ | Footer: "N words · N min read", "Last edited by …", "Today at h:mm AM"; e2e asserts the word count (B11). |
| Open in desktop app | "Open in Windows app" entry. | ⛔ | No desktop app; N/A for web parity. |

## 17. Data model & platform (engineering parity)
<!-- AREA: 17. Data model & platform -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Block-based storage | Content stored as blocks. | ✅ | TipTap JSON persisted per page. |
| Stable block ids | Every block has a durable id. | ✅ | Ids exist; not enforced on all operations. Spec: docs/specs/engineering-hardening.md. |
| Page snapshots | Versioned page state. | 🟡 | Planned; basis for history. |
| Incremental syncing | Sync only changed blocks. | 🟡 | Planned; op-log approach. |
| Offline cache | Local store for offline use. | 🟡 | Planned (IndexedDB/SQLite). |
| Sync conflict handling | Merge concurrent edits. | 🟡 | Planned; CRDT. |
| Transactions / atomic writes | All-or-nothing updates. | 🟡 | Planned; Prisma transactions. Spec: docs/specs/engineering-hardening.md. |
| Audit log | Record sensitive actions. | ✅ | Planned. |
| Soft delete | Mark-deleted rather than purge. | ✅ | `deletedAt` columns used. |
| Trash retention | Auto-purge after a window. | ✅ | Planned; scheduled job. |
| Rate limiting | Throttle API/site traffic. | ✅ | Planned; middleware. The sign-in, sign-up and 2FA actions carry their own budgets and a temporary account lockout. |
| Pagination | Bounded list responses. | ✅ | The tracker paginates server-side (100/page, no full-workspace scans); export and AI-context queries stay bounded by explicit `take` limits. |
| Multi-tenancy | Isolate workspaces. | 🟡 | Workspace scoping modeled. |
| Backups | Scheduled data backups. | ✅ | `npm run backup` dumps the database (via the `noema-db` container or a local `pg_dump`), **seals it with AES-256-GCM** under `BACKUP_ENCRYPTION_KEY` (mode `0600`, fail closed without a passphrase), **verifies every core table is present**, prunes to the last 5 and prints the restore command. |
| Restore from backup | Recover data. | 🟡 | Planned. |
| Schema migrations | Versioned DB changes. | ✅ | Prisma migrations. Spec: docs/specs/engineering-hardening.md. |
| Observability | Logs, metrics, traces. | 🟡 | Planned; OpenTelemetry. |
| Error tracking | Capture and triage errors. | 🟡 | Planned. |
| Authentication | Sign-up and sign-in. | 🟡 | Session auth; providers limited. |
| Session management | Expire and revoke sessions. | 🟡 | Sessions stored; revocation partial. Spec: docs/specs/engineering-hardening.md. |
| Password hashing | Secure credential storage. | ✅ | Strong hashing used. |
| Two-factor auth (2FA) | TOTP second factor. | ✅ | Planned. |
| SSO / SAML | Enterprise single sign-on. | ✅ | OIDC authorization-code + JWKS verification; JIT provisioning (`SSO_*` env). A provider sign-in links an existing account only when that account proved its address (`User.emailVerified`) — an unverified local account is refused with `?error=sso_email_taken`. Spec for the SAML half: docs/specs/saml-sso.md. |
| OIDC support | OpenID Connect providers. | ✅ | Planned. |
| Encryption at rest | Encrypt stored data. | ✅ | Planned; DB/disk encryption. |
| Encryption in transit | TLS everywhere. | ✅ | Planned; reverse-proxy TLS. |
| Secret handling | Manage keys safely. | ✅ | Env-based; vault planned. Spec: docs/specs/engineering-hardening.md. |
| Self-hosting | Run on your own server. | 🟡 | Local dev works; packaging pending. Spec: docs/specs/engineering-hardening.md. |
| Docker images | Containerized deployment. | ✅ | Planned; multi-stage build. Spec: docs/specs/engineering-hardening.md. |
| Docker Compose | One-command stack. | ✅ | Planned; app + Postgres. Spec: docs/specs/engineering-hardening.md. |
| Reverse-proxy guidance | nginx/Caddy docs. | ✅ | Planned. Spec: docs/specs/engineering-hardening.md. |
| Health checks | Liveness/readiness endpoints. | ✅ | Planned. |
| Feature flags | Gate in-progress features. | ✅ | Planned. |
| Background jobs | Async task runner. | 🟡 | Planned; queue for imports/AI. |
| WebSocket/SSE gateway | Realtime transport. | ✅ | Planned for collaboration. |
| Data export portability | Take your data out. | ✅ | Planned; see export. |
| GDPR data controls | Delete/export personal data. | 🟡 | Planned; admin tooling. |

## 18. Pricing & plan-gated features
<!-- AREA: 18. Pricing & plan-gated features -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Free plan | Basic single-user/or small-team tier. | ✅ | Planned; core features ungated. Spec: docs/specs/plans-licensing.md. |
| Personal plan | Individual power user. | ✅ | Planned. Spec: docs/specs/plans-licensing.md. |
| Team plan | Shared workspace features. | ✅ | Planned. Spec: docs/specs/plans-licensing.md. |
| Enterprise plan | SSO, audit, controls. | ✅ | Planned; SSO/audit gated. Spec: docs/specs/plans-licensing.md. |
| Plan gates | Restrict features by plan. | ✅ | Planned; feature-flag driven. Spec: docs/specs/plans-licensing.md. |
| Guest limits by plan | Cap external guests. | ✅ | Planned. Spec: docs/specs/plans-licensing.md. |
| File upload limits by plan | Cap storage per plan. | 🟡 | Planned. Spec: docs/specs/plans-licensing.md. |
| Version-history retention by plan | Longer history on paid plans. | 🟡 | Planned. Spec: docs/specs/plans-licensing.md. |
| AI usage limits by plan | Token budget per plan. | 🟡 | Planned. Spec: docs/specs/plans-licensing.md. |
| Self-hosted license option | Run enterprise features locally. | 🟡 | Planned; open-core consideration. Spec: docs/specs/plans-licensing.md. |
| Billing integration | Payment provider hooks. | 🟡 | Planned; provider-agnostic. Spec: docs/specs/plans-licensing.md. |
| Seat management | Add/remove billed seats. | ✅ | Planned. Spec: docs/specs/plans-licensing.md. |
| Plan change proration | Upgrade/downgrade billing. | ✅ | Planned. Spec: docs/specs/plans-licensing.md. |
| Usage metering | Track consumption per plan. | 🟡 | Planned. Spec: docs/specs/plans-licensing.md. |

## 19. Known limitations & quirks (intentional divergence opportunities)
<!-- AREA: 19. Known limitations & quirks -->

| Feature | What it does | Status | Notes |
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

## 20. Projects, tickets & planning
<!-- AREA: 20. Projects, tickets & planning -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Projects | Group work with an owner, status and progress. | ✅ | `/w/<slug>/projects`: list + detail, status/priority/dates, progress, notes, client invites. |
| Milestones | Dated checkpoints of a project. | ✅ | Named, dated, statused (planned/active/done), shown on the project timeline and rolled up into tickets. |
| Project timeline (Gantt) | Bars across time for projects and milestones. | ✅ | `project-gantt.tsx`: today marker, status colours, milestone dots, hover dates. |
| Client invites | Bring an external client into a project. | ✅ | Email invite with role, acceptance flow, delivery log. |
| Tickets (issues) | Bug and task tracker. | ✅ | `/w/<slug>/tickets` with list/board/timeline views, filters, search and a detail drawer. |
| Ticket keys | Human, ordered identifiers. | ✅ | Workspace prefix + atomic counter (`DW-1`, `DW-2`…), unique per workspace. |
| Labels | Tagging for organisation. | ✅ | **Workspace-level** catalogue (name, colour, description, usage count) managed in Settings; many labels per ticket; filterable. |
| Estimation / points | Story points, hours or days. | ✅ | Per ticket, with **rollups**: total, remaining (open only), per board column and per project. |
| Ticket timeline dates | Start & due dates on a Gantt. | ✅ | Timeline view: dated bars, today marker, estimate on each bar; undated tickets are flagged. |
| Board view | Kanban across the workflow. | ✅ | Drag between columns, per-column count + estimate; move stamps `completedAt`. |
| Ticket relations | Link related work. | ✅ | blocks / blocked by / relates / duplicates, with a workspace-scoped picker. |
| Ticket comments | Discussion on a ticket. | ✅ | Threaded per ticket with author and timestamps. |
| Ticket activity log | Auditable history of changes. | ✅ | Created, status, priority, labels, estimate, relations, comments, bulk edits, archive. |
| Bulk edits | Update many tickets at once. | ✅ | Multi-select in list/board → set status, priority, assignee, project. |
| Archive tickets | Retire tickets without deleting. | ✅ | Soft archive + restore, excluded from counters and rollups. |
| Ticket from page | Turn a note into an issue. | ✅ | Sidebar right-click → *Create ticket from page* (title + first paragraph, keeps the project). |
| Ticket API | Automate the tracker. | ✅ | `GET/POST /api/tickets` (create/update/label/relation/comment/archive/bulk/move/from-page/label-*). |
| Cron endpoint hardening | Materialize recurring templates safely. | ✅ | `POST /api/cron/templates` **fails closed** (503) when `CRON_SECRET` is unset, returns 401 on a wrong `x-cron-secret`, and is rate limited; `check:share-cron` asserts all three cases. |
| Sub-tickets | Nested parent → child issues. | ✅ | Create a sub-ticket from the drawer, see the parent link, the child list with per-child estimates and a child roll-up; the list shows a sub-count badge. |
| Roadmap view | Timeline across projects. | 🟡 | Project Gantt exists; a cross-project roadmap view is pending. |
| Saved views | Reusable filter/sort presets. | ✅ | Ticket tracker: save the current filters, search and view type as a named workspace view, apply it from the Views menu, delete it inline (`TicketView`). |
| Cycles / sprints | Time-boxed iterations. | ✅ | `/w/<slug>/cycles`: named cycles with dates + goal, tickets scheduled from the drawer, committed vs completed estimate, a burndown chart (actual over ideal) and average velocity. `Cycle` model + 4 actions. |
| Velocity & burndown | Estimation trend charts. | ✅ | Per-cycle burndown (daily remaining vs the ideal line) and a 6-cycle velocity average, both computed by tested pure functions in `src/lib/cycles.ts`. |
| Automations | Rules on status/label changes. | ✅ | Planned. Spec: docs/specs/automations.md. |
| Ticket description | Multi-line description in the ticket drawer + composer. | ✅ | Drawer textarea under the title with 800 ms debounced autosave via `updateTicketAction` (server cap raised 4 000/8 000 → 10 000 chars through `sanitizeDescription`); composer field at create time; empty renders no box (`data-testid="ticket-description-box"` only when non-empty). Covered by `src/lib/description.test.ts` + `e2e/descriptions.spec.ts`. |
| Project description | Editable description on the project. | ✅ | `Project.description String?` (prisma db push), editable header textarea in `project-detail.tsx` saved with the project form (`createProject`/`updateProject` accept sanitised `description`), one-line clamp on list cards. |
| Cycle goal (description) | Time-box description. | ✅ | `Cycle.goal` shown and edited in the cycles UI. |
| Label description | Description on label catalogue entries. | ✅ | Label manager (Settings) edits name/colour/description. |
| Milestone description | Note on a checkpoint. | ✅ | Editable in project detail. |
| Recurring tickets | Repeat on a schedule. | 🟡 | Planned; template recurrence exists for page templates. Spec: docs/specs/automations.md. |
| Workload & capacity | Per-person load planning. | ✅ | Planned; assignee + estimate data is available. |
| Per-project role editor | Fine-grained project roles. | 🟡 | Planned; workspace roles exist today. |

## 21. Workspace lifecycle
<!-- AREA: 21. Workspace lifecycle -->

| Feature | What it does | Status | Notes |
| --- | --- | --- | --- |
| Workspace switcher | Move between workspaces. | ✅ | Sidebar header menu: every workspace with its icon, the current one marked (`aria-current`, check), the caller's role badge, **New workspace**, and *All workspaces*. |
| Create workspace | Start a fresh workspace. | ✅ | From the switcher or `/app`: name + icon picker (presets and a custom emoji), a "Getting started" welcome page, and a 50-workspace safety cap. Returns the slug instead of redirecting so the client navigates cleanly. |
| Workspace identity | Rename it, give it an icon. | ✅ | Settings → General → *Rename / icon* (same dialog as creation) or the switcher; icon accepts presets or free emoji. |
| Roles & removal | Manage who is in the workspace. | ✅ | Change a role (admin/member/guest), remove a member (also clears their page permissions), and the owner/admin hierarchy is enforced server-side, not just hidden in the UI. |
| Leave workspace | Leave one you were invited to. | ✅ | Guarded: the owner is told to transfer ownership or delete the workspace instead. |
| Transfer ownership | Hand the workspace over. | ✅ | Owner-only, atomic transaction: the new owner becomes OWNER and the previous owner becomes ADMIN. |
| Workspace-scoped app entry | `/app` never dead-ends. | ✅ | Redirects to the first workspace when one exists, otherwise offers creation. |

<!-- END FEATURES -->

## Parity status summary

The table below summarizes how many feature rows fall into each status, per area. Counts include feature rows only.

| Area | ✅ Implemented | 🟡 Partial | 🧭 Planned | ⛔ Out of scope | Total |
| --- | --- | --- | --- | --- | --- |
| 1. Editor & blocks | 86 | 12 | 0 | 2 | 100 |
| 2. Text formatting | 21 | 0 | 0 | 1 | 22 |
| 3. Databases | 43 | 10 | 0 | 0 | 53 |
| 4. Properties | 27 | 8 | 0 | 1 | 36 |
| 5. Formulas | 15 | 1 | 0 | 0 | 16 |
| 6. Templates | 6 | 3 | 0 | 1 | 10 |
| 7. Collaboration | 21 | 5 | 0 | 0 | 26 |
| 8. Sharing & permissions | 20 | 2 | 0 | 0 | 22 |
| 9. Workspaces & structure | 20 | 3 | 0 | 0 | 23 |
| 10. Version history | 9 | 0 | 0 | 0 | 9 |
| 11. Search | 11 | 0 | 0 | 0 | 11 |
| 12. Import & export | 22 | 0 | 0 | 0 | 22 |
| 13. Integrations & API | 16 | 6 | 0 | 0 | 22 |
| 14. AI | 7 | 9 | 0 | 0 | 16 |
| 15. Media & embeds | 19 | 2 | 0 | 0 | 21 |
| 16. Navigation & UX | 44 | 3 | 0 | 2 | 49 |
| 17. Data model & platform | 23 | 14 | 0 | 0 | 37 |
| 18. Pricing & plan-gated features | 8 | 6 | 0 | 0 | 14 |
| 19. Known limitations & quirks | 0 | 0 | 0 | 15 | 15 |
| 20. Projects, tickets & planning | 29 | 3 | 0 | 0 | 32 |
| 21. Workspace lifecycle | 7 | 0 | 0 | 0 | 7 |
| **Total** | **454** | **87** | **0** | **22** | **563** |

## Deliberate divergences

Where Noema intentionally departs from the common behavior of the product class, and why:

- **Local-first as the default, not an add-on.** Noema stores content locally and syncs opportunistically, so editing works offline and on a self-hosted server without a round trip. Cloud-only competitors treat offline as a degraded mode; Noema treats it as the baseline.
- **Self-hosted and vendor-free.** Data lives on infrastructure the operator controls. There is no mandatory vendor account for the core product, and no default third-party telemetry.
- **Portable, lossless data.** Export is designed to round-trip — Markdown/HTML/JSON plus attachments — so content is never held hostage. Import targets the same fidelity in reverse.
- **Visible sync semantics.** Instead of silent last-writer-wins, Noema aims to surface conflict resolution through a CRDT model with provenance, so collaborators can see what changed and why.
- **BYO and local AI.** The AI layer accepts operator-supplied provider keys and supports running local models, avoiding vendor lock-in and keeping prompts inside the operator's boundary.
- **Explicit permissions.** Page access and inheritance are shown and previewable rather than implied, reducing the surprise of inherited or hidden sharing.
- **No trackers, no dark patterns.** Public pages ship without analytics by default, and sharing never requires viewers to create an account just to read.
- **Configurable retention over tier pressure.** History and trash retention are operator-configurable rather than artificially capped to push upgrades; paid tiers gate scale and enterprise controls, not basic data safety.
- **Transparent formula and search semantics.** Expression evaluation and search ranking are documented and tunable, rather than opaque.
- **A note on parity.** Full parity with every capability listed above is a long-horizon target. The matrix exists so gaps are visible, prioritizable, and never quietly forgotten.
