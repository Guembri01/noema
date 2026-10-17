# Spec — Relations, rollups & the formula property

> **Status: spec complete, implementation pending.** This document is the
> deliverable; no production code was changed. Every claim about the current state cites a file that was
> opened for this spec. Requirement IDs (`R21.x`) are the traceability anchors:
> §10 lists milestones/tasks 1:1 against them, and tests must cite the IDs they
> cover.

---

## 1. Problem statement

Noema already ships a **v1 of all three property types** — `RELATION`,
`ROLLUP` and `FORMULA` exist in the `PropertyType` enum
(`prisma/schema.prisma:45-47`), can be created (`src/server/actions/database.ts:74-85`),
are configured from the column header menus, and evaluate in the browser. What
is missing is everything that makes them trustworthy and Notion-class:

- **no validation anywhere**: a relation can point at a database in another
  workspace, a relation cell can reference arbitrary page ids, a rollup config
  can name any ids, a formula can save any string
  (`src/server/actions/database.ts:101-125,178-200`);
- **no two-way relation** (no inverse/back-link pair metadata anywhere in
  `src/` for database properties — grep for `inverse|backlink|reciprocal`
  matches only ticket relations and mention backlinks);
- **no real page picker** — a dropdown listing *every* row of the target
  database, eagerly loaded with no search, no pagination, no scoping check
  (`src/server/queries.ts:195-226`, `src/components/database/view-parts.tsx:663-696`);
- **no formula editor** — a one-line prompt textarea with a static hint string,
  no autocomplete (`src/components/database/database-view.tsx:1142-1175`);
- **rollups silently don't render in table view** — the table `Cell` discards
  the computed value it is handed (`src/components/database/view-parts.tsx:633-634`
  vs `src/components/database/view-renderers.tsx:214`).

Goal: production-grade relations (single/multi/two-way), validated rollups with
a complete function set, and a real formula editor — incrementally on top of
the existing engines (`src/lib/formula.ts`, `src/lib/rollup.ts`), not a rewrite.

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| Property schema | `prisma/schema.prisma:264-278`, `:269`, `:280-292` | `Property` rows with `type PropertyType` and `config Json` — the comment at `:269` already promises "select/status options, relation target, rollup + formula config". Values are JSON per `(propertyId, pageId)` (`@@unique` `:290`). |
| PropertyType enum | `prisma/schema.prisma:45-47` | `FORMULA`, `RELATION`, `ROLLUP` already in the enum; created via `createPropertyAction` defaults (`src/server/actions/database.ts:74-85`): formula `{expression:""}`, relation `{targetDatabaseId:null}`, rollup `{relationPropertyId:null,targetPropertyId:null,function:"count"}`. |
| Relation value shape | `src/server/actions/database.ts:27-38` | Documented shape `RELATION -> { pageIds: string[] }` — always a list; "single vs multi" is not modeled. |
| Relation target config | `src/components/database/database-view.tsx:217-224`, `src/components/database/view-parts.tsx:192-210` | Header menu "Link to database" writes `config.targetDatabaseId` via `updatePropertyAction`. `listDatabasesAction` supplies workspace-scoped candidates (`src/server/actions/linked-database.ts:18-29`). |
| Relation data load | `src/server/queries.ts:145-229`, esp. `:190-226` | `getDatabase` resolves, **per relation property**, ALL target rows + their property values into `relationData` (`:205-209` eager `findMany`, no pagination). **No workspace check on `targetDatabaseId`, no guest filter.** |
| Relation cell UI | `src/components/database/view-parts.tsx:647-700` | Chips for selected ids + a "+" `DropdownMenu` that toggles membership over the full option list. No dialog, no search, no keyboard model beyond menu defaults. Unknown ids are silently not rendered as chips (`:653`). |
| Rollup engine | `src/lib/rollup.ts:5-36,77-111` (+ `rollup.test.ts`, 7 cases) | Pure `RollupFunction` union of **14 functions** (`count, count_empty, sum, avg, min, max, median, range, earliest, latest, checked, percent_checked, unique, show_original`) + `aggregate()`. There is **no `percent_empty`** today. |
| Rollup config UI | `src/components/database/view-parts.tsx:211-251`, `database-view.tsx:226-236` | 3-level nested header submenu: relation → target property → function; writes raw config through `updatePropertyAction` (server validates nothing, `database.ts:101-125`). |
| Rollup evaluation | `database-view.tsx:368-406` (`computeRollup`), `:409-429` (`computedFor`) | **Client-side**, over `relationData` — therefore correct only for the rows that happened to be loaded. |
| Rollup in table view | `view-parts.tsx:633-634` vs `view-renderers.tsx:214` | Table `Cell` **ignores** the `computed` prop for `ROLLUP` and renders `"—"`; the side-peek panel does show it (`database-view.tsx:1078,1105-1106`). |
| Formula engine | `src/lib/formula.ts:1-261` (+ `formula.test.ts`, 6 cases) | Dependency-free tokenizer (`:22-77`) + recursive-descent parser (`:79-250`) + `evaluateFormula` returning `{ok,value|error}` (`:252-261`). `prop("Name")` case-insensitive (`:214-220`); functions `if, concat, length, upper, lower, contains, empty, abs, round, min, max` (`:212-248`); bare `now`/`today` idents (`:205-206`); operators `== != <= >= && || + - * / % < > !` (`:63-71`). **No `eval`/`Function`; no length or recursion-depth cap.** |
| Formula evaluation | `database-view.tsx:46,348-361` | **Client-side per row**: scope built from the row's values, errors rendered as `#<message>` in the cell (`:360`). |
| Formula editor | `database-view.tsx:1142-1175,1210-1212`, save at `:460-468` | `PromptDialog` single multiline textarea; description is a hardcoded function hint string (`:1156`). No autocomplete, no live validation — the raw string is saved to `config.expression` unvalidated. |
| Two-way / pair metadata | grep `twoWay\|inverse\|backlink\|reciprocal` over `src/` | **None for database properties.** The only inverse mapping in the codebase is ticket relations: `src/lib/tickets.ts:55-58` (`blocks ↔ blocked_by`, `relates→relates`, `duplicates→duplicates`). |
| `TicketRelation` precedent | `prisma/schema.prisma:717-729` (+ `:694-695`, `:679,691`) | Standalone edge table: `fromId/toId/type` with `@@unique([fromId,toId,type])`, doc comment `/// blocks · blocked_by · relates · duplicates`, both sides exposed as `relations`/`relatedBy` back-relations; parent/child tickets via `Ticket.parentId` (`onDelete: SetNull`). Actions authorize + log activity (`src/server/actions/tickets.ts:383-411`); matrix row 727 marks it ✅. |
| `linked-database` precedent | `src/components/editor/extensions/linked-database.tsx:33-70`, `src/server/actions/linked-database.ts:18-66` | TipTap **atom node** embedding a read-only view of another database (`databasePageId` attr, `:43-48`). The two actions show the house authz pattern: `requireUser` + `getWorkspaceAccess(user.id, page.workspaceId)` (`linked-database.ts:22-23,41-42`). Matrix rows 104/237 still say 🧭 (glyphs left as-is). |
| `Page` relations (parentId) | `prisma/schema.prisma:196,220,240` | Self-relation `Page.parentId` ("PageChildren", `onDelete: Cascade`, indexed). **Database rows are pages**: `getDatabase` fetches rows as `parentId: databasePageId` (`queries.ts:155-157`). Nested pages ship (matrix:152 ✅); duplicate-page relation remap is partial (matrix:431 🟡). |
| Permission precedent | `src/lib/permissions.ts:10-26,28-30` | `getWorkspaceAccess(userId, workspaceId)` → role or null (owner fallback); `canEditContent` = not GUEST. Database actions already gate on both (`database.ts:40-52,66,190`). |
| Guest scoping precedent | `src/lib/guest-access.ts:1-11,38-40,46,84` | `guestVisiblePageIds` is "the query the sidebar, search and the page route all use, so the rule cannot drift" (`:9-10`); `isVisibleToGuest` predicate (`:38-40`). |
| Tests today | `src/lib/formula.test.ts` (6), `src/lib/rollup.test.ts` (7); `e2e/` grep (case-insensitive) for `relation|rollup|formula` → **0 matches** | Engine-level unit coverage exists; **zero e2e coverage** of the three property types. Own spec file needed: `e2e/relations-parity.spec.ts` (tier rule: shared files → own file). |
| Matrix rows | `docs/FEATURE_MATRIX.md:289-295` (section 4), `:314-329` (section 5, **16 planned rows**, status summary `:775` = 0/0/16/0) | Section-4 relation/rollup rows all 🧭 "Planned" — **drift**: the code ships a v1. Glyphs left untouched per house rules; this spec's Notes append is the only matrix edit. |

**Summary:** the engines and the storage shapes exist and are tested; the gaps
are *validation, tenancy, two-way semantics, picker UX, editor UX, and one
render-path defect* (rollup → table cell).

### 2.2 What the product class (Notion) does

1. **Relation property** targets another database in the workspace; cells open a
   searchable page picker (recent + typeahead, single- or multi-select).
2. **Two-way relation** creates a reciprocal property on the target database;
   linking from either side updates both; the inverse can be hidden.
3. **Rollup** picks relation → target property → function and recomputes
   whenever either side changes; results are visible in every view type.
4. **Formula editor** autocompletes property names and functions, shows live
   errors, and never saves a broken expression silently.
5. Guests and members only ever see relation targets they are allowed to see.

### 2.3 Gaps this spec must close (defects)

- **D1 — no config validation.** `updatePropertyAction` accepts arbitrary
  `config` JSON: cross-workspace `targetDatabaseId`, bogus rollup triples,
  invalid formulas all persist (`database.ts:101-125`).
- **D2 — no value validation.** `setPropertyValueAction` upserts client-supplied
  `value` for a client-supplied `propertyId` without checking that the property
  belongs to the row's database, or that `pageIds` are rows of the configured
  target (`database.ts:178-200`).
- **D3 — unscoped target reads.** `getDatabase`'s `relationData` reads target
  rows/values with no workspace or guest check (`queries.ts:195-226`) — a
  relation config pointing cross-workspace is a data leak, not an error.
- **D4 — no two-way.** No pair metadata, no propagation, no delete/rename
  integrity (§2.1).
- **D5 — picker loads the whole target database** up front (payload + UX
  problem) with no search (`queries.ts:205-209`).
- **D6 — rollup renders "—" in tables** (`view-parts.tsx:633-634`).
- **D7 — formula editor has no autocomplete/live validation** and saves
  unparseable strings (`database-view.tsx:1142-1175,460-468`).
- **D8 — client-side rollup under-counts** when the relation set is paginated
  or lazily loaded (architectural, blocks D5's fix).
- **D9 — parser has no bounds**: no expression length cap, no recursion-depth
  cap (`formula.ts:184-187` recurses per `(`) — a pathological expression is a
  render-time DoS on the author's own team; must be bounded before the editor
  invites free-form authoring.

## 3. Decisions

### 3.1 Pair metadata: `Property.config` JSON vs a dedicated table

| Option | Fit | Verdict |
| --- | --- | --- |
| **Pair fields inside `Property.config`** (`inversePropertyId`, `multi`) | `config` is *already* documented to hold relation/rollup/formula config (`schema.prisma:269`); pair is 1:1 with the property, no independent lifecycle; **zero Prisma schema change → no `prisma db push` (Tier HEAVY) for M1/M2**; matches how `targetDatabaseId` already ships. | **Chosen.** |
| Dedicated `RelationPair` model (cf. `TicketRelation`, `schema.prisma:717-729`) | Referential integrity for free. But a pair row would duplicate the property's own row (every relation already *is* a `Property`), needs its own migration + cascade rules, and buys nothing the JSON can't express with two symmetric writes. | Rejected — schema churn for no read path that needs it. |

**Decision:** `config = { targetDatabaseId, multi, inversePropertyId }` for
relations; all pair mutations (create/invert/delete/rename) happen inside one
transaction in the server actions (§4, R21.7-R21.9). Referential integrity is
enforced by the actions, not the DB — same trade the JSON config already makes.

### 3.2 Formula evaluation: client-side (shared pure module) — decision

| Option | Fit | Verdict |
| --- | --- | --- |
| **Client-side, existing parser** (`src/lib/formula.ts`) | Already built, pure, dependency-free, unit-tested (6 cases), no `eval` (whitelist parser = no code-exec risk); evaluates during render with zero round-trips; the SAME module can be imported by the server action for validation (it touches no DOM/fs — isomorphic by construction). | **Chosen.** |
| Server-side per-row evaluation + payload | Authoritative, cacheable, indexable — but one HTTP round-trip (or a server-component refetch) per expression change; N rows × M formulas re-shipped; kills the instant-feedback loop the formula editor needs; a caching/dependency layer (matrix `:328`) would have to be built first. | Rejected for M3 — revisit only with the dependency-graph work (O21.4). |
| Hybrid: client for preview, server for stored values | Two evaluation contexts = the drift class this codebase avoids deliberately ("one source of truth", cf. realtime spec §6). Only worth it if values were persisted; they are not (`computedFor` derives at render, `database-view.tsx:409-429`). | Rejected — drift risk, no consumer for a persisted value yet. |

**Decision: client-side evaluation, server-side *validation*, one shared
module.** `updatePropertyAction` imports `evaluateFormula`'s parse path from
`src/lib/formula.ts` and rejects unparseable expressions (R21.15); the browser
runs the identical code. Semantics can never diverge because there is one
implementation. Bounds (length, depth) are added in the same module so both
sides inherit them (D9).

### 3.3 Rollup evaluation: server-side at query time — decision

Rollups are the opposite case: correctness requires the **complete** related
set, while the picker (R21.5) must stop shipping whole target databases (D5).
Client-side aggregation over a partial set would silently under-count (D8).
Therefore `getDatabase` computes rollup values per row into a server-derived
map — the exact pattern already used for `lastEditedBy`
(`queries.ts:176-189`) — reusing the same pure `aggregate()`
(`src/lib/rollup.ts:77`, isomorphic). The client stops running
`computeRollup` (`database-view.tsx:368-406`) and renders the map.

## 4. Requirements (numbered, testable)

### M1 — relation correctness + picker

- **R21.1** — Relation config shape: `Property.config` for `RELATION` is
  `{ targetDatabaseId: string | null, multi: boolean, inversePropertyId: string | null }`;
  `createPropertyAction` defaults to `{ targetDatabaseId: null, multi: true,
  inversePropertyId: null }` (extends `database.ts:74-85`). `multi: true`
  preserves today's behavior; `multi: false` is what makes "Relation (single)"
  (matrix `:291`) a first-class mode.
  *Acceptance:* red unit test on the config normalizer → green; existing
  databases with `{targetDatabaseId:...}`-only configs normalize to the full
  shape with `multi: true` (idempotent — feeds R21.19).
- **R21.2** — Target validation: `updatePropertyAction` rejects a
  `targetDatabaseId` that is not an existing, non-trashed `type = DATABASE` page
  **in the same workspace** as the source database, with the generic error
  `"Database not found."` — the module's own answer for a missing database and
  the same for a foreign, a deleted and a non-database target, so the refusal
  is no existence oracle (mirrors realtime spec R9.7).
  *Acceptance:* red action tests: cross-workspace id → error + config
  unchanged; foreign-workspace attacker id → same generic message; valid
  same-workspace id → saved.
- **R21.3** — Value validation in `setPropertyValueAction`
  (`database.ts:178-200`): for every property write, (a) `propertyId` must
  belong to the row's database (`property.databasePageId === row.parentId`);
  for `RELATION` additionally (b) every id in `pageIds` must be a non-trashed
  row whose `parentId` is the configured `targetDatabaseId`, (c) `multi:false`
  clamps to at most one id, (d) `targetDatabaseId: null` → error "Configure the
  relation first.". (a) applies to **all** property types — it closes D2 for
  formula/rollup configs too.
  *Acceptance:* red tests for (a) foreign propertyId, (b) id from a different
  database / deleted row, (c) two ids on a single relation, (d) unconfigured
  target; all green after.
- **R21.4** — Read scoping of relation targets: options, `valuesByRow` and
  target property metadata are served only when the viewer has access to the
  target database: `getWorkspaceAccess(user, targetWorkspaceId)` (precedent
  `linked-database.ts:41-42`) **and**, for `GUEST` roles, the **read** scope
  `guestReadablePageIds` (precedent `guest-access.ts`) — the shared pages plus
  their whole subtree, never an ancestor. The *display* scope
  (`guestVisiblePageIds`) is too wide here: it also carries the ancestors of
  the shared pages, so a guest who was given a single row of the target would
  pass it for the database above it.
  A denied target yields an empty `relationData` entry — not an error that
  reveals existence. Closes D3.
  *Acceptance:* red tests — member of workspace B with a relation config
  pointing at B's database from A (should be impossible post-R21.2, but the
  read path must still hold): guest without `PagePermission` on the target sees
  `options: []` and no `valuesByRow`; a guest who was given only a row of the
  target does not get the target either; non-member gets nothing.
- **R21.5** — Page picker dialog: the relation cell opens a **dialog** (not the
  dropdown at `view-parts.tsx:663-696`) with typeahead search against a new
  cursor-paginated server action `searchRelationTargetsAction(propertyId,
  query, cursor)` (20 rows/page, icon + title), recent picks first, full
  keyboard model (↑↓ move, Enter toggle, Enter again/close, Esc), focus trap +
  `role="dialog"`/`aria-modal`, and a `multi:false` mode that closes on first
  selection. The eager whole-target load (`queries.ts:205-209`) shrinks to the
  page of results actually requested. Unconfigured relation shows a
  "Choose a target database" empty state (reuses the header menu path,
  `view-parts.tsx:192-210`).
  *Acceptance:* targeted e2e in **`e2e/relations-parity.spec.ts`** (new file —
  e2e has zero relation coverage today): open picker, type, select, chip
  renders; assert the search action's `query`/`cursor` args (not a 1 000-row
  payload); keyboard-only selection works; Esc closes and restores focus.
- **R21.6** — Dangling ids: ids pointing at rows that no longer satisfy (b)
  never render (already true for chips, `view-parts.tsx:653`) and are pruned
  from stored values on write and by the migration pass (R21.19).
  *Acceptance:* red unit test on `pruneRelationIds(ids, validRows)`; e2e —
  delete the target row, reload, source cell's chip is gone.

### M2 — two-way relations + rollups

- **R21.7** — Enabling two-way on a relation, in **one transaction**: create
  the inverse `RELATION` property on the target database (auto-named after the
  source property, `multi` mirrored from the source), write
  `inversePropertyId` into **both** configs, and backfill the inverse cells for
  every existing link (source row's `pageIds` → inverse row's `pageIds`).
  Disabling removes the inverse property's pair state and clears both
  `inversePropertyId` fields.
  *Acceptance:* red action tests — toggle on: inverse property exists, configs
  cross-reference, backfill populated; toggle off: both fields null, no orphan
  config.
- **R21.8** — Pair integrity on delete/rename/target-loss: extending
  `deletePropertyAction` (`database.ts:127-141`) to clear the counterpart's
  `inversePropertyId` before deleting; renaming either side keeps the pair;
  deleting the target database cascades its `Property` rows
  (`schema.prisma:274`) and the source's `inversePropertyId` becomes null
  (relation degrades to unpaired, cells keep rendering via R21.6 rules).
  *Acceptance:* red tests for delete-source, delete-target-database,
  rename-either-side.
- **R21.9** — Link propagation: writing either side updates **both** cells
  atomically — linking A-row → B-row also writes B-row's inverse cell, unlink
  removes it; failure of the second write rolls back the first (single
  transaction). Self-relations (source database = target database) are allowed;
  a self-relation's inverse may be the same property (self-inverse).
  *Acceptance:* red action test — link from A, read B's cell shows the
  back-link; injected failure between the two writes leaves neither side
  changed.
- **R21.10** — Rollup config validation in `updatePropertyAction`: for
  `ROLLUP`, `relationPropertyId` must be a `RELATION` property of the **same**
  database, `targetPropertyId` must belong to that relation's target
  database's properties, and `function` must be in `ROLLUP_FUNCTIONS`
  (`rollup.ts:21-36`). Invalid → error, config unchanged.
  *Acceptance:* red tests for each of the three violations + one happy path.
- **R21.11** — Function set: the rollup function set is the existing 14
  (`rollup.ts:21-36`) **plus `percent_empty`** = `round(count_empty / count_all
  × 100)`%, rendered `"—"` when `count_all = 0`. The required set
  (sum/avg/min/max/count/percent-empty/show-original) is a subset; matrix row
  295's "join" maps to `show_original` with an optional `separator` config
  (default `", "`).
  *Acceptance:* red `rollup.test.ts` cases for `percent_empty` (0/3/3 empty,
  zero-total) and `show_original` with custom separator; `ROLLUP_FUNCTIONS`
  list gains the labelled entry.
- **R21.12** — Rollups render in table view: fix `view-parts.tsx:633-634` to
  display the `computed` prop it already receives (`view-renderers.tsx:214`;
  gallery path `:468-473`). Closes D6.
  *Acceptance:* red e2e — configure a sum, table cell shows the number, not
  `"—"`; side-peek value matches the table value.
- **R21.13** — Server-side rollup evaluation: `getDatabase` returns a
  `computedByRow: Record<rowId, Record<propertyId, string>>` map for ROLLUP
  (pattern precedent: `lastEditedBy`, `queries.ts:176-189`), computed with the
  pure `aggregate()` over the **complete** related set (server queries it
  directly — pagination is a picker concern only). Client `computeRollup`
  (`database-view.tsx:368-406`) is removed in favor of the map. Closes D8.
  *Acceptance:* red test — 60 related rows where the picker would only ever
  load 20: server rollup sums all 60; a change to a target row's value changes
  the source rollup on next `getDatabase`.

### M3 — formula engine

- **R21.14** — Evaluation stays **client-side in `src/lib/formula.ts`**
  (decision §3.2): no per-row server evaluation, no persisted computed values.
  New bounds, enforced inside the module: expression ≤ 10 000 chars, parser
  recursion depth ≤ 64 (rejects with a normal `{ok:false}` error). Closes D9.
  *Acceptance:* red unit tests — 10 001-char expression → error; 65 nested
  parens → error, no stack overflow; the two existing render paths
  (`database-view.tsx:348-361`, save-time validation) keep working.
- **R21.15** — Server-side validation on save: `updatePropertyAction` for
  `FORMULA` parses `config.expression` via the shared module (a `parseFormula`
  helper exported beside `evaluateFormula`, `formula.ts:252`) and rejects
  invalid expressions with the parser's own message — the same message the
  editor shows. Any string no longer persists (D7).
  *Acceptance:* red tests — `prop(` → error + config unchanged; a valid
  expression → saved; bounds violations (R21.14) rejected at save time too.
- **R21.16** — Formula editor with autocomplete: replace the `PromptDialog`
  textarea (`database-view.tsx:1163-1175`) with an editor popover containing:
  (a) expression input with an autocomplete popup offering **property names**
  (inserting `prop("Name")`) and the **function catalogue** (labels from a
  single exported list, mirroring `ROLLUP_FUNCTIONS`' pattern); (b) a live
  error line fed by `parseFormula` on each keystroke (debounced) — replacing
  the save-then-see `#error` cell (`database-view.tsx:360`); (c) a preview of
  the current row's computed value; (d) Save disabled while the expression
  fails to parse (server still rejects — R21.15 is the backstop). Keyboard:
  ↑↓ through suggestions, Tab/Enter insert, Esc closes suggestion then editor.
  All strings via `t()` (i18n ratchet must not move).
  *Acceptance:* targeted e2e — open editor, type `pro`, choose a property from
  the popup, save, cell computes; type `1 +` → error line visible, Save
  disabled; existing `formulaSaved` toast path still fires.
- **R21.17** — Function library coverage for matrix section 5 rows `:315-322`:
  keyword booleans `and`/`or`/`not` (parser today is tokens-only — `&& || !`,
  `formula.ts:63-71,173`), `ifs`, `ceil`, `floor`, `slice`, `replace`,
  `dateAdd`, `dateBetween`, `formatDate` (today only bare `now`/`today`,
  `:205-206`). Every new function ships with `formula.test.ts` cases; the
  editor's function list (R21.16) is generated from the same catalogue.
  *Acceptance:* red unit case per function; no function is listed in the
  autocomplete that fails its test.
- **R21.18** — Rollups inside formulas (matrix `:326`): the formula scope in
  `computeFormula` (`database-view.tsx:352-358`) gains rollup properties of the
  same row from the `computedByRow` map (R21.13) — the ordering dependency
  ("rollups first, then formulas") is resolved by computing rollups before
  formulas in `computedFor` (`database-view.tsx:409-429`).
  *Acceptance:* red test — formula `prop("Progress") >= 0.5` where `Progress`
  is a rollup; flip a related row's number, reload, formula flips.
- **R21.19** — Migration for existing database rows (§8): idempotent pass that
  (1) normalizes relation configs to the R21.1 shape, (2) prunes dangling
  `pageIds` (R21.6), (3) nulls rollup config pieces that fail R21.10, (4)
  parses every stored formula expression and records failures for UI flagging
  (friendly error state, matrix `:327`). No `prisma db push` — config JSON
  only.
  *Acceptance:* seed fixture DB with each broken case → run → configs valid or
  safely degraded; run twice → second run changes nothing (idempotence
  asserted).
- **R21.20** — Tenancy & guardrails (spans M1–M3): every new server action
  (`searchRelationTargetsAction`, two-way toggles, migration) runs through
  `authorizeDatabase` (`database.ts:40-52`) + `getWorkspaceAccess`
  (`permissions.ts:10-26`); cross-workspace ids always yield the one generic
  error (no existence oracle); guests are read-scoped
  (`canEditContent`, `permissions.ts:28-30` — they cannot link, rollup-config
  or save formulas; guest visibility via `guestVisiblePageIds`); all UI strings
  go through `t()` with keys added to every locale.
  *Acceptance:* coherence gate green (i18n file count may grow, never shrink);
  red action test for the generic cross-workspace error; a guest attempting a
  relation write inside their read scope gets "No permission.", while a write
  outside the scope gets "Database not found." — character for character the
  answer for a database that does not exist, so the refusal never confirms
  that the database exists.

### Non-goals (this spec)

Regex functions/extraction (matrix `:324-325`, see O21.3), formula result
caching/dependency graph (`:328`, O21.4), named constants (`:329`), rollup
**filters** ("where" clauses), cross-workspace relations, relation columns in
board/gallery beyond what `Cell` already renders, Notion-style relation
"limit" settings.

## 5. Data model

No Prisma schema change. All state lives in existing columns:

```ts
// Property.config — RELATION (R21.1)
{
  targetDatabaseId: string | null,   // must be DATABASE page, same workspace (R21.2)
  multi: boolean,                    // default true; false => single relation
  inversePropertyId: string | null,  // two-way back-link (R21.7); null = one-way
}
// Property.config — ROLLUP (validated by R21.10)
{
  relationPropertyId: string,        // RELATION property of this database
  targetPropertyId: string,          // property of the relation's target database
  function: RollupFunction,          // rollup.ts:5-19 + "percent_empty" (R21.11)
  separator?: string,                // show_original only
}
// Property.config — FORMULA (unchanged shape, validated by R21.15)
{ expression: string }

// PropertyValue.value — RELATION (unchanged): { pageIds: string[] }
// getDatabase return (R21.13): + computedByRow: Record<rowId, Record<propertyId, string>>
```

Why no `RelationPair` table: §3.1. `TicketRelation`
(`schema.prisma:717-729`) stays the precedent for *typed edges between
independent entities* — database relations are edges owned by a property, and
the property row **is** the edge definition.

## 6. UI spec

### 6.1 Relation cell → page picker dialog

- Trigger: relation cell chip area / "+" affordance (replaces the dropdown,
  `view-parts.tsx:663-696`). Unconfigured relation → empty state with
  "Choose a target database" opening the existing header submenu
  (`view-parts.tsx:192-210`).
- Dialog: reuse the app's `Dialog` primitives (focus trap, Esc); search input
  autofocused, debounced 150 ms → `searchRelationTargetsAction`; results list
  (icon + title, ✓ for selected, `aria-activedescendant` listbox pattern);
  footer shows count + "Clear all" (multi only).
- `multi:false`: single click selects **and** closes; `multi:true`: toggle +
  stay open, "Done" button closes. Selected chips render as today
  (`view-parts.tsx:652-662`).
- States: loading (skeleton rows), empty result ("No matches"), no-target
  (see above), guest read-only (dialog not offered; chips only).

### 6.2 Rollup config panel

- Keep the 3-level header submenu as the quick path (`view-parts.tsx:211-251`)
  but route it through the same validated action (R21.10).
- Add a config summary line in the property menu: `Σ <relation> · <property> ·
  <function>` with a "Change…" item opening a small panel (three selects:
  relation, target property, function — function list from
  `ROLLUP_FUNCTIONS`, incl. new `percent_empty`; separator field appears for
  `show_original`).
- Invalid persisted config (post-migration edge) renders "Configure rollup"
  instead of `—` and never throws at render.
- Table cells show the computed value (R21.12); side-peek keeps read-only
  computed display (`database-view.tsx:1105-1106`).

### 6.3 Formula editor

- Replaces the prompt (`database-view.tsx:1142-1175`): popover with multiline
  input, suggestion popup (property names first, then functions), live error
  line, current-row preview, Save/Cancel (i18n via `t()`; reuse
  `saveFormula`/`formulaFor` keys already in the catalogue).
- Cell render keeps `#<error>` fallback for expressions that failed migration
  flagging (R21.19) — with the friendly text "Fix formula: <message>"
  (matrix `:327`).

### 6.4 Migration UX

- No user-facing wizard. The R21.19 pass runs as a one-shot script (§8);
  affected formulas show the friendly error state (6.3), degraded rollups show
  "Configure rollup", pruned relation cells simply lose dead chips.

## 7. Security & tenancy

Threats → controls (all grounded in existing precedents):

| # | Threat | Control | Precedent |
| --- | --- | --- | --- |
| T1 | `targetDatabaseId` pointing cross-workspace → row/title leak | R21.2 rejects at write; R21.4 re-checks at read (defense in depth: a config that predates validation can never leak) | `linked-database.ts:41-42` (`getWorkspaceAccess` on the target's workspace) |
| T2 | Client writes an arbitrary `propertyId` (all types) | R21.3(a) — property must belong to the row's database | `authorizeDatabase`, `database.ts:40-52` |
| T3 | Relation cell as an oracle for guest-scoped pages | R21.4: guests filtered through the read scope `guestReadablePageIds` (shared pages plus their subtree, never an ancestor); denied target → empty result, generic errors only | `guest-access.ts`; no-existence-oracle rule, realtime spec R9.7 |
| T4 | Formula strings abusing the evaluator | Whitelist parser — no `eval`/`Function` (kept); length + depth bounds (R21.14); server-side parse rejects at save (R21.15) | `formula.ts:79-250` design |
| T5 | Guest escalating to write (link/unlink, config) | `canEditContent` gate on every action — GUEST excluded | `permissions.ts:28-30`, already applied in `database.ts:66,112,137,190` |
| T6 | Two-way backfill mutating another workspace's rows | Backfill runs inside the same authorized transaction and only over ids that passed R21.3(b) | transactional pair writes (R21.7-R21.9) |

## 8. Migration path (existing database rows)

1. **Script** `scripts/migrate-relations.mjs` (one-shot, idempotent — runs the
   four steps of R21.19 against live data; safe to re-run):
   normalize configs → prune `pageIds` → validate rollup triples → parse
   formulas and collect failures into a report file.
2. **No schema migration** — no `prisma db push`, no downtime, no Tier-MAX
   gate for M1/M2 (config JSON only; this is why §3.1 chose JSON).
3. **Degraded states are visible, not fatal**: failing formulas get the
   friendly error state (6.3), broken rollups show "Configure rollup",
   relation cells with a null target show the empty state.
4. **Back-compat**: `multi` absent ⇒ `true` (old configs keep working);
   one-way relations (`inversePropertyId: null`) behave exactly as today.
5. Two-way backfill for *existing* links happens at toggle-on time (R21.7),
   not in the migration — a data migration must not invent pairings nobody
   asked for.

## 9. Test plan

**Unit (vitest, red-first)**

1. Config normalizer + validators — R21.1/R21.2/R21.10 pure helpers
   (`new src/lib/relation-config.test.ts` — matches the "pure logic lives in
   `src/lib/*` with its own vitest file" sandbox rule).
2. `pruneRelationIds` — R21.6.
3. `rollup.test.ts` additions — `percent_empty`, `show_original` separator
   (R21.11).
4. `formula.test.ts` additions — bounds (R21.14), every new function
   (R21.17), rollup-in-scope composition (R21.18 helper).
5. Pair-transaction logic — pure decision helper for create/invert/delete
   (R21.7/R21.8) before touching actions.

**Action-level integration (domain-check script pattern, cf.
`scripts/check-collab.mjs`, `check-sso-teamspaces.mjs`)**

6. New `scripts/check-relations.mjs`: full matrix of R21.2/R21.3/R21.4
   (member/guest/outsider × same/cross workspace × configured/unconfigured),
   two-way toggle + propagation + delete integrity (R21.7-R21.9), rollup
   validation (R21.10), server rollup over 60 rows (R21.13), save-time formula
   validation (R21.15), migration idempotence on seeded fixtures (R21.19).

**e2e (Playwright, new `e2e/relations-parity.spec.ts`, serial, dedicated
pages — `e2e/` currently has ZERO relation/rollup/formula coverage)**

7. Picker dialog: open → typeahead → select → chip; keyboard-only path;
   single-relation closes on select (R21.5).
8. Two-way: link from source, open target row side-peek, back-link present
   (R21.9).
9. Rollup renders in the **table** cell, value matches side-peek (R21.12 — the
   D6 regression net).
10. Formula editor: autocomplete insert → save → computed cell; invalid
    expression disables Save (R21.16).
11. Non-regression: `e2e/database-parity.spec.ts` + `properties-parity.spec.ts`
    must stay green (they own the existing property behavior).

**Gate tier**: this spec is FAST (docs only: tsc/eslint untouched,
coherence + this document). Implementation is STANDARD (targeted e2e
against dev `:3201`, no full suite per phase gating); no schema push means no
Tier HEAVY unless later work adds a table (O21.4 would).

## 10. Delivery plan (milestones → tasks ↔ requirements)

> Test-first rule applies: every task's
> acceptance is a red test citing its requirement IDs before implementation.

**M1 — Single relation done right (~2-3 days)**

- T21.1 [R21.1, R21.2]: config shape + target validation in
  `updatePropertyAction`/normalizer. Red: unit 1.
- T21.2 [R21.3, R21.6]: value validation + pruning in
  `setPropertyValueAction`. Red: unit 2 + integration 6.
- T21.3 [R21.4]: read scoping for `relationData` + guest filter. Red:
  integration 6.
- T21.4 [R21.5]: `searchRelationTargetsAction` + picker dialog replacing the
  dropdown. Red: e2e 7.

**M2 — Two-way + rollups (~3-4 days)**

- T21.5 [R21.7, R21.8]: pair create/disable/delete/rename integrity
  transactions. Red: unit 5 + integration 6.
- T21.6 [R21.9]: link/unlink propagation. Red: integration 6.
- T21.7 [R21.10, R21.11]: rollup config validation + `percent_empty` +
  separator. Red: unit 3 + integration 6.
- T21.8 [R21.12, R21.13]: server-side rollup map + table-cell render fix.
  Red: integration 6 + e2e 9.

**M3 — Formula engine (~3-4 days)**

- T21.9 [R21.14]: parser bounds (length/depth). Red: unit 4.
- T21.10 [R21.15]: save-time validation via shared module. Red: integration 6.
- T21.11 [R21.16]: formula editor popover with autocomplete. Red: e2e 10.
- T21.12 [R21.17, R21.18]: function library + rollup-in-formula scope. Red:
  unit 4.
- T21.13 [R21.19]: migration script + degraded-state UI. Red: integration 6
  (idempotence).
- T21.14 [R21.20]: tenancy/i18n sweep across all of the above. Red: coherence
  + generic-error test.

## 11. Risks & open questions (honest)

**Risks**

1. **Two-way propagation correctness (highest).** Two independently editable
   cells that must stay in sync without a CRDT — concurrent edits from both
   sides are last-writer-wins per cell, and a partial failure must never leave
   the sides divergent. Mitigation: single-transaction writes (R21.9) +
   integration rollback test; divergence detector in the migration report.
2. **Read-scoping perf.** R21.4 adds a guest-filter query per relation
   property on every `getDatabase`. Mitigation: scope resolution is already
   done once per request elsewhere (sidebar/search); compute the visible-id
   set once and reuse.
3. **Scope creep into the formula mega-build.** Section 5 has 16 planned rows
   (matrix `:314-329`); R21.17 covers the cheap half. If M3 balloons, ship
   R21.14-R21.16 + R21.18 first (editor quality) and let the function library
   be its own micro-slice (tier rule: max 2-3 feature rows per change).
4. **Picker e2e flakiness.** Dialog + typeahead on `workers:1` serial suites —
   mitigate with generous polling and dedicated pages.

**Open questions**

- O21.1: Inverse visibility — should the auto-created inverse property be
  hidden in existing views by default (Notion-style) or visible? Spec leans
  **hidden** (avoid column explosion); needs a `DatabaseView.config`
  visible-property touch (`schema.prisma:299`).
- O21.2: Should relations ever target **standalone pages** (not database
  rows)? Current value shape and picker assume rows of a database; page-level
  linking already exists via mentions/backlinks. Spec says database-only.
- O21.3: Regex functions (matrix `:324-325`) — sandboxing approach (pattern
  vetting vs input caps vs a small RE2-style engine) is undecided; keeping
  regex out of M3 is deliberate (non-goal above).
- O21.4: Formula result caching / dependency graph (matrix `:328`) — deferred;
  revisit if profiling shows recompute cost at scale (client-side evaluation
  is O(rows × formula props) per render today).
- O21.5: Rollup filters ("sum where status = Done") — a config extension
  (`filter?`) that R21.10's validator would need to know about; out of scope,
  but the config shape must not painted-into-a-corner (JSON leaves room).
- O21.6: `TicketRelation`-style typed edges (`blocks/blocked_by/...`) for
  database relations? Notion has no equivalent; keep the ticket domain's
  precedent separate.
