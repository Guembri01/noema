// Embedded database: real PostgreSQL compiled to WebAssembly (PGlite), served
// over the Postgres wire protocol so Prisma connects to it exactly as it would to
// a hosted server. This is what makes the installer need **nothing** installed —
// no Postgres, no Docker, no service to start.
//
// The recipe is the one the spike proved (see docs/DESKTOP.md §5): PostgreSQL
// semantics including `tsvector` + GIN indexes, JSON columns, enums, cascades and
// a zero-change `prisma db push` of this project's schema. The one gap the spike
// found was `pg_trgm`, which this app no longer uses — the fuzzy-match tier is
// pure TypeScript now (`src/lib/fts.ts`).
//
// It is a real file in the repo (copied into the payload by prepare.mjs), not
// generated text, so it is reviewable and can be fixed without touching the
// packager.
//
// Two hardening rules live here, because the database is the app's most
// sensitive file: the data directory is created owner-only (0700, the files in
// it 0600), and the socket server asks for a password that is generated per
// launch. The password reaches the app in the environment (`DATABASE_URL`),
// never on a command line, which every user on the machine can read.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");

/** PGlite is a single-user engine; these are the conventional names. */
const DB_USER = "postgres";
const DB_NAME = "postgres";

/**
 * The two request codes a Postgres client sends before its startup packet:
 * an SSL offer and a cancel request.
 */
const SSL_REQUEST_CODE = 80877103;
const CANCEL_REQUEST_CODE = 80877102;

/** How long a client has to present the password before it is dropped. */
const AUTH_TIMEOUT_MS = 10_000;

/**
 * Where the database files live.
 *
 * Deliberately *inside* the app's data directory (`NOEMA_DATA_DIR`, which the
 * shell sets to the per-user app-data folder) rather than in the install
 * directory: an uninstall or an update must not take the user's data with it, and
 * a per-user install directory is not writable on every machine anyway.
 */
function resolveDataDir(dataDir) {
  const base = dataDir || process.env.NOEMA_DATA_DIR || path.join(os.homedir(), ".noema");
  return path.join(base, "pgdata");
}

/**
 * A fresh password for this launch.
 *
 * The engine itself does not check passwords — it runs in trust mode and
 * accepts whatever the client sends — so the socket server checks the password
 * itself (see `authenticate`). 32 random bytes, base64url: URL-safe without
 * escaping, and different for every launch, so a password that leaked from one
 * run is worthless for the next one.
 */
function generatePassword() {
  return crypto.randomBytes(32).toString("base64url");
}

/** Compare two secrets without leaking their length through the timing. */
function secretsMatch(given, expected) {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The error the server sends when the password does not match.
 *
 * The wording is Postgres' own, so the client reports the usual
 * "credentials are not valid" message instead of something exotic.
 */
function authenticationFailed() {
  const fields = Buffer.from('SERROR\0C28P01\0Mpassword authentication failed for user "postgres"\0\0', "utf8");
  const header = Buffer.alloc(5);
  header.write("E", 0, "latin1");
  header.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([header, fields]);
}

/**
 * Read bytes from a socket without losing what arrives beyond them.
 *
 * The reader keeps its own buffer, so a client that pipelines is not
 * truncated, and it removes only its own listeners — the socket server's
 * error listener has to stay.
 */
function socketReader(socket) {
  const state = { buffer: Buffer.alloc(0), waiter: null, error: null, ended: false };

  const wake = () => {
    if (!state.waiter) return;
    const waiter = state.waiter;
    state.waiter = null;
    waiter();
  };
  const onData = (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    wake();
  };
  const onError = (error) => {
    state.error = error;
    wake();
  };
  const onEnd = () => {
    state.ended = true;
    wake();
  };
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("end", onEnd);

  return {
    async read(count) {
      while (state.buffer.length < count) {
        if (state.error) throw state.error;
        if (state.ended) throw new Error("the client closed the connection");
        await new Promise((resolve) => {
          state.waiter = resolve;
        });
      }
      const bytes = state.buffer.subarray(0, count);
      state.buffer = state.buffer.subarray(count);
      return bytes;
    },
    leftover() {
      return state.buffer;
    },
    detach() {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
    },
  };
}

/**
 * Make the client prove that it knows the password.
 *
 * The exchange is the ordinary Postgres one: the server asks for a cleartext
 * password, the client answers with a `PasswordMessage`, and only a matching
 * answer lets the startup packet through to the engine. A client that cannot
 * answer never reaches the database.
 *
 * @returns the bytes the engine has to see (the startup packet), or `null`
 *          when the client did not prove anything.
 */
async function authenticate(socket, password, log) {
  const reader = socketReader(socket);
  const timeout = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
  timeout.unref?.();
  try {
    let startup = null;
    for (;;) {
      const head = await reader.read(8);
      const length = head.readInt32BE(0);
      const code = head.readInt32BE(4);
      if (length === 8 && code === SSL_REQUEST_CODE) {
        // The client offers TLS first (Prisma does); this server speaks plain
        // text, so the answer is the usual "no".
        socket.write("N");
        continue;
      }
      if (length === 16 && code === CANCEL_REQUEST_CODE) {
        // A Postgres CancelRequest is 16 bytes (length, code, pid, key), not
        // the 8 bytes of an SSLRequest. Forward the whole packet; the engine
        // answers it itself.
        return Buffer.concat([head, await reader.read(8)]);
      }
      if (length < 8) throw new Error("the client sent a malformed startup packet");
      startup = Buffer.concat([head, await reader.read(length - 8)]);
      break;
    }

    // AuthenticationCleartextPassword: 'R', length 8, code 3.
    const request = Buffer.alloc(9);
    request.write("R", 0, "latin1");
    request.writeInt32BE(8, 1);
    request.writeInt32BE(3, 5);
    socket.write(request);

    const message = await reader.read(5);
    if (message.subarray(0, 1).toString("latin1") !== "p") {
      throw new Error("the client did not answer with a password");
    }
    const length = message.readInt32BE(1);
    if (length < 4 || length > 4096) throw new Error("the client sent a malformed password message");
    const body = await reader.read(length - 4);
    const given = body.subarray(0, body.length - 1).toString("utf8");

    if (!secretsMatch(given, password)) {
      socket.write(authenticationFailed());
      return null;
    }
    return Buffer.concat([startup, reader.leftover()]);
  } catch (error) {
    log.warn(`[noema] a client did not authenticate: ${error && error.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
    // The socket is paused before the reader lets go of it: a paused socket
    // keeps what arrives, a flowing one without a listener throws it away.
    socket.pause();
    reader.detach();
  }
}

/**
 * Make the database directory and everything in it owner-only.
 *
 * PGlite creates its files with mode 0666 and its directories with 0777 — the
 * umask does not reduce them (measured: with umask 022 the cluster files came
 * out as 0666, with umask 077 as 0666 as well). A real Postgres creates them
 * as 0600/0700, so the modes are set here, once the engine has laid the
 * cluster out.
 */
function hardenDirectory(dir, log) {
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          fs.chmodSync(full, 0o700);
          walk(full);
        } else {
          fs.chmodSync(full, 0o600);
        }
      } catch (error) {
        log.warn(`[noema] could not protect ${full}: ${error && error.message}`);
      }
    }
  };

  try {
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    log.warn(`[noema] could not protect ${dir}: ${error && error.message}`);
    return;
  }
  walk(dir);
}

/**
 * The handler the socket server registered for `socket`, if it registered one.
 * A handler is only created for a connection the server had room for.
 */
function findHandlerFor(server, socket) {
  for (const handler of server.handlers) {
    if (handler.socket === socket) return handler;
  }
  return undefined;
}

/**
 * Detach one handler and forget it.
 *
 * `detach` is what releases the slot; the `delete` is what makes the count
 * trustworthy even if the handler's own `close` event never fires (which is the
 * whole problem — see `startEmbeddedDatabase`).
 */
function reclaimHandler(server, handler) {
  try {
    handler.detach(true);
  } catch {
    // The socket is already gone; the bookkeeping is the part that matters.
  }
  server.handlers.delete(handler);
}

/** Forget every handler whose client socket has already gone away. */
function reclaimDeadHandlers(server) {
  for (const handler of [...server.handlers]) {
    const socket = handler.socket;
    if (socket && socket.destroyed) reclaimHandler(server, handler);
  }
}

/**
 * Start the embedded database and expose it on loopback.
 *
 * @returns {Promise<{url: string, port: number, dir: string, stop: () => Promise<void>}>}
 */
async function startEmbeddedDatabase({ dataDir, log = console, host = "127.0.0.1" } = {}) {
  // Both packages ship CommonJS builds, so the CJS boot wrapper can require them
  // directly. Required lazily: a payload that predates the embedded database
  // should still boot on a configured URL instead of crashing on start.
  const { PGlite } = require("@electric-sql/pglite");
  const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");

  const dir = resolveDataDir(dataDir);
  // The database holds everything the app knows: owner-only, like the session
  // secret next to it. `mkdir` only sets the mode of the directories it
  // creates, so the mode is enforced afterwards — an install that was created
  // by an older version keeps the umask's 0755 otherwise.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    log.warn(`[noema] could not protect ${dir}: ${error && error.message}`);
  }

  const db = new PGlite(dir);
  await db.waitReady;
  // The engine creates its own files; they are protected once it is done.
  hardenDirectory(dir, log);

  // The password this launch expects. It never goes onto a command line: the
  // URL travels in the environment (`DATABASE_URL`), which only the user who
  // owns the process can read.
  const password = generatePassword();

  // `maxConnections` is generous rather than 1: the Prisma CLI (which runs before
  // the server, so normally alone) opens its own client, and a retry should never
  // be refused a slot. The connection URL further pins Prisma to one connection,
  // because PGlite executes one query at a time.
  const server = new PGLiteSocketServer({ db, port: 0, host, maxConnections: 10 });

  // PGlite's socket server leaks a connection slot whenever a client goes away
  // before it is accepted, and once every slot has leaked it answers "Too many
  // connections" to everyone — the database becomes unreachable and only a
  // restart brings it back.
  //
  // The window is small but real. The server accepts on a `setImmediate`, so a
  // client that connects and resets immediately (a pool closing, a window
  // closing, a laptop waking) is already `destroyed` by the time `attach` runs.
  // The library attaches its `close` listener *after* that event has fired, so
  // nothing ever removes the handler it created for the socket, and the count
  // only grows. Measured: 24 aborted handshakes against `maxConnections: 10`
  // left the engine refusing every client.
  //
  // Two guards close it, both deterministic — no timers, no grace period:
  //
  //   • every client socket gets an `error` listener the moment it is accepted
  //     by the *server* (before the deferred accept runs). Node treats an
  //     unhandled `error` event as fatal, and an unhandled `ECONNRESET` used to
  //     kill the engine process outright, taking the user's data with it.
  //   • a handler whose socket is already gone is detached and forgotten, and
  //     the check runs as each connection arrives — *before* the library decides
  //     whether there is room. A wedged engine therefore heals on the next
  //     client rather than needing a restart.
  const accept = server.handleConnection.bind(server);
  server.handleConnection = async (socket) => {
    reclaimDeadHandlers(server);
    // The password first: a client that cannot present it never reaches the
    // engine. The engine itself accepts any password (it runs in trust mode),
    // so this check is the only thing standing between the loopback port and
    // another user on the same machine.
    const startup = await authenticate(socket, password, log);
    if (!startup) {
      socket.destroy();
      return undefined;
    }
    // The engine has to see the startup packet, so it is pushed back into the
    // socket — which is paused, so the bytes cannot slip past the handler
    // before it is attached.
    socket.unshift(startup);
    const accepted = accept(socket);
    socket.resume();
    // `handleConnection` registers its handler synchronously (its only `await`
    // is `attach`, which sets `handler.socket` before suspending), so by now the
    // handler for this socket exists — and is already orphaned if the socket
    // died before this deferred accept ran.
    const handler = findHandlerFor(server, socket);
    if (handler && socket.destroyed) reclaimHandler(server, handler);
    return accepted;
  };

  await server.start();

  server.server?.on("connection", (socket) => {
    socket.on("error", (error) => {
      log.warn(`[noema] embedded database client disconnected: ${error && error.message}`);
    });
  });

  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : server.port;
  if (!Number.isInteger(port) || port <= 0) {
    await server.stop().catch(() => {});
    await db.close().catch(() => {});
    throw new Error("the embedded database did not report a listening port");
  }

  // `connection_limit=1`: PGlite is one query at a time, so a Prisma pool with
  // more connections would only queue. `schema=public` is Prisma's own default.
  //
  // `pgbouncer=true` is not about a connection pooler here — it tells Prisma to
  // stop using *named* prepared statements. It is required, not cosmetic: the
  // socket server fronts one PGlite session, so a statement name (`s0`, `s1`, …)
  // created by one client is still registered when the next client connects, and
  // Prisma's `PREPARE s0` then fails with `42P05 prepared statement "s0" already
  // exists`. That hit every second process to touch the database (the migration
  // CLI before the server, a seed after a build, a restart), which is exactly the
  // sequence the desktop app performs. Disabling prepared statements makes each
  // connection self-contained and the race disappears.
  // The password is this launch's own: 32 random bytes, base64url (so it needs
  // no escaping in the URL) and different for every start.
  const url = `postgresql://${DB_USER}:${password}@${host}:${port}/${DB_NAME}?schema=public&connection_limit=1&pgbouncer=true`;

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await server.stop();
    } catch (error) {
      log.warn("[noema] could not stop the embedded database server:", error && error.message);
    }
    try {
      // A graceful close flushes; the engine recovers from WAL on the next start
      // if the process was killed instead.
      await db.close();
    } catch (error) {
      log.warn("[noema] could not close the embedded database:", error && error.message);
    }
    // The engine writes while it runs (WAL segments and the like), and those
    // files come out with the engine's own modes. The directory is owner-only
    // either way, but a database at rest should look like a real one.
    hardenDirectory(dir, log);
  };

  log.log(`[noema] embedded database ready at ${dir}`);
  return { url, port, dir, stop };
}

module.exports = { startEmbeddedDatabase, resolveDataDir };
