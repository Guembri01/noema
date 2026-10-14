# Spec — Search deep: scope, filters, recents, palette, ranking (section 11)

> **Status: spec complete, implementation pending.** Batch **B78** of the parity
> loop (docs-only; no production code changed). This document is the
> deliverable. Every claim about current code cites file + line. Requirement IDs
> (`R78.x`) are the traceability anchors: the delivery plan in §10 lists tasks
> 1:1 against them, and tests must cite the IDs they cover. Scope is FEATURE
> MATRIX **section 11 (Search), rows `docs/FEATURE_MATRIX.md:456-466`** — 11
> rows (3 ✅ · 2 🟡 · 6 🧭 per scoreboard `:781`). Matrix edits by this batch
> are **append-only** (`Spec: docs/specs/search.md.` appended to the section-11
> Notes cells); no status glyph is changed here.
>
> **Sibling ownership (wave 2, still running — READ-only for this spec):**
> **B39** owns `e2e/search.spec.ts` (`scripts/parity-state.json:160-164`) and
> **B43** owns the command palette — `quick-find.tsx` extension, new
> `command-palette.tsx`, the `workspace-shell` keybinding, `fuzzy.ts`
> (`scripts/parity-batches.json:666-675`, `parity-state.json:175-179`). This
> spec designs *around* them: every requirement below that touches those files
> names the coordination point instead of assuming ownership.

---

## 1. Problem statement

Noema's search **works and is fast**: a Postgres FTS pipeline (`Page.searchText`
mirror + GIN index + `ts_rank` + `ts_headline`) backs a search page with
pagination and a ⌘K quick-find palette, all guest-scoped and e2e-locked. What
it is not yet is Notion-class *finding*:

- **No narrowing.** The search page is a single `q` input
  (`src/app/w/[slug]/search/page.tsx:38-47`) — no type, teamspace, creator or
  date filters, and no way to say "only databases" (matrix `:459`, `:460`).
- **Nothing is remembered.** An empty palette query shows exactly one item —
  "Create a new page" (`src/components/quick-find.tsx:97-104`; e2e asserts
  `option` count 1 at `e2e/search.spec.ts:230-231`). No recent searches, no
  recently-visited fallback (matrix `:461`).
- **Relevance stops at the word boundary.** The prefix pass runs *only* when
  the exact pass returns zero hits (`src/server/queries.ts:292`), so it can
  never improve a ranking, and there is no typo tolerance at all
  ("relevnt" finds nothing). Meanwhile the matrix still marks ranking and
  snippets 🧭 (`:463`, `:464`) although `ts_rank`/`ts_headline` ship today —
  doc drift, recorded as D78.5 below, **not** fixed by glyph edits here.
- **Scope is enforced after the window, not in it.** Guest visibility is a
  post-`LIMIT` `.filter()` (`src/server/queries.ts:330`), the empty-query branch
  ignores it entirely (`:262-271`), and the v1 API route never passes it
  (`src/app/api/v1/search/route.ts:25`) — three ways the "palette can never
  surface a page the viewer may not open" promise (`src/server/actions/search.ts:16-19`)
  can be bent.
- **The fuzzy matcher has no consumer.** `src/lib/fuzzy.ts` (`fuzzyMatch:36`,
  `fuzzyFilter:70-77`) is imported only by its own test
  (`src/lib/fuzzy.test.ts:2`) — B43 will wire it, and this spec defines what
  the search side must hand it.

The goal is: **correct scope first** (defects D78.1–D78.3), then **filters,
recents, blended fuzzy ranking, highlighted snippets and full keyboard
navigation** — reusing the shipped FTS pipeline, with zero schema changes.

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| Index & backfill | `scripts/setup-search.mjs:23-27` (GIN over `to_tsvector('english', coalesce("searchText","title"))`, `IF NOT EXISTS`), backfill loop `:30-41` (skips equal rows `:37`), usability probe `:43-47`; wired as `npm run setup:search` (`package.json:34`) | Shipped, idempotent, re-runnable |
| Mirror formula | `src/lib/search.ts:12-15` (`pageSearchText`, 100 000-char cap) mirrored verbatim by `setup-search.mjs:19-20` | Title + flattened ProseMirror block text only — no comments, no database-row properties, no file names |
| Mirror write paths | create `src/server/actions/pages.ts:73-83`, update `:271`, duplicate `page-menu.ts:264-280`, **restore** `page-versions.ts:70-72` (closes the old D8 bypass, red-proven by `page-versions.test.ts:90-96`) | Covered — **except** the creators listed in D78.6 |
| Query engine | `src/server/queries.ts:243-342`: pass 1 exact `websearch_to_tsquery` + `ts_rank` + `ts_headline` (`:274-287`, `LIMIT take+1` `:286`, errors swallowed to `[]` `:287`), pass 2 prefix `term:*` **only if pass 1 empty** (`:291-312`, condition `:292`), pass 3 substring fallback for un-backfilled mirrors (`:315-328`) | Working; ranking = single-pass (G78.6) |
| Snippets | `ts_headline` options `'StartSel=, StopSel=, MaxWords=18…'` (`queries.ts:277-278, 300-301`) — **empty** delimiters; fallback `makeSnippet` (`src/lib/search.ts:27-35`) cuts ±120 chars around the first match | Snippet text ships and renders (`search-results.tsx:69`, `quick-find.tsx:124-128`) but **no term highlighting** |
| Guest scope | `src/lib/guest-access.ts:46-78` (`guestVisiblePageIds`), `:84-91` (`pageScopeFor` → `null` for non-GUEST `:89`); applied at `search/page.tsx:28` and `actions/search.ts:29` — but **post-LIMIT** at `queries.ts:330`, **absent** in the empty branch `:262-271` | Correct for the tested cases; three holes (D78.1–D78.3) |
| Search page | `src/app/w/[slug]/search/page.tsx:29-31` (empty `q` → no results at all), GET form `:38-47`, results list `src/components/search-results.tsx:58-78` (plain links — tab/Enter only) | Server-rendered, i18n'd (`t(locale, …)` `:55, :75, :88`) |
| Pagination | `searchPagesPaged` (`queries.ts:349-366`, take clamped 1..100 `:355`, `take+1` peek `:358-361`), `loadMoreSearchAction` (`actions/search.ts:41-71`), "Load more" appends (`search-results.tsx:40-50`), e2e 60-page proof `e2e/noema.spec.ts:1175-1209` | Shipped ✅ — but **OFFSET**, while the component docstring claims "keyset" (`search-results.tsx:17-19`) → D78.4 |
| Quick find | `src/components/quick-find.tsx`: 180 ms debounce (`:36-56`, `:52`), `cmdk` with `shouldFilter={false}` (`:78-81` — server results are final), one always-on create item (`:97-104`), pages group `:106-133`, 8 results max (`actions/search.ts:30`) | Works; no recents, no commands, no filters |
| Entry points | ⌘K/Ctrl+K listener `src/components/workspace-shell.tsx:82-89`, palette mounted `:157`; sidebar button `sidebar.tsx:130`, footer menu item `sidebar/sidebar-footer.tsx:87`; matrix `:421` ✅ "Sidebar search opening quick find" | Two entry points, one component — the "single entry point" row `:462` is B43's merge |
| Fuzzy matcher | `src/lib/fuzzy.ts:36` (`fuzzyMatch`), `:70-77` (`fuzzyFilter`); consumers = `src/lib/fuzzy.test.ts:2` only (repo grep `from "@/lib/fuzzy"` → test file alone) | Built, tested, **unwired** (B43) |
| v1 API | `src/app/api/v1/search/route.ts`: rate limit `:11`, bearer auth `:13-14`, workspace access `:22-23`, then `searchPages(workspaceId, query)` **with no scope** `:25` | D78.3 |
| Second engine (AI) | `queries.ts:633-663` `searchPagesForPrompt`: loads up to 500 pages and scores in memory (`:640-654`), no guest scope | Divergent ranking + same scope question; chat-only today (`src/lib/chat-context.ts:121`) |
| Domain checks | `scripts/check-search.mjs` — **9 checks**: index `:52`, ranking `:63-64`, bearer API `:85-94`, page render/snippet `:101-102`, prefix `:104-111`, trash exclusion `:113-120`, mirror freshness `:122-133`, exit code `:140`; `package.json:33` | Green (9/9) per matrix `:456` |
| e2e | `e2e/search.spec.ts`: FTS by title `:166`, empty state `:189`, empty query `:200`, Ctrl+K palette flow `:212` (Enter `:176`, `Control+k` `:223`, option-count 1 `:230-231`), sidebar button `:256` (Escape `:287`); guest search scoping `e2e/noema.spec.ts:1142-1173` | B39's file — READ-only here; **no ArrowUp/Down assertion anywhere** |

### 2.2 What the product class (Notion) does

1. **Filters in the results header** — type (page/database/view), owner, date
   edited/created, teamspace — combinable, persisted in the URL, shareable.
2. **Recents when you haven't typed yet** — the palette opens on recently
   visited pages and recent searches, per workspace, clearable.
3. **Fuzzy, typo-tolerant matching** — "roadmap" is found from "roadmap",
   "radmap", or the wrong-but-close stem; matches are *merged* into one ranked
   list, never a fallback-of-last-resort.
4. **Highlighted previews** — the matched terms glow in title + snippet.
5. **Keyboard-complete** — ↑/↓/Home/End/Enter/Esc works in the palette *and*
   the results list; every row reachable without a mouse.
6. **Scope is invisible-but-absolute** — a guest, a token, or a member of
   another workspace never sees a page it cannot open, including in recents.

### 2.3 Gaps → the 6 planned + 2 partial section-11 rows

| # | Gap | Evidence | Rows fed |
| --- | --- | --- | --- |
| G78.1 | No result filters (type/teamspace/creator/date) | `search/page.tsx:38-47` (only `q`), `search-results.tsx` has no filter UI | `:459` |
| G78.2 | No type narrowing despite `type` being in every result row | `queries.ts:258` selects `type`; nothing filters on it | `:460` |
| G78.3 | No recents / recent searches anywhere | empty branch returns `[]` (`actions/search.ts:27`), empty `q` renders nothing (`page.tsx:31`, asserted by `e2e/search.spec.ts:200-210`) | `:461` |
| G78.4 | Palette = pages + one create item; fuzzy matcher unwired | `quick-find.tsx:97-133`; `fuzzy.ts` test-only consumer | `:462` |
| G78.5 | Snippets have no highlighted terms | `StartSel=`/`StopSel=` empty (`queries.ts:278`) | `:463` |
| G78.6 | Prefix pass cannot affect ranking; no typo tolerance | prefix only when pass 1 is empty (`queries.ts:292`); `searchTerms` drops 1-char terms and caps at 8 (`src/lib/search.ts:18-24`) | `:459`, `:464` |
| G78.7 | Scope holes: post-LIMIT filter, unscoped empty branch, unscoped API | `queries.ts:330`, `:262-271`, `api/v1/search/route.ts:25` | `:456`, `:465` |
| G78.8 | FTS-indexed content misses several creation paths | see D78.6 | `:458` |
| G78.9 | OFFSET paging mislabeled "keyset"; duplicates/skips possible under writes | `search-results.tsx:17-19` vs `actions/search.ts:54-56` + `queries.ts:356-364` | `:465` |
| G78.10 | Keyboard nav unproven: palette arrows unasserted, results list has none | `search.spec.ts` presses only Enter/`Control+k`/Escape (`:176`, `:223`, `:287`); results are plain links (`search-results.tsx:58-78`) | `:466` |

**Defects this spec makes the implementation close first:**

- **D78.1 — guest windows shrink.** Visibility is filtered *after*
  `LIMIT take+1 OFFSET` (`queries.ts:330`), so a guest whose first 51 ranked
  hits include 20 hidden pages sees ~31 results in a "50" window and the
  Load-more maths (`queries.ts:361-364`) drifts. The guest e2e
  (`noema.spec.ts:1142-1173`) only queries one-match strings, so it cannot
  catch this.
- **D78.2 — empty-query scope bypass.** `searchPages` with `q=""` returns
  workspace-wide recent pages with **no** `visiblePageIds` filter
  (`queries.ts:262-271`). `loadMoreSearchAction` never validates `query`
  (`actions/search.ts:41-56`), so a guest can call that server action with
  `query: ""` and read titles/icons/types of private pages.
- **D78.3 — v1 API ignores guest scope.** `api/v1/search/route.ts:25` calls
  `searchPages(workspaceId, query)` with the default `visiblePageIds = null`
  (`queries.ts:247`) while the page (`page.tsx:28`) and the palette
  (`actions/search.ts:29`) both scope. A GUEST-role token over-reads.
- **D78.4 — "keyset" docstring on offset paging** (`search-results.tsx:17-19`).
  Harmless today, but the claim is false; windows shift when pages are
  created/edited mid-scroll.
- **D78.5 — matrix note drift (no glyph changes from this batch).**
  `:458` says "Basic; no ranking" although `ts_rank` orders results
  (`queries.ts:283`); `:463`/`:464` say 🧭 although snippets and ranking ship.
  The honest reading: *content* ranking exists but is single-pass, and
  snippets exist but are unhighlighted — which is what R78.8/R78.9 build on.
  Wording refresh is an orchestrator call (`docs:counts`/`docs:gaps` are
  orchestrator-only, playbook §"Ordering strategy").
- **D78.6 — mirror freshness depends on the writer.** `pageSearchText` is set
  by pages/page-menu/page-versions (`pages.ts:83,271`,
  `page-menu.ts:280`, `page-versions.ts:72`) but **never** by
  `src/server/actions/import.ts` (no `searchText` in the file; creates at
  `:66,131,186,289,355`), `src/server/actions/notion-import.ts:168`,
  `src/app/api/v1/pages/route.ts:65`, `src/server/actions/database.ts:237,518,637`,
  `calendar.ts:215`, `chat.ts:256`, `home-templates.ts:55,112,164,200`,
  `workspaces.ts:61`, `auth.ts:51`, `api/cron/templates/route.ts:144`. Those
  pages are title-searchable (the index coalesces `title`,
  `setup-search.mjs:26`) but their **body text is invisible to passes 1–2**
  until the next content save or a `setup:search` re-run; pass 3 only matches
  their title (`queries.ts:316-327`).

## 3. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| Dec1 | **Scope moves into SQL, all branches.** `visiblePageIds` becomes a `p.id = ANY(...)` predicate (or a join on the scope set) applied to pass 1, pass 2, pass 3 *and* the empty branch, **before** `LIMIT/OFFSET`. | One fix closes D78.1 + D78.2 at the root; post-filtering can never be correct once windows exist. |
| Dec2 | **Filters are server-side and live in the URL** (`?q=&type=&team=&by=&edited=`), extending the existing GET form. `loadMoreSearchAction` carries them through. | Matches the shipped form/page flow (`page.tsx:38-47`), keeps Load-more consistent, URLs stay shareable. Client-side window filtering is explicitly rejected. |
| Dec3 | **Recents are client-side** (`localStorage`, key `noema:recents:<userId>:<workspaceId>`, cap 10, newest first) with entries re-checked through `pageScopeFor` on render. | Zero schema change (docs-tier promise), per-device is an accepted v1 limitation (O78.3). Server storage would need a table + migration = Tier MAX for no user-visible gain yet. |
| Dec4 | **One palette, B43 owns it.** This spec defines only the *search contracts* B43's palette must consume: recents section on empty query, `fuzzyFilter` over `quickFindAction` results + commands, filter tokens (`type:page`, `in:teamspace`) parsed into Dec2's params. | `parity-batches.json:666-675` gives B43 the file; navigation-ux already books the shortcut there (`docs/specs/navigation-ux.md:482`). Duplicating a palette would recreate the entry-point row `:462` problem. |
| Dec5 | **Blend, don't fall back.** Ranking = pass-1 `ts_rank` ∪ pass-2 prefix hits, prefix-only rows ranked at a fixed discount (0.5×) then `updatedAt` tie-break; the trigram (`pg_trgm` similarity) tier runs only when passes 1+2 both return nothing. | Keeps the GIN path fast on the common query; matrix `:464` explicitly allows "Postgres FTS or trigram". Pass 3 (substring) stays as the un-backfilled safety net only. |
| Dec6 | **Keep OFFSET windows; fix the claim, not the mechanism.** Window math stays (`searchPagesPaged`), the "keyset" docstring is corrected when a code batch owns that file, and a true cursor is O78.4. | e2e-locked by `noema.spec.ts:1175-1209`; churning paging under B39's running suite risks false reds. |
| Dec7 | **No schema change anywhere in this spec.** Filters = query params, recents = localStorage, ranking = SQL. | Keeps the batch FAST-tier (docs) and removes the `db push`/build path entirely. |

## 4. Requirements (numbered, testable)

### Scope & correctness (close first — M1)

- **R78.1** — Every branch of `searchPages` (`queries.ts:243-342`) applies
  `workspaceId`, `deletedAt IS NULL`, **and** the guest visibility set as SQL
  predicates evaluated **before** `LIMIT/OFFSET`. Acceptance: a guest with ≥60
  visible matching pages receives exactly 50 rows in window 1 and the correct
  remainder in window 2 (no shrink), proven by a unit test over a seeded
  fixture that also plants hidden matches above the cut line.
- **R78.2** — `loadMoreSearchAction` (`actions/search.ts:41-71`) rejects an
  empty/whitespace `query` with `{ error: … }` instead of falling through to
  the empty branch; with Dec1, an empty-query `searchPages` call scoped to a
  guest can never return a page outside the scope set. Acceptance: red test
  proving the current leak (call the action as a guest with `query: ""`,
  assert 0 results / error), then green.
- **R78.3** — `GET /api/v1/search` passes the caller's scope into
  `searchPages` (`pageScopeFor` for GUEST callers) exactly like the page and
  palette (`route.ts:25` gains the same line as `page.tsx:28`). Acceptance:
  route-level test — GUEST token sees only its pages; member token unchanged;
  **cross-workspace isolation test**: no response array ever contains a
  `pageId` whose `workspaceId` differs from the requested one (asserted by
  re-querying each returned id).

### Filters & type (M2)

- **R78.4** — The search page accepts `type` (`PAGE`|`DATABASE`|…), `team`
  (teamspaceId), `by` (createdById) and `edited` (a preset range) URL params;
  they are translated to `WHERE` clauses **inside** the ranked SQL before
  windowing, shown as removable filter chips above the results, cleared by a
  "Clear filters" control, and forwarded by `loadMoreSearchAction` so Load-more
  keeps filtering. Acceptance: e2e filters a mixed workspace to `DATABASE` and
  asserts only database rows render; unit tests cover the param→SQL builder
  (pure helper) including unknown-param rejection.
- **R78.5** — Type narrowing is available from the palette too: filter tokens
  in the query (`type:page foo`) parse client-side (Dec4) into R78.4's params
  and are stripped from the text sent to `quickFindAction`. Acceptance: unit
  test for the tokenizer; e2e asserts `type:database` in the palette yields
  only database entries.

### Recents & palette (M3 — coordinate with B43)

- **R78.6** — With an empty query, the palette shows up to **10 recent
  entries** (recent searches + recently visited pages, per user+workspace,
  newest first, cap 10, persisted per Dec3) above the create item; selecting
  one navigates (and records the visit), a "Clear recent searches" control
  empties the list, and every entry is re-validated through `pageScopeFor`
  before render so a revoked page disappears. The search page with empty `q`
  shows the same list instead of nothing (`page.tsx:31`). Acceptance: unit
  test for the store (cap, dedupe, ordering, scope filtering); e2e opens the
  palette with no typing, sees a seeded recent page, clears recents, sees the
  list revert to the create item only.
- **R78.7** — One palette entry point (B43): the same component is opened by
  ⌘K (`workspace-shell.tsx:82-89`), the sidebar button (`sidebar.tsx:130`) and
  the footer item (`sidebar/sidebar-footer.tsx:87`); it fuzzy-matches with
  `fuzzyFilter` (`src/lib/fuzzy.ts:70`) over `quickFindAction` results **and**
  a registered command list (create page, jump to search page, trash,
  settings — i18n'd via `t(locale, …)`), with `↑/↓/Home/End/Enter/Esc`
  driving a visible selection. Acceptance: `fuzzy.ts` gains a production
  importer (red-first: a test asserting `workspace-shell` resolves the palette
  module), plus palette e2e in B43's `e2e/palette.spec.ts`.

### Relevance & presentation (M4)

- **R78.8** — Blended ranking per Dec5: prefix hits always merge with exact
  hits (fixed discount, `updatedAt` tie-break), and a trigram/similarity tier
  runs only when both passes are empty, so a 1-edit typo still returns the
  intended page. `npm run check:search` grows from 9 to ≥12 checks (blend
  order, typo hit, guest-scope window) and stays green. Acceptance: unit
  tests over a seeded corpus for ordering + typo; `check:search` count in the
  matrix note updated by the implementing batch.
- **R78.9** — Snippets and titles render **highlighted** matched terms:
  `ts_headline` gets sentinel markers (`StartSel=<b>…` equivalent, chosen as
  markers React never renders as HTML), the client splits on them and emits
  `<mark>` elements from escaped text — no `dangerouslySetInnerHTML` (the
  coherence gate allow-list `scripts/check-coherence.mjs:30` must stay
  untouched). Acceptance: unit test for the marker-splitter (multi-term,
  overlapping, marker-in-text edge), e2e asserts `<mark>` wraps the term.
- **R78.10** — Keyboard navigation is complete and asserted: in the palette
  `ArrowDown/ArrowUp` move the selection, `Home/End` jump, `Enter` activates,
  `Esc` closes; on the search page the results list gets roving arrow-key
  focus with a visible ring and `Enter` opening the focused row. Acceptance:
  e2e asserts a selection change on `ArrowDown` (currently zero arrow
  assertions exist — `search.spec.ts` presses only Enter/`Control+k`/Escape)
  in a **new** spec file (§9), since `e2e/search.spec.ts` belongs to B39.

## 5. State model & storage (no schema change)

| State | Where | Shape / lifetime |
| --- | --- | --- |
| Filters | URL (`?q=&type=&team=&by=&edited=`) | Shareable; survives reload and Load-more (R78.4) |
| Recents | `localStorage` `noema:recents:<userId>:<workspaceId>` | `{ kind: "search" \| "page", value/id, at }[]`, cap 10, oldest evicted; per-device (O78.3) |
| Filter chips | derived from the URL | No separate state |
| Ranking | SQL only | No cache; `ts_rank` computed per query |
| Scope set | `pageScopeFor` per request (`guest-access.ts:84-91`) | `null` for members (no predicate cost), `Set` for guests — now pushed into SQL (Dec1) |

## 6. Contracts

```ts
// src/server/queries.ts — signature extension (params only, no breakage)
searchPages(workspaceId, query, visiblePageIds, {
  take?, offset?,
  filters?: { type?: string[]; teamspaceId?: string; createdById?: string; edited?: "day"|"week"|"month"|"year" }
}) // => rows  — scope + filters applied in SQL before LIMIT (R78.1, R78.4)

// src/server/actions/search.ts
loadMoreSearchAction({ workspaceId, query, offset, filters? })
//   => { error } when query is blank (R78.2)
quickFindAction(workspaceId, query)          // unchanged shape (B43 consumes it)
//   scope: unchanged (actions/search.ts:29) — must stay equal to search page scope

// src/app/api/v1/search/route.ts
//   GET …&q=… gains the pageScopeFor predicate before searchPages (R78.3)

// new pure helper — src/lib/search-filters.ts
parseSearchFilters(searchParams) => Filters | { error }   // unknown keys rejected
parsePaletteTokens(query)       => { text, filters }      // "type:page foo" (R78.5)
splitHighlight(snippet, terms)  => Array<{ text, mark }>  // no HTML (R78.9)
```

`quickFindAction`'s return type (`QuickFindResult`, `actions/search.ts:8-14`)
stays as-is: B43's palette already depends on it.

## 7. UI spec

### 7.1 Search page (`src/app/w/[slug]/search/page.tsx`)

- Same GET form (`:38-47`); filter chips render under it when params exist,
  each with an × that removes that param and re-navigates.
- Results header keeps the live count (`search-results.tsx:54-56`) and adds a
  "Filters" popover (type / teamspace / owner / edited) — a `<details>`-style
  disclosure, no new dialog primitive.
- Empty `q` **with** filters shows the filtered recent list (R78.6); empty `q`
  without filters keeps today's bare form (e2e `search.spec.ts:200-210` stays
  green) *unless* the user has recents — then the recents section appears
  (coordinate with B39: their test asserts no `results? for` summary and no
  `ul a` (`:208-209`), which recents would break — hence R78.6 ships its
  markup as a separate list only when recents exist, and B39's assertion gets
  an update in the implementing batch's own PR, not here).

### 7.2 Palette (B43-owned file, search-side sections)

Sections in order: **Recents** (empty query, R78.6) → **Pages** (fuzzy-matched
`quickFindAction` results, R78.7) → **Commands** → always-on **Create a new
page** (`quick-find.tsx:97-104` stays last so today's e2e option-count
assertions only change when recents are present). Snippets render through
`splitHighlight` (`quick-find.tsx:124-128` gains `<mark>`s).

### 7.3 Keyboard

Palette: `↑/↓` selection, `Home/End` ends, `Enter` activate, `Esc` close —
`cmdk` already moves selection with arrows; the work is *asserting* it and
keeping the `data-[selected=true]` ring (`quick-find.tsx:115`) visible in both
themes. Search page: roving `tabIndex` over result links, `↑/↓` move the ring,
`Enter` opens, `Esc` returns focus to the search input.

## 8. Edge cases

1. **Hidden hits above the cut line** (D78.1) — fixture plants 20 private pages
   ranked *above* 60 public ones; guest windows must still be 50 + 10.
2. **Empty/whitespace query through Load-more** — returns `{ error }`, never
   the recent-list leak (R78.2); palette guards at `actions/search.ts:27`.
3. **Recents referencing revoked pages** — permission removed or page trashed →
   entry filtered out on next render (R78.6 scope re-check).
4. **Filter + pagination interaction** — filters are part of every window
   request; removing a chip resets offset to 0 (else rows repeat).
5. **Prefix + exact hybrid** ("road" must not drown exact "roadmap release")
   — discount + tie-break keep exact hits first (R78.8).
6. **Typo tier latency** — trigram only runs when passes 1+2 are empty; the
   query stays parameterized (`queries.ts:275` binds `${q}`), and `searchTerms`
   output is `\p{L}\p{N}_`-sanitised (`search.ts:18-24`) so `to_tsquery` cannot
   be injected.
7. **`ts_headline` marker collision** — sentinel markers are stripped from the
   raw query text before rendering; a page literally containing the marker is
   escaped, never interpreted (R78.9).
8. **i18n** — every new string goes through `t(locale, …)` (coherence ratchet
   `BASELINE.i18nFiles`, `check-coherence.mjs:26`), en/fr/es/de/ar at minimum,
   matching the catalogue in `src/lib/i18n.ts`.
9. **Mirror-stale rows (D78.6)** — pass 3 keeps titles searchable meanwhile;
   the implementing batch additionally backfills on `setup:search` (already
   idempotent, `setup-search.mjs:37`) rather than adding writes to 12 files in
   this spec.

## 9. Test plan

> Red-first per `scripts/LOOP_PLAYBOOK.md`; tests cite their `R78.x`.

**Unit (vitest)**

1. Scope-in-SQL builder — guest fixture with hidden hits above the cut:
   window sizes exact. [R78.1] *(red: proves D78.1)*
2. Empty-query scope — scoped empty query returns only visible ids. [R78.1]
3. `loadMoreSearchAction` blank-query rejection. [R78.2] *(red: D78.2)*
4. `parseSearchFilters` — known params, unknown-param rejection, ranges. [R78.4]
5. Filter param → SQL predicate composition (type ∩ team ∩ owner ∩ date). [R78.4]
6. `parsePaletteTokens` — `type:page foo`, token-only query, unicode text. [R78.5]
7. Recents store — cap 10, dedupe, ordering, scope re-check. [R78.6]
8. `fuzzyFilter` integration shape (existing `fuzzy.test.ts` stays green). [R78.7]
9. Ranking blend — exact > prefix-only, tie-break, typo tier ordering. [R78.8]
10. `splitHighlight` — multi-term, overlap, marker-in-text, no HTML. [R78.9]
11. Roving-focus reducer for the results list. [R78.10]

**Domain check** — `scripts/check-search.mjs` grows 9 → ≥12: guest-scope
window, blend order, typo hit [R78.1, R78.3, R78.8]; existing 9 must stay
green (`package.json:33`).

**e2e (Playwright, dev :3201, targeted `-g`, no lock)**

12. `e2e/search-parity.spec.ts` (**new file — this batch's implementation
    successor owns it; do NOT add tests to B39's `e2e/search.spec.ts` or the
    editor-slot `e2e/noema.spec.ts`**): filter chip flow [R78.4], palette
    recents + clear [R78.6], `<mark>` highlight [R78.9], ArrowDown selection
    [R78.10], guest window fullness [R78.1].
13. B43's `e2e/palette.spec.ts` keeps/extends the palette assertions [R78.7];
    B39's suite must remain green unmodified.

**Explicitly not run by this batch** (docs tier): no build, no e2e, no
`docs:counts`/`docs:gaps` (orchestrator-only).

## 10. Delivery plan (milestones → tasks ↔ requirements)

> Test-first: each task's acceptance is a red test citing its IDs.

**M1 — Scope correctness (small, Tier STANDARD: server actions + queries)**

- T78.1 [R78.1]: push `visiblePageIds` + filters into SQL on all four branches
  of `searchPages`. Red: tests 1, 2.
- T78.2 [R78.2]: blank-query guard in `loadMoreSearchAction`. Red: test 3.
- T78.3 [R78.3]: scope in `api/v1/search` + cross-workspace isolation test.
  Red: route test.

**M2 — Filters & type (queries + search page UI)**

- T78.4 [R78.4]: `src/lib/search-filters.ts` pure helpers + SQL predicates.
  Red: tests 4, 5.
- T78.5 [R78.4]: search page chips + popover + Load-more pass-through. Red:
  e2e 12 (filter flow).
- T78.6 [R78.5]: palette filter-token parsing (coordinate with B43's input
  handler). Red: test 6.

**M3 — Recents + palette integration (B43 file coordination)**

- T78.7 [R78.6]: recents store + empty-query sections on both surfaces. Red:
  tests 7, e2e 12 (recents).
- T78.8 [R78.7]: wire `fuzzyFilter` + command registry into the palette
  (lands in B43's branch or immediately after it). Red: test 8, e2e 13.

**M4 — Relevance & keyboard**

- T78.9 [R78.8]: blended ranking + typo tier + `check:search` 9→12. Red:
  tests 9, domain checks.
- T78.10 [R78.9]: headline markers + `splitHighlight`. Red: tests 10, e2e 12.
- T78.11 [R78.10]: roving focus on results + palette arrow assertions. Red:
  tests 11, e2e 12/13.

## 11. Risks & open questions (honest)

**Risks**

1. **Guest scope list size pushed into SQL.** `guestVisiblePageIds` returns a
   `Set` that can reach thousands of ids (`guest-access.ts:46-78`); an
   `= ANY($1)` parameter has a practical array bound (~32 k) but the round-trip
   cost is real. Mitigation: keep the scope set for members `null`
   (`pageScopeFor:89`) so only guests pay, and add a `check:search`-style timing
   probe if a workspace grows past ~5 k visible pages.
2. **Collision with two running siblings.** B39 owns `e2e/search.spec.ts` and
   B43 owns `quick-find.tsx`/keybinding (both `running`,
   `parity-state.json:160-179`). Mitigation: this spec touches neither file;
   M3's tasks explicitly queue behind B43 and land in a fresh spec file.
3. **Recents breaking B39's empty-state assertions.** Their test asserts zero
   `ul a` on the empty search page (`search.spec.ts:208-209`) and exactly one
   palette option (`:230-231`, `:275`). Mitigation: R78.6 renders the recents
   list only when it is non-empty, and the implementing batch updates those
   assertions *with* the feature in its own PR (red-first, not silently).
4. **Typo tier latency on large workspaces.** The trigram pass scans
   `searchText` without a usable GIN operator for `%`. Mitigation: it runs only
   after two empty passes (Dec5) and is bounded by `LIMIT take+1`; if it proves
   slow, ship prefix-only and record the drop in the matrix note honestly.
5. **Doc drift recurring (D78.5).** Matrix notes lag shipped behaviour. This
   spec records the drift instead of editing glyphs; the orchestrator's
   `docs:counts`/`docs:gaps` pass should re-word `:458`, `:463`, `:464`.

**Open questions**

- **O78.1 — cross-workspace ("search everywhere").** Notion searches across
  workspaces the user belongs to. Noema's palette is bound to one
  `workspaceId` (`workspace-shell.tsx:157-161`). This spec hardens *isolation*
  (R78.3) but defers multi-workspace search until a navigation row asks for it
  — needs a workspace switcher in the palette first (section-16 owner).
- **O78.2 — database-row content.** Notion indexes database *entries*;
  `searchPages` only queries `"Page"` rows (`queries.ts:279-286`) and row
  properties live outside `Page.content`. Decide: index row properties into a
  row-level mirror, or accept page-level parity for now. Matrix `:460`
  ("Pages, databases, etc.") is the tracking row.
- **O78.3 — recents: local vs account-level.** Dec3 chose `localStorage`
  (per-device). If Notion-parity requires account-wide recents, it needs a
  table + migration (Tier MAX) — revisit when a section-9 "workspaces" row
  demands it.
- **O78.4 — `pg_trgm` availability.** The typo tier needs the extension;
  self-hosted Postgres usually has it, but `setup-search.mjs` would have to
  `CREATE EXTENSION IF NOT EXISTS pg_trgm` — confirm the deployment allows it
  before T78.9 (otherwise R78.8 ships prefix-only and says so).
- **O78.5 — second ranking engine.** `searchPagesForPrompt` scores in memory
  over 500 pages (`queries.ts:640-654`) with a different algorithm and no
  guest scope. Unify onto `searchPages` later (AI spec owner) or accept two
  engines; flagged so the divergence is a decision, not an accident.

## 12. Traceability — FEATURE_MATRIX rows (section 11)

Statuses are **unchanged** by this batch; only `Spec: docs/specs/search.md.` is
appended to each Notes cell.

| Row (`docs/FEATURE_MATRIX.md`) | Status (unchanged) | Requirements |
| --- | --- | --- |
| `:456` Full-text search | ✅ | R78.1, R78.2, R78.8 (plus existing 9/9 `check:search`) |
| `:457` Title search | ✅ | R78.9 (highlight), R78.8 (merge) |
| `:458` Content search | 🟡 | R78.4, R78.8; drift note D78.5, mirror gaps D78.6 |
| `:459` Search filters | 🧭 | R78.4 |
| `:460` Search by type | 🧭 | R78.5 (+ O78.2 for row content) |
| `:461` Recently visited | 🧭 | R78.6 |
| `:462` Command palette | 🧭 | R78.7 (implementation owned by B43) |
| `:463` Search preview snippets | 🧭 | R78.9; drift note D78.5 |
| `:464` Search ranking | 🧭 | R78.8; drift note D78.5 |
| `:465` Search pagination | ✅ | R78.1, R78.4 (scope- and filter-correct windows) |
| `:466` Search keyboard nav | 🟡 | R78.10 |
