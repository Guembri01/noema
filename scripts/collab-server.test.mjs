// B53 — collab server room-join authorization (spec docs/specs/realtime-collab.md
// M1: R9.1, R9.2, R9.5, R9.7 + the read-only half of R9.3).
//
// Red-first: this file was written BEFORE scripts/collab-server.mjs exposed any
// authorization surface — the first run failed on the missing exports (the red
// tail is recorded in the PR).
//
// The connection pipeline is exercised with an INJECTED session verifier and
// page authorizer (per B53), so no database is touched. The real
// primitives are unit-tested directly: `verifySessionCookie` (the same HS256
// `noema_session` verification `src/lib/auth.ts` performs) and `decideAccess`
// (the join rule). The injected fakes reuse `decideAccess`, so the tests pin
// the production rule rather than a look-alike.
//
// B75 (red-first AGAIN, behavior-level): the three blocks at the bottom cover
// R9.6 rate limits, R9.16 presence identity binding and the APP_ORIGINS
// origin check. They were written BEFORE any of that surface existed and use
// only B53 exports + literal close codes (4429 / 4400), so the first run
// failed on behavior, not on imports — while these 30 stayed green.
import { afterEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  CLOSE_FORBIDDEN,
  CLOSE_UNAUTHORIZED,
  createCollabServer,
  decideAccess,
  parseRoomPageId,
  verifySessionCookie,
} from "./collab-server.mjs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 4000, interval = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeout) throw new Error("waitFor timed out");
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ *
 * Fake app layer: same contract as production, no DB.
 * ------------------------------------------------------------------ */

const PAGES = {
  pageA: { workspaceId: "wsA", deletedAt: null, locked: false },
  pageB: { workspaceId: "wsB", deletedAt: null, locked: false },
  pageShared: { workspaceId: "wsA", deletedAt: null, locked: false },
  pageLocked: { workspaceId: "wsA", deletedAt: null, locked: true },
  pageTrashed: { workspaceId: "wsA", deletedAt: new Date("2026-01-01"), locked: false },
};

const MEMBERSHIPS = {
  alice: { wsA: "MEMBER" },
  carol: { wsA: "MEMBER" },
  bob: { wsB: "MEMBER" },
  gina: { wsA: "GUEST" },
};

const GUEST_SCOPES = { gina: new Set(["pageShared"]) };

/** Verified identities (B75): what the DB-backed resolver would return. */
const IDENTITIES = {
  alice: { name: "Alice Anderson" },
  carol: { name: "Carol Carr" },
  bob: { name: "Bob Brown" },
  gina: { name: "Gina Green" },
};

/** Test double for `resolveIdentity(userId)` — name source, keyed by verified id. */
async function fakeResolveIdentity(userId) {
  return IDENTITIES[userId] ?? { name: userId };
}

/** Cookie-based session verifier (test double for `verifySessionCookie`). */
function fakeVerifySession(cookieHeader) {
  const match = /(?:^|;\s*)user=([a-z]+)/.exec(cookieHeader ?? "");
  return match ? match[1] : null;
}

/** Page authorizer that reuses the production join rule (`decideAccess`). */
function fakeAuthorize(userId, pageId) {
  const page = Object.hasOwn(PAGES, pageId) ? PAGES[pageId] : null;
  const role = page ? MEMBERSHIPS[userId]?.[page.workspaceId] ?? null : null;
  return decideAccess({
    pageId,
    page: page ? { id: pageId, ...page } : null,
    role,
    pagePermission: null,
    guestVisibleIds: role === "GUEST" ? GUEST_SCOPES[userId] ?? new Set() : null,
  });
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const servers = [];
const sockets = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.terminate();
    } catch {
      /* already gone */
    }
  }
  await Promise.all(
    servers.splice(0).map((entry) => new Promise((resolve) => entry.wss.close(resolve))),
  );
});

async function startServer(options = {}) {
  const server = createCollabServer({
    host: "127.0.0.1",
    port: 0,
    verifySession: fakeVerifySession,
    authorize: fakeAuthorize,
    resolveIdentity: fakeResolveIdentity,
    ...options,
  });
  await new Promise((resolve, reject) => {
    server.wss.once("listening", resolve);
    server.wss.once("error", reject);
  });
  servers.push(server);
  const { port } = server.wss.address();
  return { ...server, url: `ws://127.0.0.1:${port}` };
}

function connectRaw(url, room, cookie, headers = {}) {
  const ws = new WebSocket(`${url}/${room}?v=2`, {
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
  });
  sockets.push(ws);
  // Buffer messages from the very first tick: the relay's post-join step 1 can
  // arrive in the same TCP chunk as the upgrade response, i.e. BEFORE any test
  // code runs `nextMessage` (EventEmitter would drop a listener-less emit).
  ws.__inbox = [];
  ws.on("message", (data) => {
    ws.__inbox.push(new Uint8Array(data));
  });
  ws.on("error", () => {
    /* rejection surfaces through the close event */
  });
  return ws;
}

/** Resolves when the raw socket finishes the WS handshake. */
function waitOpen(ws, ms = 4000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error("socket never opened")), ms);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      reject(new Error(`closed before open: ${code} ${reason.toString()}`));
    });
  });
}

function waitClose(ws, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connection was never closed")), ms);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function nextMessage(ws, ms = 4000) {
  const started = Date.now();
  for (;;) {
    if (ws.__inbox?.length) return ws.__inbox.shift();
    if (Date.now() - started > ms) throw new Error("no message received");
    await sleep(10);
  }
}

/** Minimal y-websocket client (sync + awareness) for raw `ws` sockets. */
function connectDoc(url, room, cookie) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  const ws = new WebSocket(`${url}/${room}?v=2`, cookie ? { headers: { Cookie: cookie } } : {});
  sockets.push(ws);
  ws.on("error", () => {
    /* rejection surfaces through the close event */
  });
  ws.on("message", (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
      if (encoding.length(encoder) > 1 && ws.readyState === WebSocket.OPEN) {
        ws.send(encoding.toUint8Array(encoder));
      }
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        ws,
      );
    }
  });
  doc.on("update", (update, origin) => {
    if (origin === ws || ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  });
  const opened = new Promise((resolve, reject) => {
    ws.once("open", () => {
      // Ask for the server's state, the way y-websocket does on connect.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, doc);
      ws.send(encoding.toUint8Array(encoder));
      resolve();
    });
    ws.once("close", (code, reason) =>
      reject(new Error(`closed before open: ${code} ${reason.toString()}`)),
    );
  });
  return { ws, doc, awareness, opened };
}

function sendAwarenessState(client, state) {
  // NB: `setLocalStateField` is a no-op while the local state is null
  // (y-protocols/awareness.js:141-149) — set the whole state instead.
  client.awareness.setLocalState(state);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(client.awareness, [client.awareness.clientID]),
  );
  client.ws.send(encoding.toUint8Array(encoder));
}

function sendAwareness(client) {
  sendAwarenessState(client, { user: { name: "Gina", color: "#2383e2" } });
}

/** A valid y-websocket sync-step-1 request frame (counts as ONE message). */
function syncStep1Frame() {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, new Y.Doc());
  return encoding.toUint8Array(encoder);
}

/** A byte the relay counts as a message but ignores (empty MESSAGE_SYNC). */
const JUNK_FRAME = new Uint8Array([0]);

/** Set (or unset) APP_ORIGINS for the duration of `fn`, then restore. */
async function withAppOrigins(value, fn) {
  const previous = process.env.APP_ORIGINS;
  if (value === undefined) delete process.env.APP_ORIGINS;
  else process.env.APP_ORIGINS = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.APP_ORIGINS;
    else process.env.APP_ORIGINS = previous;
  }
}

/* ------------------------------------------------------------------ *
 * Session primitive — the real HS256 `noema_session` check
 * ------------------------------------------------------------------ */

describe("verifySessionCookie (real session primitive)", () => {
  const SECRET = "unit-test-auth-secret-0123456789";

  async function signed(token, secret = SECRET, extra = {}) {
    return new SignJWT({ sub: "user-1", ...extra })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(secret));
  }

  function withSecret(value, fn) {
    const previous = process.env.AUTH_SECRET;
    if (value === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = value;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = previous;
    }
  }

  it("accepts a valid noema_session cookie and returns the user id", async () => {
    const token = await signed();
    await withSecret(SECRET, async () => {
      expect(await verifySessionCookie(`noema_session=${token}; other=1`)).toBe("user-1");
    });
  });

  it("rejects a missing cookie", async () => {
    await withSecret(SECRET, async () => {
      expect(await verifySessionCookie(undefined)).toBeNull();
      expect(await verifySessionCookie("other=1")).toBeNull();
    });
  });

  it("rejects a tampered token", async () => {
    const token = await signed();
    const forged = `${token.slice(0, -3)}${token.endsWith("AAA") ? "BBB" : "AAA"}`;
    await withSecret(SECRET, async () => {
      expect(await verifySessionCookie(`noema_session=${forged}`)).toBeNull();
    });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signed(undefined, "some-other-secret-value-999");
    await withSecret(SECRET, async () => {
      expect(await verifySessionCookie(`noema_session=${token}`)).toBeNull();
    });
  });

  it("rejects an expired token", async () => {
    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("-10s")
      .sign(new TextEncoder().encode(SECRET));
    await withSecret(SECRET, async () => {
      expect(await verifySessionCookie(`noema_session=${token}`)).toBeNull();
    });
  });

  it("fails closed when AUTH_SECRET is missing or too short", async () => {
    const token = await signed();
    await withSecret(undefined, async () => {
      expect(await verifySessionCookie(`noema_session=${token}`)).toBeNull();
    });
    await withSecret("short", async () => {
      expect(await verifySessionCookie(`noema_session=${token}`)).toBeNull();
    });
  });

  it("fails closed for the placeholder that ships in .env.example (B55)", async () => {
    // The placeholder is public: a cookie signed with it must not unlock a
    // collaboration connection. The value is read out of the repository, so
    // the check cannot pass for the wrong reason if the placeholder changes.
    const placeholder = readFileSync(
      new URL("../.env.example", import.meta.url),
      "utf8",
    )
      .split(/\r?\n/)
      .find((line) => line.startsWith("AUTH_SECRET="))
      .slice("AUTH_SECRET=".length)
      .trim()
      .replace(/^["']|["']$/g, "");

    const token = await signed(undefined, placeholder);
    await withSecret(placeholder, async () => {
      expect(await verifySessionCookie(`noema_session=${token}`)).toBeNull();
    });
    // …and in another spelling.
    await withSecret(`  ${placeholder.toUpperCase()}  `, async () => {
      expect(await verifySessionCookie(`noema_session=${token}`)).toBeNull();
    });
  });

  it("rejects a token without a subject", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(SECRET));
    await withSecret(SECRET, async () => {
      expect(await verifySessionCookie(`noema_session=${token}`)).toBeNull();
    });
  });
});

/* ------------------------------------------------------------------ *
 * Room name — never trusted as an opaque string (R9.5)
 * ------------------------------------------------------------------ */

describe("parseRoomPageId (R9.5)", () => {
  it("accepts a raw page id with the y-websocket query string", () => {
    expect(parseRoomPageId("/cmfpage0001?v=2")).toBe("cmfpage0001");
  });

  it("accepts the canonical page: prefix", () => {
    expect(parseRoomPageId("/page:cmfpage0001?v=2")).toBe("cmfpage0001");
  });

  it("decodes percent-encoded ids", () => {
    expect(parseRoomPageId("/page%3Acmfpage0001?v=2")).toBe("cmfpage0001");
  });

  it("refuses an empty room name", () => {
    expect(parseRoomPageId("/?v=2")).toBeNull();
    expect(parseRoomPageId(undefined)).toBeNull();
  });

  it("refuses traversal or junk room names", () => {
    expect(parseRoomPageId("/../secrets")).toBeNull();
    expect(parseRoomPageId("/..%2Fsecrets")).toBeNull();
    expect(parseRoomPageId("/has space")).toBeNull();
    expect(parseRoomPageId("/page:")).toBeNull(); // "page:" prefix with no id
    expect(parseRoomPageId(`/${"a".repeat(200)}`)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Join rule — fail closed (R9.2, R9.7, R9.3)
 * ------------------------------------------------------------------ */

describe("decideAccess (join rule)", () => {
  const page = (overrides = {}) => ({
    id: "pageA",
    workspaceId: "wsA",
    deletedAt: null,
    locked: false,
    ...overrides,
  });

  it("lets a workspace member read and write", () => {
    expect(
      decideAccess({ pageId: "pageA", page: page(), role: "MEMBER", pagePermission: null, guestVisibleIds: null }),
    ).toEqual({ read: true, write: true });
  });

  it("denies a non-member (cross-workspace) without further detail", () => {
    expect(
      decideAccess({ pageId: "pageA", page: page(), role: null, pagePermission: null, guestVisibleIds: null }),
    ).toBeNull();
  });

  it("denies a page that does not exist", () => {
    expect(
      decideAccess({ pageId: "pageA", page: null, role: "MEMBER", pagePermission: null, guestVisibleIds: null }),
    ).toBeNull();
  });

  it("denies a trashed page", () => {
    expect(
      decideAccess({
        pageId: "pageA",
        page: page({ deletedAt: new Date() }),
        role: "MEMBER",
        pagePermission: null,
        guestVisibleIds: null,
      }),
    ).toBeNull();
  });

  it("denies an unknown/forged role", () => {
    expect(
      decideAccess({ pageId: "pageA", page: page(), role: "SUPERADMIN", pagePermission: null, guestVisibleIds: null }),
    ).toBeNull();
  });

  it("scopes a guest to the visible page set", () => {
    expect(
      decideAccess({
        pageId: "pageA",
        page: page(),
        role: "GUEST",
        pagePermission: null,
        guestVisibleIds: new Set(["pageA"]),
      }),
    ).toEqual({ read: true, write: false });
  });

  it("denies a guest outside the visible set — including when no set was computed", () => {
    expect(
      decideAccess({ pageId: "pageA", page: page(), role: "GUEST", pagePermission: null, guestVisibleIds: new Set() }),
    ).toBeNull();
    expect(
      decideAccess({ pageId: "pageA", page: page(), role: "GUEST", pagePermission: null, guestVisibleIds: null }),
    ).toBeNull();
  });

  it("downgrades to read-only on an explicit READ/COMMENT page permission", () => {
    for (const level of ["READ", "COMMENT"]) {
      expect(
        decideAccess({
          pageId: "pageA",
          page: page(),
          role: "MEMBER",
          pagePermission: { level },
          guestVisibleIds: null,
        }),
      ).toEqual({ read: true, write: false });
    }
  });

  it("downgrades to read-only while the page is locked", () => {
    expect(
      decideAccess({
        pageId: "pageA",
        page: page({ locked: true }),
        role: "MEMBER",
        pagePermission: null,
        guestVisibleIds: null,
      }),
    ).toEqual({ read: true, write: false });
  });

  it("downgrades to read-only on an unknown permission level", () => {
    expect(
      decideAccess({
        pageId: "pageA",
        page: page(),
        role: "MEMBER",
        pagePermission: { level: "GODMODE" },
        guestVisibleIds: null,
      }),
    ).toEqual({ read: true, write: false });
  });
});

/* ------------------------------------------------------------------ *
 * Handshake pipeline (R9.1, R9.2, R9.7)
 * ------------------------------------------------------------------ */

describe("collab server handshake authorization", () => {
  it("rejects a connection with no session cookie with 4401 and creates no room (R9.1)", async () => {
    const server = await startServer({ verifySession: undefined, authorize: undefined });
    const ws = connectRaw(server.url, "pageA");
    const closed = await waitClose(ws);
    expect(closed.code).toBe(CLOSE_UNAUTHORIZED);
    expect(closed.reason).toBe("unauthorized");
    expect(server.rooms.size).toBe(0);
  });

  it("rejects a forged session cookie with 4401 before the room is touched (R9.1)", async () => {
    const server = await startServer({ verifySession: undefined, authorize: undefined });
    const ws = connectRaw(server.url, "pageA", "noema_session=not-a-jwt");
    const closed = await waitClose(ws);
    expect(closed.code).toBe(CLOSE_UNAUTHORIZED);
    expect(server.rooms.size).toBe(0);
  });

  it("lets an authenticated member join and relay updates (R9.2)", async () => {
    const server = await startServer();
    const alice = connectDoc(server.url, "pageA", "user=alice");
    const carol = connectDoc(server.url, "pageA", "user=carol");
    await Promise.all([alice.opened, carol.opened]);

    alice.doc.getMap("shared").set("hello", "from alice");
    await waitFor(() => carol.doc.getMap("shared").get("hello") === "from alice");
    expect(server.rooms.get("page:pageA").doc.getMap("shared").get("hello")).toBe("from alice");
  });

  it("rejects a cross-workspace member with 4403 and creates no room (R9.7)", async () => {
    const server = await startServer();
    const ws = connectRaw(server.url, "pageA", "user=bob"); // bob is only in wsB
    const closed = await waitClose(ws);
    expect(closed.code).toBe(CLOSE_FORBIDDEN);
    expect(closed.reason).toBe("forbidden");
    expect(server.rooms.size).toBe(0);
  });

  it("gives no existence oracle: forbidden, nonexistent and junk rooms are indistinguishable (R9.7)", async () => {
    const server = await startServer();
    const crossWorkspace = await waitClose(connectRaw(server.url, "pageA", "user=bob"));
    const nonexistent = await waitClose(connectRaw(server.url, "pageMissing", "user=alice"));
    const trashed = await waitClose(connectRaw(server.url, "pageTrashed", "user=alice"));
    const junk = await waitClose(connectRaw(server.url, "../etc/passwd", "user=alice"));
    for (const result of [nonexistent, trashed, junk]) {
      expect(result).toEqual(crossWorkspace);
    }
    expect(crossWorkspace.code).toBe(CLOSE_FORBIDDEN);
    expect(server.rooms.size).toBe(0);
  });

  it("scopes a guest to the pages shared with them (R9.2)", async () => {
    const server = await startServer();
    const allowed = await waitCloseWithOpen(connectRaw(server.url, "pageShared", "user=gina"));
    expect(allowed).toBe(true);
    expect(server.rooms.has("page:pageShared")).toBe(true);

    const denied = await waitClose(connectRaw(server.url, "pageA", "user=gina"));
    expect(denied.code).toBe(CLOSE_FORBIDDEN);
    expect(server.rooms.has("page:pageA")).toBe(false);
  });

  it("keys the room internally as page:<pageId> for either client spelling (R9.5)", async () => {
    const server = await startServer();
    const ws = connectRaw(server.url, "page:pageA", "user=alice");
    const first = await nextMessage(ws);
    expect(first[0]).toBe(MESSAGE_SYNC);
    expect([...server.rooms.keys()]).toEqual(["page:pageA"]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("relays to a read-only guest but drops their document updates (R9.3)", async () => {
    const server = await startServer();
    const alice = connectDoc(server.url, "pageShared", "user=alice");
    const gina = connectDoc(server.url, "pageShared", "user=gina");
    await Promise.all([alice.opened, gina.opened]);

    // Read path: an edit from the member reaches the read-only guest.
    alice.doc.getMap("shared").set("fromMember", "visible");
    await waitFor(() => gina.doc.getMap("shared").get("fromMember") === "visible");

    // Write path: the guest's edit must never land — prove the server processed
    // her connection by waiting for her (relayed) awareness message, which is
    // sent after the dropped document update on the same ordered socket.
    gina.doc.getMap("shared").set("fromGuest", "must-not-land");
    sendAwareness(gina);
    await waitFor(() => alice.awareness.getStates().has(gina.awareness.clientID));

    expect(server.rooms.get("page:pageShared").doc.getMap("shared").get("fromGuest")).toBeUndefined();
    expect(alice.doc.getMap("shared").get("fromGuest")).toBeUndefined();
  });
});

/** Resolves true when the socket is still open after a grace period. */
async function waitCloseWithOpen(ws, grace = 300) {
  let closed = false;
  ws.once("close", () => {
    closed = true;
  });
  await sleep(grace);
  if (closed) return false;
  return ws.readyState === WebSocket.OPEN;
}

/* ------------------------------------------------------------------ *
 * B75 — rate limits (R9.6), presence identity (R9.16), origin check
 * ------------------------------------------------------------------ */

describe("connection + message rate limits (R9.6)", () => {
  it("closes a user's 6th concurrent connection with 4429 while other users stay unaffected", async () => {
    const server = await startServer(); // default cap: 5 connections per verified user
    const held = [];
    for (let i = 0; i < 5; i++) held.push(connectRaw(server.url, "pageA", "user=alice"));
    await Promise.all(held.map((ws) => waitOpen(ws)));

    // 6th concurrent connection for the SAME user -> graceful close.
    const overflow = connectRaw(server.url, "pageA", "user=alice");
    const closed = await waitClose(overflow);
    expect(closed.code).toBe(4429);
    expect(closed.reason).toBe("rate-limited");

    // A different user in the SAME room has her own bucket and is
    // unaffected while alice is capped.
    const carol = connectRaw(server.url, "pageA", "user=carol");
    expect(await waitCloseWithOpen(carol)).toBe(true);

    // Closing the held connections returns capacity to alice (no leaked slots).
    const heldClosed = held.map((ws) => waitClose(ws));
    held.forEach((ws) => ws.close());
    await Promise.all(heldClosed);
    await sleep(200);
    const again = connectRaw(server.url, "pageA", "user=alice");
    expect(await waitCloseWithOpen(again)).toBe(true);
  });

  it("processes exactly 30 messages in the window, then closes the 31st with 4429", async () => {
    let now = 1_000_000;
    const server = await startServer({ rateLimitClock: () => now });
    const alice = connectRaw(server.url, "pageA", "user=alice");
    await waitOpen(alice);
    const initial = await nextMessage(alice); // server's sync step 1 after the join
    expect(initial[0]).toBe(MESSAGE_SYNC);

    // 29 ignored frames + one REAL sync step-1 request = 30 messages in the window.
    for (let i = 0; i < 29; i++) alice.send(JUNK_FRAME);
    alice.send(syncStep1Frame());
    const reply = await nextMessage(alice); // proof message #30 was processed
    expect(reply[0]).toBe(MESSAGE_SYNC);
    expect(await waitCloseWithOpen(alice, 200)).toBe(true);

    alice.send(JUNK_FRAME); // message #31 inside the same window
    const closed = await waitClose(alice);
    expect(closed.code).toBe(4429);
    expect(closed.reason).toBe("rate-limited");
  });

  it("slides the window with the injected clock: a partial advance does not lift the cap, a full one does", async () => {
    let now = 2_000_000;
    const server = await startServer({ rateLimitClock: () => now });

    // carol: window filled, then +5 s (INSIDE the 10 s window) must NOT lift it.
    const carol = connectRaw(server.url, "pageA", "user=carol");
    await waitOpen(carol);
    await nextMessage(carol);
    for (let i = 0; i < 29; i++) carol.send(JUNK_FRAME);
    carol.send(syncStep1Frame());
    await nextMessage(carol); // 30/30 in the window
    now += 5_000;
    carol.send(JUNK_FRAME); // #31, still inside the original window
    const closedCarol = await waitClose(carol);
    expect(closedCarol.code).toBe(4429);
    expect(closedCarol.reason).toBe("rate-limited");

    // bob: same fill on his own page, then a full +10 s advance -> the
    // entries expire and new messages are processed again on the SAME connection.
    const bob = connectRaw(server.url, "pageB", "user=bob");
    await waitOpen(bob);
    await nextMessage(bob);
    for (let i = 0; i < 29; i++) bob.send(JUNK_FRAME);
    bob.send(syncStep1Frame());
    await nextMessage(bob); // 30/30, window full
    now += 10_000;
    for (let i = 0; i < 5; i++) bob.send(JUNK_FRAME);
    bob.send(syncStep1Frame());
    const reply = await nextMessage(bob); // processed again -> the window slid
    expect(reply[0]).toBe(MESSAGE_SYNC);
    expect(await waitCloseWithOpen(bob, 200)).toBe(true);
  });
});

describe("presence identity binding (R9.16)", () => {
  it("overrides the client-supplied user field with the verified identity on the relay", async () => {
    const server = await startServer();
    const alice = connectDoc(server.url, "pageA", "user=alice");
    const observer = connectDoc(server.url, "pageA", "user=carol");
    await Promise.all([alice.opened, observer.opened]);

    sendAwarenessState(alice, {
      user: { id: "u-admin", name: "Admin", color: "#ff0000", avatarUrl: "https://evil.example/a.png" },
      cursor: { line: 3, ch: 7 },
    });
    await waitFor(() => observer.awareness.getStates().has(alice.awareness.clientID));
    const state = observer.awareness.getStates().get(alice.awareness.clientID);

    // The relay must emit the JWT holder's identity, not the client's claim.
    expect(state.user.name).toBe("Alice Anderson");
    expect(state.user.id).toBe("alice");
    expect(state.user.color).not.toBe("#ff0000");
    expect(state.user.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(state.user.avatarUrl ?? null).toBeNull();
    // Non-identity presence fields still pass through untouched.
    expect(state.cursor).toEqual({ line: 3, ch: 7 });
  });

  it("derives a stable per-user colour and resolves identity only from verified user ids", async () => {
    const seen = [];
    const server = await startServer({
      resolveIdentity: async (userId) => {
        seen.push(userId);
        return IDENTITIES[userId] ?? { name: userId };
      },
    });
    const observer = connectDoc(server.url, "pageA", "user=carol");
    const first = connectDoc(server.url, "pageA", "user=alice");
    const second = connectDoc(server.url, "pageA", "user=alice");
    await Promise.all([observer.opened, first.opened, second.opened]);

    sendAwarenessState(first, { user: { name: "Admin", color: "#ff0000" } });
    sendAwarenessState(second, { user: { name: "Root", color: "#00ff00" } });
    await waitFor(
      () =>
        observer.awareness.getStates().has(first.awareness.clientID) &&
        observer.awareness.getStates().has(second.awareness.clientID),
    );
    const one = observer.awareness.getStates().get(first.awareness.clientID).user;
    const two = observer.awareness.getStates().get(second.awareness.clientID).user;

    expect(one.name).toBe("Alice Anderson");
    expect(two.name).toBe("Alice Anderson");
    expect(one.color).toBe(two.color); // same person, same colour, across connections
    expect(one.color).not.toBe("#ff0000");
    expect(two.color).not.toBe("#00ff00");
    expect(seen).toContain("alice");
    expect(seen.every((id) => Object.hasOwn(IDENTITIES, id))).toBe(true);
  });

  it("denies the join when no verified identity can be resolved (fail closed)", async () => {
    const server = await startServer({ resolveIdentity: async () => null });
    const ws = connectRaw(server.url, "pageA", "user=alice");
    const closed = await waitClose(ws);
    expect(closed.code).toBe(CLOSE_UNAUTHORIZED);
    expect(closed.reason).toBe("unauthorized");
    expect(server.rooms.size).toBe(0);
  });
});

describe("origin check (APP_ORIGINS)", () => {
  it("closes a foreign or missing Origin with 4400 BEFORE authentication when a policy is set", async () => {
    await withAppOrigins("noema.example.test, https://app.other.test/", async () => {
      const server = await startServer(); // policy read when the server is created

      // Pre-auth proof: no session cookie AND a foreign origin -> the origin
      // answer (4400), not the session answer (4401).
      const foreignNoCookie = connectRaw(server.url, "pageA", undefined, {
        Origin: "https://evil.example",
      });
      const originClosed = await waitClose(foreignNoCookie);
      expect(originClosed.code).toBe(4400);
      expect(originClosed.reason).toBe("origin not allowed");

      // Policy set -> a MISSING Origin fails closed too (non-browser clients
      // must be allow-listed explicitly).
      const missing = connectRaw(server.url, "pageA", "user=alice");
      expect((await waitClose(missing)).code).toBe(4400);

      // Listed origins connect (entries normalized like next.config.ts:
      // scheme stripped, trailing slash stripped, case-insensitive).
      const listed = connectRaw(server.url, "pageA", "user=alice", {
        Origin: "https://noema.example.test",
      });
      expect(await waitCloseWithOpen(listed)).toBe(true);
      const listedToo = connectRaw(server.url, "pageA", "user=alice", {
        Origin: "http://app.other.test",
      });
      expect(await waitCloseWithOpen(listedToo)).toBe(true);
      expect(server.rooms.has("page:pageA")).toBe(true);
    });
  });

  it("stays permissive when APP_ORIGINS is unset (documented default posture)", async () => {
    await withAppOrigins(undefined, async () => {
      const server = await startServer();
      const any = connectRaw(server.url, "pageA", "user=alice", {
        Origin: "https://evil.example",
      });
      expect(await waitCloseWithOpen(any)).toBe(true);
    });
  });
});
