# Noema — Remediation Plan

**Status:** executable task list. Written to be worked through item-by-item without
conversation context. Every item is atomic: it names the files, the exact defect, the
change, the test, and the condition that closes it.

Derived from the scout/quality/security sweep recorded in `potential.md` (Oct 2026),
including its adversarial re-verification (34 claims: 28 confirmed, 1 refuted, 5
corrected). Deduped: F2≡S1 (one item), F5≡M4≡M5 (one item). The refuted files-route
header finding is intentionally absent (headers already apply site-wide).

**Baseline (all currently green — nothing below is a build or type failure):**

| Check | Command | Baseline |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | 0 errors |
| Unit tests | `npx vitest run` | 14,943–14,945 pass (2 known-flaky script tests, P3-T09) |
| Audit | `npm audit` | 0 vulnerabilities |
| E2E | `npx playwright test` | pass (requires dev server up) |

**Definitions of done for every item:**

1. The named test exists and fails before the change, passes after (where a test is prescribed).
2. `npx tsc --noEmit` is clean and the affected test suites pass.
3. No unrelated behaviour is altered. One commit per item where practical.

---

## Phase 1 — Criticals

Data-integrity and user-facing functionality breaks. Each is one commit.

### P1-T01 — Make database creation atomic ✅ DONE

> **Verification (2026-10-27):** commit `e043c6d`, PR #332. Fail-first test
> `pages-seed-atomic.test.ts` (mock ledger: tx writes recorded only on callback
> resolve) failed pre-change — the DATABASE page row survived a mid-seed
> `property.create` rejection — passes post-change: 3/3. Full actions suite
> 99 files / 839 tests green; `tsc --noEmit` clean. Mechanical accommodation:
> `$transaction` pass-through added to the db mocks of `pages.test.ts`,
> `pages-parent-scope.test.ts`, `page-search-text.test.ts` (no assertions
> weakened; the DATABASE-path payload assertions moved to the tx client — same
> payloads).

- **Files:** `src/server/actions/pages.ts:176-273` (called from `createPageAction` at `:162-163`)
- **Defect.** `seedDatabaseStructure` performs ~11 sequential writes (4 × `property.create`,
  `databaseView.createMany`, 2 × `page.create`, 4 × `propertyValue.create`) with **no
  `$transaction`**, called after the parent page already exists. A mid-seed failure or crash
  leaves a `DATABASE` page with missing properties/views — permanently broken. Sibling paths
  do this correctly (`import.ts:259`, `row-cells.ts:497` use `$transaction`).
- **Change:** wrap the page create + seed in one `prisma.$transaction(async (tx) => …)` and
  thread the transaction client through all seed writes. Do not change the seed logic itself.
- **Test:** unit test — stub a `property.create` rejection after page creation; assert no
  `DATABASE` page row survives.
- **Done when:** the test fails on current code and passes after.

### P1-T02 — Fix the dead short link in the share dialog ✅ DONE

> **Verification (2026-10-27):** Option B implemented — `Page.shortCode` unique
> nullable alias (migration `20261027000000_page_short_code`, applied to dev DB),
> stamped lazily by `ensurePageShortCode()` at publish / share-state read.
> Resolver `shortCodeToken()` in `/s/[token]/page.tsx`: `isValidShortCode` gate →
> indexed lookup → re-derivation guard → live published page-level ShareLink
> (`viewId: null`, not deleted, not expired) → redirect to `/s/<liveToken>`
> (temporary; zero UI duplication — password/expiry/fail-closed come from the
> canonical path). Direct tokens keep the byte-for-byte original path. New test
> suites: page.test.ts (7), share-form-link.test.ts (4), share-dialog.test.ts
> (3) — fail-first evidenced, 118 tests green across 7 touched suites; tsc clean.

- **Files:** `src/components/share-dialog.tsx:371-379,538-545,221-231`; resolver
  `src/app/s/[token]/page.tsx:107`; `src/lib/short-link.ts` (its only production consumer
  is the dialog)
- **Defect.** The dialog derives a deterministic 7-char code via
  `generateShortCode({ seed: pageId })`, renders `https://host/s/<code>` with a "Copied"
  toast — but the only resolver is `prisma.shareLink.findUnique({ where: { token } })`
  against the full 32-char random token (`randomToken(24)`). No rewrite
  (`next.config.ts:143-158` is headers-only), no middleware handling (`src/middleware.ts`
  is CSP-only). Every copied short link lands on `UnavailableState`.
- **Change (pick one, record the decision):**
  - Option A (remove): delete the LinkSection row + `short-link.ts` + its tests.
  - Option B (implement): in `/s/[token]`, detect a valid short-code form → look up the
    page's **existing published** `ShareLink` (must point at a real token, never resolve
    directly to the page) → redirect. Unpublished/expired pages must fail closed.
- **Test:** if Option B — e2e/unit: publish a page, resolve the short URL, assert a
  redirect to the real share URL; assert an unpublished page's short URL rejects.
- **Done when:** no dead link is copyable from the share dialog.

### P1-T03 — Form-share token must not leak into page share state ✅ DONE (uncommitted — Wednesday batch)

> **Verification (2026-10-27, staged-only per window policy):** `workspaces.ts`
> `shareLinks` select now `where: { viewId: null }` + `orderBy: { id: "asc" }`
> (`take: 1` kept — schema allows multiple viewId-null rows). `revokeShareLinkAction`
> returns `{ ok, removed }`, logs `page.unshared` only when >0; dialog toasts
> "Not published" instead of a false success. New `share-state-leak.test.ts`
> (5 tests, 4 failed pre-change) + mechanical mock updates in 2 suites.
> Full touched-scope run: 113 files / 933 tests green; tsc clean. HEAD remains
> `e517997` — commit reserved for the Wednesday in-window batch.

- **Files:** `src/server/queries/workspaces.ts:290-293` → consumed at
  `src/app/w/[slug]/[pageId]/page.tsx:348` and `src/components/share-dialog.tsx:432`;
  unpublish at `src/server/actions/share.ts:429-431`
- **Defect.** `getPageDetail` selects `shareLinks: { select: { id, token }, take: 1 }`
  with **no `where: { viewId: null }` and no `orderBy`**. A published **form** link
  (`viewId` set) is picked up as the page token → page dialog shows "published";
  unpublish's `deleteMany({ pageId, viewId: null })` matches 0 rows, still returns
  `{ ok: true }`, logs `page.unshared`, toasts success, and after `router.refresh()` the
  dialog flips back to published. Two surfaces disagree (`getShareLinkStateAction` at
  `share.ts:69` filters correctly).
- **Change:** add `where: { viewId: null }` and a stable `orderBy` to the select at
  `workspaces.ts:290-293`. Optionally have `revokeShareLinkAction` return the delete
  count and log/toast accordingly.
- **Test:** unit — page with only a form link → `shareLinks[0]` is absent; page with both
  kinds → the page-level token is picked deterministically.
- **Done when:** unpublish on a form-only-published page reports "not published".

### P1-T04 — Document or fix the single-instance session/rate-limit store

- **Files:** `src/lib/session-store.ts:102-104`; rate-limit buckets `src/lib/rate-limit.ts:3,338`;
  lockouts `src/server/actions/share.ts:277-281,304`
- **Defect.** Session registry + rate-limit buckets + brute-force lockouts are file/in-process
  only. On horizontally scaled deployments, revocation and lockouts silently don't apply
  across instances (a revoked session keeps working elsewhere; attackers rotate instances to
  dodge rate limits). Code comments acknowledge the limit.
- **Change (pick one, record the decision):**
  - Option A: document loudly — README/SECURITY.md + startup warning when
    `NOEMA_SCALE`-style multi-instance env is detected.
  - Option B: back revocation + lockouts with a shared store (e.g. Postgres table) with a
    file-store fallback.
- **Test:** if Option B — integration test: revoke in one "instance" context, assert
  rejection from another. If Option A — docs-only, no test.
- **Done when:** the deployment model caveat is either documented in all operator-facing docs
  or eliminated in code.

---

## Phase 2 — High/medium severity

Editor correctness first, then server races, then Tauri desktop defects.

### P2-T01 — Autosave single-flight + payload-equal clearing (F2 + S1) ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/components/editor/page-editor.tsx:772-837` (runSave/persist), flush at
  `:1894-1904`
- **Defect.** `runSave` has no in-flight guard. On resolve, `:812-813` unconditionally stamps
  `lastSavedRef` with the possibly-older payload and nulls `pendingPayloadRef`. The common
  "edit lost" framing was refuted by re-verification (`persist()` re-arms the 600 ms debounce
  and the fallback `editor.getJSON()` recovers), but two genuine data-loss windows remain:
  1. **Response-order inversion** — overlapping saves commit older-after-newer server-side.
  2. **Destroyed-editor window** — editor unmounted before the fallback save fires; `runSave`
     returns early at `:784`, and the teardown flush then has nothing to send.
- **Change:** serialize saves (single-flight: skip launching a new save while one is in
  flight, or queue); only clear `pendingPayloadRef` if it still equals the payload just
  saved; in the flush effect, capture the payload before depending on the editor lifecycle.
- **Test:** editor unit tests — (a) two overlapping saves complete in start order;
  (b) a `persist()` during an in-flight save results in a subsequent save that sends the
  newer payload; (c) save-resolve does not null a newer pending payload.
- **Done when:** all three tests fail on current code pattern and pass after.

### P2-T02 — Workspace transfer must be transactional ✅ DONE (uncommitted — Wednesday batch)

> **Verification (2026-10-27, staged-only):** array-form `$transaction([updateMany, update])`
> around the subtree workspaceId update + root re-parent in `transferPageAction`
> (`pages.ts:791-796`, re-located post-merge). Fail-first proven via temporary
> revert/re-apply cycle (subtree write persisted pre-fix when re-parent failed).
> New `pages-transfer-atomic.test.ts` (ledger mock w/ both commit semantics);
> `pages-` scope 7 files/37 tests + transfer-exercising suites 22 tests green; tsc clean.

- **Files:** `src/server/actions/pages.ts:782,787`
- **Defect.** Subtree `workspaceId` `updateMany` and the root re-parent `update` are two
  independent writes; a failure between them strands cross-workspace orphaned children.
- **Change:** `$transaction([...])` around both writes (array form is sufficient).
- **Test:** unit — fail re-parenting after subtree update; assert neither write persisted.
- **Done when:** the test fails before, passes after.

### P2-T03 — Meeting notes creation race (CAS) ✅ DONE (uncommitted — Wednesday batch)

> **Verification (2026-10-27, staged-only):** create-then-CAS inside one
> interactive `$transaction`: `tx.page.create` → `tx.calendarEvent.updateMany
> ({ where: { id, notesPageId: null }, data: { notesPageId } })`; loser path
> (count 0) deletes its candidate page in-transaction, re-reads the winner,
> returns `existing: true`. No placeholder value, no schema change (the missing
> `@unique` remains a noted follow-up). New `calendar-notes-cas.test.ts`
> (4 tests, fail-first evidenced); calendar scope 5 files/32 tests green;
> full server/editor/lib sweep 552 files/12,072 tests green; tsc clean.

- **Files:** `src/server/actions/calendar.ts:198-229`; schema `prisma/schema.prisma:1115`
  (`notesPageId` is a plain `String?`, no `@unique`)
- **Defect.** Read `event.notesPageId`, create page, then **unconditional** `update`
  (`:226-229`). Concurrent calls both see null and create orphan duplicate note pages.
- **Change:** conditional `updateMany({ where: { id, notesPageId: null }, data: … })`
  inside a transaction; if `count === 0`, reuse the winner's page.
- **Test:** unit — two concurrent accepts of a null `notesPageId`; exactly one page row.
- **Done when:** the CAS pattern replaces the unconditional update and the test passes.

### P2-T04 — UNIQUE_ID allocator: monotonic per-property counter (F5 + M4 + M5) ✅ DONE (uncommitted — Wednesday batch)

> **Verification (2026-10-27, staged-only):** `Property.uniqueIdCounter Int
> @default(0)` (migration `20261027140000_unique_id_counter`, applied to dev DB
> via `prisma db execute`, verified in information_schema; 61 existing
> properties stamped 0 → lazy backfill). Allocator: `tx.property.update
> ({ uniqueIdCounter: { increment: 1 } })` inside the row-create tx — Postgres
> row-lock serializes racers; lazy guarded backfill (counter 0 → one
> updateMany to high-water-mark) inside the same tx; O(max-scan) once per
> property ever, then O(1). Property survives hard purge → counter survives →
> no reuse. New `row-cells.test.ts` (7 tests): racing allocations distinct &
> sequential, counter never backwards, output JSON/format regression pinned.
> Full server sweep 114 files/909 tests green; tsc clean; callers
> (createRowAction/submitFormAction) needed zero changes.

- **Files:** `src/server/row-cells.ts:66-89` (allocator), purge path `pages.ts:889`,
  cascade `prisma/schema.prisma:416-424`
- **Defect.** Two problems, one fix:
  1. Read-then-max allocation at read-committed isolation → concurrent rows get **duplicate
     IDs** (no unique constraint on the value; shared by `createRowAction` and
     `submitFormAction`).
  2. Values computed from max-of-remaining → hard purge of a page re-issues `ID-12`, silently
     repointing external references (exports/backlinks treat IDs as identity).
- **Change:** add a persistent monotonically increasing per-property counter (integer column,
  `update: { increment: 1 }` returning the value) that survives hard deletes; allocate from
  it inside the row-create transaction. Migrate existing numbers first (`max+1` per property).
- **Test:** unit — concurrent row creation yields distinct sequential IDs; purge a page,
  allocate again, assert no ID is reused.
- **Done when:** both tests fail before and pass after.

### P2-T05 — Collab seed listener cleanup (leak only; crash claim refuted) ✅ DONE (uncommitted — Wednesday batch)

> **Verification (2026-10-27, staged-only):** seed effect (~:1908-1922 in current
> tree, layered on P2-T01 edits) now returns `() => collab.provider.off("sync",
> seed)`, matching `ticket-description.tsx:397`. No dedicated test added (per
> item); editor scope 35 files/400 tests green; eslint on touched files clean
> (warnings pre-existing).

- **Files:** `src/components/editor/page-editor.tsx:1876-1889`; correct pattern
  `ticket-description.tsx:396-397`; transport cleanup at `page-editor.tsx:1175-1182`
- **Defect.** `provider.once("sync", seed)` is registered with **no cleanup function** while
  the sibling component correctly returns `() => provider.off("sync", seed)`. Verified NOT a
  crash path: the transport cleanup disconnects/destroys the provider, so a post-unmount
  `sync` cannot fire as coded. The defect is the listener/closure leak + inconsistency.
- **Change:** return `() => collab.provider.off("sync", seed)` from the effect.
- **Test:** existing editor suites pass; lint clean.
- **Done when:** cleanup symmetry matches `ticket-description.tsx`.

> **Verification (2026-10-27, staged-only):** seed effect (~:1908-1922 in current
> tree, layered on P2-T01 edits) now returns `() => collab.provider.off("sync",
> seed)`, matching `ticket-description.tsx:397`. No dedicated test added (per
> item); editor scope 35 files/400 tests green; eslint on touched files clean
> (warnings pre-existing).

### P2-T06 — Chat: serialize sends and fix Cancel (F7 + F13 chat half) ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/components/chat-panel.tsx:1064-1195` (send), `:1379` (follow-up entry),
  `:1091-1093,1191-1193` (abortRef overwrite/null), `:1096-1110` (thread creation)
- **Defect.** `send()` lacks a pending guard. A follow-up replaces `abortRef`; the first
  stream's `finally` nulls it, destroying the second send's controller — Cancel is a no-op
  with two interleaved streams. Also, `createChatThreadAction` is awaited (`:1096`) before
  the abort check (`:1108`), so cancel-during-create leaves an orphan thread row.
- **Change:** early-return in `send()` while streaming (or per-stream controller registry so
  `cancelStream` aborts the right one, nulling only if the ref still matches); move the abort
  check before thread creation (or mark the orphan inactive).
- **Test:** component test — start stream, send follow-up, click Cancel → both streams abort;
  cancel during thread creation leaves no active orphan thread.
- **Done when:** Cancel is reliable with overlapping sends.

> **Verification (2026-10-27, staged-only):** agent session died mid-report;
> work verified posthumously on disk. chat-panel.tsx (+122/−21): send
> serialization/abort-selection fixed (ref-match nulling + overlapping-send
> guard; abort check before/independent of thread create so no active orphan
> thread). New `chat-panel.cancel-race.test.ts` — 42 tests green across
> chat-panel scope; full sweep pinned by the agent's pre-crash run:
> **15,016/15,016 repo-wide**; tsc clean re-verified locally.

### P2-T07 — Quick-find stale-response guard (F8 + F13 embed half) ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/components/quick-find.tsx:371-391`; same family
  `src/components/page-embed.tsx:81-88` (contrast its own guarded sibling effect at `:90-108`)
- **Defect.** Debounced search has no request token; a slower older `startTransition` can
  resolve after a newer one and overwrite results. Same pattern in `page-embed.tsx`
  mention-search.
- **Change:** monotonic sequence guard (capture seq at request start; discard `setItems`
  when seq no longer matches) in both places.
- **Test:** component test — slow older response does not overwrite newer results.
- **Done when:** both effects guard with a token/seq.

> **Verification (2026-10-27, staged-only):** monotonic seq guard via new pures
> `createRequestSequence()`/`settleSearchResults()` (page-embed actually lives
> at `src/components/editor/extensions/page-embed.tsx` — path above was stale);
> mention-search effect uses the sibling `cancelled`-flag pattern. Suites:
> quick-find +4, page-embed.mention-guard +4 — 8/8 failed pre-change, 23 green
> post. 400 tests green in touched scope (sandboxed react env renders no DOM;
> effects tested at extracted pure seams per repo convention); tsc clean.

### P2-T08 — Block publishing from trash; revoke links on archive ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/server/actions/share.ts:87-98` (contrast the guarded `loadShareableForm`
  at `:165-179`); `archivePageAction`/`restorePageAction` at `src/server/actions/pages.ts:794-863`
- **Defect.** `createShareLinkAction`'s page select omits `deletedAt` → a **trashed page can
  be published** and the link silently revives on restore with no re-share.
- **Change:** add `deletedAt` to the select and refuse `deletedAt != null` like the form
  path; revoke/flag live page-level links in `archivePageAction`.
- **Test:** unit — publish on trashed page fails; archive revokes the live link.
- **Done when:** both tests pass from fail-before state.

> **Verification (2026-10-27, staged-only):** publish gate now
> `if (!page || page.deletedAt) return { error: "Page not found." }` (fail-closed
> house style, both create + update paths). Archive revokes page-level links
> (`pageId in subtreeIds, viewId: null`) inside one `$transaction` with the
> trashed write — subtree links die with it, form links untouched. Secrets
> path verified fail-closed (revoked token → wrong-password, rate map benign).
> New `share-trash-gate.test.ts` (8 tests, 6/6 failed pre-change). Actions
> suite 860/862 green — 2 pre-existing timeout flakes in `import-integrity.test.ts`
> (pass 20/20 in isolation; note as P3 follow-up); tsc clean.

### P2-T09 — 2FA enrollment must not consume the current TOTP step ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/server/actions/two-factor.ts:71-75`; `src/lib/totp-replay.ts:34-43`;
  failing path `src/server/actions/auth.ts:336-338`
- **Defect.** Enable calls `consumeTotpStep` writing `twoFactorCounter = N`; replay check
  accepts only steps strictly greater → immediate re-login within the same 30 s window with a
  correct code returns `LOGIN_FAILED`/"Incorrect email or password". (Correction from
  adversarial recheck: this spends the separate 2FA guess budget, NOT the account lockout.)
- **Change:** on enable write `twoFactorCounter: step - 1` (so step N is still spendable once
  at login), or store the enrollment step separately.
- **Test:** unit — enable with step N, then immediately verify with step N → success;
  verify again with step N → replay failure.
- **Done when:** the re-login repro passes.

### P2-T10 — "New row" in-flight guard (M7) ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/components/database/database-view.tsx:1879-1889`; button sites:
  `database-actions.tsx:194`, `table-view.tsx:794-798`, `list-view.tsx:468-472`,
  `board-view.tsx:412-416`, `gallery-view.tsx:437-441`
- **Defect.** `startTransition(async () => { … await createRowAction; router.refresh(); })`
  with no in-flight guard — transitions do not dedupe server actions. Double-click
  duplicates whole rows (2+N writes with template prefill). Existing correct patterns:
  `form-view.tsx:439` (`disabled={pending} aria-busy={pending}`),
  `database-view.tsx:2574` (`disabled={loadingMoreRows}`).
- **Change:** a `creatingRow` state (or transition `isPending`) guarding all five `onAddRow`
  call sites with `disabled` + `aria-busy`.
- **Test:** component test — rapid double-click creates exactly one row per view.
- **Done when:** the test fails before and passes after.

> **Verification (2026-10-27, staged-only):** extracted guard module
> `add-row-guard.ts` (claim/settle with `finally` reset incl. error path) wired
> through `database-view.tsx` + `database-actions.tsx` + all four view
> empty-states; buttons `disabled` + `aria-busy` mirroring form-view. Fail-first:
> `add-row.m7-defect.test.ts` reproduces the double-create pre-change; guard +
> wiring suites post-change: 8 tests green. Full database scope 34 files/306
> tests green; tsc clean (test polished post-crash: attribute-order-agnostic
> regexes, board fixture needed a STATUS property, gallery has no `editable`
> prop, settled state is `aria-busy="false"` not absent).
> Note: repo renders real HTML via `renderToStaticMarkup` in some suites.

### P2-T11 — Invite redemption TOCTOU (M8, softened) ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/server/actions/email.ts:490-504,580-598`; `src/server/actions/teamspace-invites.ts:193,256-259`;
  correct pattern `src/app/oauth/token/route.ts:108-114`
- **Defect.** Single-use consumption is read-then-write: check `acceptedAt === null` then an
  **unconditional** `update`. Concurrent double-accept can both pass and both write.
  (Severity note from recheck: member joins are idempotent `upsert`s with `update: {}`
  (`email.ts:580-594`), so nothing is granted twice — the write path is still wrong.)
- **Change:** `prisma.invite.updateMany({ where: { id, acceptedAt: null }, data: … })`;
  proceed only when `count === 1`. Same fix in teamspace invites.
- **Test:** unit — two concurrent accepts → one winner, one loser.
- **Done when:** conditional-update pattern replaces all three unconditional update sites.

### P2-T12 — Tauri secrets.bin atomic writes ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src-tauri/src/secrets.rs:56-58,73-96`
- **Defect.** The file is opened with `truncate(true)` **before** `write_all(MAGIC)`;
  `load()` treats a zero-byte file as a fresh empty store. A crash in the truncate→write
  window silently wipes the DB URL + `auth_secret` (all sessions invalidated) with no error —
  contradicting the module comment's fail-closed claim (detection covers truncation short of
  MAGIC, not the empty-file window).
- **Change:** write to a temp file + `fs::rename` (POSIX); staged-rename on Windows; treat a
  non-first-run zero-byte file as an error in `load()`.
- **Test:** Rust unit — simulate crash between truncate and write (zero-length file, non-zero
  generations) → `load()` errors instead of returning an empty store.

> **Verification (2026-10-27, staged-only):** executor subagent rewrote `secrets.rs` save()
> to manual temp file (`tmp-{pid}-{rand32}`, same dir, `rand` already a dep — no Cargo.toml
> change) with `mode(0o600)` + `create_new` before any write, `sync_all` before rename;
> `std::fs::rename` replaces destination on Windows (MoveFileEx semantics, documented);
> best-effort POSIX dir fsync. `load()` now fails closed on an existing zero-byte file (new
> `an_empty_existing_store_fails_closed` test names the old truncate→write crash window);
> tests added for no-stray-temps, replace-keeps-contents, unix 0600; existing corrupt-store
> + roundtrip tests intact. cargo test: 56 passed / 0 failed. tsc clean. Note: sidecar
> binaries/icons were pre-existing env gaps for a first cargo build; executor used then
> removed temp placeholders, `git status` on src-tauri shows only secrets.rs.

> **Verification (2026-10-27, staged-only):** executor subagent replaced
> read-then-write with claim-first `updateMany({ where: { id, acceptedAt: null } })`
> + `count === 1` gating in both `acceptWorkspaceInviteAction` and the teamspace
> invite accept; joins/side-effects moved to winner path only; loser returns the
> same idempotent success shape with zero writes (email-gated same-user racers).
> New `invite-consumption.test.ts` (6 tests, stateful mock exposes the race;
> fails pre-fix); 4 existing invite test files' mocks updated update→updateMany
> (deviation, required). tsc clean; src/server/actions 871/872 (only the known
> import-integrity full-run timeout flake, green in isolation). No git mutations;
> T01–T10 files untouched.
- **Done when:** the test fails before and passes after.

### P2-T13 — Tauri sidecar restart counter resets on readiness ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src-tauri/src/sidecar.rs:546-553,649-668` (only production write is `:549`)
- **Defect.** `attempt += 1` increments on **every** `start()` (manual restarts, DB-URL
  changes, crashes alike) and `will_restart = attempt < 8` reads the never-reset total —
  auto-restart disables after 8 lifetime starts. Verified: no other write site (remaining hit
  is a test lock probe at `:943`).
- **Change:** reset `attempt` to 0 on `Readiness::Ready` in `start()`.
- **Test:** Rust unit — 8 successful starts + one crash still auto-restarts.
- **Done when:** the test fails before and passes after.

> **Verification (2026-10-27, staged-only):** executor subagent added
> `will_attempt_restart`/`attempt_after_start` pure seams (wired literally at both call
> sites) and reset `state.attempt` to 0 in `start()`'s `Readiness::Ready` arm
> (sidecar.rs:650-655 — same future that observed Ready; termination events can only be
> observed later, so the reset is race-free; a dying-child-in-the-microsecond edge
> conservatively counts as a failed start). 3 new tests incl. the required
> 8-good-starts-then-crash-still-restarts lifecycle replay + a contrast test proving the
> crash-loop protection survives when never-ready. Red evidence via mutation probe (reset
> disabled → 2 tests fail). cargo test: 59 passed / 0 failed; fmt clean.

> **Verification (2026-10-29, staged):** executor died mid-report but work landed on disk —
> verified posthumously. (1) Update checker: new `updateCheckOutcome` in
> `src/lib/runtime-mode.ts` (27 lines: available/unavailable/check-failed discriminate),
> workspace-shell three-way toasts — a `Some` version announces, `Ok(None)` reads
> "update unavailable", a failed catch reads "update check unavailable" (never "up to
> date"); new i18n keys added to i18n.ts + parity test. (2) SECURITY.md dup heading gone
> (single occurrence). (3) feed-guard: prod builds throw on a replaced global fetch,
> dev/test warn + honor the double. Verified: workspace-shell/i18n/feed-guard 67/67;
> cargo --lib 63/63; tsc clean.

### P2-T14 — `set_database_url` must not destroy the last-known-good URL ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src-tauri/src/commands.rs:222-229`; syntax-only validation `state.rs:69-91`
- **Defect.** `state::set_database_url` (persists into secrets.bin) runs **before**
  `sidecar::stop`/`start`; the failure path restores nothing. A valid-syntax/wrong-password
  URL replaces the last-known-good value permanently.
- **Change:** snapshot the previous value; on start failure, restore it and restart; or
  trial-start before persisting. Record the chosen approach.
- **Test:** Rust unit — set a bad URL; assert previous value restored and server back up.
- **Done when:** the test fails before and passes after.

> **Verification (2026-10-27, staged-only):** executor subagent implemented snapshot +
> restore via extracted orchestration `swap_database_url` (private
> `DatabaseUrlSwapOps` trait + real `ShellSwapOps` impl) driving
> stop→persist→start → on failure: stop again (kill unhealthy child), log, persist
> previous, start again. Module-level `SWAP_LOCK` (tokio::sync::Mutex) serializes the whole
> swap — Tauri commands run concurrently and nothing pre-existing serialized this pipeline.
> Command returns `Err(String)` with distinct case messages (running-on-previous /
> server-down-with-previous-saved / restart-required); offline banner driven by existing
> sidecar events. 3 new tests via `FakeSwap` (restore exactly once + retry; double failure
> keeps snapshot + reports down; success persists new URL and never restores) — red
> evidence via mutation probe (restore block no-op'd → 2 tests fail). cargo test:
> 62 passed / 0 failed; fmt clean.

---

## Phase 3 — Low severity / consistency

### P3-T01 — Share settings: allow clearing password/expiry; log updates ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/server/actions/share.ts:118-130` (`??`-merge cannot express "remove";
  no `logActivity` on the update branch, create logs `page.shared` at `:143`);
  UI form hidden once `active` (`share-dialog.tsx:447,466-545`)
- **Change:** accept explicit `clearPassword`/`clearExpiry` sentinels; add audit log on the
  update branch; expose the settings form for a live link in the dialog.
- **Done when:** a set password/expiry can be cleared from the UI, and the action is audited.

### P3-T02 — Rollup avg/median exclusion consistency (L1) ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/lib/rollup.ts:47-53`; `src/lib/aggregations.ts:105-114` (its doc comment
  explicitly documents the divergence); `rollup.test.ts:136` only asserts `/NaN/i`
- **Defect.** `"abc".replace(...) → Number("") = 0` is finite → **included**, so
  `avg(["12","abc"]) = 6` in a rollup while the same footer shows `12`.
- **Change:** share `aggregations.ts`'s `toNumber` coercion in `rollup.ts`; fix the test
  expectation.
- **Done when:** rollup and footer agree for non-numeric text.

> **Verification (2026-10-27, staged-only):** executor died mid-edit leaving the near-finished
> change (aggregations.ts `toNumber` exported, rollup.ts using it) with a missing import;
> completed directly: added `import { toNumber } from "@/lib/aggregations"` and rewrote
> `rollup.test.ts` expectations to the agreed behavior (`["abc","xyz"] avg → "—"`;
> `["12","abc"] avg/sum/median → "12"` = footer agreement). rollup+aggregations tests
> 54/54; full-file rollup 15/15; tsc clean.

### P3-T03 — Lockout backoff single-write (L2) ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/server/actions/auth.ts:139-152`
- **Defect.** Increment+read then a separate `lockedUntil` write — concurrent failures can
  overwrite a larger backoff with a smaller one (last writer wins).
- **Change:** compute the lockout in the DB layer (or conditional update on the counter value)
  so the pair is atomic.
- **Done when:** a concurrent-failure unit test keeps the max backoff.

> **Verification (2026-10-27, staged-only):** executor subagent built atomic guards via
> `updateMany` OR-conditions in both write directions: lock-arm writes only when
> `OR: [{ lockedUntil: null }, { lockedUntil: { lt: new } }]` (lock only ever moves
> forward), the below-threshold write sets `lockedUntil: null` only when
> `null | lte: now` (a delayed sub-threshold failure can't drop a live lock). Counter
> `increment: 1` kept (arithmetic under row lock, benign). Mock gained true statement
> semantics (count frozen at statement time). Red evidence from unfixed code: 15.1s shrink
> + live-lock drop. 12/12 file; 108/108 files, 899/899 src/server/actions; tsc clean.
> Residual left for triage: successful sign-in's clearFailedLogins can race a failure's
> lock-arm (pre-existing, unrelated).

### P3-T04 — Signup partial failure recovery (L3 + F9) ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/server/actions/auth.ts:200-226,95-116,206-213,383`; `src/server/unique.ts:10-19`
- **Defect.** Two coupled issues:
  1. Slug uniqueness is check-then-insert with no P2002 retry → raw 500 on concurrent
     same-name signups (`Workspace.slug` is `@unique`). Note: the **email** insert IS
     P2002-guarded (`createUser` at `:95-116`) — that reconciliation is why both reports
     were true.
  2. User commits before workspace/page/session; partial failure strands an
     `emailVerified: false` user whose retries hit `SIGNUP_FAILED` and whose login lands
     workspace-less on `/app` (`auth.ts:383`).
- **Change:** wrap slug generation in P2002 retry (regenerate and retry, not fail); wrap
  user+workspace+page in `$transaction`, or add complete-onboarding on login when an orphaned
  user is detected. Record the chosen approach.
- **Test:** unit — concurrent same-name signups both succeed with distinct slugs; partial
  failure leaves no user row (transaction variant) or recovers on login (onboarding variant).
- **Done when:** neither failure mode strands or 500s.

> **Verification (2026-10-28, staged-only):** chosen: **transaction variant**. (B) audited
> signup flow — exactly 3 DB writes, nothing interleaved (no signup confirmation mail),
> session is JWT + non-DB registry — so `prisma.$transaction(async (tx) => …)` covers
> user+workspace+member+getting-started page; mid-failure leaves no user row, eliminating
> the workspace-less `/app` login structurally. (A) slug retry at the attempt level (DB is
> postgres — in-tx P2002 retry impossible): bounded loop `SIGNUP_ATTEMPTS = 3` wrapping the
> whole tx; new `isWorkspaceSlugConflict` discriminator in unique.ts; next attempt sees the
> committed winner and proposes `base-1*`; exhaustion → neutral text, never raw 500.
> `auth-signup-atomic.test.ts`: 6/7 red pre-fix → 7/7 green post. tsc clean; auth suites
> 58/58; src/server/actions 905/906 (only known import-integrity flake, green isolated).
> P3-T03 hunks verified byte-untouched.

### P3-T05 — Teamspace invite redemption parity (L4) ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/server/actions/teamspace-invites.ts:176-213,194,235-263`; reference path
  `src/server/actions/email.ts:463-529`, `src/lib/invite-token.ts:117`
- **Defect.** Workspace invites use `canRedeem` + fail-closed expiry (`now >= ms`); teamspace
  invites hand-roll checks with fail-**open** boundary (`<` vs `>=`) and no grant re-check at
  redemption (an invite minted by a later-demoted user still grants ADMIN). Standalone
  exploitability is low (single-email-scoped token) — consistency fix.
- **Change:** reuse `canRedeem`/`isExpired` (boundary fails closed) and re-check the sender's
  current role at redemption.
- **Done when:** teamspace path matches the workspace path's checks exactly.

### P3-T06 — Ticket move column validation (F10) ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/server/actions/tickets.ts:974-985`
- **Defect.** `moveTicketAction` checks only `workspaceId` (`:982`); `position` is taken from
  whatever row the board placed the drag over (`before.position - 1` at `:985`) without
  validating `before.status === input.status` — dropping above a wrong-column row mis-sorts
  against the `id` tie-break.
- **Change:** reject or recompute when `before.status !== input.status`.
- **Done when:** bad cross-column drops don't corrupt ordering.

### P3-T07 — Search "Load more" id-dedup (F11, reframed) ✅ DONE (uncommitted — Wednesday batch)

- **Files:** `src/components/search-results.tsx:238-248,428-431`; dedup reference
  `src/components/database/database-view.tsx:1816-1819`
- **Defect.** No id-dedup on append. (Reframe: the `loading={pending}` disable DOES exist —
  `Button` disables on loading via `ui/button.tsx:137,176` — so the residual window is only
  the overlapping-frame double-click before the pending re-render commits.)
- **Change:** filter appended results against a `Set` of existing ids, as `database-view` does.
- **Done when:** duplicate ids cannot enter the list.

> **Verification (2026-10-27, staged-only):** executor subagent added exported pure
> `appendResultRows(current, incoming)` (verbatim mirror of database-view.tsx:1829-1832
> idiom) + functional-setRows wiring in loadMore onSuccess; modeled overlapping-frame
> double-append test threads queued functional updates forward → single copy. 20/20 file,
> 2077/2077 src/components; tsc clean. Noted boundary (mirror-faithful): same id twice
> within one server page would still pass through — matches the reference, not an
> observed defect.

### P3-T08 — Misc latent defects (L5 leftovers + L6) ✅ DONE (staged)

- `src-tauri/src/secrets.rs` — see P2-T12 (atomicity).
- `src-tauri/src/commands.rs:213-216` + `src/components/workspace-shell.tsx:330-338` —
  "Check for updates…" always answers "up to date" via an `Ok(None)` stub. Fix BOTH sides:
  server returns a distinguishable "not available" state, and the client catch/None branch
  must render "checking unavailable" — a server `Err` alone would surface an error toast
  that also reads "up to date" (recheck finding, `:338`).
- `SECURITY.md:104-106` — duplicate heading `### NOEMA_ALLOW_LOOPBACK_TARGETS` twice in a
  row; delete one.
- `src/lib/feed-guard.ts:486-488` — pinned transport falls back to `globalThis.fetch` if it
  was replaced (operator/test instrumentation only). Assert native fetch in production builds.

### P3-T09 — Flaky script tests under parallel contention (F12) ✅ DONE (staged)

- **Files:** `scripts/backup.test.mjs:224`, `scripts/check-npm-audit.test.mjs:453`
  (+ discovered 2026-10-27 during P2-T08: `src/server/actions/import-integrity.test.ts`
  zip-budget tests timeout under full-suite worker contention — pass 20/20 in isolation)
- **Defect.** Pass in isolation, fail in the full parallel run (subprocess/env contention).
- **Change:** isolate shared subprocess/env state (temp-dir per test, no global env writes)
  or move them to their own vitest project.
- **Done when:** the full `npx vitest run` passes twice consecutively.

> **Verification (2026-10-29, staged):** executor work landed on disk mid-report-death,
> verified + completed directly. backup.test.mjs suite-bounded `SUBPROCESS_TIMEOUT =
> 60_000` (cold node ~1.5s quiet, 6-11s vs 5s default under load), same for
> check-npm-audit.test.mjs; import-integrity contention window scoped. Assertions intact.
> Full `npx vitest run` ×2 consecutively green (P1: 1 fail in webhooks B11 loopback,
> investigated → REAL REGRESSION from P3-T08's prod-throw: it broke the operator-hermetic
> opt-in convoy; fixed in feed-guard.ts — production refuse applies ONLY without
> `NOEMA_ALLOW_LOOPBACK_TARGETS` (the repo's own "NODE_ENV cannot serve both" doctrine);
> new pin-test covers production+opt-in honoured, fail-first documented in the test
> comment; fix verified isolation 79/79). After fix: **838 files / 15,096 tests green
> twice consecutively.** tsc clean.

---

## Execution notes

- Order: Phase 1 → 2 → 3. Within Phase 2, do T01 (editor) on its own commit; T04 needs the
  counter migration — ship the migration and the allocator swap in the same deploy.
- P2-T12/P2-T13/P2-T14 touch Rust; run `cargo test` in `src-tauri/` alongside the TS gates.
- The security items from the sweep that are doc-level only (multi-instance caveat, Session
  store option A) live in P1-T04 — do not silently descope documentation.
