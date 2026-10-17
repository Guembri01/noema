# Noema — REST API reference

Generated for the **API docs gap** item (**B48**) by a systematic walk of every route
handler under `src/app/api/**` plus the three handlers that live outside it
(`/oauth/*`, `/s/[token]/unlock`).

- **Route files walked:** 26 (23 in `src/app/api/`, 3 outside)
- **Endpoints documented:** 31 (HTTP method × path)
- **Conventions:** every handler declares `export const runtime = "nodejs"`.
  Responses are JSON (`{"error": "…"}` on failure) unless the endpoint is
  explicitly a file/redirect/stream.
- Base URLs: dev `http://localhost:3201`, prod `http://localhost:3200`.

> When a route changes, update the matching section — each group cites its
> source file(s) so the diff is local.

---

## 1. Authentication

There is **no single auth layer**: each route file does its own guard. Three
mechanisms exist, and they do not overlap (a Bearer token is not accepted by
cookie routes and a session cookie is not accepted by `/api/v1/*`).

### 1.1 Cookie session (default for all app routes)

- Cookie: `noema_session` — a HS256 JWT signed with `AUTH_SECRET` (min 16
  chars), 30-day expiry, `httpOnly`, `sameSite=lax`, `secure` in production.
  Source: [`src/lib/auth.ts`](../src/lib/auth.ts) (`createSession`,
  `getCurrentUser`).
- Routes call `getCurrentUser()`; missing/invalid cookie →
  `401 {"error":"Unauthorized"}`.
- Obtained via credential login or the SSO flow (§2). The credential login is
  rate-limited and locks the account after repeated failures (§3.1).
- Because the cookie is `SameSite=Lax`, cross-site browser POSTs do not carry
  it; these endpoints take no CSRF token of their own.

### 1.2 Bearer API tokens (`/api/v1/*` only)

- Header: `Authorization: Bearer noema_<24 chars>`.
- Verified by `authenticateApiRequest()` in
  [`src/lib/api-auth.ts`](../src/lib/api-auth.ts) — note **`src/lib/api-guard.ts`
  is only the rate limiter** (§3); token verification lives in `api-auth.ts`.
- Storage: only the SHA-256 hash (`tokenHash`, unique column) is persisted;
  comparison is timing-safe, and `lastUsedAt` is bumped on every call.
  Missing/malformed header or unknown token → `401 {"error":"Unauthorized"}`.

**Token creation flow (settings UI):**

1. Workspace settings → **API tokens** card:
   [`src/app/w/[slug]/settings/page.tsx`](../src/app/w/[slug]/settings/page.tsx)
   renders `ApiTokenManager`
   ([`src/components/api-token-manager.tsx`](../src/components/api-token-manager.tsx)).
2. "Create token" calls the server action `createApiTokenAction(name)`
   ([`src/server/actions/tokens.ts`](../src/server/actions/tokens.ts)):
   mints `noema_${randomToken(24)}`, stores `hashApiToken(token)` with a label
   (≤60 chars, default `"API token"`), and returns the **plaintext exactly
   once** (`{ token }`) — it is never retrievable again.
3. "Revoke" calls `revokeApiTokenAction(id)` → deletes the row scoped to the
   current user (`{ ok: true }` or `{ error: "Token not found." }`).

Tokens are also minted by the OAuth flow (§10) — same `ApiToken` table, named
`OAuth: <app name>`.

### 1.3 Cron secret (`/api/cron/templates`)

- Header `x-cron-secret: <CRON_SECRET>` must match the env var. Fail-closed:
  if `CRON_SECRET` is unset the route answers
  `503 {"error":"CRON_SECRET is not configured. …"}`; mismatch →
  `401 {"error":"Unauthorized"}` (checked **before** the rate limit).

### 1.4 Auth matrix

| Routes | Guard | Source |
|---|---|---|
| `/api/v1/*` (5 routes) | Bearer token | `src/lib/api-auth.ts` |
| tickets, calendar, invites, chat, chat/stream, templates, link-preview, upload, files, export/*, import/notion, ai* | Cookie session (`getCurrentUser`) | `src/lib/auth.ts` |
| `/api/cron/templates` | `x-cron-secret` | route file |
| `/api/auth/sso/start`, `/api/auth/sso/callback` | Public (state/nonce cookies) | route files |
| `/oauth/token` | OAuth `client_id` + `client_secret` (form) | route file |
| `/oauth/authorize/complete` | Cookie session | route file |
| `/s/[token]/unlock` | Share password (form) | route file |

---

## 2. Auth — OIDC SSO

Source: [`src/app/api/auth/sso/start/route.ts`](../src/app/api/auth/sso/start/route.ts),
[`src/app/api/auth/sso/callback/route.ts`](../src/app/api/auth/sso/callback/route.ts)

### `GET /api/auth/sso/start` — public

Begins the OIDC login. Requires `SSO_ISSUER` + `SSO_CLIENT_ID`
(optional `SSO_REDIRECT_URI`, default `<origin>/api/auth/sso/callback`).

1. Fetches `<issuer>/.well-known/openid-configuration`.
2. Redirects (307) to the provider's `authorization_endpoint` with
   `client_id`, `redirect_uri`, `response_type=code`,
   `scope=openid email profile`, `state`, `nonce`.
3. Sets `sso_state` and `sso_nonce` cookies (`httpOnly`, `lax`, 600 s).

| Case | Response |
|---|---|
| Env not configured | `404 {"error":"SSO is not configured."}` |
| Discovery fails / no `authorization_endpoint` | `502 {"error":"SSO discovery failed."}` |
| OK | `307` → provider authorize URL |

### `GET /api/auth/sso/callback` — public

Query: `?code=…&state=…`. Verifies `state` against the cookie, exchanges the
code at the provider's `token_endpoint` (client-secret post), verifies the
`id_token` via JWKS (`issuer` + `audience`), checks `nonce`, then:

- upserts the user by lowercased email (SSO-created users get
  `passwordHash: "sso:<random>"`),
- issues the `noema_session` cookie, deletes `sso_state`/`sso_nonce`,
- redirects to `/app`.

| Case | Response |
|---|---|
| Env not configured | `404 {"error":"SSO is not configured."}` |
| Missing/mismatched `state`/`code`, discovery failure, token exchange failure, bad id_token, nonce mismatch, no email in token | `307` → `/login?error=sso` (redirect, no JSON body) |
| OK | `307` → `/app` |

---

## 3. Rate limiting

Source: [`src/lib/api-guard.ts`](../src/lib/api-guard.ts) +
[`src/lib/rate-limit.ts`](../src/lib/rate-limit.ts)

```ts
rateLimit(request, scope, limit = 120, windowMs = 60_000, { userId }): NextResponse | null
```

- Fixed-window, **in-memory**, in **two separate bounded LRU stores** — one for
  the client-IP budgets, one for the per-user budgets. Each store holds at
  most **10 000 buckets** and has a TTL sweep that drops the buckets whose
  window has closed.
- The client-IP bucket is keyed `scope:clientIp`. The client IP is read from
  `X-Forwarded-For` / `X-Real-IP` **only** when the deployment declares how
  many reverse-proxy hops to trust (`TRUSTED_PROXY_HOPS`); without that
  declaration the forwarding headers are written by the client itself and are
  ignored, so every caller of a scope shares the `scope:local` bucket. With
  `TRUSTED_PROXY_HOPS=N` the **Nth-from-last** `X-Forwarded-For` hop is used —
  the **N-th hop from the end**, i.e. the **real client** (every trusted proxy
  appends the address of its peer, so the last N entries of the chain are the
  ones the trusted proxies appended). A chain shorter than N hops cannot be
  attributed that way: the `X-Real-IP` fallback is used instead (the proxy
  that declared itself sets it), and only when that header is missing too
  does the key fall back to `scope:local`. The address is canonicalized
  (IPv4 dotted-decimal, IPv6 RFC 5952); a value that is not an IP literal
  cannot be attributed and also falls back to `scope:local`.
- **Two budgets** apply. The client-IP budget always does; for routes that
  know their caller a **per-user** budget (`scope:user:<id>`) applies on top.
  The user id comes from the session cookie or the API token and cannot be
  spoofed — rotating the (spoofable) client IP does not buy a fresh
  allowance. The per-user budget is checked **first**; it is the budget a
  caller cannot dodge.
- The two budgets live in **separate stores**, so the client-IP key space —
  the part an unauthenticated caller controls — cannot evict the per-user
  bucket. A flood of 10 000 forged client addresses therefore cannot reset
  an exhausted per-user budget.
- **The residual of the memory bound, named:** when a store holds more than
  10 000 **live** keys inside one window, the **coldest live bucket is
  sacrificed** and **that caller's window starts over** (same trade-off the
  sliding-window limiter makes at its own 10 000-key cap). For the client-IP
  store that needs 10 000 distinct client addresses in one window; with the
  default configuration (`TRUSTED_PROXY_HOPS` unset) every caller of a scope
  shares `scope:local`, so the key space cannot grow that way at all. For the
  per-user store it needs 10 000 **distinct authenticated users** holding a
  live budget in the same window — a real installation, not a flood.
- An **anonymous** caller only gets the client-IP budget. Without a declared
  proxy that is the shared `scope:local` bucket — a shared budget, but never a
  bypassable one.
- The caller is identified **before** the limit is charged: the per-user
  budget is keyed on the user id, so the route resolves the session or the
  API token first. The limiter therefore does not bound that lookup itself —
  an anonymous flood on a wired route costs one session lookup per request
  before the limit bites. The lookup is cheap for an unauthenticated caller
  (a forged cookie fails the signature check before any database access), so
  only authenticated callers make it expensive.
- Over the limit → `429 {"error":"Rate limit exceeded"}` with a `retry-after`
  header (whole seconds, min 1). `null` means continue.
- The limiter resets on process restart; `resetRateLimits()` exists for tests.
- Single-node only; the file header says to swap in Redis for multi-instance.
- Operational note: see [OPERATIONS §1.1](./OPERATIONS.md#11-reverse-proxy-in-front-of-the-app-trusted_proxy_hops)
  — without `TRUSTED_PROXY_HOPS` all clients of a scope share one budget, and
  a configured `ADMIN_IP_ALLOWLIST` makes the admin/private surfaces answer
  403 for everybody until the proxy is declared.

| Scope | Limit | Used by |
|---|---|---|
| `v1` | 120/min | all `/api/v1/*` routes |
| `tickets-read` / `tickets-write` | 120 / 60 per min | `GET` / `POST /api/tickets` |
| `calendar-read` / `calendar-write` | 120 / 30 per min | `GET` / `POST /api/calendar` |
| `invites-read` / `invites-write` | 60 / 20 per min | `GET` / `POST /api/invites` |
| `chat-read` / `chat-write` | 120 / 60 per min | `GET` / `POST /api/chat` |
| `chat-stream` | 20/min | `POST /api/chat/stream` |
| `templates` | 30/min | `POST /api/templates` |
| `preview` | 60/min | `GET /api/link-preview` |
| `upload` | 60/min | `POST /api/upload` |
| `ai` / `ai-skills` / `transcribe` | 30 / 30 / 10 per min | `POST /api/ai*` |
| `notion-import` / `pdf-import` | 30 / 30 per min | `POST /api/import/*` |
| `export-page` / `export-database` / `export-workspace` | 30 / 30 / 5 per min | `GET /api/export/*` |
| `inbound-webhook` | 60/min | `POST /api/webhooks/inbound` |
| `mcp` | 120/min | `GET` / `POST /api/mcp` |
| `metrics` | 120/min | `GET /api/metrics` |
| `oauth-token` | 30/min | `POST /oauth/token` |
| `cron` | 12/min | `POST /api/cron/templates` (after the secret check) |
| `share-unlock-<token>` | 5/min | `POST /s/[token]/unlock` (per share link) |

Every scope above is spent **per client IP**; the scopes whose routes know
their caller additionally spend the per-user budget (see above).

**Not rate-limited:** `files/[...path]`, `auth/sso/start`,
`auth/sso/callback`, `oauth/authorize/complete`, `s/[token]/unlock`.

### 3.1 Auth surface (server actions)

Source: [`src/lib/rate-limit.ts`](../src/lib/rate-limit.ts) +
[`src/server/actions/auth.ts`](../src/server/actions/auth.ts) +
[`src/server/actions/two-factor.ts`](../src/server/actions/two-factor.ts)

The sign-in form, the sign-up form and the 2FA check are **server actions**,
not route handlers, so they never reach `api-guard.ts`. They carry their own
budgets:

| Budget | Limit | Keyed on |
|---|---|---|
| address | 30/min | the client address (`x-forwarded-for`, then `x-real-ip`, then `local`) |
| account | 10/min (the `AUTH` tier) | the submitted e-mail address — a client cannot forge it |
| 2FA guesses | 5 / 15 min | the account (sign-in) or the user id (the 2FA settings) |

The address and the account budget are charged **before** any password work
happens, so a flood of guesses cannot outrun the limiter. The sign-up form
spends its budget before it looks the address up, so the "this e-mail already
exists" answer is bounded by the address budget instead of being free. Over a
budget the action answers
`{"error":"Too many attempts. Try again in N seconds."}`.

The account also carries a **persisted** lock — `User.failedLoginCount` and
`User.lockedUntil`, added by the migration `20260115000000_auth_lockout`:
five consecutive failures lock the account for 15 s, the lock doubles with
every further failure up to 15 min, and a successful sign-in clears the
counter and the lock. While the lock holds, the action answers
`{"error":"This account is temporarily locked. Try again in N seconds."}` —
before the password is compared.

The lock belongs to the account, not to the client address: a deliberate run
of failed sign-ins locks the account of the person being targeted.

### Common status codes

| Status | Meaning / body |
|---|---|
| 400 | Malformed JSON (`Invalid JSON body`), missing required param, unknown `action`, or an `{ error }` returned by the backing server action |
| 401 | `{"error":"Unauthorized"}` — no/invalid session or Bearer token, bad cron secret, bad OAuth client |
| 403 | `{"error":"Forbidden"}` — no access to the target workspace/page, or role too low |
| 404 | Target not found. **Quirk:** workspace-scoped cookie routes report *no access* as `404 {"error":"Workspace not found"}` (tickets/calendar/invites/chat) instead of 403 |
| 413 / 415 | Upload size / MIME rejection |
| 429 | Rate limited (§3) |
| 502 | Upstream failure (transcription provider, storage driver) |
| 503 | Feature unconfigured (AI, transcription, cron secret) |

---

## 4. Pages & content (cookie session)

### `POST /api/templates` — create a page/database from a template

Source: [`src/app/api/templates/route.ts`](../src/app/api/templates/route.ts) ·
rate scope `templates` (30/min)

```jsonc
// one of three shapes, selected by "action"
{ "action": "quickstart", "workspaceId": "…", "kind": "page" | "database", "parentId": null }
{ "action": "gallery",    "workspaceId": "…", "templateId": "…",           "parentId": null }
{ "action": "block",      "workspaceId": "…", "templateId": "…",           "parentId": null }
```

- **200** `{"ok":true,"id":"…","slug":"…"}` (`TemplateResult` from
  `src/server/actions/home-templates.ts`)
- **400** `{"error":"Unknown action."}` · `{"error":"Invalid JSON body."}` ·
  any `{error}` from the backing action (no workspace permission, bad
  template id, …)
- **401** unauthenticated · **429** rate limited

### `GET /api/link-preview?url=` — OpenGraph metadata for bookmark blocks

Source: [`src/app/api/link-preview/route.ts`](../src/app/api/link-preview/route.ts) ·
cookie session · rate scope `preview` (60/min)

- SSRF guard: `http(s)` only; the target is resolved through DNS and every
  answer must be public; redirects are followed manually and every hop is
  re-validated, and the URL the response was finally read from is checked
  again. The card's `image`/`icon` URLs pass the same gate — the victim's
  browser fetches them. Response capped at 256 KB, 6 s timeout (the DNS
  lookup included), custom `NoemaBot/1.0` UA.
- **200**

```json
{
  "url": "https://example.com/post",
  "host": "example.com",
  "title": "…", "description": "…",
  "image": "https://…/cover.png", "icon": "https://…/favicon.png"
}
```

`null` fields are normal (fetch failure returns the same shape with everything
but `url`/`host` null). **400** `{"error":"Invalid url"}` or
`{"error":"Blocked host"}` — the latter for a private/loopback/metadata host,
a host whose DNS answers point into private space, a redirect hop into
private space, and a host that does not resolve at all.

A page document stores a bookmark block as
`{ "type": "bookmark", "attrs": { "url": "…", … } }`, and `url` is rendered as
an anchor. The app's own write path (`updatePageAction`) drops a URL that is
not on the shared `http|https|mailto|tel` href allowlist; a client that writes
the document itself (the MCP `append_blocks` tool, which does not run the
document sanitiser) may store any value, and the editor and the read-only
renderer both check the stored URL against the same allowlist before it becomes
a link. A stored `javascript:`, `data:` or protocol-relative URL therefore
never becomes a live link, whichever client wrote it — it is rendered as a card
without a target.

### `POST /api/upload` — file upload (multipart)

Source: [`src/app/api/upload/route.ts`](../src/app/api/upload/route.ts) ·
cookie session · rate scope `upload` (60/min)

`multipart/form-data`: `workspaceId` (string) + `file` (Blob).

- Allow-list: `png jpg gif webp svg avif pdf txt md json zip`; max **10 MB**.
- Stored via `storageDriver()` — local disk (`STORAGE_DIR`) or S3-compatible
  when `S3_BUCKET` is set; an `Asset` row is created.

**200**
```json
{ "url": "/api/files/<workspaceId>/<12-char-name>.png",
  "name": "diagram.png", "mimeType": "image/png", "size": 48213 }
```

| Error | Body |
|---|---|
| 400 | `Expected multipart form data` / `Missing file or workspaceId` |
| 401 | `Unauthorized` |
| 403 | `Forbidden` — no workspace access **or role `GUEST`** |
| 413 | `File too large (max 10 MB)` |
| 415 | `Unsupported file type: <mime>` |
| 502 | storage driver message |

### `GET /api/files/[workspaceId]/[name]` — serve an uploaded asset

Source: [`src/app/api/files/[...path]/route.ts`](../src/app/api/files/[...path]/route.ts) ·
cookie session · **no rate limit**

- Path must be exactly 2 segments; both validated against traversal
  (`^[A-Za-z0-9_-]+$` / `^[A-Za-z0-9._-]+$`, no `..`, plus
  `isValidAssetKey`).
- **200** raw bytes with `content-type` and `cache-control: private, max-age=3600`.
- Reserved for full members: a `GUEST` is refused with `403` before the
  storage driver is asked, so the refusal carries no bytes, no asset
  `content-type`, no `etag` and no `cache-control`; a missing asset is
  refused the same way, so the route is not an existence oracle for a guest.
  An asset cannot be scoped to a page (`Asset.pageId` is never populated), so
  the route applies a role gate rather than a page scope. **Consequence: a
  guest reads the text of a page shared with them, but none of its media —
  every image block, the page cover, the page icon and every database
  attachment answers `403` for a guest**, in the app and on the public share
  page `/s/[token]`. This is deliberate and fail-closed until an asset can be
  linked to a page.
- **400** `Bad path` · **401** `Unauthorized` · **403** `Forbidden` (not a
  workspace member **or role `GUEST`**) · **404** `Not found`.

---

## 5. Databases

There is **no database CRUD over REST**. Property/row mutations go through
server actions (`src/server/actions/database.ts`,
`src/server/actions/linked-database.ts`). The only database-shaped HTTP
endpoints are:

- `GET /api/export/database/[pageId]` (CSV) — §8
- `POST /api/cron/templates` (materializes recurring database templates) — §16

`POST /api/v1/pages` accepts `"type": "DATABASE"` to *create* an empty
database page (§6).

A FILES cell stores `{ files: { name, url, mimeType? }[] }`, and `url` is an
app-owned asset path (`/api/files/<workspaceId>/<name>`, as returned by
`POST /api/upload`): the app's own write path (`setPropertyValueAction`)
refuses any other URL. The MCP `update_property_value` tool stores the value
it is given — it has no upload tool, so a client cannot produce an app-owned
URL — and every stored URL passes the shared `http|https|mailto|tel` href
allowlist before it is rendered as a link, so a stored `javascript:` URL never
becomes an anchor, whichever client wrote it. A FILES entry that is not an
app-owned asset path is dropped from the cell the next time a file is
attached to it.

---

## 6. Public REST API — `/api/v1` (Bearer tokens)

All five routes: `rateLimit(request, "v1")` (120/min), then
`authenticateApiRequest(request)`; workspace checks via
`getWorkspaceAccess()`. Source files under
[`src/app/api/v1/`](../src/app/api/v1).

#### The guest scope

A workspace role is `OWNER`, `ADMIN`, `MEMBER` or `GUEST`. A `GUEST` is an
external collaborator: they may only open the pages that were shared with
them, the pages of their teamspaces and their own pages. The scope is resolved
per request by `pageScopeFor()`
([`src/lib/guest-access.ts`](../src/lib/guest-access.ts)) and applied to every
read that returns pages — with one exception named below (the **empty**-`q`
branch of the search):

- the scope lands in the query, **before** the limit — a window never shrinks
  because a hidden page took a slot;
- a page **outside** the scope answers **404**, like a page that does not
  exist — the route never confirms that it does;
- a full member (`OWNER`/`ADMIN`/`MEMBER`) keeps the whole workspace;
- an unknown role yields an **empty** scope, never the whole workspace.

The scope covers **pages only**. The datasets that are not page-scoped —
tickets, discussions, calendar events — are **role-gated** instead: on those
routes a `GUEST` gets a **403** (§11, §12, §14). The same rule holds behind
the UI: the workspace pages that render those datasets (tickets, archived
tickets, cycles, roadmap, projects) answer **404** for a `GUEST`, and the
member directory needs the `viewMemberDirectory` permission, which a `GUEST`
does not hold.

### `GET /api/v1/workspaces` — list caller's workspaces
[`route.ts`](../src/app/api/v1/workspaces/route.ts)

```json
{ "workspaces": [ { "id": "…", "name": "Acme", "slug": "acme", "icon": "🚀" } ] }
```
Owned or member workspaces, ordered by `createdAt`. Errors: 401, 429.

### `GET /api/v1/pages?workspaceId=…`
[`route.ts`](../src/app/api/v1/pages/route.ts)

```json
{ "pages": [ { "id": "…", "parentId": null, "title": "Roadmap",
               "icon": "🗺️", "type": "PAGE", "updatedAt": "…" } ] }
```
Non-trashed pages, ordered by `position` then `createdAt`. A `GUEST` only
receives the pages in their scope (*The guest scope* above).
Errors: **400** `workspaceId is required` · **403** `Forbidden` · 401 · 429.

### `POST /api/v1/pages` — create a page
[`route.ts`](../src/app/api/v1/pages/route.ts)

```json
{ "workspaceId": "…", "title": "New doc", "parentId": null, "type": "PAGE" }
```
- `workspaceId` required; `type` is `PAGE` (default) or `DATABASE`; `title`
  truncated to 500 chars, default `"Untitled"`; content starts as an empty
  ProseMirror doc; `position` = last sibling + 1000.
- Requires an **edit-capable role** (view/guest → 403).
- Dispatches the outbound `page.created` webhook with `{"pageId","via":"api"}`.

**201** `{"page":{"id":"…","title":"New doc","type":"PAGE"}}`
Errors: 400 (`Invalid JSON body`, `workspaceId is required`) · 401 · 403 · 429.

#### Retrying safely — `Idempotency-Key`

Send an `Idempotency-Key: <opaque>` header and a retry cannot create the page
twice ([`src/lib/idempotency.ts`](../src/lib/idempotency.ts)):

| situation | result |
|---|---|
| no header | the handler runs, nothing is remembered |
| first request | runs, outcome stored for 24 h |
| repeat, same key + same body | the stored status and body are replayed, with `Idempotency-Replayed: true` |
| repeat while the first is still running | **409** `idempotency_in_progress` (honours `Retry-After: 1`) |
| same key, different method/path/user/body | **422** `idempotency_key_reuse` |

A stored response is replayed verbatim, including a **4xx** — so a rejected
request stays rejected rather than becoming a surprise second attempt. A **5xx**
and a **429** are deliberately *not* stored: a crash is not an outcome, and rate
limiting belongs to the attempt, not to the mutation.

Keys are scoped to the authenticated principal and the endpoint, so two clients
may pick the same key without colliding. Storage is process-local (a bounded
24 h FIFO map), which suits the single-process server and the standalone desktop
build; behind multiple instances it would move to a shared store with no change
to this contract.

### `GET /api/v1/pages/[pageId]` — read one page incl. document
[`route.ts`](../src/app/api/v1/pages/[pageId]/route.ts)

```json
{ "page": { "id":"…", "parentId":null, "title":"Roadmap", "icon":"🗺️",
            "type":"PAGE", "content": { "type":"doc","content":[…] },
            "updatedAt":"…" } }
```
`workspaceId`/`deletedAt` are stripped from the payload. A page outside the
caller's guest scope answers **404**, like a page that does not exist.
Errors: **404** `Not found` (missing, **trashed** or **outside the guest
scope**) · **403** `Forbidden` (no workspace access) · 401 · 429.

### `GET /api/v1/search?workspaceId=…&q=…`
[`route.ts`](../src/app/api/v1/search/route.ts)

```json
{ "results": [ { "id":"…", "title":"Roadmap", "icon":"🗺️", "type":"PAGE",
                 "snippet":"…matched excerpt…", "updatedAt":"…" } ] }
```
`q` may be empty; title + body search via `searchPages()` in
`src/server/queries.ts`. A `GUEST` only hits the pages in their scope — with
one exception still open: the **empty** `q` branch returns the workspace's
most recent pages **without** the scope. This branch does not close it; the
B88 branch does (#105 — whose body describes the MCP route, not this branch).
Errors: 400 (`workspaceId is required`) · 403 · 401 · 429.

---

## 7. Search (in-app)

The only REST search endpoint is `GET /api/v1/search` (§6). The workspace
search UI uses the server action in
[`src/server/actions/search.ts`](../src/server/actions/search.ts) and is not
HTTP-addressable.

---

## 8. Export / import

An export is a **full-text copy** of the workspace, so it is reserved for full
members: a `GUEST` — an external collaborator with access to a few shared pages
— gets a **403** `Forbidden`, and that check comes **first**. The scope check
behind it is belt and braces: a page outside the caller's scope would be a
**404**, never a leak.

### `GET /api/export/page/[pageId]?format=md|json|html|pdf`
Source: [`src/app/api/export/page/[pageId]/route.ts`](../src/app/api/export/page/[pageId]/route.ts) ·
cookie session · no rate limit

| `format` | Content-Type | Body |
|---|---|---|
| `md` (default) | `text/markdown; charset=utf-8` | `pageToMarkdown(title, content)` |
| `json` | `application/json; charset=utf-8` | `{"title":…, "content":{…}}` pretty-printed |
| `html` | `text/html; charset=utf-8` | `pageToHtml(title, content)` |
| `pdf` | `application/pdf` | `docToPdf(title, content)` |

All success responses carry
`content-disposition: attachment; filename="<sanitized-title>.<ext>"`.
Errors: **401** `Unauthorized` · **404** `Not found` (missing **or outside the
caller's scope**) · **403** `Forbidden` (no workspace access **or role
`GUEST`**).

### `GET /api/export/database/[pageId]` — CSV
Source: [`route.ts`](../src/app/api/export/database/[pageId]/route.ts) ·
cookie session · no rate limit

Header row = property names (position order), one line per non-trashed row;
the primary property renders the row title, other cells via `formatCell`.
**200** `text/csv; charset=utf-8` +
`content-disposition: attachment; filename="<title>.csv"`.
Errors: **404** `Not found` — page missing, **or `type !== "DATABASE"`**, **or
outside the caller's scope** · 401 · 403 `Forbidden` (no workspace access **or
role `GUEST`**).

### `GET /api/export/workspace/[slug]` — bulk zip
Source: [`route.ts`](../src/app/api/export/workspace/[slug]/route.ts) ·
cookie session · no rate limit

Walks every non-trashed page: `type: "DATABASE"` → `<path>.csv`, otherwise
`<path>.md` (path = title ancestry, deduplicated with ` (n)` suffixes,
depth-guarded at 50), plus a `README.md`.
The referenced uploads are bundled under `attachments/` — only uploads of the
exported workspace; a reference to another workspace's upload is skipped.
**200** `application/zip` +
`content-disposition: attachment; filename="<workspace>.zip"`.
Errors: **404** `Not found` (unknown slug) · 401 · 403 `Forbidden` (no
workspace access **or role `GUEST`**).

### `POST /api/import/notion` — import a Notion page tree
Source: [`src/app/api/import/notion/route.ts`](../src/app/api/import/notion/route.ts) ·
cookie session · rate scope `notion-import` (30/min)

```json
{ "workspaceId": "…", "parentId": null,
  "token": "ntn_…", "pageId": "…-…-…" }
```
Delegates to `importNotionPageAction` (`src/server/actions/notion-import.ts`),
which fetches from the Notion API server-side.

- **200** `{"ok":true,"id":"…","slug":"…","pages":12}`
- **400** `Invalid JSON body.` or any action `{error}` · **401** · **429**

---

## 9. Webhooks (outbound only)

**There is no inbound `/api/webhooks` endpoint** — Noema only *sends*.

- **Events** (`src/lib/webhooks.ts`): `page.created`, `page.updated`,
  `row.created`, `comment.created`. Empty event list = subscribe to all.
- **Configuration** is a server action, not REST:
  `createWebhookAction` / `deleteWebhookAction`
  ([`src/server/actions/webhooks.ts`](../src/server/actions/webhooks.ts)) from
  the workspace settings card; requires a member-managing role; URL must be
  `http(s)` **and must point to a public host** — private, reserved and cloud
  metadata addresses are refused, including host names that resolve into
  private space (DNS rebinding). Every refusal answers the same message, so
  the form cannot be used to probe the internal network.
  **The production default refuses a loopback target** (`127.0.0.0/8`, `::1`,
  `localhost`). An operator who really has a receiver on the same machine can
  open the loopback range explicitly with `NOEMA_ALLOW_LOOPBACK_TARGETS=1`;
  the opt-in covers the loopback range only — RFC1918, link-local, cloud
  metadata and `.internal`/`.local` names stay refused.
- **Dispatch** (`dispatchWebhooks(workspaceId, event, data)`): persists one
  `WebhookDelivery` outbox row per receiver *before* any network I/O, then
  fires asynchronously with 5 attempts (0 s / 2 s / 8 s / 30 s / 2 min) and a
  5 s timeout; every attempt updates that single row — one row per logical
  delivery (readable via `getWebhookDeliveries` in `src/server/queries.ts`).
  The target is checked again before **every** attempt (the creation-time
  check does not cover DNS rebinding, nor a hook whose URL changed since): a
  refused target is never contacted, and its row records no status code, so
  the delivery history is no status oracle for internal services. The same
  rules apply as at creation time, opt-in included: with
  `NOEMA_ALLOW_LOOPBACK_TARGETS=1` a loopback target is delivered to, without
  it the delivery is refused before the target is contacted.

Delivery request your endpoint receives:

```http
POST <your-url>
content-type: application/json
x-noema-event: page.created
x-noema-timestamp: <unixMs>
x-noema-signature: t=<unixMs>,v1=<hex HMAC-SHA256 of "<t>.<rawBody>", when a secret is set>

{ "deliveryId": "…", "event": "page.created", "workspaceId": "…",
  "data": { "pageId": "…", "via": "api" },
  "sentAt": "2026-10-15T17:00:00.000Z" }
```

Verify (v2) by recomputing `HMAC-SHA256(secret, "<t>.<rawBody>")` and comparing
it against `v1` with a timing-safe compare, and reject deliveries whose
`|now − t|` exceeds 300 s. The legacy bare-HMAC form (HMAC of `rawBody` alone)
is still accepted so pre-v2 receivers keep verifying. The only REST route that
*triggers* a dispatch today is
`POST /api/v1/pages` (§6); the other emitters are server actions
(`src/server/actions/{pages,database,comments,page-menu}.ts`).

---

## 10. OAuth (third-party apps registered in settings)

Apps are registered in workspace settings → **OAuth apps**
(`OAuthAppManager` in
[`src/components/oauth-app-manager.tsx`](../src/components/oauth-app-manager.tsx)
→ `createOAuthAppAction`
in [`src/server/actions/oauth-apps.ts`](../src/server/actions/oauth-apps.ts)):
name + one or more redirect URIs; returns `clientId` (`noema_<12 chars>`) and
`clientSecret` **once**.

Flow:

1. App redirects the user to **`GET /oauth/authorize?client_id=…&redirect_uri=…&state=…`**
   (a page, [`src/app/oauth/authorize/page.tsx`](../src/app/oauth/authorize/page.tsx),
   not a route handler).
2. User approves → browser POSTs to **`POST /oauth/authorize/complete`**.
3. App exchanges the code at **`POST /oauth/token`** → a normal Bearer API
   token (same table as §1.2).

### `POST /oauth/authorize/complete` — issue an authorization code
Source: [`src/app/oauth/authorize/complete/route.ts`](../src/app/oauth/authorize/complete/route.ts) ·
cookie session · no rate limit

`application/x-www-form-urlencoded` or multipart: `client_id`,
`redirect_uri`, `state`, `decision` (`allow` | anything else = deny).

- Code: `randomToken(24)`, valid **5 minutes**, single-use (marked used at
  exchange), bound to client + redirect URI.
- **303** → `<redirect_uri>?code=…&state=…` (allow) or
  `<redirect_uri>?error=access_denied&state=…` (deny).
- **401** `Unauthorized` (no session) · **400** `Invalid request`
  (unknown client or unregistered redirect URI).

### `POST /oauth/token` — authorization_code → access token
Source: [`src/app/oauth/token/route.ts`](../src/app/oauth/token/route.ts) ·
rate scope `oauth-token` (30/min)

Form body: `grant_type=authorization_code`, `code`, `client_id`,
`client_secret`, `redirect_uri`, `code_verifier` (only when the app sent a
`code_challenge`).

**200**
```json
{ "access_token": "noema_<24 chars>", "token_type": "Bearer", "scope": "read write" }
```
| Error | Body |
|---|---|
| 400 | `{"error":"unsupported_grant_type"}` |
| 401 | `{"error":"invalid_client"}` — unknown client or wrong secret |
| 400 | `{"error":"invalid_grant"}` — code unknown / already used / wrong client / wrong redirect URI / expired |
| 429 | rate limited |

The code is single-use. It is consumed with a conditional update
(`UPDATE … WHERE used = false`) and the token is minted only when that update
matched exactly one row, so two exchanges of the same code cannot both
succeed: the loser is refused with `invalid_grant`. A refused exchange — a
wrong client, a wrong redirect URI, a wrong PKCE verifier — never consumes
the code, so it stays usable.

The minted token is a regular API token named `OAuth: <app name>` and works on
`/api/v1/*` (§6).

---

## 11. Tickets

Source: [`src/app/api/tickets/route.ts`](../src/app/api/tickets/route.ts) ·
cookie session. Backing logic: `src/server/actions/tickets.ts` +
`getTickets`/`getLabels` in `src/server/queries.ts`.

### `GET /api/tickets?workspaceId=…&archived=true|false`
Rate scope `tickets-read` (120/min).

**200**
```json
{
  "tickets": [ { "id":"…", "key":"ACS-12", "number":12, "title":"Ship it",
                 "type":"task", "status":"in_progress", "priority":"high",
                 "estimate":3, "estimateUnit":"points",
                 "startDate":null, "dueDate":"2026-10-21", "completedAt":null,
                 "updatedAt":"…", "parentId":null, "cycleId":null,
                 "project":{"id":"…","name":"Web","icon":"🌐"},
                 "milestone":null,
                 "assignee":{"id":"…","name":"Ada","email":"ada@…"},
                 "labels":[{"label":{"id":"…","name":"infra","color":"#f00"}}],
                 "_count":{"children":0,"comments":2} } ],
  "labels":  [ { "id":"…", "name":"infra", "color":"#f00",
                 "description":null, "_count":{"tickets":4} } ],
  "role": "ADMIN"
}
```
- Non-archived unless `archived=true`; capped at 500 rows.
- Tickets are **not page-scoped**, so the listing is a full-member view: a
  `GUEST` gets a **403** `Forbidden` and no rows are read.
- Errors: **401** `Unauthorized` · **403** `Forbidden` (no workspace access
  **or role `GUEST`**) · **404** `Workspace not found` (no access) · **429**.

### `POST /api/tickets` — one dispatch endpoint, 13 actions
Rate scope `tickets-write` (60/min). Body `{ "action": "…", … }`.
Every action delegates to the same server action the UI uses. Success → **200**
with the action's `{ok:true, …}` payload; action failure → **400**
`{"error":"…"}`; unknown action → **400** `{"error":"Unknown action."}`.

| `action` | Required fields | Optional fields | 200 payload |
|---|---|---|---|
| `create` | `workspaceId`, `title` | `description,type,status,priority,estimate(number\|null),estimateUnit,startDate,dueDate,projectId,milestoneId,assigneeId,parentId` (string or `null`), `labelIds[]` | `{"ok":true,"id":"…","key":"ACS-13"}` |
| `update` | `ticketId` | same as `create` + `archived(boolean)` | `{"ok":true}` |
| `label` | `ticketId`, `labelId` | — | `{"ok":true,"attached":true}` |
| `relation` | `fromId`, `toId` | `type` | `{"ok":true}` |
| `unlink` | `relationId` | — | `{"ok":true}` |
| `comment` | `ticketId`, `body` | — | `{"ok":true,"id":"…"}` |
| `archive` | `ticketId` | `archived` (default `true`) | `{"ok":true}` |
| `bulk` | `ticketIds[]` | `status,priority,assigneeId,projectId` | `{"ok":true,"updated":3}` |
| `move` | `ticketId`, `status` | `beforeId` | `{"ok":true}` |
| `from-page` | `pageId` | — | `{"ok":true,"id":"…","key":"…"}` |
| `label-create` | `workspaceId`, `name` | `color`, `description` | `{"ok":true,"id":"…"}` |
| `label-update` | `labelId` | `name,color,description` | `{"ok":true}` |
| `label-delete` | `labelId` | — | `{"ok":true}` |

Example:

```json
{ "action": "create", "workspaceId": "…", "title": "Fix login redirect",
  "type": "bug", "priority": "high", "dueDate": "2026-10-22",
  "labelIds": ["…"] }
```

---

## 12. Calendar

Source: [`src/app/api/calendar/route.ts`](../src/app/api/calendar/route.ts) ·
cookie session · backing actions `src/server/actions/calendar.ts`.

### `GET /api/calendar?workspaceId=…` — scope `calendar-read` (120/min)

```json
{
  "feeds":  [ { "id":"…", "name":"Team",
                "color":"#3b82f6", "_count":{"events":24} } ],
  "events": [ { "id":"…", "title":"Sprint review",
                "start":"2026-10-16T17:00:00.000Z", "end":"…",
                "allDay":false, "location":"Room 2", "url":null,
                "notesPageId":null,
                "feed": { "name":"Team", "color":"#3b82f6" } } ]
}
```
Upcoming events: top 25. Calendar events are **not page-scoped**, so the
listing is a full-member view: a `GUEST` gets a **403** `Forbidden` and no
event is read. Errors: **401** · **403** `Forbidden` (no workspace access **or
role `GUEST`**) · **404** `Workspace not found` · 429.

`url` is the event's `URL:` property from the feed. Only an `http`, `https`,
`mailto` or `tel` URL is imported and rendered — every other scheme, a
`javascript:` URL for instance, is dropped and the field is `null` for it. A
relative path (`/w/acme/page`) and a same-document target (`?q=1`, `#section`)
are kept. The stored value is checked again on the way out: this response
and the ICS export (`?format=ics`) leave out a URL that is not on the
allowlist, so an event stored before the fix cannot leak one either.

The subscription's own URL (`icsUrl`) is not part of the response: it is the
private address of a personal calendar and often carries a secret token in its
path, so it stays on the server, which reads the feed itself. A feed is
connected with `{"action":"connect", …}` and its events are listed here.

### `POST /api/calendar` — scope `calendar-write` (30/min)

```jsonc
{ "action": "connect",    "workspaceId": "…", "name": "Team", "icsUrl": "https://…/basic.ics" }
{ "action": "refresh",    "workspaceId": "…" }
{ "action": "disconnect", "feedId": "…" }
{ "action": "notes",      "eventId": "…" }
```

| `action` | 200 payload |
|---|---|
| `connect` | `{"ok":true,"id":"…","imported":14}` |
| `refresh` | `{"ok":true,"refreshed":14}` |
| `disconnect` | `{"ok":true}` |
| `notes` | `{"ok":true,"id":"…","slug":"…","existing":false}` (creates/links a meeting-note page) |

Errors: 400 (`Invalid JSON body.` / `Unknown action.` / action `{error}`) ·
401 · 429.

---

## 13. Invites & email

Source: [`src/app/api/invites/route.ts`](../src/app/api/invites/route.ts) ·
cookie session · backing `src/server/actions/email.ts`,
`src/server/actions/teamspace-invites.ts`.

### `GET /api/invites?workspaceId=…` — scope `invites-read` (60/min)

Returns the 25 most recent email deliveries:

```json
{ "deliveries": [ { "id":"…", "to":"ada@example.com", "subject":"You are invited",
                    "kind":"invite", "status":"sent", "error":null,
                    "createdAt":"…" } ] }
```

Permission: admin only — the route asks the role matrix (`inviteMember`, i.e.
owner/admin) before it lists anything, so a member or a guest gets 403
`Forbidden` and the deliveries are never read. `listEmailDeliveries` keeps its
own member-managing check as the second line of defence. Errors: 401 · 403
`Forbidden` · 404 `Workspace not found` · 429.

### `POST /api/invites` — scope `invites-write` (20/min)

```jsonc
{ "target": "workspace", "workspaceId": "…", "email": "ada@example.com", "role": "GUEST" | "MEMBER" | "ADMIN" }
{ "target": "teamspace", "teamspaceId": "…", "email": "ada@example.com", "role": "MEMBER" | "ADMIN" }
```

- Workspace invite (default when `target` ≠ `"teamspace"`; role defaults to
  `MEMBER`) → **200** `{"ok":true,"link":"…","emailed":true,"warning":null}`
  (`warning` present when SMTP is unconfigured and the link must be shared
  manually). The role an invitation carries is a grant and goes through the
  same policy as a role change: an admin may invite `MEMBER`/`GUEST` only, and
  only the workspace owner may invite an `ADMIN` (400 `Only the workspace
  owner can invite an admin.` otherwise).
- Teamspace invite → **200**
  `{"ok":true,"invited":true,"added":false,"link":"…","email":"…","emailed":true}`.
- Errors: 400 (`Invalid JSON body.` / action `{error}` such as unknown
  workspace, invalid email, no permission) · 401 · 429.

---

## 14. Chat & AI (cookie session)

### `GET /api/chat?workspaceId=…` — scope `chat-read` (120/min)
Source: [`src/app/api/chat/route.ts`](../src/app/api/chat/route.ts)

```json
{ "threads": [ { "id":"…", "title":"Design review", "pageId":null,
                 "page":null,
                 "messages": [ { "id":"…", "body":"…", "role":"user",
                                 "meta":null, "createdAt":"…",
                                 "user":{"name":"Ada","email":"ada@…"} } ] } ] }
```
Latest 20 threads with their messages. Discussions are **not page-scoped**, so
the listing is a full-member view: a `GUEST` gets a **403** `Forbidden` and no
thread is read. Errors: 401 · 403 `Forbidden` (no workspace access **or role
`GUEST`**) · 404 `Workspace not found` · 429.

### `POST /api/chat` — scope `chat-write` (60/min)

```jsonc
{ "action": "create", "workspaceId": "…", "title": "Optional title" }
{ "action": "post",   "threadId": "…", "body": "How do I …?" }
{ "action": "rename", "threadId": "…", "title": "New title" }
{ "action": "delete", "threadId": "…" }
```

| `action` | 200 payload |
|---|---|
| `create` | `{"ok":true,"id":"…","reused":false}` |
| `post` | `{"ok":true,"id":"…","title":"…","answered":true}` |
| `rename` / `delete` | `{"ok":true}` |

Errors: 400 (`Invalid JSON body.` / `Unknown action.` / action `{error}`) ·
401 · 429.

### `POST /api/chat/stream` — streamed grounded answer — scope `chat-stream` (20/min)
Source: [`src/app/api/chat/stream/route.ts`](../src/app/api/chat/stream/route.ts)

```json
{ "threadId": "…", "body": "Summarize the roadmap" }
```

- The user message is persisted **before** streaming; the assistant message
  after. First message auto-names the thread (60 chars).
- **200** is a **plain-text stream** (`text/plain; charset=utf-8`,
  `cache-control: no-store`, `x-accel-buffering: no`) — UTF-8 chunks as the
  model emits them. Provider failures after headers are sent travel
  **in-band** as `\n\n[stream-error] <detail>`.
- Errors before streaming: **400** `Invalid JSON body` /
  `Write something first.` (empty or >4000 chars trimmed) · **401** ·
  **403** `You do not have permission to post here.` (read-only role) ·
  **404** `Discussion not found.` · **503** `AI is not configured for this
  workspace.` · 429.

### `POST /api/ai` — OpenAI-compatible completion proxy — scope `ai` (30/min)
Source: [`src/app/api/ai/route.ts`](../src/app/api/ai/route.ts)

```jsonc
{ "mode": "ask" | "summarize" | "autofill",   // default "ask"
  "prompt": "…",      // ≤4000 chars, required for ask/autofill
  "context": "…",     // ≤8000 chars, required for summarize
  "maxTokens": 2000,  // optional, clamped to 64…8000
  "workspaceId": "…" } // optional: a workspace id
```

- Modes: `ask` (grounded Q&A), `summarize` (context → Markdown summary),
  `autofill` (single database cell value, temperature 0.1, ≤60 tokens).
- The body is validated against a schema (`src/lib/validation.ts`): `mode` is
  one of `ask` / `summarize` / `autofill`, `workspaceId` is a workspace id
  (or absent / `null` for the environment configuration) and `maxTokens` an
  integer. A body that does not fit is refused with **400**
  `Invalid request body`; a body that fits but is longer than the caps above
  is trimmed, not refused. The schema's own free-text bound sits far above
  those caps (200 000 characters) on purpose: the route trims, so a long
  editor selection must become an answer and not an error. The body is
  buffered before the schema runs, so the bound is not a request-size limit.
- `workspaceId` also selects the provider: the workspace's own endpoint and
  API key are used **only** when the caller has access to that workspace.
  Otherwise the environment configuration (`AI_API_KEY` / `AI_BASE_URL` /
  `AI_MODEL`) applies, and the other workspace's provider is never read. The
  same rule grounds "ask" in the workspace search (5 hits).
- **200** `{"text":"…"}`
- Errors: **400** `Invalid JSON body` / `Invalid request body` /
  `prompt is required` / `context is required to summarize` /
  `prompt is required to autofill` ·
  **401** · **503** `AI is not configured. Add a provider in workspace
  settings (AI) or set AI_API_KEY / AI_BASE_URL / AI_MODEL.` ·
  provider failures returned as `{error}` with the upstream status · 429.

### `POST /api/ai/skills` — editor AI skills — scope `ai-skills` (30/min)
Source: [`src/app/api/ai/skills/route.ts`](../src/app/api/ai/skills/route.ts)

```json
{ "skillId": "improve", "text": "teh sentnce…", "workspaceId": null }
```
Skill ids: `improve`, `proofread`, `reformat`, `shorten`, `explain`,
`summarize`, `translate` (`src/lib/ai-skills.ts`).

**200**
```json
{ "skill": "improve", "replacesSelection": true, "text": "the sentence…" }
```
- The body is validated against a schema (`src/lib/validation.ts`): a body
  that does not fit is refused with **400** `Invalid request body.`. A
  `workspaceId` is a workspace id, or absent / `null` for the environment
  configuration.
- `workspaceId` selects the provider under the same rule as `/api/ai`: the
  workspace's own endpoint and API key are used only when the caller has
  access to that workspace, the environment configuration applies otherwise.
- Errors: 400 (`Invalid JSON body.` / `Invalid request body.` /
  `Unknown skill.` / `text is required.`,
  text capped at 8000) · 401 · 503 (AI unconfigured) · 429.

### `POST /api/ai/transcribe` — speech-to-text — scope `transcribe` (10/min)
Source: [`src/app/api/ai/transcribe/route.ts`](../src/app/api/ai/transcribe/route.ts)

`multipart/form-data` with `file`. Proxied to
`AI_TRANSCRIBE_BASE_URL` (default `https://api.openai.com/v1`) +
`/audio/transcriptions` using `AI_TRANSCRIBE_MODEL` (default `whisper-1`) and
`AI_TRANSCRIBE_API_KEY` / `OPENAI_API_KEY`.

- **200** `{"text":"…"}` · **400** `file is required` · **401** ·
  **503** `Transcription is not configured. Set AI_TRANSCRIBE_API_KEY …` ·
  **502** `Transcription failed (<upstatus>): …` or transport message · 429.

---

## 15. Share unlock

### `POST /s/[token]/unlock`
Source: [`src/app/s/[token]/unlock/route.ts`](../src/app/s/[token]/unlock/route.ts) ·
public · rate scope `share-unlock-<token>` (5/min) · attempt brake per share link

Form body: `password`. Delegates to `attemptShareUnlock(token, password)`
(`src/server/actions/share.ts`).

Two brakes guard the password: the rate limit's **scope** names the share
link, the attempt counter is **keyed** by it.

1. **Rate limit** — scope `share-unlock-<token>`, 5 requests per minute
   (`src/lib/api-guard.ts`). The bucket key is `share-unlock-<token>:<ip>`,
   so a caller that rotates its forwarded ip gets a fresh rate-limit budget.
2. **Attempt counter** — `attemptShareUnlock` counts failed attempts per
   share token, so rotating the forwarded ip does not reset the budget:
   10 failed attempts lock the link for 15 minutes, the budget is restored
   after 60 minutes of silence, and a successful unlock clears the count.
   While a link is locked **no password is compared at all** (fail closed).

| Case | Response |
|---|---|
| Over 5 requests/min for the link | **429** `{"error":"Rate limit exceeded"}` with `retry-after` (seconds) |
| Link locked (10 failed attempts) | **429** `{"error":"Too many unlock attempts"}` with `retry-after` (seconds, until the lock expires) |
| Wrong password | **303** → `/s/<token>?error=1` (no JSON body) |
| Correct password | **303** → `/s/<token>`, cookie `share_<token>` (`httpOnly`, `lax`, `secure` in production, 7 days) |

The cookie value is an HMAC-SHA256 over the share token and an expiry, keyed
by `AUTH_SECRET`; it is verified server-side, so a forged value unlocks
nothing — the constant `"1"` that the route used to hand out is never
issued.

The rate limit and the attempt counter are in-process (like every other
limiter in §3): a multi-instance deployment needs a shared store.

---

## 16. Admin / cron

### `POST /api/cron/templates` — materialize recurring templates
Source: [`src/app/api/cron/templates/route.ts`](../src/app/api/cron/templates/route.ts) ·
auth: `x-cron-secret` · rate scope `cron` (12/min)

Point a scheduler (cron, Vercel Cron, GitHub Actions, Task Scheduler) at it:

```bash
curl -X POST http://localhost:3200/api/cron/templates \
  -H "x-cron-secret: $CRON_SECRET"
```

Behavior: finds every `Template` with `recurrence != null` and
`nextRunAt <= now`, creates a child page under its database (copying title,
icon, content, and configured property values), advances `nextRunAt` via
`nextRunFor(recurrence)`; deleted/missing databases are skipped but still
rescheduled.

**200** `{"due":3,"created":2}`

| Case | Response |
|---|---|
| `CRON_SECRET` unset | `503 {"error":"CRON_SECRET is not configured. …"}` (fail-closed, checked before rate limit) |
| Wrong/missing header | `401 {"error":"Unauthorized"}` |
| Over 12 calls/min | `429 {"error":"Rate limit exceeded"}` |

---

## Appendix A — endpoint index (31 endpoints / 26 route files)

| # | Method | Path | Auth | Rate scope | File |
|---|---|---|---|---|---|
| 1 | GET | `/api/v1/workspaces` | Bearer | `v1` | `src/app/api/v1/workspaces/route.ts` |
| 2 | GET | `/api/v1/pages` | Bearer | `v1` | `src/app/api/v1/pages/route.ts` |
| 3 | POST | `/api/v1/pages` | Bearer | `v1` | `src/app/api/v1/pages/route.ts` |
| 4 | GET | `/api/v1/pages/[pageId]` | Bearer | `v1` | `src/app/api/v1/pages/[pageId]/route.ts` |
| 5 | GET | `/api/v1/search` | Bearer | `v1` | `src/app/api/v1/search/route.ts` |
| 6 | GET | `/api/auth/sso/start` | public | — | `src/app/api/auth/sso/start/route.ts` |
| 7 | GET | `/api/auth/sso/callback` | public (state/nonce) | — | `src/app/api/auth/sso/callback/route.ts` |
| 8 | POST | `/oauth/authorize/complete` | cookie | — | `src/app/oauth/authorize/complete/route.ts` |
| 9 | POST | `/oauth/token` | client credentials | `oauth-token` | `src/app/oauth/token/route.ts` |
| 10 | POST | `/api/templates` | cookie | `templates` | `src/app/api/templates/route.ts` |
| 11 | GET | `/api/link-preview` | cookie | `preview` | `src/app/api/link-preview/route.ts` |
| 12 | POST | `/api/upload` | cookie | `upload` | `src/app/api/upload/route.ts` |
| 13 | GET | `/api/files/[workspaceId]/[name]` | cookie | — | `src/app/api/files/[...path]/route.ts` |
| 14 | GET | `/api/export/page/[pageId]` | cookie | — | `src/app/api/export/page/[pageId]/route.ts` |
| 15 | GET | `/api/export/database/[pageId]` | cookie | — | `src/app/api/export/database/[pageId]/route.ts` |
| 16 | GET | `/api/export/workspace/[slug]` | cookie | — | `src/app/api/export/workspace/[slug]/route.ts` |
| 17 | POST | `/api/import/notion` | cookie | `notion-import` | `src/app/api/import/notion/route.ts` |
| 18 | GET | `/api/tickets` | cookie | `tickets-read` | `src/app/api/tickets/route.ts` |
| 19 | POST | `/api/tickets` | cookie | `tickets-write` | `src/app/api/tickets/route.ts` |
| 20 | GET | `/api/calendar` | cookie | `calendar-read` | `src/app/api/calendar/route.ts` |
| 21 | POST | `/api/calendar` | cookie | `calendar-write` | `src/app/api/calendar/route.ts` |
| 22 | GET | `/api/invites` | cookie | `invites-read` | `src/app/api/invites/route.ts` |
| 23 | POST | `/api/invites` | cookie | `invites-write` | `src/app/api/invites/route.ts` |
| 24 | GET | `/api/chat` | cookie | `chat-read` | `src/app/api/chat/route.ts` |
| 25 | POST | `/api/chat` | cookie | `chat-write` | `src/app/api/chat/route.ts` |
| 26 | POST | `/api/chat/stream` | cookie | `chat-stream` | `src/app/api/chat/stream/route.ts` |
| 27 | POST | `/api/ai` | cookie | `ai` | `src/app/api/ai/route.ts` |
| 28 | POST | `/api/ai/skills` | cookie | `ai-skills` | `src/app/api/ai/skills/route.ts` |
| 29 | POST | `/api/ai/transcribe` | cookie | `transcribe` | `src/app/api/ai/transcribe/route.ts` |
| 30 | POST | `/api/cron/templates` | `x-cron-secret` | `cron` | `src/app/api/cron/templates/route.ts` |
| 31 | POST | `/s/[token]/unlock` | share password | `share-unlock-<token>` | `src/app/s/[token]/unlock/route.ts` |

## Appendix B — domains with **no** REST surface

These exist as server actions (`"use server"`) only; they are not callable
over HTTP and are therefore out of scope for this reference:

| Domain | Source |
|---|---|
| Page/database CRUD & block editing (non-`v1`) | `src/server/actions/pages.ts`, `database.ts`, `linked-database.ts`, `page-menu.ts` |
| Page comments (only *ticket* comments are reachable via `POST /api/tickets`) | `src/server/actions/comments.ts` |
| In-app search UI | `src/server/actions/search.ts` |
| Sharing / permissions / password-protected shares (config side) | `src/server/actions/share.ts`, `page-permissions.ts` |
| Webhook & OAuth-app & API-token management (config side; §9/§10/§1.2) | `src/server/actions/{webhooks,oauth-apps,tokens}.ts` |
| Notifications, mentions, cycles, projects, ticket views, two-factor, preferences, email config, workspaces, teamspaces, page versions | `src/server/actions/*.ts` |

`POST /api/tickets` is the exception that proves the rule: it is an
action-dispatch shim, so ticket comments/labels/relations *are* reachable over
HTTP (§11).

## Appendix C — environment variables referenced by API routes

| Var | Used by |
|---|---|
| `AUTH_SECRET` | session JWT signing (all cookie routes) |
| `SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_REDIRECT_URI` | `/api/auth/sso/*` |
| `CRON_SECRET` | `/api/cron/templates` |
| `AI_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` | `/api/ai`, `/api/ai/skills`, `/api/chat/stream` |
| `AI_TRANSCRIBE_API_KEY` (+ `OPENAI_API_KEY` fallback), `AI_TRANSCRIBE_BASE_URL`, `AI_TRANSCRIBE_MODEL` | `/api/ai/transcribe` |
| `STORAGE_DIR`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_PREFIX` | `/api/upload`, `/api/files/*` |
