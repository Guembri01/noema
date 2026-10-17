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
  await server.start();

  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : server.port;
  if (!Number.isInteger(port) || port <= 0) {
    await server.stop().catch(() => {});
    await db.close().catch(() => {});
    throw new Error("the embedded database did not report a listening port");
  }

  // `connection_limit=1`: PGlite is one query at a time, so a Prisma pool with
  // more connections would only queue. `schema=public` is Prisma's own default.
  const url = `postgresql://${DB_USER}:${DB_USER}@${host}:${port}/${DB_NAME}?schema=public&connection_limit=1`;

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
