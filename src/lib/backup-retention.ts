/**
 * Backup retention policy — the pure, deterministic core (GFS rotation).
 *
 * Given a list of backups and a grandfather-father-son policy, decide which
 * backups to keep and which to prune. Retention is expressed as a number of
 * buckets per tier (`daily`, `weekly`, `monthly`, `yearly`); each tier keeps the
 * latest backup in each of the newest N buckets, ending at `now`:
 *
 *  - `daily`   — the newest N UTC calendar days;
 *  - `weekly`  — the newest N ISO-8601 weeks (week starts Monday; the
 *                week-year is used, so a week straddling New Year belongs to the
 *                year that owns its Thursday);
 *  - `monthly` — the newest N UTC calendar months;
 *  - `yearly`  — the newest N UTC calendar years.
 *
 * A backup kept by any tier is kept; the kept sets are unioned and a backup
 * claimed by several tiers is kept once. Ordering is deterministic: newest
 * first, ties broken by ascending `id`.
 *
 * Safety invariant: the newest backup overall is never pruned, even when every
 * tier is off or every bucket is outside the window — mirroring the
 * `--keep`/“never the newest” rule already enforced by `scripts/backup.mjs`.
 * `now` is injectable and all grouping is UTC, so results are reproducible.
 * Nothing here reads the clock, the filesystem or the DB.
 */

/** The tiers of a grandfather-father-son rotation. */
export type RetentionTier = "daily" | "weekly" | "monthly" | "yearly";

/** How many buckets to keep per tier. A non-positive count disables a tier. */
export type RetentionPolicy = {
  /** Latest backup per UTC day, for the newest `daily` days. */
  daily: number;
  /** Latest backup per ISO-8601 week, for the newest `weekly` weeks. */
  weekly: number;
  /** Latest backup per UTC month, for the newest `monthly` months. */
  monthly: number;
  /** Latest backup per UTC year, for the newest `yearly` years. */
  yearly: number;
};

/** A backup as seen by retention: an identity and when it was taken. */
export type BackupRef = {
  /** Stable identity used for de-duplication and tie-breaking. */
  id: string;
  /** Creation instant, as a `Date` or an ISO-8601 string. */
  createdAt: Date | string;
};

/** The result of applying a policy: what survives and what is pruned. */
export type RetentionSelection = {
  /** Backups to keep, newest first. */
  kept: BackupRef[];
  /** Backups to prune, newest first. */
  pruned: BackupRef[];
  /** The representative picked per tier (may repeat across tiers), newest first. */
  tiers: Record<RetentionTier, BackupRef[]>;
};

/** A flat, id-based view of a retention pass, for an ops job or a preview UI. */
export type PrunePlan = {
  /** Ids to keep, newest first. */
  keepIds: string[];
  /** Ids to prune, newest first. */
  pruneIds: string[];
  /** How many backups are kept (`keepIds.length`). */
  kept: number;
  /** How many backups are pruned (`pruneIds.length`). */
  pruned: number;
  /** Buckets selected per tier; a backup several tiers keep is counted in each. */
  tierCounts: Record<RetentionTier, number>;
};

/** The tier order used by every output and by `describePolicy`. */
export const RETENTION_TIERS: readonly RetentionTier[] = ["daily", "weekly", "monthly", "yearly"];

/** A common rotation: a week of dailies, a month of weeklies, a year of monthlies. */
export const defaultRetentionPolicy: RetentionPolicy = {
  daily: 7,
  weekly: 4,
  monthly: 12,
  yearly: 3,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Clamp a tier count to a whole, non-negative number (bad input ⇒ off). */
function tierLimit(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The effective, sanitised policy actually applied. */
function normalizePolicy(policy: RetentionPolicy): Record<RetentionTier, number> {
  return {
    daily: tierLimit(policy.daily),
    weekly: tierLimit(policy.weekly),
    monthly: tierLimit(policy.monthly),
    yearly: tierLimit(policy.yearly),
  };
}

/** Epoch millis for a backup's `createdAt`; an unparseable value sorts oldest. */
function instantOf(backup: BackupRef): number {
  const ms =
    backup.createdAt instanceof Date ? backup.createdAt.getTime() : Date.parse(backup.createdAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** Newest first, ties broken by ascending id — the single ordering rule. */
function byNewest(a: BackupRef, b: BackupRef): number {
  const delta = instantOf(b) - instantOf(a);
  if (delta !== 0) return delta;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

const two = (value: number): string => String(value).padStart(2, "0");

/** `YYYY-MM-DD` for the instant's UTC day. */
function dayKey(date: Date): string {
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

/** `YYYY-MM` for the instant's UTC month. */
function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}`;
}

/** `YYYY` for the instant's UTC year. */
function yearKey(date: Date): string {
  return String(date.getUTCFullYear());
}

/**
 * `YYYY-Www` for the instant's ISO-8601 week-year and week number. The week
 * owning the Thursday determines both, so 2025-12-29 (Mon) → `2026-W01`.
 */
function isoWeekKey(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = (target.getUTCDay() + 6) % 7; // Mon = 0 … Sun = 6
  target.setUTCDate(target.getUTCDate() - weekday + 3); // Thursday of this week
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return `${isoYear}-W${two(week)}`;
}

/** The set of bucket keys eligible for a tier: the newest `limit` buckets at `now`. */
function windowKeys(tier: RetentionTier, limit: number, now: Date): Set<string> {
  const keys = new Set<string>();
  const nowMs = now.getTime();
  for (let i = 0; i < limit; i += 1) {
    if (tier === "daily") {
      keys.add(dayKey(new Date(nowMs - i * MS_PER_DAY)));
    } else if (tier === "weekly") {
      keys.add(isoWeekKey(new Date(nowMs - i * 7 * MS_PER_DAY)));
    } else if (tier === "monthly") {
      keys.add(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
    } else {
      keys.add(yearKey(new Date(Date.UTC(now.getUTCFullYear() - i, 0, 1))));
    }
  }
  return keys;
}

/** Bucket key for a tier, mapping a backup to its day/week/month/year slot. */
function bucketKey(tier: RetentionTier, date: Date): string {
  if (tier === "daily") return dayKey(date);
  if (tier === "weekly") return isoWeekKey(date);
  if (tier === "monthly") return monthKey(date);
  return yearKey(date);
}

/**
 * Apply `policy` to `backups` as of `now`: pick the latest backup in each
 * eligible bucket per tier, union the picks and partition the input into `kept`
 * (newest first) and `pruned` (newest first). Inputs are never mutated; the
 * returned entries are the caller's own objects.
 */
export function selectKept(
  backups: readonly BackupRef[],
  policy: RetentionPolicy,
  now: Date,
): RetentionSelection {
  const list = Array.isArray(backups) ? backups : [];
  const limits = normalizePolicy(policy);
  const tiers: Record<RetentionTier, BackupRef[]> = {
    daily: [],
    weekly: [],
    monthly: [],
    yearly: [],
  };
  const keptById = new Map<string, BackupRef>();

  for (const tier of RETENTION_TIERS) {
    const limit = limits[tier];
    if (limit <= 0) continue;

    const eligible = windowKeys(tier, limit, now);
    const bestPerBucket = new Map<string, BackupRef>();
    for (const backup of list) {
      const key = bucketKey(tier, new Date(instantOf(backup)));
      if (!eligible.has(key)) continue;
      const current = bestPerBucket.get(key);
      if (current === undefined || byNewest(backup, current) < 0) {
        bestPerBucket.set(key, backup);
      }
    }

    const picks = [...bestPerBucket.values()].sort(byNewest);
    tiers[tier] = picks;
    for (const pick of picks) {
      if (!keptById.has(pick.id)) keptById.set(pick.id, pick);
    }
  }

  // Safety invariant: the newest backup overall is never pruned.
  const newest = [...list].sort(byNewest)[0];
  if (newest !== undefined && !keptById.has(newest.id)) keptById.set(newest.id, newest);

  const kept = [...keptById.values()].sort(byNewest);
  const pruned = list.filter((backup) => !keptById.has(backup.id)).sort(byNewest);

  return { kept, pruned, tiers };
}

/**
 * The id-based counterpart of `selectKept`, ready for a prune job or a preview:
 * which ids to keep and prune (newest first) plus the per-tier bucket counts.
 */
export function prunePlan(
  backups: readonly BackupRef[],
  policy: RetentionPolicy,
  now: Date,
): PrunePlan {
  const { kept, pruned, tiers } = selectKept(backups, policy, now);
  return {
    keepIds: kept.map((backup) => backup.id),
    pruneIds: pruned.map((backup) => backup.id),
    kept: kept.length,
    pruned: pruned.length,
    tierCounts: {
      daily: tiers.daily.length,
      weekly: tiers.weekly.length,
      monthly: tiers.monthly.length,
      yearly: tiers.yearly.length,
    },
  };
}

/**
 * A one-line, human-readable summary of a policy, e.g.
 * `"Keep 7 daily, 4 weekly, 12 monthly and 3 yearly backups."`. Tiers at or
 * below zero are omitted; an all-off policy explains that only the latest
 * backup is protected.
 */
export function describePolicy(policy: RetentionPolicy): string {
  const limits = normalizePolicy(policy);
  const parts = RETENTION_TIERS.filter((tier) => limits[tier] > 0).map(
    (tier) => `${limits[tier]} ${tier}`,
  );
  if (parts.length === 0) return "Keep only the latest backup.";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Keep ${list} backups.`;
}
