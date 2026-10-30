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

### P1-T03 — Form-share token must not leak into page share state

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

### P2-T01 — Autosave single-flight + payload-equal clearing (F2 + S1)

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

### P2-T02 — Workspace transfer must be transactional

- **Files:** `src/server/actions/pages.ts:782,787`
- **Defect.** Subtree `workspaceId` `updateMany` and the root re-parent `update` are two
  independent writes; a failure between them strands cross-workspace orphaned children.
- **Change:** `$transaction([...])` around both writes (array form is sufficient).
- **Test:** unit — fail re-parenting after subtree update; assert neither write persisted.
- **Done when:** the test fails before, passes after.

### P2-T03 — Meeting notes creation race (CAS)

- **Files:** `src/server/actions/calendar.ts:198-229`; schema `prisma/schema.prisma:1115`
  (`notesPageId` is a plain `String?`, no `@unique`)
- **Defect.** Read `event.notesPageId`, create page, then **unconditional** `update`
  (`:226-229`). Concurrent calls both see null and create orphan duplicate note pages.
- **Change:** conditional `updateMany({ where: { id, notesPageId: null }, data: … })`
  inside a transaction; if `count === 0`, reuse the winner's page.
- **Test:** unit — two concurrent accepts of a null `notesPageId`; exactly one page row.
- **Done when:** the CAS pattern replaces the unconditional update and the test passes.

### P2-T04 — UNIQUE_ID allocator: monotonic per-property counter (F5 + M4 + M5)

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

### P2-T05 — Collab seed listener cleanup (leak only; crash claim refuted)

- **Files:** `src/components/editor/page-editor.tsx:1876-1889`; correct pattern
  `ticket-description.tsx:396-397`; transport cleanup at `page-editor.tsx:1175-1182`
- **Defect.** `provider.once("sync", seed)` is registered with **no cleanup function** while
  the sibling component correctly returns `() => provider.off("sync", seed)`. Verified NOT a
  crash path: the transport cleanup disconnects/destroys the provider, so a post-unmount
  `sync` cannot fire as coded. The defect is the listener/closure leak + inconsistency.
- **Change:** return `() => collab.provider.off("sync", seed)` from the effect.
- **Test:** existing editor suites pass; lint clean.
- **Done when:** cleanup symmetry matches `ticket-description.tsx`.

### P2-T06 — Chat: serialize sends and fix Cancel (F7 + F13 chat half)

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

### P2-T07 — Quick-find stale-response guard (F8 + F13 embed half)

- **Files:** `src/components/quick-find.tsx:371-391`; same family
  `src/components/page-embed.tsx:81-88` (contrast its own guarded sibling effect at `:90-108`)
- **Defect.** Debounced search has no request token; a slower older `startTransition` can
  resolve after a newer one and overwrite results. Same pattern in `page-embed.tsx`
  mention-search.
- **Change:** monotonic sequence guard (capture seq at request start; discard `setItems`
  when seq no longer matches) in both places.
- **Test:** component test — slow older response does not overwrite newer results.
- **Done when:** both effects guard with a token/seq.

### P2-T08 — Block publishing from trash; revoke links on archive

- **Files:** `src/server/actions/share.ts:87-98` (contrast the guarded `loadShareableForm`
  at `:165-179`); `archivePageAction`/`restorePageAction` at `src/server/actions/pages.ts:794-863`
- **Defect.** `createShareLinkAction`'s page select omits `deletedAt` → a **trashed page can
  be published** and the link silently revives on restore with no re-share.
- **Change:** add `deletedAt` to the select and refuse `deletedAt != null` like the form
  path; revoke/flag live page-level links in `archivePageAction`.
- **Test:** unit — publish on trashed page fails; archive revokes the live link.
- **Done when:** both tests pass from fail-before state.

### P2-T09 — 2FA enrollment must not consume the current TOTP step

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

### P2-T10 — "New row" in-flight guard (M7)

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

### P2-T11 — Invite redemption TOCTOU (M8, softened)

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

### P2-T12 — Tauri secrets.bin atomic writes

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
- **Done when:** the test fails before and passes after.

### P2-T13 — Tauri sidecar restart counter resets on readiness

- **Files:** `src-tauri/src/sidecar.rs:546-553,649-668` (only production write is `:549`)
- **Defect.** `attempt += 1` increments on **every** `start()` (manual restarts, DB-URL
  changes, crashes alike) and `will_restart = attempt < 8` reads the never-reset total —
  auto-restart disables after 8 lifetime starts. Verified: no other write site (remaining hit
  is a test lock probe at `:943`).
- **Change:** reset `attempt` to 0 on `Readiness::Ready` in `start()`.
- **Test:** Rust unit — 8 successful starts + one crash still auto-restarts.
- **Done when:** the test fails before and passes after.

### P2-T14 — `set_database_url` must not destroy the last-known-good URL

- **Files:** `src-tauri/src/commands.rs:222-229`; syntax-only validation `state.rs:69-91`
- **Defect.** `state::set_database_url` (persists into secrets.bin) runs **before**
  `sidecar::stop`/`start`; the failure path restores nothing. A valid-syntax/wrong-password
  URL replaces the last-known-good value permanently.
- **Change:** snapshot the previous value; on start failure, restore it and restart; or
  trial-start before persisting. Record the chosen approach.
- **Test:** Rust unit — set a bad URL; assert previous value restored and server back up.
- **Done when:** the test fails before and passes after.

---

## Phase 3 — Low severity / consistency

### P3-T01 — Share settings: allow clearing password/expiry; log updates

- **Files:** `src/server/actions/share.ts:118-130` (`??`-merge cannot express "remove";
  no `logActivity` on the update branch, create logs `page.shared` at `:143`);
  UI form hidden once `active` (`share-dialog.tsx:447,466-545`)
- **Change:** accept explicit `clearPassword`/`clearExpiry` sentinels; add audit log on the
  update branch; expose the settings form for a live link in the dialog.
- **Done when:** a set password/expiry can be cleared from the UI, and the action is audited.

### P3-T02 — Rollup avg/median exclusion consistency (L1)

- **Files:** `src/lib/rollup.ts:47-53`; `src/lib/aggregations.ts:105-114` (its doc comment
  explicitly documents the divergence); `rollup.test.ts:136` only asserts `/NaN/i`
- **Defect.** `"abc".replace(...) → Number("") = 0` is finite → **included**, so
  `avg(["12","abc"]) = 6` in a rollup while the same footer shows `12`.
- **Change:** share `aggregations.ts`'s `toNumber` coercion in `rollup.ts`; fix the test
  expectation.
- **Done when:** rollup and footer agree for non-numeric text.

### P3-T03 — Lockout backoff single-write (L2)

- **Files:** `src/server/actions/auth.ts:139-152`
- **Defect.** Increment+read then a separate `lockedUntil` write — concurrent failures can
  overwrite a larger backoff with a smaller one (last writer wins).
- **Change:** compute the lockout in the DB layer (or conditional update on the counter value)
  so the pair is atomic.
- **Done when:** a concurrent-failure unit test keeps the max backoff.

### P3-T04 — Signup partial failure recovery (L3 + F9)

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

### P3-T05 — Teamspace invite redemption parity (L4)

- **Files:** `src/server/actions/teamspace-invites.ts:176-213,194,235-263`; reference path
  `src/server/actions/email.ts:463-529`, `src/lib/invite-token.ts:117`
- **Defect.** Workspace invites use `canRedeem` + fail-closed expiry (`now >= ms`); teamspace
  invites hand-roll checks with fail-**open** boundary (`<` vs `>=`) and no grant re-check at
  redemption (an invite minted by a later-demoted user still grants ADMIN). Standalone
  exploitability is low (single-email-scoped token) — consistency fix.
- **Change:** reuse `canRedeem`/`isExpired` (boundary fails closed) and re-check the sender's
  current role at redemption.
- **Done when:** teamspace path matches the workspace path's checks exactly.

### P3-T06 — Ticket move column validation (F10)

- **Files:** `src/server/actions/tickets.ts:974-985`
- **Defect.** `moveTicketAction` checks only `workspaceId` (`:982`); `position` is taken from
  whatever row the board placed the drag over (`before.position - 1` at `:985`) without
  validating `before.status === input.status` — dropping above a wrong-column row mis-sorts
  against the `id` tie-break.
- **Change:** reject or recompute when `before.status !== input.status`.
- **Done when:** bad cross-column drops don't corrupt ordering.

### P3-T07 — Search "Load more" id-dedup (F11, reframed)

- **Files:** `src/components/search-results.tsx:238-248,428-431`; dedup reference
  `src/components/database/database-view.tsx:1816-1819`
- **Defect.** No id-dedup on append. (Reframe: the `loading={pending}` disable DOES exist —
  `Button` disables on loading via `ui/button.tsx:137,176` — so the residual window is only
  the overlapping-frame double-click before the pending re-render commits.)
- **Change:** filter appended results against a `Set` of existing ids, as `database-view` does.
- **Done when:** duplicate ids cannot enter the list.

### P3-T08 — Misc latent defects (L5 leftovers + L6)

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

### P3-T09 — Flaky script tests under parallel contention (F12)

- **Files:** `scripts/backup.test.mjs:224`, `scripts/check-npm-audit.test.mjs:453`
- **Defect.** Pass in isolation (`npx vitest run scripts/backup.test.mjs
  scripts/check-npm-audit.test.mjs` → 18/18 in ~3.4 s), fail in the full 15k-test parallel
  run (subprocess/env contention). Matches the report's own precondition; failure mode not
  independently re-reproduced — confirm first.
- **Change:** isolate shared subprocess/env state (temp-dir per test, no global env writes)
  or move them to their own vitest project.
- **Done when:** the full `npx vitest run` passes twice consecutively.

---

## Execution notes

- Order: Phase 1 → 2 → 3. Within Phase 2, do T01 (editor) on its own commit; T04 needs the
  counter migration — ship the migration and the allocator swap in the same deploy.
- P2-T12/P2-T13/P2-T14 touch Rust; run `cargo test` in `src-tauri/` alongside the TS gates.
- The security items from the sweep that are doc-level only (multi-instance caveat, Session
  store option A) live in P1-T04 — do not silently descope documentation.
