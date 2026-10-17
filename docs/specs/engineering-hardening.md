# Spec — Engineering parity hardening (ids, transactions, sessions, secrets, packaging)

> **Status: spec complete, implementation pending.** Document-only: no
> production code was changed. This document is the deliverable. Every claim about the current code cites `file:line`.
> Requirement IDs (`R28.x`) are the traceability anchors: §9 lists tasks 1:1
> against them and tests must cite the IDs they cover. Gate tier for this change
> is FAST (tsc + eslint + targeted unit + coherence — no build, no e2e, no
> matrix count regeneration).

---

## 1. Problem statement

Section 17 of `docs/FEATURE_MATRIX.md` ("Data model & platform") holds nine
🟡/🧭 rows that describe *engineering hygiene* rather than user features:
stable block ids, transactions/atomic writes, session management, secret
handling, self-hosting, Docker images, Docker Compose, reverse-proxy guidance
and schema-migration discipline. None of them is a greenfield build — each has
a partial implementation or a documented plan, and the gaps are the classic
class of defect that only shows up in production: a signup that half-commits, a
stolen cookie that can never be invalidated, a DB dump that reads like plain
text, a compose file that starts a database but no app.

This spec audits what is actually there (§2), fixes five decisions (§3), and
emits testable requirements `R28.1`–`R28.26` (§4) with a data model (§5),
edge behavior (§6), test plan (§7), migration notes (§8) and delivery plan
(§9).

## 2. Current state audit (evidence)

### 2.1 Stable block ids — column exists, producer does not

| Aspect | Evidence | State |
| --- | --- | --- |
| Block nodes carry no `id` | Every `addAttributes()` in `src/components/editor/extensions/*` registers domain attributes only (`block-colors.ts:43-55` `blockColor`, `image-block.tsx:25-44`, `custom-blocks.tsx:61,142`, `bookmark.tsx:30,165`, `page-embed.tsx:40`); the **only** node `id` attribute in the editor is `mention.ts:17` (`id: { default: null }`) — and it points at a page/user, not a block | Missing |
| No id minting anywhere | `randomUUID` / `nanoid` / `crypto.randomUUID` appear **nowhere in `src/`** — the only hits are `scripts/check-sso-teamspaces.mjs:8,46` (test fixture) | Missing |
| The column waiting for ids | `Comment.blockId String?` (`prisma/schema.prisma:336`); zod `blockId: z.string().max(200).optional()` (`src/lib/validation.ts:65`); action writes it (`src/server/actions/comments.ts:18,26,47`); `docs/ARCHITECTURE.md:44` calls it "for future inline anchoring" | Exists, unpopulated |
| The producer | The comment composer is dispatched with **`quote` only**: `bubble-toolbar.tsx:274-276` and `block-context-menu.tsx:347-348` send `COMMENT_EVENT { quote }`; `comment-panel.tsx:67-68,83-87` reads/sends `quote` — no file in `src/**/*.tsx` even mentions `blockId` | Missing |
| What anchors look like instead | Positional: `snapshotBlockDeletion` captures child-index paths (`src/lib/blocks.ts:176-205`) and `restoreBlockDeletion` clamps stale indices on restore (`blocks.ts:213-236`) — correct as an undo affordance, but an index path is not identity | Positional only |
| Enforced today | Only at *reference* level: mentions mint/collect node ids (`mention-menu.tsx:89`, `src/lib/mentions.ts:29-30`) | Partial |

**Audit verdict:** matrix row 634 ("Ids exist; not enforced on all operations")
is optimistic. Durable ids exist for *entities* (cuid on `Page`, `Comment.id`)
and for *cross-references* (mention `attrs.id`), but **document blocks have no
identity at all** — `Comment.blockId` is a schema-shaped hole with no writer.

### 2.2 Transactions — 2 uses in 138 actions

Scan of `src/server/actions/**` (every `export async function …`, every
`await prisma.<model>.<write>`):

| Metric | Value |
| --- | --- |
| Exported server actions | **138** |
| Actions with ≥2 Prisma writes and **no** `$transaction` | **32** |
| `$transaction` sites in all of `src/` | **2** |

The two good citizens:

- `src/server/actions/workspaces.ts:265-272` — ownership transfer wraps
  `workspace.update` + two `workspaceMember.update*` calls, with the comment at
  `:263-264`: *"The transaction runs first: the activity log records what
  actually happened, never an attempt that failed halfway."*
- `src/server/actions/database.ts:166-173` — property reorder as a batch of
  `property.update` calls.

Highest-risk ad-hoc multi-writes (writes → lines):

| Action | Writes | Lines |
| --- | --- | --- |
| `createPageAction` (`pages.ts:46`) | 9 | `page.create@71`, `property.create@104,:113,:128,:136`, `databaseView.createMany@145`, `page.create@165`, `propertyValue.create@182,:189` |
| `importTrelloAction` (`import.ts:70`) | 6 | `page.create@100,:153`, `property.create@113,:127`, `databaseView.createMany@136`, `propertyValue.createMany@168` |
| `createGalleryTemplateAction` (`home-templates.ts:36`) | 5 | `page.create@55,:112`, `property.create@72`, `databaseView.createMany@108`, `propertyValue.createMany@137` |
| `signupAction` (`auth.ts:20`) | 3 | `user.create@39`, `workspace.create@43`, `page.create@52` |
| `addCommentAction` (`comments.ts:14`) | 3 | `comment.create@43`, `notification.create@61`, `notification.createMany@85` |
| `acceptWorkspaceInviteAction` (`email.ts:492`) | 3 | `workspaceMember.upsert@500`, `projectMember.upsert@507`, `invite.update@513` |
| `acceptTeamspaceInviteAction` (`teamspace-invites.ts:230`) | 3 | `workspaceMember.upsert@239`, `teamspaceMember.upsert@246`, `teamspaceInvite.update@251` |
| `updatePageAction` (`pages.ts:200`) | 2 | `pageVersion.create@237` **then** `page.update@253` |
| `restorePageVersionAction` (`page-versions.ts:16`) | 2 | `pageVersion.create@36` **then** `page.update@48` |
| `createRowAction` (`database.ts:223`) | 2 | `page.create@236`, `propertyValue.create@253` |

Failure modes implied by the table: a failed `workspace.create` after
`user.create` leaves an account nobody can log into (`auth.ts:39-50`); a failed
`page.update` at `pages.ts:253` leaves a `PageVersion` snapshot claiming an
edit that never landed; a failed `invite.update` after the membership upserts
leaves an invite that can be accepted twice (`email.ts:367-380`). The whole
list of 32 is in §4.2 / the R28.11 regression guard.

### 2.3 Sessions — there is no session model

| Aspect | Evidence | State |
| --- | --- | --- |
| Session storage | **No `Session` model.** `prisma/schema.prisma` defines 45 models (`User:78` … `WebhookDelivery:909`) and none stores sessions. Sessions are a **stateless HS256 JWT** in the `noema_session` cookie: name + 30-day TTL (`src/lib/auth.ts:14-15`), issue (`createSession`, `:47-76`), verify (`getSessionUserId`, `:98-119`), delete (`destroySession`, `:82-96`) | Stateless |
| Matrix claim | Row 652 says *"Sessions stored; revocation partial"* — the audit correction is stronger: **nothing is stored, so nothing can be revoked server-side** except by rotating `AUTH_SECRET` (which invalidates *everything* and breaks envelopes, §2.4) | Gap |
| Logout | `logoutAction` (`src/server/actions/auth.ts:141-144`) → `destroySession()` deletes **this device's cookie only**; the JWT stays valid until expiry (`src/lib/auth.ts:62-66`) | Per-device only |
| Logout-all | No `logoutAll`, no session list, no `sessionVersion`-style counter anywhere (`logout|revoke` grep across `src/` hits only API tokens, invites and share links) | **Missing** |
| Password change | No change-password flow exists at all (`passwordHash` written only at signup `auth.ts:40`, SSO JIT `src/app/api/auth/sso/callback/route.ts:85`, share-link passwords `share.ts:76`) — so the classic "revoke on credential change" hook has nothing to attach to yet | Missing |
| 2FA | `two-factor.ts:27,60,86` stores/clears `twoFactorSecret` (sealed since B05); disabling 2FA does **not** revoke existing sessions | Partial |
| Contrast: API tokens *are* revocable | `revokeApiTokenAction` (`tokens.ts:23`) + `ApiToken.tokenHash` (`schema.prisma:459`) | Good pattern |
| Test coverage | `src/lib/auth.test.ts:10-36` covers bcrypt helpers only; no JWT/session tests; no logout e2e (e2e greps return login-only flows) | Missing |

### 2.4 Secret handling — env first, envelope second, vault nowhere

**What exists and works:**

- **Env-only process secrets**: `.env.example:4-50` documents `DATABASE_URL`,
  `AUTH_SECRET`, `AI_*`, `AI_TRANSCRIBE_*`, `SSO_CLIENT_SECRET`, `SMTP_PASSWORD`,
  `CRON_SECRET`; README's env matrix repeats it (`README.md:299-308`).
  Fail-fast: `secretKey()` throws when `AUTH_SECRET` is missing/<16 chars
  (`src/lib/auth.ts:10-18`); the envelope key derivation throws the same way
  (`src/lib/secrets.ts:12-19`).
- **Envelope encryption** (`src/lib/secrets.ts:1-43`): AES-256-GCM,
  `v1:iv:tag:payload` versioned format (`:21-27`), key =
  `sha256("noema:ai-provider:v1:" + AUTH_SECRET)` (`:12-19`), decrypt `:29-43`,
  mask `:376-381`, `hashToken` `:383-385`, `randomToken` `:387-389`. The
  two-factor seed joins them: `encryptTwoFactorSecret` `:72-74` /
  `openTwoFactorSecret` `:82-95`.
- **One key for every domain (B05 — a deliberate design property, not an
  oversight):** the envelope key is derived from `AUTH_SECRET` alone, so the
  TOTP seed, the AI provider keys and the SMTP password share **one** key.
  An attacker who learns the key therefore opens **all three** at once — the
  seed of every account, every provider key and the mail password. The
  hardening plan asks for a per-domain derivation (R28.17, §2.4); giving the
  2FA seed its own key is a migration of its own and is deliberately not part
  of B05. Until then, `AUTH_SECRET` is the single secret that protects all
  three, and it must be treated as such (rotation invalidates every envelope
  at once).
- **Enforced for the two biggest stored secrets**: AI provider key
  (`ai-settings.ts:122` encrypt → `ai-provider.ts:58` decrypt, mask at
  `ai-settings.ts:78`) and SMTP password (`email.ts:141` → `mailer.ts:52`,
  `hasPassword` at `email.ts:96`) — and since B05 for the two-factor seed
  (`two-factor.ts:20,53` seal, `:43,77` open).
- **Tokens hashed at rest**: `Invite.token` stores `hashToken(...)`
  (`email.ts:285` issue, `:349` lookup), `TeamspaceInvite.tokenHash`
  (`teamspace-invites.ts:103,109,157`), `ApiToken.tokenHash`
  (`schema.prisma:459`).
- **OAuth secrets hashed at rest**: `OAuthApp.clientSecretHash` and
  `OAuthCode.codeHash` store the SHA-256 digest; the plaintext client secret
  is shown once at creation (`oauth-apps.ts:35-47`), the plaintext
  authorization code only travels in the redirect
  (`oauth/authorize/complete/route.ts:39-52`). The token endpoint compares
  the digest in constant time and looks the code up by its digest
  (`oauth/token/route.ts:25-36`).

**What is not:**

| Secret | Where | State |
| --- | --- | --- |
| `User.twoFactorSecret` | `schema.prisma:89`, written sealed `two-factor.ts:27,60` (`encryptTwoFactorSecret`), read through `openTwoFactorSecret` | **Envelope** (B05) — `v1:iv:tag:payload`, shared envelope key (one key for the seed, the provider keys and the SMTP password — §2.4); rows that are still plaintext are re-sealed on the next sign-in/re-enrolment or by `npm run backfill:2fa` |
| `OAuthApp.clientSecretHash` | `schema.prisma:872`, `randomToken(24)` written hashed `oauth-apps.ts:33` (`hashOAuthSecret`, returned once, stored as a digest) | **Digest** (B06) — SHA-256 hex, compared in constant time at the token endpoint; the plaintext is handed out once at creation and never stored |
| `Webhook.secret` | `schema.prisma:899` | Plaintext |
| `ShareLink.token` | `schema.prisma:396`, raw `share.ts:101` (a DB dump exposes every share URL) | Plaintext (hashed like `Invite` would fix it) |
| Vault integration | grep for `vault|KMS|sealed-secret` across code: **zero hits** (only matrix/docs prose, `docs/specs/saml-sso.md:274,360` — *"…an `AUTH_SECRET`-derived key … is better than nothing but not a vault"*) | Not started |

Convention drift worth fixing: `Invite.token` **holds a hash** despite the
column name (`email.ts:285`), while `TeamspaceInvite`/`ApiToken` use honest
`tokenHash` columns (`schema.prisma:459,530`).

### 2.5 Packaging & self-hosting — compose runs the database only

| Aspect | Evidence | State |
| --- | --- | --- |
| Compose | `docker-compose.yml:1-21` defines exactly **one service** (`db`, `postgres:16-alpine`, port 5433, healthcheck `:14-18`, volume `:20-21`). No app service, no network wiring, no env_file | DB only |
| App image | Glob for `Dockerfile*`, `.dockerignore`, `render.yaml`, `fly.toml`, `vercel.json`, `Procfile`, `.github/**` → **no files**. No CI either | Missing |
| Standalone output | `next.config.ts:41-50` sets `outputFileTracingRoot` (the comment at `:42-44` even says *"how the standalone output is assembled"*) but the **`output: "standalone"` key is absent** | Half-done |
| Health endpoint | Route inventory under `src/app/api/` = `ai, auth, calendar, chat, cron, export, files, import, invites, link-preview, templates, tickets, upload, v1` — no `health` | Missing |
| Documented install | `README.md:275-297` — Node + npm + Docker-for-DB local quick start; `npm run dev` (`:296`); **`npm run db:push` (`:291`)** for schema | Dev-host only |
| Migrations | One real migration exists (`prisma/migrations/20260113000000_init/migration.sql`), yet the documented prod path is `db push` — schema drift between `push` and `migrate deploy` is undocumented | Ambiguous |
| Reverse proxy | Only hook: `APP_ORIGINS` allow-list for Server-Action origins (`next.config.ts:34-37`, comment `:15-16` *"for a reverse proxy or tunnel"*); no nginx/Caddy doc anywhere in `docs/` (grep hits only matrix rows 658/663 and `saml-sso.md:184`) | Missing |
| Backups (for contrast) | `scripts/backup.mjs`, documented `README.md:124,132` — matrix row 646 is legitimately ✅ | Done |

### 2.6 Defect summary

- **D28.1** — Blocks have no identity; `Comment.blockId` has no producer
  (§2.1), so inline-comment anchoring (matrix row 358) stores a quote with no
  durable key.
- **D28.2** — 32 of 138 server actions can half-commit (§2.2); signup,
  page-create, invite-accept and version-snapshot pairs are the worst.
- **D28.3** — Sessions cannot be revoked server-side; no logout-all; a leaked
  cookie is valid for 30 days regardless of what the operator does
  (§2.3).
- **D28.4** — Three secret classes sit plaintext in Postgres while three use
  the envelope (the TOTP seed was sealed in B05); no vault seam, no rotation
  story (§2.4).
- **D28.5** — `docker compose up` starts a database and nothing else; no app
  image, no health endpoint, no reverse-proxy guidance, and the documented
  schema path for prod is `db push` (§2.5).

## 3. Decisions

| # | Decision | Options considered | Verdict |
| --- | --- | --- | --- |
| **DEC28.1** | **Block identity = `id` attribute on every block node, minted at edit time and back-filled on load** | (a) status quo positional paths (`blocks.ts:176-236`); (b) external anchor table keyed by child path; (c) re-mint ids on every save | **(a+) attr + idempotent `ensureBlockIds` on load.** Attributes survive copy/move/export, need no schema, and repair legacy docs lazily. Positional paths break under concurrent edit (the very thing §17's CRDT rows plan for). |
| **DEC28.2** | **Keep sessions stateless; add a revocation counter (`User.sessionVersion`)** | (a) status quo (irrevocable JWT); (b) `Session` table (device list, per-session revoke); (c) short-lived access + refresh tokens | **(b) deferred, (a) upgraded now:** `sessionVersion` claim gives logout-all with a ~10-line diff and no schema surface beyond one column. A real `Session` table (device management UI) is an open question (O28.2), not a prerequisite. |
| **DEC28.3** | **Per-action `$transaction`, inventory-driven, regression-guarded** | (a) status quo; (b) wrap every action incl. single writes; (c) unit-of-work middleware around all actions | **(a) → per-action.** (b) buys nothing for single-write actions; (c) fights Next.js server-action boundaries. The guard test (R28.11) keeps the 32-item inventory shrinking — same ratchet style as `scripts/check-coherence.mjs:13-27`. |
| **DEC28.4** | **Env for process secrets, `secrets.ts` envelope for stored secrets, a `SecretProvider` seam for vaults later** | (a) status quo; (b) adopt HashiCorp Vault/KMS now; (c) move everything to env | **(a) extended + seam.** No ops story exists for a vault in a local-first self-hosted product (matrix row 659 already says "vault planned"); (c) is impossible for per-workspace secrets stored in the DB. The seam makes the future swap non-invasive and blocks new direct `decryptSecret` call sites. |
| **DEC28.5** | **`output: "standalone"` + multi-stage Dockerfile + compose `app` service** | (a) status quo (host npm); (b) standalone image + compose; (c) Kubernetes/Helm | **(b).** (a) cannot be a "one-command stack" (row 662); (c) is out of scope for a single-node self-host target. DB service stays byte-identical so `npm run backup` and the dev loop are untouched. |

## 4. Requirements (numbered, testable, with acceptance)

### 4.1 Stable block identity — R28.1–R28.5

- **R28.1** — Every block-level node (the set the block menu targets:
  `p, h1-h6, pre, blockquote, li, [data-callout], .noema-toggle`,
  `block-context-menu.tsx:58`) carries a non-empty, doc-unique `id` attribute
  in stored `Page.content`, minted by one shared editor extension registered in
  the default extension set (`page-editor.tsx`), format `b_` + 12 base64url
  chars from `crypto.getRandomValues`.
  *Acceptance:* unit (red-first, `src/lib/blocks.test.ts`) — a freshly saved
  doc's block nodes all have ids; ids are unique across the doc; minting uses
  no `Math.random`.
- **R28.2** — Normalization is lazy and idempotent:
  `ensureBlockIds(doc: BlockDoc): { doc: BlockDoc; changed: boolean }` added to
  `src/lib/blocks.ts` runs on editor load (and for docs seeded by
  `createPageAction`), assigning ids **only** to missing/duplicate slots and
  never rewriting an existing one; `changed` gates whether the next save
  persists them.
  *Acceptance:* unit — applying twice yields identical JSON; a fully-identified
  doc passes through byte-for-byte with `changed: false`.
- **R28.3** — Comment anchoring becomes id-based: `COMMENT_EVENT` detail gains
  `blockId` (`bubble-toolbar.tsx:274-276`, `block-context-menu.tsx:347-348`),
  `comment-panel.tsx` forwards it to `addCommentAction` — the receiving column
  (`schema.prisma:336`), validator (`validation.ts:65`) and action
  (`comments.ts:18,26,47`) already accept it. `quote` remains for display;
  `blockId` is the key.
  *Acceptance:* e2e — a comment on paragraph P keeps resolving to P after two
  paragraphs are inserted above it; `blockId` is non-null for every comment
  created afterwards.
- **R28.4** — Copies get fresh identity: duplicating a block, instantiating a
  template or re-pasting content re-mints ids for the copy; a doc never
  contains two nodes with the same id (paste re-mints colliding ids).
  *Acceptance:* unit — duplicate-then-inspect produces disjoint id sets;
  property-style test: random structural edits keep ids unique.
- **R28.5** — Legacy tolerance: readers of `blockId` (comment anchor
  resolution) fall back to quote-text matching when the id is absent or
  unresolvable. A doc without ids is never invalid, never errors, and never
  blocks rendering (`doc-renderer.tsx` path unchanged).
  *Acceptance:* unit — anchor resolution on an id-less doc returns the
  quote-based fallback without throwing.

### 4.2 Atomic writes — R28.6–R28.11

- **R28.6** — Every exported action in `src/server/actions/**` performing ≥2
  Prisma writes runs them in one `prisma.$transaction` (batch array where the
  write list is static, interactive callback where it is computed). Baseline
  inventory: **32 of 138** (§2.2 table). Priority order: `signupAction`,
  `createPageAction`, `importTrelloAction`, `createGalleryTemplateAction`,
  `createQuickStartAction`, `acceptWorkspaceInviteAction`,
  `acceptTeamspaceInviteAction`, `updatePageAction`,
  `restorePageVersionAction`, `createRowAction`, `addCommentAction`.
  *Acceptance:* the R28.11 guard reports zero non-allow-listed multi-write
  actions; each converted action has a rollback test citing `R28.7`.
- **R28.7** — Rollback semantics: if any write inside the transaction throws,
  **no** write from that action is visible afterwards (including the first
  one).
  *Acceptance:* integration test per priority action — force the final write
  to fail (bad FK/unique violation), read back, assert the earlier writes are
  absent.
- **R28.8** — Snapshot/mutate pairs are atomic: the `PageVersion` snapshot and
  its `Page` update commit together in `updatePageAction` (`pages.ts:237` →
  `:253`) and `restorePageVersionAction` (`page-versions.ts:36` → `:48`).
  History never records an edit that failed; an edit never lands without its
  snapshot.
  *Acceptance:* integration — kill the second write ⇒ neither row exists;
  happy path ⇒ both exist with matching `charDelta`/timestamps.
- **R28.9** — Side effects stay **outside** the transaction: `logActivity`
  after commit (the pattern already documented at `workspaces.ts:263-264`),
  webhook dispatch after commit (`pages.ts:277`), `revalidatePath` last. No
  HTTP call, mail send or webhook inside `$transaction`.
  *Acceptance:* unit — a rejected transaction never reaches
  `dispatchWebhooks`/`logActivity`; code-review checklist item in §9.
- **R28.10** — Shape discipline: authorization reads (`requireUser`,
  `authorizePage`, `canEditContent`, …) happen *before* the transaction opens;
  transactions contain writes only, so a skipped authorization check can never
  hide inside a callback.
  *Acceptance:* static test — no `authorize*`/`requireUser` call lexically
  inside a `$transaction(` callback in `src/server/actions/**`.
- **R28.11** — Regression guard (ratchet): a vitest re-runs this audit's
  algorithm — ≥2 `prisma.<model>.(create|update|delete|upsert|createMany|updateMany|deleteMany)`
  inside one exported action with no `$transaction` — and fails unless the
  finding is in a committed allow-list that may only shrink (mirrors
  `scripts/check-coherence.mjs:13-27`).
  *Acceptance:* introducing a new multi-write action turns `npm test` red;
  allow-list starts at 32 and decreases monotonically.

### 4.3 Sessions & revocation — R28.12–R28.16

- **R28.12** — Server-side revocation: `User.sessionVersion Int @default(0)`;
  `createSession` embeds `ver` in the JWT payload (`src/lib/auth.ts:33-37`);
  `getSessionUserId` (`:54-63`) rejects tokens whose `ver` differs from the
  column **or is absent** (⇒ old-format tokens die at deploy — see M28.2).
  No `Session` table (DEC28.2).
  *Acceptance:* unit — token minted at v0 verifies; after
  `sessionVersion: 1` the same token fails and `getSessionUserId` returns
  `null`.
- **R28.13** — **Sign out everywhere**: new `logoutAllAction` bumps
  `sessionVersion` and clears the calling cookie; surfaced in account settings
  (all new strings through `t()` — no i18n-ratchet raise). The same bump runs
  on 2FA disable (`two-factor.ts:57`) and on any future password change.
  *Acceptance:* e2e — contexts A and B logged in as the same user; A signs out
  everywhere ⇒ B's next navigation lands on `/login`.
- **R28.14** — Per-device logout stays exactly as it is: `logoutAction`
  (`auth.ts:141-144`) deletes this cookie, is idempotent for anonymous
  callers, and keeps the `/login` redirect.
  *Acceptance:* unit/e2e — calling logout twice throws neither error nor
  redirect loop; cookie absent afterwards.
- **R28.15** — Cookie attributes unchanged and documented: `httpOnly`,
  `sameSite: "lax"`, `path: "/"`, `secure` in production, 30-day `maxAge`
  (`src/lib/auth.ts:69-75`); the self-host doc (R28.26) states that `secure`
  requires TLS termination in production.
  *Acceptance:* unit — `createSession` options snapshot asserted flag-by-flag.
- **R28.16** — Single issuer, tested: password login (`auth.ts:122`), signup
  (`auth.ts:62`) and the SSO callback
  (`src/app/api/auth/sso/callback/route.ts`) all go through `createSession`;
  `src/lib/auth.test.ts` (today bcrypt-only, `:10-36`) gains issue / verify /
  expiry / version-mismatch tests.
  *Acceptance:* `npm test` covers all four JWT cases; no second code path
  writes the `noema_session` cookie.

### 4.4 Secret handling — R28.17–R28.21

- **R28.17** — Stored secrets get the envelope: `User.twoFactorSecret`
  (`schema.prisma:89`) and `Webhook.secret` (`schema.prisma:899`) are
  written via `encryptSecret` (`src/lib/secrets.ts:21-27`) and read via
  `decryptSecret`. Key derivation becomes per-domain —
  `noema:<domain>:v1:<AUTH_SECRET>` generalizing the existing
  `noema:ai-provider:v1` salt (`secrets.ts:18`) — so rotating one domain's
  scheme cannot disturb another. (`OAuthApp.clientSecret` is not part of it:
  the OAuth client secret is a **digest** (`clientSecretHash`), so there is
  nothing to encrypt.)
  *Acceptance:* unit — envelope round-trip for each of the two domains; a
  pre-migration plaintext value is accepted with a warning during the M28.3
  window and rejected after it.
  > **Status — `User.twoFactorSecret` landed (B05).** The TOTP seed is
  > written with `encryptTwoFactorSecret` and read with `openTwoFactorSecret`
  > (`src/lib/secrets.ts`): an envelope that cannot be opened (tampered
  > ciphertext, rotated `AUTH_SECRET`) fails closed, and a pre-B05 plaintext
  > seed still works but is re-sealed on the next successful write. The
  > one-off backfill of the remaining plaintext rows is
  > `npm run backfill:2fa` (a script, not a migration — see M28.3).
  > `OAuthApp.clientSecret` and `Webhook.secret` are **still plaintext**.
  > **Data protection (Art. 15/17):** the seed was never part of a subject
  > access export — `PERSONAL_DATA_FIELDS.user.twoFactorSecret` is
  > `exportable: false` (`src/lib/gdpr.ts:122`), so the export bundle never
  > carried the seed and still does not. What the column holds changed: it
  > is the `v1:iv:tag:payload` envelope, not the base32 seed, so the value
  > the erasure plan deletes (`strategy: "delete"`) is a sealed envelope.
- **R28.18** — Lookup tokens are hashed at rest: `ShareLink.token`
  (`schema.prisma:396`, raw at `share.ts:101`) stores `hashToken(raw)` exactly
  as `Invite.token` does (`email.ts:285,349`); column naming is normalized to
  `tokenHash` for new columns (existing `Invite.token` keeps its name but its
  hashed content — documented).
  *Acceptance:* integration — create a link ⇒ stored value ≠ raw token;
  `/s/<raw>` still resolves (M28.4); `/s/<stored>` does not.
- **R28.19** — No secret round-trips to a client: masked/status-only responses
  are the rule (`ai-settings.ts:78` `maskSecret`, `email.ts:96` `hasPassword`,
  `share.ts:55` `hasPassword`); no action may return `*Encrypted`,
  `passwordHash`, `twoFactorSecret`, `clientSecret` or an unmasked token.
  The one exception is the OAuth client secret: it is handed back **once**,
  in the response of `createOAuthAppAction` — the app has to be able to
  copy it, and only its digest is ever stored.
  *Acceptance:* unit — a response-shape scan over every exported action's
  declared return type/value fixture fails on a seeded violation.
- **R28.20** — Process secrets stay env-only with fail-fast validation:
  `DATABASE_URL`, `AUTH_SECRET`, `SSO_CLIENT_SECRET`, `SMTP_PASSWORD`, `AI_*`,
  `CRON_SECRET` (`.env.example:4-50`), keeping the existing throws
  (`auth.ts:10-18`, `secrets.ts:12-19`), plus a new
  `scripts/check-env.mjs` that reports **every** missing/short required key in
  one pass before `next start`.
  *Acceptance:* `node scripts/check-env.mjs` on a clean env exits non-zero and
  lists all missing keys; on the documented `.env` it exits 0.
- **R28.21** — Vault seam, not a vault (DEC28.4): a `SecretProvider`
  (`get(domain,key)` / `put(domain,key,value)`) becomes the only supported
  read/write path for stored secrets; `SECRET_BACKEND=envelope` is the default
  implementation, `SECRET_BACKEND=env` a supported variant for fixed
  deployments. External vault/KMS adapters are future work (O28.3).
  *Acceptance:* unit — both backends exercised through the interface; a
  lint-style test asserts `decryptSecret`/`encryptSecret` are imported only by
  the provider module and its tests.

### 4.5 Packaging & self-hosting — R28.22–R28.26

- **R28.22** — App image: multi-stage `Dockerfile` (deps → `next build` →
  minimal runtime, non-root user) with `output: "standalone"` added to
  `next.config.ts` (tracing root already pinned at `:42-44`, key missing), plus
  `.dockerignore` excluding `.next`, `node_modules`, `backups`, `e2e`,
  `scripts/_logs`.
  *Acceptance:* `docker build` succeeds; `docker run -e …` serves the login
  page with no source mount and no `node_modules` in the final layer.
- **R28.23** — Compose becomes one-command stack: add an `app` service
  (`build: .`, `env_file: .env`, port 3000, `depends_on` db healthy,
  healthcheck per R28.24) to `docker-compose.yml`; the existing `db` service
  (`docker-compose.yml:1-21`) stays byte-identical so `noema-db`, the dev loop
  and `npm run backup` (README:132) keep working.
  *Acceptance:* `docker compose up --build` yields a reachable login page and
  a healthy `db`; `docker compose down` preserves the `noema-db-data` volume;
  `npm run backup` still dumps through the container.
- **R28.24** — Health endpoint: `GET /api/health` →
  `{ ok: boolean, db: "up"|"down", version: string }`, performing `SELECT 1`
  and returning **503** when the DB is unreachable; consumed by the compose
  healthcheck. (No such route exists today — §2.5 inventory.)
  *Acceptance:* unit for the status mapping; integration asserts 200 with the
  DB up and 503 with it stopped.
- **R28.25** — Production migration path: documented prod flow becomes
  `prisma migrate deploy` (a baseline migration reconciling today's schema),
  run by the compose entrypoint before the app starts; local dev keeps
  `npm run db:push`. This replaces the current README quick-start step
  (`README.md:291`) for deployments while leaving it valid for dev.
  *Acceptance:* fresh clone → `docker compose up --build` creates the full
  schema with zero manual prisma commands; a second boot is a no-op;
  `npm run db:push` still works for the dev loop.
- **R28.26** — Self-host documentation: `docs/SELF_HOSTING.md` with nginx/Caddy
  snippets (TLS termination, `APP_ORIGINS` for the Server-Action origin
  allow-list `next.config.ts:34-37`, WebSocket upgrade for the collab port,
  upload body-size limits), the env matrix, backup/restore
  (`scripts/backup.mjs`, README:124-132), AUTH_SECRET rotation implications
  (it invalidates sessions **and** envelopes), and the demo-credential caveat
  (README:328-334). README links it from Quick start.
  *Acceptance:* a fresh-operator checklist of ≤10 steps is walked once against
  the compose stack and checked off in the PR description.

### Non-goals (this spec)

- Implementing HashiCorp Vault / cloud KMS adapters (O28.3), Kubernetes
  manifests, CI setup (no CI exists — out of scope), rate limiting /
  middleware (matrix row 643, separate change), audit-log completion (row 640),
  per-session device management UI (O28.2), changing bcrypt cost or the JWT
  algorithm, encrypting the DB at rest (rows 657-658 are infra concerns).

## 5. Data model

```prisma
// prisma/schema.prisma — the only schema change required by this spec:
model User {
  // …existing fields (schema.prisma:78-114)…
  sessionVersion Int @default(0)   // R28.12: bumped by logout-all / 2FA disable
}

// No Session table (DEC28.2). No new tables for block ids (they live in the
// JSON document, R28.1). Existing columns whose *values* change meaning:
//   Comment.blockId        schema.prisma:336  — now populated (R28.3)
//   ShareLink.token        schema.prisma:396  — stores hashToken(raw) (R28.18)
//   User.twoFactorSecret   schema.prisma:89   — a v1 envelope (R28.17, landed in B05)
//   OAuthApp.clientSecret  schema.prisma:872  — becomes a v1 envelope (R28.17, landed in B06)
//   Webhook.secret         schema.prisma:899  — becomes a v1 envelope (R28.17)
```

Prisma change = one column (`db push` locally, baseline migration for prod per
R28.25). Everything else is behavior, not schema.

**Later addition (B07, the security campaign):** the same `User` model also
carries `emailVerified Boolean @default(false)` — whether the address was
ever proven. A local sign-up writes `false` (a sign-up proves nothing about
the address it registers), the SSO callback writes `true` for the account it
creates (the address came out of a signed id_token), and a provider sign-in
links an existing account only when **that account** proved its own address
— a vouching provider alone does not authorize the link, because the address
may have been pre-registered by somebody else (account pre-hijacking). Its
migration is `20261019000000_user_email_verified`.

## 6. Behavior & edge spec

| Edge | Behavior |
| --- | --- |
| Logout-all from device A, device B active | B's next request fails `getSessionUserId` → redirect `/login` (R28.13); no cookie-clearing race (cookie is B's problem) |
| `AUTH_SECRET` rotated | All sessions die (already true today) **and** envelopes become unreadable → documented two-step rotation (dual-key window) in R28.26; not silently swallowed |
| Failure mid-`signupAction` | No user, no workspace, no welcome page — or all three (R28.6/R28.7) |
| Failure mid-`updatePageAction` | Page unchanged **and** no `PageVersion` row (R28.8) |
| Duplicate a block / paste a doc with ids | Copy gets fresh ids; collisions re-minted (R28.4) |
| Legacy doc (no ids) opens | `ensureBlockIds` assigns on load, next save persists one version; comments fall back to quote anchors (R28.2/R28.5) |
| DB down | `/api/health` → 503; compose marks `app` unhealthy; app process itself keeps its existing behavior (no new crash paths) (R28.24) |
| Compose boot on existing volume | `migrate deploy` is a no-op; `noema-db-data` survives `down` (R28.25/R28.23) |
| Backup restored on another host | Readable only with the original `AUTH_SECRET` — called out explicitly in SELF_HOSTING (R28.26) |
| Old-format JWT after deploy | Missing `ver` claim → rejected → one-time re-login (M28.2) |

## 7. Test plan

**Unit (vitest, red-first, `src/lib/**` sandbox)**

1. `ensureBlockIds` — id-less doc gains ids; idempotent; duplicates repaired;
   `changed` flag correct (R28.1, R28.2).
2. Structural copy — duplicate/paste paths produce unique id sets (R28.4).
3. Anchor fallback — quote-based resolution when ids are missing (R28.5).
4. JWT lifecycle — issue, verify, expiry, `sessionVersion` mismatch, missing
   `ver` (R28.12, R28.16).
5. Cookie flags snapshot for `createSession` (R28.15).
6. Envelope round-trip per domain + plaintext-transition window (R28.17).
7. Response-shape scan: no secret-bearing keys escape any action (R28.19).
8. `check-env.mjs` exit codes on clean/documented env (R28.20).
9. `SecretProvider` interface tests + import-scope assertion (R28.21).
10. Multi-write guard: seeded violation fails; allow-list only shrinks (R28.11).
11. Health status mapping, db up/down (R28.24).

**Integration (node scripts, extend `scripts/check-*` family)**

12. Rollback per priority action — forced failure ⇒ zero rows (R28.6, R28.7,
    R28.8).
13. Share link hashing — stored ≠ raw, `/s/<raw>` resolves (R28.18).
14. Docker/compose smoke — `docker compose up --build`, health 200, `down`
    keeps volume (R28.22–R28.25) — Tier HEAVY, scheduled.

**e2e (Playwright, own `e2e/hardening.spec.ts`, serial, dedicated pages)**

15. Two contexts, logout-all ⇒ second context redirected (R28.13); logout
    idempotence (R28.14).
16. Comment anchored by `blockId` survives paragraph insertion above it
    (R28.3).

Feasibility: items 1-11 and 7/10 are pure-lib and cheap in the FAST tier;
12-13 need the dev DB; 14 is the only heavyweight gate and stays Tier HEAVY
(build is explicitly not part of this change).

## 8. Migration notes

- **M28.1 — Block-id backfill.** Lazy: `ensureBlockIds` on load + one save
  persists ids (R28.2). No big-bang DB rewrite; an optional
  `scripts/backfill-block-ids.mjs` exists for operators who want it eager.
  Expect **one extra `PageVersion` row per doc** on first save after upgrade —
  documented so it is not mistaken for user activity.
- **M28.2 — Session version deploy.** `@default(0)` backfills existing users;
  tokens issued before the deploy carry no `ver` and are rejected ⇒ a single
  forced re-login for everyone at upgrade time. Chosen deliberately (cheap,
  one-line operator note) over a dual-accept window that would keep D28.3 open.
- **M28.3 — Encrypt-in-place.** One-time script wraps
  `twoFactorSecret` / `Webhook.secret` values into
  `v1:` envelopes; readers accept plaintext **only** during the window and log
  a warning, then hard-fail (R28.17). Requires `AUTH_SECRET` present; idempotent
  (already-enveloped values are skipped by the `v1:` prefix check).
  > **Status — the `twoFactorSecret` half landed (B05).** It is a **script**,
  > not a migration: the envelope key is derived from an environment variable,
  > and SQL cannot derive a key or produce an AES-GCM envelope. The script is
  > `npm run backfill:2fa` (`scripts/backfill-2fa-secrets.mjs`, planner in
  > `scripts/backfill-2fa-secrets-lib.mjs`): it needs the database (not the app
  > server) and the app's `AUTH_SECRET`, it skips rows that already carry a
  > `v1:` **or** a `v2:` envelope (idempotent), and a row it cannot re-seal is
  > **never deleted and never overwritten** — it stays as it is and is reported.
  > It walks the table in batches (bounded memory) and refuses to start when
  > the `AUTH_SECRET` of the environment opens **none** of the envelopes
  > already in the database: the pre-flight probes the two-factor table **and**
  > the two other columns that the same `AUTH_SECRET` seals
  > (`AiProviderConfig.apiKeyEncrypted`, `EmailConfig.passwordEncrypted`), and
  > refuses only when **none of the three** opens — sealing the remaining
  > cleartext rows with a key the app does not use would leave those accounts
  > unable to open their own seed. The `OAuthApp.clientSecret` /
  > `Webhook.secret` halves are still open.
- **M28.4 — Hash share tokens.** In-place `token = hashToken(token)` — safe
  because the raw token lives in the user's URL, not derivable from the hash;
  existing `/s/<raw>` links keep working because lookup already hashes the
  incoming value (`share.ts:119` becomes `where: { token: hashToken(token) }`).
- **M28.5 — Baseline migration.** Generate the first "real" migration
  reconciling the current schema (today only
  `prisma/migrations/20260113000000_init/migration.sql` exists) so
  `migrate deploy` and `db push` agree; local dev keeps `db:push` (R28.25).
- **M28.6 — Compose rollout.** `db` service untouched; `app` service added
  alongside ⇒ existing volumes/backups/port 5433 mapping all keep working
  (R28.23). Old "npm run dev on the host" path remains documented and valid.

## 9. Delivery plan (tasks ↔ requirements)

> Red-first: each task's acceptance is a failing
> test citing its `R28.x` IDs before implementation.

**Slice 1 — Atomic writes (pure server, no schema; ~1-2 days)**

- T28.1 [R28.11]: guard test first (red on today's 32-item inventory), then
  allow-list it down as slices land. Red: unit 10.
- T28.2 [R28.6, R28.7]: wrap the 10 priority actions. Red: integration 12.
- T28.3 [R28.8, R28.9, R28.10]: snapshot pairs + side-effect placement +
  shape discipline. Red: unit 11-style + integration 12.

**Slice 2 — Sessions (1 column + auth lib; Tier HEAVY because schema; ~1 day)**

- T28.4 [R28.12, R28.14, R28.15, R28.16]: `sessionVersion` + JWT `ver` +
  cookie flags. Red: unit 4, 5.
- T28.5 [R28.13]: `logoutAllAction` + settings UI + 2FA-disable hook +
  i18n keys. Red: e2e 15.

**Slice 3 — Block ids (editor slot — serialize with page-editor owner; ~2-3 days)**

- T28.6 [R28.1, R28.2, R28.4]: `BlockId` extension + `ensureBlockIds`. Red:
  unit 1, 2.
- T28.7 [R28.3, R28.5]: comment `blockId` plumbing + fallback. Red: unit 3 +
  e2e 16.

**Slice 4 — Secrets (no schema; ~1 day)**

- T28.8 [R28.17, R28.18]: envelope domains + share-token hashing + M28.3/M28.4
  scripts. Red: unit 6 + integration 13.
- T28.9 [R28.19, R28.20, R28.21]: response-shape scan, `check-env.mjs`,
  `SecretProvider`. Red: unit 7, 8, 9.

**Slice 5 — Packaging (Tier HEAVY — builds/images; scheduled; ~2 days)**

- T28.10 [R28.22, R28.24]: standalone output + Dockerfile + `/api/health`. Red:
  unit 11.
- T28.11 [R28.23, R28.25]: compose `app` service + entrypoint
  `migrate deploy` + baseline migration. Red: integration 14.
- T28.12 [R28.26]: `docs/SELF_HOSTING.md` + README link (docs tier).

## 10. Risks & open questions (honest)

**Risks**

1. **Transaction scope creep / lock time.** Wrapping big actions (9-write
   `createPageAction`) lengthens lock windows on hot workspace rows.
   Mitigation: writes only inside the tx (R28.10), reads/authz outside, no
   network I/O in callbacks; the guard test prevents *new* offenders rather
   than demanding perfection everywhere at once.
2. **Backfill churn.** M28.1's first-save rewrite creates a version row per
   doc and a one-time write burst on a busy workspace. Mitigation: lazy
   per-doc backfill (no global sweep), documented in the upgrade notes.
3. **Forced re-login at upgrade** (M28.2) plus envelope read failures if an
   operator rotates `AUTH_SECRET` naively (R28.26 documents the dual-key
   window). Both are visible, documented one-time costs — chosen over leaving
   D28.3/D28.4 open.
4. **Image/build cost.** Docker builds are `npm run build`-class:
   they belong to Tier HEAVY with the build serialization, never to this docs-only change or to
   a standard change.
5. **Extension collision (editor slot).** The `BlockId` extension touches the
   shared extension list owned by the editor slot — T28.6 must serialize
   behind any page-editor work (tier rule: one writer per file).

**Open questions**

- **O28.1** — Should block ids be visible to e2e/DOM (`data-block-id`) for
  stable selectors? Cheap, but changes DOM snapshots; decide with the editor
  slot before T28.6.
- **O28.2** — Does session management eventually need a device list
  ("where you're logged in")? That upgrades DEC28.2's counter to a real
  `Session` table. Counter ships now; table only if the product asks.
- **O28.3** — Which vault first: file-based (docker secrets), cloud KMS, or
  HashiCorp? Deferred behind `SecretProvider` (R28.21); no commitment.
- **O28.4** — `Invite.token` vs `tokenHash` column naming: rename in a future
  migration (data is already hashed — pure rename) or document forever?
  Preferring rename once M28.5-style migrations are routine.
- **O28.5** — Multi-node deploys: `sessionVersion` works across nodes only if
  they share the DB (they do); rate limiting (`src/lib/rate-limit.ts:2`
  "in-memory … single-node") is the actual multi-node limitation — tracked by
  matrix row 643, not here.
