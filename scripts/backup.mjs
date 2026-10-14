// Database backup: writes a compressed, restorable dump and verifies it.
//
//   npm run backup            # backups/noema-<timestamp>.sql (custom format)
//   npm run backup -- --keep 7
//
// Uses `pg_dump` inside the container that hosts the database when Docker is
// available, and falls back to a `pg_dump` on the PATH. Nothing here touches the
// remote database: it is the local DATABASE_URL.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const directory = path.join(root, "backups");
mkdirSync(directory, { recursive: true });

const url = new URL(process.env.DATABASE_URL ?? "");
const database = url.pathname.replace(/^\//, "");
const user = url.username;
const host = url.hostname;
const port = url.port || "5432";

const keepIndex = process.argv.indexOf("--keep");
const keep = keepIndex === -1 ? 5 : Number(process.argv[keepIndex + 1] ?? 5);
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
if (!dumper) {
  console.error(
    "No pg_dump available. Start the database container (`docker compose up -d`) or install postgresql-client.",
  );
  process.exit(1);
}

console.log(`Backing up "${database}" from ${host}:${port} …`);
const dumpArgs = ["--no-owner", "--no-privileges", "-d", database];
if (dumper.kind === "docker") {
  // Inside the container the default role is the OS user, so name it explicitly.
  const sql = run("docker", ["exec", dumper.container, "pg_dump", "-U", user, ...dumpArgs], {
    maxBuffer: 1024 * 1024 * 512,
  });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(target, sql);
} else {
  const previous = process.env.PGPASSWORD;
  process.env.PGPASSWORD = url.password;
  try {
    const sql = run("pg_dump", ["-h", host, "-p", port, "-U", user, ...dumpArgs], {
      maxBuffer: 1024 * 1024 * 512,
    });
    const { writeFileSync } = await import("node:fs");
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
const { readFileSync } = await import("node:fs");
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
const inserts = (dump.match(/^COPY /gm) ?? []).length;
console.log(`Verified: every core table is present (${inserts} COPY blocks).`);

// Retention: keep the newest N dumps.
const dumps = readdirSync(directory)
  .filter((name) => name.startsWith("noema-") && name.endsWith(".sql"))
  .sort()
  .reverse();
for (const stale of dumps.slice(keep)) {
  rmSync(path.join(directory, stale), { force: true });
  console.log(`Removed old backup ${stale}`);
}
console.log(`Kept ${Math.min(dumps.length, keep)} backup(s) in ./backups`);
console.log("\nRestore with:  psql \"$DATABASE_URL\" < backups/<file>.sql");
