import { describe, expect, it } from "vitest";
import {
  defaultRetentionPolicy,
  describePolicy,
  prunePlan,
  selectKept,
  type BackupRef,
  type RetentionPolicy,
} from "./backup-retention";

/**
 * Backup retention policy (GFS rotation) — the pure, deterministic core.
 *
 * Red-first: this file was written BEFORE `src/lib/backup-retention.ts` existed,
 * so every import resolved to module-not-found and collection failed. It pins a
 * grandfather-father-son rotation: keep the latest backup per UTC day/week/
 * month/year for the newest N buckets of each tier, prune the rest, and never
 * prune the newest backup overall. `now` is injected, grouping is UTC only.
 */

const NOW = new Date("2026-06-15T12:00:00.000Z"); // Monday, UTC

/** Policy builder: every tier defaults to 0 (off) unless overridden. */
const policy = (overrides: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  daily: 0,
  weekly: 0,
  monthly: 0,
  yearly: 0,
  ...overrides,
});

const ref = (id: string, createdAt: string | Date): BackupRef => ({ id, createdAt });

const ids = (backups: readonly BackupRef[]): string[] => backups.map((backup) => backup.id);

describe("defaultRetentionPolicy", () => {
  it("is a sensible grandfather-father-son default", () => {
    expect(defaultRetentionPolicy).toEqual({ daily: 7, weekly: 4, monthly: 12, yearly: 3 });
  });
});

describe("describePolicy", () => {
  it("names every non-zero tier, in daily→yearly order", () => {
    expect(describePolicy(defaultRetentionPolicy)).toBe(
      "Keep 7 daily, 4 weekly, 12 monthly and 3 yearly backups.",
    );
  });

  it("reads naturally for a single tier", () => {
    expect(describePolicy(policy({ daily: 3 }))).toBe("Keep 3 daily backups.");
  });

  it("joins two tiers with `and`", () => {
    expect(describePolicy(policy({ daily: 1, weekly: 2 }))).toBe(
      "Keep 1 daily and 2 weekly backups.",
    );
  });

  it("explains the all-off case (the newest is still protected)", () => {
    expect(describePolicy(policy())).toBe("Keep only the latest backup.");
  });

  it("clamps negative and non-finite counts to zero", () => {
    const wonky = policy({ daily: -5, weekly: Number.NaN, monthly: 2 });
    expect(describePolicy(wonky)).toBe("Keep 2 monthly backups.");
  });
});

describe("selectKept — daily tier (UTC days)", () => {
  it("keeps only the latest backup within a single UTC day", () => {
    const backups = [
      ref("morning", "2026-06-15T08:00:00.000Z"),
      ref("evening", "2026-06-15T23:00:00.000Z"),
    ];
    const result = selectKept(backups, policy({ daily: 1 }), NOW);
    expect(ids(result.kept)).toEqual(["evening"]);
    expect(ids(result.pruned)).toEqual(["morning"]);
  });

  it("keeps the latest day in each of the newest N daily buckets", () => {
    const backups = [
      ref("d15", "2026-06-15T09:00:00.000Z"),
      ref("d14", "2026-06-14T09:00:00.000Z"),
      ref("d13", "2026-06-13T09:00:00.000Z"),
      ref("d12", "2026-06-12T09:00:00.000Z"),
    ];
    const result = selectKept(backups, policy({ daily: 3 }), NOW);
    expect(ids(result.kept)).toEqual(["d15", "d14", "d13"]);
    expect(ids(result.pruned)).toEqual(["d12"]);
    expect(ids(result.tiers.daily)).toEqual(["d15", "d14", "d13"]);
  });

  it("is independent of the caller's input order", () => {
    const backups = [
      ref("d13", "2026-06-13T09:00:00.000Z"),
      ref("d15", "2026-06-15T09:00:00.000Z"),
      ref("d14", "2026-06-14T09:00:00.000Z"),
    ];
    expect(ids(selectKept(backups, policy({ daily: 2 }), NOW).kept)).toEqual(["d15", "d14"]);
    expect(ids(selectKept([...backups].reverse(), policy({ daily: 2 }), NOW).kept)).toEqual([
      "d15",
      "d14",
    ]);
  });
});

describe("selectKept — weekly tier (ISO-8601 weeks)", () => {
  it("keeps the latest backup per ISO week for the newest N weeks", () => {
    // NOW is Mon 2026-06-15 → W25. W24 = Jun 8–14, W23 = Jun 1–7.
    const backups = [
      ref("w25a", "2026-06-15T08:00:00.000Z"),
      ref("w25b", "2026-06-16T08:00:00.000Z"),
      ref("w24", "2026-06-10T08:00:00.000Z"),
      ref("w23", "2026-06-03T08:00:00.000Z"),
    ];
    const result = selectKept(backups, policy({ weekly: 2 }), NOW);
    expect(ids(result.kept)).toEqual(["w25b", "w24"]);
    expect(ids(result.pruned)).toEqual(["w25a", "w23"]);
  });

  it("groups across the year boundary by ISO week-year", () => {
    // 2026-01-05 is a Monday: W02. W01 = Mon 2025-12-29 … Sun 2026-01-04.
    const boundary = new Date("2026-01-05T12:00:00.000Z");
    const backups = [
      ref("jan5", "2026-01-05T08:00:00.000Z"), // W02
      ref("dec31", "2025-12-31T08:00:00.000Z"), // W01
      ref("jan2", "2026-01-02T08:00:00.000Z"), // W01, latest
      ref("dec29", "2025-12-29T08:00:00.000Z"), // W01, oldest
    ];
    const result = selectKept(backups, policy({ weekly: 2 }), boundary);
    expect(ids(result.kept)).toEqual(["jan5", "jan2"]);
    expect(ids(result.pruned)).toEqual(["dec31", "dec29"]);
  });
});

describe("selectKept — monthly and yearly tiers", () => {
  it("keeps the latest backup per month for the newest N months", () => {
    const backups = [
      ref("junEarly", "2026-06-02T08:00:00.000Z"),
      ref("junLate", "2026-06-12T08:00:00.000Z"),
      ref("may", "2026-05-31T08:00:00.000Z"),
    ];
    const result = selectKept(backups, policy({ monthly: 1 }), NOW);
    expect(ids(result.kept)).toEqual(["junLate"]);
    expect(ids(result.pruned)).toEqual(["junEarly", "may"]);
  });

  it("keeps the latest backup per year for the newest N years", () => {
    const backups = [
      ref("early2026", "2026-01-01T08:00:00.000Z"),
      ref("late2026", "2026-06-15T08:00:00.000Z"),
      ref("y2025", "2025-12-31T08:00:00.000Z"),
    ];
    const result = selectKept(backups, policy({ yearly: 1 }), NOW);
    expect(ids(result.kept)).toEqual(["late2026"]);
    expect(ids(result.pruned)).toEqual(["early2026", "y2025"]);
  });

  it("keeps one representative per year across several years", () => {
    const backups = [
      ref("y2026", "2026-06-15T08:00:00.000Z"),
      ref("y2025", "2025-08-08T08:00:00.000Z"),
      ref("y2024", "2024-11-11T08:00:00.000Z"),
    ];
    const result = selectKept(backups, policy({ yearly: 2 }), NOW);
    expect(ids(result.kept)).toEqual(["y2026", "y2025"]);
    expect(ids(result.pruned)).toEqual(["y2024"]);
  });
});

describe("selectKept — union, safety and determinism", () => {
  it("unions the tiers and de-duplicates a backup claimed by several", () => {
    // A is the latest of W25 and of Jun 15; B is the latest of W24 and Jun 14.
    const backups = [
      ref("A", "2026-06-15T08:00:00.000Z"),
      ref("B", "2026-06-14T08:00:00.000Z"),
      ref("C", "2026-06-13T08:00:00.000Z"),
    ];
    const result = selectKept(backups, policy({ daily: 2, weekly: 2 }), NOW);
    expect(ids(result.kept)).toEqual(["A", "B"]);
    expect(ids(result.pruned)).toEqual(["C"]);
    expect(ids(result.tiers.daily)).toEqual(["A", "B"]);
    expect(ids(result.tiers.weekly)).toEqual(["A", "B"]);
  });

  it("returns the caller's own backup references", () => {
    const backups = [ref("only", "2026-06-15T08:00:00.000Z")];
    expect(selectKept(backups, policy({ daily: 1 }), NOW).kept[0]).toBe(backups[0]);
  });

  it("never prunes the newest backup, even with every tier off", () => {
    const backups = [ref("old", "2026-01-01T08:00:00.000Z"), ref("new", "2026-06-15T08:00:00.000Z")];
    const result = selectKept(backups, policy(), NOW);
    expect(ids(result.kept)).toEqual(["new"]);
    expect(ids(result.pruned)).toEqual(["old"]);
  });

  it("never prunes the newest backup even when it predates every window", () => {
    const backups = [
      ref("ancient", "2000-01-01T08:00:00.000Z"),
      ref("lessAncient", "2001-01-01T08:00:00.000Z"),
    ];
    const result = selectKept(backups, policy({ daily: 7 }), NOW);
    expect(ids(result.kept)).toEqual(["lessAncient"]);
    expect(ids(result.pruned)).toEqual(["ancient"]);
  });

  it("breaks a same-second tie deterministically by id", () => {
    const backups = [
      ref("b", "2026-06-15T10:00:00.000Z"),
      ref("a", "2026-06-15T10:00:00.000Z"),
    ];
    expect(ids(selectKept(backups, policy({ daily: 1 }), NOW).kept)).toEqual(["a"]);
    expect(ids(selectKept([...backups].reverse(), policy({ daily: 1 }), NOW).kept)).toEqual(["a"]);
  });

  it("keeps everything and prunes nothing when the window covers it all", () => {
    const backups = [
      ref("a", "2026-06-15T08:00:00.000Z"),
      ref("b", "2026-06-14T08:00:00.000Z"),
      ref("c", "2026-06-13T08:00:00.000Z"),
    ];
    const result = selectKept(backups, policy({ daily: 7 }), NOW);
    expect(ids(result.kept)).toEqual(["a", "b", "c"]);
    expect(result.pruned).toEqual([]);
  });

  it("accepts ISO strings and Date objects interchangeably", () => {
    const backups = [
      ref("asString", "2026-06-15T09:00:00.000Z"),
      ref("asDate", new Date("2026-06-15T21:00:00.000Z")),
    ];
    expect(ids(selectKept(backups, policy({ daily: 1 }), NOW).kept)).toEqual(["asDate"]);
  });

  it("treats an unparseable createdAt as the oldest, so it is pruned", () => {
    const backups = [
      ref("new", "2026-06-15T08:00:00.000Z"),
      ref("old", "2026-01-01T08:00:00.000Z"),
      ref("bad", "not-a-date"),
    ];
    const result = selectKept(backups, policy(), NOW);
    expect(ids(result.kept)).toEqual(["new"]);
    expect(ids(result.pruned)).toEqual(["old", "bad"]);
  });

  it("returns an empty, well-formed selection for no backups", () => {
    const result = selectKept([], defaultRetentionPolicy, NOW);
    expect(result.kept).toEqual([]);
    expect(result.pruned).toEqual([]);
    expect(result.tiers).toEqual({ daily: [], weekly: [], monthly: [], yearly: [] });
  });

  it("does not mutate its inputs", () => {
    const backups = [
      ref("b", "2026-06-14T08:00:00.000Z"),
      ref("a", "2026-06-15T08:00:00.000Z"),
    ];
    const snapshot = JSON.stringify(backups);
    selectKept(backups, defaultRetentionPolicy, NOW);
    expect(JSON.stringify(backups)).toBe(snapshot);
  });
});

describe("prunePlan", () => {
  it("partitions every backup into keep and prune ids, newest first", () => {
    const backups = [
      ref("A", "2026-06-15T08:00:00.000Z"),
      ref("B", "2026-06-14T08:00:00.000Z"),
      ref("C", "2026-06-13T08:00:00.000Z"),
    ];
    const plan = prunePlan(backups, policy({ daily: 2 }), NOW);
    expect(plan.keepIds).toEqual(["A", "B"]);
    expect(plan.pruneIds).toEqual(["C"]);
    expect(plan.kept).toBe(2);
    expect(plan.pruned).toBe(1);
    expect(plan.tierCounts).toEqual({ daily: 2, weekly: 0, monthly: 0, yearly: 0 });
  });

  it("reports per-tier counts that may overlap a shared backup", () => {
    const backups = [
      ref("A", "2026-06-15T08:00:00.000Z"),
      ref("B", "2026-06-14T08:00:00.000Z"),
    ];
    const plan = prunePlan(backups, policy({ daily: 2, weekly: 2 }), NOW);
    expect(plan.tierCounts).toEqual({ daily: 2, weekly: 2, monthly: 0, yearly: 0 });
    // Two tiers each claim two backups, yet only two distinct backups are kept.
    expect(plan.kept).toBe(2);
  });

  it("reports an empty plan for no backups", () => {
    const plan = prunePlan([], defaultRetentionPolicy, NOW);
    expect(plan).toEqual({
      keepIds: [],
      pruneIds: [],
      kept: 0,
      pruned: 0,
      tierCounts: { daily: 0, weekly: 0, monthly: 0, yearly: 0 },
    });
  });

  it("agrees with selectKept on what survives", () => {
    const backups = [
      ref("A", "2026-06-15T08:00:00.000Z"),
      ref("B", "2026-06-08T08:00:00.000Z"),
      ref("C", "2026-06-01T08:00:00.000Z"),
    ];
    const selection = selectKept(backups, policy({ weekly: 1, monthly: 2 }), NOW);
    const plan = prunePlan(backups, policy({ weekly: 1, monthly: 2 }), NOW);
    expect(plan.keepIds).toEqual(ids(selection.kept));
    expect(plan.pruneIds).toEqual(ids(selection.pruned));
  });
});
