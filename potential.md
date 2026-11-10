# Noema — Potential Fixes & Security Updates

> Scout results from three read-only subagent investigations (reviewer / historian / debugger), run Oct 27 2026.
> No code was modified. No fixes implemented.
>
> **Adversarial re-verification applied:** every claim was independently re-checked against source (34 claims: 28 confirmed, 1 refuted, 5 confirmed-in-core but overstated in severity/mechanism). The corrections are inlined below — items marked *Adversarial recheck*; the refuted finding was removed and noted in place.

## Baseline Health (all clean ✅)

- `npx tsc --noEmit`: **0 errors**
- `npx vitest run`: **14,943 / 14,945 tests pass** (2 flaky, see F12 below)
- `npm audit`: **0 vulnerabilities** (Next.js 15.5.28, no deps in v1.4.3 with issues)
- Latest Playwright run in `test-results/.last-run.json` failed `noema.spec.ts >> backlink guest scoping` with `net::ERR_CONNECTION_REFUSED at http://localhost:3200/login` — **environmental** (dev server not up), not a code bug.
- One explicitly documented skip: `e2e/export-import.spec.ts:255` (`test.skip(true, "B91 ?format=json not implemented yet")`). No `.only()` anywhere in e2e/.

---

# Report 1 — Security Scout (@reviewer)

**Overall verdict:** This is one of the most security-disciplined codebases I've reviewed — layered rate limiting, DNS-rebinding-safe SSRF guards, SVG sanitization, timing-safe token comparisons, KaTeX with `trust: false`, non-root digest-pinned Docker, nonce-based CSP with no `unsafe-inline` in scripts, and full CSRF via Next's Origin check plus explicit `allowedOrigins`. `npm audit` is clean. Nearly everything below is confirmed-protective or low-severity hardening; **no critical or high findings**.

## Confirmed Protections (spot-verified, not exhaustive)

| Area | Evidence |
|---|---|
| Sessions | HS256 JWT (`jose`) + fail-closed file registry — sid revoked/expired/unknown ⇒ rejected even with valid JWT, `src/lib/auth.ts:104-110`, `src/lib/session-store.ts:124-152,360-369`; AUTH_SECRET refuses short/placeholder values, `src/lib/auth-secret.ts:106-127` |
| Passwords | bcrypt cost 12 + dummy-hash timing defense + per-account lockout, `src/lib/auth.ts:48-65,139-160,281-300` |
| 2FA | AES-256-GCM sealed seeds, replay protection consuming matched time-step, separate guess budget — `src/lib/auth.ts:312-359` |
| IDOR / tenancy | Centralized `getWorkspaceAccess` (`src/lib/permissions.ts:11-27`), fail-closed scope engine (`src/lib/tenancy.ts:100-128`); swept all server actions — every tenant-data action resolves membership + capability first. **No IDOR found** |
| API tokens | SHA-256 digest storage + `timingSafeEqual` + expiry + scopes capped by owner role, `src/lib/api-auth.ts:9-15,41-87` |
| Share pages | 192-bit random tokens, bcrypt share password, HMAC unlock cookie bound to token+expiry, per-token in-process brute-force brake — `src/server/actions/share.ts:135,365-403`, `src/lib/secrets.ts:817-927` |
| SSRF | Resolve-then-pinned-connect (rebinding safe), per-hop redirect revalidation, http(s)-only, full private/metadata IP blocklist — `src/lib/feed-guard.ts:74-105,232-286,362-450,529-581`; webhooks re-guard **every delivery** (`src/lib/webhooks.ts:388-424`) |
| Uploads | Auth+guest-deny, MIME allowlist (never trusting `File.type` alone), pre-storage SVG scanner (script/handler/`javascript:`/SMIL blocks, UTF-16 smuggling refused), random stored names, traversal-safe storage with 0700/0600 — `src/app/api/upload/route.ts:93-228`, `src/lib/svg-safety.ts`, `src/lib/storage.ts:183-213` |
| Imports | Extension allowlist, zip bomb double-budget (declared + actual bytes), ZIP64/encrypted refused, deny-by-default href scheme gate on all save/import paths — `src/server/actions/import.ts:371-551`, `src/lib/validation.ts:62-96` |
| XSS in rendered HTML | All three `dangerouslySetInnerHTML` sites are KaTeX render output with `trust: false, throwOnError: true, maxExpand/maxSize` caps — `src/lib/math-tex.ts:188-196`, `equation-editor.tsx:329,393`, `math-node.tsx:102`. Safe |
| OAuth | Exact-match registered `redirect_uri` re-validated on POST, PKCE S256 enforced, codes hashed + 5-min TTL, no open redirect — `src/app/oauth/authorize/complete/route.ts:34-68` |
| SAML | Library-validated signed assertions, audience pinned, PK replay via atomic insert, HMAC RelayState mandatory — `src/lib/sso/saml-client.ts:21-33`, `src/server/sso-replay.ts:44-55` |
| Docker | Non-root UID 10001, `read_only: true`, `cap_drop: ALL`, `no-new-privileges`, npm removed from runtime, loopback-only DB port, password refused if unset — `Dockerfile:111-143`, `docker-compose.yml:15-23,99-106` |
| Secrets/cors | `.env*` gitignored (`.gitignore:44-45`), `check:secrets` script + history check in tree (`scripts/check-secrets.mjs`); no `Access-Control-Allow-Origin` anywhere; no sensitive `NEXT_PUBLIC_*` vars (only app version/URL/collab URL) |
| SECURITY.md vs practice | **Matches actual practice** — the loopback opt-in, SSO email-verification linking, lockout-as-DoS property, unsigned Windows versions, single-host session store are all accurately described, and code honors them |

## Findings

### 🟡 Medium

1. **`src/lib/session-store.ts:102-104`** — Session registry + per-instance rate-limit buckets/lockouts (`auth.ts`, `share.ts:277-281`) are **file/in-process only**. On a horizontally scaled deployment, revocation and lockouts silently don't apply across instances (an attacker rotating instances sidesteps rate limits; a revoked session keeps working elsewhere). *Confirmed (design limit, documented in code comments).* Fix: document loudly for scale-up or back with a shared store (e.g. Postgres table).

### 🟢 Low

2. **`src/server/actions/notifications.ts:198-211`** — Slack page-update posts use raw global `fetch` without the per-delivery `resolveOutboundTarget` re-check or manual redirect handling that the codebase's own invariant requires (`webhooks.ts` does both). Mitigated: URL literal-filtered to `hooks.slack.com` (`:120-126`) and creation-time guard ran; a Slack-issued redirect would auto-follow. *Confirmed deviation, hard to exploit.* Fix: route through `safeFetchGuarded`/pinned transport like every other outbound POST.

3. **`src/app/api/auth/sso/callback/route.ts:92-99,153`** — OIDC discovery endpoints (`token_endpoint`, `jwks_uri`) taken from the IdP's own well-known doc without asserting https/issuer-origin. The trust root is the operator-configured IdP, so this is misconfig-class, but a malformed/misbehaving IdP could redirect token/JWKS traffic elsewhere. *Suspicious (low).* Fix: validate discovered URLs are https under the configured issuer origin.

4. **`src/server/actions/share.ts:337-345`** — In-process token-lockout store is bounded; flooding random tokens can evict a live lockout, mildly resetting the brute-force brake for a targeted token (per-IP limit still applies). *Suspicious (edge case).* Fix: cap by distinct-attempt weighting or persist lockouts alongside sessions.

5. **`src/lib/feed-guard.ts:486-488`** — Pinned transport falls back to `globalThis.fetch` if it was replaced, bypassing pinning. Only reachable via operator/test instrumentation, not user input. *Note only.* Fix: assert native fetch or refuse when replaced in production builds.

### Nitpick

6. **`SECURITY.md:104-106`** — A duplicated section heading (`### NOEMA_ALLOW_LOOPBACK_TARGETS` twice in a row) suggests an editing slip; content otherwise accurate.

> **Adversarial recheck (counter-verification):** the original report also listed a finding claiming the files route (`src/app/api/files/[...path]/route.ts:104-115`) serves assets without `X-Content-Type-Options: nosniff` or a CSP. That finding was **retired as REFUTED** during adversarial re-verification: `next.config.ts:145-153` applies `SECURITY_HEADERS` to `source: "/:path*"` (route handlers included), and `security-headers.ts:298-299` defines both `Content-Security-Policy` and `X-Content-Type-Options: nosniff` — enforcement is pinned by `scripts/check-hsts.mjs:60-61` and `security-headers.test.ts`.

**Bottom line:** No critical/high issues. The maintainer-worthy items are (1) the multi-instance session/rate-limit caveat and (2) pulling the Slack notifier in line with the shared SSRF guard. Everything else is defense-in-depth polish.

---

# Report 2 — Quality Review (@historian)

## Findings

### 🔴 HIGH

**F1 — Database seeding is not atomic** — *confirmed*
- `src/server/actions/pages.ts:176-273` (called from `createPageAction` line 162-164)
- `seedDatabaseStructure` performs ~11 sequential non-transactional writes (4 property.create, view createMany, 2 page.create, 4 propertyValue.create) after the parent page already exists. A mid-seed failure or crash leaves a `DATABASE` page with missing properties/views, permanently broken. Sibling paths (`import.ts:259`, `row-cells.ts:497`) correctly use `$transaction` — this one doesn't.
- **Fix**: wrap page create + seed in one `prisma.$transaction(async (tx) => …)`.

**F2 — Autosave races: out-of-order saves can regress server content** — *confirmed; original "silently loses edits" framing was overstated*
- `src/components/editor/page-editor.tsx:772-837`
- `runSave` has no single-flight/in-flight guard. `:812-813` unconditionally stamps `lastSavedRef` with the just-saved (possibly older) payload and nulls `pendingPayloadRef`, even if `persist()` wrote a newer payload during the await. Two overlapping saves can also complete out of order; an older payload landing server-side after a newer one regresses server content.
- **Adversarial recheck:** the original claim "the newer edit is silently never sent to the server (and the localStorage draft is cleared)" is **refuted in the common case** — `persist()` (`:822-830`) always re-arms a fresh 600 ms debounce timer on every edit, so when the in-flight `runSave` nulls the ref on resolve, the newly armed timer fires a subsequent `runSave` whose fallback (`editor.getJSON()`, `:776-779`) captures the current document including the newer edit, which reaches the server via that fallback run.
- **The two genuine data-loss windows**, narrower than originally framed:
  1. **Response-order inversion** — overlapping saves committing older-after-newer server-side.
  2. **Destroyed-editor window** — editor unmounted before the fallback `runSave` fires: `runSave` returns early at `:784` on a null ref, and the teardown flush (`:1894-1904`) then has nothing to send (this is finding S1's frame).
- **Fix**: keep the fix (single-flight + only clear `pendingPayloadRef` if it still equals the payload just saved). Severity sits between MEDIUM and LOW with the two narrow windows above.

### 🟠 MEDIUM

**F3 — Workspace transfer not transactional** — *confirmed* — `src/server/actions/pages.ts:782,787`. Subtree `workspaceId` updateMany and root re-parent are two separate updates; failure between them leaves cross-workspace orphaned children. Fix: `$transaction([...])`.

**F4 — Meeting notes creation race** — *confirmed* — `src/server/actions/calendar.ts:198-229`. Check-then-create on `CalendarEvent.notesPageId` with no `@unique` (schema:1115); concurrent calls create orphan duplicate note pages. Fix: conditional `updateMany` CAS inside a transaction.

**F5 — UNIQUE_ID numbering race** — *confirmed* — `src/server/row-cells.ts:66-89`. Read-then-max allocation at read-committed isolation lets concurrent rows get duplicate IDs. Fix: `SELECT … FOR UPDATE` or serializable isolation.

**F6 — Collab seed listener leak** — *confirmed (as a leak/inconsistency; the claimed crash was refuted)* — `src/components/editor/page-editor.tsx:1876-1889`. `provider.once("sync", seed)` registered with no cleanup function; the sibling `ticket-description.tsx:396-397` correctly returns `() => collab.provider.off("sync", seed)`. *Adversarial recheck: the original "unmount mid-sync crashes on destroyed TipTap instance" scenario is dubious* — the transport effect cleanup (`page-editor.tsx:1175-1182`) runs `provider.disconnect()` + `provider.destroy()` on unmount/room change, and a destroyed provider does not emit a later `sync`, so the seed closure never fires post-unmount as coded. The verified defect is the listener/closure leak plus lint-order inconsistency. Fix: `provider.off("sync", seed)`; severity downgraded.

**F7 — Follow-up during stream breaks Cancel** — *confirmed* — `src/components/chat-panel.tsx:1379` + `1064-1094`. `send()` lacks a pending guard; a follow-up replaces `abortRef` and the first `finally` nulls it, making Cancel a no-op with two interleaved streams. Fix: early-return while streaming; null only if same controller.

**F8 — Quick-find stale-response race** — *confirmed* — `src/components/quick-find.tsx:371-391`. Debounced search has no request token; a slower older transition can overwrite newer results. Fix: monotonic seq guard.

### 🟡 LOW

**F9** — *confirmed* — `src/server/unique.ts:10-19` + `actions/auth.ts:206-213`: slug uniqueness is check-then-insert with no P2002 retry → raw 500 on concurrent signups.

**F10** — *suspicious* — `src/server/actions/tickets.ts:985`: `moveTicketAction` doesn't validate `before.status === input.status`; dropping above a wrong-column row mis-sorts against `id` tie-break.

**F11** — *suspicious* — `src/components/search-results.tsx:238-248`: "Load more" has no id-dedup (appends `result.results` raw, contrast `database-view.tsx:1816-1819` which filters against a `Set` of existing ids) → re-clicks can duplicate the keyset window. *Adversarial recheck: the original "no in-flight gate" claim was overstated* — the button passes `loading={pending}` (`search-results.tsx:428-431`) and `Button` disables on loading (`ui/button.tsx:137,176`); the residual path is only the synchronous overlapping-frame double-click before the pending re-render commits, a real but far narrower window. Severity lowered accordingly.

**F12** — *confirmed flaky* — `scripts/backup.test.mjs:224`, `scripts/check-npm-audit.test.mjs:453`: pass in isolation (2s), fail in full parallel runs (subprocess/env contention).

**F13** — *low/suspicious* — `page-embed.tsx:81-88`, `comment-panel.tsx:595-631`, `chat-panel.tsx:1094-1110` (orphan thread on cancel-during-create): same stale-closure family as F7/F8.

## Verdict
The codebase is unusually hardened (B-numbered audit trail, near-flawless test coverage), but **F1 is a genuine ship-quality bug**: it breaks data integrity on a common action (creating a database). F2's fix is still warranted (single-flight refactor) but its data-loss framing was corrected by adversarial re-verification to two narrow windows (see F2 above and S1 in Report 3). The server fixes are one-line transaction wraps; the editor fix is a small single-flight refactor. Findings written to `.spec/agents/historian.json`.

---

# Report 3 — Bug Hunt (@debugger)

## CONFIRMED — HIGH

### H1. Share dialog advertises a dead "short link" (no resolver exists anywhere)
- **file:line:** `src/components/share-dialog.tsx:371-379` (derives `shortCode` from `pageId` seed), `:538-545` (renders copyable URL), `:221-231` (CopyLinkButton → success toast). Only consumers of `src/lib/short-link.ts` are the dialog and its own test (`grep -l` confirmed: dialog, dialog test, lib test — nothing else).
- **Root cause:** `generateShortCode({ seed: pageId })` deterministically produces a 7-char code shown as `https://host/s/<code>` with "Copied" toast, but the only resolver is `src/app/s/[token]/page.tsx:107` — `prisma.shareLink.findUnique({ where: { token } })` against the 32-char `randomToken(24)`. No rewrite (`next.config.ts:143-158` headers-only), no middleware redirect (`src/middleware.ts:157-178` is CSP-only). Every short link users copy resolves to `UnavailableState` (`page.tsx:71-93`).
- **Verify:** publish a page, click the short-link copy button, open `https://<host>/s/<7chars>` → "no longer available".
- **Fix direction:** remove the LinkSection row, or add resolution in `/s/[token]` (detect `isValidShortCode` form → look up derived page's *published* ShareLink → redirect; deterministic code must point at an existing token, never directly at the page).

### H2. Form-share token leaks into page share state; "Unpublish" deletes 0 rows but reports success
- **file:line:** `src/server/queries/workspaces.ts:290-293` — `shareLinks: { select: { id, token }, take: 1 }` with **no `where: { viewId: null }` and no `orderBy`**; `src/app/w/[slug]/[pageId]/page.tsx:348` (`initialSharedToken={page.shareLinks[0]?.token}`), `share-dialog.tsx:432` (`const active = created ?? token`), `src/server/actions/share.ts:429` (`deleteMany({ where: { pageId, viewId: null } })`).
- **Root cause:** Publish a **form** (`share.ts:227-237` creates `ShareLink{viewId: view.id}`) without a page-level link → `getPageDetail` picks the form token → dialog shows the page as *published*. Unpublish's `deleteMany` matches 0 rows yet returns `{ ok: true }`, logs `page.unshared` (share.ts:430), toasts "Unpublished"; `router.refresh()` re-fetches the same form token and the dialog flips back to "published". The form link is invisible to this surface. With both kinds present, `take: 1` unordered picks an arbitrary token.
- **Verify:** create a database page, publish a form view, open the page share dialog → shows published/unpublishable even though `getShareLinkStateAction` (share.ts:69, correctly filtered `viewId: null`) says not published.
- **Fix direction:** add `where: { viewId: null }` (+ stable `orderBy`) to the select; optionally return the delete count from `revokeShareLinkAction`.

## CONFIRMED — MEDIUM

### M1. `createShareLinkAction` publishes a trashed page; link silently revives on restore
- **file:line:** `src/server/actions/share.ts:87-98` (no `deletedAt` in select/check; contrast `share.ts:179` which the form path guards); `src/server/actions/pages.ts:822-863` (restore does not revoke/flag links).
- **Verify:** trash a page → share panel → publish succeeds and mints a live URL. Restore → link goes live instantly with no re-share.
- **Fix direction:** check `deletedAt` like `loadShareableForm`; consider auto-revoke on `archivePageAction`.

### M2. Tauri crash auto-restart disables after 8 *lifetime* server starts, not 8 consecutive crashes
- **file:line:** `src-tauri/src/sidecar.rs:546-553` (`*attempt += 1` unconditionally in `start()`), `:649-668` (`let will_restart = attempt < 8` reads the never-reset total). Grep confirms no write path resets it.
- **Verify:** in the desktop app click "Restart local server" (shell.rs:162-170) 8 times (or change DB URL 8× via commands.rs:225-226); the next genuine crash shows the dead-server page with no supervision.
- **Fix direction:** reset `attempt` to 0 on `Readiness::Ready` in `start()`.

### M3. `set_database_url` irreversibly destroys a working connection string on failed restart
- **file:line:** `src-tauri/src/commands.rs:222-229` — `state::set_database_url` (persists into secrets.bin) runs **before** `sidecar::stop/start`; failure path restores nothing. Validation is syntax-only (`state.rs:69-91`) so a valid-syntax/wrong-password URL passes and overwrites the last-known-good value.
- **Fix direction:** snapshot the previous value and restore+restart on start failure, or trial-start before saving.

### M4. UNIQUE_ID allocator races under concurrent row creation → permanent duplicate IDs
- **file:line:** `src/server/row-cells.ts:66-89` — `findMany` over `propertyValue` → `nextNumbers` = max+1, inside the row-create transaction; two read-committed transactions both compute the same max+1. No unique constraint on PropertyValue.value (prisma schema). Shared by `createRowAction` and `submitFormAction`.
- **Fix direction:** per-property counter column with `update: { increment: 1 }` returning the value, or `(propertyId, text)` unique index + retry.

### M5. UNIQUE_ID numbers are re-issued after a trash purge → external references silently repointed
- **file:line:** same `row-cells.ts:71-74` scan. Soft deletes are safe (values remain), but purge cascades `PropertyValue` (`prisma/schema.prisma` Property onDelete Cascade; hard `page.deleteMany` in `pages.ts:889`), so `ID-12` gets re-issued after the row holding it is hard-deleted. Violates the never-reuse contract that exports/backlinks/relations treat as identity.
- **Fix direction:** monotonic per-property counter that survives hard deletes (also solves M4).

### M6. 2FA enable consumes the current time step → immediate re-login falsely rejected as replay
- **file:line:** `src/server/actions/two-factor.ts:75` (enable calls `consumeTotpStep(user.id, step)`, writing `twoFactorCounter = N`), `src/lib/totp-replay.ts:34-43` (accepts only step **strictly greater**: `twoFactorCounter: { lt: counter }`), `src/server/actions/auth.ts:336-338` (login same-step → returns `LOGIN_FAILED`/"Incorrect email or password" despite a correct code).
- **Verify:** enable 2FA, sign out, sign back in within 30 s with a freshly generated code → "Incorrect email or password."
- **Fix direction:** on enable write `twoFactorCounter: step - 1` (or store the enrollment step separately), so step N is still spendable once at login.
- *Adversarial recheck:* the original parenthetical "and burns the rate-limit budget" was **removed** — `registerFailedLogin` is not called on this path (it fires only on password failures, `auth.ts:295-299`); what is spent is one of the three-per-window codes of the **separate** 2FA guess budget (`:307`), not the account lockout counter.

### M7. Database "New row" has no in-flight guard → double-click duplicates whole rows (2+N writes with template prefill)
- **file:line:** `src/components/database/database-view.tsx:1879-1889` (`startTransition(async () => { … await createRowAction(...); router.refresh(); })` — transitions don't dedupe server actions); buttons at `database-actions.tsx:194`, `table-view.tsx:794-798`, `list-view.tsx:468-472`, `board-view.tsx:412-416`, `gallery-view.tsx:437-441` have no `disabled={pending}`. Codebase guards this pattern elsewhere (`form-view.tsx:439`, skip-to-end `database-view.tsx:2574`).
- **Fix direction:** a `creatingRow` state (or transition `isPending`) guarding all `onAddRow` call sites.

### M8. Invite single-use consumption is a read-then-write TOCTOU (double-accept possible)
- **file:line:** `src/server/actions/email.ts:490-504` (read `acceptedAt === null`) → `:595-598` (unconditional `update`); same pattern `src/server/actions/teamspace-invites.ts:193` / `:256-259`. The OAuth code in `src/app/oauth/token/route.ts:108-114` already does the correct conditional `updateMany … where used: false, count === 1`.
- **Fix direction:** `prisma.invite.updateMany({ where: { id, acceptedAt: null }, … })`, proceed only `count === 1`.

### M9. Tauri secrets.bin is non-atomic; crash mid-save silently resets all secrets
- **file:line:** `src-tauri/src/secrets.rs:75-96` (`OpenOptions::…truncate(true)` zeroes the file at open, before `write_all(MAGIC)` at `:89-90`) vs `:56-58` (zero-length file treated as a fresh empty store). The module comment (":73-74") promises truncation is *detected*, but a crash in the truncate→write window is not.
- **Impact:** silent loss of stored DB URL + new auth secret (all sessions invalid), no error — contradicts the documented fail-closed contract.
- **Fix direction:** temp file + `fs::rename` (POSIX); staged-rename on Windows; treat a non-first-run zero-byte file as an error in `load()`.

## CONFIRMED — LOW

### L1. Rollup `avg`/`median` count non-numeric text as 0; footer aggregation excludes it (cross-surface inconsistency)
- `src/lib/rollup.ts:47-53` — `"abc".replace(/[^0-9.eE+-]/g,"") → Number("") = 0` → included. `src/lib/aggregations.ts:~105` comment documents the divergence ("non-numeric strings are excluded (unlike rollup…)"). `rollup.test.ts:136` only asserts `/NaN/i`, blessing it. `avg(["12","abc"]) = 6` in a rollup vs `12` in the footer.
- **Fix direction:** share the `aggregations.ts` coercion; fix the test expectation.

### L2. Lockout backoff is a two-phase non-atomic update; last writer wins
- `src/server/actions/auth.ts:139-152` — increment+read separate from the `lockedUntil` write; concurrent failures can overwrite a larger backoff with a smaller one.

### L3. Signup commits the user before workspace/session; partial failure strands the account behind a misleading error
- `src/server/actions/auth.ts:200-226` — user row committed at :200-206, workspace/welcome-page/session can throw after → orphaned `emailVerified: false` user; every retry hits P2002 → "If you already have an account, sign in instead", and login then lands workspace-less (`auth.ts:365-375`, no membership → `/app`).
- **Fix direction:** `$transaction` across user/workspace/page, or complete-onboarding on login when orphaned.

### L4. Teamspace invite redemption drifts from the hardened workspace path
- `src/server/actions/teamspace-invites.ts:176-213` vs `email.ts:463-529`: no `canRedeem` gate, expiry check fails **open** at the boundary instant (`:194` `<` vs `invite-token.ts:117`'s `>=`), and **no grant re-check** at redemption — an invite minted by a later-demoted user still grants ADMIN. Consistency bug, not exploitable standalone (token is single-email-scoped).

### L5. Live share-link settings are write-once (password/expiry can never be cleared) and update path skips the audit log
- `src/server/actions/share.ts:118-127` (`??`-merge cannot express "remove"), no `logActivity` on the update branch (create logs `page.shared` at :143). No UI path to edit either since the form hides when `active` is set (`share-dialog.tsx:448`).
- **Fix direction:** explicit `clearPassword`/`clearExpiry` sentinels + audit event.

### L6. "Check for updates…" always answers "up to date"
- `src-tauri/src/commands.rs:213-216` (`Ok(None)` stub) consumed at `src/components/workspace-shell.tsx:328-337` as `toast.success(t("upToDate"))`. Affirmative lie rather than "unavailable". Fix: return `Err("update checking is not available in this build yet")` **and update the client branch** — *adversarial recheck:* a server `Err` alone would surface through the existing `.catch` as an **error toast that also reads "up to date"** (`workspace-shell.tsx:338` — `.catch(() => toast.error(t(locale, "upToDate")))`), so the catch path's copy must be changed too.

## SUSPICIOUS — LOW

### S1. Autosave success clobbers a newer pending payload; data loss possible only in the destroyed-editor teardown window
- `src/components/editor/page-editor.tsx:813` — `runSave` sets `pendingPayloadRef.current = null` unconditionally after a successful await, even though `persist()` (line 824) may have written a newer payload during the await. The debounce timer's fallback (`:777` `editor.getJSON()`) recovers it in the common case; the gap is only when the editor is destroyed before the fallback fires (editorRef effect cleanup at :1643-1645 runs before useEditor's destroy on unmount, and the teardown flush at :1894-1904 then sees `payload === null` at :784 and returns). Traceable but sub-600 ms window.
- **Fix direction:** only nullify `pendingPayloadRef` when it still equals the payload this run saved; in the flush effect, capture the payload before depending on the editor lifespan.
- **Autosave overall verdict:** otherwise sound — the offline buffer (`:722-770`), online/sync replay (`:1163-1183`), draft recovery (`:1687-1700`, offer-never-apply), and timer cleanup (`:1894-1904`) are defensively written; I found **no** stuck-spinner error path in the save flow (failure states set "error" but never leave pending unretryable except on user input, which re-triggers).

## Verified-solid (no bug despite suspicion)

- **Public share gating / unlock security / sitemap-RSS exclusions** (`src/app/s/[token]/page.tsx`, `src/lib/share-page.ts`, `src/lib/secrets.ts:775-904`, unlock route) — fails closed, boundary-instant-expiry correct, no title leak pre-password, form links re-validated, rate budgets separate. Only defect in this area is the `take:1` filter (H2) and the trash publish guard (M1).
- **Database sort/filter/pagination** — `(position, id)` keyset with `take: n+1` probe and id-dedup is off-by-one free both client and server; stable tiebreaks everywhere; null ordering "last" consistent.
- **Formula display** of NaN/Infinity guarded; div-by-zero errors-as-values; `formula-cache` keys on raw values (no staleness).
- **Auth hardening** — dummy-hash timing defence, PKCE S256 + constant-time compare, mandatory nonce + email_verified in SSO, `P2002` duplicate-signup race handled, safe-return-to redirect double-check, session expiry direction correct. Minor deviations: session cookie missing `__Host-` prefix (consistent writer/reader; deviates from the stated B31 rule), SSO first-login create not P2002-guarded.
- **Tauri Windows hardening (commit 795d292)** holds: capability split is minimal and audited, navigation guard denies origin-spoof/`javascript:`/`page:`, no manual path-string handling, DPAPI buffers freed on all paths, `logging::redact` covers URL credentials, no shell injection (args array), no unwrap-on-user-input panics, publish race aside `deleteMany`-revoke does clean all page-level tokens.
- **Editor** — `historyApplyingRef` guard against undo/re-save feedback loops, FLIP layer drag-abort cleanup on every path (`:1740-1760`), collab seeding once-only (`:1876-1889`).

## Commit-history follow-ups
Latest `fix:` batches (3b2d574 editor/sidebar/token/ticket regressions, de634f9 backlink-scan truncation) landed with matching `test(e2e)`/unit pins; no stale TODO markers surfaced at those sites. The only regression-prone spot I'd flag for follow-up is the editor autosave edge (S1) introduced along the pendingPayload architecture.

---

# Suggested Fix Order

1. Transaction wraps (`pages.ts` seeding, workspace transfer, calendar notes CAS)
2. Autosave single-flight refactor (`page-editor.tsx`)
3. Share-query filter (`viewId: null`) + short-link decision
4. 2FA enrollment step fix
5. UNIQUE_ID monotonic counter
6. Tauri items (sidecar counter reset, `set_database_url` rollback, secrets.bin atomicity)
7. Remaining TOCTOU/race hardening (invites, lockout backoff, chat/quick-find guards)
