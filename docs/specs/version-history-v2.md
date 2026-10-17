# Spec — Version history v2 (diff, named versions, retention, scheduled snapshots)

> **Status: spec complete, implementation pending.** Document-only: no
> production code changed. This document is the deliverable. Every claim about current code cites file + line. Requirement IDs
> (`R30.x`) are the traceability anchors: the delivery plan in §11 lists tasks
> 1:1 against them, and tests must cite the IDs they cover. Scope is FEATURE
> MATRIX **section 10 (Version history), rows `docs/FEATURE_MATRIX.md:441-449`**
> — 9 planned rows.

---

## 1. Problem statement

Noema already ships a working **v1** version history: every content/title save
snapshots the *previous* page state into a `PageVersion` row, a slide-over
panel lists them with author/time/char-delta, and any row can be restored in
one click. The matrix still marks all nine section-10 rows 🧭 because what
exists is a *timeline*, not a *history feature*: there is no way to see **what
changed** (no diff), to **mark a meaningful point** (no named versions), to
bound **how long snapshots accumulate** (no retention — unbounded growth), and
no **scheduled capture** (snapshots only happen when a save happens). Restore
itself carries correctness defects — most importantly the known
**`searchText`-bypass quirk** documented as D8 in
`docs/specs/realtime-collab.md:93-96`: a restored page is silently invisible
to search until the next edit.

The goal is Notion-class history: **diff any two points**, **name and pin
versions**, **selective restore** (range + block selection), **configurable
retention** with a sane default, **scheduled snapshot backstops**, and an
honest verdict on **per-block history** — all on top of the existing store,
not a rewrite, and coordinated with the realtime/CRDT spec (B09) where the two
overlap (cadence R9.13, restore-through-ydoc R9.14, block authorship O9.4).

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| Snapshot store | `prisma/schema.prisma:245-258` | `PageVersion { id cuid, pageId, title, content Json?, createdById String?, summary, charDelta, createdAt }`; `page` relation cascades on delete (`:255`); index is `@@index([pageId])` only (`:257`) — **no `(pageId, createdAt)` composite, no `label`, no `contentHash`, no FK on `createdById`** (`:250` is a bare string). |
| Snapshot write | `src/server/actions/pages.ts:234-251` | `updatePageAction` creates a version **whenever `contentResult.doc !== undefined || titleChanged`** (`:231-234`) — i.e. change detection is "content field was present", **not** "content differs from previous". Stores the *previous* title/content (`:240-241`), summary string (`:243-247`), `charDelta = after - before` (`:235-236,248`). Title-only renames also snapshot (delta 0). |
| Client save cadence | `src/components/editor/page-editor.tsx:107-144` | 600 ms debounce (`:139-141`), payload equality guard `lastSavedRef` (`:105,113-117`) — but the guard is **client-side only**; the server never compares to stored content. `onUpdate → persist` (`:378`), manual save button (`:501`). |
| FTS mirror on save | `src/server/actions/pages.ts:263-274`, `src/lib/search.ts:12-13` | Save path recomputes `searchText` via `pageSearchText(title, content)` in the same update. |
| Restore action | `src/server/actions/page-versions.ts:16-60` | `restorePageVersionAction`: loads version + page (`:18-27`), checks `getWorkspaceAccess` + `canEditContent` on `version.page.workspaceId` (`:30-33`), pushes a **pre-restore snapshot** so restore is undoable (`:35-45`), then `prisma.page.update` with `title` + `content` (`:48-54`), `revalidatePath("/w","layout")` (`:56`). |
| Restore defects | same | **(a) `searchText` bypass** — the update sets `title`/`content` only (`:50-53`); FTS goes stale until the next edit (D8, `docs/specs/realtime-collab.md:93-96`). **(b) null-content no-op** — `content: (version.content ?? undefined)` (`:52`): a version snapshotted from an empty page (`content: null`) makes the field *undefined* in the update, so **content is silently not overwritten** while the title is. **(c) summary date bug** — `` `Restored the version from ${new Date(version.id ? Date.now() : 0).toLocaleDateString()}` `` (`:42`) always renders *today*, never the restored version's date. **(d) dead delta** — `before`/`after` computed (`:35,47`) then discarded (`:57-58`, `charDelta: 0` hardcoded `:43`). **(e) no webhook / no `revalidateWorkspace`** — compare `pages.ts:278-279`. **(f) no `Page.locked` and no trashed-page check** — the page select (`:25`) omits `deletedAt`/`locked`; same advisory-lock class as D6 in `realtime-collab.md:88-91`. **(g) mild existence oracle** — "Version not found." (`:28`) vs permission error (`:32`) distinguishes a valid foreign-workspace version id. |
| History UI | `src/components/version-history.tsx:37-181` | Slide-over dialog (`:64-88`); row shows avatar/name (`:106-114`), relative time (`:21-31`), char-delta badge (`:124-136`), summary + title (`:138-145`); empty state (`:91-94`); **restore button only when `index !== 0`** (`:146-170`), restore → `safeAction` → toast → `router.refresh()` (`:150-164`). Row 0 is labeled `currentSuffix` " · current" (`:121`) and highlighted (`:102`). |
| "Current" semantics | `pages.ts:227-241` + `version-history.tsx:121,146` | The newest row stores the state **before the latest edit**, not the live content — yet it is labeled "current" and its restore is suppressed. Consequence: **the live content exists in no row**, and "undo the last edit via history" is impossible. |
| List limits | `src/server/queries.ts:104-115` (`take: 25`), `src/server/actions/page-menu.ts:127-139` (`take: 10`) | Two different caps, neither paginated, no load-more. Page route maps rows at `src/app/w/[slug]/[pageId]/page.tsx:188-200`. |
| Authorship resolution | `page.tsx:198` vs `page-menu.ts:155-172` | Two strategies: the page panel resolves authors **only among current workspace members** (`members.find(...)` → `null` → "unknown"); the ⋯-menu timeline looks up `User` rows directly (`:161-168`). Departed members render inconsistently between the two surfaces. `PageVersion` has no user relation (`schema.prisma:250`). |
| Trash path | `src/server/actions/pages.ts:450-469` (archive), `:471-496` (restore), `:499-515` (hard delete), `:324` (empty trash) | Soft delete keeps versions (cascade only fires on hard delete, `schema.prisma:255`). **No scheduled purge exists** — trash lives forever; recovery window is unbounded-by-default rather than configured. |
| Scheduled jobs | `src/app/api/cron/templates/route.ts:14-31` | The only cron endpoint: `CRON_SECRET` fail-closed (`:17-29`) + `rateLimit(request,"cron",12,60_000)` (`:30`). This is the house pattern for §9's scheduled snapshots. |
| Size guard | `src/lib/validation.ts:33,35-38,41-59` | Content capped at 2 MB (`MAX_PAGE_CONTENT_BYTES`), shape `{ type: "doc", content: ≤20 000 nodes }`. A full copy rides in every version row. |
| Tests | `docs/TEST_PLAN.md:89` (E9) | E9 is **planned, not implemented**: no unit test touches `page-versions.ts`, no e2e opens the history panel (grep across `src/**/*.test.ts` and `e2e/` finds none). |
| Cross-docs | matrix `:428,434,635,683` | An earlier audit claimed "version history with restore ✅" while the matrix plans all 9 rows — the glyph change is **maintainer-owned** (`docs:counts`); this change edits Notes only. Related rows outside section 10: "Page history" `:428` (points here), "Trash retention policy" `:434`, "Page snapshots" `:635`, "Version-history retention by plan" `:683`. |
| Collab interplay | `docs/specs/realtime-collab.md:80-83 (D3), :163-166 (R9.13), :167-170 (R9.14), :417-419 (O9.4)` | Under collab, N clients × per-save snapshots spam versions (D3); B09 will make the **server** the single writer and throttle to "at most once per 5 minutes per page of actual activity" (R9.13) — v2's cadence helper must be the *same* function. Restore must become ydoc-aware (R9.14); block-level attribution stays CRDT-bound (O9.4). |

### 2.2 What the product class (Notion) does

1. **Diff view** — open any version and see blocks **added / removed /
   changed** against the current state (or another point), not a char counter.
2. **Named versions** — label a saved point ("Launch copy", "Client review");
   names are pinned in the list and survive retention pruning.
3. **Restore to any point, incl. partial** — restore the whole page at a
   chosen point; select individual blocks from a diff and restore only those.
4. **Scheduled capture** — history advances on a cadence even between explicit
   saves, so a day of work is never one coalesced blob.
5. **Retention window** — full fidelity recent, thinned older, bounded total;
   plan-gated depth on paid tiers.
6. **Authorship everywhere** — who made each version, stable even after they
   leave the workspace.

### 2.3 Gaps → the 9 planned section-10 rows (matrix `:441-449`)

| # | Row (matrix) | v1 today | Gap v2 must close |
| --- | --- | --- | --- |
| 1 | Per-page history `:441` | ✅ panel + timeline exist (§2.1) | Pagination past 25/10 caps, consistent authorship (R30.11, R30.12); rows understate shipped state — glyph fix is the maintainers'. |
| 2 | Restore version `:442` | ✅ one-click restore | Correctness: `searchText` recompute, null-content write, lock/trash guards, summary/charDelta bugs (R30.1-R30.5); current-row semantics (R30.6). |
| 3 | Version diff `:443` | ❌ charDelta number only | Block-level diff engine + view (R30.8, R30.9). |
| 4 | Named versions `:444` | ❌ no label column | `label` + naming action + pinning + retention exemption (R30.10). |
| 5 | Auto-snapshot cadence `:445` | ❌ save-driven only | Change-detected 5-min cadence (R30.3) + scheduled backstop cron (R30.13). |
| 6 | Retention window `:446` | ❌ unbounded growth | Policy lib + cron enforcement + composite index (R30.7); plan-gating noted as O30.1 (matrix `:683`). |
| 7 | Version authorship `:447` | ⚠️ two divergent resolvers | Single tolerant resolution incl. departed users (R30.11). |
| 8 | Trash recovery window `:448` | ⚠️ soft delete, no window | Configured window + scheduled purge cascading versions (R30.15); coordinates with section-9 row `:434`. |
| 9 | Block-level attribution `:449` | ❌ whole-doc snapshots | Feasibility verdict + staged path: stable block ids first, CRDT origins for *authorship* (R30.16). |

## 3. Decisions

| # | Decision | Rationale / alternatives |
| --- | --- | --- |
| D1 | **Diff is a pure lib** `src/lib/version-diff.ts`, unit-harness first (tier rule: new complex domains start as lib + unit tests before components). | Alternatives: SQL/JSONB diff (untestable in isolation), editor-internal diff (requires mounted editor server-side). Content JSON is the shared denominator — diff two `PageVersion.content` snapshots structurally: align top-level nodes by `(type, position, text similarity)`, classify `added/removed/modified/unchanged`. Tables/nested lists diff as whole nodes in v2 (recursion = O30.3). |
| D2 | **Cadence + dedupe live in one pure helper** `shouldSnapshot(prev, next, now, opts)` shared by the action path today and B09's server-side writer (R9.13) tomorrow. | One source of truth prevents drift between collab and non-collab modes (the exact class of bug D3 describes, `realtime-collab.md:80-83`). Defaults: max 1 auto snapshot / 5 min / page; skip when `sha256(canonical JSON)` equals the newest row's hash; named + restore-point writes bypass both gates. |
| D3 | **Retention is tiers, not a single TTL**: full fidelity < 30 d, daily 30-90 d, weekly > 90 d, never prune `label != null` nor the newest row, hard cap 500 non-labeled rows/page. | A pure `retentionPolicy(now, rows)` function is trivially unit-testable; a TTL destroys exactly the long-tail history users regret losing. Values come from env (`VERSION_RETENTION_*`), not code (matrix `:446` "configurable"). |
| D4 | **Scheduled snapshots reuse the templates cron pattern** — `POST /api/cron/versions`, `CRON_SECRET` fail-closed + rate limit (`cron/templates/route.ts:14-31`). | No new infra; scheduler already points at a cron endpoint in deployments. The job is a *backstop*: it only writes when the newest hash differs (R30.13), so unchanged pages cost one indexed query. |
| D5 | **Block identity before block authorship**: add stable `id` attrs to top-level blocks (attrs live inside the content JSON — no Prisma migration for the doc itself; backfill by walk) to unlock per-block *diff/restore*; per-block *who-changed-it* stays deferred to CRDT change origins (O9.4, B09). | Honest feasibility: snapshots alone cannot attribute authorship per block — they are point-in-time copies. Positional diff (D1) degrades on heavy reordering; ids fix that. Claiming attribution without CRDT would be a false ✅. |
| D6 | **Restore stays a server action, gains transactional semantics**: one `prisma.$transaction` (pre-restore snapshot + page update with explicit `content` + `searchText` recompute), webhook + workspace revalidation matching `updatePageAction`. | Mirrors the save path so history and search can never disagree again (closes D8). Collab-aware application of the restore (into the ydoc) is B09's R9.14 — this spec must not duplicate it; v2 delivers the non-collab correctness half. |
| D7 | **Rows are immutable; labels are editable.** No manual version deletion UI (matches product class); operators bound growth via retention (D3). | Keeps "history can be trusted" invariant; avoids a delete-permission surface. |

## 4. Requirements (numbered, testable)

### M1 — Restore correctness + storage foundation

- **R30.1** — `restorePageVersionAction` recomputes `searchText` with
  `pageSearchText(version.title, version.content)` (`src/lib/search.ts:12`)
  inside the same `prisma.page.update` that writes `title`/`content`
  (`page-versions.ts:48-54`), closing the non-collab half of D8
  (`realtime-collab.md:93-96`).
  *Acceptance:* **red** action test first: seed page + version → restore →
  `check:search`-style FTS query matches the restored text (today it does not);
  `npm run check:search` stays 9/9.
- **R30.2** — Restore writes content **explicitly**: `content` is set to the
  version's JSON *or* an explicit DB null (`Prisma.DbNull`), never omitted via
  `?? undefined` (`page-versions.ts:52`). Title + content + pre-restore snapshot
  commit in one transaction; any failure rolls all back.
  *Acceptance:* **red** test: version snapshotted from an empty page → restore
  → live `content` is cleared (today the stale body survives while the title
  changes); a mid-transaction failure leaves page and versions untouched.
- **R30.3** — Snapshot cadence/dedupe helper (`src/lib/version-policy.ts`,
  decision D2): `updatePageAction` creates a `PageVersion` only when (a) the
  canonical-JSON hash differs from the newest row's hash **and** (b) the newest
  auto row is older than the cadence window (default 300 s, env
  `VERSION_SNAPSHOT_INTERVAL_S`). Labeled versions and restore-points bypass
  both gates. The identical helper is what B09's collab writer must call for
  R9.13.
  *Acceptance:* **red** pure tests on `shouldSnapshot` (same-hash skip, inside
  vs. outside window, labeled bypass, first-row always snapshots) + action
  test: two identical saves in a row → exactly 1 version row (today: 2 via any
  caller that bypasses the client `lastSavedRef` guard, `page-editor.tsx:113-117`);
  burst of saves inside 5 min → ≤ 1 auto row per window.
- **R30.4** — Restore guards: reject when `Page.locked = true` (generic
  message, aligned with the advisory-lock class D6, `realtime-collab.md:88-91`)
  and when the page is trashed; cross-workspace/foreign version ids return the
  **same generic error** as a missing id (no existence oracle, mirrors R9.7 /
  R21.2 house rule). Permission model stays `getWorkspaceAccess` +
  `canEditContent` (`page-versions.ts:30-33`).
  *Acceptance:* **red** matrix tests: member × locked × trashed ×
  guest × outsider × foreign-workspace-id — every non-allowed case yields one
  indistinguishable error string; allowed case restores.
- **R30.5** — Pre-restore snapshot integrity: summary cites the **restored
  version's date** (fix `new Date(version.id ? Date.now() : 0)` at
  `page-versions.ts:42`), `charDelta` is computed and stored (remove the
  `void before/void after` dead code at `:57-58`), and restore dispatches
  `page.updated` + revalidates the workspace exactly like `updatePageAction`
  (`pages.ts:278-279`).
  *Acceptance:* **red** tests: summary contains `version.createdAt`'s date, not
  "today" when they differ; `charDelta` = post-restore text length − pre-restore
  length; webhook spy fires once per restore.
- **R30.6** — Current-row semantics: the panel renders a distinct,
  non-restorable **"Current" header row built from live page content**, and
  *every* snapshot row (including the newest, today suppressed at
  `version-history.tsx:146` and mislabeled `:121`) gets a working Restore
  control — "undo the last edit from history" becomes possible.
  *Acceptance:* **red** e2e: edit → open history → current content shown as
  header (not as a snapshot) → newest snapshot restorable → restore reverts the
  last edit; a11y (`role="dialog"`, labels) unchanged/green under
  `check:a11y`.
- **R30.7** — Retention enforcement (decision D3): pure
  `retentionPolicy(rows, now, cfg)` + `POST /api/cron/versions` pruning pass
  (D4 pattern: fail-closed `CRON_SECRET`, rate-limited, idempotent); schema
  adds `@@index([pageId, createdAt])` replacing `@@index([pageId])`
  (`schema.prisma:257`). Invariants: never prune the newest row, never prune
  `label != null`, hard cap 500 non-labeled rows/page, tiers per D3.
  *Acceptance:* **red** policy tests (tier boundaries, invariants, cap) +
  integration: seed 1 000 rows across 40 days → cron returns pruned counts,
  newest + named survive, second run is a no-op. *(Schema change ⇒ this task
  ships Tier HEAVY: `prisma db push` under the build serialization.)*

### M2 — Visibility: diff, named versions, authorship, pagination

- **R30.8** — Diff engine `src/lib/version-diff.ts` (decision D1):
  `diffVersions(a, b)` aligns top-level nodes and returns
  `{ kind: "added"|"removed"|"modified"|"unchanged", aIndex, bIndex,
  preview }[]` plus recomputed aggregate deltas; deterministic for equal
  inputs; never throws on malformed/legacy JSON (falls back to whole-doc
  "modified").
  *Acceptance:* **red** unit fixtures: paragraph edit, block insert, block
  delete, block reorder, heading level change, table edit (whole-node), empty ↔
  content, null content ↔ content (the R30.2 shape), 20 000-node doc completes
  < 200 ms.
- **R30.9** — Diff view in the history panel: each snapshot row gets a
  "Changes" control opening a diff of **that version vs current content**
  (toggle: vs previous snapshot); added/removed/modified blocks rendered with
  distinct, non-color-only markers (a11y), keyboard-navigable, all strings via
  `t()` through the B07/B08 anchor-line discipline (no i18n ratchet raise —
  `check:coherence` baseline `i18nFiles ≥ 71` must hold).
  *Acceptance:* **red** e2e: edit a paragraph + add a block → open Changes →
  assert modified + added markers with the edited text; `check:a11y` green.
- **R30.10** — Named versions: schema `PageVersion.label String?` (≤ 100
  trimmed chars) + `nameVersionAction(versionId, label)` /
  `clearVersionLabelAction` guarded by `canEditContent`; labeled rows render a
  pinned badge in the panel, sort above auto rows, and are **exempt from
  retention** (R30.7) and from cadence gating (R30.3). Rows stay immutable
  otherwise (D7); clearing a label re-exposes the row to retention.
  *Acceptance:* **red** action tests: 101-char + empty + whitespace labels
  rejected, non-editor denied, label persists across rename of the page;
  retention seed keeps labeled rows and prunes unlabeled twins; panel shows the
  badge + pin order.
- **R30.11** — Authorship consistency: one resolver used by both surfaces
  (panel `page.tsx:198` and ⋯-menu `page-menu.ts:155-172`): look up the `User`
  row for `createdById` regardless of current membership; a user who left or
  was deleted renders a stable **"Former member"** (i18n key), never
  surface-dependent "unknown". Schema makes `createdById` an optional FK
  (`onDelete: SetNull` keeps history when a user is hard-deleted — no cascade
  of history).
  *Acceptance:* **red** unit/action tests: version authored by a member
  removed from the workspace shows the same label in panel and menu; deleted
  author → "Former member", `charDelta`/summary unaffected. *(FK ⇒ Tier HEAVY
  with R30.7's index — ship both in one `db push`.)*
- **R30.12** — Pagination: history reads move to a cursor action
  (`getPageVersionsAction(pageId, cursor)`, default 25, `createdAt`-cursor)
  replacing the fixed `take: 25` (`queries.ts:104-115`) and `take: 10`
  (`page-menu.ts:127-139`); panel grows "Load more"; the count badge shows the
  **total**, not the page size.
  *Acceptance:* **red** tests: 60 seeded versions → 3 pages, no duplicates or
  gaps across cursors, stable under concurrent new snapshots; badge = 60 while
  first page renders 25.

### M3 — Scheduled capture, ranges/selection, trash window, block history

- **R30.13** — Scheduled snapshot backstop: `POST /api/cron/versions` (D4
  pattern) walks pages changed since their newest auto snapshot, applies
  `shouldSnapshot` (R30.3), and writes **at most one** daily row per active
  page when the hash differs; inactive/unchanged pages write nothing. Returns
  `{ scanned, created, pruned }` for observability; runs the R30.7 pruning
  after capture.
  *Acceptance:* **red** integration (extend the cron test harness): page
  edited inside a cadence window → cron adds the backstop row after the window
  closes; unchanged page → zero rows; unconfigured/`wrong` secret → 503/401
  (mirrors `cron/templates/route.ts:17-31`); rate limit trips past 12/min.
- **R30.14** — Restore ranges & selection: (a) **range compare** — pick any two
  versions in the panel (from/to) and diff across the range (reuses R30.8
  pairwise; shows aggregate added/removed counts for the span); (b)
  **range restore** — restore the older endpoint of a selected range in one
  confirm step (single transaction per R30.2); (c) **selection restore**
  (stretch, same milestone) — in a diff, check individual changed blocks and
  restore *only those* by merging their nodes into live content by id/position
  (depends on D5 ids for reorder-safe merges; falls back to position merge with
  a confirmation warning when ids are absent).
  *Acceptance:* **red** tests: range diff of v1→v3 equals composed pairwise
  deltas; range restore lands exactly v1's content with one pre-restore
  snapshot; selection restore merges 1 of 3 changed blocks, leaves the other
  two and unrelated blocks byte-identical; missing-id fallback warns and still
  merges deterministically.
- **R30.15** — Trash recovery window: env `TRASH_RETENTION_DAYS` (default 30)
  enforced by the same cron (R30.13's prune phase): pages with
  `deletedAt < now - window` are hard-deleted, cascading their versions
  (`schema.prisma:255`); within the window, trashing never touches versions and
  `restorePageAction` (`pages.ts:471-496`) keeps working. History panel is
  unreachable for trashed pages today (`page.tsx:49`) — unchanged. Coordinate
  defaults with section-9 row "Trash retention policy" (`:434`) so one env var
  governs both (O30.1).
  *Acceptance:* **red** integration: seeded trash older than window → purged +
  versions gone; newer trash + its versions survive; `emptyTrashAction`
  (`pages.ts:324`) still bypasses the window explicitly.
- **R30.16** — Per-block history feasibility (decision D5), delivered in two
  labeled stages:
  **(a) stage 1 — ids**: a pure `ensureBlockIds(doc)` assigns stable `attrs.id`
  (nanoid) to top-level nodes lacking one, applied on save and on import, so
  R30.8 diffs and R30.14(c) selections key on ids; ids round-trip through save
  → version → restore unchanged.
  **(b) stage 2 — attribution**: per-block *authorship* requires CRDT change
  origins (B09 `O9.4`, `realtime-collab.md:417-419`); until B09 lands, matrix
  row `:449` remains 🧭 and this spec ships **no** per-block author claim —
  only per-block *change* detection (stage 1).
  *Acceptance:* **red** unit tests: idempotent id assignment, ids stable across
  a save/restore round-trip, diff-by-id survives block reorder (position-only
  diff must fail this test first — red-first proves the gap); stage-2 gate =
  B09's `changeOrigin` plumbed into snapshots, tracked as O9.4 not here.

### Non-goals (this spec)

Real-time co-editing (B09), version share links / public history, cross-page
history browser, infinite undo (editor history stays separate), property-value
history for database rows (row edits do not currently snapshot — O30.2),
compressing snapshots with a custom codec (Postgres JSONB toast already
compresses), per-plan UI gating (O30.1).

## 5. Data model

```prisma
model PageVersion {
  id          String   @id @default(cuid())
  pageId      String
  title       String
  content     Json?
  createdById String?                  // becomes optional FK → User, onDelete: SetNull (R30.11)
  summary     String?
  charDelta   Int?
  label       String?                  // R30.10 named versions; null = automatic row
  contentHash String?                  // R30.3 sha256 of canonical JSON; backfilled lazily
  createdAt   DateTime @default(now())

  page     Page  @relation(fields: [pageId], references: [id], onDelete: Cascade)
  createdBy User? @relation(fields: [createdById], references: [id], onDelete: SetNull)

  @@index([pageId, createdAt])         // R30.7 — replaces @@index([pageId])
}
```

- `Page.content` / `Page.searchText` stay the durable, FTS-indexed copy;
  `PageVersion.content` is a **snapshot**, never FTS-indexed (restore brings
  text back into `searchText` per R30.1).
- Existing rows need no backfill migration: `label`/`contentHash` are nullable;
  `contentHash` computes on first touch (R30.3) — old rows simply re-hash on
  their next comparison. Schema change ⇒ Tier HEAVY (`prisma db push`) when this
  spec is implemented; **this change is docs-only and touches no schema**.
- Env knobs: `VERSION_SNAPSHOT_INTERVAL_S` (300), `VERSION_RETENTION_FULL_D`
  (30) / `VERSION_RETENTION_MED_D` (90) / `VERSION_RETENTION_MAX_ROWS` (500),
  `TRASH_RETENTION_DAYS` (30).

## 6. UI spec

- **Panel** (`version-history.tsx`): header (title + total count) →
  **Current** row (live content, no restore) → snapshot list: labeled rows
  pinned with badge, then auto rows newest-first, each with author ("Former
  member" fallback), relative time, char delta, summary/title, and two
  controls: **Changes** (R30.9) and **Restore** (R30.6, all rows) → "Load
  more" (R30.12). Selecting a second row while Changes is open switches to
  **range compare** (R30.14a) with a "Restore older" confirm.
- **Diff view**: side-by-side on ≥ 768 px, stacked below; per-block markers
  added / removed / modified with text (not color alone), aggregate "+n −m
  chars" header, block checkboxes for selection restore (R30.14c), Esc closes
  and returns focus to the invoking row.
- **Naming**: ⋯-inline "Name this version" on a row (prompt dialog →
  `nameVersionAction`), rename/clear from the pinned badge menu. All strings
  via `t()`; new keys land in all 5 locales in the same change (i18n test
  parity), anchored with the i18n key inserter.
- **A11y**: panel keeps `role="dialog"` + aria-labels (`:66-75`), diff is
  keyboard-reachable, restore/naming remain buttons (existing patterns).

## 7. Storage & growth strategy

**Today's growth model (the problem):** one full JSON copy per qualifying
save; cadence = 600 ms debounce (`page-editor.tsx:139-141`) × N clients under
collab (D3, `realtime-collab.md:80-83`); content up to 2 MB/page
(`validation.ts:33`); **no dedupe, no cap, no retention, no pruning anywhere**
(grep: no `pageVersion.deleteMany` in `src/` or `scripts/`). A heavy editing
day ≈ one row per pause ≥ 600 ms — hundreds of rows, each a full copy.

**Levers (in order of leverage):**

1. **Write-rate bound (R30.3)** — hash dedupe kills no-op/burst rows at the
   source; 5-min cadence bounds worst case to 12 auto rows/hour/page and is
   byte-identical to B09's R9.13 throttle (one helper, D2).
2. **Stock bound (R30.7)** — tiered retention (30 d full → 90 d daily →
   weekly) + hard cap 500 non-labeled rows ⇒ steady state ≈ low hundreds of
   rows/page regardless of how long the workspace lives; labeled rows are the
   user-curated exception (their cost is visible: count badge).
3. **Byte bound** — snapshots ride in JSONB, which is TOAST-compressed
   server-side (≈ 3-6× on repetitive ProseMirror JSON); no custom codec (a
   non-goal). The 2 MB content cap bounds the per-row worst case.
4. **Index bound (R30.7)** — `(pageId, createdAt)` serves both the panel query
   and the retention scan (`WHERE pageId = ? AND createdAt < ?`) without a
   sort; the cron prune is batched per page, idempotent, and returns counts.
5. **Trash coupling (R30.15)** — versions die with their page only through the
   *windowed* hard-delete path (cascade `schema.prisma:255`), so abandoned
   drafts don't pin history forever.

**Measurement:** cron returns `{ scanned, created, pruned }`; the implementer
adds a one-line note to the ops notes if a seeded 100 k-row
prune exceeds 5 s (batch size knob) — honest numbers, no invented benchmarks.

## 8. Test plan

**Unit (vitest, red-first — pure libs first)**

1. *Cadence/dedupe* — `shouldSnapshot`: same hash skip; inside/outside window;
   labeled + restore-point bypass; first row always writes (R30.3).
2. *Retention* — `retentionPolicy`: tier boundaries (30/90 d), newest-row and
   labeled invariants, 500-row cap, empty/one-row inputs (R30.7).
3. *Diff engine* — fixtures: edit/insert/delete/reorder/heading/table/null↔content;
   determinism; malformed-JSON fallback; 20 k-node perf smoke (R30.8).
4. *Block ids* — idempotence, round-trip through save→version→restore,
   reorder-safety (**red-first**: positional diff must fail before ids pass)
   (R30.16a).
5. *Label validation* — 100-char boundary, trim, empty reject (R30.10).
6. *Author resolution* — departed/deleted author → "Former member", both
   surfaces equal (R30.11).

**Action/integration (vitest + prisma, dedicated pages + try/finally cleanup)**

7. *Restore correctness* — `searchText` recomputed and FTS-matchable (R30.1,
   **the D8 regression guard**); null-content version clears body (R30.2);
   transaction rollback (R30.2).
8. *Restore guard matrix* — locked/trashed/guest/outsider/foreign-id → single
   generic error (R30.4).
9. *Restore side-effects* — summary date, `charDelta`, `page.updated` webhook,
   workspace revalidation (R30.5).
10. *Snapshot cadence end-to-end* — identical saves → 1 row; burst → ≤ 1 per
    window (R30.3).
11. *Cron* — secret fail-closed 503/401, rate limit, backstop capture on/off,
    prune counts idempotent, trash window purge (R30.13, R30.15); extends the
    `cron/templates` harness pattern.

**e2e (Playwright, new `e2e/version-history.spec.ts`, dedicated prisma pages)**

12. *Timeline + restore* — edit → panel lists row with author/relative
    delta → restore newest snapshot reverts the last edit (R30.6) → FTS finds
    restored text (R30.1).
13. *Diff view* — edit + add block → Changes shows modified + added markers
    (R30.9); range compare picks two rows (R30.14a).
14. *Named version* — name → badge pinned above auto rows → survives a seeded
    retention prune (R30.10).
15. *Pagination* — 60 versions → Load more, count badge = 60 (R30.12).

**Non-regression:** `check:search` 9/9, `check:a11y`, existing editor/collab
e2e untouched (collab off in CI builds); `check:coherence` must stay
**COHERENT** (baseline `unwrappedCallSites 11`, `unsafeCallSites 7`,
`i18nFiles 71` — no ratchet raises to make gates pass).

**Feasibility:** items 1-6 are cheap pure tests (the real gate); 7-11 use the
existing action-test + cron-harness patterns; 12-15 are ordinary serial e2e on
dev :3201 — none require a new server or the collab process.

## 9. Migration path (existing data)

1. **No content migration.** `label`/`contentHash` are nullable; existing
   `PageVersion` rows load unchanged and hash lazily on first comparison
   (R30.3). The composite index replaces `@@index([pageId])` in the same
   `prisma db push` (Tier HEAVY, build serialization) as the `createdById` FK.
2. **FK adoption for existing rows**: `createdById` strings that no longer
   resolve to a `User` simply render "Former member" (R30.11) — the FK is
   added as *optional*; unmatched legacy ids are preserved as-is (no data
   rewrite, no history loss).
3. **Retention starts from deploy date**: the first prune run only sees
   seeded/aged rows; tier math is pure (R30.7), so a re-run after env changes
   converges without special casing.
4. **Search self-heals**: after R30.1, any page restored post-deploy is
   FTS-correct; pages restored *pre*-deploy stay stale until their next edit or
   a one-off backfill (`npm run setup:search` recomputes mirrors — cheap,
   documented as an optional ops step).

## 10. Delivery plan (milestones → tasks ↔ requirements)

> Test-first rule applies: every task's
> acceptance is a red test citing its requirement IDs before implementation.

**M1 — Correctness + storage foundation (~2-3 days; schema part = Tier HEAVY)**

- T30.1 [R30.1, R30.2]: transactional restore with explicit content + FTS
  recompute. Red: tests 7.
- T30.2 [R30.4, R30.5]: restore guards + side-effects (summary/charDelta/
  webhook). Red: tests 8, 9.
- T30.3 [R30.3]: `version-policy` lib + `updatePageAction` wiring. Red: tests
  1, 10.
- T30.4 [R30.7, R30.11]: schema (`label`, `contentHash`, composite index,
  author FK) + retention policy + cron prune — **one `prisma db push` under
  the lock**. Red: tests 2, 11(prune).
- T30.5 [R30.6]: current-row panel semantics + restore on newest row. Red:
  e2e 12.

**M2 — Diff + naming + authorship + pagination (~3-4 days)**

- T30.6 [R30.8]: `version-diff` lib. Red: tests 3.
- T30.7 [R30.9]: Changes view + a11y + i18n keys. Red: e2e 13.
- T30.8 [R30.10]: label column wiring + naming actions + pinning. Red: tests
  5, e2e 14.
- T30.9 [R30.11]: shared author resolver ("Former member"). Red: tests 6.
- T30.10 [R30.12]: cursor action + Load more + total badge. Red: tests 15.

**M3 — Scheduled capture + ranges + trash window + block ids (~3-5 days)**

- T30.11 [R30.13]: `/api/cron/versions` capture backstop (+ prune phase).
  Red: tests 11(capture).
- T30.12 [R30.15]: trash window purge in the same job. Red: tests 11(trash).
- T30.13 [R30.14]: range compare/restore, then selection restore. Red: test 3
  (add a range-composition fixture: diff(v1,v3) ≡ diff(v1,v2) ∘ diff(v2,v3))
  + e2e 13(range).
- T30.14 [R30.16a]: `ensureBlockIds` on save/import + id-based diff/merge.
  Red: tests 4. (Stage 2 attribution = B09 gate, O9.4 — not scheduled here.)

## 11. Risks & open questions (honest)

**Risks**

1. **Diff quality on structure-heavy docs (highest user-visible).** Tables,
   nested lists and heavy reordering are where positional alignment (D1)
   misleads; stage-1 block ids (R30.16) are the mitigation and land only in M3
   — M2's diff must therefore label reordered blocks conservatively ("moved?")
   rather than invent precision.
2. **Retention deleting something a user wanted.** Tiered policy + labeled
   exemption + newest-row invariant (D3, R30.7) are the guards; defaults are
   deliberately generous (30/90 d) and env-tunable; the prune returns counts
   for audit. Still the one requirement where a bug loses data irrecoverably —
   it gets the invariant-heavy unit suite (test 2).
3. **Two-spec overlap with B09 (cadence + restore).** R30.3's helper and
   R9.13's throttle must be one function, and R9.14 (ydoc-aware restore) will
   touch `page-versions.ts` too. Mitigation: this spec's M1 lands the
   non-collab correctness half with tests that B09 must keep green; file
   ownership: whoever implements second re-derives from both specs, not from
   the first diff.
4. **Tier HEAVY schema push contention.** R30.7 + R30.11 need `db push`
   (shared `.next`/DB rules, build serialization): make it one push with
   build+prod restart, restart dev :3201 after.

**Open questions**

- **O30.1** — Retention/trash defaults vs. matrix `:683` "Version-history
  retention by plan": Noema is self-hosted, so "plan" ≈ deployment config.
  Env vars now (this spec); workspace-admin UI and plan tiers deferred until a
  pricing row is actually built. Coordinate `TRASH_RETENTION_DAYS` with the
  section-9 row `:434` owner so two envs don't drift.
- **O30.2** — Database **row** pages are `Page` rows but property writes don't
  go through `updatePageAction`, so rows have no versions. Is row-property
  history in scope for section 10? Spec assumes **no** (page-level history
  only); if yes, it needs its own snapshot hook in the property setter —
  separate slice.
- **O30.3** — Diff recursion depth: v2 diffs tables/nested lists as whole
  nodes. If users hit that wall, recurse per table row using the same id
  machinery (R30.16) — cheap follow-up, not speculative work now.
- **O30.4** — Should restore also dispatch a dedicated `page.restored`
  webhook/activity entry (audit trail) instead of reusing `page.updated`
  (R30.5)? R30.5 mandates `page.updated` for parity; a distinct event name is
  additive and can ride along without breaking consumers — decide at
  implementation with the webhooks row owner.
