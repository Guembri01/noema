#!/usr/bin/env node
/**
 * Smoke-test the packaged payload, without the webview.
 *
 * This is the check that proves the *installer's contents* work: it runs the
 * bundled Node runtime on the staged `server/start.cjs` (which migrates the
 * database and then boots the Next server), waits for `/api/health`, and fetches
 * a real page. If this passes, the only thing left that can fail is the webview
 * window itself.
 *
 * It needs a reachable Postgres (the app's own schema) — the same one the site
 * version uses. `DATABASE_URL` from `.env` is used unless `NOEMA_DATABASE_URL`
 * is set.
 *
 * Three modes:
 *   npm run desktop:smoke                configured database (DATABASE_URL / .env)
 *   npm run desktop:smoke -- --managed   the Docker-provisioned database
 *   npm run desktop:smoke -- --embedded  the **embedded** database (PGlite), from
 *                                        an empty data directory — the path a
 *                                        fresh install takes, with nothing
 *                                        installed and no URL configured
 *
 *   npm run desktop:smoke
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeSidecarPath, targetTriple } from "./prepare.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const payload = join(root, "src-tauri", "server");
const runtime = nodeSidecarPath(targetTriple());
const READY_TIMEOUT_MS = 300_000;
/** `--managed`: use the Docker-provisioned database instead of a configured one. */
const MANAGED = process.argv.includes("--managed");
/** `--embedded`: use the in-process PGlite database (nothing installed). */
const EMBEDDED = process.argv.includes("--embedded");
/** `--fresh`: drop and recreate the managed database first (empty schema). */
const FRESH = process.argv.includes("--fresh");
const MANAGED_CONTAINER = "noema-postgres";
const MANAGED_USER = "noema";
const MANAGED_DB = "noema";

function databaseUrl() {
  if (process.env.NOEMA_DATABASE_URL) return process.env.NOEMA_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = join(root, ".env");
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .find((entry) => entry.startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).replace(/^"|"$/g, "");
  }
  return "";
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

const problems = [];
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "ok   " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

/**
 * Every model the *staged* schema declares.
 *
 * Assertions compare a database against this list rather than against a count:
 * "more than ten tables" was satisfied by a schema missing 28 models, and that is
 * not a mistake worth being able to repeat.
 */
function expectedModels() {
  const schema = readFileSync(join(payload, "prisma", "schema.prisma"), "utf8");
  return [...schema.matchAll(/^model (\w+)/gm)].map((match) => match[1]);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  console.log("Desktop payload smoke test\n");

  if (!existsSync(runtime)) {
    console.error(`Bundled runtime missing (${runtime}). Run: npm run desktop:prepare`);
    process.exit(1);
  }
  check(true, "bundled runtime present");
  if (!existsSync(join(payload, "start.cjs")) || !existsSync(join(payload, "server.js"))) {
    console.error(`Payload incomplete at ${payload}. Run: npm run desktop:prepare`);
    process.exit(1);
  }
  check(true, "payload staged (server.js + start.cjs)");

  let url = "";
  if (EMBEDDED) {
    check(true, "embedded mode: the app provisions PostgreSQL inside itself (PGlite)");
  } else if (MANAGED) {
    check(true, "managed mode: the app provisions Postgres with Docker");
  } else {
    url = databaseUrl();
    if (!url) {
      console.error("No DATABASE_URL found (.env, NOEMA_DATABASE_URL or DATABASE_URL).");
      process.exit(1);
    }
    check(true, "database URL resolved", url.replace(/\/\/[^@]*@/, "//***@"));
  }

  const dataDir = mkdtempSync(join(tmpdir(), "noema-smoke-"));
  const port = await freePort();
  if (MANAGED && FRESH) {
    // Provision the container first (exactly what the boot wrapper does), then
    // reset the database, so migrations are genuinely exercised.
    const ensured = spawnSync(process.execPath, [join(payload, "docker-db.cjs"), "--ensure"], {
      cwd: payload,
      env: { ...process.env, NOEMA_DATA_DIR: dataDir },
      encoding: "utf8",
    });
    check(ensured.status === 0, "provisioned the managed database", (ensured.stdout || "").trim().split("\n").pop());
    spawnSync("docker", ["exec", MANAGED_CONTAINER, "dropdb", "-U", MANAGED_USER, "--if-exists", MANAGED_DB], { encoding: "utf8" });
    const created = spawnSync("docker", ["exec", MANAGED_CONTAINER, "createdb", "-U", MANAGED_USER, MANAGED_DB], { encoding: "utf8" });
    check(created.status === 0, "reset to an empty database");
  }

  console.log(`\n  starting the packaged server on 127.0.0.1:${port} …\n`);

  const child = spawn(runtime, [join(payload, "start.cjs")], {
    cwd: payload,
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      NOEMA_RUNTIME: "desktop",
      NOEMA_DATA_DIR: dataDir,
      // Explicitly empty for the modes that must *not* use a configured database:
      // an inherited DATABASE_URL would silently take the first branch of the boot
      // wrapper's resolution order and the mode would prove nothing.
      ...(EMBEDDED || MANAGED ? { DATABASE_URL: "" } : url ? { DATABASE_URL: url } : {}),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  let status = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      status = response.status;
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await sleep(500);
  }

  if (!ready) {
    console.log("  --- server output (tail) ---");
    for (const line of output.split(/\r?\n/).slice(-25)) console.log(`  ${line}`);
    console.log("  ----------------------------\n");
  }
  check(ready, "GET /api/health returns 200", ready ? "" : `last status ${status || "no response"}`);

  if (ready) {
    const page = await fetch(`http://127.0.0.1:${port}/login`);
    const html = await page.text();
    check(page.status === 200, "GET /login returns 200", `status ${page.status}`);
    check(html.includes("<html") && html.length > 500, "page HTML is real (not an error shell)", `${html.length} bytes`);
    check(/noema|Noema/i.test(html), "page mentions the product");

    const css = await fetch(`http://127.0.0.1:${port}/login`).then((r) => r.text());
    check(/<link[^>]+\.css|styles/i.test(css), "stylesheets are linked (static assets copied)");

    // The payload is the desktop build, so `/` must onboard rather than pitch:
    // the shell runs the server with NOEMA_RUNTIME=desktop, and the landing page
    // redirects to sign-up (no users yet) or sign-in.
    const root = await fetch(`http://127.0.0.1:${port}/`);
    const rootHtml = await root.text();
    check(!rootHtml.includes("A local-first workspace for notes"), "/ does not serve the marketing landing page");
    check(/type="password"|name="password"/.test(rootHtml), "/ lands on an auth form");

    if (MANAGED) {
      // The wrapper must have created the schema inside the container it provisions.
      // Compared against the schema's own model list rather than a magic floor: a
      // "< 20 tables" check is exactly what let 28 models ship without tables.
      const listed = spawnSync(
        "docker",
        ["exec", MANAGED_CONTAINER, "psql", "-U", MANAGED_USER, "-d", MANAGED_DB, "-tAc",
         "select tablename from pg_tables where table_schema = 'public'"],
        { encoding: "utf8" },
      );
      const names = (listed.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
      const missing = expectedModels().filter((model) => !names.includes(model));
      check(
        missing.length === 0,
        "migrations created every model's table in the managed container",
        missing.length
          ? `${missing.length} missing: ${missing.slice(0, 6).join(", ")}`
          : `${names.length} tables for ${expectedModels().length} models`,
      );
    }

    if (EMBEDDED) {
      // The wrapper must have started the embedded engine and applied the schema
      // *to it* — with nothing installed and no URL configured.
      check(
        /using the embedded database on 127\.0\.0\.1:\d+/.test(output),
        "boot log shows the embedded database was used",
        /embedded database on ([^\s]+)/.exec(output)?.[1] ?? "not found in the log",
      );
      const pgdata = join(dataDir, "pgdata");
      check(existsSync(pgdata), "the embedded data directory was created", pgdata);
      const embeddedPort = (output.match(/embedded database on 127\.0\.0\.1:(\d+)/) || [])[1];
      check(Boolean(embeddedPort), "the embedded database reported a loopback port", embeddedPort ? `port ${embeddedPort}` : "not found");
      check(
        /All migrations have been successfully applied/.test(output),
        "the migration ran against the embedded database",
        /All migrations have been successfully applied/.test(output) ? "" : "see the server output above",
      );
    }
  }

  child.kill();
  await sleep(300);

  // Opening the embedded database's files *after* the server has exited proves two
  // things at once — that the migration created the schema, and that it survived to
  // disk — without racing a second client for the engine's single session (Prisma's
  // prepared-statement names are global to that session, which is a real limitation
  // of the embedded engine; see docs/DESKTOP.md). A terminating kill can hold the
  // files for a moment, hence the retries.
  if (EMBEDDED) {
    let verified = false;
    for (let attempt = 0; attempt < 6 && !verified; attempt += 1) {
      try {
        const { PGlite } = await import("@electric-sql/pglite");
        const db = new PGlite(join(dataDir, "pgdata"));
        await db.waitReady;
        const listed = await db.query("select tablename from pg_tables where schemaname = 'public'");
        const names = listed.rows.map((row) => row.tablename);
        const missing = expectedModels().filter((model) => !names.includes(model));
        check(
          missing.length === 0,
          "every model has a table on disk in the embedded database",
          missing.length
            ? `${missing.length} missing: ${missing.slice(0, 6).join(", ")}`
            : `${names.length} tables for ${expectedModels().length} models (the schema survived to disk)`,
        );
        await db.close();
        verified = true;
      } catch (error) {
        if (attempt === 5) {
          check(false, "the schema is on disk in the embedded database", error && error.message);
        } else {
          await sleep(500);
        }
      }
    }
  }

  // The embedded database's files live in here; on Windows a file handle can
  // outlive the process by a moment, and a leftover temp directory is not worth
  // failing a smoke test over.
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch (error) {
    console.log(`  note: could not remove ${dataDir} (${error && error.code})`);
  }

  console.log("");
  if (problems.length) {
    console.error(`${problems.length} problem(s): ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log("Payload boots, migrates and serves. The installer contains a working app.");
}

main().catch((error) => {
  console.error("smoke test crashed:", error);
  process.exit(1);
});
