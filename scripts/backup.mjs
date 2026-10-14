// Database backup: writes a compressed, restorable dump and verifies it.
//
//   npm run backup                 # backups/noema-<timestamp>.sql + sibling manifest
//   npm run backup -- --keep 7     # retention: keep the newest 7 dumps
//   npm run backup -- --dry-run    # print the plan, touch nothing
//
// Every successful backup writes a sibling `noema-<timestamp>.manifest.json`
// (timestamp, per-table row counts parsed from the dump, prisma schema
// fingerprint, app version) so a restore can be checked against what was
// captured. Retention keeps the newest N dumps (`--keep`, default 5) and NEVER
// prunes the newest one; each pruned dump takes its manifest with it.
//
// Restore + verification hook (manual, documented here):
//   psql "$DATABASE_URL" < backups/<file>.sql
//   createdb noema-restore-check && psql -d noema-restore-check < backups/<file>.sql
//   → compare the restored table row counts against backups/<file>.manifest.json
//   → drop the check database:  dropdb noema-restore-check
//
// Uses `pg_dump` inside the container that hosts the database when Docker is
// available, and falls back to a `pg_dump` on the PATH. Nothing here touches the
// remote database: it is the local DATABASE_URL.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_KEEP,
  buildManifest,
  formatDryRunPlan,
  manifestNameFor,
  parseRowCounts,
  planRetention,
  schemaFingerprint,
} from "./backup-lib.mjs";

const root = process.cwd();
const directory = path.join(root, "backups");

const url = new URL(process.env.DATABASE_URL ?? "");
const database = url.pathname.replace(/^\//, "");
const user = url.username;
const host = url.hostname;
const port = url.port || "5432";

const keepIndex = process.argv.indexOf("--keep");
const keep = keepIndex === -1 ? DEFAULT_KEEP : Number(process.argv[keepIndex + 1] ?? DEFAULT_KEEP);
const dryRun = process.argv.includes("--dry-run");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const target = path.join(directory, `noema-${stamp}.sql`);

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

/** Prefer the container that hosts this database (the docker-compose default). */
function pickDumpCommand() {
  const containers = ["noema-db"];
  for (const container of containers) {
    try {
      run("docker", ["exec", container, "which", "pg_dump"]);
      return { kind: "docker", container };
    } catch {
      /* try the next option */
    }
  }
  try {
    run("pg_dump", ["--version"]);
    return { kind: "path" };
  } catch {
    return null;
  }
}

const dumper = pickDumpCommand();

/* ------------------------------------------------------------------ *
 * --dry-run: print the plan and exit — no mkdir, no dump, no prune.
 * ------------------------------------------------------------------ */
if (dryRun) {
  const existing = existsSync(directory) ? readdirSync(directory) : [];
  // A real run writes the new dump first — include it so the preview matches.
  const plan = planRetention([...existing, path.basename(target)], keep);
  console.log(
    formatDryRunPlan({
      root,
      database,
      host,
      port,
      dumper,
      target,
      keep: plan.keep,
      retained: plan.retained,
      prunable: plan.prunable,
    }),
  );
  process.exit(0);
}

if (!dumper) {
  console.error(
    "No pg_dump available. Start the database container (`docker compose up -d`) or install postgresql-client.",
  );
  process.exit(1);
}

mkdirSync(directory, { recursive: true });

console.log(`Backing up "${database}" from ${host}:${port} …`);
const dumpArgs = ["--no-owner", "--no-privileges", "-d", database];
if (dumper.kind === "docker") {
  // Inside the container the default role is the OS user, so name it explicitly.
  const sql = run("docker", ["exec", dumper.container, "pg_dump", "-U", user, ...dumpArgs], {
    maxBuffer: 1024 * 1024 * 512,
  });
  writeFileSync(target, sql);
} else {
  const previous = process.env.PGPASSWORD;
  process.env.PGPASSWORD = url.password;
  try {
    const sql = run("pg_dump", ["-h", host, "-p", port, "-U", user, ...dumpArgs], {
      maxBuffer: 1024 * 1024 * 512,
    });
    writeFileSync(target, sql);
  } finally {
    process.env.PGPASSWORD = previous;
  }
}

const size = statSync(target).size;
if (size < 1024) {
  console.error(`Backup looks empty (${size} bytes) — refusing to keep it.`);
  rmSync(target, { force: true });
  process.exit(1);
}

// A restorable dump declares its own schema; check it actually created the tables.
const dump = readFileSync(target, "utf8");
const expectedTables = ["User", "Workspace", "Page", "Ticket", "Activity"];
const missing = expectedTables.filter(
  (table) => !new RegExp(`CREATE TABLE (?:public\\.)?"?${table}"?`, "i").test(dump),
);
console.log(`Wrote ${path.relative(root, target)} (${(size / 1024).toFixed(1)} KB)`);
if (missing.length > 0) {
  console.error(`Backup is missing expected tables: ${missing.join(", ")}`);
  rmSync(target, { force: true });
  process.exit(1);
}
const rowCounts = parseRowCounts(dump);
const inserts = (dump.match(/^COPY /gm) ?? []).length;
console.log(`Verified: every core table is present (${inserts} COPY blocks).`);

// Manifest: timestamp, row counts, schema/app version — written next to the dump.
const readOptional = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const pkg = JSON.parse(readOptional(path.join(root, "package.json")) ?? "{}");
const schemaText = readOptional(path.join(root, "prisma", "schema.prisma"));
const manifestTarget = path.join(directory, manifestNameFor(path.basename(target)));
const manifest = buildManifest({
  timestamp: new Date().toISOString(),
  file: path.basename(target),
  sizeBytes: size,
  rowCounts,
  schemaVersion: schemaText === null ? "unknown" : schemaFingerprint(schemaText),
  appVersion: pkg.version ?? "unknown",
  keep: planRetention([], keep).keep,
});
writeFileSync(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Wrote ${path.relative(root, manifestTarget)} (${Object.keys(rowCounts).length} tables, ${manifest.rowCountTotal} rows, schema ${manifest.schemaVersion}, app ${manifest.appVersion}).`,
);

// Retention: keep the newest N dumps (never the newest) + their manifests.
const plan = planRetention(readdirSync(directory), keep);
for (const stale of plan.prunable) {
  rmSync(path.join(directory, stale), { force: true });
  rmSync(path.join(directory, manifestNameFor(stale)), { force: true });
  console.log(`Removed old backup ${stale}`);
}
console.log(`Kept ${plan.retained.length} backup(s) in ./backups (keep ${plan.keep})`);
console.log(`\nRestore with:  psql "$DATABASE_URL" < backups/${path.basename(target)}`);
console.log("Verify restore: createdb noema-restore-check && psql -d noema-restore-check < backups/<file>.sql");
console.log(`  then compare row counts against backups/${path.basename(manifestTarget)} and dropdb noema-restore-check`);
