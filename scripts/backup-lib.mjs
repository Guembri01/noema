// B92 — pure helpers for scripts/backup.mjs (backup hardening).
//
// Everything here is a pure function: no fs, no docker, no pg_dump — that is
// what makes `--dry-run`, the per-backup manifest.json and keep-N retention
// unit-testable under vitest (scripts/backup-lib.test.mjs).
import { createHash } from "node:crypto";
import path from "node:path";

/** Default number of dumps retained when `--keep` is absent or invalid. */
export const DEFAULT_KEEP = 5;

/** Only `noema-*.sql` dumps are backup artifacts (manifests/notes never are). */
export function isBackupDump(name) {
  return name.startsWith("noema-") && name.endsWith(".sql");
}

/** `noema-<stamp>.sql` → `noema-<stamp>.manifest.json` (its sibling manifest). */
export function manifestNameFor(dumpName) {
  return dumpName.endsWith(".sql") ? `${dumpName.slice(0, -4)}.manifest.json` : `${dumpName}.manifest.json`;
}

/**
 * Row counts per table, parsed from the dump's `COPY … FROM stdin;` blocks
 * (one row per line until the `\.` terminator). A table whose block is empty
 * counts 0 — the block being present is what proves the table exists.
 */
export function parseRowCounts(dump) {
  const counts = {};
  let current = null;
  for (const line of dump.split(/\r?\n/)) {
    if (current === null) {
      const match = /^COPY\s+(.+?)\s+\([^)]*\)\s+FROM stdin;\s*$/.exec(line);
      if (match) {
        const relation = match[1].split(".").pop() ?? "";
        current = relation.replace(/^"|"$/g, "");
        counts[current] = 0;
      }
    } else if (line === "\\.") {
      current = null;
    } else {
      counts[current] += 1;
    }
  }
  return counts;
}

/**
 * Short, stable fingerprint of prisma/schema.prisma — the manifest's
 * `schemaVersion`. Changes whenever the schema text changes.
 */
export function schemaFingerprint(schemaText) {
  return createHash("sha256").update(schemaText, "utf8").digest("hex").slice(0, 12);
}

/**
 * Assemble the manifest written next to every successful backup: timestamp,
 * row counts (parsed from the dump), schema fingerprint and app version.
 */
export function buildManifest({ timestamp, file, sizeBytes, rowCounts, schemaVersion, appVersion, keep }) {
  const counts = { ...rowCounts };
  return {
    timestamp,
    file,
    sizeBytes,
    schemaVersion,
    appVersion,
    keep,
    rowCounts: counts,
    rowCountTotal: Object.values(counts).reduce((sum, n) => sum + n, 0),
  };
}

/** `--keep` is trusted only when it is a finite number ≥ 1 (floored). */
function normalizeKeep(keep) {
  const n = Number(keep);
  if (!Number.isFinite(n)) return DEFAULT_KEEP;
  return Math.max(1, Math.floor(n));
}

/**
 * Retention plan: newest-first (dump names are ISO timestamps, so they sort
 * lexicographically), keep the newest N, prune the rest.
 *
 * Invariants the tests pin:
 * - the newest dump is NEVER pruned — `keep` is clamped to ≥ 1;
 * - files that are not dumps (manifests, notes) are never listed at all;
 * - invalid `keep` (NaN, undefined, "banana") falls back to DEFAULT_KEEP.
 */
export function planRetention(names, keep) {
  const effectiveKeep = normalizeKeep(keep);
  const dumps = names.filter(isBackupDump).sort().reverse();
  return {
    keep: effectiveKeep,
    retained: dumps.slice(0, effectiveKeep),
    prunable: dumps.slice(effectiveKeep),
  };
}

/** Human-readable `--dry-run` plan. Pure: prints nothing, returns the text. */
export function formatDryRunPlan({ root, database, host, port, dumper, target, keep, retained, prunable }) {
  const rel = (file) => path.relative(root, file).split(path.sep).join("/");
  const dumpPath = rel(target);
  const manifestPath = rel(manifestNameFor(target));
  const via =
    dumper === null
      ? "NO pg_dump (container unreachable and none on PATH)"
      : dumper.kind === "docker"
        ? `docker container "${dumper.container}"`
        : "pg_dump on PATH";
  const lines = [
    "DRY RUN — nothing will be written or removed.",
    `Source:      database "${database}" at ${host}:${port} via ${via}`,
  ];
  if (dumper === null) {
    lines.push("would FAIL: no pg_dump available (start the database container or install postgresql-client).");
  }
  lines.push(
    `Target:      ${dumpPath}`,
    `Manifest:    ${manifestPath}`,
    `Restore:     psql "$DATABASE_URL" < ${dumpPath}`,
    `             createdb noema-restore-check && psql -d noema-restore-check < ${dumpPath}`,
    `             then compare row counts against ${manifestPath}`,
    `Retention:   keep ${keep} — ${retained.length} kept, ${prunable.length} would be removed`,
  );
  const dir = path.dirname(target);
  for (const name of retained) lines.push(`  keep         ${rel(path.join(dir, name))}`);
  for (const name of prunable) lines.push(`  would remove ${rel(path.join(dir, name))}`);
  return lines.join("\n");
}
