# Spec — Database deep: view-type depth, linked views, templates, permissions & row ops

> **Status: spec complete, implementation pending.** Batch **B89** of the parity
> loop (docs tier, light slot). This document is the deliverable; no production
> code was changed. It covers **FEATURE_MATRIX §3 "Databases" — the 36 planned
> (🧭) rows**, the biggest remaining cluster. Every claim about the current code
> cites file + line. Requirement IDs (`R89.x`) are the traceability anchors:
> §11 lists milestones 1:1 against them, §13 maps every matrix row to its
> requirements, and tests must cite the IDs they cover.

---

## 1. Problem statement

B15 rebuilt the database view family (per-view configuration, filter operators,
multi-sort, view duplicate, soft-delete rows) and B17 closed the properties
family. The substrate — `src/lib/database-query.ts`, `src/components/database/**`,
the `database.ts` actions — is in place. What remains in §3 of the matrix is the
**depth cluster**: 36 rows still marked 🧭 that fall into five groups:

1. **View-type depth** — all seven view types render, but shallowly (§2.1): no
   group collapse/aggregation, no chart measures, no calendar multi-day spans,
   no gantt interaction, and **no Form view at all** (`ViewType` has no `FORM`).
2. **Linked / synced databases** — the linked-database node exists but carries
   **no view identity** (only `databasePageId`), is read-only, and has no
   synced (mirror) mode.
3. **Database templates deep** — row templates shipped minimal (B-earlier
   evidence below); default template, previews and the recurrence surface are
   pending, mostly owned by `docs/specs/templates.md` (R31.x).
4. **View permissions + row operations** — no capability split (schema edits vs
   row edits vs view management), no database lock, no duplicate-row action and
   no move-row UI.
5. **Property types & import** — `UNIQUE_ID`/`BUTTON` exist as enum values with
   shell rendering only; `PLACE`/`VERIFICATION` do not exist in the enum;
   CSV import/export is owned by `docs/specs/import-export.md` (R23.x) with a
   thin database-toolbar integration left here.

The goal: one coherent plan that closes (or explicitly hands off) all 36 rows
with testable `R89.x` requirements, grouped M1–M3, without duplicating a single
requirement already owned by a sibling spec (§2.4).

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| View schema | `prisma/schema.prisma:294-307` `model DatabaseView { … type ViewType @default(TABLE), config Json?, position Float }`; `:57-65` `enum ViewType { TABLE BOARD LIST GALLERY CALENDAR TIMELINE CHART }` | **7 types, no `FORM`.** Config is a JSON blob (filters, sorts, groups, visible properties, layout options). |
| Query engine | `src/lib/database-query.ts:41-58` `FilterOperator`, `:66` `FilterNode` (**already a recursive AND/OR tree**), `:68-74` `ColorRule`, `:75` `Sort`, `:77-89` `ViewConfig`, `:91-144` operator catalogues + `operatorsFor`, `:501` `compareBySorts`, `:580` `groupRows`, `:623` `applyView`, `:714` `normalizeViewConfig`, `:764` `parseViewConfig`, `:796` `chartData`, `:845` `timelineData` | Engine is deep: tree filters evaluate, grouping and colour rules are modelled, config is normalized on write/parse on read. The **UI has not caught up** (rows 🧭). |
| Per-view settings | `src/components/database/view-settings.tsx:41-71` — filters, sorts, `groupByPropertyId`, colour rules, visible columns, frozen-column toggle | Wired to one view's `config`. No group order/collapse, no chart/timeline/gallery/date-property settings. |
| Renderers | `view-renderers.tsx:19` `TableView`, `:284` `ListView`, `:340` `BoardView` (groupBy prop `:347,361`; falls back to the STATUS property `:369-373`; one column per option/bucket `:384+`), `:491` `GalleryView` (preview = first 3 non-primary properties `:508-510`; banner = first image across FILES `:513-527`), `:586` `CalendarView` (matches **only `value.start`'s single day** `:624-634`; month grid `:613-621`; no week view), `timeline-chart-views.tsx:21` `TimelineView` (fixed window now−1mo…now+4mo `:40-49`; bars from first DATE property; no drag, no zoom, no dependencies), `:88` `ChartView` (**count-only bars** `:112-133`; group property = first STATUS/SELECT/MULTI_SELECT `:97-99`; no type/measure choice) | All 7 types render; **depth is what the 🧭 rows still need**. Matrix notes such as "grouping engine needed" (`FEATURE_MATRIX.md:199`) are stale relative to B15's code — the *depth* gaps are real (§2.3). |
| Toolbar & row actions | `src/server/actions/database.ts:41` `authorizeDatabase`, `:224` `createRowAction` (position = max+1000, appends `:232-243`), `:271` `deleteRowAction`, `:292` `listDeletedRowsAction`, `:329/355/388` view create/update/duplicate, `:592` `importCsvAction`; `database-view.tsx:438-442` New row, `:507-509` delete row, `:566-578` deleted-rows panel, `:825-848` Export/Import CSV menu | No `duplicateRow`, no `moveRow`. `getDatabase` orders rows by **`Page.position`** (`queries.ts:155-157`), so the manual-order storage already exists; only the reorder action + drag UI are missing. |
| Row order seeding | `home-templates.ts:110-122` seeds positions in 1000 steps; `createRowAction` appends (`database.ts:232-243`) | Position-based order is real; sorts overlay it client-side (`applyView`). |
| Templates | `prisma/schema.prisma:309-324` `model Template { databasePageId, name, icon, content, config, recurrence, nextRunAt }`; actions `database.ts:464` `saveRowAsTemplateAction`, `:499` `createRowFromTemplateAction`, `:549` `deleteTemplateAction`, `:568` `setTemplateRecurrenceAction`; UI `database-view.tsx:717-750` (Templates menu, recurrence badge `:734-735`, instantiate `:742-748`), `:444-453` save-row-as-template | **Shipped but minimal**: no rename/edit, no default, no preview (`getDatabase` selects only `{id,name,icon,recurrence}` — `queries.ts:163-167`), no ownership check on instantiate. `docs/specs/templates.md:47` already records the matrix row `:338` as stale and owns the fixes (R31.x). |
| Linked database | `src/server/actions/linked-database.ts:8-16` `LinkedDatabaseData`, `:18` `listDatabasesAction`, `:32` `getLinkedDatabaseAction` (**read-only**, authorizes via `getWorkspaceAccess`), node `src/components/editor/extensions/linked-database.tsx:21-33` attrs = `{ databasePageId }` only, `slash-menu.tsx:74` insert | Renders source schema + rows inline; **no view identity, no per-instance config, no write path, no synced mode.** |
| Synced page view | `page-embed.tsx:26` "read-only synced view of another page", attrs `{ pageId }` `:42`; `doc-renderer.tsx:9` notes it renders on the server | Page mirroring exists; **database** mirroring does not. |
| Property types | `prisma/schema.prisma:32-55` `enum PropertyType` — contains `UNIQUE_ID` (`:52`), `BUTTON` (`:53`), `AI_AUTOFILL` (`:54`); **no `PLACE`, no `VERIFICATION`**; cell catalogue `view-parts.tsx:38-40`; UNIQUE_ID render `:639-649` (read-only), computed display `database-view.tsx:424-425` = `row.id.slice(-8).toUpperCase()`; BUTTON shell `view-parts.tsx:701`, `view-renderers.tsx:219-224` | Unique ID is a **derived display**, not a monotonic stored id; Button has no config/action; Place/Verification absent (schema change needed). |
| Permissions | `src/lib/permissions.ts:10-26` `getWorkspaceAccess` (workspace roles), `prisma/schema.prisma:481` `PagePermission` (per-page grants), `:206` `Page.locked`, `database.ts:41-58` `authorizeDatabase` + `canEditContent` role checks | One binary capability: *can edit content or not*. **No schema-vs-rows-vs-views split, no database lock, no per-view restrictions.** Section-8 rows (per-page permission inheritance, share toggles) are out of this spec's scope (§2.4). |
| Import/export | `importCsvAction database.ts:592` (raw append, header-name matching), toolbar `database-view.tsx:825-848`, export route `src/app/api/export/database/[pageId]/route.ts` | Mapping step, create-database import, round-trip and atomicity are specified by R23.1–R23.6 (`docs/specs/import-export.md:127-170`) — **pending implementation there**; the toolbar integration is the only piece owned here. |
| Tests | `e2e/database-parity.spec.ts:291,353,409,477,530,586,611,658` — operators, two sorts, config persistence, view duplicate, deleted rows, view tab, type switch, side-peek property edit; unit: `src/lib/database-query.test.ts` | 8 e2e + engine unit tests cover the substrate; nothing covers the depth rows. |
| Docs | `docs/FEATURE_MATRIX.md:191-265` §3; sibling specs §2.4 | — |

### 2.2 What the product class (Notion & peers) does

1. **Grouped views**: collapsible groups, group order, per-group counts and
   summaries, column footer calculations (count/sum/avg/min/max/median).
2. **Chart view**: pick chart type (bar/line/pie/donut), measure
   (count/sum/avg…) and group-by — a first-class view, not a fixed count.
3. **Gantt/timeline**: pickable date property, zoomable scale, drag to move or
   resize, dependency arrows, today marker.
4. **Calendar**: week + month scales, multi-day spans, drag-create.
5. **Linked databases**: insert *a specific view* of another database; the
   instance may carry its own filters; **synced** views are read-only mirrors.
6. **Row operations**: duplicate row (values + body, computed excluded), drag to
   reorder with a persisted manual order.
7. **Permissions**: at minimum read-vs-edit split plus a database lock that
   freezes schema (properties/views/templates) while leaving rows editable.
8. **Properties**: monotonic Unique ID (`PREFIX-0001`), Button (click → action),
   Place (address + map link), Verification (verified-by-owner chip).

### 2.3 Gaps this spec closes (defects)

- **D89.1 — shallow renderers.** Calendar is single-day only
  (`view-renderers.tsx:624-634`); Chart is count-only with an implicit group
  property (`timeline-chart-views.tsx:97-133`); Timeline is a fixed 5-month
  window with no interaction (`:40-49`); Board has no group collapse/order;
  Gallery has no cover selection or content preview.
- **D89.2 — no Form view.** `enum ViewType` lacks `FORM`
  (`schema.prisma:57-65`); no `FormView`, no submit path, no `grep` hits for
  `"FORM"` in `src/`.
- **D89.3 — linked DB has no view identity.** Node attrs are only
  `databasePageId` (`linked-database.tsx:21-33`); every instance renders the
  same thing, read-only, with no per-instance config and no synced mode.
- **D89.4 — templates shallow.** No default template application in
  `createRowAction` (`database.ts:224-269` knows nothing about templates), no
  preview (`queries.ts:163-167` omits `content`/`config`), no rename/edit.
- **D89.5 — no duplicate/move row.** Only `deleteRowAction` exists; there is no
  action to copy a row's values/body, and no action to rewrite `Page.position`
  (order is position-based — `queries.ts:155-157` — but nothing writes it after
  creation).
- **D89.6 — single binary capability.** Every database action funnels through
  `authorizeDatabase` + `canEditContent` (`database.ts:41-58`); a MEMBER who may
  edit rows may equally add/delete properties and views; no lock exists.
- **D89.7 — Unique ID is derived, not stored.** `row.id.slice(-8)` changes
  character with the cuid and cannot be prefixed/padded; not a stable,
  human-readable id (matrix `:265`, `:300`).
- **D89.8 — `PLACE`/`VERIFICATION` missing** from `enum PropertyType`
  (`schema.prisma:32-55`) — requires `prisma db push` (Tier MAX).
- **D89.9 — engine/UI split.** `FilterNode`, `ColorRule`, `groupRows`,
  `aggregate` (rollup lib) already exist, but the settings UI still offers flat
  filters only (`view-settings.tsx:56-71`) — rows `:216-226` stay 🧭 purely for
  wiring.
- **D89.10 — toolbar import bypasses the mapping step.** The menu calls
  `importCsvAction(text)` directly (`database-view.tsx:835-848`); R23.1's
  mapping preview (owned by import-export) is not wired into this entry point.

### 2.4 Ownership map (cross-spec — do not duplicate)

| Concern | Owner spec | Anchor requirements | What THIS spec adds |
| --- | --- | --- | --- |
| Relation / two-way / rollup semantics | `relations-rollups.md` (B21) | **R21.1–R21.20** (M1 `R21.1-R21.6`, two-way+rollups `R21.7-R21.13`, formula `R21.14-R21.20`) | Only §R89.32: relation/rollup columns *participate in view filter/sort/group*, referencing R21.4's read scoping. No relation semantics here. |
| Formula engine, computed columns in filter/sort | `formula-engine.md` | **R22.1–R22.16**, esp. `R22.15` (computed columns in filter/sort) | Nothing — R22.15 is reused by R89.1's filter work. |
| CSV/JSON import (append mapping, create-database, round-trip, atomicity) | `import-export.md` | **R23.1–R23.6** (+ R23.9–R23.12 job UX) | R89.20: toolbar wiring of R23.1/R23.2 and export-menu parity only. |
| Template model, gallery, default flag, variables, recurrence engine | `templates.md` (B31) | **R31.1–R31.24**, esp. R31.1/R31.13 (default), R31.3–R31.5 (row materialization), R31.14 (row-template editing), R31.17–R31.23 (variables/recurrence) | R89.16/R89.17: the **database-view integration** (New-row default, menu preview, recurrence surfacing, scheduler → `createRowFromTemplate` core). |
| Side peek / drawer, row-open UX | `navigation-ux.md` (B29) | **R29.1–R29.8** (incl. R29.5 database peek) | Nothing — matrix `:234` already points there. |
| Button *action execution* (what a button does) | `automations.md` (B27) | **R27.x** (matrix `:58` lists `:259` as dependent) | R89.26: the button **property shell** (config, render, disabled-until-R27 state). |
| AI autofill property | `ai-surface.md` | **R25.x** | Nothing (matrix `:304` points there). |
| Per-page permission inheritance, share-link toggles, publish-to-web (matrix §8) | *no spec owns yet* (row-level grants ship in `plans-licensing.md` R26.x gating and `PagePermission` is read by relations R21.4/R21.20) | — | R89.23/R89.24 define the **database-scoped** capability split only; §8 inheritance stays open (O89.3). |
| Collab on database-row pages | `realtime-collab.md` (B09) | **R9.x**, open question O9.2 | Nothing. |
| Public form sharing | — (share links exist: `schema.prisma:393` `model ShareLink`) | — | R89.29 specifies internal forms; public publishing is O89.1. |

## 3. Decisions

### 3.1 Depth lands in the pure engine + renderers; config-only persistence (M1 has no schema change)

Every M1 requirement extends `database-query.ts` (pure functions) and the
renderers, persisting through the existing `DatabaseView.config` JSON via
`normalizeViewConfig`/`parseViewConfig`. No `prisma db push` in M1 → the
milestone runs Tier STANDARD. Schema deltas (FORM, PLACE, VERIFICATION, lock,
seq, dependencies) are isolated in M3 → Tier MAX, one push.

### 3.2 One aggregation function set: reuse `src/lib/rollup.ts`

`aggregate(values, fn)` and `ROLLUP_FUNCTIONS` already exist
(`src/lib/rollup.ts:5,21,77`) and are the same 14-function set R21.11 blesses.
Group summaries (R89.4), footer calculations (R89.4) and chart measures
(R89.12) all call it. **Rejected**: a second aggregation module in
`database-query.ts` — it would drift from rollup semantics the day B21 lands.

### 3.3 Filter groups: build the tree UI over the already-recursive evaluator

`FilterNode` (`database-query.ts:66`) and `applyView` already evaluate nested
AND/OR; flat `config.filters` remains the legacy shape normalized into a single
top-level `and` on read. **Rejected**: a new filter engine — only the UI,
persistence round-trip and keyboard model are missing (D89.9).

### 3.4 Linked vs synced = mode on the node; view identity = `viewId` attr

- Node attrs become `{ databasePageId, viewId, mode: "linked" | "synced" }`.
- **linked**: renders the chosen source view (its filters/sorts/group config
  applied), allows row edits/create **through the source database's normal
  actions** (same authz — no second write path), plus per-instance filter/sort
  overrides stored in the attrs (bounded JSON, like `ViewConfig`).
- **synced**: read-only mirror; server rejects writes by view id mode anyway
  (defense in depth: the linked path already authorizes per row/property).
- **Rejected**: creating a real `DatabaseView` row per embed (schema bloat, view
  tab pollution, orphan cleanup on block delete).

### 3.5 Manual row order = a per-view mode over the existing `Page.position`

`Page.position` already orders rows (`queries.ts:155-157`) and new rows append
(+1000, `database.ts:232-243`). R89.19 adds `config.manualOrder: boolean` +
`moveRowAction(rowId, beforeRowId | afterRowId)` writing midpoint positions, and
disables drag when any sort key is active (sorted views own their order —
O89.4 documents the interaction).

### 3.6 Database capabilities: three gates on top of `getWorkspaceAccess`, lock as a flag

`authorizeDatabase` (`database.ts:41`) is the single choke point; extend it with
three derived capabilities — `readRows`, `editRows`, `editSchema`
(create/edit/delete properties, views, templates, import) — from
`getWorkspaceAccess` role + a new `Page.schemaLocked` flag (database lock,
matrix `:245`). **Rejected**: reusing `Page.locked` — that flag means "content
frozen" for the whole page (`schema.prisma:206`, realtime D6) and would
incorrectly freeze row data too.

### 3.7 Unique ID = stored monotonic counter on the `Property`

`Property.seq Int @default(0)`; allocation = one transactional
`update … seq = seq + 1` (Postgres row lock) at row creation when a UNIQUE_ID
property exists; display `PREFIX-0001` from `config { prefix, pad }`.
**Rejected**: deriving from cuid (today's `:424-425` — unstable, unpadded) and
**rejected**: a per-database counter table (a database can have several
UNIQUE_ID properties; Notion numbers per property).

### 3.8 Form view: `ViewType.FORM` + settings in view config; submissions reuse `createRowAction` core

The form is a view (`ViewType.FORM`) whose `config.form` lists question
property ids + required flags + `accepting: boolean`. Submit path is a new
server action that authorizes against the *database* (internal forms first) and
creates rows through the same core as `createRowAction` (atomicity per R23.6's
pattern). Public anonymous submission is O89.1 (share-link based, not specified
here). **Rejected**: a separate `Form` table (no matrix row for form management;
a view is the identity).

### 3.9 Sub-items and dependencies are dedicated columns, not relations

R21's relation machinery is **pending** (relations-rollups is spec-complete,
implementation pending); making §3's rows wait on it would serialize two big
clusters. **Decision**: `Page.subOfId` (sub-items, R89.30) and a
`RowDependency` join model (R89.31) are independent of the relation engine;
they can later be *projected* as system relation properties. Dependency cycles
are rejected at write time.

## 4. Requirements (numbered, testable)

> Test-first rule from `scripts/LOOP_PLAYBOOK.md` applies: every task's
> acceptance is a red test citing its requirement IDs before implementation.
> Docs batch: no tests run for B89 itself; IDs below are for the implementing
> batches.

### M1 — view-engine depth (pure lib + renderers + config; **no schema change**, Tier STANDARD)

- **R89.1** — `ViewConfig` gains depth keys, all optional and defaulted by
  `normalizeViewConfig` (`database-query.ts:714`) so every existing view parses
  unchanged (backward-compat unit test mandatory): `groupOrder?: string[]`,
  `collapsedGroups?: string[]`, `footer?: { propertyId, fn }[]`,
  `colorRules` (existing `ColorRule[]`, now surfaced), `manualOrder?: boolean`,
  `columnWidths?: Record<string, number>`, `columnOrder?: string[]`,
  `datePropertyId?: string`, `calScale?: "month" | "week"`,
  `chartType?: "bar" | "line" | "pie" | "donut"`, `chartMeasure?: RollupFunction`,
  `chartGroupBy?: string`, `galleryCoverPropertyId?: string`,
  `galleryPreviewContent?: boolean`, `form?: { accepting, questions: {propertyId, required}[] }`.
  *Accept:* round-trip unit: a pre-M1 config object parses to the same
  semantics with all new keys defaulted; unknown keys are preserved, not
  dropped.
- **R89.2** — **Filter groups UI** (matrix `:216`, `:217`): the filter panel
  renders the `FilterNode` tree — add group (AND/OR), nest to arbitrary depth,
  drag a condition into a group, match-all/any per group — persisted in
  `config.filters` as the tree shape; `applyView` already evaluates it (no
  evaluator change unless a test proves otherwise). *Accept:* unit over a
  3-level mixed tree (a AND (b OR c)); e2e: build the same tree in the UI,
  reload, tree intact, rows filtered correctly.
- **R89.3** — **Groups engine generalized + hidden groups** (matrix `:221`,
  `:223`): `groupRows` (already `:580`) accepts any groupable type
  (SELECT/STATUS/MULTI_SELECT/PERSON/CHECKBOX/FORMULA-result/RELATION-free
  types), supports `groupOrder` (drag to reorder groups) and
  `collapsedGroups` (persisted), keeps the "No value" bucket last, and every
  consuming view (Table/List/Board) shares the same bucket derivation.
  *Accept:* unit: grouping over select/status/person/checkbox/no-value;
  collapsed ids round-trip; e2e: collapse a group, reload, still collapsed.
- **R89.4** — **Group aggregation + calculations footer** (matrix `:222`,
  `:243`): per-group summary chip and a sticky footer row compute
  count/sum/avg/min/max/median (function set = `ROLLUP_FUNCTIONS`,
  `src/lib/rollup.ts:21`) per visible column over the **filtered** row set via
  one shared helper; empty/non-numeric columns show `count` only. *Accept:*
  unit: footer values over a fixed fixture equal `aggregate()` outputs; e2e:
  set a column footer to Sum, assert the rendered number after a filter.
- **R89.5** — **Conditional formatting + row colour rules** (matrix `:224`,
  `:225`): `ColorRule[]` (already typed `:68-74`) get an editor (property,
  operator from `operatorsFor`, colour); rules render as the two-tone row
  background in Table/List (existing row-stripe slot on the pinned cell
  generalizes), evaluated by the same operator catalogue as filters; rule order
  = first match wins. *Accept:* unit: rule evaluation parity with the filter
  evaluator for 5 operator classes; e2e: colour a row by rule, reload, persists.
- **R89.6** — **Quick filter from header** (matrix `:226`): each column header
  menu offers "Filter by this property" that appends a condition to
  `config.filters` (opening R89.2's panel focused on the new row); no separate
  filter state anywhere. *Accept:* e2e: header → equals → value, rows narrow,
  panel shows exactly one condition.
- **R89.7** — **Board depth** (matrix `:199`, `:258`): group-by picker in the
  view menu (any groupable property, persisted), columns follow R89.3's order +
  collapse + counts, "New card" inside a column pre-fills that group's value on
  create, and cards support the row context menu (R89.18/R89.19 actions once
  M2 lands; M1 ships menu with open/delete). *Accept:* e2e: switch group-by
  from STATUS to a SELECT, columns change, reload persists; new card in a
  column carries the group value.
- **R89.8** — **List depth** (matrix `:200`): compact single-line rows grouped
  by R89.3's headers (with per-group counts), inline title edit, row actions on
  hover/focus (keyboard reachable — `check:a11y` must stay green). *Accept:*
  e2e: grouped list renders headers + rows, title edit persists.
- **R89.9** — **Gallery depth** (matrix `:201`, `:257`): cover = explicit
  `galleryCoverPropertyId` (FILES image property) falling back to today's first
  image (`view-renderers.tsx:513-527`), card size option (small/medium/large),
  optional page-content text preview (`galleryPreviewContent`, clipped,
  first 256 chars of `Page.content` plain text via the existing search-text
  helper semantics). *Accept:* unit: cover resolution order; e2e: set cover
  property, cards show the chosen image after reload.
- **R89.10** — **Calendar depth** (matrix `:202`, `:256`): `datePropertyId`
  selection per view (default: first DATE), `calScale` month/week toggle, and
  **multi-day spans**: a DATE value with `start`≠`end` renders as a bar across
  every covered day (each day cell lists overlapping rows; span styling on ≥2
  days), replacing today's single-day match (`:624-634`). *Accept:* unit:
  span-day expansion for 1-day/3-day/cross-month ranges; e2e: create a
  3-day event, all three days show it.
- **R89.11** — **Timeline/gantt depth** (matrix `:203`): per-view
  `datePropertyId`, zoomable window (week/month/quarter scale) with prev/today/
  next navigation, drag a bar to shift dates and drag its edges to resize
  (writes the DATE property through `setPropertyValueAction`), and bars honour
  filters/sorts/group collapse. Dependency arrows are R89.31 (M3).
  *Accept:* unit: date-range math (offset/width) at each scale; e2e: drag a bar
  one week, property value updates, reload keeps it.
- **R89.12** — **Chart depth** (matrix `:204`): chart type (bar/line/pie/donut),
  measure (`chartMeasure` via `ROLLUP_FUNCTIONS`, default count), group-by
  (`chartGroupBy`, default = today's implicit property `:97-99`), persisted in
  view config; empty states for "no groupable property" (existing
  `chartNeedsSelect`) and "no numeric values" preserved. *Accept:* unit:
  `chartData` extended — same fixture produces count and sum series; e2e:
  switch measure to Sum, bar labels change.
- **R89.13** — **Column resize + per-view column order** (matrix `:242`):
  drag-to-reorder headers persists `config.columnOrder` (applied after the
  database-wide `Property.position` default), resizer handle writes
  `config.columnWidths`; hidden columns are unaffected; primary column stays
  pinned. *Accept:* unit: order/width normalization; e2e: resize + reorder,
  reload, both persist; existing property drag-reorder (`reorderPropertiesAction`
  `database.ts:149`) still works and seeds the default order.

### M2 — linked/synced databases, templates deep, row ops, import integration

- **R89.14** — **Linked database: view identity + picker** (matrix `:237`):
  the `linkedDatabase` node attrs become `{ databasePageId, viewId, mode,
  overrides? }` (`linked-database.tsx:21-33`); the insert flow
  (`slash-menu` → picker) offers database → view → mode (Linked/Synced), and the
  block renders **that view's config** (filters/sorts/group/columns via
  `applyView`) instead of raw rows; a "Source view" chip links back to the
  database with that view active. Per-instance `overrides` accept filter/sort
  changes made in the block without touching the source view (bounded to the
  `ViewConfig` subset, normalized by the same parser). Backward compat: old
  nodes (`databasePageId` only) default to `viewId = source's first view`,
  `mode = linked`. *Accept:* unit: attr normalizer incl. legacy nodes; e2e:
  insert a linked block bound to a filtered view — only matching rows show;
  edit an override, source view config unchanged.
- **R89.15** — **Synced mode is read-only; linked mode writes through the
  source's authz** (matrix `:237`): in `synced` mode the block hides all edit
  affordances **and** the server refuses writes that carry a synced-view
  provenance (defense in depth — row/property actions keep their existing
  `authorizeDatabase` checks, `database.ts:41`); in `linked` mode create/edit/
  delete rows call the existing actions unchanged (one write path, one authz
  path), scoped so a member without source-database access sees the block as an
  "unavailable database" placeholder (no existence oracle — mirrors R9.7
  semantics). *Accept:* integration: user with read-only access to source →
  linked block renders, write attempt returns "No permission."; synced block →
  same via provenance check.
- **R89.16** — **Database templates deep** (matrix `:260`, `:261`) —
  *coordinate with `templates.md`: model/flag/gallery = R31.1/R31.7-R31.12,
  default semantics = R31.13, editing = R31.14*. This spec owns only the
  database-view integration: (a) `getDatabase` exposes `content`/`config` for
  previews (`queries.ts:163-167` currently omits them); (b) the Templates menu
  (`database-view.tsx:717-750`) shows a hover preview (icon, name, first
  properties, body snippet) and an "Update from row" entry per R31.14;
  (c) `createRowAction` applies the database's default template's
  `config.values` **when no explicit values are given** (idempotent, single
  source: one helper shared with `createRowFromTemplateAction`
  `database.ts:499`); (d) the New-row split button shows the default template
  first with a "Blank" option. *Accept:* unit: default application is skipped
  when values are supplied; e2e: mark default → New row → row opens with prefilled
  properties; Blank still yields an empty row.
- **R89.17** — **Recurring templates integration** (matrix `:262`) —
  *core = R31.18-R31.23 (resolver, `nextRunFor`, cron driver, flood guard)*.
  Database-side: the Templates menu surfaces `nextRunAt` next to the existing
  recurrence badge (`database-view.tsx:734-735`) and the cron driver
  materializes through the same server-side core as
  `createRowFromTemplateAction` (never through UI code), so generated rows obey
  R89.16's default logic and R89.33's authz (system actor, recorded as such in
  the activity log). *Accept:* integration: set daily recurrence → run the
  driver once → a row exists with correct prefills; UI shows the next run time.
- **R89.18** — **Duplicate row**: new `duplicateRowAction(rowId)` — copies
  title, icon, cover, body `content`, and all `PropertyValue`s **except**
  computed/system types (FORMULA, ROLLUP, CREATED_*, LAST_EDITED_*, UNIQUE_ID);
  relation values copy as-is (subject to R21.3 validation once B21 lands);
  position = source + 1000 shifted (insert right after source); authorizes via
  `authorizeDatabase` + `canEditContent`; dispatches the same `row.created`
  webhook family as `createRowAction` (`database.ts:263-266`). Entry points:
  row ⋯ menu in every view + side peek. *Accept:* unit: value-copy filter
  (computed excluded, UNIQUE_ID re-allocated per R89.25); e2e: duplicate a row
  with 3 filled properties → new row appears after the source with identical
  values and its own unique id.
- **R89.19** — **Move row / manual order** (matrix `:241`): `config.manualOrder`
  (R89.1) toggles manual mode; `moveRowAction(rowId, targetId, placement)`
  rewrites `Page.position` by midpoint (fallback: renormalize all rows in
  1000-steps when midpoints collide — same pattern as `home-templates.ts:110`);
  drag handle in Table/List, drag between Board columns writes both the
  position and the group value; drag is disabled (with an explanatory tooltip)
  while any sort key is active. *Accept:* unit: midpoint math + renormalization
  boundary cases (first/last, equal positions); e2e: drag row below another,
  reload, order persists; board drag across columns updates the group property.
- **R89.20** — **Import/export integration** (matrix `:263`, `:264`) — *core =
  R23.1 (mapping step), R23.2 (create-database import), R23.5 (round-trip),
  R23.6 (atomicity)*. This spec owns only: (a) the database toolbar's
  Import/CSV entry (`database-view.tsx:835-848`) must open **R23.1's mapping
  dialog** instead of raw-append — the preview, skip/create-property choices
  and the `created N rows · skipped […]` summary are import-export's contract;
  (b) Export/CSV keeps hitting `GET /api/export/database/:id` so R23.5's
  round-trip invariant covers the toolbar path; (c) failures surface through
  the existing toast + no partial state (R23.6 atomicity asserted, not
  reimplemented). *Accept:* e2e: import a CSV whose headers match no property →
  mapping dialog blocks completion until every column is accounted for;
  export→import round-trips values (R23.5 test cites both IDs).
- **R89.21** — **Database description** (matrix `:244`): `Page.description
  String?` (DATABASE rows only), editable in the toolbar header (inline textarea,
  500-char cap, one per database), rendered between the toolbar and the view
  area on the full-page database and above linked blocks' source chip; sanitized
  plain text. *Accept:* unit: cap + sanitize; e2e: set a description, reload,
  persists; linked block shows it.
- **R89.22** — **Duplicate database** (matrix `:247`): `duplicateDatabaseAction`
  copies the database page (title "… (copy)"), all `Property` rows (names,
  types, configs, positions), `DatabaseView`s (type + full config, positions),
  optionally rows (checkbox, default off) and templates (name/content/config,
  no recurrence — the copy starts non-recurring per R31.20 semantics), in
  **one transaction**, same workspace/parent, authorization = `canEditContent`
  on source **and** destination parent; new ids everywhere, relation configs
  pointing at other databases are left intact (they reference external targets,
  not copied ones). *Accept:* unit: copy plan for a fixture database (counts +
  id rewrites); e2e: duplicate with views+properties → copy has identical view
  configs, original untouched.

### M3 — permissions & lock, property types, form view, structural rows (**schema changes → Tier MAX**)

- **R89.23** — **Database capability model**: `authorizeDatabase`
  (`database.ts:41`) returns `{ readRows, editRows, editSchema }` derived from
  `getWorkspaceAccess` (`permissions.ts:10-26`) + `Page.schemaLocked` +
  `PagePermission` grants when present (`schema.prisma:481`): owner/admin ⇒ all;
  member ⇒ `readRows`+`editRows`, `editSchema` unless locked; guest ⇒ per
  `PagePermission` (default read-only). Enforcement table: row create/update/
  delete/restore/import ⇒ `editRows`; property/view/template CRUD, view config
  writes, duplicate-database, schema lock toggle ⇒ `editSchema`; everything
  else ⇒ `readRows`. Every database action migrates to this gate (no behavior
  change when unlocked: same roles as today's `canEditContent`). *Accept:*
  unit: full capability matrix (role × lock × PagePermission × capability) as a
  pure predicate; integration: MEMBER without PagePermission cannot delete a
  property but can edit a row (post-lock states covered by R89.24).
- **R89.24** — **Database lock** (matrix `:245`): `Page.schemaLocked` (new
  column, applies when `Page.type = DATABASE`), toggle in the database toolbar
  menu for `editSchema` holders, lock icon + "Schema locked" hint for others;
  when locked: property/view/template/import/duplicate actions return
  "Database is locked." while row edits keep working (rows stay editable —
  matches "prevent schema edits"); unlock is symmetric. Server-side only —
  hiding buttons is cosmetic. *Accept:* integration: lock →
  `createPropertyAction`/`createViewAction`/`importCsvAction` all refuse,
  `createRowAction` succeeds; UI hides the locked controls (e2e).
- **R89.25** — **Unique ID property depth** (matrix `:265`, §4 `:300`):
  `Property.seq Int @default(0)`; `config { prefix = "ID", pad = 4 }`;
  allocation in `createRowAction`'s transaction when the database has a
  UNIQUE_ID property (one `UPDATE … SET seq = seq + 1`, read-back = the row's
  id); display format `${prefix}-${String(seq).padStart(pad, "0")}` replacing
  the derived `row.id.slice(-8)` (`database-view.tsx:424-425`); read-only cell
  + addressable `aria-label` (keep `view-parts.tsx:639-649` contract); visible
  in filters/sorts (lexicographic on the padded string) and in the side-peek
  panel; duplicate row (R89.18) allocates a **fresh** id; CSV import (R23.1)
  never writes it (skip column). *Accept:* unit: formatting/allocator
  (sequential, concurrency-safe via row lock, pad boundaries 9999→10000);
  e2e: create 3 rows → IDs 0001..0003 stable across reload; duplicate → 0004.
- **R89.26** — **Button property shell** (matrix `:259`, §4 `:301`) —
  *execution = automations R27.x*. Owns: `config { label, style: "default" |
  "primary" | "danger", actionId: string | null }`; editor UI in the property
  config panel; cell renders a `<button>` (replacing the shell at
  `view-parts.tsx:701`) that is **disabled with a tooltip "Actions coming with
  automations" while `actionId` is null**; clicking with an `actionId` invokes
  R27.x's dispatcher (contract: `runAutomationAction(actionId, { rowId })` —
  defined here only as the call shape, implemented in automations.md); button
  cells are read-only for value purposes (no `PropertyValue` write). *Accept:*
  unit: config normalizer; e2e: create a Button property, cell renders disabled,
  enabling via config with a stub action id dispatches (stubbed) and fails
  gracefully when R27 is absent.
- **R89.27** — **Place/location property** (§4 `:302`): `PropertyType.PLACE`
  (schema push); value `{ address: string, lat?: number, lng?: number }`
  (coordinates optional — no external geocoder dependency); editor = text input
  with pickable saved places (per-database list from existing values), cell =
  `address` text + "Open in map" link (`https://www.openstreetmap.org/search?query=…`
  — no API key, no embedded iframe in M3); filters/operators: text-shaped set
  (`operatorsFor("PLACE")` ⇒ TEXT_OPERATORS); CSV import maps a column via
  R23.2's inference only when headers say "place"/"location" (else TEXT).
  *Accept:* unit: value normalization + operator catalogue; e2e: set a place,
  cell shows address, link opens (assert `href`), filter by contains works.
- **R89.28** — **Verification property** (§4 `:303`): `PropertyType.VERIFICATION`
  (schema push); value `{ verifiedById: string | null, verifiedAt: ISO | null,
  note?: string }`; cell = chip "Verified ✓ · <name> · <date>" or "Not
  verified"; toggle requires `editRows` and stamps the acting user (from
  session — never client-supplied); un-verifying clears both fields; read-only
  in gallery/peek contexts with the same chip; CSV round-trip (R23.5): exports
  `yes/no`, imports to checked/unchecked with actor = importer. *Accept:* unit:
  toggle state machine (stamp/clear, foreign actor rejected); e2e: verify a row
  as demo user, chip shows name + date, reload persists, second user sees it.
- **R89.29** — **Form view** (matrix `:205`): `enum ViewType.FORM` +
  `config.form` (R89.1); the view renders a **builder** (list of questions =
  property pick order, required toggles, accept/responses switch, preview) for
  `editSchema` holders and a **respondent form** (title, question per property
  using the existing cell editors in a simplified layout, required validation,
  submit + "Add another") for anyone who can `editRows`; submit → new
  `submitFormAction(viewId, values)` that re-authorizes against the database
  (not the view), validates required/typed values through the same rules as
  `setPropertyValueAction` (`database.ts:179`), creates the row in one
  transaction, and rate-limits per user/IP (reuse the existing `rateLimit`
  helper pattern per R23.22); `accepting:false` ⇒ polite closed-state page.
  Form responses counter surfaces in the builder. *Accept:* unit: question
  resolution + required validation; integration: closed form refuses, open form
  creates a row with exactly the submitted values; e2e: fill + submit → row
  appears in the table view of the same database.
- **R89.30** — **Sub-items / sub-tasks** (matrix `:253`): `Page.subOfId String?`
  (nullable, indexed, `SetNull` on parent delete) + `@@index([parentId, subOfId])`;
  indent/outdent actions (Tab/Shift-Tab semantics on the focused row, one level
  deep boundary enforced — no cycles, depth cap 1 in M3), tree rendering in
  Table/List (chevron toggle + indentation), board/gallery show a "has
  sub-items" badge with the child count; duplicate row copies `subOfId`;
  filters/groups treat sub-items as rows (they are rows). *Accept:* unit: cycle
  guard + depth cap; e2e: indent a row under another, reload, still indented;
  outdent restores.
- **R89.31** — **Dependencies + timeline arrows** (matrix `:254`, `:255`):
  new `RowDependency { id, blockerId, blockedId, @@unique([blockerId, blockedId]) }`
  (both `Page`, cascade); UI: a "Dependencies" popover on timeline/gantt bars
  (add blocked/blocking rows from the same database, validated non-self,
  acyclic — write-time DFS over ≤ 500 edges, reject with a clear message);
  timeline draws SVG arrows between overlapping bars (`R89.11` window), board/
  list show a dependency badge (blocked count); overdue-blocked emphasis is
  out of scope. *Accept:* unit: cycle rejection + arrow path geometry;
  e2e: link two rows, arrow renders between their bars, cycle attempt shows
  the error toast.
- **R89.32** — **Relation/rollup columns participate in views** (coordination
  with B21 — no relation semantics here): once R21.x lands, `operatorsFor`
  gains a RELATION catalogue (is empty / is not empty / contains-page-id via
  R21.4's **scoped** options — options/values respect read scoping for guests),
  group-by supports RELATION, and rollup columns are filterable/sortable
  through R22.15's computed-column path. Until B21 lands, these types use the
  existing fallback (filter disabled with a "requires relations" hint — same
  pattern as the current FORMULA handling). *Accept:* unit: operator catalogue
  selection per type (enabled only when the dependency exists); e2e marked
  `test.skip` **only until B21 M1 lands**, then activated citing R21.4+R89.32
  together. (No skips ship in the final state — playbook rule.)
- **R89.33** — **Tenancy & guardrails (spans M1–M3)**: every new action
  (`moveRowAction`, `duplicateRowAction`, `duplicateDatabaseAction`,
  `submitFormAction`, dependency CRUD, description/lock/config writes) calls
  `requireUser` + `authorizeDatabase`/`getWorkspaceAccess` before any read;
  cross-workspace ids return the same generic error (no existence oracle, cf.
  R21.20/R9.7); view-config writes validate through `normalizeViewConfig`
  (never trust shape); new UI strings go through `t()` with
  `scripts/i18n-insert.mjs` only (no i18n-ratchet raise beyond measured
  coverage); a11y: every new control keyboard-reachable (`check:a11y` green).
  *Accept:* integration: outsider/foreign-workspace ids rejected on every new
  action; unit: config validation rejects malformed trees/widths/measure ids.

### Non-goals (this spec)

Side peek drawer & row-open UX (R29.1–R29.8), CSV mapping/create-database/
round-trip semantics (R23.x), relation/rollup/formula semantics (R21.x/R22.x),
template model/gallery/variables/recurrence core (R31.x), button action
execution (R27.x), AI autofill (R25.x), per-page permission inheritance and
share-link/public publishing (matrix §8 — unowned, O89.3), collab on row pages
(R9.x/O9.2), date range/reminders/timezone property rows (§4 `:280-282` — no
§3 owner), conditional formatting per-cell styles beyond row tinting,
median-of-group performance tuning beyond the bounded-load assumption.

## 5. Data model (schema deltas — M3 only)

```prisma
enum ViewType { TABLE BOARD LIST GALLERY CALENDAR TIMELINE CHART FORM }   // + FORM
enum PropertyType { … UNIQUE_ID BUTTON AI_AUTOFILL PLACE VERIFICATION }   // + PLACE, VERIFICATION

model Page {
  …
  schemaLocked Boolean  @default(false)  // database lock, R89.24 (DATABASE only)
  description  String?                   // R89.21
  subOfId      String?                   // R89.30 sub-items (self ref, SetNull)
  @@index([parentId, subOfId])
}

model Property {
  …
  seq Int @default(0)                    // R89.25 UNIQUE_ID allocation counter
}

model RowDependency {
  id         String @id @default(cuid())
  blockerId  String                     // Page that blocks
  blockedId  String                     // Page that is blocked
  blocker    Page @relation("DepBlocker", fields: [blockerId], references: [id], onDelete: Cascade)
  blocked    Page @relation("DepBlocked", fields: [blockedId], references: [id], onDelete: Cascade)
  createdAt  DateTime @default(now())
  @@unique([blockerId, blockedId])
  @@index([blockedId])
}
```

- `DatabaseView.config` (JSON) is **not** migrated — R89.1's keys are additive
  and defaulted on read; unknown keys preserved for forward-compat.
- `Template` changes (isDefault, kind, workspaceId, variables, locked) are
  **owned by `templates.md` §5** — not repeated here.
- Everything in this section lands in one `prisma db push` (Tier MAX gate per
  playbook), behind the M3 milestone.

## 6. UI spec (delta only — what B15's chrome gains)

- **View menu additions**: group-by picker (board/list/table), date-property
  picker (calendar/timeline), chart config (type/measure/group-by), gallery
  cover + size, calendar scale, "Manual order" toggle. All persist through
  `updateViewAction` config writes.
- **Filter panel**: tree rows with AND/OR group chips, drag-to-nest, per-group
  match toggle, depth unlimited (visual indent caps at 4, then "…").
- **Footer row**: sticky bottom row in Table view; click a cell → function
  picker (ROLLUP_FUNCTIONS); persists per view.
- **Row ⋯ menu**: Open as page · Duplicate · Move to… (group picker) · Delete
  (+ existing restore path untouched).
- **Templates menu** (R89.16): preview pane on hover, default star, Blank first
  when a default exists, recurrence `nextRunAt` (R89.17), Update-from-row.
- **Linked block** (R89.14): source chip (icon + title + view name + link),
  mode badge (Linked/Synced), in-block filter/sort with "Reset to source view".
- **Lock** (R89.24): toolbar ⋯ → "Lock database" (editSchema only); locked state
  shows a lock chip and disables property/view/import controls client-side.
- **New property editors**: Place (address input + saved-place list + map link),
  Verification (read-only chip + verify/unverify button), Button (label, style,
  action selector disabled until R27), Unique ID (prefix + pad).
- **Form view** (R89.29): builder = ordered question list (drag), required
  switches, accept toggle, preview; respondent = single-column card, inline
  validation, success state.
- **i18n/a11y**: all strings via `t()`; new glyphs follow the existing icon
  set; every control keyboard-reachable; drag operations have keyboard
  alternatives (row menu equivalents for R89.19/R89.30).

## 7. Security & tenancy

- Single authorization choke point: `authorizeDatabase` grows the R89.23
  capability gate; no renderer decides permissions (UI hiding is cosmetic).
- Linked/synced blocks: authorization is evaluated against the **source**
  database on every action; a synced-provenance write is refused server-side
  (R89.15). Blocks never widen access: a viewer without source access gets the
  placeholder, not a 404-vs-403 oracle (R9.7 pattern).
- `submitFormAction` (R89.29) re-authorizes per call; rate-limited; validated
  with the same value rules as direct cell writes (no validation bypass via
  forms).
- Unique ID allocation (R89.25) is server-computed; clients can neither choose
  nor forge ids; Verification stamps come from the session (R89.28).
- All new mutations run inside transactions where partial failure would strand
  data (duplicate database, form submit, move-row renormalization).

## 8. Edge cases

| Edge | Behavior |
| --- | --- |
| Two concurrent duplicate-row actions | Each gets its own transaction; position midpoint collisions trigger renormalization (R89.19 helper) — no duplicate positions allowed (`@@unique` not added; invariant enforced by renormalize-on-collision). |
| Unique ID counter contention | Row-level lock in the create transaction; 10 concurrent creates ⇒ 10 distinct sequential ids; failure rolls back the row. |
| Manual order vs active sorts | Drag disabled with tooltip; clearing sorts restores manual order (config remembers both). |
| Move row while a filter hides neighbours | Target is resolved by row id (visible neighbours only); hidden rows keep relative order. |
| Calendar span crosses months | Row appears in both months' cells; span styling per month segment (R89.10 unit). |
| Chart measure on all-empty column | "No data yet" empty state (existing `noDataYet`), never `NaN`. |
| Timeline drag over a locked database (rows still editable) | Allowed — date property is row data, not schema. |
| Linked source deleted/trashed | Block shows "Database unavailable"; normalizes back after restore; never throws. |
| Linked override JSON tampering | `normalizeViewConfig` clamps; unknown/broken tree ⇒ source view config used. |
| Synced write attempt | Server refusal (R89.15); client hides affordances. |
| Default template deleted while menu open | Menu refetch on error; creation falls back to blank row with a toast. |
| Recurrence fires while database locked | Rows may be created (editRows unaffected by schema lock); template schema edits refuse. |
| Form double-submit | Idempotency key per form session (client UUID) → one row. |
| Dependency cycle (A→B→A) | DFS rejects with "Circular dependency" toast; nothing written. |
| Sub-item depth > 1 (M3) | Indent refused at cap with tooltip; no cycles possible (parent must be same database, depth guard). |
| Place property with only an address | Map link uses query-string search; no coordinates required. |
| CSV column named like a system property | R23.1 mapping dialog forces an explicit choice (skip/create), never silent overwrite. |
| Lock bypass via API | Capability gate is server-side (R89.23/24); integration test hits actions directly. |

## 9. Test plan

**Unit (vitest, red-first, cite R89.x)**

1. ViewConfig normalization round-trip + unknown-key preservation (R89.1).
2. Filter-tree evaluation over a 3-level mixed tree (R89.2) — parity with
   today's flat filters for equivalent trees.
3. Group bucket derivation across types + collapse/order persistence (R89.3).
4. Footer/group/chart aggregation equals `aggregate()` outputs (R89.4, R89.12).
5. Colour-rule evaluation parity with filter operators (R89.5).
6. Calendar span expansion (1-day/3-day/cross-month) (R89.10).
7. Timeline offset/width math per scale + drag date-shift arithmetic (R89.11).
8. Cover resolution + content-preview clipping (R89.9).
9. Attr normalizer for linked nodes incl. legacy `databasePageId`-only nodes
   (R89.14).
10. Duplicate-row value filter (computed/system excluded, position insert)
    (R89.18).
11. Position midpoint math + renormalization boundaries (R89.19).
12. Capability predicate matrix: role × lock × PagePermission × capability
    (R89.23, R89.24).
13. Unique-ID formatting + allocation under concurrency (R89.25).
14. Place/Verification/Button config normalizers (R89.26–R89.28).
15. Form question resolution + required validation (R89.29).
16. Sub-item cycle/depth guard (R89.30); dependency cycle rejection + arrow
    geometry (R89.31).
17. Column order/width normalization (R89.13); duplicate-database copy plan
    (R89.22).

**Integration (actions, node scripts)**

18. Capability gate on every action in the §7 table (R89.23/24) — lock refuses
    schema, allows rows.
19. Linked write authz + synced refusal + placeholder for no-access viewer
    (R89.15).
20. Form submit: open/closed/invalid/double-submit (R89.29).
21. Recurrence driver → row with prefills, system actor recorded (R89.17).
22. Outsider/foreign-workspace ids generic-refused on all new actions (R89.33).

**e2e (Playwright — new `e2e/database-deep.spec.ts`, dedicated pages,
try/finally cleanup per playbook)**

23. Filter tree build → reload → intact (R89.2); group collapse persistence
    (R89.3); footer sum (R89.4); colour rule (R89.5); header quick filter
    (R89.6).
24. Board group-by switch + card create with group value (R89.7); calendar
    3-day span (R89.10); chart measure switch (R89.12); column resize/reorder
    (R89.13).
25. Linked block bound to a filtered view + override isolation (R89.14);
    synced read-only (R89.15).
26. Duplicate row with values (R89.18); drag-reorder persists (R89.19);
    duplicate database (R89.22).
27. Lock behavior in UI (R89.24); unique ids sequential (R89.25); verification
    chip (R89.28); form fill+submit → row (R89.29).
28. CSV toolbar import mapping dialog blocks unaccounted columns (R89.20 +
    R23.1).

Docs batch B89 runs **none** of the above (FAST/docs tier: no e2e, no build);
evidence for B89 = coherence gate green + this document.

## 10. Migration path (M1 → M2 → M3)

1. **M1 — engine + renderers (no schema)**: R89.1–R89.13. Ships behind the
   existing view chrome; all changes ride `DatabaseView.config`. Tier STANDARD
   (tsc/eslint/unit/coherence + targeted e2e on dev :3201). Existing databases
   need no backfill — R89.1 defaults everything.
2. **M2 — integration (no schema)**: R89.14–R89.22. Linked nodes normalize on
   read (legacy blocks keep working); `Page.description` is the one schema item
   — **move it to M3's push** or ship M2 with a single-column push; the
   milestone orders R89.21 last so the push happens once (decision: defer
   `description` to the M3 push). Row/template/import work depends on B21/B31/
   B23 landings only where §2.4 says so; otherwise independent.
3. **M3 — schema + permissions**: R89.23–R89.33 in one `prisma db push`
   (Tier MAX: build + prod restart + full e2e + domain checks per playbook).
   Order: capability gate first (no behavior change unlocked), then lock, then
   property types, then form/sub-items/dependencies. Existing rows: UNIQUE_ID
   properties backfill `seq` from `count(*)` in the migration task (ids start
   after existing rows — no collisions).

## 11. Delivery plan (milestones → tasks ↔ requirements)

**M1 — view-engine depth (~2–3 days)**

- T89.1 [R89.1]: ViewConfig keys + normalizer. Red: unit 1.
- T89.2 [R89.2]: filter-tree UI + persistence. Red: units 1–2, e2e 23.
- T89.3 [R89.3, R89.4]: groups/collapse + footer/group aggregation. Red: units 3–4, e2e 23.
- T89.4 [R89.5, R89.6]: colour rules + header quick filter. Red: unit 5, e2e 23.
- T89.5 [R89.7, R89.8]: board/list depth. Red: e2e 24.
- T89.6 [R89.9, R89.10]: gallery/calendar depth. Red: units 6, 8, e2e 24.
- T89.7 [R89.11, R89.12]: timeline + chart depth. Red: unit 7, e2e 24.
- T89.8 [R89.13]: column resize/order. Red: unit 17, e2e 24.

**M2 — integration (~2 days)**

- T89.9 [R89.14, R89.15]: node attrs + picker + authz. Red: units 9, integration 19, e2e 25.
- T89.10 [R89.16, R89.17]: templates integration (with B31). Red: integration 21.
- T89.11 [R89.18, R89.19]: duplicate/move row. Red: units 10–11, e2e 26.
- T89.12 [R89.20, R89.21, R89.22]: import wiring, description, duplicate database. Red: e2e 26, 28 (description moves to M3 push — see §10).

**M3 — permissions, properties, form, structural (~3–4 days, Tier MAX)**

- T89.13 [R89.23, R89.33]: capability gate + guards. Red: units 12, 22; integration 18, 22.
- T89.14 [R89.24]: lock. Red: integration 18, e2e 27.
- T89.15 [R89.25]: unique id (schema + backfill). Red: unit 13, e2e 27.
- T89.16 [R89.26, R89.27, R89.28]: button shell, place, verification. Red: unit 14, e2e 27.
- T89.17 [R89.29]: form view. Red: units 15, integration 20, e2e 27.
- T89.18 [R89.30, R89.31]: sub-items, dependencies. Red: unit 16.
- T89.19 [R89.32]: relation/rollup view participation (queued behind B21 M1). Red: unit 17's catalogue test.

## 12. Risks & open questions (honest)

**Risks**

1. **Config-JSON sprawl.** R89.1 puts 14 more keys in `ViewConfig`; malformed
   hand-edited configs are the likeliest crash source. Mitigation: one
   normalizer, unknown-key preservation, property-style tests over random
   configs.
2. **Scope gravity.** 36 rows in one spec can become one mega-batch — the
   playbook's 2–3-row cap applies. Mitigation: milestones ship as micro-slices
   (T89.x) with independent acceptance; M1 alone closes 13 rows.
3. **Two big dependencies.** R89.16/R89.17 wait on B31 (templates) and R89.32
   on B21 (relations); R89.20 on B23 (import). Mitigation: integration seams
   specified above so implementation batches can land the seam first and flip
   behavior when the dependency lands (no skipped tests at the end).
4. **Tier MAX consolidation.** All schema changes concentrate in M3 — one big
   push. Mitigation: columns are additive with defaults; the UNIQUE_ID backfill
   is idempotent.
5. **Drag interactions are e2e-flaky territory.** Mitigation: keyboard
   equivalents everywhere + unit coverage of the math (the DOM test only
   asserts the wiring).

**Open questions**

- **O89.1**: public (anonymous) form submission — share-link based, rate-limit
  strategy, spam defense. Internal forms specified (R89.29); public is a
  follow-up slice.
- **O89.2**: linked database instances under collab (two editors in different
  instances of the same source) — same source ydoc, so CRDT already merges; the
  open part is override attrs conflicting. Spec assumes attrs are CRDT-safe
  (small JSON in the parent doc).
- **O89.3**: per-view/per-user restrictions and §8's permission-inheritance
  model have **no owner spec yet**; R89.23 defines only the database-scoped
  split. If a future sharing spec lands, capabilities should derive from it.
- **O89.4**: manual order ↔ sort interaction is "drag disabled while sorted"
  — revisit if the product class allows a persisted manual order under sorts.
- **O89.5**: chart/gantt performance on large databases — databases load a
  bounded row set today (matrix `:238`); aggregation over >5k rows needs
  server-side rollups (future work, flagged in R89.4's accept criteria only
  for bounded loads).
- **O89.6**: if B21's relations ship first, should sub-items/dependencies be
  re-projected as system relation properties? Additive either way
  (`subOfId`/`RowDependency` stay canonical in M3).

## 13. Traceability — FEATURE_MATRIX rows → requirements

Section 3 (every 🧭 row addressed; Notes in the matrix were appended
append-only, glyphs untouched):

| Matrix row (§3) | Line | Requirements |
| --- | --- | --- |
| Board view | 199 | R89.7 (+R89.3, R89.1) |
| List view | 200 | R89.8 |
| Gallery view | 201 | R89.9 |
| Calendar view | 202 | R89.10 |
| Timeline view | 203 | R89.11 (+R89.31) |
| Chart view | 204 | R89.12 |
| Form view | 205 | R89.29 |
| AND/OR filter groups | 216 | R89.2 |
| Nested filter groups | 217 | R89.2 |
| Groups | 221 | R89.3 |
| Group aggregation | 222 | R89.4 |
| Hidden groups | 223 | R89.3 |
| Conditional formatting | 224 | R89.5 |
| Row color rules | 225 | R89.5 |
| Quick filter from header | 226 | R89.6 |
| Open row in side peek | 234 | *owned by navigation-ux R29.1–R29.8 (no change — already referenced)* |
| Linked database | 237 | R89.14, R89.15 |
| Row reordering | 241 | R89.19 |
| Column resize/reorder | 242 | R89.13 |
| Calculations/footer | 243 | R89.4 |
| Database description | 244 | R89.21 |
| Database lock | 245 | R89.23, R89.24 |
| Duplicate database | 247 | R89.22 |
| Sub-items / sub-tasks | 253 | R89.30 |
| Dependencies | 254 | R89.31 |
| Timeline dependencies | 255 | R89.31 (arrows in R89.11's window) |
| Calendar multi-day events | 256 | R89.10 |
| Gallery previews | 257 | R89.9 |
| Board grouping | 258 | R89.7 |
| Buttons in databases | 259 | R89.26 (execution: automations R27.x) |
| Database templates | 260 | R89.16 (model: templates R31.x) |
| Default template | 261 | R89.16 (semantics: R31.13) |
| Recurring templates | 262 | R89.17 (core: R31.18–R31.23) |
| CSV import | 263 | R89.20 (contract: R23.1, R23.2) |
| CSV export | 264 | R89.20 (contract: R23.5) |
| Unique ID property | 265 | R89.25 (section-4 twin `:300`, notes not edited — §4 is outside this batch) |

Section 4 twins referenced **without editing** (matrix §4 rows keep their own
ownership): Button `:301` → R89.26, Place `:302` → R89.27, Verification `:303`
→ R89.28, Unique ID `:300` → R89.25, Relation/Rollup `:290-295` → R21.x (+
R89.32), Formula `:289` → R22.x, AI autofill `:304` → R25.x.

**Cross-spec reference table (the anti-duplication contract):**

| This spec | References | Used by |
| --- | --- | --- |
| R89.1, R89.32 | R22.15 (computed columns in filter/sort) | filter/sort of FORMULA/ROLLUP columns |
| R89.16, R89.17 | R31.1, R31.13, R31.14, R31.18–R31.23 | default/preview/recurrence |
| R89.20 | R23.1, R23.2, R23.5, R23.6 | mapping dialog, round-trip, atomicity |
| R89.18, R89.32 | R21.3, R21.4 (validation + read scoping) | relation values on duplicate; relation filters |
| R89.26 | R27.x | action dispatch contract |
| R89.14, R89.15 | R9.7 semantics (no existence oracle) | unavailable-database placeholder |
| R89.23 | R21.20 pattern (tenancy guardrails), plans-licensing R26.x (grant gating) | capability gate |
| — | R29.1–R29.8, R25.x, R22.x, R9.x/O9.2 | explicit non-goals (§2.4) |
