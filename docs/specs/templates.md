# Spec — Templates system (page, database, recurring)

> **Status: spec complete, implementation pending.** Batch **B31** of the parity
> loop (docs-only — no production code changed). Every claim about the current
> code cites file + line. Requirement IDs (`R31.x`) are the traceability
> anchors: §11 lists delivery tasks 1:1 against them, and tests must cite the
> IDs they cover. Matrix Notes for `FEATURE_MATRIX.md` §6 rows point back here;
> glyph changes are orchestrator-owned (`docs:counts` / `docs:gaps`).

---

## 1. Problem statement

Templates are the one Noema subsystem where **the matrix and reality disagree
in both directions**: several rows marked 🧭 "Planned" have shipped code
(database row templates, the template button block, recurring materialization),
while the rows marked ✅/🟡 describe only the *home* gallery and page
duplication — there is **no workspace-scoped template registry at all**. A user
cannot save a page as a template, browse/manage templates per workspace, set a
default row template, stamp dates into a template, or rely on recurrence
without wiring an external cron job they must discover by reading the route
source.

The product class (Notion) offers: a workspace template gallery with CRUD, "Save
as template" from any page, template variables/date stamps (`@today`), default
templates per database, recurring database templates on a schedule, and locked
(read-only) templates. This spec closes that gap **on top of what already
exists** — three shipped template surfaces and a cron materializer — fixing the
correctness defects found in the audit first (§2.3), then adding the missing
UI/CRUD parity, then variables and recurrence hardening.

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| Block templates (data) | `src/lib/templates.ts:9` (`TemplateId = "meeting" \| "tasks" \| "decision" \| "weekly"`), `:46-94` (`TEMPLATES` builders → `RichNode[]`), `:96-102` (`templateDefinition`, `templateContent`) | 4 built-in, code-defined, **static** content. No variables. |
| Block template tests | `src/lib/templates.test.ts:6,12,17,19` | Unit coverage of ids/content only (21 lines). |
| Template button block | `src/components/editor/extensions/template-button.tsx:21-53` (TipTap atom node `templateButton`, `templateId` attr default `"meeting"` `:27`), `:55-112` node view (`<select>` over the 4 built-ins `:76-97`, Insert `:98-100`, remove `:101-108`); registered `src/components/editor/page-editor.tsx:66,251`; slash entry `src/components/editor/slash-menu.tsx:76` | **Shipped** — matrix row "Template button 🧭 Planned" (`FEATURE_MATRIX.md:339`) is stale. Labels `aria-label="Choose template"`/`"Insert"`/`"Remove template button"` are **hardcoded English** (`template-button.tsx:89,99,104`) in a 5-locale app (D7). |
| Third consumer | `src/server/actions/calendar.ts:204` (`templateContent("meeting")` seeds meeting pages) | Block templates reused by the calendar flow. |
| Home gallery (template gallery) | `src/lib/workflow-templates.ts:40-50` (`GalleryTemplate` type), `:52-201` (`GALLERY_TEMPLATES` = 6: ids at `:54,:82,:110,:128,:147,:174`), `:202-204` (`galleryTemplate`), `:206-209` (`OTHER_TEMPLATES` = the 4 block templates); UI `src/components/home-gallery.tsx:101-130` (card + MiniBoard/MiniTable preview), `:139,:149` quick-starts, `:157-164` gallery grid, `:176-188` "Other templates" list | **Shipped** — matrix row "Template gallery ✅" (`:337`). Workspace-home only; no management surface. |
| Gallery/quick-start actions | `src/server/actions/home-templates.ts:36-142` (`createGalleryTemplateAction`: DATABASE page `:55-66`, `Property` rows `:72-91`, Table/Board `DatabaseView`s `:93-108`, sample rows + `PropertyValue`s `:110-138`), `:145-179` (`createBlockTemplateAction`), `:182-233` (`createQuickStartAction`); all gate on `canEditContent` (`:41-45`, `:151-154`, `:188-190`) | Permissioned, but **none of the created pages set `searchText`** (D2) — cf. `duplicatePageAction` which does (`page-menu.ts:286`). |
| REST wrapper | `src/app/api/templates/route.ts:19-70` (`POST` dispatch `quickstart`/`gallery`/`block`), rate limit 30/min `:20`, `getCurrentUser` 401 `:22-23` | Thin, authed wrapper over the same actions. |
| Page templates | `src/server/actions/page-menu.ts:235-289` (`duplicatePageAction`, clones title/icon/content/flags + `searchText` `:286`, authz `:259-262`); entry points `src/components/page-title.tsx:190-192`, `src/components/topbar/actions-menu.tsx:482` | **Duplicate-page only.** There is no "template" concept for pages: no flag, no listing, no save-as-template (D6). Matrix row "Page templates 🟡 … gallery UI missing" (`:336`) is accurate. |
| Database row templates — model | `prisma/schema.prisma:309-324` `model Template { databasePageId, name, icon, content Json?, config Json?, recurrence String?, nextRunAt DateTime?, createdAt }` + `@@index([databasePageId])`, `@@index([nextRunAt])`; relation `:320` (cascade delete) | **Shipped** but minimal: no `workspaceId`, no `createdById`/`updatedById`, no `updatedAt`, no `locked`, no `isDefault`, no `variables`, no `position`. |
| Database row templates — actions | `src/server/actions/database.ts:463-495` (`saveRowAsTemplateAction`, name cap 80 `:481`, `config.values` snapshot `:484-489`), `:498-546` (`createRowFromTemplateAction`), `:548-562` (`deleteTemplateAction`, authz through `template.databasePageId` `:556`), `:567-588` (`setTemplateRecurrenceAction` → `recurrence` + `nextRunAt` `:583`) | CRUD is create/delete/recurrence only — **no rename, no edit, no default, no ownership check on instantiate** (D1). Matrix row "Database templates 🧭 Planned" (`:338`) is stale. |
| Database row templates — read | `src/server/queries.ts:145-168` (`getDatabase` returns `{id,name,icon,recurrence}` per template `:163-167`) | List view only; `config`/`content` not sent to the client (no preview possible today). |
| Database row templates — UI | `src/components/database/database-view.tsx:444-458` (row → "Save as template" → `saveRowAsTemplateAction` `:446`), `:717-808` (toolbar **Templates** dropdown: hidden entirely when `templates.length === 0` `:717`; per-template submenu: New row `:739-757`, Repeat daily/weekly/monthly + off `:758-787`, Delete `:789-802`) | Functional but minimal: no rename, no preview, no default, no edit; the menu **vanishes when empty** so a user cannot discover templates from a fresh database. |
| Recurrence math | `src/lib/recurrence.ts:1-13` (`nextRunFor`: daily +1d, weekly +7d, monthly `setMonth(+1)` **from `new Date()`, no time-of-day anchor**) | Drifts by execution jitter; monthly from Jan 31 → **Mar 3 (February skipped)** (D4). No unit test file exists for it. |
| Cron materializer | `src/app/api/cron/templates/route.ts:14-102`: fail-closed 503 when `CRON_SECRET` unset `:17-26`, 401 wrong `x-cron-secret` `:27-29`, rate limit 12/min `:30-31`; due query `:33-44`; skip-and-advance for missing/trashed database `:54-60`; row create `:67-78` (**no `searchText`**, attribution `createdById: database.createdById` `:73` — not the template creator); blind `config.values` copy `:80-92` (**no transaction, no stale-property filter** — a dangling `propertyId` throws mid-loop and blocks every later due template, D3); `nextRunAt` advance `:94-97`; `{due, created}` `:101` | **Shipped + hardened** (`AUDIT.md:60` F-03 fail-closed fix; guard `scripts/check-share-cron.mjs:54,61,69` asserts 401/401/200; matrix "Cron endpoint hardening ✅" `:734`). Missing: in-repo scheduler driver (no `cron` entry in `package.json`, no `.github/`, no `vercel.json`), catch-up policy, observability. |
| Variables / date stamps | grep for `@today`/`{{…}}`/date substitution across `src/` → **zero hits**; cron uses `template.name` verbatim as the row title (`cron/templates/route.ts:71`) | **Absent** (gap). |
| Default template | grep `defaultTemplate\|isDefault` across `src/` → **zero hits** | **Absent** (gap). |
| Template locking | `Page.locked` exists (`prisma/schema.prisma:206`, toggle `page-title.tsx:346-350`) but `Template` has no lock and no action checks one | **Absent** (gap). |
| Tests / e2e | `src/lib/templates.test.ts`, `src/lib/ai-skills.test.ts:3,27-43,65` (gallery shape), `e2e/noema.spec.ts:42` ("signs in and shows the home template gallery") | **Zero** unit/e2e coverage of `database.ts` template actions, `recurrence.ts`, and the cron materializer beyond `check-share-cron`'s auth codes. |
| Docs | `README.md:47` ("Template button block + database templates with recurrence … materialized by `POST /api/cron/templates`") | README already claims what the matrix calls planned (D8). |

### 2.2 The product class (Notion) does

1. **Workspace template gallery** — every template (page + database + row) in
   one browsable, searchable place, with create/rename/duplicate/delete.
2. **Save as template** from any page's ⋯ menu; applying a template produces an
   independent copy (source never mutates).
3. **Default template per database** — "New" auto-instantiates it.
4. **Template variables / date stamps** — `@today`, `@tomorrow`, relative dates
   resolved *at instantiation time*, in titles and body text.
5. **Recurring database templates** — daily/weekly/monthly (with time-of-day)
   materialized on schedule, with a visible schedule chip.
6. **Locked templates** — read-only reference templates that still instantiate.

### 2.3 Defects this feature must fix (D-class)

- **D1 — cross-scope instantiation.** `createRowFromTemplateAction` loads the
  template **by id only** (`database.ts:506-510`) and then authorizes only the
  *input* database (`:502-504`). A template from another database — or another
  workspace — is instantiated into the caller's database, and its
  `config.values` `propertyId`s (which belong to the foreign database) are
  written as `PropertyValue`s (`:534-542`) → cross-tenant data link / FK error.
  `deleteTemplateAction` (`:556`) and `setTemplateRecurrenceAction` (`:576`)
  get this right; the instantiate path does not.
- **D2 — invisible to search.** Four materialization paths create pages with
  `content` but **no `searchText`**: `createBlockTemplateAction`
  (`home-templates.ts:164-175`), gallery sample rows (`:112-121`),
  `createRowFromTemplateAction` (`database.ts:517-528`), cron rows
  (`cron/templates/route.ts:67-78`) — while `duplicatePageAction` sets it
  (`page-menu.ts:286`) and `pages.ts:81,269` maintain it. FTS falls back to the
  title only (`queries.ts:277-282` `coalesce(searchText, title)`), so
  template-created content is unsearchable by body text.
- **D3 — poison template blocks the recurrence queue.** The cron loop has no
  per-template `try/catch` and no transaction (`cron/templates/route.ts:47-99`);
  one template with a dangling `propertyId` in `config.values` throws inside
  `createMany` (`:85-91`) → the whole request 500s, later due templates never
  materialize, and if the poison row sorts first the recurrence system is
  permanently wedged.
  ✅ **Fixed by B57** — per-template `try/catch` (`failed: [{id, error}]`,
  failing template does not advance its own `nextRunAt`), row + values +
  advance in one `prisma.$transaction` (no double-create on crash), stale
  `propertyId`s skipped/counted (`{due, created, skipped, failed[]}`);
  red-first `cron/templates/route.test.ts` (7 red → 9 green).
- **D4 — recurrence drift and month-end skip.** `nextRunFor` computes from
  *now*, not from an anchor (`recurrence.ts:4-13`): daily/weekly drift with
  cron jitter, and monthly `setMonth(+1)` from Jan 31 lands on Mar 3 —
  February is skipped. No time-of-day ("every day at 09:00") semantics.
  ✅ **Fixed by B57** (R31.20 math) — `nextRunFor(recurrence, from, anchor?)`
  pins time-of-day and remembers the anchor day-of-month with a last-day
  clamp (Jan 31 → Feb 28 → Mar 31); the cron advances from the stored
  `nextRunAt` (jitter-free) with single-row catch-up past `now`.
  `config.anchorAt` read path ships; the write path
  (`setTemplateRecurrenceAction`, `database.ts`) deferred with D1/B17.
- **D5 — no scheduler driver.** The endpoint exists and is guarded, but
  nothing in the repo runs it (no package script, no workflow, no vercel.json);
  discoverability is `route.ts:10-13`'s comment.
- **D6 — no workspace template registry.** `Template` is reachable only through
  its database (`schema.prisma:320`); there is no way to store, list, edit,
  lock or default a *page* template, and no per-workspace gallery/CRUD UI.
- **D7 — unlocalized template button.** `template-button.tsx:89,99,104`
  hardcodes English while the app ships 5 locales (`src/lib/i18n.ts`).
  ⏸ **Not converted by B57** (brief's literals + note fallback) — no locale
  reaches node views (threading needs `page-editor.tsx`, editor slot; keys
  must land in all 5 catalogues via `scripts/i18n-insert.mjs`, i18n slot);
  in-file note added, real fix rides with R31.10/T31.10's unified picker.
- **D8 — stale matrix rows.** Database templates and the template button are
  marked 🧭 `FEATURE_MATRIX.md:338-339` despite shipping (README `:47` claims
  both). Glyphs are **not** touched by this batch — counts/regen are
  orchestrator-owned (`LOOP_PLAYBOOK.md:59-60,84-87`).

## 3. Decision: one template model, two scopes

| Option | Fit | Verdict |
| --- | --- | --- |
| **A — extend the existing `Template` model** with `workspaceId?` + `kind` (`ROW` \| `PAGE`), keeping `databasePageId` for ROW templates | Reuses the table, the cascade (`schema.prisma:320`), the cron query (`:33-44`) and the existing actions; tree/search/trash stay clean (templates are not `Page` rows, so they never pollute the sidebar, FTS or trash); migration is additive backfill. | **Chosen.** |
| B — page templates as `Page` rows with `type = "TEMPLATE"` (extend `PageType`) | Full editor reuse (open any page route as the template). But `PageType` is a 2-value enum (`schema.prisma:27-30`) with `type === "DATABASE"` conditionals all over the tree/search/trash code; template pages would appear in the sidebar, search, favorites and trash until every consumer is filtered. | Rejected for M1-M2 — enum churn + N consumers to audit; revisit (O31.1) only if M2's template editor route proves too costly. |
| C — JSON blobs in workspace settings | No per-template authz, no cascade, no recurrence linkage; reinvents what `Template` already is. | Rejected. |

Page-template **content editing** therefore gets a dedicated route (R31.11)
that renders the existing editor against a template-scoped save action, rather
than pretending templates are pages.

## 4. Requirements (numbered, testable)

### A. Registry, model, correctness (M1)

- **R31.1** — `Template` gains: `workspaceId String?` (+ relation, `SetNull`
  on workspace delete is **not** acceptable — cascade delete with the
  workspace), `kind` (`ROW` default | `PAGE`), `createdById`, `updatedById`,
  `updatedAt`, `locked Boolean @default(false)`, `isDefault Boolean
  @default(false)`, `variables Json?`, `position Float @default(0)`.
  Existing rows backfill to `kind=ROW`, `workspaceId` derived through their
  `databasePageId`'s page, `locked/isDefault=false`, `position=createdAt`.
  The same push adds nullable `Workspace.timezone` (UTC fallback — used by
  R31.17, O31.2).
  Applied via `prisma db push` under the gate lock (Tier MAX, playbook §gate
  tiers). Attribution fix: cron rows are created with
  `createdById = template.createdById ?? database.createdById`
  (today: `cron/templates/route.ts:73` uses the database creator only).
- **R31.2** — Every template read/write authorizes its **owning scope**:
  ROW → `authorizeDatabase(template.databasePageId)` semantics (already used
  by `database.ts:556,576`); PAGE → `getWorkspaceAccess` + `canEditContent`
  on `template.workspaceId`. A template id whose owning scope the user cannot
  read returns `{ error: "Template not found." }` — no existence oracle
  (cross-workspace ids are indistinguishable from missing ones).
- **R31.3** — *(fixes D1)* `createRowFromTemplateAction` refuses when
  `template.databasePageId !== databasePageId` **before** any write, with the
  same "not found" error. Red-first test proves a template from database B
  cannot be instantiated into database A (same workspace and cross-workspace
  variants).
- **R31.4** — *(fixes D2)* Every materialization path (block, gallery sample
  row, row-from-template, cron) writes `searchText = pageSearchText(title,
  content)` in the same create, byte-identical to `duplicatePageAction`
  (`page-menu.ts:286`). Red-first: create from each path → `searchText`
  non-null and equal to the helper's output.
- **R31.5** — *(fixes D3)* Row materialization runs in a single
  `prisma.$transaction` (row + `PropertyValue` inserts + `nextRunAt` advance);
  `config.values` entries whose `propertyId` no longer exists on the database
  are **skipped and counted**, never thrown. The cron loop isolates each
  template in `try/catch`: one failing template yields
  `{ id, error }` in the response, does **not** advance its own `nextRunAt`
  (retried next tick), and does **not** prevent later due templates from
  materializing.
- **R31.6** — *(template locking)* A `locked` template refuses `update`,
  `delete`, recurrence changes and recapture server-side with
  `"Template is locked."`; the UI hides those actions and shows a lock glyph.
  **Applying/instantiating a locked template stays allowed** (that is the
  point of a reference template). Reuses the `Page.locked` UX precedent
  (`schema.prisma:206`).

### B. Workspace gallery + page-template CRUD (M2)

- **R31.7** — New route `/w/[slug]/templates`: a gallery listing **both**
  scopes — workspace PAGE templates and every ROW template of the
  workspace's databases — each card showing icon, name, scope badge
  ("Workspace" / database name), recurrence chip, locked glyph and "Updated"
  relative time. Empty state links to the home gallery
  (`home-gallery.tsx:157-164`) and to "Save this page as template".
- **R31.8** — Gallery CRUD: **create** (blank), **rename** (inline, ≤120
  chars), **duplicate** (deep copy of `content`/`config`, `locked=false`),
  **delete** (confirm; allowed for creator or workspace admin/owner only),
  **lock/unlock** (R31.6). Each is a server action with the R31.2 scope check;
  guests (read-only role) see the gallery but no mutating controls.
- **R31.9** — **Save page as template**: entry in the page ⋯ / Actions menu
  (alongside the existing Duplicate, `page-title.tsx:190-192`) opens a dialog
  (name + icon prefilled from the page) → `savePageAsTemplateAction`
  snapshots `title/icon/content` into a `kind=PAGE` `Template`. The source
  page is never modified; content over 200 KB is rejected with a clear error.
- **R31.10** — **Apply template**: from the gallery, the picker (R31.12) or
  the slash menu, a template instantiates as a **new sibling page** (or
  appends its blocks into the current page when invoked from the editor).
  Applying is always a copy — red-first test asserts the source template's
  `content`/`updatedAt` are unchanged after N applications.
- **R31.11** — **Template editor**: `/w/[slug]/templates/[templateId]` opens
  the existing `PageEditor` in template mode; saves go through
  `updateTemplateAction` (title/icon/content + R31.2 authz + R31.6 lock
  check), **not** `updatePageAction` (no `PageVersion`, no share links, no
  comments). Locked templates open read-only.
- **R31.12** — **One picker component** (searchable listbox: `role="combobox"`
  + `aria-expanded`, arrow-key navigation, `/`-filter, Enter to apply) reused
  by (a) database "New row → From template…", (b) slash menu "Template…"
  (replacing the hardcoded `"meeting"` insert at `slash-menu.tsx:76`), (c) the
  home gallery "Other templates" list. All strings via `t()` across the 5
  locales — this also fixes **D7** by localizing the template-button node view
  labels (`template-button.tsx:89,99,104`). `check:a11y` stays green; the
  i18n ratchet may only be raised to a *measured* count.

### C. Database template parity (M2)

- **R31.13** — **Default template**: at most one `isDefault=true` template per
  database (enforced in the action: setting one clears the previous in a
  transaction). `createRowAction` applies it automatically (title, icon,
  content, values — via the same R31.5 materializer). The Templates menu gains
  "Set as default / Clear default"; when no default exists, behavior is
  exactly today's empty row. Setting a default on a locked template is
  refused (R31.6).
- **R31.14** — **Row-template editing**: rename + "Update from row" (recapture
  `content` + `config.values` from a chosen existing row) + "Change icon",
  all through `updateTemplateAction`. The submenu shows the name edit field
  and the recapture picker; delete/recurrence keep their current entries
  (`database-view.tsx:758-802`).
- **R31.15** — **Preview**: the picker and the Templates menu show, per
  template, its icon, name, and a one-line preview (row title + up to 3
  property values, or the first heading of `content` for PAGE templates).
  `getDatabase` (`queries.ts:163-167`) and the gallery query extend their
  `select` to include `config`/`content`/`isDefault`/`locked`/`position`.
- **R31.16** — The Templates dropdown must be discoverable on an **empty**
  database: it renders whenever `editable` (with a "New template" entry),
  not only when `templates.length > 0` (`database-view.tsx:717`).

### D. Template variables / date stamps (M3)

- **R31.17** — A pure resolver `resolveTemplateVariables(text, ctx)` processes
  template **title, body text nodes, and TEXT/DATE property values** at
  instantiation time. Tokens: `@today`, `@tomorrow`, `@yesterday`,
  `{{date}}` (ISO), `{{date:<Intl pattern>}}`, `{{datetime:<pattern>}}`,
  `{{title}}` (target page title, when known). `ctx = { now, timezone,
  title? }`; `timezone` comes from the new nullable `Workspace.timezone`
  column added in the M1 push (§5) — `null` = UTC (`Workspace` has no tz
  column today; see O31.2). Unknown tokens are passed through
  **verbatim** (never an error); input length is bounded (64 KB) and the
  resolver performs **no `eval`/dynamic code** (same whitelist posture as
  `src/lib/formula.ts`).
- **R31.18** — Recurrence materialization resolves variables against the **run
  time**, so a "Weekly report" template created Monday materializes each week
  stamped with that run's date — not the authoring date (this is the whole
  point of R31.17 in combination with R31.19).
- **R31.19** — Resolver is unit-tested red-first: DST spring-forward/fall-back,
  leap day (Feb 29 → non-leap year), month-end (`@today` on Jan 31),
  invalid pattern fallback to ISO, unknown-token passthrough, 64 KB bound,
  and a non-ASCII/RTL title round-trip (5-locale parity).

### E. Recurrence hardening (M3)

- **R31.20** — *(fixes D4)* `nextRunFor` becomes anchor-aware:
  `nextRunFor(recurrence, from, anchor?)` where `anchor` is the wall-clock time
  of the first schedule — daily = same time next day, weekly = same weekday +
  time, monthly = same day-of-month + time with **last-day clamp** (Jan 31 →
  Feb 28/29 → Mar 31 — the day-of-month is remembered, not incremented).
  `setTemplateRecurrenceAction` stores the anchor (`config.anchorAt`), the cron
  computes from the **stored** `nextRunAt` (`route.ts:94-97` keeps this
  shape), and red-first unit tests cover the Feb clamp + jitter-free pinning.
- **R31.21** — *(fixes D5)* In-repo driver: `scripts/run-cron.mjs` + npm
  script `cron:run` (reads `CRON_SECRET`, POSTs `/api/cron/templates`,
  pretty-prints the response) plus documented examples for system cron,
  Task Scheduler and GitHub Actions in the README; `npm run check:cron` runs
  the materializer end-to-end against a seeded due template with an injected
  clock.
- **R31.22** — **Missed runs never flood.** If `nextRunAt` is far in the past
  (service down for a week), materialize **at most one catch-up row** (cap
  configurable, default 1) and advance `nextRunAt` past `now` — no row-per-
  missed-tick. Covered by a fake-clock integration test.
- **R31.23** — **Observability + preserved semantics.** Response shape becomes
  `{ due, created, skipped, failed: [{ id, error }] }`; `skipped` counts
  trashed/missing databases (current behavior `route.ts:54-60` is preserved:
  skip **and** advance) and stale property values (R31.5). The fail-closed
  guard (503 unset / 401 wrong secret / rate limit, `route.ts:17-31`) and
  `scripts/check-share-cron.mjs` assertions stay green; cascade delete of a
  database still removes its templates (`schema.prisma:320`).

### F. Non-regression

- **R31.24** — Existing coverage stays green: `src/lib/templates.test.ts`,
  `src/lib/ai-skills.test.ts` gallery assertions (`:27-43,65`),
  `e2e/noema.spec.ts:42` home-gallery test, `check:share-cron`. New tests
  (§9) cite their `R31.x` ids. No i18n key added without all 5 locales; no
  ratchet raise except to a measured value; `check:a11y` green;
  `check:coherence` ends **COHERENT**.

### Non-goals (this spec)

- **Template from selection** — `FEATURE_MATRIX.md:345` is ⛔ "skip
  initially"; stays a non-goal (would need block-selection capture in the
  editor slot).
- Cross-workspace template marketplace/import, public Notion-template imports,
  per-view defaults (view `config` can host this later — O31.4), replacing
  the home gallery (it ships and stays).

## 5. Data model

```prisma
model Template {
  id             String    @id @default(cuid())
  kind           TemplateKind @default(ROW)   // ROW | PAGE
  workspaceId    String?                      // set for PAGE; backfilled for ROW
  databasePageId String?                      // required for ROW (kept as-is)
  name           String
  icon           String?
  content        Json?                        // block tree (PAGE templates + row body)
  config         Json?                        // { values, anchorAt, variables }
  variables      Json?                        // declared tokens + defaults (optional)
  recurrence     String?                      // daily | weekly | monthly (unchanged)
  nextRunAt      DateTime?
  isDefault      Boolean  @default(false)     // one per database (R31.13)
  locked         Boolean  @default(false)     // R31.6
  position       Float    @default(0)
  createdById    String
  updatedById    String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  databasePage Page?     @relation(fields: [databasePageId], references: [id], onDelete: Cascade)
  workspace    Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([databasePageId])
  @@index([workspaceId, kind])
  @@index([nextRunAt])
}

enum TemplateKind { ROW PAGE }
```

- `Workspace.timezone String?` (added in the same push, O31.2) — used only by
  R31.17; `null` = UTC.
- Existing `@@index([nextRunAt])` and the cascade relation stay — the cron
  query (`route.ts:33-44`) keeps its shape.
- Migration: additive columns + backfill (`kind=ROW`, workspace via the
  database's page, `position = createdAt`); no row is lost or rewritten
  otherwise. `prisma db push` under the gate lock, `:3200` restart, dev
  `:3201` restarted after (playbook "HARD RULE").

## 6. Contracts

| Surface | Contract |
| --- | --- |
| `POST /api/templates` (existing) | Unchanged dispatch (`route.ts:42-66`) gains actions `savePage`, `apply` — same auth, same rate limit 30/min. |
| `POST /api/cron/templates` (existing) | Same guard; response `{ due, created, skipped, failed[] }` (R31.23). |
| Server actions (new/changed) | `savePageAsTemplateAction(pageId, name)` [R31.9] · `updateTemplateAction(id, patch)` (name/icon/content/isDefault/locked/recapture) [R31.6,R31.11,R31.14] · `applyTemplateAction(target, templateId)` [R31.10] · `listTemplatesAction(workspaceId)` [R31.7,R31.15] · `duplicateTemplateAction(id)` [R31.8] · changed: `createRowFromTemplateAction` (+ownership check R31.3), `deleteTemplateAction` / `setTemplateRecurrenceAction` (+lock +scope R31.2,R31.6), `createRowAction` (+default apply R31.13), all four materializers (+transaction +searchText R31.4,R31.5). |
| Pure libs | `src/lib/templates.ts` (keep) · `src/lib/template-variables.ts` (new, R31.17-R31.19) · `src/lib/recurrence.ts` (anchor-aware, R31.20) · `src/lib/template-picker.ts` (new, filter/preview model for R31.12/R31.15). |
| Authz | Reuses `getWorkspaceAccess`/`canEditContent` (`src/lib/permissions.ts`) and `authorizeDatabase` — **no new permission primitives** (single source of truth, same rule as `realtime-collab.md` §6). |

## 7. UI spec

- **Gallery** (`/w/[slug]/templates`): responsive card grid (reuse
  `home-gallery.tsx` card styling `:101-130`), sectioned "Workspace" /
  "Databases", per-card ⋯ menu (rename/duplicate/lock/delete), search input,
  "New template" primary action, sidebar entry under Library
  (i18n via `t()`, 5 locales).
- **Picker**: single `template-picker.tsx` dialog — search field + listbox
  with icon/name/scope/preview line; keyboard: ↑/↓, Enter, Esc; announced
  result count (`aria-live="polite"`); used by R31.12 (a),(b),(c).
- **Database Templates menu** (extends `database-view.tsx:717-808`): renders
  when editable even if empty (R31.16); per-template submenu gains Rename,
  Update from row, Set/Clear default, preview line; recurrence submenu keeps
  daily/weekly/monthly (+ a chip showing the pinned time once R31.20 lands);
  lock glyph for locked templates with edit actions hidden.
- **Template button block**: same behavior, labels localized (D7) and its
  `<select>` fed by the picker model (built-ins + workspace PAGE templates)
  once R31.12 lands; until then it keeps the 4 built-ins.
- **Save-as-template dialog**: name (prefilled), icon, scope fixed
  "Workspace"; success toast links to the gallery.

## 8. Edge spec

| Edge | Behavior |
| --- | --- |
| Guest tries gallery CRUD | Controls not rendered; server actions return the R31.2 error regardless (defense in depth). |
| Template id from workspace B used in A | `{ error: "Template not found." }`, no write, no existence signal (R31.2). |
| Row template instantiated into a different database | Refused pre-write (R31.3, fixes D1). |
| Property deleted after template saved | Stale `propertyId` values skipped + counted in `skipped` (R31.5); row still created with remaining values. |
| Cron with 1 poison template among 10 due | 9 materialize, 1 reported in `failed[]`, its `nextRunAt` unchanged, request 200 (R31.5). |
| Service down 7 days (daily recurrence) | Exactly 1 catch-up row, `nextRunAt` jumps past now (R31.22). |
| Monthly template anchored on the 31st | Jan 31 → Feb 28 → Mar 31 (clamped day remembered), never skips a month (R31.20). |
| Template content contains `@today` | Resolved against run time + workspace tz; unknown tokens pass through verbatim (R31.17). |
| Locked template | Not editable/deletable/recurrence-changeable; still instantiable (R31.6). |
| Database trashed | Cron skips + advances (existing `route.ts:54-60`, preserved in R31.23); restore resumes on next tick. |
| Database permanently deleted | Cascade removes its ROW templates (`schema.prisma:320`); PAGE templates unaffected. |
| Applying a template twice | Two independent copies; source `updatedAt` unchanged (R31.10). |
| Default template deleted | `isDefault` row removed; next new row is empty (no error) (R31.13). |

## 9. Test plan

**Unit (vitest, red-first — cite the requirement ids)**

1. **Scope/ownership predicate** — `assertTemplateScope(template, target)`:
   same-db ok / other-db-same-workspace deny / other-workspace deny; PAGE
   template scope check. *[R31.2, R31.3]*
2. **Materializer plan (pure)** — `planRowFromTemplate(template, database)`:
   filters stale property ids, derives `searchText` via `pageSearchText`,
   applies default flag, produces the transaction ops list. *[R31.4, R31.5,
   R31.13]*
3. **Variable resolver** — `resolveTemplateVariables`: tokens, Intl patterns,
   tz/UTC, DST, leap, month-end, unknown passthrough, 64 KB bound, no-eval
   posture. *[R31.17-R31.19]*
4. **Anchor-aware recurrence** — daily/weekly pinning, monthly last-day clamp
   (Jan 31 → Feb 28 → Mar 31), from stored `nextRunAt` not `now`.
   *[R31.20]*
5. **Picker model** — `filter(query, templates)` ordering (workspace first,
   defaults first), scope badge, preview-line truncation. *[R31.12, R31.15]*
6. **Catch-up cap** — `advanceAfterRun(recurrence, missedFrom, now, cap)`:
   one row max, `nextRunAt` past now. *[R31.22]*

**Integration (node script, extend the `check-*` family → `check-cron`)**

7. Seeded due template → POST `/api/cron/templates` with secret → row exists
   with `searchText` + resolved date stamp; poison template → `failed[]`,
   others created, `nextRunAt` semantics per R31.5/R31.22.
   *[R31.4, R31.5, R31.18, R31.21-R31.23]*
8. `scripts/check-share-cron.mjs` stays 401/401/200 (guard regression).
   *[R31.23]*

**e2e (Playwright — NEW `e2e/templates.spec.ts`, dedicated prisma pages +
try/finally, dev :3201, targeted runs only in wave mode)**

9. Save page as template → appears in gallery → apply → sibling page has the
   content; source unchanged. *[R31.9, R31.10]*
10. Gallery CRUD rename/duplicate/delete; guest sees no mutating controls and
    a direct action call errors. *[R31.8, R31.2]*
11. Default template auto-applies on "New row"; clearing it restores empty
    rows. *[R31.13]*
12. Locked template: edit action refused + UI shows lock glyph. *[R31.6]*
13. Recurrence: set daily on a template with `@today` in the title → run the
    cron endpoint with `CRON_SECRET` → new row stamped with today's date.
    *[R31.17, R31.20-R31.23]*
14. Non-regression: `e2e/noema.spec.ts:42` home-gallery test still green.
    *[R31.24]*

**Gates (FAST/STANDARD per tier)**: M1 schema work is Tier MAX (db push +
build + restart + full e2e under the gate lock); M2/M3 are Tier STANDARD
(tsc + eslint + unit + targeted e2e on :3201). Every batch ends with
`check:coherence` **COHERENT** and honest evidence tails.

## 10. Milestones

- **M1 — Correctness + model (~2-3 days, Tier MAX):** R31.1-R31.6.
  Schema push + backfill, scope fix (D1), searchText parity (D2),
  transactional materializer + poison isolation (D3), locking. Ships value
  even if no new UI lands: the shipped surfaces stop lying.
- **M2 — Workspace gallery + CRUD + defaults (~3-4 days):** R31.7-R31.16.
  Gallery route, page-template save/apply/editor, unified picker (fixes D7),
  default template, row-template rename/recapture, previews, discoverability.
- **M3 — Variables + recurrence (~2-3 days):** R31.17-R31.23 (+ R31.24 across
  all). Resolver, anchor-aware recurrence (D4), scheduler driver (D5),
  catch-up + observability.

## 11. Delivery plan (milestones → tasks ↔ requirements)

> Test-first rule from `scripts/LOOP_PLAYBOOK.md` applies: every task's
> acceptance is a red test citing its requirement IDs before implementation.

**M1**

- T31.1 [R31.1]: schema extension + backfill + cron attribution fix. Red: none
  (migration) → integration 7 asserts backfilled workspace ids.
- T31.2 [R31.2, R31.3]: scope predicate + `createRowFromTemplateAction`
  guard. Red: unit 1.
- T31.3 [R31.4]: `searchText` on all four materializers. Red: unit 2.
- T31.4 [R31.5]: transaction + stale-value skip + per-template isolation in
  cron. Red: unit 2, integration 7.
- T31.5 [R31.6]: `locked` enforcement in actions (+ matrix UI glyph in M2).
  Red: unit 1 (locked refusal cases).

**M2**

- T31.6 [R31.7, R31.15]: gallery route + queries + preview model. Red: unit 5.
- T31.7 [R31.8, R31.2]: CRUD actions + permission gating. Red: unit 1, e2e 10.
- T31.8 [R31.9, R31.10]: save-as-template + apply. Red: e2e 9.
- T31.9 [R31.11]: template editor route + `updateTemplateAction`. Red: e2e 9
  (edit-then-apply variant).
- T31.10 [R31.12, R31.16]: unified picker + i18n of the template button (D7).
  Red: unit 5 + a11y run.
- T31.11 [R31.13, R31.14]: default template + rename/recapture UI. Red:
  unit 2, e2e 11.

**M3**

- T31.12 [R31.17, R31.18]: resolver + wire into materializers. Red: unit 3.
- T31.13 [R31.19]: resolver edge suite. Red: unit 3 (edges).
- T31.14 [R31.20]: anchor-aware `nextRunFor` + stored anchor. Red: unit 4.
- T31.15 [R31.21, R31.22]: driver script + catch-up cap + `check:cron`.
  Red: unit 6, integration 7.
- T31.16 [R31.23, R31.24]: response shape + guard regression + full
  non-regression sweep (existing unit/e2e/a11y/coherence). Red: integration 8,
  e2e 14.

## 12. Risks & open questions (honest)

**Risks**

1. **Schema push is Tier MAX.** M1 needs `prisma db push` + build + `:3200`
   restart + dev `:3201` restart under the gate lock (playbook hard rule);
   this is the only milestone that holds the lock. Backfill correctness on the
   live DB is the thing to get wrong — snapshot first, verify row counts by
   `kind` after.
2. **Overlap with B27 (automations spec)** — both cite
   `/api/cron/templates`. Boundary: **B27 owns the rule model
   (trigger/condition/action) and recurring-ticket semantics; this spec owns
   the template materializer semantics** (R31.5, R31.20-R31.23). The endpoint
   must not grow two competing behaviors; whoever implements second reuses the
   R31.5 transactional helper.
3. **i18n volume.** Gallery + picker + dialogs are new UI in a 5-locale app —
   keys must go through `scripts/i18n-insert.mjs` with measured ratchet
   movement only; the template-button localization (D7) touches a file whose
   strings are currently asserted nowhere (low risk, but check:e2e text
   matching).
4. **Cron response change** (`failed[]` added) — `check-share-cron.mjs`
   asserts status codes only (`:54-69`), so additive fields are safe; verify
   in T31.16 rather than assume.
5. **Stale matrix rows (D8).** This batch appends Notes only; glyph flips for
   "Database templates" / "Template button" (both shipped) are orchestrator
   work at regen time (`LOOP_PLAYBOOK.md:84-87`). Implementation batches
   should flip them with evidence.

**Open questions**

- **O31.1** — If the M2 template editor route (R31.11) proves disproportionate,
  fall back to gallery CRUD with JSON-level content editing (duplicate → edit
  as page → save back). Decision revisit: after T31.6, before T31.9.
- **O31.2** — Timezone source: add `Workspace.timezone` (chosen in §5) vs
  reuse `User.locale` heuristics vs UTC-only. Chosen: workspace column,
  `null` = UTC; revisit if settings UI ordering makes it awkward.
- **O31.3** — Cross-workspace template sharing (duplicate-into-another-
  workspace): out of scope now; the R31.2 scope rule makes it an explicit,
  testable future action.
- **O31.4** — Default template per **view** (Notion allows per-view defaults):
  `DatabaseView.config` (`schema.prisma:299`) has room; deferred until view
  configs stabilize (B15/B17).
- **O31.5** — Recurring row attribution: R31.1 prefers `template.createdById`;
  audit trail may want a distinct "scheduler" actor in `Activity` rows —
  decide at T31.1 with the activity conventions (`queries.ts:178-184`).
