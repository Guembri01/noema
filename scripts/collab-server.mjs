// Minimal Yjs WebSocket server (y-websocket wire protocol) for Noema.
// Usage: node scripts/collab-server.mjs   (env: PORT=1234 HOST=127.0.0.1)
//
// One Y.Doc per room (room = page id). Documents are kept in memory and
// broadcast to every other connection. Awareness (cursors/presence) is
// relayed and cleaned up on disconnect.
//
// ---------------------------------------------------------------------------
// Join authorization (B53 / spec realtime-collab.md M1 — R9.1, R9.2, R9.5,
// R9.7, read-only half of R9.3). Fail closed everywhere:
//
//  1. R9.1  the HTTP upgrade must carry a valid `noema_session` cookie,
//           verified with the same primitive as `src/lib/auth.ts` (HS256 JWT
//           signed with `AUTH_SECRET`, `sub` = user id). Missing/invalid/short
//           secret -> close 4401, and the room name is not parsed before that
//           check succeeds.
//  2. R9.2  the page behind the room must be readable by that user: workspace
//           membership (`getWorkspaceAccess` semantics), guest page scoping
//           (`guestVisiblePageIds` semantics) and not trashed. Denial ->
//           close 4403.
//  3. R9.7  4403 is returned verbatim for "page does not exist", "not a
//           member" and "guest not scoped to this page": same code, same
//           reason, no existence oracle. Room ids are normalized to an
//           internal `page:<id>` key (R9.5); junk/traversal names are refused
//           identically.
//  4. R9.3  a grant with `write: false` (guest, READ/COMMENT page permission,
//           locked page) still joins read-only: document updates are dropped,
//           awareness is still relayed.
//
// Contract of the injected hooks (tests use these; production defaults below):
//   verifySession(cookieHeader) -> userId | null
//   authorize(userId, pageId)   -> { read: true, write: boolean } | null
//   resolveIdentity(userId)     -> { name, avatarUrl } | null
//
// ---------------------------------------------------------------------------
// B75 — M1.5 hardening (B53's disclosed residuals, spec R9.6 / R9.16):
//
//  5. R9.6  rate limits: at most 5 concurrent connections per verified user
//           (the overflow closes 4429 "rate-limited") and at most 30 messages
//           per connection per 10 s sliding window (the 31st closes 4429).
//           Clock injectable via `createCollabServer({ rateLimitClock })`.
//  6. R9.16 presence identity binding: the `user: {id,name,color,avatarUrl}`
//           field of EVERY inbound awareness update is replaced server-side
//           with the verified identity — display name resolved from the DB
//           once at join (cached on the connection), colour a stable hash of
//           the user id (R9.17 palette). Client claims are never relayed.
//  7. Origin (B64 — the rule changed from permissive to fail closed): the
//           upgrade `Origin` is checked BEFORE the session check.
//           · `APP_ORIGINS` configured (comma-separated, normalized like
//             `next.config.ts:34-37`): ONLY the listed origins connect; a
//             missing or empty Origin fails closed (close 4400).
//           · `APP_ORIGINS` unset — the repo's default posture: ONLY the
//             loopback origin (`localhost`, `127.0.0.1`, `[::1]`) connects.
//             A foreign origin (any page in the network) is refused with
//             4400, and so is an EMPTY Origin header: it names no origin,
//             and no browser sends one.
//           · A MISSING Origin header is accepted, because no browser omits
//             it on a WebSocket handshake — only a native client
//             (`check-collab.mjs`, the desktop sidecar, the tests) sends
//             none, and a native client cannot be the cross-site attacker
//             the Origin check exists for. It still has to pass the session
//             check (4401) and the page authorization (4403).
//           A networked deployment therefore has to name its origins in
//           `APP_ORIGINS` (see docs/OPERATIONS.md §5.4).
//
//  8. B64 — the network posture of the relay:
//           · the default bind address is the loopback interface
//             (`127.0.0.1`); `HOST=0.0.0.0` is an explicit opt-in for a
//             networked deployment and is never the default;
//           · a single WebSocket message is capped at `MAX_PAYLOAD_BYTES`
//             (4 MiB — the app's own budget for a page's content in one
//             request); `ws` would otherwise accept 100 MiB per message.
//
// Known gaps (still open):
// no mid-session lock re-evaluation (R9.4 — join-time only), no byte-rate cap
// (512 KiB/s half of R9.6 — the per-MESSAGE cap of B64 does not replace it),
// handshake *churn* bounded only by the concurrency cap, and the residual
// timing side channel from B53.
// ---------------------------------------------------------------------------
import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { jwtVerify } from "jose";
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** Close codes (private range, per spec R9.1/R9.2). */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_FORBIDDEN = 4403;
/** B75: Origin not on the `APP_ORIGINS` allow-list (answered pre-auth). */
export const CLOSE_BAD_ORIGIN = 4400;
/** B75 / R9.6: connection or message-rate limit exceeded. */
export const CLOSE_RATE_LIMITED = 4429;

const SESSION_COOKIE = "noema_session";
const AUTH_TIMEOUT_MS = 5000;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const KNOWN_ROLES = new Set(["OWNER", "ADMIN", "MEMBER", "GUEST"]);
const EDIT_LEVELS = new Set(["EDIT", "FULL"]);

// R9.6 defaults: concurrent connections per verified user, and messages per
// connection per sliding window. Injected as options for tests.
const MAX_CONNECTIONS_PER_USER = 5;
const MESSAGE_LIMIT = 30;
const MESSAGE_WINDOW_MS = 10_000;
const MAX_NAME_LENGTH = 128;

/**
 * The interface the relay binds to when the operator names none (B64).
 *
 * Loopback only: the relay carries the live document content, so a default
 * that listens on every interface would publish it to the whole network.
 * `HOST=0.0.0.0` stays available as an EXPLICIT choice for a networked
 * deployment (a container, a host behind a reverse proxy) — it is simply
 * never the default.
 */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * The largest single WebSocket message the relay accepts (B64).
 *
 * `ws` defaults to 100 MiB per message, so one client could hand the relay
 * a message that fills its heap. 4 MiB is the app's own budget for a page's
 * content in one request (`MAX_CONTENT_BODY_BYTES`, `src/lib/body-limit.ts`),
 * i.e. the biggest document the product itself accepts; measured, a Yjs
 * update of a page costs 1.0–1.4× its content size (10 000 small blocks:
 * 976.6 KiB of text → 1.35 MiB of update), so the cap covers what the app
 * can store while staying 25× below the `ws` default.
 */
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Resolve the interface the relay binds to (B64).
 *
 * `HOST` wins when it names something; an unset, empty or blank `HOST` falls
 * back to {@link DEFAULT_HOST}. The empty case matters: `server.listen(port,
 * "")` binds to EVERY interface, so an empty `HOST` would have been the very
 * hole this default closes.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveHost(env = process.env) {
  const raw = typeof env?.HOST === "string" ? env.HOST.trim() : "";
  return raw.length > 0 ? raw : DEFAULT_HOST;
}

const PORT = Number(process.env.PORT ?? 1234);
const HOST = resolveHost(process.env);

// `npm run collab` starts this file directly (no `--env-file`), so load the
// repo `.env` once at import time when the secrets are not already set.
// `process.loadEnvFile` never overrides variables already in the environment.
let envLoaded = false;
function ensureEnv() {
  if (envLoaded) return;
  envLoaded = true;
  try {
    process.loadEnvFile();
  } catch {
    // No .env (e.g. variables injected by the environment) — verifySession
    // fails closed when AUTH_SECRET is absent.
  }
}
ensureEnv();

/* ------------------------------------------------------------------ *
 * Session verification (mirrors getSessionUserId in src/lib/auth.ts)
 * ------------------------------------------------------------------ */

/** Parse a `Cookie:` header into a plain object. */
export function parseCookieHeader(header) {
  const jar = Object.create(null);
  if (typeof header !== "string" || header.length === 0) return jar;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    if (!name) continue;
    jar[name] = pair.slice(index + 1).trim();
  }
  return jar;
}

/**
 * The AUTH_SECRET rule, mirrored from `src/lib/auth-secret.ts`.
 *
 * B55: this file runs under plain `node` (`npm run collab`) and therefore
 * cannot import the TypeScript module the app uses. What matters here is that
 * a session cookie is never accepted with a key everybody knows: the
 * placeholder this repository ships in `.env.example` is public, and a short
 * secret is not a key. `scripts/collab-server.test.mjs` reads the placeholder
 * out of `.env.example`, so the two copies cannot drift apart silently.
 */

/** Fold a value to its comparison form: trimmed, lowercased, no separators. */
function canonicalSecret(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Every placeholder this repository ships, mirrored from
 * `SHIPPED_AUTH_SECRET_PLACEHOLDERS` in `src/lib/auth-secret.ts`.
 *
 * `scripts/collab-server.test.mjs` reads the TypeScript list and fails if these
 * two drift apart. The `.env.example` value is the one an operator is most
 * likely to copy, but it is not the only public example: the self-hosting
 * documentation also ships a 32-character hex string, which would pass a
 * length-only check.
 */
export const SHIPPED_AUTH_SECRET_PLACEHOLDERS = [
  "replace-me-with-a-32-byte-hex-secret", // .env.example
  "0123456789abcdef0123456789abcdef", // src/lib/self-hosting.ts (AUTH_SECRET example)
  "sk-example-0000000000000000", // src/lib/self-hosting.ts (AI_API_KEY example)
  "sso-client-secret-value", // src/lib/self-hosting.ts (SSO_CLIENT_SECRET example)
  "smtp-password-value", // src/lib/self-hosting.ts (SMTP_PASSWORD example)
  "cron-secret-value", // src/lib/self-hosting.ts (CRON_SECRET example)
];

/** Well-known weak values, mirrored from `WEAK_AUTH_SECRETS`. */
export const WEAK_AUTH_SECRETS = [
  "changeme",
  "change-me",
  "your-secret-here",
  "example",
  "secret",
  "password",
  "placeholder",
  "replace-me",
  "todo",
  "tbd",
  "xxx",
];

const CANONICAL_PLACEHOLDERS = new Set(
  SHIPPED_AUTH_SECRET_PLACEHOLDERS.map(canonicalSecret),
);
const CANONICAL_WEAK = new Set(WEAK_AUTH_SECRETS.map(canonicalSecret));

/** Minimum length of an AUTH_SECRET that may verify a session cookie. */
const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * Whether a candidate AUTH_SECRET may be used to verify a session cookie.
 * A missing, too short, shipped-placeholder or well-known weak value is
 * refused. The application rule refuses the same set; the test below keeps the
 * two lists in step.
 */
export function isUsableAuthSecret(secret) {
  if (typeof secret !== "string") return false;
  const trimmed = secret.trim();
  if (trimmed.length < MIN_AUTH_SECRET_LENGTH) return false;
  const folded = canonicalSecret(trimmed);
  return !CANONICAL_PLACEHOLDERS.has(folded) && !CANONICAL_WEAK.has(folded);
}

/**
 * Verify the `noema_session` HS256 JWT exactly the way the app does
 * (`src/lib/auth.ts:getSessionUserId`) and return the user id, or null.
 * Fail closed: no cookie, no/short `AUTH_SECRET`, bad signature, expired
 * token or missing `sub` all yield null.
 */
export async function verifySessionCookie(cookieHeader) {
  const token = parseCookieHeader(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  const secret = process.env.AUTH_SECRET;
  if (!isUsableAuthSecret(secret)) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret.trim()), {
      algorithms: ["HS256"],
    });
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Origin policy (B75) — independent of the session check
 * ------------------------------------------------------------------ */

/**
 * Normalize one `APP_ORIGINS` entry the way `next.config.ts:34-37` does:
 * trim, strip a leading scheme and trailing slashes, lowercase. Empty
 * entries are dropped; an unset/empty value yields an empty list (= no
 * policy = the fail-closed default of `isOriginAllowed`).
 */
export function parseAppOrigins(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** The host names that address THIS machine's loopback interface. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether an `Origin` header names the loopback interface — the app served
 * from this very machine (`http://localhost:3200`, `http://127.0.0.1:3200`,
 * `http://[::1]:3200`).
 *
 * The port is irrelevant: the origin is the APP's, not the relay's, and the
 * relay's port is not known to the browser's page.
 */
export function isLoopbackOrigin(originHeader) {
  if (typeof originHeader !== "string") return false;
  const normalized = originHeader
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (normalized.length === 0) return false;
  const host = normalized.startsWith("[")
    ? normalized.slice(0, normalized.indexOf("]") + 1)
    : normalized.split(":")[0];
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Decide an upgrade's `Origin` header against a parsed allow-list (B64).
 *
 * The rule fails closed in every configuration:
 *
 * - Non-empty policy (`APP_ORIGINS` configured): only the listed origins
 *   connect. A missing or empty Origin is denied — non-browser clients have
 *   to be named too. Entries are matched scheme-insensitively against
 *   `host[:port]`, mirroring the app's Server-Action allow-list
 *   normalization.
 * - Empty policy (`APP_ORIGINS` unset — the repo default): only the
 *   LOOPBACK origin connects. A foreign origin (any page in the network)
 *   is refused with 4400, and so is an EMPTY Origin header: it names no
 *   origin, and no browser ever sends one.
 * - A MISSING Origin header is accepted in both cases, because no browser
 *   omits `Origin` on a WebSocket handshake: only a native client
 *   (`check-collab.mjs`, the desktop sidecar, the tests) sends none, and a
 *   native client cannot be the cross-site attacker the Origin check exists
 *   for. It still has to pass the session check (4401) and the page
 *   authorization (4403), so a missing header does not open the relay.
 *
 * Before B64 this rule was permissive whenever `APP_ORIGINS` was unset —
 * which, together with the default bind on every interface, let every page
 * in the network reach the relay.
 */
export function isOriginAllowed(originHeader, allowedOrigins) {
  const hasPolicy = Array.isArray(allowedOrigins) && allowedOrigins.length > 0;
  const raw = typeof originHeader === "string" ? originHeader.trim() : "";

  if (raw.length === 0) {
    // Present but empty: an Origin header that names no origin. Refused in
    // every configuration.
    if (typeof originHeader === "string") return false;
    // Absent: a native client (see above).
    return !hasPolicy;
  }

  const normalized = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  if (hasPolicy) return allowedOrigins.includes(normalized);
  return isLoopbackOrigin(raw);
}

/* ------------------------------------------------------------------ *
 * Room name (R9.5) — never trusted as an opaque string
 * ------------------------------------------------------------------ */

/**
 * Extract the page id from the upgrade URL. Accepts both client spellings
 * (`<pageId>` from `page-editor.tsx`, `page:<pageId>` from the spec contract)
 * and normalize to the same id; anything that is not a plausible id — empty,
 * traversal, oversized, control characters — is refused (null -> 4403).
 */
export function parseRoomPageId(url) {
  if (typeof url !== "string") return null;
  const path = url.split("?")[0].split("#")[0];
  let decoded;
  try {
    decoded = decodeURIComponent(path.replace(/^\/+/, ""));
  } catch {
    return null; // malformed percent-encoding
  }
  const pageId = decoded.startsWith("page:") ? decoded.slice("page:".length) : decoded;
  if (!ROOM_ID_PATTERN.test(pageId)) return null;
  return pageId;
}

/** The single internal room key — clients cannot choose their own namespace. */
function roomKey(pageId) {
  return `page:${pageId}`;
}

/* ------------------------------------------------------------------ *
 * Join rule (R9.2/R9.3/R9.7) — one pure home for the decision
 * ------------------------------------------------------------------ */

/**
 * Decide a join grant from already-loaded facts. Returns `{ read, write }` or
 * `null` (denied). Fail closed: unknown role, missing page, trashed page,
 * non-member, guest without scope, or a guest scope set that was not computed
 * all deny — and every denial is reported identically to the caller so the
 * transport can map them to one indistinguishable 4403 (R9.7).
 *
 * Mirrors `src/app/w/[slug]/[pageId]/page.tsx:76-81` (`editable`) plus
 * `getWorkspaceAccess` / `pageScopeFor`.
 */
export function decideAccess({ pageId, page, role, pagePermission, guestVisibleIds }) {
  if (!page || page.id !== pageId || page.deletedAt) return null;
  if (typeof role !== "string" || !KNOWN_ROLES.has(role)) return null;

  const isGuest = role === "GUEST";
  if (isGuest && !(guestVisibleIds instanceof Set && guestVisibleIds.has(pageId))) return null;

  const level = pagePermission?.level ?? null;
  const write =
    !isGuest &&
    !page.locked &&
    (level === null || EDIT_LEVELS.has(level));
  return { read: true, write };
}

/* ------------------------------------------------------------------ *
 * Production authorizer (Prisma-backed). Same queries as the app's
 * `getWorkspaceAccess` + `guestVisiblePageIds`; kept in this script because
 * `src/**` is not importable from `.mjs` — the spec's internal endpoint
 * (T9.1/O9.3) is the planned replacement for this port.
 * ------------------------------------------------------------------ */

let prismaClient = null;
function getPrisma() {
  ensureEnv();
  if (!prismaClient) prismaClient = new PrismaClient();
  return prismaClient;
}

/** `getWorkspaceAccess` semantics (src/lib/permissions.ts:10-26). */
async function resolveWorkspaceRole(prisma, userId, workspaceId) {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (member) return member.role;
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true },
  });
  return workspace?.ownerId === userId ? "OWNER" : null;
}

/** Port of `withAncestors` (src/lib/guest-access.ts:22-35). */
function withAncestors(visibleIds, pages) {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const result = new Set(visibleIds);
  for (const id of [...result]) {
    let cursor = byId.get(id)?.parentId ?? null;
    let guard = 0;
    while (cursor && guard < 200) {
      result.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
      guard += 1;
    }
  }
  return result;
}

/** Port of `guestVisiblePageIds` (src/lib/guest-access.ts:46-78). */
async function guestVisiblePageIds(prisma, userId, workspaceId) {
  const [permissions, memberships, created, pages] = await Promise.all([
    prisma.pagePermission.findMany({
      where: { userId, page: { workspaceId } },
      select: { pageId: true },
    }),
    prisma.teamspaceMember.findMany({
      where: { userId, teamspace: { workspaceId } },
      select: { teamspaceId: true },
    }),
    prisma.page.findMany({
      where: { workspaceId, createdById: userId, deletedAt: null },
      select: { id: true },
    }),
    prisma.page.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, parentId: true, teamspaceId: true },
    }),
  ]);

  const teamspaceIds = new Set(memberships.map((member) => member.teamspaceId));
  const direct = new Set([
    ...permissions.map((permission) => permission.pageId),
    ...created.map((page) => page.id),
  ]);
  for (const page of pages) {
    if (page.teamspaceId && teamspaceIds.has(page.teamspaceId)) direct.add(page.id);
  }
  return withAncestors(direct, pages);
}

/**
 * Production `authorize(userId, pageId)` — reads the page, resolves the role,
 * applies guest scoping and the join rule. Any failure (including a DB error)
 * propagates to the connection handler, which maps it to 4403.
 */
export async function authorizePageAccess(userId, pageId) {
  const prisma = getPrisma();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, workspaceId: true, deletedAt: true, locked: true },
  });
  if (!page) return null;
  const role = await resolveWorkspaceRole(prisma, userId, page.workspaceId);
  if (!role) return null;
  const [pagePermission, guestVisibleIds] = await Promise.all([
    prisma.pagePermission.findUnique({
      where: { userId_pageId: { userId, pageId } },
      select: { level: true },
    }),
    role === "GUEST"
      ? guestVisiblePageIds(prisma, userId, page.workspaceId)
      : Promise.resolve(null),
  ]);
  return decideAccess({ pageId, page, role, pagePermission, guestVisibleIds });
}

/* ------------------------------------------------------------------ *
 * Presence identity (R9.16 / R9.17) — server-owned, unspoofable
 * ------------------------------------------------------------------ */

/**
 * Fixed palette taken from the editor's `TEXT_COLORS` hues
 * (`src/components/editor/bubble-toolbar.tsx:33-44`), so a user's relay colour
 * matches their editor colour. One entry per named hue; the "Default" entry
 * (null) is intentionally not a colour.
 */
const PRESENCE_COLORS = [
  "#787774", "#9f6b53", "#d9730d", "#cb912f", "#448361",
  "#337ea9", "#9065b0", "#c14c8a", "#d44c47",
];

/**
 * Stable per-user colour: FNV-1a of the user id into the fixed palette
 * (R9.17). Pure, deterministic across processes — the same person keeps the
 * same colour on every page and after a server restart.
 */
export function colorForUserId(userId) {
  const text = String(userId);
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

/**
 * Production `resolveIdentity(userId)` — the display name behind the verified
 * JWT, fetched once at join and cached on the connection. Returns null for an
 * unknown user or an empty name, which makes the join fail closed: presence
 * cannot be bound, so the connection is refused.
 */
export async function resolveUserIdentity(userId) {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, avatarUrl: true },
  });
  if (!user || typeof user.name !== "string" || user.name.trim().length === 0) return null;
  return {
    name: user.name.trim(),
    avatarUrl:
      typeof user.avatarUrl === "string" && user.avatarUrl.length > 0 ? user.avatarUrl : null,
  };
}

/* ------------------------------------------------------------------ *
 * Rate limiting (R9.6) — per-user connections + per-connection messages
 * ------------------------------------------------------------------ */

/**
 * Sliding-window limiter with an injectable clock (B75). `active` counts
 * OPEN connections per verified user; each connection owns one message
 * window. Both failure modes close gracefully with 4429 "rate-limited".
 */
function createRateLimiter({ maxConnections, messageLimit, messageWindowMs, clock }) {
  const active = new Map(); // userId -> open connection count
  return {
    /** Take a connection slot; false when the user is already at the cap. */
    acquire(userId) {
      const current = active.get(userId) ?? 0;
      if (current >= maxConnections) return false;
      active.set(userId, current + 1);
      return true;
    },
    /** Return a slot (idempotent for callers that guard with a flag). */
    release(userId) {
      const current = active.get(userId) ?? 0;
      if (current <= 1) active.delete(userId);
      else active.set(userId, current - 1);
    },
    /** A fresh sliding window for one connection's inbound messages. */
    openWindow() {
      const stamps = [];
      return {
        /** True while the connection is inside the allowance. */
        allow() {
          const now = clock();
          while (stamps.length > 0 && now - stamps[0] >= messageWindowMs) stamps.shift();
          if (stamps.length >= messageLimit) return false;
          stamps.push(now);
          return true;
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Room registry + server
 * ------------------------------------------------------------------ */

function createRoom(rooms, key) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null); // the server holds no presence of its own
  const conns = new Map();

  const sendAll = (message, origin) => {
    for (const conn of conns.keys()) {
      if (conn !== origin) conn.send(message);
    }
  };

  doc.on("update", (update, origin) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    sendAll(encoding.toUint8Array(encoder), origin);
  });

  awareness.on("update", ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated, removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
    );
    sendAll(encoding.toUint8Array(encoder), origin);
  });

  const room = { doc, awareness, conns };
  rooms.set(key, room);
  return room;
}

function getRoom(rooms, key) {
  return rooms.get(key) ?? createRoom(rooms, key);
}

function withTimeout(value, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    Promise.resolve(value).then(
      (next) => {
        clearTimeout(timer);
        resolve(next);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function deny(conn, code, reason) {
  try {
    conn.close(code, reason);
  } catch {
    // socket already gone — the close is the point, nothing else to do
  }
}

/** True when a MESSAGE_SYNC payload is a pure state *request* (step 1). */
function isStateRequest(message) {
  try {
    const decoder = decoding.createDecoder(message);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return false;
    return decoding.readVarUint(decoder) === syncProtocol.messageYjsSyncStep1;
  } catch {
    return false;
  }
}

async function handleConnection(conn, request, deps) {
  // 0. Origin first — answered BEFORE the session check and before the room
  //    name is parsed (B75). Fail closed (B64): only the loopback origin, or
  //    the `APP_ORIGINS` allow-list, is accepted; a missing header is a
  //    native client and still has to pass the session check below.
  if (!isOriginAllowed(request.headers.origin, deps.origins)) {
    return deny(conn, CLOSE_BAD_ORIGIN, "origin not allowed");
  }

  // 1. Session first — no room name is parsed before this succeeds (R9.1).
  let userId = null;
  try {
    const verified = await withTimeout(
      deps.verifySession(request.headers.cookie),
      AUTH_TIMEOUT_MS,
      "session verification",
    );
    if (typeof verified === "string" && verified.length > 0) userId = verified;
  } catch {
    userId = null;
  }
  if (!userId) return deny(conn, CLOSE_UNAUTHORIZED, "unauthorized");

  // 2. Connection cap per verified user (R9.6): handshake spam cannot bypass
  //    it because the slot is taken before the room name is even parsed, and
  //    it is returned the moment the socket closes (denials included).
  if (!deps.limiter.acquire(userId)) {
    return deny(conn, CLOSE_RATE_LIMITED, "rate-limited");
  }
  let holdingSlot = true;
  const releaseSlot = () => {
    if (!holdingSlot) return;
    holdingSlot = false;
    deps.limiter.release(userId);
  };
  if (conn.readyState === WebSocket.CLOSED) releaseSlot();
  else conn.once("close", releaseSlot);

  // 3. Room name, normalized — junk names are indistinguishable from a
  //    forbidden page (R9.5/R9.7).
  const pageId = parseRoomPageId(request.url);
  if (!pageId) return deny(conn, CLOSE_FORBIDDEN, "forbidden");

  // 4. Page authorization — one 4403 for nonexistent / cross-workspace /
  //    out-of-scope guest alike (R9.2, R9.7).
  let grant = null;
  try {
    grant = await withTimeout(
      deps.authorize(userId, pageId),
      AUTH_TIMEOUT_MS,
      "page authorization",
    );
  } catch {
    grant = null; // fail closed (DB down, query error, timeout)
  }
  if (!grant || grant.read !== true) return deny(conn, CLOSE_FORBIDDEN, "forbidden");
  if (conn.readyState !== WebSocket.OPEN) return; // went away while deciding

  // 5. Verified identity (R9.16): display name resolved from the DB once at
  //    join and cached on this connection; colour derived from the user id.
  //    No resolvable identity -> no join (presence cannot be bound).
  let identity = null;
  try {
    const resolved = await withTimeout(
      deps.resolveIdentity(userId),
      AUTH_TIMEOUT_MS,
      "identity resolution",
    );
    if (resolved && typeof resolved.name === "string" && resolved.name.trim().length > 0) {
      identity = {
        id: userId,
        name: resolved.name.trim().slice(0, MAX_NAME_LENGTH),
        color: colorForUserId(userId),
        avatarUrl:
          typeof resolved.avatarUrl === "string" && resolved.avatarUrl.length > 0
            ? resolved.avatarUrl
            : null,
      };
    }
  } catch {
    identity = null; // fail closed (DB down, query error, timeout)
  }
  if (!identity) return deny(conn, CLOSE_UNAUTHORIZED, "unauthorized");
  if (conn.readyState !== WebSocket.OPEN) return; // went away while deciding

  // 6. Authorized — only now does the room exist.
  const { doc, awareness, conns } = getRoom(deps.rooms, roomKey(pageId));
  const controlledIds = new Set();
  const canWrite = grant.write === true;
  conns.set(conn, controlledIds);

  // Send our state to the client (sync step 1 + current presence).
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    conn.send(encoding.toUint8Array(encoder));
  }
  const states = awareness.getStates();
  if (states.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [...states.keys()]),
    );
    conn.send(encoding.toUint8Array(encoder));
  }

  const trackAwareness = ({ added, removed }, origin) => {
    if (origin !== conn) return;
    for (const id of added) controlledIds.add(id);
    for (const id of removed) controlledIds.delete(id);
  };
  awareness.on("update", trackAwareness);

  // One sliding window per connection (R9.6) — the clock is injectable so
  // tests can slide it deterministically.
  const window = deps.limiter.openWindow();

  conn.on("message", (data) => {
    // R9.6: every frame counts, malformed or not — a flood is a flood.
    if (!window.allow()) return deny(conn, CLOSE_RATE_LIMITED, "rate-limited");
    let message;
    try {
      message = new Uint8Array(data);
      const decoder = decoding.createDecoder(message);
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        // R9.3: a read-only grant may request state but never supply it —
        // step 2 responses and updates carry document state and are dropped.
        if (!canWrite && !isStateRequest(message)) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        if (encoding.length(encoder) > 1) conn.send(encoding.toUint8Array(encoder));
      } else if (type === MESSAGE_AWARENESS) {
        // Awareness stays relayable for read-only viewers (presence), and the
        // `user` field of every entry is rewritten to the verified identity
        // before anything reaches the room (R9.16): a client can only ever
        // announce its own name/colour/id, never somebody else's. All other
        // state (cursor, selection, …) passes through untouched.
        const update = decoding.readVarUint8Array(decoder);
        const bound = awarenessProtocol.modifyAwarenessUpdate(update, (state) =>
          state !== null && typeof state === "object" && !Array.isArray(state)
            ? { ...state, user: identity }
            : state,
        );
        awarenessProtocol.applyAwarenessUpdate(awareness, bound, conn);
      }
    } catch {
      // Malformed frame: ignore instead of crashing the process (a raw throw
      // here used to take the whole relay down).
    }
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    conns.delete(conn);
    awareness.off("update", trackAwareness);
    awarenessProtocol.removeAwarenessStates(awareness, [...controlledIds], null);
  };
  conn.on("close", cleanup);
  conn.on("error", cleanup);
}

/**
 * Create (but do not bind) a collab server. `verifySession`, `authorize` and
 * `resolveIdentity` are injectable so tests can drive the pipeline without a
 * database; the R9.6 clock (`rateLimitClock`) and caps are injectable too,
 * and the origin policy defaults to the `APP_ORIGINS` environment variable.
 * `host` defaults to {@link resolveHost} and `maxPayload` to
 * {@link MAX_PAYLOAD_BYTES} (B64).
 */
export function createCollabServer({
  verifySession = verifySessionCookie,
  authorize = authorizePageAccess,
  resolveIdentity = resolveUserIdentity,
  host = HOST,
  port = PORT,
  rooms = new Map(),
  rateLimitClock = Date.now,
  maxConnectionsPerUser = MAX_CONNECTIONS_PER_USER,
  messageLimit = MESSAGE_LIMIT,
  messageWindowMs = MESSAGE_WINDOW_MS,
  appOrigins = process.env.APP_ORIGINS,
  maxPayload = MAX_PAYLOAD_BYTES,
} = {}) {
  const limiter = createRateLimiter({
    maxConnections: maxConnectionsPerUser,
    messageLimit,
    messageWindowMs,
    clock: rateLimitClock,
  });
  const origins = parseAppOrigins(appOrigins);
  const wss = new WebSocketServer({ host, port, maxPayload });
  wss.on("connection", (conn, request) => {
    handleConnection(conn, request, {
      verifySession,
      authorize,
      resolveIdentity,
      rooms,
      limiter,
      origins,
    }).catch(() => deny(conn, CLOSE_FORBIDDEN, "forbidden"));
  });
  return { wss, rooms };
}

/* ------------------------------------------------------------------ *
 * CLI entry point (`npm run collab`)
 * ------------------------------------------------------------------ */

function start() {
  if (!isUsableAuthSecret(process.env.AUTH_SECRET)) {
    console.warn(
      "AUTH_SECRET is missing, too short or a known placeholder — every collaboration connection will be rejected (4401).",
    );
  }
  const { wss } = createCollabServer({ host: HOST, port: PORT });
  wss.on("listening", () => {
    const origins = parseAppOrigins(process.env.APP_ORIGINS);
    const originNote =
      origins.length > 0
        ? `origin allow-list: ${origins.length} entr${origins.length === 1 ? "y" : "ies"} (fail closed)`
        : "origin policy: APP_ORIGINS unset (loopback origins only — a networked deployment must set APP_ORIGINS)";
    console.log(
      `Noema collaboration server listening on ws://${HOST}:${PORT} (auth: session cookie + page authz; identity: DB-bound; rate: ${MAX_CONNECTIONS_PER_USER} conns/user, ${MESSAGE_LIMIT} msg/${MESSAGE_WINDOW_MS / 1000}s; payload: max ${MAX_PAYLOAD_BYTES} B/msg; ${originNote})`,
    );
  });
  wss.on("error", (error) => {
    console.error(`collab server error: ${error.message}`);
    process.exitCode = 1;
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) start();



