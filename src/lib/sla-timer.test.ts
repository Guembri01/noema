import { describe, expect, it } from "vitest";
import {
  DEFAULT_WARN_PERCENT,
  computeSlaDue,
  formatRemaining,
  nextBreach,
  slaStatus,
  type SlaItem,
  type SlaPolicies,
  type SlaPolicy,
} from "@/lib/sla-timer";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

const policy: SlaPolicy = { responseMinutes: 60, resolveMinutes: 480, warnAtPercent: 80 };

describe("computeSlaDue — creation instant + policy → deadline", () => {
  it("computes the response and resolve deadlines from the minute windows", () => {
    expect(computeSlaDue(BASE, policy, { kind: "response" })).toStrictEqual({
      kind: "response",
      startedAt: BASE,
      dueAt: BASE + HOUR,
      windowMs: HOUR,
    });
    expect(computeSlaDue(BASE, policy, { kind: "resolve" })).toStrictEqual({
      kind: "resolve",
      startedAt: BASE,
      dueAt: BASE + 8 * HOUR,
      windowMs: 8 * HOUR,
    });
  });

  it("accepts a Date or an ISO string as the creation instant", () => {
    const asDate = computeSlaDue(new Date(BASE), policy, { kind: "response" });
    const asString = computeSlaDue(new Date(BASE).toISOString(), policy, { kind: "response" });
    expect(asDate?.dueAt).toBe(BASE + HOUR);
    expect(asString?.dueAt).toBe(BASE + HOUR);
  });

  it("supports fractional minute windows", () => {
    const due = computeSlaDue(BASE, { responseMinutes: 0.5, resolveMinutes: 1 }, { kind: "response" });
    expect(due?.windowMs).toBe(30_000);
  });

  it("returns null for an unparseable instant or a non-positive window", () => {
    expect(computeSlaDue("not-a-date", policy, { kind: "response" })).toBeNull();
    expect(computeSlaDue(BASE, { responseMinutes: 0, resolveMinutes: 0 }, { kind: "response" })).toBeNull();
    expect(computeSlaDue(BASE, { responseMinutes: Number.NaN, resolveMinutes: 1 }, { kind: "response" })).toBeNull();
    expect(computeSlaDue(BASE, { responseMinutes: 1, resolveMinutes: -5 }, { kind: "resolve" })).toBeNull();
  });
});

describe("slaStatus — grading a deadline for an injected now", () => {
  const due = BASE + HOUR;

  it("grades ok, warning and overdue across the warning band", () => {
    expect(slaStatus(BASE, due, { warnAtPercent: 80, windowMs: HOUR })).toStrictEqual({
      status: "ok",
      remainingMs: HOUR,
    });
    expect(slaStatus(BASE + 50 * MIN, due, { warnAtPercent: 80, windowMs: HOUR })).toStrictEqual({
      status: "warning",
      remainingMs: 10 * MIN,
    });
    // Exactly 20% of the window left is the inclusive edge of the band.
    expect(slaStatus(BASE + 48 * MIN, due, { warnAtPercent: 80, windowMs: HOUR }).status).toBe("warning");
    expect(slaStatus(due - 720_001, due, { warnAtPercent: 80, windowMs: HOUR }).status).toBe("ok");
  });

  it("treats the deadline instant and everything after it as overdue", () => {
    expect(slaStatus(due, due, { windowMs: HOUR })).toStrictEqual({ status: "overdue", remainingMs: 0 });
    expect(slaStatus(due + MIN, due, { windowMs: HOUR })).toStrictEqual({
      status: "overdue",
      remainingMs: -MIN,
    });
    expect(slaStatus(new Date(BASE), due, { windowMs: HOUR }).status).toBe("ok");
  });

  it("defaults warnAtPercent to DEFAULT_WARN_PERCENT", () => {
    expect(slaStatus(BASE + 50 * MIN, due, { windowMs: HOUR })).toStrictEqual(
      slaStatus(BASE + 50 * MIN, due, { warnAtPercent: DEFAULT_WARN_PERCENT, windowMs: HOUR }),
    );
  });

  it("disables the warning band without a positive windowMs", () => {
    expect(slaStatus(due - 1, due).status).toBe("ok");
    expect(slaStatus(due, due).status).toBe("overdue");
    expect(slaStatus(due - 1, due, { windowMs: 0 }).status).toBe("ok");
  });

  it("clamps warnAtPercent into [0, 100]", () => {
    expect(slaStatus(BASE, due, { warnAtPercent: -10, windowMs: HOUR }).status).toBe("warning");
    expect(slaStatus(BASE + 59 * MIN, due, { warnAtPercent: 150, windowMs: HOUR }).status).toBe("ok");
  });

  it("treats an unparseable deadline as overdue with NaN remaining", () => {
    const bad = slaStatus(BASE, "not-a-date");
    expect(bad.status).toBe("overdue");
    expect(Number.isNaN(bad.remainingMs)).toBe(true);
  });
});

describe("formatRemaining — compact duration text", () => {
  it("renders the largest two units", () => {
    expect(formatRemaining(0)).toBe("0s");
    expect(formatRemaining(500)).toBe("0s");
    expect(formatRemaining(1_000)).toBe("1s");
    expect(formatRemaining(59_000)).toBe("59s");
    expect(formatRemaining(150_000)).toBe("2m 30s");
    expect(formatRemaining(45 * MIN)).toBe("45m");
    expect(formatRemaining(HOUR)).toBe("1h");
    expect(formatRemaining(HOUR + MIN + 1_000)).toBe("1h 1m");
    expect(formatRemaining(DAY + 3 * HOUR)).toBe("1d 3h");
  });

  it("keeps the sign for a past deadline and rejects non-finite input", () => {
    expect(formatRemaining(-150_000)).toBe("-2m 30s");
    expect(formatRemaining(Number.NaN)).toBe("");
    expect(formatRemaining(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("nextBreach — most urgent outstanding deadline", () => {
  const policies: SlaPolicies = {
    standard: { responseMinutes: 60, resolveMinutes: 480, warnAtPercent: 80 },
  };
  const items: SlaItem[] = [
    { id: "r1", createdAt: BASE, policyId: "standard" },
    { id: "r2", createdAt: BASE + 30 * MIN, policyId: "standard" },
  ];

  it("picks the earliest due deadline across the queue", () => {
    expect(nextBreach(items, policies)).toStrictEqual({
      itemId: "r1",
      kind: "response",
      dueAt: BASE + HOUR,
      policyId: "standard",
    });
  });

  it("skips a timer that has already been satisfied", () => {
    const answered: SlaItem[] = [
      { id: "r1", createdAt: BASE, policyId: "standard", respondedAt: BASE + 10 * MIN },
    ];
    expect(nextBreach(answered, policies)).toStrictEqual({
      itemId: "r1",
      kind: "resolve",
      dueAt: BASE + 8 * HOUR,
      policyId: "standard",
    });
  });

  it("breaks an exact tie with response before resolve", () => {
    const tie: SlaItem[] = [{ id: "t1", createdAt: BASE, policyId: "p" }];
    expect(nextBreach(tie, { p: { responseMinutes: 60, resolveMinutes: 60 } })).toStrictEqual({
      itemId: "t1",
      kind: "response",
      dueAt: BASE + HOUR,
      policyId: "p",
    });
  });

  it("attaches remainingMs and status when now is supplied", () => {
    expect(nextBreach(items, policies, BASE + 50 * MIN)).toStrictEqual({
      itemId: "r1",
      kind: "response",
      dueAt: BASE + HOUR,
      policyId: "standard",
      remainingMs: 10 * MIN,
      status: "warning",
    });
  });

  it("ignores unknown policies and returns null when nothing is outstanding", () => {
    expect(nextBreach([{ id: "x", createdAt: BASE, policyId: "ghost" }], policies)).toBeNull();
    expect(nextBreach([], policies)).toBeNull();
  });

  it("does not mutate the items it inspects", () => {
    const snapshot = JSON.stringify(items);
    nextBreach(items, policies, BASE + 10 * MIN);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});
