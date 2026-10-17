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

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

/** PGlite is a single-user engine; these are the conventional credentials. */
const DB_USER = "postgres";
const DB_NAME = "postgres";

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
  fs.mkdirSync(dir, { recursive: true });

  const db = new PGlite(dir);
  await db.waitReady;

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
    const accepted = accept(socket);
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
  const url = `postgresql://${DB_USER}:${DB_USER}@${host}:${port}/${DB_NAME}?schema=public&connection_limit=1&pgbouncer=true`;

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
  };

  log.log(`[noema] embedded database ready at ${dir}`);
  return { url, port, dir, stop };
}

module.exports = { startEmbeddedDatabase, resolveDataDir };
