# Spec — Plans & plan-gated features (community vs enterprise)

> **Status: spec complete, implementation pending.** This document is the
> deliverable; no production code was changed.
> Every claim about the current code cites file + line. Requirement IDs
> (`R26.x`) are the traceability anchors: the delivery plan in §8 lists tasks
> 1:1 against them, and tests must cite the IDs they cover. Matrix `§18`
> (`docs/FEATURE_MATRIX.md:671-689`, 14 rows) cites this file in its Notes
> cells; status glyphs are untouched by this change.

---

## 1. Problem statement

Noema is an **MIT-licensed, self-hosted** application (`LICENSE:1-3`,
`README.md:13`). The product class (Notion) answers "pricing & plan-gated
features" with four subscription tiers and a payment provider; Noema cannot —
there is **no billing surface, no customer account, and no payment processor**
in this repo (§9 registers that honestly as N/A, not as "planned").

For self-hosted software the same section means something different and
concrete:

1. **What is the community/enterprise split?** Which capabilities stay free in
   the MIT tree, and which require an enterprise license.
2. **How is a license expressed and enforced offline?** The operator's server
   must never phone home; enforcement has to be a local, deterministic check.
3. **Which features actually gate, decided from what is built?** Not from a
   pricing deck: several candidate gate features (SCIM, custom roles, extended
   audit log) do not exist yet, and several "obvious" gate candidates (SSO
   via `SSO_*` env, unlimited version history) are already shipped ungated.

This spec answers all three, audits every gating surface that exists today,
and fixes the gate vocabulary **before** the SAML (`docs/specs/saml-sso.md`)
and audit-log implementations land, so that work cites `R26.x` instead of
inventing per-feature ad-hoc checks.

## 2. Current state audit (evidence)

### 2.1 Roles & authorization — built, ungated (the real gate today)

| Surface | Evidence | State |
| --- | --- | --- |
| Role model | `prisma/schema.prisma:20` `enum WorkspaceRole { OWNER ADMIN MEMBER GUEST }` | 4 fixed roles, no plan dimension anywhere in the schema. |
| Membership | `prisma/schema.prisma:152` `WorkspaceMember`, `:166` `Invite` | Rows carry `role` only — **no seat/plan/limit columns**. |
| Access resolution | `src/lib/permissions.ts:10-26` (`getWorkspaceAccess`: membership row, owner fallback, `null` = denied) | Single source; fail-closed. |
| Role helpers | `src/lib/permissions.ts:28-38` (`canEditContent`, `canManageMembers`, `canDeleteWorkspace`) | Role-only predicates. |
| Action matrix | `src/lib/permissions.ts:44-58` (`WorkspaceAction` union), `:60-68` (`ACTION_GRANTS`), `:81-89` (`canPerformWorkspaceAction`: unknown action denies even the owner) | **The pattern this spec copies for feature gates** (R26.4). |
| Call sites | `src/server/actions/workspaces.ts:87` (`manageSettings`), `:119` (`deleteWorkspace`), `:143` + `:184` (`manageMembers`), `:247` (`transferOwnership`) | Server-side, not just hidden UI. |
| Page/share grants | `prisma/schema.prisma:481` `PagePermission`, `:67` `enum SharePermission`, `:510` `TeamspaceMember` (role `@default(MEMBER)`) | Shipped, ungated. |
| Guest scoping | `src/lib/guest-access.ts:1-11` (doc comment), `guestScope`/`guestVisiblePageIds` consumed by sidebar/search/page route; matrix `docs/FEATURE_MATRIX.md:376` | Shipped, ungated, e2e-proven. |

**Members/guests limits: none exist.** `sendWorkspaceInviteAction`
(`src/server/actions/email.ts:236-251`) validates the role whitelist
(`GUEST|MEMBER|ADMIN`) and rejects the owner's own address — there is **no
count cap, no seat cap, no guest cap** anywhere in `src/server/actions`
(searched: `memberLimit|maxMembers|guestLimit|storageLimit|retentionDays|
tokenBudget` → 0 matches in `src/`).

### 2.2 Capacity surfaces — built, flat, not plan-tiered

| Surface | Evidence | State |
| --- | --- | --- |
| File upload | `src/app/api/upload/route.ts:11` `const MAX_BYTES = 10 * 1024 * 1024` | Hard-coded 10 MB for every deployment. |
| Version history | `prisma/schema.prisma:245` `model PageVersion` (no retention column) | **Unlimited and never pruned** — no `pageVersion.delete*`/retention/prune call exists in `src/` or `scripts/` (the only retention in the repo is DB-dump retention, `scripts/backup.mjs:104`). |
| AI usage | `src/lib/api-guard.ts:8` `rateLimit()`; `/api/ai` + `/api/ai/skills` 30/60 s, `/api/chat/stream` 20/60 s, transcribe 10/60 s (`src/app/api/ai/route.ts:18` etc.) | Fixed-window **protection**, not metering: no token accounting, no budgets, no counters. |
| API rate limiting | README `README.md:68` ("fixed-window rate limiting on every API route") | Protection only. |

### 2.3 Feature flags & env — the de-facto gate today

There is **no feature-flag module** (matrix `docs/FEATURE_MATRIX.md:665`
"Feature flags … Planned"; searched `featureFlag|FEATURE_[A-Z]` in `src/` →
0 matches). Every capability switch that exists is **environment-variable
presence**, i.e. a deployment-level, operator-owned gate:

| Gate | Config | Consumers |
| --- | --- | --- |
| OIDC SSO | `.env.example:30` `SSO_ISSUER` (+ client id/secret) | `src/app/login/page.tsx:26` (renders "Sign in with SSO"), `src/app/api/auth/sso/start/route.ts:8`, `src/app/api/auth/sso/callback/route.ts:12` |
| AI provider | `.env.example:15-19` `AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL` | `src/lib/ai-provider.ts:34-39` (global fallback), plus per-workspace `AiProviderConfig` (`prisma/schema.prisma:544`, `enabled` flag surfaced by `src/server/actions/ai-settings.ts:79` `workspaceReady`) |
| SMTP | `.env.example:36-44` `SMTP_*` | `src/lib/mailer.ts:61-72`; workspace `EmailConfig` overrides (`src/server/actions/email.ts:100`) |
| Collab | `.env.example:12` `NEXT_PUBLIC_COLLAB_URL` — **build-time inlined** (defect D5, `docs/specs/realtime-collab.md:84-86`; runtime fix is R9.21) | `page-editor.tsx:242-252` |
| Cron auth | `.env.example:50` `CRON_SECRET` | `src/app/api/cron/templates` |
| App URL | `.env.example:47` `APP_URL` | `src/server/actions/email.ts:35` |

These are *infra* switches (like pointing at your own SMTP), not plan gates —
this distinction drives decision **D4** below.

### 2.4 Settings surface — nothing plan-shaped

- Workspace settings is one page: `src/app/w/[slug]/settings/page.tsx`
  (319 lines) with exactly four sections — `general` (`:169`),
  `members` (`:189`), `activityHeading` (`:215`), `exportHeading` (`:240`).
- It renders `AiSettings`, `EmailSettings`, `WebhookManager`,
  `TeamspaceManager`, `ApiTokenManager`, `OAuthAppManager`, `MembersManager`,
  `TwoFactorManager`, `DangerZone` (imports at `page.tsx:14-30`) — **no Plan,
  Billing, Upgrade or Seats section**.
- Zero matches for `billing|subscription|pricing|\bplan\b` as a product concept
  in `src/` (only unrelated local variables named `plan`,
  `page-editor.tsx:338-365`, `drag-indent.test.ts:74+`), and zero plan/billing
  keys in `src/lib/i18n.ts`.
- No `Subscription`/`Invoice`/`Customer`/`Plan` model in
  `prisma/schema.prisma` (full model list checked).

### 2.5 Enterprise feature inventory — built / spec'd / absent

| Candidate gate | State | Evidence |
| --- | --- | --- |
| SSO — OIDC | **Built**, env-gated (§2.3) | `login/page.tsx:26`, `sso/*` routes |
| SSO — SAML | **Spec complete, not built** | `docs/specs/saml-sso.md:3-4` status block; R10.13 settings section `:174`, R10.14 env defaults stay `:181`, R10.15 login button `:185` |
| SCIM | **Absent** — spec only | `docs/specs/saml-sso.md:206-208` (**R10.20**, milestone M3 `:339-341`); 0 matches for `scim` outside the spec |
| Audit log (extended) | **Absent** as a product surface | 0 matches for `auditlog|AuditLog` in `src/`; matrix `:640` "Audit log … Planned". What *does* exist is the **Activity trail**: `model Activity` (`prisma/schema.prisma:438`), `logActivity` (`src/lib/activity.ts:34`, called from pages/comments/cycles/… actions), read back at `src/server/queries.ts:178,761`, rendered in Settings → Activity (`settings/page.tsx:215`), matrix `:375` |
| Advanced permissions | **Partial**: fixed 4-role matrix + teamspace roles + page permissions (§2.1). **No custom/dynamic roles** (0 matches; matrix `:384` "Roles modeled; enforcement partial", `:405` "Access audit view … Planned") |
| Unlimited history | **Built and ungated** — everything is unlimited (§2.2) |
| Self-hosting / packaging | `LICENSE:1-3` MIT, `README.md:13`; **`package.json` has no `license` field**; matrix `:660` Self-hosting 🟡, `:661-663` Docker/proxy 🧭, `:665` feature flags 🧭 |

### 2.6 What the product class does (matrix §18, `FEATURE_MATRIX.md:671-689`)

Four tiers (Free/Personal/Team/Enterprise) with plan gates, per-plan guest &
upload caps, longer history on paid plans, AI token budgets, a self-hosted
license option, plus **Billing integration, Seat management, Plan change
proration and Usage metering** — the last four only exist because the product
class charges money.

## 3. Decision

**D1 — Two editions, not four tiers.** Noema ships a **community** edition
(the MIT tree as it runs today, default) and an **enterprise** edition
(unlocked by a license file, §5). The matrix rows *Free/Personal/Team plan*
(`:676-678`) all map to community — the operator's team size is not a
billing concern of ours; *Enterprise plan* (`:679`) maps to the enterprise
edition. No tier ladder, no per-seat pricing surface.

**D2 — Payment processing is N/A, permanently.** No payment provider,
subscription lifecycle, proration, invoicing, or billed seats will be
implemented (§9, R26.16). Matrix rows `:686-689` are documented N/A in this
spec; their glyphs are not changed by this change (maintainer owns status).

**D3 — License = offline signed file, fail → community.** An Ed25519-signed
JSON license file (§5.1), verified locally against a pinned public key.
Invalid/tampered/expired/unreadable ⇒ community edition, logged once, startup
never fails. **No phone-home, no activation endpoint, no telemetry** (R26.3) —
self-hosted means the license check must work air-gapped.

**D4 — Grandfather rule: what is shipped ungated stays community.** Every
capability already built and reachable without a license remains community
unless it appears in the explicit enterprise allow-list: env-level OIDC SSO
(§2.3), SMTP, AI BYO-key, the Activity trail, the fixed role matrix, guest
scoping, version history, API tokens/webhooks/OAuth apps, uploads. This
converts the matrix note "SSO/audit gated" (`:679`) into a precise statement:
the **per-workspace SSO product surface** (SAML connections + the SSO settings
section, `saml-sso.md` R10.13) and the **extended audit log** are gated; the
deployment env switches they build on are not (this is also forced by
R10.14 "env-level defaults stay"). Retroactive paywalling of shipped behavior
would break existing self-hosters — see risk K1.

**D5 — Two enforcement classes.**

- **Class A — hard gates (license-checked code):** features that only exist
  under enterprise (`sso` connections, `scim`, `auditLog`, `customRoles`).
  Enforced server-side, fail closed, denial is a typed error (R26.5).
  Exactly **four** feature keys exist in the allow-list (R26.11) so the gate
  surface cannot silently grow.
- **Class B — capacity defaults (operator-configured limits):** guest cap,
  upload cap, history retention (R26.12-14). In self-hosted software the
  operator *owns the machine*; capacity is expressed as env config with
  per-edition defaults shipped in deployment templates (`.env.example`,
  `docker-compose.yml`), **never as a paywall**: limits apply to *new grants
  and new allocations only*, they never revoke existing members/guests and
  never delete existing data as a side effect of an edition change. Raising a
  limit above the community default is a config edit the operator is allowed
  to make (documented, not patched out) — the license sells code, not
  arithmetic.

**D6 — Gate-by-feature decisions** are the table in §6; each row of matrix §18
maps to a decision + `R26.x` there.

## 4. Requirements (numbered, testable)

### Edition & licensing

- **R26.1** — The deployment has exactly two editions, `community` and
  `enterprise`, resolved by a pure function
  `resolveEdition({ env, license }) -> { edition, reason }`.
  `NOEMA_EDITION` unset ⇒ community (default); `community` ⇒ community even
  if a license file is present; `enterprise` without a valid license ⇒
  community with `reason` naming the failure.
  *Acceptance:* unit matrix over {unset, community, enterprise+no file,
  enterprise+valid, enterprise+tampered, enterprise+expired, enterprise+
  wrong-key} asserts edition + reason for all 7 cells.

- **R26.2** — The license file (`NOEMA_LICENSE_FILE`, default
  `./license/noema.license`) is JSON
  `{ v, edition, licensee, issuedAt, expiresAt?, features[], sig }` with a
  detached Ed25519 signature over the canonical payload, verified against the
  public key pinned in the repo. Verification is offline, constant-time
  where it matters, and tolerates clock skew ≤ 24 h. Any parse error, unknown
  `v`, signature failure, or expiry ⇒ community (D3), never a throw.
  *Acceptance:* fixture-based unit tests — flip one payload byte ⇒ community;
  expired ⇒ community; future-dated `issuedAt` beyond skew ⇒ community;
  valid fixture ⇒ enterprise; the test suite runs with networking disabled.

- **R26.3** — License evaluation performs **zero network I/O**: no
  activation, renewal call, or telemetry. The check runs at most once per
  request (memoized per process, invalidated on file change/`SIGHUP`).
  *Acceptance:* unit test asserts the gate module imports no HTTP client
  (dependency scan); `grep` gate in CI for `fetch|http.request` in the
  edition/gate modules.

### Gate mechanism

- **R26.4** — One gate function, mirroring the permissions pattern:
  `canUseFeature(feature: FeatureKey, edition: Edition): boolean` with a
  typed `FeatureKey` union. Unknown feature ⇒ `false` **even on enterprise**
  (same fail-closed semantics as `canPerformWorkspaceAction`,
  `src/lib/permissions.ts:81-89`). No feature check anywhere else in the
  codebase reads `process.env` directly (existing §2.3 infra switches are
  exempt until migrated; new gates are not).
  *Acceptance:* unit matrix (community × all keys ⇒ false; enterprise ×
  allow-listed ⇒ true; enterprise × unknown key ⇒ false); lint-level grep
  test that no file except the gate module calls `canUseFeature`'s
  internals.

- **R26.5** — Enforcement is **server-side at the action/route boundary**,
  before side effects; hiding UI is cosmetic. A denial returns a typed error
  carrying a stable code (`FEATURE_NOT_LICENSED`) and an i18n string
  ("This is an enterprise feature — add a valid license to enable it."),
  surfaced through the existing ActionErrorGuard/toast path — never
  `window.prompt`/`window.alert` (coherence gate). All new strings go through
  `t()` so the i18n ratchet (`check:coherence` `i18nFiles ≥ 71`) cannot
  shrink.
  *Acceptance:* one integration test per gated action (added as each feature
  lands) asserting denial with `FEATURE_NOT_LICENSED` and **zero** rows
  written; i18n coverage ratchet still green.

- **R26.6** — Workspace settings gains a fifth section **"Plan"** beside
  `general/members/activity/export` (`settings/page.tsx:169,189,215,240`),
  admin-only via `canPerformWorkspaceAction(role, "manageSettings")`. It shows
  the resolved edition + `reason`, each Class-A gate with its state, and (when
  the file is unreadable/expired) why. It is **deliberately not itself
  gated** — gating the surface that activates gates would be circular — and
  it contains **no upsell, no pricing links, no external calls** (self-hosted;
  R26.3).
  *Acceptance:* e2e `e2e/plan-gate.spec.ts` — community admin sees
  "Community" + four gates listed as unavailable; non-admin gets the existing
  unauthorized treatment; page makes no third-party requests (route-hold
  assertion).

### Feature gates (decided from what is built)

- **R26.7** — **SSO.** Deployment-wide env OIDC (§2.3) stays community under
  D4. The per-workspace SSO surface specified in `docs/specs/saml-sso.md` —
  connection CRUD, the admin "Single sign-on" section (R10.13), and the
  connection-driven login button (R10.15) — requires the `sso` gate; env-level
  defaults keep working per R10.14 regardless of edition.
  *Acceptance:* community: SAML connection create/update/delete denies
  `FEATURE_NOT_LICENSED`, OIDC login with `SSO_ISSUER` still succeeds;
  enterprise+valid license: connection CRUD succeeds.

- **R26.8** — **SCIM.** The `scim` gate exists from day one (allow-listed in
  R26.11) although the feature is not built — it exists only as R10.20
  (SCIM 2.0 endpoints, `saml-sso.md:206-208`, M3). The implementation
  must wire R10.20 through `canUseFeature("scim", …)` instead of inventing a
  new mechanism.
  *Acceptance:* gate unit matrix already covers `scim` (R26.4 test);
  when R10.20 lands, its tests cite both R10.20 and R26.8, asserting denial
  with no `SamlScimToken`/user provisioning side effects in community.

- **R26.9** — **Audit logs.** The Activity trail (§2.5: `Activity` model,
  `logActivity`, Settings → Activity) is community forever — it is the
  transparency baseline, not a paid feature. The planned workspace audit log
  (matrix `:640`: long retention, filters, CSV/JSON export, sensitive-action
  coverage beyond the trail) is gated `auditLog`.
  *Acceptance:* trail writes/reads unchanged in community (existing activity
  tests stay green); the future export action denies in community with zero
  bytes produced.

- **R26.10** — **Advanced permissions.** The shipped model (fixed
  `WorkspaceRole` set, `ACTION_GRANTS`, teamspace roles, `PagePermission`,
  `SharePermission` — §2.1) is community. Custom/dynamic roles (not built;
  matrix `:384` partial, `:405` planned view) will be gated `customRoles` —
  the allow-list entry exists now, the feature does not.
  *Acceptance:* `permissions.test.ts` pins today's matrix unchanged (no
  regression from the gate work); `customRoles` covered by the R26.4 matrix.

- **R26.11** — **Grandfather + allow-list lock.** The Class-A allow-list is
  exactly `["sso", "scim", "auditLog", "customRoles"]`. Adding a key requires
  a spec amendment here first (documented in §6); a feature not on the list
  denies as enterprise, and shipped-ungated features (D4) may not be moved to
  the list without an O26.x resolution.
  *Acceptance:* unit test pins the array literal (fails when someone adds a
  key without editing this spec); repo grep shows no other
  `canUseFeature(<literal>)` call sites.

- **R26.12** — **Guest cap (Class B).** `MAX_GUESTS` env, enforced in
  `sendWorkspaceInviteAction` (and the project-client invite path,
  `email.ts:236-251`) **before** creating an `Invite` row. Unset ⇒ unlimited
  (today's behavior, back-compat). Templates propose community default 25 /
  enterprise unlimited. Counting counts *pending + accepted guests*; denial
  message is i18n'd; existing guests are never revoked by lowering the cap.
  *Acceptance:* unit/integration — cap at N ⇒ (N+1)-th invite denies with no
  `Invite` row; members/admins unaffected by the guest cap; unset ⇒ no cap.

- **R26.13** — **Upload cap (Class B).** `MAX_UPLOAD_MB` replaces the
  hard-coded `MAX_BYTES` (`upload/route.ts:11`); unset ⇒ 10 (byte-identical
  to today). Templates propose community 10 / enterprise 100. Applied to new
  uploads only; never affects stored files.
  *Acceptance:* route test — 11 MB body rejected when default, accepted when
  `MAX_UPLOAD_MB=50`; default-unset behavior matches current 10 MB boundary.

- **R26.14** — **History retention (Class B).** New env
  `HISTORY_RETENTION_DAYS` (0/unset ⇒ no pruning = today's unlimited
  behavior); when set > 0, a cron job on the existing authenticated cron
  surface (`src/app/api/cron`, `CRON_SECRET` `.env.example:50`) deletes
  `PageVersion` rows older than N days, newest-per-page kept, and logs the
  count. Because enabling it is an explicit operator act, `.env.example`
  documents "back up first" (existing `scripts/backup.mjs`,
  workspace export `src/app/api/export/workspace/[slug]`). Enterprise
  templates ship 0/unlimited; community templates suggest 90. The *product*
  surface (a settings UI to edit it) is not license-gated — Class B is
  config, not code (D5).
  *Acceptance:* unit — cutoff math (boundary exactly N days, newest kept,
  per-page survivor); integration — unset ⇒ 0 deletes; set to N ⇒ only rows
  beyond the window removed; job rejects without valid `CRON_SECRET`.

- **R26.15** — **AI usage limits (Class B / partial N/A).** Noema is BYO-key:
  the operator's own provider account is billed (`AiProviderConfig`
  `prisma/schema.prisma:544`, global `AI_*` env `ai-provider.ts:34-39`), so a
  per-plan token budget would meter money that is not ours. What ships:
  existing fixed-window rate limits (§2.2) stay as protection, and an
  optional operator-only warn threshold (`AI_MONTHLY_TOKEN_BUDGET`,
  warn-toast in the Plan/Info area, **never blocking, never licensed**). Any
  future hard budget is an operator config — never a license gate, never a
  billing meter (ties R26.16).
  *Acceptance:* no persistent billing counters; rate-limit tests unchanged;
  budget exceeded ⇒ warning only, AI requests still succeed.

### Non-goals

- **R26.16** — **Payment processing & commercial metering: N/A (honest
  scope cut).** No payment provider integration, subscription lifecycle,
  invoice/tax handling, **billed** seat management, plan-change proration, or
  billing-grade usage metering will be implemented (§9). "Seat management"
  in the product sense reduces to the existing free member management
  (`workspaces.ts:136-198`); "usage metering" reduces to the protection rate
  limits of §2.2.
  *Acceptance:* repo grep for payment-provider SDKs/keys
  (`stripe|paddle|braintree|lemonsqueezy|checkout session`) returns nothing;
  `package.json` gains no billing dependency; §9 stays in this document.

## 5. License & gate contract (design)

### 5.1 License file

```
./license/noema.license          # override path: NOEMA_LICENSE_FILE
{
  "v": 1,
  "edition": "enterprise",
  "licensee": "ACME Corp",            // free text, displayed in Plan section
  "issuedAt": "2026-01-01T00:00:00Z",
  "expiresAt": null,                  // null = perpetual; else ISO date
  "features": [],                     // reserved; gate set is fixed by R26.11
  "sig": "<base64 Ed25519 detached signature over canonical JSON of above>"
}
```

- Public key pinned in-repo (`src/lib/edition.ts` constant); rotation ships
  with a release that also accepts the previous key.
- Canonical JSON = keys sorted, no whitespace — one helper, unit-tested.
- `NOEMA_EDITION=community|enterprise` selects intent; the signature decides
  reality (mismatch ⇒ community + reason, R26.1).

### 5.2 Modules (new, pure, lib-first — the sandbox rule)

- `src/lib/edition.ts` — parse + verify + `resolveEdition` (R26.1-3).
- `src/lib/gates.ts` — `FeatureKey`, allow-list (R26.11), `canUseFeature`
  (R26.4), `FEATURE_NOT_LICENSED` error code (R26.5).
- Both unit-tested in vitest with fixtures; no Prisma import, no network —
  same class of pure module as `permissions.ts` + `guest-access.ts` helpers.

### 5.3 Denial path (server → UI)

```
server action / route handler
  → canUseFeature("sso", resolveEdition(...).edition)     // before side effects
  → false ⇒ return { error, code: "FEATURE_NOT_LICENSED" } // typed, i18n key
  → ActionErrorGuard/toast renders it (never window.alert — coherence gate)
```

UI hides gated controls the same way gated server actions are hidden today
(members/settings patterns), with the understanding that hiding is cosmetic
(R26.5).

## 6. Gate matrix — matrix §18 rows → decision

| Matrix §18 row (`FEATURE_MATRIX.md`) | Decision | Class | Requirement |
| --- | --- | --- | --- |
| `:676` Free plan | = community edition (default) | — | R26.1 |
| `:677` Personal plan | = community (no tiering) | — | R26.1 |
| `:678` Team plan | = community (no tiering) | — | R26.1 |
| `:679` Enterprise plan | = enterprise edition via license; "SSO/audit gated" = per-workspace SSO + extended audit log only (D4) | A | R26.1-3, R26.7, R26.9 |
| `:680` Plan gates | single fail-closed `canUseFeature`, 4-key allow-list, server-side | A | R26.4-5, R26.11 |
| `:681` Guest limits by plan | `MAX_GUESTS` env; new invites only; unset = unlimited | B | R26.12 |
| `:682` File upload limits by plan | `MAX_UPLOAD_MB` env; default 10 MB = today | B | R26.13 |
| `:683` Version-history retention by plan | `HISTORY_RETENTION_DAYS` env; default off = today's unlimited; enterprise default unlimited | B | R26.14 |
| `:684` AI usage limits by plan | no plan budget (BYO-key, operator pays); rate limits stay; optional warn-only budget | B / N/A metering | R26.15 |
| `:685` Self-hosted license option | signed offline license file; MIT community default | A | R26.1-3, R26.6 |
| `:686` Billing integration | **N/A** — self-hosted, no payment processing | N/A | R26.16 |
| `:687` Seat management | **N/A** as billing; member management stays free (`workspaces.ts:136-198`) | N/A | R26.16 |
| `:688` Plan change proration | **N/A** — nothing to prorate without billing | N/A | R26.16 |
| `:689` Usage metering | **N/A** for billing; protection rate limits already exist (§2.2) | N/A | R26.16 |

Status glyphs in these rows are **not** changed by this change (Notes-only
edit; status/count regeneration is maintainer-only).

## 7. Test plan

**Unit (vitest, red-first, cite R26.x)**

1. *Edition resolution* — 7-cell matrix incl. all failure reasons (R26.1).
2. *License verification* — fixtures: valid / byte-flipped / expired /
   skew / unknown `v` / wrong key ⇒ community, never throws (R26.2);
   assertion that the module performs no I/O (R26.3).
3. *Gate matrix* — community × 4 keys; enterprise × 4 keys; unknown key ×
   enterprise ⇒ false; allow-list literal pinned (R26.4, R26.11).
4. *Retention cutoff* — boundary day, newest-per-page survivor, unset ⇒ 0
   deletions (R26.14).
5. *Guest cap* — N-th guest invite denied, no `Invite` row, members exempt,
   unset ⇒ uncapped (R26.12).
6. *Upload boundary* — default 10 MB preserved, env override honored
   (R26.13).

**Integration / e2e (as features land)**

7. Gated action denial end-to-end: `FEATURE_NOT_LICENSED` toast, zero
   side-effect rows (R26.5) — first real instance with SAML connection CRUD
   (R26.7).
8. e2e `e2e/plan-gate.spec.ts`: Plan section renders edition + gate states,
   admin-only, no third-party requests (R26.6).
9. Non-regression: OIDC login path and Activity trail untouched in community
   (R26.7, R26.9).

**Gates owed (FAST tier — docs-only):** `npm run check:coherence` green
(never green by loosening a ratchet), `tsc --noEmit`, `eslint`; no build, no
e2e, no `docs:counts`/`docs:gaps` (maintainer-only).

## 8. Delivery plan (milestones → tasks ↔ requirements)

> Test-first: each task's acceptance is a red
> test citing its R26.x before implementation.

**L1 — Edition + license core (~1 day)**

- T26.1 [R26.1,R26.2,R26.3]: `src/lib/edition.ts` + fixtures. Red: unit 1,2.

**L2 — Gate primitive + denial path (~1 day)**

- T26.2 [R26.4,R26.11]: `src/lib/gates.ts` allow-list + `canUseFeature`.
  Red: unit 3.
- T26.3 [R26.5]: typed error code + i18n key + toast wiring pattern doc for
  consumers. Red: integration 7 harness.

**L3 — Plan section (~1 day)**

- T26.4 [R26.6]: fifth settings section (admin-only, offline). Red: e2e 8.

**L4 — Class-B capacity (~1-2 days)**

- T26.5 [R26.12,R26.13]: `MAX_GUESTS`, `MAX_UPLOAD_MB` + `.env.example`
  templates. Red: unit 5,6.
- T26.6 [R26.14]: retention cron job + docs. Red: unit 4.
- T26.7 [R26.15]: warn-only AI budget. Red: unit (budget warns, never
  blocks).

**L5 — Feature wiring (cross-cutting, cites this spec)**

- T26.8 [R26.7]: SAML connection CRUD gates — **implemented with the
  `saml-sso.md` (B10) implementation**, which must cite R26.7.
- T26.9 [R26.8]: `scim` gate consumed by R10.20 when M3 lands.
- T26.10 [R26.9,R26.10]: extended audit log + custom roles gates as those
  features land (matrix `:640`, `:384`).
- T26.11 [R26.16]: no-op + grep guard (CI) for payment SDKs.

## 9. N/A register (honest)

| Item | Verdict | Why |
| --- | --- | --- |
| Payment processing / provider integration | **N/A** | Self-hosted, MIT; the operator runs the infrastructure — there is nothing for us to bill for in this distribution. No Stripe/Paddle/… code will land (R26.16). |
| Subscription lifecycle (trial/upgrade/renewal/dunning) | **N/A** | Editions are file-based, not accounts (R26.2). |
| Billed seat management | **N/A** | Membership is uncapped and free (§2.1); "seats" are a billing concept. |
| Plan change proration | **N/A** | No paid plans, no proration arithmetic. |
| Billing-grade usage metering | **N/A** | Only protection rate limits exist (§2.2); metering money is out of scope. |
| Cloud tier pricing page in-app | **N/A** | No hosted cloud offering in this repo; the Plan section shows state, never offers (R26.6). |

Revisit only via an explicit spec amendment, never ad-hoc in feature work.

## 10. Risks & open questions (honest)

**Risks**

1. **K1 — Retroactive-gating backlash.** Moving shipped behavior (OIDC SSO,
   history, uploads) behind a license would break every existing self-hoster.
   Mitigation: the grandfather rule D4 + allow-list lock R26.11 makes the
   enterprise set a fixed, reviewable literal.
2. **K2 — Honor-system enforcement.** An operator can edit env, delete the
   gate call, or hand-patch the key — accepted for self-hosted software
   (D3/D5): the license is a legal/commercial artifact, not DRM; building
   obfuscation would violate the offline, inspectable premise. Consequence:
   gates must fail *gracefully* (community keeps working, feature denies),
   never brick a deployment.
3. **K3 — Data loss via retention.** Pruning `PageVersion` is destructive.
   Mitigation: opt-in only (unset = no prune), backup/export documented at
   the point of enablement, job logs counts, per-page survivor rule (R26.14).
4. **K4 — Legal shape of "open-core" (O26.1).** If enterprise-gated code
   ships inside the MIT tree, the gate is pure honor-system; a real
   commercial split needs a license/exclusion decision (e.g. `enterprise/`
   dir under a separate license) that this spec cannot make — engineering
   consequence is only that the allow-list must stay small (R26.11).
5. **K5 — Spec/implementation drift.** SAML (B10) and audit-log
   work could invent their own checks. Mitigation: R26.7/R26.8/R26.9 are
   written as obligations that work must cite, and R26.4 forbids
   out-of-module env reads for gating.

**Open questions**

- **O26.1** — License model: MIT tree with honor-gated enterprise features
  (status quo of this spec) vs. dual-license the `enterprise/` directory?
  Legal decision; engineering impact limited to where the four gated modules
  live.
- **O26.2** — Should env-level OIDC ever move behind `sso`? Current answer:
  no (D4 + R10.14 compatibility); revisit only with a migration story for
  existing `SSO_*` deployments.
- **O26.3** — License expiry semantics: hard downgrade at `expiresAt` (current
  reading of R26.1-2) vs. a grace period for long-lived air-gapped servers
  with no way to renew promptly.
- **O26.4** — Do future Docker images (matrix `:661-662`) ship enterprise
  code in the same image (license file mounted at runtime — presumed here) or
  as a separate build arg? Affects nothing in R26.x today.
- **O26.5** — Should the Plan section expose a "download diagnostics for
  license failures" helper (offline support), or keep `reason` text-only as
  specified?
