// Boot wrapper for the packaged desktop server: get the database and the
// per-install session secret ready, then hand over to the Next standalone server.
//
// This is a real file in the repo (copied into the payload by
// `scripts/desktop/prepare.mjs`), not generated text: it is linted, reviewable,
// and can be fixed without touching the packager.
//
// Why migrate on every launch: `prisma migrate deploy` is idempotent and cheap,
// and running it at boot means an app update can never leave the schema behind
// the code. Why the db-push fallback: `P3005` means the tables exist without a
// migration history — which is exactly what `prisma db push` (this project's own
// setup path) leaves behind — and refusing to start on that would punish the
// operator for a database that is already correct.
//
// Why the Prisma CLI is spawned *asynchronously* rather than with spawnSync: the
// embedded database runs **inside this process** (PGlite is WebAssembly), so a
// synchronous child would block the event loop and the CLI's own connection could
// never be answered. That was measured, not guessed — the first attempt failed
// with `P1001: Can't reach database server` for exactly this reason.
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

// The managed-database helper is copied next to this file by prepare.mjs.
// Required defensively: an older payload without it should still boot (falling
// back to a configured or conventional database) rather than crash on start.
let ensureManagedDatabase = async () => null;
try {
  ({ ensureManagedDatabase } = require("./docker-db.cjs"));
} catch (error) {
  console.warn("[noema] managed-database helper unavailable:", error && error.message);
}

// The embedded database (real PostgreSQL in WebAssembly). Also required
// defensively, for the same reason.
let startEmbeddedDatabase = null;
try {
  ({ startEmbeddedDatabase } = require("./embedded-db.cjs"));
} catch (error) {
  console.warn("[noema] embedded-database helper unavailable:", error && error.message);
}

const root = __dirname;

/** Set once the embedded database is running, so shutdown can close it. */
let embedded = null;

/**
 * Which database to use, first match wins.
 *
 *  1. an explicit `DATABASE_URL` (from the environment or the app's settings)
 *     always wins — that is how a shared server, a CI run, a portable install or
 *     a support session points the app somewhere specific;
 *  2. **the embedded database** (PGlite, PostgreSQL compiled to WebAssembly):
 *     nothing to install, no daemon, no network. This is the default, and it is
 *     what makes the installer self-contained — not even Postgres is required;
 *  3. a Postgres this app manages with Docker (see docker-db.cjs), for anyone who
 *     wants a full server engine without configuring one;
 *  4. the conventional local URL, so an existing Postgres still works and the
 *     app's bootstrap page can take over if nothing else is available.
 *
 * Set `NOEMA_NO_EMBEDDED_DB=1` to skip step 2 (useful when debugging the Docker
 * path, or on a platform where WebAssembly memory is constrained).
 */
async function resolveDatabaseUrl() {
  const configured = process.env.DATABASE_URL;
  if (configured && configured.trim() !== "") {
    console.log("[noema] using the configured DATABASE_URL");
    return configured;
  }

  if (startEmbeddedDatabase && process.env.NOEMA_NO_EMBEDDED_DB !== "1") {
    try {
      embedded = await startEmbeddedDatabase({
        dataDir: process.env.NOEMA_DATA_DIR,
        log: console,
      });
      console.log(
        `[noema] using the embedded database on 127.0.0.1:${embedded.port} (nothing to install)`,
      );
      return embedded.url;
    } catch (error) {
      // Fall through: a usable app on a configured database beats no app at all.
      console.error("[noema] embedded database unavailable:", error && error.message);
      embedded = null;
    }
  }

  const managed = await ensureManagedDatabase({ dataDir: process.env.NOEMA_DATA_DIR });
  if (managed) {
    console.log(`[noema] using the managed Docker database on port ${managed.port}`);
    return managed.url;
  }

  const fallback = "postgresql://postgres:postgres@127.0.0.1:5432/noema?schema=public";
  console.log("[noema] no embedded database and no Docker — falling back to a local Postgres URL");
  return fallback;
}

function prismaCli() {
  const cli = path.join(root, "node_modules", "prisma", "build", "index.js");
  const schema = path.join(root, "prisma", "schema.prisma");
  if (!fs.existsSync(cli) || !fs.existsSync(schema)) return null;
  return { cli, schema };
}

/**
 * Run the Prisma CLI and resolve with its result.
 *
 * Asynchronous on purpose: with the embedded database in this process, a
 * synchronous spawn would deadlock (the database could not answer the CLI).
 */
function runPrisma(cli, schema, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, "--schema", schema], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: 1, stdout, stderr: `${stderr}${error && error.message}` });
    });
    child.on("close", (status) => {
      resolve({ status: status === null ? 1 : status, stdout, stderr });
    });
  });
}

async function migrate() {
  if (process.env.NOEMA_SKIP_MIGRATE === "1") return;
  const resolved = prismaCli();
  if (!resolved) {
    console.warn("[noema] prisma CLI/schema not bundled — skipping migrations");
    return;
  }
  const { cli, schema } = resolved;

  console.log("[noema] prisma migrate deploy…");
  const deployed = await runPrisma(cli, schema, ["migrate", "deploy"]);
  if (deployed.status === 0) {
    if (deployed.stdout) process.stdout.write(deployed.stdout);
    return;
  }

  const output = (deployed.stdout || "") + (deployed.stderr || "");
  if (output.indexOf("P3005") !== -1) {
    console.log("[noema] existing schema without migration history — syncing with db push…");
    // Deliberately NOT `--accept-data-loss`: a boot path that can silently drop
    // a user's columns is not acceptable. `db push` without it applies additive
    // changes and refuses destructive ones, which is the right failure mode for
    // someone's real database.
    const pushed = await runPrisma(cli, schema, ["db", "push", "--skip-generate"]);
    if (pushed.stdout) process.stdout.write(pushed.stdout);
    if (pushed.status === 0) return;
    console.error("[noema] db push exited with status", pushed.status, pushed.stderr || "");
    return;
  }

  // Not fatal: the server still boots, /api/health reports the problem, and the
  // app's own bootstrap page can offer the connection field.
  console.error("[noema] migrations exited with status", deployed.status);
  if (deployed.stderr) console.error(deployed.stderr);
}

function startServer() {
  require(path.join(root, "server.js"));
}

/**
 * The session-signing secret, generated once per install.
 *
 * A packaged build must never carry the developer's `AUTH_SECRET`: one secret
 * shared by every copy of the installer would make a session cookie minted by
 * any install valid on all of them. So the payload ships no `.env` at all (see
 * `stripDevelopmentEnv` in prepare.mjs), and the first launch writes a secret of
 * its own into the app's data directory — next to the other per-install state,
 * `0600` like the rest. Later launches read it back, which is what keeps a
 * signed-in user signed in across a restart.
 *
 * An explicitly configured `AUTH_SECRET` still wins, so a shared server, a
 * portable install and a support session can all pin one.
 */
function ensureAuthSecret() {
  const configured = (process.env.AUTH_SECRET || "").trim();
  if (configured) return configured;

  const dir = process.env.NOEMA_DATA_DIR || process.cwd();
  const file = path.join(dir, "auth-secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Nothing stored yet (or unreadable) — generate below.
  }

  const secret = crypto.randomBytes(32).toString("base64url");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    console.log("[noema] generated a session secret for this install");
  } catch (error) {
    // Refusing to boot would be worse: sessions that end at the next restart
    // still beat an app that will not start. Say so rather than hide it.
    console.warn("[noema] could not persist the session secret:", error && error.message);
  }
  return secret;
}

/**
 * Close the embedded database on the way out.
 *
 * Postgres recovers from WAL after a hard kill, but a graceful close is cheap and
 * leaves no recovery work for the next launch.
 */
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (embedded) {
    await embedded.stop();
    console.log(`[noema] embedded database closed (${reason})`);
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    shutdown(signal).then(
      () => process.exit(0),
      () => process.exit(0),
    );
  });
}

/**
 * Adopt the uploaded files an older build left in the *program* folder.
 *
 * The shell used to pass `UPLOAD_DIR`, which the app never reads, so uploads fell
 * back to `<cwd>/uploads` - next to the code. That is a data-loss trap (an update
 * or an uninstall takes the folder with it) and the reason an installer used to
 * carry the builder's own uploads. Files are copied, never moved: the old copy is
 * harmless, and a copy that is interrupted must not lose anything. New uploads go
 * to `STORAGE_DIR`, so this only ever has work to do for a legacy install.
 */
function adoptLegacyUploads() {
  const target = process.env.STORAGE_DIR;
  if (!target) return;
  const legacy = path.join(root, "uploads");
  let entries;
  try {
    entries = fs.readdirSync(legacy);
  } catch {
    return;
  }
  let adopted = 0;
  for (const entry of entries) {
    const from = path.join(legacy, entry);
    const to = path.join(target, entry);
    try {
      if (!fs.statSync(from).isFile() || fs.existsSync(to)) continue;
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(from, to);
      adopted += 1;
    } catch {
      // A locked file or a read-only payload is not worth failing a boot over.
    }
  }
  if (adopted > 0) {
    console.log(`[noema] adopted ${adopted} uploaded file(s) from the previous layout`);
  }
}

function main() {
  adoptLegacyUploads();
  // Before anything reads it: the app signs sessions with this, and the server
  // it hands over to is required in this same process.
  process.env.AUTH_SECRET = ensureAuthSecret();
  resolveDatabaseUrl()
    .then(async (url) => {
      process.env.DATABASE_URL = url;
      await migrate();
      startServer();
    })
    .catch(async (error) => {
      // The server still starts (with whatever DATABASE_URL says) so /api/health
      // can report the problem and the app's bootstrap page can offer the fix.
      console.error("[noema] database setup failed:", error && error.message);
      await migrate().catch(() => {});
      startServer();
    });
}

main();
