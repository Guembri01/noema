#!/usr/bin/env node
/**
 * Verify the *shipped payload* against a database built the way the app builds one,
 * then run every live check against it.
 *
 * Why this exists, and why it is not "just the other checks":
 *
 *  · the individual `check:*` scripts run against a **dev server** on a database
 *    built by `db push`, which syncs everything. That combination hid a real
 *    defect: `prisma migrate deploy` — the only path the desktop app uses —
 *    created **17 of 45 tables**, so tickets, projects, cycles, chat, calendar,
 *    webhooks, OAuth apps and teamspaces would have failed with
 *    `relation "ticket" does not exist` for anyone who installed the app;
 *  · this runs the packaged `start.cjs` with the bundled runtime, against a
 *    database created by `prisma migrate deploy` and seeded, and then exercises
 *    every live check through real routes, APIs and Server Actions.
 *
 * That means it catches the class of defect unit tests cannot (they mock Prisma)
 * and the smoke test cannot (it only proves the app boots and serves a page).
 *
 *   npm run check:features
 *   npm run check:features -- --reuse      # reuse the last database (faster)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "noema-db";
const USER = "noema";
const DATABASE = "noema_verify";
const BASE = "http://127.0.0.1:3300";
const REUSE = process.argv.includes("--reuse");

/** Mock services the checks expect the *app* to be pointed at. */
const CHECK_ENV = {
  NOTION_API_BASE: "http://localhost:4322/v1",
  SSO_ISSUER: "http://localhost:4321",
  SSO_CLIENT_ID: "noema",
  SSO_CLIENT_SECRET: "secret",
};

/**
 * B11 — the operator opt-in for the loopback range.
 *
 * The payload runs with NODE_ENV=production, and the webhook checker
 * registers a hook on the hermetic receiver of `scripts/check-webhooks.mjs`
 * (127.0.0.1:4280). The delivery-time SSRF guard refuses a loopback target
 * in production unless the operator opts in explicitly, so the payload run
 * sets the opt-in here. It opens the loopback range ONLY — the calendar feed
 * path does not use it, so `check-workspace-ui` still sees a refused loopback
 * feed, and every other private range (RFC1918, link-local, cloud metadata)
 * stays refused.
 */
const LOOPBACK_OPT_IN_ENV = { NOEMA_ALLOW_LOOPBACK_TARGETS: "1" };

const CHECKS = [
  "check-routes",
  "check-tickets",
  "check-workspace-ui",
  "check-a11y",
  "check-search",
  "check-collab",
  "check-oauth",
  "check-webhooks",
  "check-share-cron",
  "check-notion",
  "check-export",
  "check-preview",
  "check-upload",
  "check-storage",
  "check-backlinks",
  "check-sso-teamspaces",
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const psql = (database, sql) =>
  spawnSync("docker", ["exec", CONTAINER, "psql", "-U", USER, "-d", database, "-tAc", sql], { encoding: "utf8" });

function prismaCli(args, env = {}) {
  return spawnSync(process.execPath, [join("node_modules", "prisma", "build", "index.js"), ...args], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl(), ...env },
    encoding: "utf8",
  });
}

/**
 * The value of a variable in the `.env` file, unquoted.
 */
function envValue(name) {
  const envFile = join(root, ".env");
  if (!existsSync(envFile)) return "";
  return ((readFileSync(envFile, "utf8").match(new RegExp(`^${name}=(.*)$`, "m")) || [])[1] || "")
    .trim()
    .replace(/^"|"$/g, "");
}

/**
 * The URL of the verification database.
 *
 * B09: the compose stack no longer starts its database with a fixed password
 * — the `db` service reads POSTGRES_PASSWORD from `.env` — so the check has
 * to read it from the same file the operator wrote. Without it the container
 * would be started with a password that cannot authenticate.
 */
function databaseUrl() {
  const password = envValue("POSTGRES_PASSWORD");
  if (!password) {
    console.error("POSTGRES_PASSWORD is missing from .env — the compose stack needs it to start its database.");
    process.exit(1);
  }
  return `postgresql://${USER}:${encodeURIComponent(password)}@localhost:5433/${DATABASE}?schema=public`;
}

function authSecret() {
  const envFile = join(root, ".env");
  if (!existsSync(envFile)) return "";
  return ((readFileSync(envFile, "utf8").match(/^AUTH_SECRET=(.*)$/m) || [])[1] || "")
    .trim()
    .replace(/^"|"$/g, "");
}

function runtimePath() {
  const dir = join(root, "src-tauri", "binaries");
  if (!existsSync(dir)) return null;
  try {
    const name = readdirSync(dir).find((entry) => /^noema-node/.test(entry));
    return name ? join(dir, name) : null;
  } catch {
    return null;
  }
}

async function main() {
  const runtime = runtimePath();
  const payload = join(root, "src-tauri", "server");
  if (!runtime || !existsSync(join(payload, "start.cjs"))) {
    console.error("Payload or bundled runtime missing — run `npm run desktop:prepare` first.");
    process.exit(1);
  }

  if (REUSE) {
    console.log("1. reusing the migrated + seeded database");
  } else {
    console.log("1. a fresh database, built the way the app builds one (prisma migrate deploy)");
    psql("postgres", `drop database if exists ${DATABASE}`);
    psql("postgres", `create database ${DATABASE}`);
    const deployed = prismaCli(["migrate", "deploy", "--schema", "prisma/schema.prisma"]);
    console.log(`   migrate deploy: exit=${deployed.status}`);
    if (deployed.status !== 0) {
      console.log((deployed.stdout || "") + (deployed.stderr || ""));
      process.exit(1);
    }
    const seeded = prismaCli(["db", "seed"]);
    console.log(`   db seed: exit=${seeded.status}`);
  }

  const tables = psql(DATABASE, "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'");
  console.log(`   tables: ${(tables.stdout || "").trim()}`);

  const secret = authSecret();
  if (!secret) {
    console.error("AUTH_SECRET is missing from .env — the checks cannot mint a session.");
    process.exit(1);
  }

  const dataDir = mkdtempSync(join(tmpdir(), "noema-features-"));
  console.log(`2. starting the shipped payload on ${BASE}`);
  const child = spawn(runtime, [join(payload, "start.cjs")], {
    cwd: payload,
    env: {
      ...process.env,
      ...CHECK_ENV,
      ...LOOPBACK_OPT_IN_ENV,
      PORT: "3300",
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      NOEMA_RUNTIME: "desktop",
      NOEMA_DATA_DIR: dataDir,
      DATABASE_URL: databaseUrl(),
      AUTH_SECRET: secret,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (chunk) => {
    serverLog += chunk;
  });
  child.stderr.on("data", (chunk) => {
    serverLog += chunk;
  });

  const deadline = Date.now() + 240_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok && (await response.text()).includes('"db":"up"')) {
        ready = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  if (!ready) {
    console.error("   the payload never became healthy:\n" + serverLog.split("\n").slice(-25).join("\n"));
    child.kill();
    process.exit(1);
  }
  console.log("   healthy\n");

  console.log("3. every live check\n");
  const results = [];
  for (const name of CHECKS) {
    const file = join(root, "scripts", `${name}.mjs`);
    if (!existsSync(file)) {
      results.push({ name, verdict: "absent" });
      continue;
    }
    const started = Date.now();
    const result = spawnSync(process.execPath, [file, BASE], {
      cwd: root,
      env: {
        ...process.env,
        ...CHECK_ENV,
        DATABASE_URL: databaseUrl(),
        NOEMA_DATABASE_URL: databaseUrl(),
        AUTH_SECRET: secret,
        CRON_SECRET: process.env.CRON_SECRET ?? "verify",
      },
      encoding: "utf8",
      timeout: 420_000,
    });
    const output = ((result.stdout || "") + (result.stderr || "")).trim();
    const tail = output.split("\n").filter((line) => line.trim() !== "").slice(-3).join(" | ");
    const seconds = Math.round((Date.now() - started) / 1000);
    results.push({ name, verdict: result.status === 0 ? "pass" : `FAIL(${result.status})`, tail });
    console.log(`   ${result.status === 0 ? "ok  " : "FAIL"} ${name}  (${seconds}s)`);
  }

  child.kill();
  await sleep(500);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // a held handle is not worth failing over
  }

  const passed = results.filter((result) => result.verdict === "pass").length;
  console.log(`\n=== ${passed}/${results.length} live checks passed ===`);
  for (const result of results) {
    if (result.verdict !== "pass") console.log(`  ${result.verdict}  ${result.name}\n    ${result.tail}`);
  }
  process.exit(passed === results.filter((result) => result.verdict !== "absent").length ? 0 : 1);
}

main().catch((error) => {
  console.error("feature check crashed:", error);
  process.exit(1);
});
