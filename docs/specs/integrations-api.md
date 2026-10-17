# Spec — Integrations & API parity (webhooks, pagination, rate limits, OAuth)

> **Status: spec complete, implementation pending.** This document is the
> deliverable; no production code was changed. Every claim about the current code cites
> file + line. Requirement IDs (`R24.x`) are the traceability anchors: §11
> lists milestones/tasks 1:1 against them, and tests must cite the IDs they
> cover.

---

## 1. Problem statement

Noema already has the skeleton of a public integration platform: a versioned
REST surface (`/api/v1/*`), hashed API tokens, a webhook dispatcher with HMAC
signing, and an OAuth 2.0 authorization-code flow with a consent screen. But
every one of those four pillars is a **first slice** — each is missing the one
or two properties that make it safe and usable against the product class:

- **no list endpoint paginates** — `GET /api/v1/pages` returns every page in
  the workspace (`src/app/api/v1/pages/route.ts:24-29`), so a 50k-page
  workspace is one 10 MB response;
- **rate limits are keyed by IP, not by token** — all authenticated traffic
  from one NAT gateway shares one bucket, and one misbehaving token is
  indistinguishable from its well-behaved neighbours
  (`src/lib/rate-limit.ts:36-43`);
- **webhook retries live in the request process** — `void deliverWithRetry`
  (`src/lib/webhooks.ts:99`) dies with the process, the delivery log writes
  one row per attempt plus a terminal row (four rows for one failed delivery),
  and the signature carries no timestamp, so a captured payload can be
  replayed forever;
- **OAuth tokens get a hardcoded `scope: "read write"`**
  (`src/app/oauth/token/route.ts:53`) — the consent screen never asks, so the
  matrix's "OAuth scopes" row is planned for a reason.

The goal is **API-class parity**: a paginated, honestly rate-limited,
scope-aware public API with a webhook subsystem that survives restarts,
signs replay-safely, and offers delivery/subscription UX that an integration
developer can operate without SSH access — plus a marketplace-style install
path that ties the pieces together.

## 2. Current state audit (evidence)

### 2.1 Route inventory (`src/app/api/**`, 23 route files)

| Group | Files | Auth | Notes |
| --- | --- | --- | --- |
| **Public API v1** | `v1/pages/route.ts`, `v1/pages/[pageId]/route.ts`, `v1/search/route.ts`, `v1/workspaces/route.ts` | `Authorization: Bearer` | The entire public surface. All rate-limited with the single scope `"v1"` (e.g. `v1/pages/route.ts:12`). |
| OAuth (outside `/api`) | `src/app/oauth/authorize/page.tsx`, `oauth/authorize/complete/route.ts`, `oauth/token/route.ts` | session → code → token | Consent screen, code issue, token exchange. |
| Session-scoped app routes | `tickets`, `invites`, `templates`, `calendar`, `cron/templates`, `export/{database,page,workspace}`, `files/[...path]`, `import/notion`, `link-preview`, `upload`, `chat`, `chat/stream`, `ai`, `ai/skills`, `ai/transcribe`, `auth/sso/{start,callback}` | cookie session | Internal UI plumbing, not part of the public API contract. |

There is **no `src/app/api/webhooks/**` directory** — webhook management is
server actions (`src/server/actions/webhooks.ts`) plus the settings UI
(`src/components/webhook-manager.tsx`), and there is no REST route to list or
test deliveries either.

### 2.2 Tokens & guards — a correction

An early assumption pointed at `src/lib/api-guard.ts` for "token minting/verification".
It does not do that: **`src/lib/api-guard.ts:1-25` contains only `rateLimit()`**
(a fixed-window wrapper over `checkRateLimit(clientKey(request, scope), …)`
returning 429 + `Retry-After`). Minting and verification live elsewhere:

| Concern | Evidence | State |
| --- | --- | --- |
| Token hashing | `src/lib/api-auth.ts:5-7` | SHA-256 hex at rest; `apiTokenMatches` uses `timingSafeEqual` (`:9-13`). |
| Verification | `src/lib/api-auth.ts:16-35` | Bearer parse → `prisma.apiToken.findUnique({ tokenHash })` → `lastUsedAt` update (`:30-32`). Returns `{ userId }` **only — no token id, no scopes**. |
| Minting (manual) | `src/server/actions/tokens.ts:10-21` | `noema_${randomToken(24)}`, plaintext returned once; revoke at `:23-31`. |
| Minting (OAuth) | `src/app/oauth/token/route.ts:41-48` | Creates an `ApiToken` named `OAuth: ${app.name}`; **scope hardcoded `"read write"`** (`:53`). |
| Schema | `prisma/schema.prisma` `model ApiToken` | `id, userId, name, tokenHash @unique, createdAt, lastUsedAt` — **no scopes, no expiry, no per-token quota**. |
| Rate limiting | `src/lib/rate-limit.ts:17-33, 36-43` | In-memory fixed window (documented single-node topology, `:1-5`); key = `scope:first-x-forwarded-for-hop`. Used as `"v1"` 120/min shared by all four v1 routes, `"oauth-token"` 30/min (`oauth/token/route.ts:11`), `"tickets-read"` 120 / `"tickets-write"` 60 (`api/tickets/route.ts:26,50`). |

### 2.3 Webhooks & delivery

| Aspect | Evidence | State |
| --- | --- | --- |
| Event catalog | `src/lib/webhooks.ts:4-9` | 4 events: `page.created`, `page.updated`, `row.created`, `comment.created`. |
| Dispatch sites | `pages.ts:93,277`, `comments.ts:104`, `database.ts:262`, `page-menu.ts:291`, `v1/pages/route.ts:78` | `await dispatchWebhooks(...)` from server actions + the API create route. |
| Subscription match | `webhooks.ts:86-88` | `events.length === 0` ⇒ **catch-all** (subscribes to everything). |
| Retry policy | `webhooks.ts:13-14, 52-68` | `MAX_ATTEMPTS = 3`, delays `[0, 2 s, 8 s]`, 5 s per-attempt timeout (`:59`), executed **in-process**. |
| Fire-and-forget | `webhooks.ts:99` | `void deliverWithRetry(...)` — a restart loses every in-flight retry. |
| Delivery log | `webhooks.ts:18-33, 61, 68` + `model WebhookDelivery` | **One row per attempt**: a failed delivery writes rows for attempts 1-3 *plus* a terminal row (`:68`) ⇒ 4 rows per failed delivery. |
| Signing | `webhooks.ts:41-49` | `x-noema-event` + `x-noema-signature = HMAC-SHA256(secret, body)` — **no timestamp, no version prefix ⇒ indefinite replay**. |
| Payload | `webhooks.ts:91-96` | `{ event, workspaceId, data, sentAt }`. |
| Management UX | `webhook-manager.tsx:18, 55-72, 161+` | Create (URL + secret + checkbox events), delete, last-15 workspace-wide deliveries (`queries.ts:438-454`). **No redeliver, no payload view, no per-hook history, no rotation, no test event.** |
| Catalog duplication | `webhook-manager.tsx:18` vs `webhooks.ts:4-9` | `EVENTS` literal re-declares the catalog — drift risk; no descriptions in the picker. |
| Permissions | `src/server/actions/webhooks.ts:16-19` | `canManageMembers` required to create/delete. |
| Checker | `scripts/check-webhooks.mjs` | Register hook → create page via API → assert one signed delivery (`:43-56`) + delivery row (`:58-61`). |

### 2.4 OAuth apps

| Aspect | Evidence | State |
| --- | --- | --- |
| Registration | `src/server/actions/oauth-apps.ts:9-39` | `clientId = noema_<rand>`, `clientSecret = randomToken(24)` shown once; redirect URIs URL-validated (`:19-26`). |
| Schema | `model OAuthApp` / `model OAuthCode` | **`clientSecret` stored in plaintext**; code has `used` + `expiresAt`. |
| Consent | `src/app/oauth/authorize/page.tsx:17-21, 41-65` | Validates client + redirect-URI membership; allow/deny form; **`scope` parameter never parsed**; no PKCE. |
| Code issue | `oauth/authorize/complete/route.ts:31-40` | Single-use, 5-minute expiry, `state` echoed (`:27,43`). |
| Exchange | `oauth/token/route.ts:23-54` | Secret compared plaintext (`:23-26`), code checks (`:28-39`), mints `ApiToken`, **`scope: "read write"` hardcoded (`:53`)**; no refresh token, no PKCE verifier. |
| Management UI | `settings/page.tsx:125-136, 262` | `OAuthAppManager` lists apps; issued `OAuth:` tokens appear only as rows in the flat token list (`:155-159`). |

### 2.5 Pagination — what exists and what does not

- **Zero pagination in the public API.** No `cursor`, `start_cursor`,
  `page_size`, `has_more` or `next_cursor` appears anywhere under
  `src/app/api/**`. Every list endpoint is unbounded:
  `v1/pages/route.ts:24-29`, `v1/workspaces/route.ts:15-21`,
  `v1/search/route.ts:25-35`, `api/tickets/route.ts:36-39`.
- **The keyset primitive already exists** for the tracker:
  `src/server/queries.ts:780-797` — `getTickets({ take, cursor })` pages on
  `id` and returns `nextCursor`, consumed by
  `src/server/actions/tickets.ts:318-335` and the "Load more" UI
  (`src/app/w/[slug]/tickets/page.tsx:59`, `tickets-workspace.tsx:54-55`).
  Note: it is **not** wired to `GET /api/tickets`.
- **The wire shape is already familiar**: the Notion importer consumes
  `?page_size=100&start_cursor=…` and reads `has_more` / `next_cursor`
  (`src/server/actions/notion-import.ts:42-51`). Parity means speaking the
  same dialect outward.
- **Consumers to keep green**: `scripts/check-api.mjs:34,40,50`,
  `check-search.mjs:86`, `check-oauth.mjs:66`, `check-webhooks.mjs:43`,
  `check-routes.mjs:35` read `body.workspaces` / `body.pages` / `body.results`
  — those keys must survive.

### 2.6 Gap summary (defects this spec closes)

- **D24.1** — No pagination anywhere in `/api/v1` or `/api/tickets` (§2.5).
- **D24.2** — Rate limits keyed by IP+scope, one shared `"v1"` bucket for all
  four v1 routes; no per-token or per-user budget (§2.2).
- **D24.3** — Webhook retries are in-process fire-and-forget; a restart drops
  them, and the log writes 4 rows per failed delivery (§2.3).
- **D24.4** — Signature has no timestamp ⇒ replay; the signing secret is
  user-typed at creation, never rotated, never server-generated (§2.3).
- **D24.5** — No delivery operations surface: no redeliver, no stored payload,
  no per-hook history, no test event (§2.3).
- **D24.6** — Event catalog duplicated in UI code; picker has no descriptions;
  "empty = all events" is invisible to the user (§2.3).
- **D24.7** — OAuth scopes hardcoded; consent ignores `scope`; no PKCE;
  `clientSecret` plaintext at rest (§2.4).
- **D24.8** — No marketplace-style install path: four managers sit flat in
  settings with no catalog, no test step, no health state (§2.1, §2.4).

## 3. Decisions

| Decision | Options | Verdict |
| --- | --- | --- |
| **Pagination style** | keyset cursor / offset / none | **Keyset cursor**, reusing the `getTickets` primitive (§2.5). Offset is unstable under writes and O(n) in Postgres. |
| **Cursor vocabulary** | invent names / Notion dialect (`page_size`, `start_cursor`, `has_more`, `next_cursor`) | **Notion dialect** — the importer already parses it (`notion-import.ts:42-51`), so docs, importer, and API share one vocabulary. |
| **Delivery durability** | in-process retry (status quo) / durable outbox row + scheduler | **Outbox row + scheduler.** `WebhookDelivery` already exists; give it `status`/`nextAttemptAt`/`payload` and a tick. No queue dependency. |
| **Rate-limit key** | IP / token / both | **Both**: token bucket when authenticated (primary), IP bucket retained for anonymous traffic; plus a per-user aggregate so minting 100 tokens doesn't multiply budget. |
| **Signature format** | keep bare HMAC / timestamped versioned HMAC | **Timestamped v2** (`t=…,v1=…` over `"<t>.<body>"`) with 300 s tolerance. No external verifiers exist yet (matrix row still 🧭), so a coordinated update of `check-webhooks.mjs` is cheap now and impossible later. |
| **Scope storage** | column / JSON | **`String[] scopes` on `ApiToken`**, default `["read","write"]` so every existing token keeps working with no migration surprise. |
| **Event catalog source** | keep UI duplicate / single export | **Single export** `WEBHOOK_EVENTS`; the UI maps over it, guarded by a test (R24.18). |
| **Retry transport** | Redis/BullMQ / DB-backed tick | **DB-backed tick** — matches the single-node topology documented at `rate-limit.ts:1-5`; Redis is an open question (O24.1). |

## 4. Requirements (numbered, testable, with acceptance)

### M1 — API contract parity: pagination + rate limits

- **R24.1** — `GET /api/v1/pages`, `GET /api/v1/workspaces`,
  `GET /api/v1/search` and `GET /api/tickets` accept optional `page_size`
  (default 50, max 100, clamped) and `start_cursor`.
  *Acceptance:* unit tests cover default/clamp/edge values; `page_size=1000`
  returns ≤ 100 items; `page_size=abc` → 400 `{"error":"invalid_page_size"}`.
- **R24.2** — Responses keep the existing item key (`pages` / `workspaces` /
  `results` / `tickets`) and gain top-level `has_more: boolean` and
  `next_cursor: string | null`.
  *Acceptance:* `scripts/check-api.mjs:34,40,50`, `check-search.mjs:86`,
  `check-oauth.mjs:66` pass unmodified (they read the item keys only).
- **R24.3** — `start_cursor` is an opaque `base64url(JSON)` encoding of the
  last item's sort tuple **and the endpoint name**; the keyset filter follows
  the `getTickets` pattern (`queries.ts:780-797`). A malformed, truncated, or
  wrong-endpoint cursor → 400 `{"error":"invalid_cursor"}` — never a 500.
  *Acceptance:* codec round-trip unit tests (encode → decode → equality),
  garbage/truncated/foreign-endpoint inputs → 400; walking a 250-row fixture
  returns every id exactly once (no duplicates, no skips).
- **R24.4** — Each list endpoint documents and implements a stable total
  order: pages by `(position, createdAt, id)` (matching `v1/pages/route.ts:26`),
  workspaces by `(createdAt, id)`, search results by the engine's rank with
  `id` tie-break, tickets by `id`.
  *Acceptance:* two consecutive walks over unchanged data return byte-identical
  item sequences; ordering is stated in the route's doc comment.
- **R24.5** — Back-compat: omitting both params returns the first page with
  the envelope (never "all rows"); no in-repo consumer changes are required.
  *Acceptance:* the check scripts cited in R24.2 stay green against the prod
  server; the settings UI (which uses server actions, not `/api/v1`) is
  unaffected — no UI diff in this change.
- **R24.6** — Once `authenticateApiRequest` succeeds, the limiter key becomes
  `api-token:<tokenId>:<scope>` with a default budget of **600 req/min per
  token**; unauthenticated traffic keeps the IP key
  (`rate-limit.ts:36-43`).
  *Acceptance:* unit test with injected clock: two tokens behind one IP get
  independent budgets; one token over limit → 429 while the other still
  succeeds.
- **R24.7** — Every `/api/v1/*` response carries `X-RateLimit-Limit`,
  `X-RateLimit-Remaining`, `X-RateLimit-Reset`; 429 responses keep
  `Retry-After` (already emitted, `api-guard.ts:16-23`).
  *Acceptance:* integration test asserts the three headers on a 200 and
  `Retry-After` + non-zero reset on a 429.
- **R24.8** — Per-user aggregate cap: **1200 req/min per `userId`** across all
  of its tokens, so minting tokens cannot multiply budget.
  *Acceptance:* unit test: two tokens of the same user exhaust the 1200 cap
  together; a second user's budget is untouched.
- **R24.9** — The limiter remains a **pure, in-memory, single-node**
  fixed-window core (`rate-limit.ts:1-5` topology) — all new key derivation is
  a pure function tested through the injected `now` parameter
  (`checkRateLimit(key, limit, windowMs, now)`, `rate-limit.ts:17-22`); no
  Redis or new dependency in this milestone.
  *Acceptance:* vitest covers key construction + window reset; `tsc`/eslint
  green; no dependency added to `package.json`.

### M2 — Webhook delivery: durability, signing, subscriptions

- **R24.10** — Durable outbox: `dispatchWebhooks` persists one
  `WebhookDelivery` row in `status = "pending"` **with the exact request body**
  before any network I/O, including a `deliveryId` in the payload (receivers
  deduplicate on it). A scheduler claims due rows every ~5 s and on process
  boot, so retries survive restarts.
  *Acceptance:* integration: receiver down → dispatch → restart the process →
  receiver up → delivery completes; row transitions
  `pending → delivering → delivered|failed`; payload includes `deliveryId`.
- **R24.11** — Backoff schedule **0 s, 2 s, 8 s, 30 s, 2 min (5 attempts)**
  replaces `MAX_ATTEMPTS = 3` / `RETRY_DELAYS_MS` (`webhooks.ts:13-14`);
  per-attempt timeout stays 5 s (`webhooks.ts:59`); redirects are **not**
  followed (`redirect: "manual"`) so a 3xx counts as a failed attempt.
  *Acceptance:* pure scheduler unit test with a fake clock asserts due times
  for all 5 attempts; a 302-receiver is recorded as a failed attempt.
- **R24.12** — One row per logical delivery: attempts update the same row's
  `attempts` / `error` / `responseStatus` / `lastAttemptAt` (columns already
  exist on `WebhookDelivery`), fixing the per-attempt row duplication
  (`webhooks.ts:61` success row, `:68` extra terminal row).
  *Acceptance:* a receiver failing all 5 attempts yields **exactly one**
  delivery row with `attempts = 5, ok = false`; a first-try success yields one
  row with `attempts = 1`.
- **R24.13** — Signature v2: `x-noema-signature: t=<unixMs>,v1=<hex>` where
  `v1 = HMAC-SHA256(secret, "<t>.<rawBody>")`, plus
  `x-noema-timestamp: <unixMs>`; verifiers must reject `|now − t| > 300 s`.
  The bare-HMAC format (`webhooks.ts:46-48`) is replaced in the same change and
  `scripts/check-webhooks.mjs` updated alongside.
  *Acceptance:* known-vector unit test (fixed secret/time/body → fixed hex);
  tampered body and stale timestamp both fail verification; the updated
  `check-webhooks.mjs` passes against prod — the payload gate starts the
  shipped payload with `NOEMA_ALLOW_LOOPBACK_TARGETS=1`, so the loopback
  receiver of the checker is allowed; without that opt-in the production
  default refuses a loopback target.
- **R24.14** — Signing-secret UX: creation **generates a server-side secret
  by default**, shown exactly once (same contract as `createApiTokenAction`,
  `tokens.ts:9-21`), with an option to paste a custom one; a **Rotate** action
  replaces it (old secret invalid immediately); the UI only ever shows the
  existing `hasSecret` boolean (`settings/page.tsx:137-143`).
  *Acceptance:* create → secret displayed once → reload shows only
  "set/unset"; rotate → the next delivery verifies against the new secret and
  fails against the old one.
- **R24.15** — Manual redelivery: the stored payload (R24.10) can be re-sent
  from the UI by a `canManageMembers` user (permission pattern
  `src/server/actions/webhooks.ts:16-19`); the new attempt is flagged `manual`
  in the log and signed with the current secret.
  *Acceptance:* redeliver a failed delivery → receiver gets a byte-identical
  body with a valid v2 signature; the delivery row's `attempts` increments and
  the manual flag is set.
- **R24.16** — Auto-disable: a webhook with **≥ 20 consecutive failed
  deliveries** (no intervening success) is set `active = false`; settings show
  a warning banner with a one-click re-enable; any success resets the counter.
  *Acceptance:* unit test of the counter transition (fail×20 → disabled,
  success mid-way resets); integration: disabled hooks are skipped by the
  scheduler (`webhooks.ts:82-84` filter already selects `active: true`) and
  the banner renders.
- **R24.17** — Test event: each hook has a **Send test event** action that
  delivers a signed `ping` payload directly (independent of the subscription
  list) and lands in that hook's delivery history.
  *Acceptance:* click → receiver sees a v2-signed `ping` within 2 s → the
  delivery appears under that hook with `ok = true`.
- **R24.18** — Single event catalog: the picker maps over the exported
  `WEBHOOK_EVENTS` (`webhooks.ts:4-9`); the hardcoded literal at
  `webhook-manager.tsx:18` is deleted.
  *Acceptance:* unit test imports the UI's event source and
  `WEBHOOK_EVENTS` and asserts deep equality; a grep gate finds no second
  event literal in `src/components/`.
- **R24.19** — The catalog grows to **eight events** — add `row.updated`,
  `page.trashed`, `comment.updated` with dispatch sites in
  `database.ts` (row update), `pages.ts`/`page-menu.ts` (trash) and
  `comments.ts` — and the picker becomes a grouped checkbox list with a
  one-line description per event; an **empty selection is labeled "All
  events"**, making the current catch-all semantics (`webhooks.ts:86-88`)
  explicit.
  *Acceptance:* catalog test asserts 8 unique events each reachable from ≥ 1
  call site; every picker entry renders a description via `t()` (i18n ratchet
  must not rise); `check-webhooks.mjs` extended with one new-event assertion.

### M3 — OAuth scopes, token hardening, install path

- **R24.20** — The consent screen parses `scope` (space-separated; catalog
  `read write`), renders one checkbox per scope pre-checked to the requested
  set, and lets the user downgrade; the granted set is stored on the issued
  token. *Acceptance:* authorize with `scope=read write` then uncheck
  `write` → resulting token reads (200) but is refused on POST (403);
  the consent page shows exactly the requested scopes, unknown scope → 400.
- **R24.21** — Scope enforcement: `authenticateApiRequest` returns
  `{ userId, tokenId, scopes }`; every mutating `/api/v1` route (POST now,
  PUT/PATCH/DELETE later) requires `write`, else
  403 `{"error":"insufficient_scope","required":"write"}`.
  *Acceptance:* integration matrix: read-only token GET=200/POST=403,
  write token POST=201 (`v1/pages/route.ts:79` status preserved).
- **R24.22** — The hardcoded `scope: "read write"`
  (`oauth/token/route.ts:53`) is replaced by the granted set; the token
  response echoes `scope` as granted.
  *Acceptance:* downgraded exchange returns `"scope": "read"`;
  `scripts/check-oauth.mjs` updated and green.
- **R24.23** — PKCE (S256): `/oauth/authorize` accepts and stores
  `code_challenge` + `code_challenge_method=S256` on `OAuthCode`; `/oauth/token`
  requires and verifies `code_verifier`. Code single-use + 5-minute expiry
  (`complete/route.ts:31-39`) are retained.
  *Acceptance:* exchange without verifier → `invalid_grant`; with wrong
  verifier → `invalid_grant`; happy path green in an extended
  `check-oauth.mjs`.
- **R24.24** — Client secret hashed at rest: `OAuthApp.clientSecret` is
  replaced by `clientSecretHash = SHA-256(secret)`, compared timing-safe at
  exchange (mirroring `apiTokenMatches`, `api-auth.ts:9-13`); one-time display
  at creation (`oauth-apps.ts:38`) is unchanged.
  *Acceptance:* a seeded DB dump of `OAuthApp` contains no plaintext secret;
  the existing authorize → exchange happy path still succeeds.
- **R24.25** — Granted-token management: settings groups tokens by source —
  manual vs `OAuth: <app>` (provenance already encoded in the name,
  `oauth/token/route.ts:45`) — and offers **Revoke all** per app, deleting
  that app's tokens; `lastUsedAt` remains visible per token
  (`settings/page.tsx:155-159`).
  *Acceptance:* revoke → every token of that app 401s on the next request;
  the list updates in place; a manual token of the same user is untouched.
- **R24.26** — Marketplace-style install: an **Integrations** catalog section
  in workspace settings lists shippable connectors as cards (Webhooks, OAuth
  apps, ICS calendars, Zapier-style-via-webhooks; MCP/GitHub/Slack stay
  "planned" cards). Install runs **configure → test → installed**: reuses the
  existing managers (`WebhookManager`, `OAuthAppManager`), the test step is
  the R24.17 ping or an API sample request, and installed connectors show
  health derived from delivery counters (R24.16).
  *Acceptance:* e2e: install the webhook card end-to-end (create → ping →
  health "OK") with **no new backend** beyond existing actions; `check:a11y`
  stays green (cards and wizard are keyboard-reachable with proper labels).

### Non-goals (this spec)

- Native Zapier/Slack/GitHub/Google-Drive connectors and the automation
  engine (matrix rows 🧭 — they build *on* these foundations).
- Inbound webhooks (receiving external events) and the MCP server — separate
  specs once M2 exists.
- Refresh tokens / token expiry (open question O24.3), multi-instance rate
  limiting (O24.1), GraphQL, changing cookie-session app routes into public
  API.

## 5. Data model (delta only)

```prisma
model Webhook {
  // existing: id, workspaceId, url, events, secret, active, createdAt
  consecutiveFailures Int      @default(0)   // R24.16
  lastFailureAt       DateTime?
}

model WebhookDelivery {
  // existing: id, webhookId, event, ok, responseStatus, attempts, error, createdAt
  status        String    @default("pending") // pending | delivering | delivered | failed
  nextAttemptAt DateTime?                     // scheduler claim (R24.10, R24.11)
  payload       String?                       // exact body: redelivery + signature (R24.10, R24.15)
  lastAttemptAt DateTime?
  manual        Boolean   @default(false)      // UI redelivery (R24.15)
}

model ApiToken {
  // existing: id, userId, name, tokenHash, createdAt, lastUsedAt
  scopes String[] @default(["read", "write"])  // R24.20-R24.22; back-compat default
}

model OAuthApp {
  // clientSecret String          → replaced (R24.24)
  clientSecretHash String
}

model OAuthCode {
  // existing: code, clientId, userId, redirectUri, expiresAt, used
  codeChallenge       String?  // PKCE (R24.23)
  codeChallengeMethod String?  // "S256"
}
```

- No table is dropped; `clientSecret` → `clientSecretHash` is a one-time
  migration that hashes the existing plaintext values (they are already in the
  DB, so hashing is lossless for verification purposes — the plaintext is
  simply no longer *readable* afterwards).
- `ApiToken.scopes` defaults to full access → zero behavior change for every
  token minted before this change.

## 6. Transport & contracts

**Pagination (all list endpoints)**

```
GET /api/v1/pages?workspaceId=…&page_size=50&start_cursor=<opaque>
Authorization: Bearer noema_…
→ 200 { "pages": [...], "has_more": true, "next_cursor": "eyJ…" }
```

- `page_size` default 50, max 100 (clamped), invalid → 400 `invalid_page_size`.
- `next_cursor == null` ⇔ `has_more == false`.
- Cursors are endpoint-scoped: replaying a cursor from another endpoint →
  400 `invalid_cursor`.

**Errors** — `{ "error": "<machine-code>" }` with the existing shape
(`{ error: "Unauthorized" }` style is retained for unchanged paths; new codes
are snake_case): `invalid_page_size`, `invalid_cursor`, `insufficient_scope`,
`Rate limit exceeded` (existing, `api-guard.ts:17`).

**Rate-limit headers** — `X-RateLimit-Limit` / `X-RateLimit-Remaining` /
`X-RateLimit-Reset` on every `/api/v1` response; `Retry-After` on 429.

**Webhook request**

```
POST <hook.url>
content-type: application/json
x-noema-event: page.created
x-noema-timestamp: 1760000000000
x-noema-signature: t=1760000000000,v1=<hex hmac-sha256 of "<t>.<rawBody>">

{ "event": "page.created", "workspaceId": "…", "data": {…},
  "sentAt": "…", "deliveryId": "…" }
```

Verifier rule: recompute over the **raw body** with the timestamp the
verifier received (do not re-serialize JSON); reject if older than 300 s.

**OAuth** — `GET /oauth/authorize?client_id&redirect_uri&state&scope&code_challenge&code_challenge_method=S256`
→ consent → `POST /oauth/token` with `grant_type=authorization_code`,
`code`, `client_id`, `client_secret`, `redirect_uri`, `code_verifier`
→ `{ access_token, token_type: "Bearer", scope: "<granted>" }`.

## 7. UX spec (settings → Integrations)

- **Section layout**: one *Integrations* section grouping the catalog cards
  (R24.26) above the existing managers; `ApiTokenManager`, `OAuthAppManager`
  and `WebhookManager` keep their current slots (`settings/page.tsx:260-268`).
- **Event subscription picker** (R24.19): grouped checkboxes
  (Pages / Database / Comments) over the shared catalog, each with a one-line
  description; "All events" chip when the selection is empty; validation
  message when a custom selection is required.
- **Delivery row** (R24.12, R24.15): status dot + event + HTTP status ·
  attempts · relative time (existing row layout, `webhook-manager.tsx:167-182`)
  + expandable payload preview (request body + response body snippet) +
  **Redeliver** button (permission-gated, `canManageMembers`).
- **Secret field** (R24.14): create form shows the generated secret once in a
  copy-to-attention box with "Copy / I saved it"; afterwards only
  "Secret set" + **Rotate**.
- **Health banner** (R24.16): red banner "Disabled after 20 consecutive
  failures" + Re-enable + "Send test event" shortcut.
- **i18n**: every new string through `t()` with keys added via the anchor-line
  insert script (B07/B08 discipline) — the i18n ratchet must not rise.

## 8. Conflict & edge spec

| Edge | Behavior |
| --- | --- |
| Rows inserted mid-pagination walk | Newly created rows may or may not appear; pre-existing rows never duplicate or vanish (keyset on a stable tuple, R24.4). |
| Cursor forged/truncated/foreign-endpoint | 400 `invalid_cursor`; never a 500, never cross-endpoint data (endpoint name inside the cursor, R24.3). |
| Clock skew on signature | 300 s tolerance both ways; docs recommend NTP on receivers (R24.13). |
| Secret rotated while deliveries are queued | Signature is computed at send time with the *current* secret (R24.14). |
| Hook deactivated between claim and send | Scheduler re-checks `active` at claim time; claimed rows for inactive hooks are marked `failed` with `error = "hook disabled"` (R24.16). |
| Receiver returns 3xx | `redirect: "manual"` → recorded as a failed attempt, no redirect following (R24.11). |
| `X-Forwarded-For` spoofing | IP bucket trusts the first hop (`rate-limit.ts:37-39`) — documented as best-effort behind a trusted proxy; the token bucket (R24.6) is spoof-proof and becomes the primary control. |
| In-memory limiter reset on deploy | Buckets clear on restart — accepted under the single-node topology (R24.9); noted in O24.1. |
| Empty event selection | Means "all events" — now explicitly labeled (R24.19); existing hooks keep working unchanged. |
| Consent downgrade mid-flow | Only the final checked scopes are minted (R24.20); re-authorization can widen them again. |
| Authorization code replay | `used` flag + 5-minute expiry already enforced (`oauth/token/route.ts:28-39`); PKCE adds a second factor for the redirect channel (R24.23). |
| 20 consecutive failures | Auto-disable, never delete — history stays inspectable, re-enable is one click (R24.16). |

## 9. Test plan

**Unit (vitest, red-first)**

1. Cursor codec: round-trip, clamp, garbage → `invalid_cursor` (R24.3, R24.1).
2. Rate-limit keys: token bucket vs IP bucket vs user aggregate, window reset
   via injected clock (R24.6-R24.9).
3. Backoff schedule: due-times for 5 attempts with a fake clock (R24.11).
4. Delivery state machine: pending→delivering→delivered/failed, one-row
   invariant, failure counter (R24.10, R24.12, R24.16).
5. Signature v2 known vector + tamper/stale cases (R24.13).
6. Scope predicate: read token vs write route matrix (R24.21).
7. Catalog equality: UI source ≡ `WEBHOOK_EVENTS`, ≥ 8 events with call sites
   (R24.18, R24.19).

**Integration (node scripts, extended)**

8. `scripts/check-api.mjs`: pagination walk (250 seeded rows → 3 pages, no
   dup/skip), envelope keys, 429 + rate-limit headers (R24.1-R24.7).
9. `scripts/check-webhooks.mjs`: signed delivery with v2 format, retry on a
   500-then-200 receiver, manual redelivery, auto-disable after the failure
   threshold, ping event (R24.10-R24.17).
10. `scripts/check-oauth.mjs`: PKCE happy/sad paths, scope downgrade,
    hashed-secret exchange (R24.20-R24.24).

**e2e (Playwright, `e2e/integrations.spec.ts`, dedicated workspace)**

11. Settings: create webhook → picker shows descriptions → test event →
    delivery row appears; token created → shown once → hidden on reload
    (R24.14, R24.19).
12. Install card wizard (R24.26) + `check:a11y` green.

**Feasibility**: units + check scripts carry the risk (all pure logic or
single-request HTTP); e2e covers only rendering/interaction, one spec file,
no new servers.

## 10. Migration path (M1–M3)

1. **M1 — API contract parity (R24.1-R24.9)**: pagination envelope + cursor
   codec + per-token/per-user rate limits and headers. Pure additive API
   change; schema only gains `ApiToken.scopes` (defaulted, back-compat).
   Ships first because it unblocks every future integration client.
2. **M2 — Webhook durability & subscriptions (R24.10-R24.19)**: outbox
   columns + scheduler + signature v2 + redeliver/rotate/ping UX + shared
   8-event catalog with descriptions. Includes the coordinated
   `check-webhooks.mjs` signature update.
3. **M3 — OAuth scopes & install path (R24.20-R24.26)**: consent scopes,
   enforcement, PKCE, hashed client secrets, per-app revocation, and the
   marketplace-style Integrations catalog wizard.

Each milestone is independently shippable; M2/M3 depend on M1 only for the
error model and headers, not for data.

## 11. Delivery plan (milestones → tasks ↔ requirements)

> Red-first: every task's acceptance is a test
> citing its requirement IDs before implementation.

**M1 — API contract parity (~2-3 days)**

- T24.1 [R24.1-R24.5]: cursor codec + envelope helper; wire into
  `/api/v1/pages`, `/workspaces`, `/search`, `/api/tickets`.
  Red: unit 1 + integration 8.
- T24.2 [R24.6-R24.9]: token/user bucket keys + response headers in
  `api-guard.ts`. Red: unit 2 + integration 8 (429 assertions).

**M2 — Webhooks (~3-4 days)**

- T24.3 [R24.10-R24.12]: delivery columns + outbox write + scheduler tick +
  single-row attempt updates. Red: units 3,4 + integration 9 (restart case).
- T24.4 [R24.13]: signature v2 + `check-webhooks.mjs` update. Red: unit 5.
- T24.5 [R24.14-R24.17]: secret generate/rotate, stored-payload redeliver,
  auto-disable + banner, ping event. Red: integration 9 + e2e 11.
- T24.6 [R24.18, R24.19]: shared catalog, 3 new events with dispatch sites,
  grouped picker with descriptions. Red: unit 6… catalog unit 7 + e2e 11.

**M3 — OAuth + install (~3-4 days)**

- T24.7 [R24.20-R24.22]: consent scopes + enforcement + token response.
  Red: unit 6 (scope matrix) + integration 10.
- T24.8 [R24.23, R24.24]: PKCE + hashed client secret (+ one-time hash
  migration). Red: integration 10.
- T24.9 [R24.25, R24.26]: per-app revoke + Integrations catalog wizard.
  Red: e2e 11, 12 + a11y gate.

## 12. Risks & open questions (honest)

**Risks**

1. **Signature v2 breaks early verifiers.** Anyone who already integrated
   against bare-HMAC will fail closed. Mitigation: no external verifiers are
   known (matrix row still 🧭), the only in-repo verifier
   (`check-webhooks.mjs`) is updated in the same change, and the format
   change is documented with a copy-paste verifier (§6).
2. **Scheduler in a serverless/multi-instance deployment.** The DB-backed
   tick assumes a long-lived Node process like the rest of the app
   (`next start`); two instances would double-send unless the claim uses a
   conditional update (`UPDATE … WHERE status='pending'` returning row).
   Mitigation: claim via conditional Prisma `updateMany` + `updateMany`
   count check; noted in O24.1.
3. **Pagination changes response semantics.** Absent params now return a
   bounded first page instead of "everything". Mitigation: no in-repo
   consumer reads beyond the item keys (R24.5 evidence); check scripts are
   the merge gate.
4. **Rate-limit header leakage of internal state** — trivial, but headers
   must be computed *before* incrementing is rejected (they reflect the
   post-decision state consistently).

**Open questions**

- **O24.1** — Move rate limiting to Redis when multi-instance becomes real?
  Current spec keeps the pure in-memory core (R24.9); the interface
  (`checkRateLimit(key, limit, windowMs, now)`) already permits a swap.
- **O24.2** — Should `/api/tickets` pagination default to the tracker's
  existing `take` size (whatever the UI uses) rather than 50? Decide at
  implementation with the tracker owner.
- **O24.3** — Refresh tokens / expiring access tokens: Notion issues
  long-lived integration tokens; we keep non-expiring tokens this round —
  revisit with the security review before GA.
- **O24.4** — Inbound webhooks (receive external events) and outbound
  ordering guarantees (per-hook FIFO vs concurrent sends): FIFO per hook is
  desirable but costs throughput; decide with the first real connector.
- **O24.5** — Marketplace catalog scope: cards for MCP/GitHub/Slack ship as
  "planned" placeholders (R24.26) — do they belong in the catalog before
  their own specs land, or should the catalog only list shipped connectors?
