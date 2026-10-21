// Database backup: writes an encrypted, restorable dump and verifies it.
//
//   npm run backup                 # backups/noema-<timestamp>.sql.enc + sibling manifest
//   npm run backup -- --keep 7     # retention: keep the newest 7 dumps
//   npm run backup -- --dry-run    # print the plan, touch nothing
//
// Every successful backup writes a sibling `noema-<timestamp>.manifest.json`
// (timestamp, per-table row counts parsed from the dump, prisma schema
// fingerprint, app version) so a restore can be checked against what was
// captured. Retention keeps the newest N dumps (`--keep`, default 5) and NEVER
// prunes the newest one; each pruned dump takes its manifest with it.
//
// B62: a dump is the most secret file this product writes — the `COPY` blocks
// carry every password hash, 2FA seed, OAuth client secret and provider key in
// cleartext. So the dump is sealed (AES-256-GCM, passphrase from
// BACKUP_ENCRYPTION_KEY), written with mode 0600 into a 0700 directory, and
// the plaintext never touches the disk. Without BACKUP_ENCRYPTION_KEY the
// script fails closed: no dump is written at all, never an unencrypted one.
//
// Restore + verification hook (manual, documented here):
//   node scripts/backup-restore.mjs backups/<file>.sql.enc | psql "$DATABASE_URL"
//   createdb noema-restore-check && node scripts/backup-restore.mjs backups/<file>.sql.enc | psql -d noema-restore-check
//   → compare the restored table row counts against backups/<file>.manifest.json
//   → drop the check database:  dropdb noema-restore-check
//
// Uses `pg_dump` inside the container that hosts the database when Docker is
// available, and falls back to a `pg_dump` on the PATH. Nothing here touches the
// remote database: it is the local DATABASE_URL.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  BACKUP_CIPHER,
  BACKUP_DIR_MODE,
  BACKUP_FILE_MODE,
  DEFAULT_KEEP,
  buildManifest,
  decryptBackup,
  encryptBackup,
  formatDryRunPlan,
  manifestNameFor,
  parseRowCounts,
  planRetention,
  resolveBackupPassphrase,
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
const target = path.join(directory, `noema-${stamp}.sql.enc`);

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
      encryption: resolveBackupPassphrase(process.env),
    }),
  );
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * The seal comes before the dump: without a passphrase there is no
 * backup at all — an unencrypted dump is never written.
 * ------------------------------------------------------------------ */
const passphrase = resolveBackupPassphrase(process.env);
if (!passphrase.ok) {
  console.error(passphrase.reason);
  process.exit(1);
}

if (!dumper) {
  console.error(
    "No pg_dump available. Start the database container (`docker compose up -d`) or install postgresql-client.",
  );
  process.exit(1);
}

console.log(`Backing up "${database}" from ${host}:${port} …`);
const dumpArgs = ["--no-owner", "--no-privileges", "-d", database];
let sql;
if (dumper.kind === "docker") {
  // Inside the container the default role is the OS user, so name it explicitly.
  sql = run("docker", ["exec", dumper.container, "pg_dump", "-U", user, ...dumpArgs], {
    maxBuffer: 1024 * 1024 * 512,
  });
} else {
  const previous = process.env.PGPASSWORD;
  process.env.PGPASSWORD = url.password;
  try {
    sql = run("pg_dump", ["-h", host, "-p", port, "-U", user, ...dumpArgs], {
      maxBuffer: 1024 * 1024 * 512,
    });
  } finally {
    process.env.PGPASSWORD = previous;
  }
}

// The dump stays in memory: it is verified there, sealed there, and only the
// sealed bytes ever reach the disk.
const plaintext = Buffer.from(sql, "utf8");
const size = plaintext.length;
if (size < 1024) {
  console.error(`Backup looks empty (${size} bytes) — refusing to keep it.`);
  process.exit(1);
}

// A restorable dump declares its own schema; check it actually created the tables.
const dump = plaintext.toString("utf8");
const expectedTables = ["User", "Workspace", "Page", "Ticket", "Activity"];
const missing = expectedTables.filter(
  (table) => !new RegExp(`CREATE TABLE (?:public\\.)?"?${table}"?`, "i").test(dump),
);
if (missing.length > 0) {
  console.error(`Backup is missing expected tables: ${missing.join(", ")}`);
  process.exit(1);
}
const rowCounts = parseRowCounts(dump);
const inserts = (dump.match(/^COPY /gm) ?? []).length;
console.log(`Verified: every core table is present (${inserts} COPY blocks).`);

// The dump directory belongs to the operator alone.
mkdirSync(directory, { recursive: true, mode: BACKUP_DIR_MODE });
try {
  chmodSync(directory, BACKUP_DIR_MODE);
} catch (error) {
  console.warn(
    `Could not restrict ${path.relative(root, directory) || directory} to mode 0700 (${error.message}) — the dump itself is still written with mode 0600.`,
  );
}

// Seal, write, seal-proof: the artifact on disk is 0600 and the plaintext is
// never written anywhere.
const sealed = encryptBackup(plaintext, passphrase.passphrase);
writeFileSync(target, sealed, { mode: BACKUP_FILE_MODE });
chmodSync(target, BACKUP_FILE_MODE);
console.log(
  `Wrote ${path.relative(root, target)} (${(sealed.length / 1024).toFixed(1)} KB, ${BACKUP_CIPHER})`,
);

// Prove the artifact restores before it is called a backup: open the file that
// is on disk and compare it with the dump that was verified.
try {
  const reopened = decryptBackup(readFileSync(target), passphrase.passphrase);
  if (!reopened.equals(plaintext)) {
    console.error("The sealed backup did not open back to the dump — removing it.");
    rmSync(target, { force: true });
    process.exit(1);
  }
} catch (error) {
  console.error(`The sealed backup could not be opened again (${error.message}) — removing it.`);
  rmSync(target, { force: true });
  process.exit(1);
}

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
  encryption: BACKUP_CIPHER,
});
writeFileSync(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`, { mode: BACKUP_FILE_MODE });
chmodSync(manifestTarget, BACKUP_FILE_MODE);
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
console.log(
  `\nRestore with:  node scripts/backup-restore.mjs backups/${path.basename(target)} | psql "$DATABASE_URL"`,
);
console.log(
  "Verify restore: createdb noema-restore-check && node scripts/backup-restore.mjs backups/<file>.sql.enc | psql -d noema-restore-check",
);
console.log(`  then compare row counts against backups/${path.basename(manifestTarget)} and dropdb noema-restore-check`);
