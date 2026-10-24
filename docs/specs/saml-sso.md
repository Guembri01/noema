# Spec — SAML 2.0 SSO (`@node-saml/node-saml`)

> **Status: env-level M1 implemented; per-workspace M2/M3 pending.** The
> deployment-default SAML connection now has start/ACS/metadata/SLO routes,
> `@node-saml/node-saml` validation, a persistent assertion replay cache,
> JIT/linking, group→role mapping, workspace auto-join, signed RelayState and
> per-workspace `SsoConnection` rows/admin CRUD with `?connection=` route
> resolution, and `VerifiedDomain` DNS TXT verification/auto-join (see
> `docs/integrations/saml.md`). Not yet built: the rendered settings UI,
> metadata-URL rotation and SCIM. Requirement IDs
> (`R10.x`) remain the traceability anchors; §12's task list references them
> 1:1 and every test cites the IDs it covers.

---

## ⚠️ Iron law (read before anything else)

**SAML assertions MUST be validated with [`@node-saml/node-saml`]
(exactly-one-of signature/encryption options per its docs).**
**NEVER hand-roll XML signature verification, canonicalization, or XML-DSig
logic in this codebase.** `@node-saml/node-saml-idp` may be added as a
**devDependency** solely to run a mock IdP in tests. Any implementation PR
that contains bespoke `xmldsig`/C14N/reference-resolution code is to be
rejected at review regardless of test results. This mirrors how the OIDC path
already delegates cryptography to `jose` rather than rolling its own JWT code
(`src/app/api/auth/sso/callback/route.ts:3,61-65`).

---

## 1. Problem statement

Noema authenticates with email/password (+ TOTP 2FA), and offers **env-configured
OIDC** SSO (`SSO_*` variables). Enterprise buyers in the product class expect
**SAML 2.0** against Okta / Azure AD / Google Workspace, with Just-in-Time
(JIT) provisioning, role mapping from directory groups, verified-domain
auto-join, and eventually SCIM provisioning. This spec adds SAML behind the
existing SSO surface so workspace settings get **one** SSO page regardless of
protocol.

## 2. Current state audit (evidence)

| Area | Evidence | State |
| --- | --- | --- |
| Password auth + 2FA | `src/server/actions/auth.ts:19-114`, `src/lib/auth.ts`, `src/lib/totp.ts` (+ `totp.test.ts`), `src/server/actions/two-factor.ts` | Signup/login/logout server actions; TOTP gate before session issue (`auth.ts:85-90`); sessions = HS256 JWT cookie `noema_session`, 30 days, signed with `AUTH_SECRET` (`src/lib/auth.ts:31-47`). |
| OIDC SSO (env-level) | `src/app/api/auth/sso/start/route.ts`, `.../callback/route.ts`, `.env.example:30-33` | Discovery via `/.well-known/openid-configuration` (`start:14-21`), state+nonce in httpOnly cookies (`start:38-39`), code exchange + `jose` JWKS verification with issuer/audience/nonce (`callback:42-72`), JIT user create only when the id_token asserts email_verified: true, keyed by lowercased email with sentinel password `sso:<random>` and `emailVerified: true` (`callback:82-87`), then `createSession` (`callback:89`). A sign-in links an existing account only when that account proved its address (`User.emailVerified`); an unverified one is refused with `?error=sso_email_taken` (B07). **Global for the whole deployment; not per-workspace; no role/group mapping** (JIT user lands in no workspace). |
| Login surface | `src/app/login/page.tsx:26` | Renders a "Sign in with SSO" link only when `process.env.SSO_ISSUER` is set. |
| Settings UI | `src/app/w/[slug]/settings/page.tsx` | Single scrolling settings page of sections (General, Members, Activity, 2FA, API tokens, OAuth apps, Webhooks, AI, Labels, Email, Teamspaces); admin gate `canManageMembers` (`:62,164`). **No SSO section** — SSO config exists only as env. |
| OAuth apps | `src/server/actions/oauth-apps.ts`, `OAuthAppManager` on settings page (`:246`) | Third-party OAuth **clients** Noema issues (integrations). Unrelated to SSO; must not be conflated in the UI. |
| Roles | `src/lib/permissions.ts:28-38`, `prisma/schema.prisma:152-164` | `WorkspaceRole` = OWNER / ADMIN / MEMBER / GUEST on `WorkspaceMember`; workspace owner auto-OWNER (`permissions.ts:20-24`). |
| Invites | `prisma/schema.prisma:166-182`, `src/server/actions/email.ts` | Email invites with role + expiry; the model SAML JIT must complement, not bypass (an invited email wins over domain rules). |
| Mock IdP harness | `scripts/check-sso-teamspaces.mjs:13-87` | In-process OIDC mock IdP on `:4321` (discovery, `/authorize`, `/token`, `/jwks`, RS256 `id_token` with `email`/`name`/`nonce` claims, `:67-79`); full flow asserted end-to-end including negative state test (`:119-120`) and JIT user cleanup (`:159`). `npm run check:sso` (`package.json:15`). |
| Server env for the live gate | the dev-server config | The live gate server starts with `SSO_ISSUER=http://localhost:4321 SSO_CLIENT_ID=noema SSO_CLIENT_SECRET=secret`. |
| SAML code today | — | **None.** No `@node-saml/*`, no XML libs in `package.json:45-101`. |
| Docs drift worth knowing | `docs/FEATURE_MATRIX.md:655,656,654` | Row 655 "SSO / SAML ✅" is OIDC-only (glyph overstates); row 656 says "OIDC support 🧭 Planned" (stale opposite); row 654 says 2FA planned though implemented. Left as-is per house rules — this spec's matrix Notes append is the only edit. |

**Summary:** what exists is a solid, tested *env-level OIDC* login with JIT
user creation. What is missing for parity: SAML protocol support, per-workspace
SSO configuration, group→role mapping, workspace auto-join for JIT users,
domain verification, SLO, and SCIM.

## 3. Decision: protocol library & layering

- **Library**: `@node-saml/node-saml` (maintained successor of `passport-saml`'s
  core; supports signed/encrypted assertions, metadata endpoints, `validateSignature`,
  clock skew allowance, and covers the AuthnRequest/Response lifecycle). Version
  pinned exactly; upgrades only with a regression run of the mock-IdP suite.
- **Layering**: introduce a thin **SSO provider abstraction**
  (`src/lib/sso/providers.ts`): `type SsoProtocol = "oidc" | "saml"`, with a
  common result shape `{ email, name, groups, providerId }`. Both the existing
  OIDC callback and the new SAML ACS reduce to this shape, then share one
  **post-auth provisioning pipeline** (link → JIT → domain/invite join →
  session). The existing OIDC routes are refactored onto the abstraction
  without behavior change (its mock-IdP suite must stay green — regression
  net).
- **Config model**: env `SSO_*` remains the **deployment-default OIDC**
  connection (back-compat). SAML connections are **per-workspace DB rows**
  (`SsoConnection`, §6). The login page shows "Sign in with SSO" when *any*
  connection exists (env or DB), and — if multiple — a workspace chooser by
  email domain, else a generic list.

## 4. Architecture

### 4.1 SP (Service Provider) surface

| Endpoint | Purpose |
| --- | --- |
| `GET /api/sso/saml/metadata?connection=<id>` | SP metadata XML: entity ID, ACS URL, SLO URL, NameID format, signing cert (if SP-signed requests enabled). IdPs (Okta "Metadata URL", Azure "Federation metadata URL", Google "IDP metadata") consume this. |
| `POST /api/sso/saml/acs` | Assertion Consumer Service. Receives `SAMLResponse` (+ `RelayState`), validates via `node-saml`, runs the provisioning pipeline, issues `noema_session`, redirects to RelayState (validated same-site relative) or the workspace. |
| `POST /api/sso/saml/slo` | Single Logout endpoint (M2; receives `SAMLRequest`, best-effort — always destroys the local session even if IdP SLO is unsupported). |
| `GET /api/sso/saml/start?connection=<id>` | Builds and redirects the AuthnRequest (with `RelayState` = validated return path). Optional `ForceAuthn` flag for "re-authenticate" flows. |

- **Entity ID**: stable per connection: `<origin>/api/sso/saml/sp/<connectionId>`
  (stable across origin changes is *not* guaranteed — documented; enterprise
  IdPs pin entity IDs, so changing the origin requires updating the IdP).
- **NameID policy**: `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`
  default, per-connection override. If the NameID isn't an email, the
  configured email attribute (`emailAttribute`, default
  `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` —
  Azure — vs Okta's `email` / Google's `email`) is used.

### 4.2 Validation rules (all via `node-saml`, all fail-closed)

- Response **and** assertion must be signed (or assertion encrypted+signed);
  `wantAssertionsSigned: true`, `audience` = our entity ID, `destination` =
  ACS URL.
- **Clock skew**: `clockTolerance: 120` seconds (IdP clock drift is the #1
  enterprise failure).
- **Replay protection**: `WantAssertionsSigned` + `OneTimeUse` honored when
  present; **Assertion ID cache** — a Postgres-backed `SamlAssertionSeen`
  (assertionId, expiresAt) checked-and-inserted atomically before processing;
  rows GC'd past newest assertion `NotOnOrAfter`.
- **Encrypted assertions**: supported when configured (cert stored per
  connection); decryption via the connection's private key inside `node-saml`.
- Any validation failure → destroy any half-open state, redirect
  `/login?error=sso` (same UX as OIDC failures, `callback:28`), and write a
  `saml.login_failed` activity row with the reason class (never the payload).

### 4.3 IdP metadata import

- Per connection: **URL** (fetch with 5 s timeout, HTTPS only, re-fetch weekly
  via a lazy cache — certificate rotation) **or paste** (XML textarea,
  validated on save by constructing a `node-saml` strategy in dry-run mode).
- Manual field override (entity ID, SSO URL, cert) as an advanced expander for
  IdPs that only give certs.

## 5. Requirements (numbered, testable)

### Protocol & security

- **R10.1** — ACS validates every `SAMLResponse` exclusively through
  `@node-saml/node-saml`; the dependency is added to `package.json` and a
  CI/gate grep (`scripts/check-saml.mjs` step 0) asserts no `xml-crypto`,
  `xmldsig`, or bespoke signature code exists under `src/`.
- **R10.2** — A tampered assertion (byte flipped in the signature-covered
  region) is **rejected**; the user gets `/login?error=sso`, no session
  cookie, and a `saml.login_failed` activity row. (Negative test, fail-closed.)
- **R10.3** — Assertion `audience` mismatch, `destination` mismatch, expired
  `NotOnOrAfter` (beyond 120 s skew), and `NotBefore` in the future are each
  rejected independently (table-driven negative tests).
- **R10.4** — Replay: resubmitting a previously accepted `SAMLResponse`
  byte-for-byte is rejected via the assertion-ID cache (R10.16); the first
  submission succeeds.
- **R10.5** — Unconfigured/unknown `connection` id → 404 JSON on
  metadata/start, redirect with error on ACS; no timing side channel beyond
  constant-shape responses.
- **R10.6** — SP metadata endpoint serves valid XML with entity ID, ACS, SLO
  locations and the signing cert; `node-saml`'s own client can complete a
  round-trip against it in tests.

### Provisioning & mapping

- **R10.7** — JIT provisioning: on first successful SAML login, a `User` is
  created when no user matches the (lowercased) NameID/email — mirroring the
  OIDC path's `callback:82-87`, but with `passwordHash: "sso:<random>"` and no
  auto-created personal workspace unless signup policy says so (default:
  create the user + **no workspace**; they land on `/app` with an empty-state).
  The JIT account carries `emailVerified: true` — the assertion vouched for
  the address — so a later provider sign-in may link it.
- **R10.8** — Existing-account linking: if a user with the same email exists
  (password or OIDC) **and that account proved its own address**
  (`User.emailVerified` — `true` for the accounts the OIDC callback creates,
  `false` for every local sign-up), the SAML login **signs that account in**
  (no duplicate user). An account that never verified its address is **not**
  linked: the address may have been registered by somebody else before the
  real owner showed up (B07, account pre-hijacking), so the sign-in ends in
  the `email_taken_unverified` conflict instead of taking the account over —
  a vouching provider does not authorize the link, it only vouches for the
  address it was given. If the account has 2FA enabled, SSO login bypasses
  the TOTP prompt (IdP is the factor — matches product-class behavior); this
  is an explicit, documented decision (open question O10.3).
- **R10.9** — Domain auto-join: JIT users whose email domain matches a
  **verified domain** of a workspace are added as `MEMBER` automatically
  (schema §6). Unverified domains never auto-join.
- **R10.10** — Invite precedence: if an unaccepted `Invite` row exists for the
  email, the JIT flow accepts it with its role (reusing invite semantics,
  `prisma/schema.prisma:166-182`) instead of the domain default.
- **R10.11** — Role mapping: per-connection ordered rules
  `group claim value → WorkspaceRole` (default MEMBER). Groups come from the
  `AttributeStatement` (configurable claim name; defaults:
  `groups`, `roles`,
  `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups`).
  Highest-privileged rule wins; OWNER is **never** granted by mapping (admin
  max) — ownership transfer stays a human action.
- **R10.12** — Mapping is deterministic and unit-tested as a pure function
  `mapGroupsToRole(rules, groups) → role` (red-first).

### Configuration surface

- **R10.13** — New settings section "Single sign-on" (admin-only,
  `canManageMembers`) on `src/app/w/[slug]/settings/page.tsx`: list
  connections (protocol, domains, status), add/edit dialog (entity ID, SSO
  URL / metadata URL or paste, cert, NameID format, email + group claim
  names, role-map editor, encryption on/off), "Test connection" button that
  runs a dry AuthnRequest round-trip, and a **verified domains** sub-table
  (add domain → shows the DNS TXT verification record → verify button).
- **R10.14** — Env-level defaults stay: `SSO_ISSUER`/`SSO_CLIENT_ID`/
  `SSO_CLIENT_SECRET`/`SSO_REDIRECT_URI` behave exactly as today (OIDC);
  new optional env `SAML_SP_ENTITY_ID` overrides the SP entity-ID origin
  prefix for reverse-proxy deployments.
- **R10.15** — Login page: "Sign in with SSO" appears when any connection
  exists; when the typed-in email's domain matches exactly one connection,
  SSO jumps straight to it.
- **R10.16** — Replay cache: `SamlAssertionSeen { assertionId @unique,
  expiresAt }` persisted in Postgres (not memory — survives restarts and
  future multi-instance deployments), pruned opportunistically.
- **R10.17** — Cert rotation: metadata-URL connections re-fetch metadata and
  accept the new signing cert with **zero downtime** (both old+new certs
  validated during a 24 h overlap window by caching the previous cert and
  passing both to `node-saml`'s `cert` option chain).
- **R10.18** — Failure visibility: every ACS outcome (ok / rejected +
  reason-class) writes an `Activity` row (`saml.login`,
  `saml.login_failed`); Settings shows the last 20 per connection.
- **R10.19** — Per-IdP docs shipped in the repo (`docs/integrations/okta.md`,
  `azure-ad.md`, `google-workspace.md`): step-by-step with the exact fields
  this UI exposes (Okta: SP-initiated SSO, group claim filtered by regex;
  Azure: Enterprise app, group claims optional+Graph caveats; Google:
  SAML app + "Group membership" mapping), plus the metadata-URL directions.

### Follow-on (M3, may slip)

- **R10.20** — SCIM 2.0 bearer-token endpoints
  (`/api/scim/v2/{Users,Groups}`): create/deactivate users, sync group
  membership into teamspace/role mapping; only for connections with SCIM
  enabled; token stored hashed.
- **R10.21** — Domain capture UI polish: verified-domain list becomes the
  source for "managed accounts" (JIT users display a "via Okta" badge and
  password login is disabled for those domains unless the admin allows it).

### Non-goals

- SAML as a protocol for anything besides login (no SAML for API tokens).
- Multiple simultaneous IdP failover per connection (one active connection
  per domain; per-connection only).
- SLO full back-channel (front-channel best-effort only, R10 §4.1).
- Replacing password auth globally ("SSO-enforced" toggle is O10.2, deferred).

## 6. Data model

```prisma
model SsoConnection {
  id             String   @id @default(cuid())
  workspaceId    String
  protocol       String                    // "saml" | "oidc" (oidc-from-DB: M3+)
  name           String                    // "Okta – Acme"
  // SAML specifics
  entityId       String?
  ssoUrl         String?                   // IdP SSO endpoint (parsed from metadata or manual)
  sloUrl         String?
  metadataUrl    String?                   // if set, refreshed lazily (R10.17)
  metadataXml    String?
  certificate    String?                   // signing cert (PEM); previous kept in prevCertificate
  prevCertificate String?
  wantEncrypted  Boolean  @default(false)
  privateKeyEnc  String?                   // encrypted at rest; only if wantEncrypted
  nameIdFormat   String   @default("emailAddress")
  emailAttribute String   @default("email")
  groupAttribute String   @default("groups")
  roleRules      Json                      // [{ group, role }] ordered (R10.11)
  domains        VerifiedDomain[]
  enabled        Boolean  @default(true)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  workspace      Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@index([workspaceId])
}

model VerifiedDomain {
  id           String  @id @default(cuid())
  connectionId String
  domain       String                    // lowercase, e.g. "acme.com"
  verifiedAt   DateTime?
  verifyToken  String                    // value for the DNS TXT record
  connection   SsoConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  @@unique([connectionId, domain])
}

model SamlAssertionSeen {
  id         String   @id                // the SAML Assertion ID
  expiresAt  DateTime                    // NotOnOrAfter + skew
  seenAt     DateTime @default(now())
  @@index([expiresAt])
}
```

- Secrets (encrypted private key; later SCIM tokens) follow the existing
  pattern of env-adjacent secrets but are stored per connection; encryption
  key derived from `AUTH_SECRET` (same constraint as sessions,
  `src/lib/auth.ts:10-18`). "Secret handling 🟡" in the matrix already flags
  vault-later (row 659) — consistent.
- `Workspace` gains nothing structural; verified domains hang off connections.

## 7. Test plan

**Mock IdP harness (extends the `check-sso-teamspaces.mjs` pattern)**

- New devDependency `@node-saml/node-saml-idp`; new
  `scripts/check-saml.mjs` spins it up on **:4323** (leave :4321 to the OIDC
  mock so both suites can run in one gate), configures a connection row
  directly via Prisma, then drives: start → IdP POSTs `SAMLResponse` to ACS →
  session issued → `/app` 200 → JIT user exists → cleanup (mirroring
  `check-sso-teamspaces.mjs:96-120,156-159`).
- **Negative legs in the same script**: tampered XML (`:2`-byte patch in the
  signed region) must land on `/login?error=sso` with **no** cookie; replayed
  response must fail the second time (R10.2, R10.4).

**Unit (vitest, red-first)**

1. `mapGroupsToRole` matrix incl. OWNER-max rule (R10.11, R10.12).
2. Metadata parsing: URL-fetch result and pasted XML both produce the same
   normalized connection fields; malformed XML fails with a typed error
   (R10.13).
3. Assertion-ID cache prune logic (R10.16).
4. RelayState validation (same-site relative only — reuse the login page's
   open-redirect guard, `src/server/actions/auth.ts:135-137`).

**Integration / e2e**

5. `check:saml` script as above (full flow + negatives), wired as
   `npm run check:saml` and included in the gate the same way `check:sso` is.
6. Existing `npm run check:sso` (OIDC mock) stays green after the abstraction
   refactor — the regression net for R10's provider layering.
7. Playwright e2e: settings → SSO section renders for admin, hidden for
   member (a11y-checked, i18n via `t()` without raising the ratchet).

**Fail-closed rule**: every negative test asserts *both* "no session cookie"
and "user-visible error redirect"; a PR that logs users in on any
validation failure fails review even if tests were adjusted.

## 8. Delivery plan (milestones → tasks ↔ requirements)

**M1 — SP + ACS + JIT login (~3-4 days)**

- T10.1 [R10.1,R10.5]: add `@node-saml/node-saml`; SsoConnection/SamlAssertionSeen
  schema + `prisma db push` under the build serialization; SAML strategy wiring with
  fail-closed defaults. Red: unit 2 skeleton + tampered-XML integration leg.
- T10.2 [R10.2,R10.3,R10.4,R10.16]: full validation config + replay cache.
  Red: negative legs in `check-saml.mjs`.
- T10.3 [R10.6,R10.14]: metadata + start + ACS + SLO endpoints; env SP override.
  Red: metadata round-trip test.
- T10.4 [R10.7,R10.8,R10.9,R10.10]: provisioning pipeline shared with OIDC
  (provider abstraction refactor — OIDC suite must stay green). Red: unit +
  mock-IdP flow.

**M2 — Settings UI + docs (~2-3 days)**

- T10.5 [R10.11,R10.12]: role-map editor model + pure mapper. Red: unit 1.
- T10.6 [R10.13,R10.15]: SSO settings section + login-page chooser. Red:
  e2e 7.
- T10.7 [R10.17,R10.18]: cert rotation overlap + activity feed. Red:
  rotation integration leg (mock IdP rotates its key mid-suite).
- T10.8 [R10.19]: Okta / Azure AD / Google Workspace docs +
  README pointer.

**M3 — SCIM + domain capture (~4-6 days, may slip)**

- T10.9 [R10.20]: SCIM 2.0 Users/Groups endpoints + bearer token + tests.
- T10.10 [R10.21]: verified-domain UX + managed-account policies.

## 9. Risks & open questions (honest)

**Risks**

1. **XML/SAML ecosystem sharp edges** (highest, but contained): signature
   wrapping attacks, IdP quirks (Azure's optional group claims, Google's
   metadata churn). Contained by the iron law — `node-saml` is maintained and
   battle-tested; we only configure it. Mitigation: per-IdP docs tested
   against the mock plus one real Okta dev org before calling M2 done.
2. **JIT account linking abuse**: an IdP that lets unverified emails through
   could take over password accounts by email match (R10.8). Mitigation: the
   link rule keys on the **account's own proof** (`User.emailVerified`), not
   on how trustworthy the provider is — an account that never verified its
   address (every local sign-up) is never linked by an SSO sign-in, whatever
   the assertion says (B07). On top of that: only trust the email when the
   assertion is signed (always) **and** the connection's `emailAttribute` is
   explicitly configured; document that IdPs must mark email `email_verified`;
   O10.1 considers requiring NameID-format-email only.
3. **Secret storage**: private keys and (later) SCIM tokens in DB encrypted
   with an `AUTH_SECRET`-derived key is better than nothing but not a vault;
   consistent with matrix row 659, but enterprise reviewers will ask. Be
   honest in docs.
4. **Gate/CI load**: the SAML suite needs a port (:4323) + server restart
   under the build serialization — same class of
   friction the OIDC check already has; keep the suite < 30 s.

**Open questions**

- O10.1: Should SAML-only domains disable password login for those emails?
  (Product-class: yes, configurable.) Deferred to R10.21 policy.
- O10.2: "Enforce SSO for all members" workspace toggle — where does it sit
  with password users who are already members? Spec'd as M3+.
- O10.3: 2FA bypass on SSO login (R10.8) — confirm with a real Okta
  conditional-access story before shipping; may need per-connection
  "require IdP MFA" flag surfaced from `AuthnContextClassRef`.
- O10.4: Per-workspace OIDC connections (DB-stacked with SAML) — the
  abstraction (§3) makes it cheap, but scope control says: not before SAML
  M2 ships.
