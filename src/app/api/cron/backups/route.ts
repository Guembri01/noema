import { NextResponse } from "next/server";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { rateLimit } from "@/lib/api-guard";
import { guardOpsSecret } from "@/lib/ops-guard";
import {
  defaultRetentionPolicy,
  describePolicy,
  prunePlan,
  type BackupRef,
  type RetentionPolicy,
} from "@/lib/backup-retention";

export const runtime = "nodejs";

/**
 * Backup-retention cron (`src/lib/backup-retention.ts`, GFS rotation). Point a
 * scheduler at this endpoint; protect it by setting CRON_SECRET and sending
 * `x-cron-secret: <value>` — the same fail-closed guard + fixed-window
 * rate-limit as `api/cron/versions` / `api/cron/templates`.
 *
 * `scripts/backup.mjs` writes `noema-<timestamp>.sql` dumps and their sibling
 * `noema-<timestamp>.manifest.json` files under `BACKUP_DIR` (default
 * `./backups`). This route lists those dumps, hands their `{ id, createdAt }`
 * refs to the pure policy (`prunePlan`) and unlinks exactly the ids the policy
 * returns — the dump first, then its manifest. The pure core never prunes the
 * newest dump, even when every tier is disabled.
 *
 * Policy comes from the `BACKUP_RETENTION_DAILY|WEEKLY|MONTHLY|YEARLY` env
 * knobs, each falling back to `defaultRetentionPolicy` (7/4/12/3) on unset,
 * blank or non-numeric input.
 *
 * Response: `evaluated` dumps considered, `kept`/`keepIds` and
 * `pruned`/`pruneIds` from the plan, the human-readable `policy`, per-tier
 * bucket counts and any per-file `failed[]` unlink errors (reported, never
 * thrown — a locked file does not block the rest of the sweep).
 */

/** A dump artifact is `noema-*.sql`; manifests/notes are never retention units. */
const DUMP_PATTERN = /^noema-.*\.sql$/;

/** Read a non-negative integer env knob, falling back on unset/blank/junk. */
function envCount(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** The effective policy: each tier from its env knob, else the documented default. */
function retentionPolicy(): RetentionPolicy {
  return {
    daily: envCount("BACKUP_RETENTION_DAILY", defaultRetentionPolicy.daily),
    weekly: envCount("BACKUP_RETENTION_WEEKLY", defaultRetentionPolicy.weekly),
    monthly: envCount("BACKUP_RETENTION_MONTHLY", defaultRetentionPolicy.monthly),
    yearly: envCount("BACKUP_RETENTION_YEARLY", defaultRetentionPolicy.yearly),
  };
}

/** Directory the dump files live in. */
function backupDir(): string {
  return process.env.BACKUP_DIR?.trim() || "backups";
}

/**
 * The instant a dump was taken: the timestamp embedded in
 * `noema-YYYY-MM-DDTHH-MM-SS.sql`, else the file's mtime (a renamed/copied
 * dump still participates in the rotation rather than sorting oldest forever).
 */
function createdAtOf(name: string, mtimeMs: number): Date {
  const match = /^noema-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.sql$/.exec(name);
  if (match) {
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date(mtimeMs);
}

/** The sibling manifest that travels with a pruned dump. */
function manifestNameFor(dump: string): string {
  return dump.endsWith(".sql") ? `${dump.slice(0, -4)}.manifest.json` : `${dump}.manifest.json`;
}

export async function GET(request: Request) {
  // The shared gate: fail closed without a secret, throttle before the
  // comparison (a wrong secret is bounded, not an unbounded guessing oracle),
  // and compare the secret in constant time.
  const gate = guardOpsSecret(request, {
    secret: process.env.CRON_SECRET,
    limit: () => rateLimit(request, "cron", 12, 60_000),
  });
  if (!gate.ok) return gate.response;

  const now = new Date();
  const policy = retentionPolicy();
  const dir = backupDir();

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    // A missing backup directory is an empty pass, not an error.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({
        evaluated: 0,
        kept: 0,
        pruned: 0,
        keepIds: [],
        pruneIds: [],
        policy: describePolicy(policy),
        tierCounts: { daily: 0, weekly: 0, monthly: 0, yearly: 0 },
        failed: [],
      });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }

  const refs: BackupRef[] = [];
  for (const name of names) {
    if (!DUMP_PATTERN.test(name)) continue;
    const info = await stat(join(dir, name));
    refs.push({ id: name, createdAt: createdAtOf(name, info.mtimeMs) });
  }

  const plan = prunePlan(refs, policy, now);

  let pruned = 0;
  const failed: { id: string; error: string }[] = [];
  for (const id of plan.pruneIds) {
    try {
      await unlink(join(dir, id));
      // The manifest is optional — a dump without one is still pruned.
      await unlink(join(dir, manifestNameFor(id))).catch(() => undefined);
      pruned += 1;
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (pruned > 0 || failed.length > 0) {
    console.info(
      `[cron/backups] evaluated ${refs.length} dumps: kept ${plan.kept}, pruned ${pruned}, failed ${failed.length}`,
    );
  }

  return NextResponse.json({
    evaluated: refs.length,
    kept: plan.kept,
    pruned,
    keepIds: plan.keepIds,
    pruneIds: plan.pruneIds,
    policy: describePolicy(policy),
    tierCounts: plan.tierCounts,
    failed,
  });
}
