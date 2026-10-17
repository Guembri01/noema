#!/usr/bin/env node
/**
 * Embedded-database robustness check.
 *
 * The desktop app's database is PGlite (PostgreSQL compiled to WebAssembly)
 * served over the Postgres wire protocol by a Node socket server. That server
 * is the least-tested part of the desktop path — `cargo test` cannot reach it
 * and the Tauri shell cannot be launched in CI — yet it has already broken in
 * two ways that a unit test could never have seen:
 *
 *   1. **Prepared-statement reuse.** The socket server fronts one PGlite
 *      session, so a statement name (`s0`) created by one client is still
 *      registered for the next. Prisma's `PREPARE s0` then failed with
 *      `42P05 prepared statement "s0" already exists`, which hit every second
 *      process to touch the database: the migration CLI before the server, a
 *      seed after a build, a restart. Fixed by adding `pgbouncer=true` to the
 *      URL (Prisma stops naming statements).
 *   2. **A rude client killed the engine.** A socket that resets before the
 *      server accepts it — Prisma's pool closing, a window closing, a laptop
 *      waking — emitted an unhandled `ECONNRESET`, and Node treats an unhandled
 *      `error` event as fatal. The *whole database process died* because one
 *      client went away. Fixed by listening for `connection` on the server and
 *      attaching an `error` listener before the server's own accept runs.
 *
 * Both are reproduced here against a real engine, in a throwaway data directory:
 *
 *   npm run check:embedded-db
 *
 * It needs no Postgres, no Docker and no Tauri — the same property the installer
 * has, which is the point.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

const require = createRequire(import.meta.url);
const { startEmbeddedDatabase } = require("./desktop/embedded-db.cjs");

const failures = [];
function record(ok, label, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

/** A Postgres startup packet: length, protocol 3.0, then the user/database. */
function startupPacket() {
  const params = Buffer.from("user\0postgres\0database\0postgres\0\0", "utf8");
  const packet = Buffer.alloc(8 + params.length);
  packet.writeInt32BE(packet.length, 0);
  packet.writeInt32BE(196608, 4);
  params.copy(packet, 8);
  return packet;
}

/**
 * Open `count` connections, half-send a startup packet and then abort with a
 * TCP reset. This is the exact shape of a client that goes away mid-handshake,
 * and it is what used to take the engine down.
 */
async function rudeClients(port, count) {
  const sockets = [];
  for (let i = 0; i < count; i += 1) {
    sockets.push(
      new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        // Never let a probe failure reject the check: the point is the *server*.
        socket.on("error", () => resolve("error"));
        socket.on("connect", () => {
          socket.write(startupPacket());
          // `resetAndDestroy` sends RST rather than FIN — the ECONNRESET case.
          socket.resetAndDestroy();
          resolve("reset");
        });
        setTimeout(() => {
          socket.destroy();
          resolve("timeout");
        }, 2000).unref();
      }),
    );
  }
  return Promise.all(sockets);
}

/** Is anything still listening and answering on this port? */
function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    setTimeout(() => done(false), 2000).unref();
  });
}

const dataDir = mkdtempSync(join(tmpdir(), "noema-embedded-db-"));
let db;
try {
  db = await startEmbeddedDatabase({
    dataDir,
    log: { log() {}, warn() {} },
  });

  console.log(`embedded database on port ${db.port}`);

  record(db.port > 0, "the engine reports a listening port", String(db.port));
  record(
    db.url.includes("pgbouncer=true"),
    "the URL disables named prepared statements",
    db.url,
  );
  record(db.url.includes("connection_limit=1"), "the URL pins Prisma to one connection");

  process.env.DATABASE_URL = db.url;
  const { PrismaClient } = require("@prisma/client");

  // --- a first client creates and fills a table -----------------------------
  const first = new PrismaClient();
  await first.$executeRawUnsafe("CREATE TABLE probe (id serial primary key, note text)");
  await first.$executeRawUnsafe("INSERT INTO probe (note) VALUES ('first')");
  await first.$disconnect();

  // --- rude clients, the crash repro ---------------------------------------
  const outcomes = await rudeClients(db.port, 24);
  record(
    outcomes.every((outcome) => outcome === "reset" || outcome === "error"),
    "aborted handshakes are absorbed, not fatal",
    outcomes.join(","),
  );
  record(await portIsOpen(db.port), "the engine is still listening after 24 resets");

  // --- a second client proves both fixes at once ----------------------------
  // A second process touching an already-used engine is the prepared-statement
  // race; it is also the liveness check after the resets.
  const second = new PrismaClient();
  const rows = await second.$queryRawUnsafe("SELECT count(*)::int AS n FROM probe");
  const n = Array.isArray(rows) ? rows[0]?.n : undefined;
  record(n === 1, "a second client reads the first client's row", `count=${n}`);
  await second.$disconnect();

  // --- and a third, because the race hit *every second* client --------------
  const third = new PrismaClient();
  const again = await third.$queryRawUnsafe("SELECT count(*)::int AS n FROM probe");
  record(
    Array.isArray(again) && again[0]?.n === 1,
    "a third client connects to the same engine",
    `count=${Array.isArray(again) ? again[0]?.n : undefined}`,
  );
  await third.$disconnect();
} catch (error) {
  record(false, "the embedded database started and served queries", String(error && error.stack));
} finally {
  // Never let a stuck close hang the check: the engine is a throwaway and the
  // data directory is deleted either way.
  if (db) await Promise.race([db.stop().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nembedded database check FAILED (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nembedded database check passed");
process.exit(0);
