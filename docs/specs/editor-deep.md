# Spec — Editor deep backlog (columns, table headers, provider parity, selection edges, embed allowlist)

> **Status: spec complete, implementation pending.** This document is the
> deliverable: docs-only, no production code was changed, and
> `src/components/editor/**` was opened **READ-only** for this spec. Every claim about the current code cites file + line. Requirement IDs
> (`R84.x`) are the traceability anchors: §7 lists tasks 1:1 against them, and
> tests must cite the IDs they cover.

---

## 1. Scope, ownership & status

### 1.1 What this spec is

The §1 *Editor & blocks* area of `docs/FEATURE_MATRIX.md` still carries a set of
🟡/🧭 rows that no other work is closing. This spec is the **editor-slot
backlog**: it specifies the behaviour for the rows that are nobody else's, and
gives spec-level detail (with explicit ownership hand-offs) for three rows that
concurrent suites **B18**, **B20** and **B96** are closing live this phase.

### 1.2 Rows closed by other work — do NOT re-implement from this spec

| Matrix row (line) | Glyph | Covered by | Evidence |
| --- | --- | --- | --- |
| Markdown shortcuts (`FEATURE_MATRIX.md:138`) | ✅ | **B18** | `e2e/editor-extras.spec.ts:118` (long tail: `1)` lists, pipe tables) |
| `@` mention menu scoping (`:141`) | ✅ | **B18** | `e2e/editor-extras.spec.ts:158` |
| Emoji picker / `:shortcode:` (`:142`) | ✅ | **B18** | `e2e/editor-extras.spec.ts:208` |
| Page link mention (`:105`), Person mention (`:108`, scoping half) | 🟡 | **B18** | same mention slice; the *notifications* half of `:108` is **not** in B18's scope |
| Multi-block selection (`:130`) — **select-all edge subset only** | 🟡 | **B18** | B18 owns "shift+click select-all edge cases"; no select-all test exists in `e2e/editor-extras.spec.ts` yet (grep) — still open on its side |
| Image block/resize (`:81`, `:82`), Video (`:85`), Audio (`:86`), File preview (`:87`), Bookmark thumbnail (`:88`) | 🟡/🧭 | **B20** | `e2e/media-parity.spec.ts:227` (resize), `:196` (upload progress), `:299,370` (bookmark thumbnails) |
| YouTube embed (`:93`), Vimeo embed (`:94`) | 🟡/🧭 | **B20** | `e2e/media-parity.spec.ts:149` (provider path with start time). Note: Vimeo URL detection already ships (`src/lib/embeds.ts:178-195`, `src/lib/embeds.test.ts:115-131`) — the 🧭 on `:94` is stale; glyph left for a manual re-baseline |
| Embed block (`:89`) — **config/code half** ("embed allowlist config" is in B20's file list) | 🟡 | **B20** | allowlist already in code, see §3.5 |
| Table of contents (`:68`) | 🟡 | **B96** | `e2e/toc.spec.ts` not present yet (B96 pending); scroll-spy detail specified in §5 here |

### 1.3 This change's scope

- **Spec'd here:** columns add/remove UI (`R84.1-R84.3`), simple-table header
  styling + table controls (`R84.4-R84.6`), video/audio provider parity
  (`R84.7-R84.9`), multi-block selection edges (`R84.10-R84.12`), embed
  allowlist UI (`R84.13-R84.15`), TOC scroll-spy *spec detail* (`R84.16` —
  implementation owned by B96).
- **Not in scope:** matrix glyph flips and `docs:counts` / `docs:gaps`
  regeneration (maintainer-only), any edit under
  `src/components/editor/**` (READ-only for B84), any code change at all.

## 2. Audit — matrix section 1 (planned/partial rows, who covers what)

Every 🟡/🧭/⛔ row of `docs/FEATURE_MATRIX.md` §1 (lines 20-161) with its
disposition. "Unowned" = no other work and no spec covers it today; that is the
honest backlog this audit exists to surface.

### 2.1 Core text blocks (lines 37-42)

| Line | Row | Glyph | Disposition |
| --- | --- | --- | --- |
| 37 | Toggle heading | 🧭 | Unowned (heading × toggle composite) |
| 41 | Pull quote / large quote | 🧭 | Unowned (quote variant) |
| 42 | Comment block (doc annotation) | ⛔ | Out of scope by design |

### 2.2 Code & math (lines 51-56)

| Line | Row | Glyph | Disposition |
| --- | --- | --- | --- |
| 51 | Code block line numbers | 🧭 | Unowned |
| 52 | Code block caption | 🧭 | Unowned |
| 53-55 | Inline/block equation, KaTeX support | 🟡 | Unowned — the math rows are all partial; no spec claims them |
| 56 | Math editor UX (composer) | 🧭 | Unowned |

### 2.3 Layout blocks (lines 62-75)

| Line | Row | Glyph | Disposition |
| --- | --- | --- | --- |
| 62 | Columns (2/3/4/5) | 🟡 | **Spec'd here — R84.1-R84.3** |
| 63 | Column resize | 🧭 | Unowned — adjacent to R84.1 but *not* required by B84; keep as a separate slice so the add/remove UI is not blocked on drag-width persistence |
| 64 | Simple table block | 🟡 | **Spec'd here — R84.4-R84.6** |
| 65 | Table header row/column | 🟡 | **Spec'd here — R84.4-R84.6** |
| 66 | Table cell colors | 🧭 | Unowned (paints ride the block-colour machinery later) |
| 67 | Table merge/split cells | ⛔ | Out of scope by design |
| 68 | Table of contents | 🟡 | **B96 live; spec detail here §5 (R84.16)** |
| 69 | Breadcrumb block (deep-tree linking) | 🟡 | Unowned |
| 70-71 | Synced block + source marker | 🧭 | Unowned (needs reference ids) |
| 72 | Template button block | 🧭 | Gated on the templates system — `docs/specs/templates.md` (matrix `:339`) |
| 73 | Button block | 🧭 | Gated on automations — `docs/specs/automations.md` |
| 74 | Ask-AI block | 🧭 | Gated on AI layer — `docs/specs/ai-surface.md` (matrix `:532`) |
| 75 | Two-column page property layout | 🧭 | Unowned (property panel rework) |

### 2.4 Media blocks (lines 81-97)

| Line | Row | Glyph | Disposition |
| --- | --- | --- | --- |
| 81-82 | Image block, image resize | 🟡/🧭 | **B20 live** (`e2e/media-parity.spec.ts:227`) |
| 85-86 | Video block, Audio block | 🟡 | **B20 live (rows) + R84.7-R84.9 (editor-slot spec)** — see §3.3: the "local file playback" claim is not backed by any player in `src/` today |
| 87-88 | File block, Bookmark block | 🟡 | **B20 live** (`e2e/media-parity.spec.ts:299,370`) |
| 89 | Embed block (provider allowlist) | 🟡 | **R84.13-R84.15 (UI half) + B20 (config half)** — allowlist already ships in code (§3.5) |
| 90 | PDF preview block | 🧭 | Unowned (`src/lib/pdf.ts` exists for export, no viewer block) |
| 91-92, 95-97 | Map, Twitter/X, Figma, CodePen/CodeSandbox, Google Drive embeds | 🧭 | Unowned — but note the embed input *promises* Figma/Loom today (`bookmark.tsx:218`); R84.8 makes the UI truthful first |
| 93-94 | YouTube, Vimeo embeds | 🟡/🧭 | **B20 live** (§1.2) |

### 2.5 Page-level blocks & structure (lines 103-110)

| Line | Row | Glyph | Disposition |
| --- | --- | --- | --- |
| 103-104 | Inline database block, linked view | 🟡/🧭 | Database family (view config) — not editor-slot; no live work item claims them |
| 105, 108 | Page/person mention | 🟡 | **B18 live** (scoping); `:108` notifications half unowned |
| 106, 109-110 | Block reference, synced/reference content, unlinked mention | 🧭 | Unowned |

### 2.6 Block editing operations (lines 118-132)

| Line | Row | Glyph | Disposition |
| --- | --- | --- | --- |
| 118 | Drag to another page | 🧭 | Unowned |
| 130 | Multi-block selection | 🟡 | **B18 owns the select-all subset; R84.10-R84.12 own the range edges** |
| 131-132 | Copy block link, Copy as Markdown | 🧭 | Unowned (row 131's `#block-<pos>` anchor is pos-based — see O84.2) |

### 2.7 Authoring pickers & page appearance (lines 143-161)

| Line | Row | Glyph | Disposition |
| --- | --- | --- | --- |
| 143-145 | Page icon (image), page cover, cover reposition | 🟡/🧭 | Unowned |
| 146 | Callout icon picker | 🧭 | **Stale — ships today**: in-block icon picker at `src/components/editor/extensions/custom-blocks.tsx:104-116` (`aria-label="Change callout icon"`). Glyph left for a manual re-baseline; evidence note appended to the matrix Notes cell |
| 153-154 | Sub-pages section, full-width toggle | 🟡 | Unowned |
| 155 | Small text | 🧭 | **Stale — ships today**: `src/app/w/[slug]/[pageId]/page.tsx:115,130` + `src/components/page-title.tsx:87,270-273` (topbar toggle `src/components/topbar/actions-menu.tsx:468`). Glyph left for re-baseline; note appended |
| 156-157 | Page fonts, line spacing | 🧭 | Unowned |
| 158 | Page locking | 🧭 | **Stale — ships today**: `Page.locked` enforced at render (`page.tsx:88`), toggle in the actions menu (`src/lib/actions-menu.ts:237-242` keeps it reachable when locked; `src/components/page-title.tsx:279-281`). The *server-side* enforcement gap is tracked as D6 in `docs/specs/realtime-collab.md` §2.3. Glyph left for re-baseline; note appended |
| 159-161 | Page description, page breadcrumb header, favorite page | 🧭/🟡 | Unowned / partial (favorites has `e2e/favorites-parity.spec.ts`; verify with its owner before claiming) |

**Audit verdict:** of the 61 non-✅ rows in section 1, other work covers 13
(B18: 5, B20: 7, B96: 1), this spec covers 7 (rows 62, 64, 65, 85, 86, 89,
130 — with the shared halves above), 3 are stale-but-shipping, 2 are ⛔ by
design, and **36 remain unowned backlog** (columns resize, math UX, synced
blocks, breadcrumb deep-tree, page appearance, copy-as-markdown, …). Those 36
are listed above precisely so the maintainers can schedule them instead of
assuming §1 is otherwise covered.

## 3. Current state (evidence)

### 3.1 Columns

- The `columns`/`column` nodes are plain structural TipTap nodes with no node
  view (`src/components/editor/extensions/custom-blocks.tsx:211-259`),
  registered in `src/components/editor/page-editor.tsx:245-246`.
- The **only** insertion path is the slash entry that always creates exactly
  two columns: `src/components/editor/slash-menu.tsx:66` →
  `setColumns(2)`. `setColumns(count)` clamps to `Math.max(2, Math.min(count, 4))`
  (`custom-blocks.tsx:240`) — so **5 columns are impossible today** even though
  the matrix row is labelled "2/3/4/5" (`FEATURE_MATRIX.md:62`).
- There is **no add/remove/distribute UI anywhere**: no hover controls on the
  container, no context-menu entries (the block context menu only resolves a
  single block, `src/components/editor/block-context-menu.tsx:110-121`), no
  slash variants for 3/4 columns.
- Rendering is CSS-only: flex container + equal columns
  (`src/app/globals.css:613-624`). Export/read paths already round-trip the
  node (`src/lib/serialize.ts:283-284`, `src/components/doc-renderer.tsx:198-208`,
  `src/lib/paste.ts:373`, walk in `src/lib/blocks.ts:142`) — the add/remove UI
  must not change that markup contract.

### 3.2 Simple table + header styling

- `TableKit.configure({ table: { resizable: true } })` is the whole table
  config (`page-editor.tsx:236`); the slash menu inserts a 3×3 table **with**
  a header row (`src/components/editor/slash-menu.tsx:69`).
- TipTap ships the row/column/header commands, but **nothing binds them**:
  a `src/` grep for `addColumnBefore|deleteColumn|addRowBefore|toggleHeader|mergeOrSplit|deleteTable`
  matches only the slash insert and unrelated database-row code. The bubble
  toolbar has zero table controls (`src/components/editor/bubble-toolbar.tsx`,
  grep for table/row/column: no matches), and the block context menu has none
  either. The matrix's "Toggle exists in logic" (`FEATURE_MATRIX.md:65`)
  means *library* logic, not product UI.
- Styling: header cells get `background: var(--surface); font-weight: 600;
  text-align: left` in the editor (`src/app/globals.css:647-651`), a separate
  rule for the read-only renderer (`globals.css:1093`), cell selection tint
  (`globals.css:652-658`) and the column-resize handle (`globals.css:659+`).
  `doc-renderer.tsx` emits `<th>` with **no `scope` attribute**
  (`src/components/doc-renderer.tsx:218-219`) — a real a11y gap.

### 3.3 Video/audio provider parity

- There is **no video or audio block**: `src/` contains no `<video>`/`<audio>`
  element and no `video`/`audio` node definition (grep across `src/**/*.{ts,tsx}`).
  The upload entry point accepts `image/*,.pdf,.txt,.md,.json,.zip` only
  (`page-editor.tsx:476`), and `isImage` is the only type branch
  (`src/lib/upload-client.ts:76-77`). Notion-style import degrades
  `video`/`file`/`pdf` blocks to a **link paragraph**
  (`src/lib/notion-api.ts:177-195`).
- Therefore the matrix claims "Local file playback" for Video/Audio
  (`FEATURE_MATRIX.md:85-86`) and "Local playback" in section 15
  (`:552-553`) are **not backed by the code today**. Glyphs untouched; the
  appended Notes carry the evidence, and R84.7 specifies what must actually
  ship before those rows can flip.
- Provider embeds *do* exist: `detectEmbed` normalises YouTube (watch/share/
  shorts/live/embed/nocookie) and Vimeo (`src/lib/embeds.ts:159-217`) into
  player URLs, with unit coverage (`src/lib/embeds.test.ts:42-147`) and a
  live e2e (`e2e/media-parity.spec.ts:149`). The embed node renders whichever
  URL `detectEmbed` returns (`src/components/editor/extensions/bookmark.tsx:194-253`).
- The **UI over-promises**: the embed field placeholder says "Paste a YouTube,
  Vimeo, Loom, Figma… URL" (`bookmark.tsx:218`) and the slash entry says
  "YouTube, Vimeo, Figma…" (`src/components/editor/slash-menu.tsx:72`), while
  `EMBED_HOST_ALLOWLIST` accepts only youtube.com hosts + vimeo.com
  (`src/lib/embeds.ts:67-85`).

### 3.4 Multi-block selection edges

- **No project code implements block-range selection.** A grep for `shiftKey`
  under `src/components/editor/**` returns only the Enter-vs-Shift+Enter guards
  in `equation-editor.tsx:108`; there is no range-selection plugin, no range
  highlight, no `selectAll` wiring in components. What "works" today is
  prosemirror-view's default shift-click extension plus the built-in
  `selectAll` command — reachable in the app only via the test hook
  (`e2e/noema.spec.ts:1610-1626` sets `editor.commands.selectAll()`).
- Every block action resolves **exactly one** block: the context menu derives a
  single position from the DOM event (`block-context-menu.tsx:110-121`) and
  duplicate/delete act on that node (`:196-202`, `:214-216`). The delete-undo
  snapshot helper takes a single `pos` (`src/lib/blocks.ts:176`, `:213`) — a
  range variant does not exist.
- Range *copy* already works and is e2e-proven (partial selection copy with
  open depths, `e2e/noema.spec.ts:1627-1655`), so the gap is selection chrome +
  range *actions*, not the clipboard.

### 3.5 Embed allowlist UI

- The allowlist is code, and it is central: `EMBED_HOST_ALLOWLIST` +
  `isEmbedHostAllowed` gate every iframe decision — embed node view
  (`bookmark.tsx:197,206`), read-only renderer (`src/components/doc-renderer.tsx:260-269`),
  link preview (`src/app/api/link-preview/route.ts:10`), and it feeds the
  feed guard (`src/lib/feed-guard.ts:21`). Negative cases are unit-tested
  (`embeds.test.ts:134-140`: `evil.example.com`, `localhost`, `""` all false).
- The browser-side bound is a **static** CSP `frame-src` that mirrors the same
  hosts (`next.config.ts:60-83` — youtube.com + player.vimeo.com) and is
  baked at build time. Consequence: **no UI can add a provider host**; UI can
  only narrow within the deployed set.
- There is **no UI surface at all**: workspace settings has only General,
  Members, Activity, Export and Danger-zone sections
  (`src/app/w/[slug]/settings/page.tsx:185-273`), and `Workspace` has no
  settings JSON column to hang a config on (`prisma/schema.prisma:120-150`;
  the precedent for per-workspace config is the 1:1 `AiProviderConfig` /
  `EmailConfig` models at `:137-138`).

## 4. Requirements (numbered, testable)

### Columns — add/remove UI

- **R84.1** — A columns container exposes **add/remove controls**: focusing or
  hovering the container shows a small toolbar (or context-menu group) with
  "Add column" (disabled at the container's max) and, per column, "Add column
  right" and "Remove column". The slash menu gains explicit `Columns · 2`,
  `Columns · 3`, `Columns · 4` entries. The maximum is **4** columns, matching
  the existing clamp (`custom-blocks.tsx:240`) — raising it to 5 is a separate
  decision (O84.1) because it changes the matrix row label.
- **R84.2** — Removal semantics: removing a column deletes that column's
  blocks (with the standard undo affordance — history undo when history is
  enabled, and the delete-restore toast path when it is not, mirroring
  `block-context-menu.tsx:214-232`); when removal would leave a single column,
  the `columns` wrapper is **unwrapped** and its content spliced in at the
  container's position so no one-column wrapper survives; the container never
  drops below 2 columns while wrapped.
- **R84.3** — Every control is keyboard-reachable with an `aria-label`
  (a11y gate `check:a11y` stays green), all strings go through `t()` without
  raising the i18n ratchet, and add/remove are plain ProseMirror transactions
  so they merge safely under collaboration. The document contract is
  unchanged: serialize (`serialize.ts:283-284`), read-only render
  (`doc-renderer.tsx:198-208`), paste mapping (`paste.ts:373`) and the walk
  (`blocks.ts:142`) keep passing their existing tests.

### Simple table — header styling & controls

- **R84.4** — When the selection is inside a table, an in-table toolbar (and
  matching context-menu entries) binds the currently-unbound TableKit
  commands: add/delete row above/below, add/delete column left/right, **toggle
  header row**, **toggle header column**, delete table. Slash-insert keeps
  working exactly as it does (`slash-menu.tsx:69`).
- **R84.5** — Header styling is a product state, not an accident of markup:
  header cells render distinctly (background `var(--surface)`, weight ≥600,
  emphasised bottom border) **identically** in the editor, the read-only
  renderer and public share views; toggling a header row/column changes only
  the cell type, never the cell content; `doc-renderer` emits
  `<th scope="col">`/`<th scope="row">` (fixes `doc-renderer.tsx:218-219`).
- **R84.6** — Table edges: toggling the header on an empty or 1×1 table is a
  no-op with feedback (no crash); a table nested inside a `column` node keeps
  all controls (R84.1's container UI must not swallow table clicks); copy/paste
  of header cells preserves `<th>` through the HTML paste path
  (`src/lib/paste.ts`); every table command is a single transaction (collab
  safe) and cell-selection (drag) keeps precedence over R84.10's block range
  while the selection is inside one table.

### Video/audio provider parity

- **R84.7** — Local media actually plays: new `video`/`audio` blocks accept
  upload (accept list extended past `page-editor.tsx:476` through the existing
  `uploadFile`/Asset path, same 10 MB cap and auth as other uploads) and render
  native `<video controls>` / `<audio controls>` in **both** the editor node
  view and `doc-renderer`; a file the browser cannot play degrades to the
  existing file/link presentation instead of a dead player. Only after this
  lands may the Video/Audio rows (`FEATURE_MATRIX.md:85-86`, `:552-553`) flip.
- **R84.8** — Provider parity without lies: pasting a provider URL into the
  video/audio/embed block routes through `detectEmbed`
  (`embeds.ts:159-217`); every user-facing hint enumerates **exactly** the
  deployed `EMBED_HOST_ALLOWLIST` (fixes `bookmark.tsx:218` and
  `slash-menu.tsx:72` — no UI may advertise a host the allowlist rejects);
  an unsupported URL keeps the documented bookmark fallback
  (`bookmark.tsx:221-223`). Adding a provider is a three-part change —
  allowlist + `frame-src` (`next.config.ts:60-83`) + unit tests — never a
  UI-only edit.
- **R84.9** — Honest partials: video transcoding and the audio waveform stay
  **out of scope** for this spec (matrix rows `:86`, `:552-553` keep an honest
  note until someone scopes them); the provider list shown in the UI is
  generated from `embedMeta`/`EMBED_HOST_ALLOWLIST` so it can never drift from
  what actually embeds.

### Multi-block selection edges

- **R84.10** — Range selection: shift+click (and a keyboard equivalent,
  shift+arrow down/up) extends a selection across top-level blocks with a
  visible range highlight; a range that crosses `column` wrappers, atoms
  (embed/image/TOC) or a table boundary resolves to **whole top-level blocks**
  (partial nodes are never half-selected); today none of this exists in project
  code (`grep shiftKey` in `src/components/editor/**` → only
  `equation-editor.tsx:108`).
- **R84.11** — Range actions: with >1 top-level block selected, the context
  menu and drag handle act on the **whole range** — delete (with a
  range-aware `snapshotBlockDeletion` variant returning an array, extending
  `blocks.ts:176-213`), duplicate, move up/down, copy — instead of silently
  acting on the single block under the cursor (`block-context-menu.tsx:110-121`).
- **R84.12** — Selection edges & exclusions: select-all staging (block text →
  block → document) is **explicitly excluded** — it belongs to B18, and this
  spec's implementation must not collide with it; the existing
  range-copy e2e (`e2e/noema.spec.ts:1610-1655`) must stay green; inside a
  table, cell range (R84.6) beats block range; under collaboration a range
  delete is an ordinary transaction (no special path); a mouse-free path to
  build a range exists (shift+arrow) for the a11y gate.

### Embed allowlist UI

- **R84.13** — Truthful insertion UX: the embed flow lists the deploy's
  providers (label + aspect ratio from `embedMeta`, `embeds.ts:110-120`) as
  selectable chips, the placeholder/hints are generated from that same list,
  and an unsupported paste shows an inline message naming the allowed hosts
  before falling back to a bookmark card.
- **R84.14** — Settings surface: workspace settings gains an **Embeds**
  section (admin-gated like Members, `settings/page.tsx:185-273` pattern) that
  shows the active providers and, as milestone 2, per-workspace *disable*
  toggles persisted in a new 1:1 `EmbedConfig` model (schema precedent:
  `AiProviderConfig`/`EmailConfig`, `prisma/schema.prisma:137-138` — schema
  change ⇒ Tier HEAVY when built). Toggles may only **narrow** the deployed
  set; the section states plainly that new hosts require a redeploy, because
  `frame-src` is build-time (`next.config.ts:60-83`). New strings via `t()`.
- **R84.15** — Single source of truth: `isEmbedHostAllowed` remains the only
  gate that decides whether an iframe may render, in the editor, the
  read-only renderer and link preview (`bookmark.tsx:206`,
  `doc-renderer.tsx:260-269`, `link-preview/route.ts`); workspace toggles are
  evaluated *against* it, never instead of it, and the negative unit cases
  (`embeds.test.ts:134-140`) stay green.

### Table of contents — scroll-spy (spec detail only)

- **R84.16** — TOC behaviour, **implemented and tested by B96** (see §5):
  the outline highlights the heading currently in view, marks it
  `aria-current="true"`, smooth-scrolls on click with `scroll-margin` so the
  sticky header never covers the target, refreshes on document update (the
  `editor.on("update")` subscription already exists,
  `custom-blocks.tsx:307-314`), and keeps the empty state
  (`custom-blocks.tsx:319-320`).

## 5. TOC scroll-spy — spec detail + B96 handoff

Current behaviour: `TocView` collects headings on every update and jump-to on
click (`src/components/editor/extensions/custom-blocks.tsx:290-345`) — there
is **no active-heading state, no scroll-spy, no `aria-current`**, and no
`tableOfContents` case exists in `doc-renderer.tsx` (grep: no match), so
read-only/share views drop the outline entirely.

Spec detail for B96:

1. Active heading = the last heading whose top edge is above the viewport
   midpoint; recalculate on scroll (rAF-throttled `IntersectionObserver`
   preferred) and on doc update; only one item is active at a time.
2. Active item: `aria-current="true"`, accent-coloured left indicator, bold
   label; inactive items keep default styling; state resets when the outline
   scrolls out of view.
3. Click/Enter: `preventDefault` + smooth scroll to the heading with
   `scroll-margin-top` sized to the sticky header, focus moves to the heading
   (keyboard users must land where they clicked).
4. Deep links must be **id-based**, not position-based: the existing
   `#block-<pos>` anchor (`block-context-menu.tsx:238`) breaks on every edit —
   this ties TOC anchors to the stable-block-ids row
   (`FEATURE_MATRIX.md:634`, `docs/specs/engineering-hardening.md`). Until ids
   land, B96 may use heading index + text hash, documented as provisional.
5. Ownership hazard (why this section exists): the TOC view lives **inside**
   `src/components/editor/extensions/custom-blocks.tsx`, while B96
   marks `editor/**` off-limits (it belongs to the editor slot). See O84.3 for
   the recommended resolution — do not edit `custom-blocks.tsx` from B96
   without the hand-off below.

## 6. Test plan

**Unit (vitest, red-first, pure lib — the sandboxing rule)**

1. *Column ops* — new `src/lib/columns.ts`: add/remove/unwrap decisions on a
   fixture doc (clamp at 4, unwrap at 1, content preserved, positions valid)
   [R84.1, R84.2].
2. *Table command plan* — pure builder mapping "table toolbar button" →
   command chain + enabled/disabled state (header toggle on 1×1 no-op)
   [R84.4, R84.6].
3. *Provider hints* — a test asserting the hint/chip list equals
   `EMBED_HOST_ALLOWLIST` projections, so R84.8/R84.9 cannot drift (extend
   `src/lib/embeds.test.ts`) [R84.8, R84.9].
4. *Media accept/gating* — upload type gating for `video/*`, `audio/*` and the
   browser-unsupported fallback decision [R84.7].
5. *Range resolution* — new `src/lib/selection-range.ts`: shift-range → array
   of whole top-level positions across columns/atoms/tables; range-aware
   `snapshotBlockDeletion` round-trip [R84.10, R84.11].
6. *EmbedConfig* — toggle evaluation always intersects the static allowlist
   (never widens it) [R84.14, R84.15].

**e2e (Playwright, own file `e2e/editor-deep.spec.ts` — never
`e2e/noema.spec.ts`, which is editor-slot owned)**

7. Columns: slash-insert 3 columns → add a 4th → remove one → reload persists;
   remove down to 2 → remove again unwraps with content intact [R84.1-R84.3].
8. Table: insert table → toggle header row off/on → style + `scope` present in
   read-only render; add/delete row & column [R84.4, R84.5].
9. Selection: build a 3-block range (shift+click, then shift+arrow), duplicate
   and delete the range, undo restores it; existing clipboard range-copy test
   still green [R84.10-R84.12].
10. Embed UI: unsupported host shows the named-provider message; chip list
    matches the allowlist [R84.13].

**Gates** (tier): implementation here is **STANDARD**
(tsc + eslint + full unit + coherence + targeted e2e against dev `:3201`);
the `EmbedConfig` schema slice is **Tier HEAVY**. This change (B84, docs-only)
owes FAST: tsc + eslint + coherence. `check:a11y` must stay green for R84.1,
R84.5, R84.10, R84.16.

## 7. Delivery plan (milestones → tasks ↔ requirements)

> Test-first rule: every task's acceptance is a
> red test citing its requirement IDs before implementation. Editor-slot work
> is sequential — one `page-editor.tsx` change at a time.

**M1 — Layout & table UI (editor slot, ~2-3 h slices)**

- T84.1 [R84.1, R84.3] Columns toolbar + slash variants. Red: unit 1, e2e 7.
- T84.2 [R84.2] Remove/unwrap semantics + undo pairing. Red: unit 1, e2e 7.
- T84.3 [R84.4-R84.6] Table toolbar (row/column/header/delete) + header
  styling + `scope`. Red: unit 2, e2e 8.

**M2 — Selection edges (editor slot, after M1)**

- T84.4 [R84.10] Range selection plugin + highlight + keyboard path. Red: unit 5, e2e 9.
- T84.5 [R84.11, R84.12] Range actions in context menu/handle + range delete
  snapshot. Red: unit 5, e2e 9; regression: `e2e/noema.spec.ts` copy suite.

**M3 — Media & embeds (after B20 lands; embed config slice is Tier HEAVY)**

- T84.6 [R84.7] `video`/`audio` nodes + upload gating + doc-renderer parity.
  Red: unit 4, e2e (extend `e2e/media-parity.spec.ts`-style assertions in the
  own file).
- T84.7 [R84.8, R84.9, R84.13] Truthful provider UI (chips, hints, messages).
  Red: unit 3, e2e 10.
- T84.8 [R84.14, R84.15] Embeds settings section + `EmbedConfig` (Tier HEAVY:
  `prisma db push` + build + prod e2e). Red: unit 6.

**Hand-offs (no implementation here)**

- T84.9 [R84.16] TOC scroll-spy — **owned by B96**; blocked on O84.3
  resolution (extraction or scoped exception).

**Exit criteria per milestone:** tsc 0, eslint 0 errors, unit green with cited
IDs, targeted e2e green on dev `:3201`, `check:a11y` green, coherence
COHERENT, matrix glyph flipped **only** by the maintainers (Notes already
carry the spec path — do not re-append), evidence recorded in the pull request.

## 8. Risks & open questions (honest)

**Risks**

1. **Editor-slot contention (highest).** T84.1-T84.5 all touch
   `page-editor.tsx`/`block-context-menu.tsx`, which serialises work
   to one change at a time, and B18/B20 are moving underneath this spec right
   now. Mitigation: re-audit §3 citations at execution start; if the cited
   lines moved, fix the spec before coding, never after.
2. **Spec/code drift on media rows.** The matrix says "local playback" while
   `src/` has no player (§3.3). Mitigation: R84.7 makes the flip conditional;
   the appended Notes record the evidence so nobody flips those glyphs early.
3. **CSP surprise.** Any attempt to "just add" Loom/Figma from the UI will
   silently fail against `frame-src`. Mitigation: R84.8/R84.14 make the
   redeploy requirement explicit and unit-tested (hint list == allowlist).
4. **Selection regressions.** Range selection touches the same
   `block-context-menu`/clipboard paths B18's select-all work touches.
   Mitigation: R84.12 excludes select-all staging, own e2e file, and the
   existing copy-range e2e as a tripwire.

**Open questions**

- **O84.1** — Max columns: keep 4 (matches `custom-blocks.tsx:240`) or go to
  5 (matches the row label `FEATURE_MATRIX.md:62`)? Spec assumes 4; changing
  the label is a maintainer edit.
- **O84.2** — Block anchors: `#block-<pos>` (`block-context-menu.tsx:238`) is
  unstable under editing; TOC deep links (§5.4) and "Copy block link" both
  need the stable-block-ids work (`FEATURE_MATRIX.md:634`). Coordinate with
  `docs/specs/engineering-hardening.md` rather than fixing twice.
- **O84.3** — B96's off-limits list excludes `editor/**`, but the TOC view
  lives at `custom-blocks.tsx:263-345`. Recommended: an editor-slot pre-task
  extracts `TocView` into a non-editor module (e.g.
  `src/components/table-of-contents.tsx`) so B96 can implement R84.16 without
  violating ownership; fallback is a written scoped exception naming exactly
  `TableOfContents`/`TocView`.
- **O84.4** — Per-workspace embed toggles need a schema model (Tier HEAVY cost
  for a narrow feature). Is read-only provider visibility (R84.14 M1) enough
  for parity, deferring `EmbedConfig` until a second customer asks?
- **O84.5** — Waveform/transcoding (rows `:86`, `:552-553`): stay honest
  partials per R84.9, or spawn a dedicated heavy change? Unassigned.
