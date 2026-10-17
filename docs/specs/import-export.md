# Spec — Import & export (round-trip, fidelity, jobs, scheduling)

> **Status: spec complete, implementation pending.** Document-only: no
> production code was changed. Every claim about the
> current code cites file + line. Requirement IDs (`R23.x`) are the
> traceability anchors: the delivery plan in §11 lists tasks 1:1 against them,
> and tests must cite the IDs they cover. Matrix edits for this change are
> Notes-only entries in `docs/FEATURE_MATRIX.md` §12 (glyphs untouched).

---

## 1. Problem statement

Noema already ships a working import/export surface: Markdown, `.zip`
(Markdown-archive), Word (`.docx`), Trello JSON, Notion API and ICS feed
imports on the way in; page Markdown/JSON/HTML/PDF, database CSV and
whole-workspace zip on the way out. But the round trip is not trustworthy:

- **CSV/JSON database import is ergonomically incomplete** — rows can be
  appended to an *existing* database only, columns that don't match a property
  name are dropped **silently**, and there is no "create a database from this
  file" path and no JSON-to-database import at all;
- **imports are all-or-nothing in the wrong way** — a mid-import failure
  leaves partially created page trees behind (no transaction, no rollback, no
  cancel), and Notion imports silently truncate at depth 4 while swallowing
  per-child errors;
- **there is no import progress UX** — every importer is a single server
  action with a disabled button and one toast;
- **HTML/PDF export fidelity is partial** — exported HTML hardcodes
  `lang="en"`, never sets `dir`, and renders inline math as `<code>`; PDF
  export strips every character outside Latin-1 (Arabic/CJK/emoji vanish),
  renders tables as `"a | b"` text lines and images as `"[image]"`;
- **whole-workspace export is on-demand only** — one fully-buffered zip per
  request, no attachments, no subpage toggle, no background job, no schedule,
  no rate limit.

FEATURE_MATRIX §12 records 20 planned rows against this surface. This spec
audits what actually exists, closes the gaps above with numbered,
testable requirements (`R23.1`–`R23.23`), and stages them over milestones
M1–M3.

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| Notion API import route | `src/app/api/import/notion/route.ts:9-35` | `POST`, rate-limited `rateLimit(request, "notion-import", 30, 60_000)` (`:10`), cookie auth (`:13`), JSON body parse (`:16-27`), delegates to `importNotionPageAction` (`:28`), maps action errors to 400 (`:33`). Node runtime (`:6`). |
| Notion import action | `src/server/actions/notion-import.ts:73-152` | Permission check via `getWorkspaceAccess` + `canEditContent` (`:79-83`); token required (`:85-86`); recursive `importOne` with **depth cap 4** (`:133`); per-child failures **swallowed** (`.catch(() => undefined)`, `:136`); outer catch returns an error **after pages were already created** (`:142-146`); `pages` count on success (`:148`). No transaction. |
| Notion import dialog | `src/components/notion-import-dialog.tsx:24-47, 86-90` | Two inputs (token, page URL/id) + `useTransition` `pending` flag; button label swaps to `importing` while pending; success toast with page count (`:33-38`); failure toast (`:44`). **No progress, no per-step status, no partial-failure report.** |
| Sidebar import surface | `src/components/sidebar/importers.tsx:26-283` | Buttons: Markdown (`.md,.markdown,.txt`, `:186-196`), Trello JSON (`:197-215`), zip export archive (`:216-234`), Word (`:235-253`), Notion API (`:254-261`), audio transcribe→Markdown (`:136-166, 262-280`). **No CSV/JSON → database entry.** Every handler is one `FileReader`/`FormData` + server action + toast. |
| Markdown import action | `src/server/actions/import.ts:265-305` | `importMarkdownAction` → `markdownToDoc` (`import.ts:8`, impl `src/lib/serialize.ts:44`); title = filename stem (`:290-292`); one `Page` row per file. |
| Markdown parsers (two) | `src/lib/markdown.ts:278` (`parseMarkdown`), `:645` (`markdownToTipTap`) vs `src/lib/serialize.ts:44` (`markdownToDoc`) | Import paths use `serialize.markdownToDoc`; chat/ask-ai use `markdown.ts` (`src/server/actions/chat.ts:236-239`, `src/components/editor/extensions/ask-ai.tsx:13,134`). Two independent Markdown→blocks conversions must be kept in sync by hand. |
| Frontmatter | `grep frontmatter src/lib/markdown.ts src/lib/serialize.ts` → **0 hits** | No YAML frontmatter handling anywhere; a `---` block imports as literal body content. Matrix's "frontmatter partial" (§12 row 1) is optimistic. |
| Zip import | `src/server/actions/import.ts:182-263` | `importZipAction`: `JSZip` load (`:200-201`), **only `*.md/*.markdown` entries** considered (`:204-205`), path segments become nested pages (`pathToTitles`, `src/lib/importers.ts:53`), leaf content via `markdownToDoc` (`:233`). Non-Markdown assets in the archive are dropped. No transaction; error after partial create leaves pages (`:259`). |
| Word import | `src/server/actions/import.ts:16-67` | `importDocxAction`: `mammoth.convertToMarkdown` → `markdownToDoc` → one page. Matrix §12 row 7 says "Planned; docx parser needed" — **the code exists**; glyph is stale (maintainer regen owns it). |
| Trello import | `src/server/actions/import.ts:70-180` | `importTrelloAction`: JSON parse + `parseTrelloBoard` (`src/lib/importers.ts:19`), creates a `DATABASE` page, `Name` + `List` properties, Table+Board views, then a row per card (`:150-180`). Sequential creates, **no transaction**. |
| CSV import (append) | `src/server/actions/database.ts:591-665` | `importCsvAction(databasePageId, csv)`: `csvToMatrix` (`src/lib/serialize.ts:173-213`, handles BOM `:178`, quotes, CRLF), header matched **case-insensitively by property name** (`:610`), unmatched column → `columns[i] = null` → skipped at `:642`; unparseable cell skipped at `:646-647`. Result reports only `{ created }`. The only `prisma.$transaction` in `database.ts` is `:166` (create-database path) — **the CSV row loop is not transactional**. |
| CSV import UI | `src/components/database/database-view.tsx:819-866` | Toolbar: export `<a href=/api/export/database/...>` (`:820`), import button (label `importCsv`, `src/lib/i18n.ts:508`) → hidden `.csv` file input → `importCsvAction(databasePageId, text)` (`:848`) → "imported N rows" toast. **No mapping/preview step**, no skip-column report. |
| ICS import | `src/lib/ics.ts:87` (`parseIcsEvents`), `:152` (`isAllowedFeedUrl`), `:162` (`normalizeFeedUrl`); used by `src/server/actions/calendar.ts:8,16-44,91-111` | Feed-**subscription** import only: URL allow-list (`calendar.ts:28`), server fetch (`:32`, refresh `:106`), hard **500-event cap** (`:44`, `:111`). No `.ics` **file** upload import; lives in the calendar domain, not the importer surface. |
| Page export | `src/app/api/export/page/[pageId]/route.ts:11-70` | `?format=` read at `:28`; `json` (`:32-45`), `html` (`:46-53`, `pageToHtml`), `pdf` (`:55-62`, `docToPdf`), **default/fallback Markdown** (`:63-69`) — an unknown format silently exports Markdown, never 400. Auth `getCurrentUser` (`:15`) + `getWorkspaceAccess` (`:25-27`). **No `rateLimit`.** |
| Page export UI | `src/components/topbar/actions-menu.tsx:54-59, 284-304` | `EXPORTS = md / json / html / pdf`; submenu builds `/api/export/page/<id>?format=…` anchors (`:292,295`). |
| Database export | `src/app/api/export/database/[pageId]/route.ts:11-61` | CSV only: property names as header (`:41-42`), `formatCell` values (`:43-52`), `matrixToCsv` response (`:55-59`). No JSON format, no rate limit. |
| Workspace export | `src/app/api/export/workspace/[slug]/route.ts:19-108` | Auth (`:23-30`), **loads every page in one query** (`:32-36`), ancestry path with 50-ancestor guard (`:39-51`), databases → CSV (`:64-90`), pages → Markdown (`:92`), `README.md` (`:96-99`), **fully buffered zip in memory** (`:101`). No attachments/assets, no format choice, no subpage toggle, no rate limit, no job/schedule. Linked from settings (`src/app/w/[slug]/settings/page.tsx:229`) and workspace switcher (`src/components/sidebar/workspace-switcher.tsx:83`). |
| HTML renderer | `src/lib/serialize.ts:251-307` (`blockHtml`), `:223-249` (`inlineHtml`), `:310-345` (`docToHtml`/`pageToHtml`) | Broad coverage (lists, tasks, tables `:287-294`, callouts, toggles, columns, block math `:295-296`, bookmark/embed `:297-303`) with readable `default:` fallback (`:304-305`). Gaps: inline math → `<code>` (`:230-232`), `pageToHtml` hardcodes `lang="en"` (`:319`) and sets **no `dir`**, no asset embedding (image `src` points back at the origin), `pageEmbed` degrades to italic text (`:302-303`). |
| PDF renderer | `src/lib/pdf.ts:5-8, 84-93` | `clean()` strips **everything outside `\u0000-\u00ff`** (`:5-8`) — Arabic/CJK/emoji are deleted from every text run; base-14 fonts only; tables render as cell text joined with `"   |   "` (`:84-89`); images render the literal string `"[image]"` (`:92-93`); callouts/headings are plain text (`:40-82`). |
| Backup (ops, adjacent) | `scripts/backup.mjs`, `package.json:32` | Manual `npm run backup` → `pg_dump` custom dump, `--keep` retention default 5 (`:24`), restorability check for 5 tables (`:88-94`), retention sweep (`:104-110`). **Database dump only — not a content export, and not scheduled.** |
| Verification | `scripts/check-export.mjs:1-60` | Smoke-fetches md/json/csv/html/zip/pdf and reports status + content-type (+ `%PDF` magic, byte counts). **Asserts reachability, not fidelity.** |
| Scheduling + mail building blocks | `src/app/api/cron/templates/route.ts:12-30`, `src/lib/mailer.ts` | A `CRON_SECRET`-guarded cron endpoint pattern already exists (fail-closed 503 when unset, `x-cron-secret` check, `rateLimit(… "cron" 12, 60_000)`), and a mailer exists — scheduled exports can reuse both instead of inventing infrastructure. |

### 2.2 What the product class (Notion) does

1. **Create a database from CSV/JSON** with a header→property mapping step,
   type inference, and a preview before commit.
2. **Per-import progress** with page counts, warnings, cancel, and a
   failure report that either rolled everything back or told you exactly
   what survived.
3. **Faithful HTML/PDF export** — visual fidelity to the page, embedded
   assets, correct document language/direction, real tables and images.
4. **Export options**: include/exclude subpages, include or omit
   attachments, and — for admins — scheduled recurring workspace exports.

### 2.3 Defects in the current path (must be fixed by this feature)

- **D23.1 — silent CSV column loss.** Header cells that match no property
  (`database.ts:610,642`) and cells that fail coercion (`:646-647`) are
  dropped without a word; the toast only says "imported N rows".
- **D23.2 — no rollback anywhere on the import path.** Neither
  `src/server/actions/import.ts` nor `notion-import.ts` contains a
  `prisma.$transaction`; a failure mid-way (Notion `:142-146`, zip `:259`,
  Trello loop `:150-180`) leaves a half-imported tree the user must find and
  delete by hand.
- **D23.3 — silent Notion truncation.** Depth cap 4 (`notion-import.ts:133`)
  and swallowed child errors (`:136`) mean a deep or partially-failing import
  reports success while missing subtrees, with no warning surface.
- **D23.4 — no import jobs or progress.** `ImportResult` is
  `{ok,id,slug} | {error}` (`import.ts:13`); the only feedback is a
  `pending` boolean (`notion-import-dialog.tsx:26,86-90`) and toasts. No
  counts, no history, no cancel, nothing survives navigation.
- **D23.5 — two Markdown import pipelines, zero frontmatter handling.**
  `serialize.markdownToDoc` (imports) vs `markdown.ts` (chat/paste/ask-ai)
  drift by construction; `---` frontmatter lands in the document body.
- **D23.6 — HTML/PDF fidelity gaps** (`serialize.ts:230-232,319`;
  `pdf.ts:5-8,84-93`) — direction/language, math, assets, Unicode text,
  tables, images (§2.1 rows).
- **D23.7 — export routes are unthrottled and memory-unbounded.** All three
  export routes check access but call no `rateLimit` (contrast
  `import/notion/route.ts:10`); the workspace zip buffers every page and the
  whole archive in one response (`workspace/route.ts:32-36,101`).
- **D23.8 — no scheduled or background export.** Exports only happen when a
  human clicks; `backup.mjs` covers the database, not content; there is no
  recurring snapshot story.

## 3. Decision

| Question | Options | Verdict |
| --- | --- | --- |
| Import job execution | (a) DB-backed `ImportJob` rows updated by the running server action/route, polled by the client; (b) external queue/worker (BullMQ etc.). | **(a)** — self-hosted single-node deploy (the cron pattern in `api/cron/templates` shows the house style); no new service dependency. Jobs are observable and resumable-by-repair (R23.9). |
| HTML/PDF fidelity engine | (a) improve the existing server-side renderers (`serialize.blockHtml`, `pdfkit`); (b) headless-browser print pipeline (Puppeteer/Playwright). | **(a) now** — (b) adds a heavyweight runtime dep and is a Tier-MAX-only concern; the coherence gate's `dangerouslySetInnerHTML` allow-list also means exported HTML must stay escaped static markup (KaTeX source fallback, no server-side HTML injection). Revisit (b) only if pixel parity becomes a requirement (O23.5). |
| Scheduling | (a) `POST /api/cron/exports` guarded by `CRON_SECRET` + `rateLimit`, mirroring `api/cron/templates/route.ts:12-30`; (b) in-process `setInterval`. | **(a)** — same fail-closed, externally-scheduled pattern the product already documents for recurring templates; works on any deploy with a cron/Tasks Scheduler. |
| CSV/JSON import shape | (a) one shared "matrix → properties → rows" core reused by append-import and create-import; (b) two separate code paths. | **(a)** — `csvToMatrix`/`formatCell`/`coerceCsvValue` already exist; one core is what makes the round-trip invariant (R23.5) testable. |

## 4. Requirements (numbered, testable)

### Database import (CSV / JSON)

- **R23.1** — Appending a CSV to an existing database goes through a
  **mapping step**: a preview table shows CSV columns pre-matched
  case-insensitively to properties (as today, `database.ts:610`), each
  unmatched column is explicitly selectable as *skip* or *create new
  property*, and the confirmation reports `created N rows · skipped
  columns […] · created properties […]`.
  *Accept:* a fixture whose headers match no property cannot complete
  without every column being accounted for; the completion toast/result
  lists skipped columns by name (unit + e2e asserting the summary string).
- **R23.2** — A new **"Import CSV (create database)"** entry in the sidebar
  importer section creates a `DATABASE` page from a file: first column →
  primary `TEXT` property (titles), then per-column type inference —
  `NUMBER` when ≥90% of non-empty values coerce like `coerceCsvValue`'s
  number branch (`database.ts:419`), `SELECT` when distinct values ≤ 25 and
  they fit the status-option shape, `DATE` on ISO-parseable values,
  otherwise `TEXT` — then rows via the shared core from R23.1.
  *Accept:* unit test over a fixture CSV (mixed number/select/date/text
  columns) yields the expected `Property` types and one row per data line;
  the new database renders in the workspace tree.
- **R23.3** — **JSON import for databases**: accepts a JSON array of flat
  objects, and the `{"results": [...]}` envelope used by the Notion-class
  database export shape; keys become columns, values are coerced with the
  same inference as R23.2; a malformed element fails with an error citing
  its array index.
  *Accept:* unit tests for both envelopes + one bad-element case producing
  `row 3: …` in the error; import is rejected atomically (nothing created).
- **R23.4** — Input hardening for every file importer: BOM/CRLF/quotes
  (already handled by `csvToMatrix`, `serialize.ts:178-212`), duplicate
  header names rejected with a clear error, a **5 MB / 20 000-row cap** with
  an explicit "file too large" error, and empty/one-line files rejected
  (existing message `database.ts:597-599` generalized).
  *Accept:* over-cap and duplicate-header fixtures produce errors and leave
  the database byte-identical (hash compare before/after).
- **R23.5** — **Round-trip invariant**: `GET /api/export/database/:id`
  output fed into the R23.1/R23.2 importer on an empty copy of that database
  reproduces identical titles and property values for
  TEXT/NUMBER/SELECT/DATE/checkbox property types (the `formatCell`
  ⟷ `coerceCsvValue` pair must be inverse on their shared domain).
  *Accept:* property-based test generating matrices → export → import →
  export equals the first export byte-for-byte (modulo row order, which is
  positional).

### Import integrity & honesty

- **R23.6** — **Every multi-record import is atomic.** `importZipAction`,
  `importTrelloAction`, `importNotionPageAction`, the docx path and the new
  CSV/JSON imports either run inside one `prisma.$transaction` or register
  created ids and compensate (delete) on failure. After any failure the
  workspace contains exactly the rows it had before.
  *Accept:* fault-injection unit/integration tests (throw after N creates
  for each importer) leave `Page`/`PropertyValue`/`Property` counts
  unchanged — the regression test cites R23.6.
- **R23.7** — Notion import reports honestly: the depth cap is raised to
  **10** (named constant), child failures are **collected, not swallowed**
  (`notion-import.ts:136`), and the success result gains
  `warnings: string[]` + `truncatedAtDepth?: number`. The dialog surfaces
  "Imported N pages · M warnings" instead of a bare success toast.
  *Accept:* fixture with one failing child returns `ok:true` and
  `warnings.length ≥ 1`; a depth-11 tree returns `truncatedAtDepth: 10`;
  the toast text contains the warning count (e2e).
- **R23.8** — **Frontmatter + single Markdown path.** A leading `---` YAML
  block is parsed: `title:` sets the page title, `icon:`/`tags:` map to
  page fields, remaining keys render as a leading info callout — never as
  literal `---` body content. The two converters converge: `serialize`'s
  `markdownToDoc` becomes a thin adapter over `lib/markdown.ts`'s
  AST (`parseMarkdown` → TipTap), with one shared golden corpus.
  *Accept:* unit tests for both entry points over one fixture corpus assert
  identical block trees; a frontmatter fixture imports with no `---`
  remaining in `page.content`.

### Import jobs & progress UX

- **R23.9** — Every importer creates an **`ImportJob` row** (§5) before
  writing content: `kind` (markdown/zip/docx/trello/notion/csv/json/ics),
  `status` QUEUED→RUNNING→DONE|FAILED|CANCELLED, `total` (when known),
  `processed`, `created`, `warnings`, `error`, timestamps. Progress updates
  land at least every 500 ms during a run.
  *Accept:* after any import the job row exists with `status=DONE`,
  `created` equal to rows written, and sensible `processed/total`.
- **R23.10** — The import dialog (and file pickers) switch from "disabled
  button" to a **progress surface**: determinate `processed/total` when the
  total is known (zip entries, CSV rows), indeterminate with a live
  `processed` counter otherwise; failure view shows the R23.6 rollback
  confirmation or, if the failure is pre-transaction, the error text.
  *Accept:* e2e importing a ≥50-file zip observes an intermediate progress
  string (poll DOM during the action), and a forced failure renders the
  rollback message (test hook or malformed fixture).
- **R23.11** — Jobs **survive navigation/refresh**: a "Recent imports"
  section (sidebar, per workspace) lists the last 10 jobs with status,
  counts and a link to the created root page on completion.
  *Accept:* navigating away mid-import and back shows the job still
  RUNNING/DONE with final counts (e2e: refresh between start and finish).
- **R23.12** — **Cancel**: a cancel button aborts a queued/running import at
  its next checkpoint; the partial work is removed per R23.6 and the job
  ends `CANCELLED`.
  *Accept:* cancel during a long Notion/zip import leaves zero created
  pages and the job reads `CANCELLED` (integration test).

### Export fidelity (HTML / PDF)

- **R23.13** — **HTML block completeness.** `blockHtml`
  (`serialize.ts:251-307`) covers every block type the editor can produce;
  any unknown node renders as `<div data-block-type="…">` wrapping its
  readable children (the current `default:` already does this — it becomes
  an explicit, tested contract). Inline/block math keeps its LaTeX source in
  `<span class="math-literal">` **plus** an optional KaTeX stylesheet+script
  reference for readers that have network, never `dangerouslySetInnerHTML`
  on the server (coherence gate rule: injection sinks are allow-listed).
  *Accept:* golden-file test: a fixture document containing all editor block
  types produces HTML containing a marker for each; the coherence gate's
  DSI allow-list is unchanged.
- **R23.14** — **Self-contained, correctly-languaged HTML.** `pageToHtml`
  sets `lang` and `dir="rtl"` from the exporting user's locale (Arabic ⇒
  `dir="rtl"`, mirroring the RTL check already in
  `scripts/check-export.mjs:44-48`), and images/files are embedded as data
  URIs when ≤ 1 MB per page total, otherwise emitted as sibling `assets/…`
  entries when the export is a zip (R23.17). Origin-authenticated
  `/api/files/...` URLs are never left dangling in a downloaded file.
  *Accept:* exporting an Arabic page yields `dir="rtl"` in the first 500
  bytes; an export containing an uploaded image renders it with the network
  offline (data URI assertion).
- **R23.15** — **PDF fidelity.** `docToPdf` embeds a bundled Unicode font
  subset (Noto Sans, shipped in-repo) instead of base-14-only, replacing
  `clean()`'s Latin-1 strip (`pdf.ts:5-8`) with a control-character filter
  so Arabic/CJK/emoji survive; tables render as real bordered tables
  (pdfkit table drawing, not `" | "` text, `pdf.ts:84-89`); images embed
  the actual `Asset` bytes (`pdf.ts:92-93` keeps the `[image]` text only as
  an alt fallback when the asset row is gone); heading scale and block
  colours are preserved from the editor styles.
  *Accept:* a fixture page with Arabic text, a 3×3 table and an image
  exports to a PDF whose extracted text contains the Arabic string, whose
  page contains a table drawing, and which has an embedded image XObject
  (assert via pdf-lib/pdf-parse in a unit test; cite R23.15).
- **R23.16** — **Explicit format contract.** `?format=` on the page export
  is validated against `{md,json,html,pdf}` — unknown values return **400**
  (`page/[pageId]/route.ts:28` currently falls through to Markdown at
  `:63-69`), and the database export gains `?format=json` (array of row
  objects keyed by property name, primary key first) beside the existing
  CSV default.
  *Accept:* `curl …?format=docx` → 400 with an error body listing valid
  formats; `?format=json` on a database returns
  `content-type: application/json` and parses to N objects.

### Bulk & scheduled export

- **R23.17** — **Attachments in the workspace zip**: every `Asset` file
  referenced by exported pages lands under `assets/<workspace>/…`, and
  Markdown image/file links are rewritten to relative `assets/…` paths;
  `README.md` documents the mapping (`workspace/route.ts:96-99`).
  *Accept:* uploading an image, exporting, and grepping the zip yields
  `assets/…` bytes plus a relative link in the page's `.md`.
- **R23.18** — **Subpage toggle**: `GET /api/export/page/:id?includeSubpages=1`
  returns a zip containing one `.md` per descendant (default stays the
  current single-file Markdown response, `:63-69`); the export submenu gains
  "Markdown (with subpages)" and "Markdown (this page only)" entries.
  *Accept:* a 3-level fixture exports 3 files with `includeSubpages=1` and
  1 without; DB children export as CSV inside the same zip (consistent with
  the workspace export's DB handling, `workspace/route.ts:64-90`).
- **R23.19** — **Large exports become `ExportJob`s.** When the workspace
  export would exceed **200 pages or ≈25 MB estimated**, the endpoint
  returns `202 { jobId }` instead of buffering (`workspace/route.ts:101`);
  the job writes the artifact to `backups/exports/<workspace>/<stamp>.zip`
  (retention sweep reusing the `--keep` idea from `backup.mjs:24,104-110`)
  and the UI shows progress + a download link when done.
  *Accept:* a 500-page fixture workspace export returns 202 with a job id,
  the job reaches DONE, and the artifact downloads; small workspaces still
  stream 200 inline (no behavior change below the threshold).
- **R23.20** — **Scheduled exports.** Workspace settings gain "Recurring
  export" (off by default; daily/weekly; zip of md+csv+assets, R23.17).
  Execution is `POST /api/cron/exports`, guarded exactly like
  `api/cron/templates/route.ts:15-30` (fail-closed 503 without
  `CRON_SECRET`, 401 on bad `x-cron-secret`, `rateLimit "cron-export" 12/60s`).
  On success the artifact is written and workspace owners receive a mail
  with a signed, expiring download link via `src/lib/mailer.ts`; without
  configured SMTP the settings page shows the artifact path instead.
  *Accept:* manual cron POST with the correct secret produces a dated
  artifact, advances `lastRunAt`, and the mailer is invoked (or logged);
  missing secret ⇒ 503, wrong secret ⇒ 401.
- **R23.21** — **Export access rules.** Workspace-archive export
  (`/api/export/workspace/:slug`) requires a **non-guest member role**;
  pages flagged "export restricted" (FEATURE_MATRIX §7 "Export-restricted
  pages") return 403 on page/database export and are excluded from the
  workspace zip entirely (content not present in any entry).
  *Accept:* guest session on `/api/export/workspace/:slug` → 403; a
  restricted page's marker string does not appear anywhere in the zip bytes
  (integration test).

### Rate limits & verification

- **R23.22** — All export routes use the existing `rateLimit` helper:
  page/database **30/min**, workspace **5/min** per user (same helper and
  style as `import/notion/route.ts:10`), returning 429 beyond that.
  *Accept:* 6 workspace export requests in one minute → 6th is 429; the
  import and export surfaces report their limits in the REST API
  reference.
- **R23.23** — **Verification asserts fidelity, not just reachability.**
  `scripts/check-export.mjs` is extended to assert: md contains the fixture
  marker heading; html contains `dir=` and one marker per block type
  (R23.13); pdf text extract contains the Unicode marker (R23.15); the csv
  round-trips (R23.5); the workspace zip contains `assets/` (R23.17) — and
  a new `scripts/check-import.mjs` covers the CSV mapping and rollback
  invariants (R23.1, R23.6) against the live dev server.
  *Accept:* deliberately breaking any invariant above turns the corresponding
  check red; both scripts stay green on the current tree when the features
  land.

### Non-goals (this spec)

- Importers for Asana / Evernote / Google Docs / Confluence / HTML files /
  PDF extraction (their own §12 rows; they plug into the job + integrity
  framework built here but are separate changes).
- Two-way calendar sync, `.ics` file upload (calendar domain owns feed
  imports; row "Google Calendar sync" is §13).
- Changing `scripts/backup.mjs` (database dumps stay an ops concern —
  §2.1 distinguishes them from content export).
- Export of database views' filters/sorts (CSV/JSON export = data, not view
  config), server-side HTML→PDF pixel parity via headless browser (O23.5),
  watermarking/DRM.

## 5. Data model

```prisma
model ImportJob {
  id          String   @id @default(cuid())
  workspaceId String
  userId      String
  kind        String   // markdown | zip | docx | trello | notion | csv | json | ics
  status      String   @default("QUEUED") // QUEUED | RUNNING | DONE | FAILED | CANCELLED
  total       Int?                           // null when unknown (streaming parse)
  processed   Int      @default(0)
  created     Int      @default(0)
  warnings    Json?                          // string[] — R23.7
  error       String?
  filename    String?                        // original upload name
  rootPageId  String?                        // link target on success
  createdAt   DateTime @default(now())
  finishedAt  DateTime?
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@index([workspaceId, createdAt])
}

model ExportJob {
  id          String   @id @default(cuid())
  workspaceId String
  userId      String
  kind        String   // workspace | page-subtree
  status      String   @default("QUEUED")
  pages       Int      @default(0)
  bytes       Int      @default(0)
  artifactPath String?                       // backups/exports/…  (R23.19)
  error       String?
  createdAt   DateTime @default(now())
  finishedAt  DateTime?
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@index([workspaceId, createdAt])
}

model WorkspaceExportSchedule {
  id          String   @id @default(cuid())
  workspaceId String   @unique
  enabled     Boolean  @default(false)
  frequency   String   @default("weekly")    // daily | weekly
  formats     Json     @default("[\"zip\"]") // zip | md | csv | html
  lastRunAt   DateTime?
  nextRunAt   DateTime?
  updatedById String?
  updatedAt   DateTime @updatedAt
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
}
```

- Jobs are **observability + rollback bookkeeping**, not a queue: the action
  that owns the import writes its progress into `ImportJob` as it goes
  (R23.9). Artifacts from `ExportJob` live beside `backups/` dumps and share
  the retention sweep (R23.19).

## 6. Contracts & surfaces

- **Job reads**: `GET /api/jobs/import/:id` and `GET /api/jobs/export/:id`
  → `{ status, total, processed, created, warnings, error, rootPageId }`,
  same-session authorization only (401/404 otherwise). The sidebar's
  "Recent imports" is a server component query, no client polling needed
  for the list; the open dialog polls its own job at 1 Hz (R23.10).
- **CSV/JSON import payload** (R23.1): the mapping step sends
  `{ databasePageId, rows: string[][], mapping: { column: number,
  propertyId?: string, createAs?: "TEXT"|"NUMBER"|"SELECT"|"DATE" }[] }`
  — the server never trusts header names blindly again; every column has an
  explicit decision (R23.1).
- **Cron**: `POST /api/cron/exports` with `x-cron-secret` (mirrors
  `api/cron/templates/route.ts:15-30`); it evaluates
  `WorkspaceExportSchedule.nextRunAt` and enqueues `ExportJob`s (R23.20).
- **Format parameter**: page export `?format=md|json|html|pdf` (400
  otherwise), database export `?format=csv|json` (R23.16), page export
  `?includeSubpages=0|1` (R23.18).
- **Errors**: every new failure mode returns a stable machine code
  (`FILE_TOO_LARGE`, `DUPLICATE_HEADERS`, `MAPPING_REQUIRED`,
  `EXPORT_RESTRICTED`, `FORMAT_UNKNOWN`) plus a human sentence, so i18n can
  key off codes (new strings go through `t()` per the B07/B08 anchor-line
  discipline — no i18n ratchet raise).

## 7. Import/export UI spec

- **Mapping dialog (CSV/JSON → existing database)**: table of
  `CSV column → property dropdown (or "skip" / "+ new property")`,
  pre-matched case-insensitively; first 5 data rows previewed with coerced
  values; footer "Import N rows" (primary) / Cancel; result toast reads the
  R23.1 summary. Reuses the `Dialog` pattern of
  `notion-import-dialog.tsx` and the `t()` locale prop.
- **Progress surface**: replaces the disabled-button state inside the same
  dialog — determinate bar when `total` is known, live
  `"Importing… 128 / 412"` counter otherwise, Cancel button (R23.10/12);
  terminal states switch to success summary (with warnings, R23.7) or
  failure + rollback note.
- **Recent imports**: collapsed section under the sidebar importer buttons;
  row = filename, kind icon, status glyph, counts; click → root page or job
  detail (R23.11). No new glyph set beyond the existing status vocabulary.
- **Export submenu** (`actions-menu.tsx:54-59`): existing four formats plus
  "Markdown (with subpages)"; workspace settings gain the recurring-export
  toggle (R23.20) with last-run/next-run text; large workspace exports show
  "Preparing export…" with a job link instead of a hanging download
  (R23.19).
- **a11y/i18n**: progress announced via `aria-live="polite"` region; all
  new strings through `t()` (must not raise the i18n ratchet).

## 8. Conflict & edge spec

| Edge | Behavior |
| --- | --- |
| CSV has 12 columns, DB has 4 properties | Mapping step forces a decision per column (R23.1) — never silent drops (closes D23.1). |
| Import fails at row 3 000 of 5 000 | Transaction/compensation removes rows 1-2 999 (R23.6); job = FAILED with rollback confirmation; workspace unchanged. |
| User cancels mid-Notion-import | Checkpoint cancel ⇒ compensation ⇒ zero rows, job CANCELLED (R23.12). |
| Notion tree deeper than 10 / a child 404s | Import succeeds with `truncatedAtDepth`/`warnings` shown in the toast (R23.7) — no more silent loss (D23.3). |
| Markdown file starts with `---` YAML | Parsed into title/icon/callout; body never contains `---` (R23.8). |
| Exported HTML opened offline | Data-URI or sibling-asset images render; no `/api/files` links left (R23.14/17). |
| Arabic page → PDF | Unicode font embedded; text extractable; nothing stripped (R23.15, fixes D23.6). |
| `?format=docx` | 400 + valid-format list (R23.16) — today silently yields Markdown. |
| 10 000-page workspace export | 202 + ExportJob + artifact path (R23.19); small workspaces unchanged. |
| Guest clicks "Export workspace" | 403 (R23.21). |
| Cron secret unset | Fail closed 503 (R23.20, same as templates cron). |
| Scheduled export while SMTP down | Job records the failure; settings page shows last error + artifact path fallback. |
| `check-export.mjs` run pre-M3 | Stays green — assertions are added **with** each requirement, not before (red-first applies per task in §11). |

## 9. Test plan

**Unit (vitest, red-first)**

1. *Mapping core* — header→property resolution incl. skip/create decisions;
   duplicate-header and oversize rejection (R23.1, R23.4).
2. *Type inference* — CSV and JSON fixtures → expected property types
   (R23.2, R23.3).
3. *Round-trip* — property-based: generated matrix → `matrixToCsv` →
   import → `formatCell` equals original (R23.5).
4. *Frontmatter + parser convergence* — shared corpus through
   `markdownToDoc` and `parseMarkdown` yields identical trees (R23.8).
5. *HTML golden file* — all block types present, `dir`/`lang` attributes,
   math fallback markup (R23.13, R23.14).
6. *PDF Unicode/table/image* — fixture export assertions (R23.15).
7. *Format validation* — unknown format → 400 path; database JSON shape
   (R23.16).

**Integration (node scripts / route-level)**

8. *Rollback matrix* — fault injection per importer, count invariance
   (R23.6).
9. *Job lifecycle* — created → RUNNING → DONE with counts; cancel ⇒ 0 rows
   (R23.9, R23.12).
10. *Cron export* — secret absent ⇒ 503, wrong ⇒ 401, correct ⇒ artifact +
    `lastRunAt` (R23.20).
11. *Access* — guest workspace export ⇒ 403; restricted page absent from zip
    (R23.21); rate-limit 429s (R23.22).

**e2e (Playwright, dev :3201, own `e2e/import-export.spec.ts`)**

12. Mapping dialog: import a fixture CSV with one unmapped column, assert the
    summary text (R23.1).
13. Progress surface visible during a ≥50-file zip import; refresh preserves
    the job row (R23.10, R23.11).
14. Export submenu downloads md + html and the html contains the fixture
    marker and `dir=` (R23.13, R23.14).
15. Non-regression: existing `check-export.mjs` and database e2e stay green.

**Feasibility**: units 1-7 are pure functions over existing helpers
(`csvToMatrix`, `formatCell`, `blockHtml`) — cheap and decisive; 8-11 run
against the dev DB like `check-export.mjs` does today; e2e 12-13 need only
one serial spec file with dedicated fixture pages (structural-test
cleanup discipline).

## 10. Migration path (M1–M3)

1. **M1 — Integrity & honesty first (~2-3 days).** R23.6 (atomic imports),
   R23.7 (Notion warnings/depth), R23.8 (frontmatter + single converter),
   R23.4 (input hardening). No schema yet: `warnings` rides the existing
   result objects; transactions use `prisma.$transaction`. This removes the
   data-loss class (D23.2, D23.3, D23.5) before any new surface grows on
   top of it.
2. **M2 — Database import + jobs/progress (~3-4 days).** `ImportJob`
   schema + job reads (R23.9), mapping step (R23.1), create-from-CSV (R23.2),
   JSON import (R23.3), round-trip test (R23.5), progress/cancel/recent UX
   (R23.10–R23.12). Closes D23.1 and D23.4.
3. **M3 — Export fidelity, bulk & schedule (~4-6 days, splittable).**
   - **M3a fidelity:** R23.13, R23.14, R23.15, R23.16, R23.22, R23.23
     (closes D23.6, D23.7).
   - **M3b bulk/schedule:** R23.17, R23.18, R23.19, R23.20, R23.21
     (closes D23.8). Needs `ExportJob` + `WorkspaceExportSchedule` schema
     (Tier HEAVY: `prisma db push` + build).

## 11. Delivery plan (milestones → tasks ↔ requirements)

> Test-first rule applies: every task's
> acceptance is a red test citing its requirement IDs before implementation.

**M1**

- T23.1 [R23.6]: transaction/compensation wrapper for all import actions.
  Red: integration 8.
- T23.2 [R23.7]: depth constant, warning collection, dialog summary. Red:
  unit + e2e toast assertion.
- T23.3 [R23.8]: frontmatter parser + `serialize.markdownToDoc` adapter +
  shared corpus. Red: unit 4.
- T23.4 [R23.4]: size/duplicate-header caps across importers. Red: unit 1.

**M2**

- T23.5 [R23.9]: `ImportJob` schema (`prisma db push`, Tier HEAVY) + progress
  writes. Red: integration 9.
- T23.6 [R23.1]: mapping UI + server contract. Red: unit 1 + e2e 12.
- T23.7 [R23.2,R23.3]: create-from-CSV/JSON path + inference. Red: unit 2.
- T23.8 [R23.5]: round-trip property test. Red: unit 3.
- T23.9 [R23.10,R23.11,R23.12]: progress surface, recent-imports list,
  cancel. Red: e2e 13.

**M3a**

- T23.10 [R23.13,R23.14]: HTML completeness + lang/dir/data-URI. Red:
  units 5 + e2e 14.
- T23.11 [R23.15]: PDF font/table/image. Red: unit 6.
- T23.12 [R23.16]: format validation + database JSON. Red: unit 7.
- T23.13 [R23.22,R23.23]: rate limits + `check-export` fidelity asserts +
  `check-import.mjs`. Red: script failures (10, 11).

**M3b**

- T23.14 [R23.17,R23.18]: assets in zip + subpage toggle. Red: integration
  round-trip on zip fixture.
- T23.15 [R23.19]: `ExportJob` schema + 202 path + artifact retention.
  Red: integration (500-page fixture).
- T23.16 [R23.20]: schedule model + `/api/cron/exports` + mailer. Red:
  integration 10.
- T23.17 [R23.21]: guest/restricted export rules. Red: integration 11.

## 12. Risks & open questions (honest)

**Risks**

1. **Transaction size (highest).** Wrapping a 5 000-row import in one
   transaction holds a long write lock on a shared Postgres. Mitigation:
   chunked creates inside one logical job with compensating deletes (still
   R23.6 semantics — end state = unchanged), tested with the fault matrix
   (unit 8); fall back to full transaction below 500 rows.
2. **Unicode font in PDF.** Bundling a Noto subset adds repo weight and
   pdfkit font embedding is fiddly; a broken embed silently degrades to
   today's behavior. Mitigation: unit 6 asserts extracted text, and M3a can
   ship html/lang fixes (R23.13/14) independently of R23.15.
3. **Parser convergence regressions (R23.8).** Making `serialize.markdownToDoc`
   delegate to `lib/markdown.ts` can change existing import output for
   exotic Markdown. Mitigation: golden corpus first, run existing
   `markdown.test.ts` + `serialize.test.ts` before switching.
4. **Job polling load.** 1 Hz dialog polling × several open tabs is
   negligible against the existing rate limits, but the job read endpoint
   must carry its own `rateLimit` (fold into R23.22's helper usage).
5. **Cron availability.** Self-hosters who never wire the cron get no
   scheduled exports — mitigated by the settings page stating the exact
   command and failing visibly (last-run never advances).

**Open questions**

- O23.1: Scheduled-export destination — email link only, or also a
  stable `GET /api/exports/latest/:slug` download for scripted pulls?
  Spec assumes both (R23.20), decide the retention window with it.
- O23.2: Should guests be able to export **pages** (read scope says yes
  today) while banned from workspace archives (R23.21), or ban all export
  for guests? Spec bans workspace archives only.
- O23.3: Font subset strategy for PDF — full Noto Sans vs Latin+Arabic
  subset, and acceptable bundle delta.
- O23.4: Should JSON database export/import adopt the Notion-class row
  envelope verbatim (making R23.3 the ingestion path for third-party
  exports), or our own shape first?
- O23.5: When (if ever) to move PDF export to a headless-browser print
  pipeline for pixel parity — revisit if R23.15's pdfkit fidelity is
  judged insufficient by stakeholders.
- O23.6: Job execution model — current spec runs imports inline in the
  request/action with progress writes; if a single import exceeds the
  platform's function timeout, we need a chunked continuation (checkpoint
  cursor on `ImportJob`). Decide at M2 based on measured zip-import
  durations.
