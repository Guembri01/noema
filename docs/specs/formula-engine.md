# Spec — Formula engine (deep: semantics, dependencies, validation, editor)

> **Status: spec complete, implementation pending.** Batch **B22** of the parity
> loop (spec-only, light slot). This document is the deliverable; no production
> code was changed. Every claim about the current state cites a file that was
> opened for this spec. Requirement IDs (`R22.x`) are the traceability anchors:
> §11 lists milestones/tasks 1:1 against them, tests must cite the IDs they
> cover, and §4.4 maps all 16 rows of `docs/FEATURE_MATRIX.md` section 5
> (`:314-329`) to the requirement — or explicit deferral — that owns them.

---

## 1. Problem statement

Noema already ships a formula *engine*: `src/lib/formula.ts:1-261`, a
dependency-free whitelist parser (tokenizer + recursive descent, **no `eval` /
no `Function`**) with 12 functions, and `src/lib/rollup.ts:1-111`, a 14-function
aggregator. Both are pure and unit-tested (6 + 7 cases). What is missing is
everything *around* the engine:

- **no authoring UX** — the editor is one textarea inside the shared
  `PromptDialog` with a hardcoded function-hint string
  (`src/components/database/database-view.tsx:1142-1225`);
- **no save-time validation** — `updatePropertyAction` writes `config` as raw
  JSON (`src/server/actions/database.ts:118-120`), so any string persists and
  every row renders an error forever;
- **no dependency awareness** — formulas read only *stored* cell values
  (`database-view.tsx:352-358`), so another formula, a rollup, or the formula's
  own property evaluates to `""`, silently;
- **no honest invalid states** — errors surface as a raw `#<message>` string
  (`database-view.tsx:360`), bad numeric results render as the literal text
  `NaN`, and a renamed property empties dependent formulas with no signal;
- **no query participation** — filters and sorts run on stored values only
  (`src/lib/database-query.ts:623-634`), so a formula/rollup column compares as
  "empty" in every row and sorting it silently does nothing.

This spec is the deep contract for that surround: normative language semantics
and function reference (§5), dependency and invalid-state handling (§7),
server-side parse-validation (§8), the formula editor UX (§6), a test plan
(§10), M1–M3 delivery (§11), and 16 numbered requirements R22.1–R22.16 (§4).

### 1.1 Ownership split with B21 (`docs/specs/relations-rollups.md`)

The sibling spec B21 covers relations/rollup plumbing and claims five anchors in
this area. Nothing here contradicts them:

| B21 anchor (already specified) | What B22 adds |
| --- | --- |
| **R21.14** — evaluation stays client-side; bounds ≤ 10 000 chars, depth ≤ 64 in `formula.ts` | §8 restates the bounds as a save-time rule (R22.16) and adds the safety invariants that must hold for the *reference* work |
| **R21.15** — `updatePropertyAction` rejects unparseable expressions via a `parseFormula` helper | §8 is the **contract detail** for that rejection: rule set, message identity with the editor, empty-expression rule, no-partial-write, config size cap (R22.14) |
| **R21.16** — baseline editor (autocomplete + live error + preview + save-disable) | §6 is the **design of record** for that editor: full layout, function-reference panel, signature help, states, keyboard, a11y (R22.12, R22.13) |
| **R21.17** — function additions (`and`/`or`/`not`, `ifs`, `ceil`, `floor`, `slice`, `replace`, `dateAdd`, `dateBetween`, `formatDate`) | §5 is where those functions are **documented normatively** when they land; R22.1 makes the catalogue the single source that prevents doc/function drift |
| **R21.18** — rollups feed formulas through a `computedByRow` map, rollups computed before formulas | R22.8 generalizes this to a real **dependency graph** (formula→formula, self-reference, cycles) and R22.11 defines the **typed** value a rollup contributes |

B21's non-goals (`relations-rollups.md:337-343`) — regex, result caching, named
constants — are confirmed as B22 non-goals in §4.5, except caching/dependency
graph, which **B22 takes over** (matrix `:328` was deferred there as O21.4 and
is required here by R22.8/R22.9).

## 2. Current state audit (evidence)

### 2.1 What exists today

| Area | Evidence | State |
| --- | --- | --- |
| Engine module | `src/lib/formula.ts:1-261` | Header `:1-6` ("small, dependency-free formula language… pure and unit-tested"). Types `FormulaValue = number \| string \| boolean`, `FormulaScope`, discriminated `FormulaResult` (`:8-13`) — **no `null`** in the value type. |
| Tokenizer | `formula.ts:22-77` | Numbers incl. `_` separators (`:31-37`), single/double-quoted strings with backslash escapes (`:38-54`), identifiers (`:55-61`), two-char ops `== != <= >= && \|\|` (`:62-67`), single-char `+-*/%<>()!,` (`:68-72`), else `Unexpected character` throw (`:73`). |
| Parser | `formula.ts:79-250` | Recursive descent, precedence `or → and → equality → comparison → additive → multiplicative → unary → primary` (`:105-210`); trailing-input guard (`:86-90`); parenthesis guard (`:184-188`); argument lists (`:195-203`). |
| Function dispatch | `formula.ts:212-248` | 12 functions: `prop, if, concat, length, upper, lower, contains, empty, abs, round, min, max`; unknown → throw `Unknown function "x"` (`:246-247`). **No arity check** — `min()` folds to `Math.min()` = `Infinity` (`:242-243`), `if(true)` returns `undefined` (`:221-222`). |
| `prop()` | `formula.ts:214-220` | Case-insensitive **name** lookup over `Object.keys(scope)`; **unknown name → `""`** (silent). |
| Bare idents | `formula.ts:205-206` | `now` → `Date.now()` (number, ms), `today` → `"YYYY-MM-DD"` (string). The **call forms `now()` / `today()` throw** `Unknown function` (`:246-247`). |
| Entry point | `formula.ts:252-261` | `evaluateFormula(expression, scope)` → `{ok:true,value}` or `{ok:false,error}`; empty → `Empty formula` (`:254`); all throws captured (`:258-260`). **No `eval`/`Function` anywhere in the file** — whitelist design is the security property. |
| Engine tests | `src/lib/formula.test.ts:10,17,25,31,35,46` | 6 cases: precedence, booleans, property refs, `+` concat, helper functions, error-not-throw. |
| Rollup module | `src/lib/rollup.ts:1-111` | `RollupFunction` union of 14 ids (`:5-19`), label catalogue `ROLLUP_FUNCTIONS` (`:21-36`) — the pattern R22.1 mirrors. `isEmpty` (`:40-43`), numeric coercion by stripping non-numeric chars (`:45-51`), `aggregateNumeric` (`:53-75`). |
| Rollup contract | `rollup.ts:77-111` | `aggregate()` **always returns a display string**: counts (`:80-83`), `"83%"` (`:86-91`), date → `YYYY-MM-DD` (`:94-102`), `show_original` join (`:103-104`), numeric → `String(int)` / `toFixed(2)` (`:106-109`), no data → `"—"` (`:99,107`). |
| Rollup tests | `src/lib/rollup.test.ts:7,13,22,27,32,37,42` | 7 cases (counts, numeric, booleans, dates, unique/original, empty, function list). |
| Evaluation site | `database-view.tsx:46-47,348-361` | `computeFormula`: reads `config.expression` (`:349-350`), empty → `"—"` (`:351`), builds a **name-keyed scope from every property** (`:352-358`): `NUMBER` → `Number(value?.number ?? 0)` (`:355`, empty cell becomes `0`), `CHECKBOX` → `Boolean(checked)` (`:356`), everything else → `formatCell()` **string** (`:357`), then `evaluateFormula` (`:359`) and `result.ok ? String(value) : "#" + error` (`:360`). |
| Self/rollup visibility | `database-view.tsx:353-358` + `database-query.ts:308-309` | Scope values come from `valueFor` (`:345-346`, stored `propertyValues` only) → other `FORMULA`, `ROLLUP` and system properties, and the formula's **own** property, all resolve to `formatCell(undefined)` = `""`. Chained formulas and self-reference are therefore invisible today. |
| Rollup site | `database-view.tsx:367-406` | config `{relationPropertyId, targetPropertyId, function}` (`:369-376`), missing config → `"—"` (`:378`), per-target values typed by property type (`:393-404`), `aggregate()` (`:405`). |
| Dispatch | `database-view.tsx:408-429` | `computedFor()` switches `FORMULA`, `ROLLUP`, `CREATED_TIME`, `LAST_EDITED_TIME`, `CREATED_BY`, `LAST_EDITED_BY`, `UNIQUE_ID`. Each formula property is evaluated **independently, in property order** — no dependency order, no cache. |
| Save path | `database-view.tsx:460-468` | `onEditFormula` → `updatePropertyAction(property.id, {config:{...prev, expression}})` → `toast.success("formulaSaved")` (`:465`). **No client-side parse, no server-side parse.** |
| Editor UI | `database-view.tsx:1142-1225`, `src/components/prompt-dialog.tsx` | `PromptDialog` title = `formulaWord` (`:1146-1147`); **static hint string listing functions** (`:1156`); exactly one field, `multiline: true`, 3-row `<textarea>`, placeholder `concat(prop("Name"), " — done")` (`:1163-1175`); confirm `saveFormula` (`:1201-1203`); submit → `onEditFormula` (`:1210-1212`). `PromptDialog` itself validates only non-empty (`prompt-dialog.tsx:58-60`), textarea `:93-102`, documented as the `window.prompt` replacement (`:20-23`, `multiline` comment `:15-16`). |
| Entry points | `database-view.tsx:999`, `view-parts.tsx:187-191` | Column menu → `Edit formula` only for `FORMULA` properties; `PROPERTY_TYPES` offers the type in the create-type list (`view-parts.tsx:31`). |
| Cell rendering | `view-parts.tsx:631-632,644`, `:885-886` | Table cell: `readOnly(computed && computed.length > 0 ? computed : "—")`; card fallback same pattern (`:644`); type glyph `ƒ`. |
| Side peek | `database-view.tsx:1074-1078` | Comment + `computedFor(peek, property)`: computed values (formula, rollup, system) render read-only. |
| Server create | `src/server/actions/database.ts:74-85` | `FORMULA` default config `{expression:""}` (`:79-80`); `ROLLUP` default `{relationPropertyId:null,targetPropertyId:null,function:"count"}` (`:83-84`). |
| Server update | `database.ts:101-125` | `updatePropertyAction`: authorize (`:110-112`), name sliced to 80 (`:117`), **`config` written as `Prisma.InputJsonValue` with no shape check, no parse, no size cap** (`:118-120`). |
| Server value write | `database.ts:178-221` | `setPropertyValueAction` upserts any JSON for any `propertyId` (`:192-200`) — computed columns are read-only **only in the UI**. |
| View queries | `src/lib/database-query.ts:323-335,501-532,623-634` | `comparable()` handles `NUMBER`/`DATE`/`CHECKBOX`, else text via `formatCell` (default `""`, `:308-309`) → `null` for computed columns; `compareBySorts` pushes empties last (`:513-518`); `applyView` = filter → sort → group (`:623-634`) over **stored values**. Grep of the file: no `FORMULA`/`ROLLUP` branch anywhere. |
| What the UI offers | `view-settings.tsx:59-65,106-111` | Grouping limited to `SELECT/STATUS/MULTI_SELECT` (`:59-61`) — correct for formulas, out of scope; but `secondary = properties.filter(not primary)` (`:65`) and `addableSortProperty` (`:106-111`) **offer formula/rollup columns in filter and sort controls** that then do nothing (§2.3 G22.10). |
| i18n | `src/lib/i18n.ts:474,495,517,519,524` + `:1166-1216,1853-1903,2540-2590,3227-3277` | 5 locales (en, fr, es, de, ar) already carry `editFormula`, `formulaSaved`, `formulaWord`, `formulaFor`, `saveFormula`. Coherence's i18n ratchet counts consumer files, may grow not shrink (`scripts/check-coherence.mjs:25-26,81-84`). |
| e2e | `e2e/` grep `formula\|Formula` | **0 matches** — no end-to-end coverage of the feature; unit-only today. |
| Matrix | `docs/FEATURE_MATRIX.md:309-329` | Section 5 "Formulas": **16 planned rows** (`:314-329`), counts row `:775` (`0 done / 0 partial / 16 planned / 0 excluded / 16 total`). Related rows: formula property `:289`, rollups `:294-295`. |
| Coherence gate | `scripts/check-coherence.mjs` | Scans `src/` via `audit-inventory.mjs` (`:32`), baselines `:13-27`, `COHERENT`/`DRIFT` line `:93`. Matrix **Notes cells are not scanned** → a docs-only append cannot move it; a `src/` edit could. |

### 2.2 What the product class (Notion) does

1. **A real authoring surface** — expression input with autocomplete over
   property names *and* the function catalogue, a live error line while typing,
   a preview of the result before saving, and an in-editor reference.
2. **A documented language** — the function set, its coercions and its error
   behavior are published and stable, not discoverable by trial and error.
3. **Explicit invalid states** — a broken formula shows one friendly error,
   flagged on the *property*, without rendering an error badge on every row of a
   500-row table.
4. **Rename/delete safety** — renaming a referenced property keeps dependent
   formulas working, or at minimum surfaces a broken-reference state instead of
   silently evaluating to `""`.
5. **Computed columns participate in views** — they can be sorted and filtered
   like any other column.
6. **Dependency-aware recompute** — rollups feed formulas, formulas feed
   formulas, and changes recompute in topological order without cycles.
7. **No literal `NaN`/`Infinity`** in a cell — degenerate numeric results are
   errors.

### 2.3 Gaps this spec closes

| Id | Gap | Evidence |
| --- | --- | --- |
| **G22.1** | Editor is a 3-row textarea in `PromptDialog` with a hardcoded function hint; no autocomplete, no reference, no live validation | `database-view.tsx:1142-1225`, `:1156`, `:1163-1175` |
| **G22.2** | Any string persists as `config.expression`; validation happens at render time, in every cell | `database.ts:101-125` (`:118-120`), `database-view.tsx:359-360` |
| **G22.3** | Formula→formula, rollup→formula, and self-references all evaluate to `""` (scope reads stored values only) | `database-view.tsx:352-358,345-346`, `database-query.ts:308-309`; matrix `:326,328` |
| **G22.4** | Renaming a property leaves `prop("Old")` in place → silent `""`; deleting one does the same | `formula.ts:214-220`, `database.ts:117` (rename path has no formula pass) |
| **G22.5** | Non-finite results render as literal `NaN` / `Infinity` text | `formula.ts:154-155,164-166` (unchecked `Number()` math), `database-view.tsx:360` |
| **G22.6** | No arity checks: `min()` → `Infinity`, `if(true)` → `undefined` (→ `"undefined"` cell), `round()` → `NaN` | `formula.ts:195-203,221-222,237-241,242-243` |
| **G22.7** | `now()`/`today()` throw `Unknown function`; only bare `now`/`today` work, and they have undocumented types (number vs date-string) | `formula.ts:205-206,246-247` |
| **G22.8** | Errors render as raw `#<message>`; no per-property flag, no place to fix from | `database-view.tsx:360`, `view-parts.tsx:631-632` |
| **G22.9** | Re-tokenize + re-parse every expression for every row on every render; no dependency graph | `formula.ts:256`, `database-view.tsx:348-361,408-429`; matrix `:328` |
| **G22.10** | Filter/sort controls offer formula/rollup columns, but evaluation uses stored values → every row "empty" → sorts to the end, filters match nothing | `view-settings.tsx:65,106-111` vs `database-query.ts:323-335,513-518,623-634` |
| **G22.11** | Rollups contribute only display strings (`"12.50"`, `"83%"`, `"—"`) — unusable numerically in `prop("X") * 100` (→ `NaN` under G22.5) | `rollup.ts:77-111`, `database-view.tsx:357,405` |
| **G22.12** | An empty NUMBER cell enters scope as `0`, so `empty(prop("Price"))` is `false` and `prop("Price") + 1` silently succeeds | `database-view.tsx:355`, `formula.ts:233-234` |

## 3. Decisions

| # | Decision | Options weighed | Verdict |
| --- | --- | --- | --- |
| DC1 | **Evaluation stays client-side in the shared module**; no persisted computed values, no per-row server evaluation | (a) client-side pure module (already built, isomorphic, instant feedback, zero round-trips); (b) server evaluation per row (round-trip per expression change, kills preview); (c) materialized `PropertyValue` column (denormalization + invalidation + schema change) | **(a)** — same conclusion as B21 §3.2 (R21.14); B22 does not reopen it |
| DC2 | **References stay name-based text** (`prop("Name")`) with **transactional rewrite on rename** | (a) name text + rewrite (grammar unchanged, expressions stay human-readable, existing configs keep working); (b) embed property ids in the expression (rename-safe but unreadable, breaks every existing formula's text); (c) store AST JSON in `config` (opaque, un-diffable, needs a text facade anyway) | **(a)** — R22.6 |
| DC3 | **Cache at parse level, not value level**: memoize tokenize+parse per distinct expression (bounded LRU), evaluate per row per render | (a) AST memo by expression (tiny invalidation surface — only the text changes); (b) cache final values per (row, property) (needs dependency invalidation + row identity, high risk of stale cells); (c) no cache (status quo, O(rows × props) parses) | **(a)** now; value-level cache only after the dependency graph proves out (O22.1) |
| DC4 | **Errors stay `{ok:false; error}` with an optional machine code** | (a) keep the shape, add `code?: "parse"\|"arity"\|"unknown_property"\|"not_finite"\|"cycle"\|"bounds"` (existing callers `database-view.tsx:359-360` and 6 tests keep compiling); (b) throw typed exceptions (breaks the "reports errors instead of throwing" contract tested at `formula.test.ts:46`) | **(a)** — R22.10 needs the code only to pick the friendly message; the raw message stays for the editor |
| DC5 | **Rollups get a typed projection**: new `aggregateTyped(values, fn): FormulaValue \| null` sharing the same switch, `aggregate()` remains the display formatter | (a) two views over one switch (display strings unchanged, formula scope gets real numbers/booleans/null); (b) parse the display string back (`Number("83%")` = `NaN`, `"1,234"` fragile) | **(a)** — R22.11 |
| DC6 | **View queries take a computed-value accessor** instead of gaining an evaluator | (a) `applyView(rows, properties, config, computed?)` — client passes `computedFor`, server passes `computedByRow` (B21 R21.13); (b) move the whole evaluator into `database-query.ts` (duplicates engine, breaks "one module"); (c) persist computed values (DC1c) | **(a)** — R22.15 |
| DC7 | **Empty cells become `null` in scope** (`FormulaValue \| null`), not `0`/`""` | (a) `null` + coercion rules (`empty()` true, numeric → 0, string → `""`, result `null` → cell `"—"`); (b) keep `0`/`""` and document the quirk (`empty()` stays wrong forever) | **(a)** — R22.3 |

## 4. Requirements (numbered, testable)

### 4.1 M1 — engine contract: semantics, values, catalogue

- **R22.1 — Single-source function catalogue.** `src/lib/formula.ts` exports
  `FORMULA_FUNCTIONS: { id, label, signature, arity, category, doc }[]` covering
  every name the parser accepts: the 12 `call()` functions
  (`formula.ts:212-248`), the bare idents `now`/`today` (`:205-206`), and the
  operator set (`:62-72,173`). Shape mirrors `ROLLUP_FUNCTIONS`
  (`rollup.ts:21-36`). The editor's function list (R22.13), the docs reference
  (§5) and the server validator's allow-list (R22.14) are all derived from it.
  *Acceptance:* red unit test that walks `FORMULA_FUNCTIONS` and asserts each
  `id` evaluates its canonical example through `evaluateFormula`, **and** a
  drift test that fails when `call()` handles a name absent from the catalogue
  (or the reverse) — same guard `rollup.test.ts:42` applies to the rollup list.

- **R22.2 — Normative coercion & evaluation semantics.** The tables in §5.4
  (operators, coercions, truthiness, equality) are normative and locked by
  tests, one case per row: `+` concatenates when either side is a string
  (`formula.ts:148-153`); `- * / %` coerce with `Number()` (`:154-155,161-169`);
  comparisons coerce both sides (`:136-139`); `==`/`!=` are **strict**
  (`:126-127`, so `1 == "1"` is `false`); `&& || !` booleanize operands and
  return booleans (`:105-121,173`); `if()` evaluates all three arguments
  eagerly (`:199-203,221-222`); `true`/`false` are case-insensitive literals
  (`:192-194`).
  *Acceptance:* red unit case per table row in `formula.test.ts`; §5.4 and the
  test file must cite each other.

- **R22.3 — Empty-value model.** `FormulaValue` gains `null`
  (`formula.ts:8`), `FormulaScope` values may be `null`, and `computeFormula`
  feeds `null` for empty cells instead of coercing: `NUMBER` empty → `null` not
  `0` (`database-view.tsx:355`), text/`formatCell` empty → `null` (`:357`).
  Rules: `empty(x)` is `true` for `null` and for `""` (`formula.ts:233-234`);
  numeric operators coerce `null → 0`, string operators `null → ""`,
  comparisons/`!` coerce `null → false`; a result of `null` renders `"—"` (the
  empty-formula rule at `database-view.tsx:351`), never `"null"`.
  *Acceptance:* red unit cases — `empty(prop("Price"))` true on an empty number
  cell; `prop("Price") + 1` = `1` on empty; a `prop()` returning `null`
  rendered through `computeFormula` shows `—`.

- **R22.4 — Non-finite results are errors.** `evaluateFormula` returns
  `{ok:false, code:"not_finite"}` when the parsed value is a non-finite number.
  No cell may ever contain the literal text `NaN` or `Infinity` (today:
  `Number()` math is unchecked, `formula.ts:154-155,164-166`, and
  `computeFormula` does `String(result.value)`, `database-view.tsx:360`).
  Division by zero yields the error state, not `Infinity`; `0/0` likewise.
  *Acceptance:* red unit — `1/0` → error; `"a" - 1` → error (string minus is
  numeric, `formula.ts:154-155`); render path test asserts the friendly state
  (R22.10), not `NaN`.

- **R22.5 — Arity validation at parse time.** Function arity comes from the
  catalogue (R22.1) and is checked before dispatch (`formula.ts:195-203`):
  `min()`/`max()` require ≥ 1 argument (today → `Infinity`, `:242-243`),
  `if()` requires exactly 3 (today → `undefined`, `:221-222`), `round()` ≥ 1
  (today → `NaN`, `:237-241`), `prop()` exactly 1, unary/`concat` per the
  catalogue. Wrong arity → `{ok:false, code:"arity"}` with the function's
  signature in the message.
  *Acceptance:* red unit cases for `min()`, `if(true)`, `round()`, `prop()`,
  `prop("a","b")`; message text includes the signature the editor shows.

### 4.2 M2 — dependency graph, invalid states, display

- **R22.6 — Rename propagates to formulas.** When `updatePropertyAction`
  changes a property's `name` (`database.ts:117`) in database D, it rewrites
  every `prop("Old")` reference — case-insensitive, matching the lookup rule
  (`formula.ts:216-218`) — in all `FORMULA` configs of D, in the **same
  transaction** as the rename. Formula text stays otherwise untouched.
  *Acceptance:* red action test — database with 2 formulas referencing
  `prop("Price")`, rename to `Cost` → both configs contain `prop("Cost")`,
  computed cell values unchanged before/after; a formula that never referenced
  it is byte-identical; rename to a name that already exists in some formula
  leaves those references intact (no clobber).

- **R22.7 — Unknown property reference is an explicit error.** `prop()` on a
  name that is not in scope returns `{ok:false, code:"unknown_property"}`
  (`formula.ts:214-220` currently returns `""` silently). A name that *is* in
  scope with value `null` keeps returning `null` (R22.3) — only genuinely
  absent references error. Scope keys remain property names, so the error fires
  for deleted properties and for pre-migration/broken data.
  *Acceptance:* red unit — `prop("Ghost")` with `{}` → error naming `Ghost`;
  `prop("Ghost")` with `{Ghost: null}` → `null`; existing case-insensitive
  match (`prop("price")` vs key `Price`) still resolves (`formula.ts:216-218`).

- **R22.8 — Dependency graph and evaluation order.** The database layer builds
  a dependency map by one tokenize pass over each expression (no evaluation):
  `{propertyId → referenced property names}` + a per-row result map.
  Evaluation order per row: **rollups first** (B21 R21.18), then formulas in
  topological order, each formula's scope receiving the already-computed values
  of same-row computed properties — fixing G22.3 (today `database-view.tsx:
  352-358` reads stored values only). **Cycles**, including self-reference
  (a formula that reads its own property), are detected: every member of the
  cycle renders `code:"cycle"` and evaluation of the cycle is skipped once —
  no recursion, no stack overflow (`primary()` recurses per `(`,
  `formula.ts:184-188`).
  *Acceptance:* red unit tests — `prop("B") + 1` where `B` is a formula (order
  matters: `B` computed first, value correct); self-referencing formula → cycle
  error; two formulas referencing each other → both `cycle`, evaluated once;
  a 3-node cycle does not recurse; rollup→formula chain matches R21.18's
  example (`prop("Progress") >= 0.5`).

- **R22.9 — Parse once per distinct expression.** `evaluateFormula` memoizes
  the tokenize+parse result keyed by the expression string (bounded LRU, 1 000
  entries, invalidated only by expression text — DC3). A 500-row table with 3
  formula properties must tokenize **3** times per render pass, not 1 500
  (today: `formula.ts:256` runs `tokenize(source)` on every call from
  `database-view.tsx:359`).
  *Acceptance:* red unit — instrumented tokenizer counter: 500 × 3 evaluations
  → 3 tokenizations, 1 parse; distinct expressions each parse once; after
  LRU eviction (1 001st distinct expression) behavior is still correct; a
  changed expression re-parses.

- **R22.10 — Friendly invalid states everywhere.** Errors render as
  `⚠ <short reason>` in the cell with the full parser message in `title`
  (replacing `#${error}`, `database-view.tsx:360`, `view-parts.tsx:631-632,644`)
  and the same line in the side peek (`database-view.tsx:1074-1078`). The
  property header shows an "invalid formula" dot whose menu entry **Fix
  formula** opens the editor at the error (column menu pattern,
  `view-parts.tsx:187-191`) — so a 500-row table shows one flag on the
  property, not 500 badges (per-row `⚠` still renders for the *selected* row in
  the side peek). Short reason selection uses `code` (DC4) with a default of
  the raw message. All strings via `t()` in all 5 locales
  (`i18n.ts` en/fr/es/de/ar blocks); the coherence i18n ratchet may grow, never
  shrink (`check-coherence.mjs:25-26,81-84`).
  *Acceptance:* targeted e2e (`e2e/formula.spec.ts`, own file per playbook) —
  break a formula, assert cell shows `⚠`, header dot present, `Fix formula`
  opens the editor with the bad expression; `check:a11y` green (icon-only dot
  carries an `aria-label`); coherence `COHERENT`.

- **R22.11 — Typed rollup values into formula scope.** New export
  `aggregateTyped(values, fn): FormulaValue | null` shares `aggregate`'s switch
  (`rollup.ts:77-111`) but returns: numeric functions (`sum, avg, min, max,
  median, range`) → `number | null`; `count, count_empty, checked, unique,
  percent_checked` → `number`; `earliest, latest` → `"YYYY-MM-DD" | null`;
  `show_original, unique` → `string`; empty input → `null` (display still
  `"—"`, `rollup.ts:99,107`). `percent_checked` follows the existing
  fraction convention (`0.83` typed, `"83%"` displayed — same convention as
  NUMBER percent at `database-query.ts:269-271`). `computeFormula` puts the
  **typed** value into scope for `ROLLUP` properties; `computeRollup` keeps
  using the display string for the cell.
  *Acceptance:* red unit — `prop("Progress") * 100` with a typed `0.83`
  rollup → `83`; rollup over no rows → `null` → `empty()` true; display path
  unchanged (existing `rollup.test.ts:7` cases still pass untouched).

### 4.3 M3 — editor, server validation, view participation

- **R22.12 — Formula editor (design of record for B21's R21.16).** Replace the
  `PromptDialog` textarea (`database-view.tsx:1163-1175`, hint `:1156`) with
  `FormulaEditorDialog` per §6: expression input with property/function
  autocomplete, live parse line, current-row preview, Save disabled while the
  expression fails to parse, Cancel restores the previous expression, Esc
  closes. Entry points unchanged (column menu `view-parts.tsx:187-191`,
  wiring `database-view.tsx:999`). Existing save path and `formulaSaved` toast
  (`database-view.tsx:460-468`) are preserved.
  *Acceptance:* targeted e2e in `e2e/formula.spec.ts` — open editor, type
  `pro`, pick a property from the popup (inserts `prop("Name")`), save → cell
  computes + toast; type `1 +` → error line visible + Save disabled; Esc leaves
  the expression unchanged; `npm test -- src/lib/formula.test.ts` green.

- **R22.13 — In-editor function reference.** The editor's reference panel is
  generated from `FORMULA_FUNCTIONS` (R22.1): grouped by category (logic, math,
  text, date, property), searchable, each entry showing signature + one-line
  doc, click/Enter inserts the call with the caret inside the first argument.
  §5 is the static twin of this panel; a drift test keeps them aligned.
  *Acceptance:* red unit — every catalogue entry renders (label + signature
  non-empty, unique ids); e2e — open reference, search `rou`, insert
  `round()`, expression parses.

- **R22.14 — Server parse-validation contract** (the contract B21's R21.15
  implements; §8 is the normative detail). `updatePropertyAction` for a
  `FORMULA` property runs `parseFormula(expression, {propertyNames})` from the
  shared module **before** the write (`database.ts:114-122`) and rejects with
  the parser's own message when: the expression is non-empty and fails to
  parse; any referenced property name does not exist in that database; bounds
  are exceeded (≤ 10 000 chars, depth ≤ 64 — R21.14/R22.16); an unknown
  function is called (catalogue allow-list, R22.1); `config` exceeds 16 KiB.
  **Empty expression is valid** (it means "unset" and renders `"—"`,
  `database-view.tsx:351`; matches the create default `{expression:""}`,
  `database.ts:79-80`). The message returned to the client is byte-identical
  to the editor's live line (§8.3). On rejection **nothing is written** — no
  partial config, no rename half-applied.
  *Acceptance:* red action tests — `prop(` → `{error}` + config unchanged
  (re-read assertion); unknown property name → error; valid → saved; empty →
  saved; 10 001-char expression → error; `config` > 16 KiB → error; guest /
  cross-workspace behavior unchanged (`database.ts:110-112` authorize +
  `canEditContent`).

- **R22.15 — Computed columns participate in filter and sort.** `applyView`
  (`database-query.ts:623-634`) accepts an optional computed-value accessor
  `computed?: (row, propertyId) => FormulaValue | string | null`;
  `comparable()` (`:323-335`) consults it for `FORMULA`/`ROLLUP` properties
  before falling back to stored values, so numeric results compare as numbers,
  booleans as `0/1`, text lexically, `null` as empty — with the existing
  empties-last rule preserved (`compareBySorts :513-518`). The client passes
  `computedFor`; the server passes B21's `computedByRow` (R21.13) when it
  lands. Grouping stays limited to `SELECT/STATUS/MULTI_SELECT`
  (`view-settings.tsx:59-61`) — out of scope, matching the product class.
  *Acceptance:* red cases in `src/lib/database-query.test.ts` — sort a formula
  column `asc`/`desc` orders rows by computed value with empties last; filter
  `contains`/`gt`/`is_empty` on formula values match computed results; **no
  accessor → behavior identical to today** (regression guard).

- **R22.16 — Safety invariants.** (a) The engine never gains `eval`,
  `new Function`, dynamic `require` or regex-driven code paths — the whitelist
  parser (`formula.ts:22-250`) is the invariant, and regex features stay
  deferred (§4.5). (b) Bounds enforced *inside* `formula.ts` (≤ 10 000 chars,
  recursion depth ≤ 64) per R21.14, and again at save time per R22.14.
  (c) Evaluation is pure and total: no I/O, no `Date` reads other than
  `now`/`today` (`formula.ts:205-206`), no global state — required so the same
  module is safe to run inside a server action.
  *Acceptance:* red unit — 10 001-char expression → `code:"bounds"`; 65 nested
  parens → `code:"bounds"`, no stack overflow; a repo-level assertion (extend
  `scripts/audit-inventory.mjs`'s placeholder scan or a unit test over the
  source) fails if `eval(`/`new Function(` appears under `src/lib/formula.ts`.

### 4.4 Matrix traceability — section 5, 16 rows (`FEATURE_MATRIX.md:314-329`)

| Row (`:line`) | Owner / requirement | Note |
| --- | --- | --- |
| Formula editor (`:314`) | **R22.12, R22.13** (baseline R21.16) | §6 design of record |
| Arithmetic operators (`:315`) | **R22.2** (implemented today, `formula.ts:145-170`) | semantics locked, not greenfield |
| Comparison operators (`:316`) | **R22.2** (`formula.ts:123-143`) | strict `==`, numeric comparisons |
| Boolean operators (`:317`) | **R22.2** + keywords via **R21.17** | `&& \|\| !` exist (`:63,173`); `and/or/not` keywords land with R21.17, catalogue (R22.1) covers both |
| Property references (`:318`) | **R22.3, R22.6, R22.7** | empty model + rename + unknown-ref |
| Math functions (`:319`) | **R22.1, R22.5**; `ceil`/`floor` via **R21.17** | reference §5.2 |
| Text functions (`:320`) | **R22.1, R22.5**; `slice`/`replace` via **R21.17** | reference §5.2 |
| Logic functions (`:321`) | **R22.1, R22.5**; `ifs` via **R21.17** | `if` today (eager) |
| Date functions (`:322`) | **R22.4** (`now`/`today` call forms); `dateAdd`/`dateBetween`/`formatDate` via **R21.17** | date functions additionally need DATE cells to enter scope as ISO strings — noted as a R21.17 precondition in §5.6 |
| List functions (`:323`) | **Deferred** — O22.2 | needs a list value type (language extension); design constraints in §12 |
| Regex functions (`:324`) | **Deferred** — B21 O21.3 | untrusted-pattern cost; would violate R22.16(a) unless sandboxed |
| Regex extraction (`:325`) | **Deferred** — B21 O21.3 | same |
| Rollups in formulas (`:326`) | **R22.8, R22.11** (+ B21 R21.18 ordering) | typed values, ordering, cycles |
| Formula error states (`:327`) | **R22.4, R22.7, R22.10** (+ B21 R21.19 migration flagging) | friendly states + property badge |
| Formula result caching (`:328`) | **R22.8, R22.9** (B21 deferred this as O21.4) | parse-cache now, value-cache later (DC3) |
| Named constants (`:329`) | **Deferred** — O22.3 | workspace-level scope injection, no engine change needed |

### 4.5 Non-goals (this spec)

- Regex functions/extraction (matrix `:324-325`, B21 O21.3) — see R22.16(a).
- List functions `map/filter/sort/join` (matrix `:323`) — O22.2, §12.
- Named constants (matrix `:329`) — O22.3.
- Persisting computed values / server-side per-row evaluation (DC1, B21 R21.14).
- Grouping by computed columns (`view-settings.tsx:59-61` intentionally
  unchanged).
- Rollup *filter* clauses ("where" in a rollup — B21 non-goal), relation
  plumbing, and relation picker UI (all B21).
- Import/export of formula expressions, sharing formulas across databases,
  AI-assisted authoring.

## 5. Function reference (normative)

> This section is the language contract. §4 requirements cite it; the in-editor
> panel (R22.13) is generated from the same catalogue (R22.1).

### 5.1 Literals and grammar

| Form | Syntax | Notes / evidence |
| --- | --- | --- |
| Number | `12`, `1.5`, `1_000` | digits/`.`/`_` only — `_` stripped, then `Number()`; **no `1e3` exponent form** (`formula.ts:31-37`: `[0-9._]` scan, so `1e3` lexes as `1` + identifier `e3` → error) |
| String | `"hi"`, `'hi'`, escapes `\" \\ \n` (any escaped char passes through) | `:38-54` |
| Boolean | `true`, `false` (case-insensitive) | `:192-194` |
| Property ref | `prop("Name")` — case-insensitive name match | `:214-220`; rename rewrite R22.6 |
| Date-ish values | bare `today` → `"YYYY-MM-DD"`; bare `now` → epoch ms number | `:205-206`; call forms `now()`/`today()` added by R22.4 |
| Grouping | `( … )` | `:184-188` |

### 5.2 Operators (precedence high → low)

| Level | Operators | Assoc / result | Evidence |
| --- | --- | --- | --- |
| 1 | `!`, unary `-` | right; boolean / number | `formula.ts:172-176` |
| 2 | `*` `/` `%` | left; **number** (NaN → R22.4 error) | `:161-170` |
| 3 | `+` `-` | left; `+` → number **or string concat if either side is a string**, `-` → number | `:145-159` |
| 4 | `<` `<=` `>` `>=` | left; both sides `Number()` | `:133-143` |
| 5 | `==` `!=` | left; strict `===` / `!==`, **no type coercion** | `:123-131` |
| 6 | `&&` | left; booleanizes operands, returns boolean | `:114-121` |
| 7 | `\|\|` | left; booleanizes operands, returns boolean | `:105-112` |

### 5.3 Functions (current catalogue — R22.1 makes this table machine-checked)

| Signature | Returns | Semantics / evidence |
| --- | --- | --- |
| `prop(name)` | value of that property (`null` if empty, R22.3) | case-insensitive name lookup; **unknown → error** (R22.7; today `""`, `formula.ts:214-220`) |
| `if(cond, then, else)` | value of a branch | **eager**: both branches evaluated (`:199-203`), exactly 3 args (R22.5) |
| `concat(a, b, …)` | string | every argument `String()`-ed (`:223-224`) |
| `length(s)` | number | `String(s).length` (`:225-226`) |
| `upper(s)` / `lower(s)` | string | (`:227-230`) |
| `contains(hay, needle)` | boolean | **case-insensitive** substring (`:231-232`) |
| `empty(x)` | boolean | `String(x).trim() === ""` (`:233-234`); true for `null` (R22.3) |
| `abs(n)` | number | `Math.abs(Number(n))` (`:235-236`) |
| `round(n, digits = 0)` | number | `digits` 0–9; `Math.round`-based (`:237-241`) |
| `min(n, …)` / `max(n, …)` | number | ≥ 1 arg (R22.5; today 0 args → `Infinity`, `:242-245`) |
| `now` (ident) / `now()` (R22.4) | number (epoch ms) | `:205` |
| `today` (ident) / `today()` (R22.4) | string `YYYY-MM-DD` | `:206` |

Not implemented today, specified by **B21 R21.17** and appended to this table
when they land: `ifs`, `ceil`, `floor`, `slice`, `replace`, `dateAdd`,
`dateBetween`, `formatDate`, and the keyword forms `and` / `or` / `not`
(`formula.ts:63-71,173` is tokens-only today).

### 5.4 Coercion & error semantics (normative — R22.2)

| Situation | Rule | Consequence |
| --- | --- | --- |
| `+` with any string operand | string concatenation | `"Total: " + 12` → `Total: 12` |
| `- * / %` with a string operand | `Number(string)` first | `"3" * 2` → `6`; `"abc" * 2` → **error** (R22.4), not `NaN` |
| Comparison with mixed types | `Number()` both sides | `"10" < "9"` → `true` (numeric) |
| `==` across types | strict `===` | `1 == "1"` → **`false`** (documented quirk, matrix `:703`) |
| `&&` `\|\|` `!` | `Boolean()` operands → boolean result | `prop("X") \|\| "none"` returns a **boolean**, never the fallback text — use `if(empty(prop("X")), "none", prop("X"))` |
| `if()` branches | evaluated eagerly | a failing branch errors the whole expression even when not taken |
| Empty cell in scope | `null` (R22.3) | `empty()` true; numeric ops see `0`; string ops see `""` |
| Non-finite result | error (R22.4) | cells never show `NaN`/`Infinity` |
| Unknown function | error listing the catalogue | `formula.ts:246-247` |
| Unknown property | error naming it (R22.7) | replaces silent `""` |
| Empty expression | `{ok:false, "Empty formula"}` | `formula.ts:254`; renders `—` in the cell (`database-view.tsx:351`), not an error badge |

### 5.5 Error taxonomy (feeds R22.10's friendly text)

| `code` | Raised by | Example message |
| --- | --- | --- |
| `parse` | tokenizer/parser | `Unexpected character "@"`, `Missing closing parenthesis`, `Unexpected trailing input` (`formula.ts:73,88,187,201`) |
| `arity` | R22.5 | `round() expects round(number, digits?)` |
| `unknown_function` | `call()` default | `Unknown function "foo"` (`:246-247`) |
| `unknown_property` | R22.7 | `Unknown property "Ghost"` |
| `not_finite` | R22.4 | `Result is not a number` |
| `cycle` | R22.8 | `Circular reference: A → B → A` |
| `bounds` | R21.14 / R22.16 | `Formula too long` / `Too deeply nested` |

### 5.6 Interaction notes

- **Date functions (R21.17) precondition:** `DATE` cells currently enter scope
  as formatted display text (`database-view.tsx:357` → `formatCell`,
  `database-query.ts:287-301`), i.e. locale-formatted strings. `dateAdd` /
  `dateBetween` / `formatDate` must receive ISO day strings — the scope builder
  must special-case `DATE` (like `NUMBER`/`CHECKBOX` already are, `:355-356`).
  This spec owns the note; R21.17 owns the functions.
- **Non-determinism:** `now`/`today` are the only impure inputs; they must be
  excluded from any future value-level cache key (DC3) or captured once per
  evaluation pass.
- **Growth rule:** a function may not exist in code without appearing in
  `FORMULA_FUNCTIONS` (R22.1), this table (R22.13's static twin), and
  `formula.test.ts` (B21 R21.17's rule, restated).

## 6. Formula editor UX spec

> Design of record for B21's R21.16 (§1.1). Replaces the `PromptDialog`
> textarea: title `database-view.tsx:1146-1147`, static hint `:1156`, single
> multiline field `:1163-1175`.

### 6.1 Entry & container

- Entry points unchanged: column menu **Edit formula**
  (`view-parts.tsx:187-191`) and — new — **Fix formula** on the invalid-state
  dot (R22.10). Both open `FormulaEditorDialog`.
- Container: existing `Dialog` primitive (`src/components/ui/dialog`), wider
  than `PromptDialog`'s `max-w-md` (`prompt-dialog.tsx:76`): `max-w-2xl`.
  Keeps the focus trap / Escape / focus-return behavior `PromptDialog`
  documents (`:20-23`) — that behavior must not regress.
- Sections: header (property name + `formulaWord`), expression input, error
  line, preview row, function reference (collapsible), footer
  (`Cancel` / `Save formula`).

### 6.2 Expression input

- Monospace textarea (`prompt-dialog.tsx:101` styling), min 3 rows, grows to
  8; **syntax highlighting overlay** for strings, numbers, operators,
  `prop("…")`, function names (render-only; the source of truth stays the
  plain text).
- Autocomplete popup triggers on: identifier typing, `prop("` → property names
  of the current database (from the loaded `properties` list,
  `database-view.tsx:337-339` pattern), and `(` after a function name →
  signature. Suggestions merge `FORMULA_FUNCTIONS` (R22.1) and property names,
  labeled distinctly (ƒ vs column glyph `view-parts.tsx:885-890`).

### 6.3 Live validation

- On each input (debounced 150 ms): run `parseFormula` → render the error line
  (§5.5 code → friendly text, R22.10) with the raw message as `title`.
  Valid → line replaced by a subtle `✓` or hidden.
- **Save disabled** while the expression fails to parse (empty expression is
  *allowed* and means unset — R22.14).
- Validation is client-side UX; the server re-validates (R22.14), so a stale
  tab cannot bypass it.

### 6.4 Preview

- One line under the input: `Preview (row: <row title>) → <value>`, evaluated
  against the row that opened the editor, in the same scope builder as the
  table (`database-view.tsx:348-361`), so what you see is what the cell will
  show. Errors here render the friendly form.

### 6.5 Function reference panel

- Collapsible right/bottom section listing the catalogue grouped by category,
  search box, signature + one-line doc per entry, Enter/click inserts
  `name()` with caret in the first argument (R22.13).

### 6.6 Keyboard

| Key | Action |
| --- | --- |
| `Ctrl/Cmd+Space` | open autocomplete explicitly |
| `↑ ↓` | move suggestion |
| `Tab` / `Enter` (popup open) | insert suggestion |
| `Enter` (popup closed) | newline (multiline) |
| `Esc` | close popup first, then dialog |
| `Ctrl/Cmd+Enter` | save |

### 6.7 States

| State | Rendering |
| --- | --- |
| Never configured (`expression === ""`) | empty input + hint `Start with prop("Name")` — **no error line** (empty is valid) |
| Invalid on open (broken formula) | error line visible, Save disabled, **Fix formula** path |
| Saving | footer button `working` (`prompt-dialog.tsx:129` reuse), existing `formulaSaved` toast on success (`database-view.tsx:465`) |
| Cancel / Esc | previous expression untouched (no `updatePropertyAction` call) |

### 6.8 i18n & a11y

- New keys through `t()` in all 5 locales (blocks listed at
  `i18n.ts:474-524,1166-1216,1853-1903,2540-2590,3227-3277`); existing
  `editFormula`, `formulaWord`, `formulaFor`, `saveFormula`, `formulaSaved`
  keys are reused. The i18n ratchet may grow, never shrink
  (`check-coherence.mjs:81-84`).
- Autocomplete is an ARIA combobox (listbox + `aria-activedescendant`); the
  error line is `role="alert"`; `check:a11y` must stay green.

## 7. Dependency & invalid-state handling

### 7.1 Evaluation pipeline (target)

```
properties of database
  → per-expression tokenize pass  →  deps: propertyId → referenced names   (R22.8)
  → order: rollups (B21 R21.18) → formulas topologically
  → per row: build scope (stored values + computed values so far)          (R22.3, R22.11)
  → evaluateFormula (AST memoized per expression)                          (R22.9)
  → result map: propertyId → {ok, value | error{code, message}}            (DC4)
  → render: value | friendly error | "—" (null/empty)                       (R22.10)
```

- **Cycle members** are detected once per database (not per row) and every row
  renders `cycle` for those properties without re-running evaluation.
- **Missing references** (`unknown_property`, R22.7) are also per-database
  findings: the property-level flag (R22.10) points at the offending reference.

### 7.2 Rename, delete, type change

| Event | Behavior | Requirement |
| --- | --- | --- |
| Rename property P in D | rewrite `prop("P")` (case-insensitive) → new name in all FORMULA configs of D, same transaction | R22.6 |
| Delete property P | dependents keep their text; evaluation of `prop("P")` → `unknown_property` error + property flag (never silent `""`) | R22.7, R22.10 |
| Edit a formula | invalid expression cannot be saved (editor + server) | R22.12, R22.14 |
| Add a formula that references a not-yet-existing name | rejected at save (server rule) — references must resolve | R22.14 |
| Type change of a referenced property | out of scope (B21/`⛔` matrix row `:307`); scope re-derives types on next render, so values stay coherent | — |

### 7.3 Invalid-state surface map

| Surface | Today | Target |
| --- | --- | --- |
| Table cell | `#<raw message>` (`database-view.tsx:360`) | `⚠ <short reason>` + `title` raw message (`view-parts.tsx:631-632,644`) |
| Side peek | same raw string (`:1074-1078`) | friendly line + raw message below in small text |
| Column header | nothing | invalid dot + **Fix formula** menu item |
| Editor | nothing until after save | live error line (§6.3) |
| Whole table | error repeated per row | one property-level flag; per-row `⚠` only for the row shown in the peek |
| Migration-found errors | — | B21 R21.19 records them; same flag (§1.1) |

## 8. Server parse-validation approach

> Normative detail for B21's R21.15 anchor (§1.1). Implemented inside
> `updatePropertyAction` (`database.ts:101-125`), which today writes `config`
> unchecked (`:118-120`).

### 8.1 Contract

```ts
// in src/lib/formula.ts (isomorphic — no DOM/fs access, DC1/R22.16(c))
export function parseFormula(
  expression: string,
  scope: { propertyNames: string[] },
): { ok: true } | { ok: false; error: string; code: FormulaErrorCode };
```

- The client editor calls it for the live line (§6.3); the server action calls
  the **same function** for the rejection — one code path, one message.
- `evaluateFormula` (unchanged signature, `formula.ts:252`) is
  `parseFormula` + evaluation; existing 6 tests keep passing.

### 8.2 Rejection rules (all checked before any write)

| # | Rule | Fails when |
| --- | --- | --- |
| V1 | Parse | non-empty expression does not parse |
| V2 | References | a `prop("…")` name is not in `propertyNames` of that database (R22.14; case-insensitive per `:216-218`) |
| V3 | Functions | called name not in `FORMULA_FUNCTIONS` (R22.1) |
| V4 | Arity | argument count violates the catalogue (R22.5) |
| V5 | Bounds | length > 10 000 or depth > 64 (R21.14, R22.16) |
| V6 | Size | serialized `config` > 16 KiB |
| V7 | Empty | **not a failure** — `""` persists (unset) |

### 8.3 Message identity

The `error` string returned to the client is produced by the parser, verbatim
— identical to the editor's live line. No server-only wording, no translated
message on the wire (translation happens client-side by `code`).

### 8.4 No partial write

Rejection happens **before** `prisma.property.update` (`database.ts:114`):
nothing — name, position, other config keys — is written. The action returns
`{ error }`, the caller surfaces it via the existing toast path. Authorization
order is unchanged: `authorizeDatabase` → `canEditContent` first
(`:110-112`), so validation errors never leak existence of properties across
tenants.

### 8.5 Why not validate on render only (status quo)

Render-time validation (a) multiplies one bad expression into N row errors,
(b) can be bypassed by any client that writes `config` directly
(`setPropertyValueAction`'s pattern, `database.ts:192-200`, shows how little
the actions assume), (c) gives the author no failure point at save — the toast
says "Formula saved" (`database-view.tsx:465`) while every cell is already red.

## 9. Data model

**No schema change.** Everything lives in the existing JSON columns:

```ts
// Property.config — FORMULA (unchanged shape; now validated by R22.14)
{ expression: string }            // "" = unset, renders "—"

// Property.config — ROLLUP (B21 R21.10 owns the shape)
{ relationPropertyId, targetPropertyId, function }

// evaluation result (in-memory only, never persisted — DC1)
{ ok: true, value: number | string | boolean | null }   // R22.3
| { ok: false, error: string, code?: FormulaErrorCode } // DC4
```

- No `prisma db push` for any requirement in this spec → no Tier MAX gate for
  M1–M3 (FAST/STANDARD tiers per `scripts/LOOP_PLAYBOOK.md:34-38`).
- Computed values are **never** written to `PropertyValue`
  (`database.ts:192-200` stays for stored types only).

## 10. Test plan

**Unit (vitest, red-first — `npm test -- src/lib/formula.test.ts` etc.)**

1. *Semantics table* — one case per §5.4 row (R22.2), one per §5.2 operator
   (R22.2), extending `formula.test.ts` (today 6 cases, `:10-46`).
2. *Catalogue drift* — `FORMULA_FUNCTIONS` ↔ `call()` ↔ §5.2/5.3 tables
   (R22.1, R22.13).
3. *Empty model* — `null` scope values, `empty()`, coercions, `"—"` rendering
   (R22.3).
4. *Not-finite + arity* — `1/0`, `"a" - 1`, `min()`, `if(true)`, `round()`
   (R22.4, R22.5).
5. *Unknown property* — error vs `null`-value distinction, case-insensitive
   match preserved (R22.7).
6. *Dependency order + cycles* — formula→formula, self, 3-node cycle, rollup→
   formula chain (R22.8) — pure helpers, no React.
7. *Parse cache* — instrumented tokenizer: 500 rows × 3 formulas → 3
   tokenizations; LRU boundary (R22.9).
8. *Typed rollups* — `aggregateTyped` per function + `aggregate` unchanged
   (R22.11, and `rollup.test.ts`'s 7 cases must stay green untouched).
9. *Bounds/safety* — 10 001 chars, 65 nested parens, no-stack-overflow, no
   `eval` in source (R22.16).

**View/query unit (`src/lib/database-query.test.ts`)**

10. *Computed sort/filter* — asc/desc by formula value with empties last;
    `contains`/`gt`/`is_empty`; no-accessor regression (R22.15).

**Server action tests**

11. *Validation matrix* — V1–V7 with re-read assertions of `config`
    unchanged on failure; auth/guest/cross-workspace unchanged (R22.14,
    aligning with B21's R21.15 tests).
12. *Rename propagation* — 2 dependents rewritten, 1 non-dependent untouched,
    values stable (R22.6).

**e2e (Playwright — new `e2e/formula.spec.ts`, own file per playbook
file-ownership rule, `scripts/LOOP_PLAYBOOK.md:65-71`; dedicated pages +
try/finally cleanup)**

13. *Editor happy path* — open, autocomplete property, save, cell computes,
    `formulaSaved` toast (R22.12).
14. *Editor invalid path* — `1 +` → error line, Save disabled, Esc cancels
    (R22.12).
15. *Invalid property flag* — broken formula → cell `⚠`, header dot,
    **Fix formula** reopens editor (R22.10); a11y-checked.
16. *Sort a formula column* — computed order visible after clicking sort
    (R22.15).

**Non-regression & gates**

- Existing `formula.test.ts` (6) + `rollup.test.ts` (7) green unchanged
  except where a requirement explicitly changes behavior (R22.3, R22.7 — those
  cases are updated **with** their requirement, cited by ID).
- `npm run typecheck`, `npm run lint`, `npm run check:coherence` → `COHERENT`
  (`check-coherence.mjs:93`); `check:a11y` green.
- **Tier:** spec batch = FAST (no build, no e2e, no `docs:counts`/`docs:gaps`
  — orchestrator-only, playbook `:59-60,84-87`). Implementation batches: M1
  FAST (pure lib), M2/M3 STANDARD (targeted e2e against dev `:3201`).

## 11. Delivery plan (milestones → tasks ↔ requirements)

> Test-first rule from `scripts/LOOP_PLAYBOOK.md` applies: every task's
> acceptance is a red test citing its requirement IDs before implementation.

**M1 — Engine contract (~1–2 days, pure lib, FAST tier)**

- T22.1 [R22.1, R22.5]: `FORMULA_FUNCTIONS` catalogue + arity check + drift
  tests. Red: unit 2, 4.
- T22.2 [R22.2]: semantics-lock tests for §5.2/§5.4. Red: unit 1.
- T22.3 [R22.3]: `FormulaValue | null` + scope/render empty rules. Red: unit 3.
- T22.4 [R22.4]: `not_finite` guard in `evaluateFormula`. Red: unit 4.
- T22.5 [R22.4]: `now()`/`today()` call forms. Red: unit 4 (4 cases).

**M2 — Dependencies, invalid states, display (~2–3 days)**

- T22.6 [R22.8]: dependency extraction + topological ordering + cycle
  detection as pure helpers (`src/lib/formula-deps.ts` or in-module). Red:
  unit 6.
- T22.7 [R22.9]: AST memo + evaluation pass. Red: unit 7.
- T22.8 [R22.7]: unknown-property error. Red: unit 5.
- T22.9 [R22.11]: `aggregateTyped` + scope projection. Red: unit 8.
- T22.10 [R22.6]: transactional rename rewrite in `updatePropertyAction`.
  Red: action test 12.
- T22.11 [R22.10]: friendly error states + property flag + `Fix formula`
  (5 locales). Red: e2e 15; coherence/a11y.

**M3 — Editor, validation, view participation (~2–3 days, STANDARD tier)**

- T22.12 [R22.14, R22.16]: `parseFormula` + V1–V7 in `updatePropertyAction`.
  Red: action test 11 + unit 9. *(Coordinates with B21 R21.15 — whichever
  batch lands first ships the helper; the other ships the rules not yet
  covered.)*
- T22.13 [R22.12]: `FormulaEditorDialog` — input, autocomplete, live error,
  preview, keyboard. Red: e2e 13, 14.
- T22.14 [R22.13]: reference panel generated from the catalogue. Red: unit 2
  (panel data) + e2e insert case.
- T22.15 [R22.15]: computed accessor through `applyView`/`comparable`. Red:
  unit 10 + e2e 16.

## 12. Risks & open questions (honest)

**Risks**

1. **Overlap with B21's M3 (highest process risk).** R21.14–R21.18 and
   R22.1/R22.12–R22.14/R22.8 touch the same module. Mitigation: §1.1 assigns
   design-of-record (this doc) vs anchor (B21); implementation batches must
   read both before touching `formula.ts`, and the first mover lands the shared
   helper (`parseFormula`, `FORMULA_FUNCTIONS`) so the second only extends it.
2. **Behavior changes are breaking by design.** R22.3 (`null` scope) and R22.7
   (unknown property errors) change results of expressions that "worked"
   (silently). Mitigation: both ship with their red tests, are called out in
   release notes, and B21's R21.19 migration flags the newly-erroring formulas
   instead of leaving cells ambiguous.
3. **Autocomplete UI on `workers:1` e2e.** A popup + textarea is a classic
   flake source (playbook `:117-139`). Mitigation: dedicated
   `e2e/formula.spec.ts`, one editor scenario + one invalid scenario, generous
   polling, existing dialog focus-trap helpers rather than new selectors.
4. **Parse-cache staleness (DC3).** An LRU keyed by expression text cannot go
   stale on row data (AST has no values in it), but a bug in the key would
   reuse a wrong AST. Mitigation: key is the exact expression string; unit 7
   asserts distinct strings → distinct parses; no value-level caching yet.
5. **i18n drift.** 5 locales × new editor strings; a missing key falls back
   silently. Mitigation: keys added in one commit across all five blocks
   (`i18n.ts`), coherence's `i18nFiles` ratchet may grow only
   (`check-coherence.mjs:81-84`).

**Open questions**

- **O22.1** — Value-level result caching (matrix `:328`'s second half): cache
  `(rowId, propertyId)` results and invalidate from the dependency graph? The
  graph lands in R22.8 and parse caching in R22.9; measure first — 500 rows ×
  3 formulas after R22.9 may already be fast enough (R22.9's acceptance is a
  *count*, not a ms budget).
- **O22.2** — List functions (`map/filter/sort/join`, matrix `:323`): needs a
  `FormulaList` value type, lambda syntax or column-predicate syntax, and
  bounds on list size. Design constraint if taken: must stay pure/total
  (R22.16(c)) and must not break `FormulaResult` consumers. Spec a slice in a
  later batch; keep the row `🧭`.
- **O22.3** — Named constants (matrix `:329`): workspace-scoped
  `constant("name")` injected into `FormulaScope` by the caller — no parser
  change; needs a store + editor UI. Later batch.
- **O22.4** — Should `prop()` also accept a property **id** (for programmatic
 /API-authored formulas) in addition to the name? Cheap to add alongside the
  name path (`formula.ts:216-220`) but adds a second reference identity; decide
  when the API surface batch (B24) lands.
- **O22.5** — Non-`en` number/date rendering in formula results: cells format
  NUMBER with fixed `en-US` locale (`database-query.ts:265-276`) while
  formulas produce raw `String(value)` (`database-view.tsx:360`). Should a
  numeric formula result pass through `formatCell`'s NUMBER formatting? Needs a
  product decision (consistency vs. "a formula returns a value, not a
  formatting").
