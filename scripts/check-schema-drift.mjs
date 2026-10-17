#!/usr/bin/env node
/**
 * Schema drift gate: the migrations must describe the schema, and applying them to
 * an empty database must create **every model**.
 *
 * Why this exists: the schema declared 45 models while the single migration created
 * 17 tables and left 28 columns off the existing ones. Every check in the repo
 * passed — unit tests mock Prisma, e2e and dev databases are built with `db push`
 * (which syncs everything), and the desktop smoke test asserted "more than ten
 * tables". The only databases built the way the *app* builds them (the boot
 * wrapper's `prisma migrate deploy`) were missing tickets, projects, cycles, chat,
 * calendar, webhooks, OAuth apps, teamspaces, 2FA columns and `Page.searchText`.
 * Real users would have hit `relation "ticket" does not exist`.
 *
 * So this gate asserts the two properties that were silently false:
 *   1. `migrate diff --from-migrations … --to-schema-datamodel` is empty (no drift);
 *   2. after `migrate deploy` on an empty database, every `model` in the schema has
 *      a table.
 *
 * The shadow database is the app's own embedded engine (PGlite), so the gate needs
 * nothing installed and no network.
 *
 *   npm run check:schema
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startEmbeddedDatabase } from "./desktop/embedded-db.cjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRISMA_CLI = join(root, "node_modules", "prisma", "build", "index.js");
const SCHEMA = join(root, "prisma", "schema.prisma");
const MIGRATIONS = join(root, "prisma", "migrations");

/** Run the Prisma CLI and resolve with its result (async: the database is local). */
function prisma(args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [PRISMA_CLI, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) => resolveRun({ code: 1, out, err: `${err}${error && error.message}` }));
    child.on("close", (code) => resolveRun({ code: code ?? 1, out, err }));
  });
}

/** Every model the schema declares. */
function models() {
  const schema = readFileSync(SCHEMA, "utf8");
  return [...schema.matchAll(/^model (\w+)/gm)].map((match) => match[1]);
}

const failures = [];
const ok = (condition, label, detail = "") => {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
};

async function main() {
  console.log("Schema drift check (migrations vs schema, and a real migrate)\n");

  if (!existsSync(PRISMA_CLI)) {
    console.error("prisma CLI not found — run `npm install` first.");
    process.exit(1);
  }
  if (!existsSync(MIGRATIONS)) {
    console.error("prisma/migrations is missing — this project is expected to ship migrations.");
    process.exit(1);
  }

  const work = mkdtempSync(join(tmpdir(), "noema-schema-"));

  // Two databases, used one after the other: `migrate diff` *applies* every
  // migration inside its shadow database, so reusing that directory for the
  // `migrate deploy` assertion below would find a non-empty database and fail with
  // P3005 — a mistake this gate made on its own first run.
  const shadow = await startEmbeddedDatabase({ dataDir: join(work, "shadow") });
  try {
    // 1. Drift: replay every migration in the shadow database, then compare the
    //    result with the schema. Any SQL here means the migrations are behind.
    //
    //    The shadow URL is an *argument* here — Prisma has no environment
    //    alternative for `--shadow-database-url` ("You must pass the
    //    --shadow-database-url if you want to diff a migrations directory", it
    //    says). So this one command line carries the shadow database's
    //    password. It is a throwaway database that holds nothing but this
    //    project's schema and lives for the seconds this gate takes; the
    //    desktop app never does this (there the URL travels in the
    //    environment).
    const diff = await prisma(
      [
        "migrate",
        "diff",
        "--from-migrations",
        MIGRATIONS,
        "--to-schema-datamodel",
        SCHEMA,
        "--shadow-database-url",
        shadow.url,
        "--script",
      ],
      { DATABASE_URL: shadow.url },
    );
    const sql = diff.out.trim();
    const empty = /^-- This is an empty migration\.?$/.test(sql);
    ok(diff.code === 0, "migrate diff ran", diff.code === 0 ? "" : diff.err.trim().split("\n").slice(-1)[0]);
    ok(
      diff.code === 0 && (empty || sql.length === 0),
      "the migrations describe the schema (zero drift)",
      empty || sql.length === 0 ? "" : `${(sql.match(/;/g) || []).length} statements of drift:\n${sql.split("\n").slice(0, 12).join("\n")}`,
    );
  } finally {
    await shadow.stop();
  }

  // 2. A real apply on an empty database, so the gate proves the user-visible
  //    property rather than only the diff: every model gets a table.
  const fresh = await startEmbeddedDatabase({ dataDir: join(work, "fresh") });
  try {
    const deploy = await prisma(["migrate", "deploy", "--schema", SCHEMA], { DATABASE_URL: fresh.url });
    ok(deploy.code === 0, "prisma migrate deploy succeeded on an empty database",
      deploy.code === 0 ? "" : ((deploy.out + deploy.err).trim().split("\n").slice(-1)[0] ?? ""));
  } finally {
    await fresh.stop();
  }

  if (!failures.includes("prisma migrate deploy succeeded on an empty database")) {
    const { PGlite } = await import("@electric-sql/pglite");
    // Read the files directly, now that every server has stopped: a second engine on
    // a live directory would not see the other's writes.
    const probe = new PGlite(join(work, "fresh", "pgdata"));
    await probe.waitReady;
    const listed = await probe.query("select tablename from pg_tables where schemaname = 'public'");
    const names = listed.rows.map((row) => row.tablename);
    const missing = models().filter((model) => !names.includes(model));
    ok(
      missing.length === 0,
      `every model has a table after migrate deploy (${models().length} models)`,
      missing.length ? `${missing.length} missing: ${missing.join(", ")}` : `${names.length} tables`,
    );
    await probe.close();
  }

  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // A held file handle on Windows is not worth failing the gate over.
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} failure(s): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("Migrations and schema agree, and a fresh database gets every model.");
}

main().catch((error) => {
  console.error("schema drift check crashed:", error);
  process.exit(1);
});
