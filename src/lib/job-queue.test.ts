import { describe, expect, it } from "vitest";
import { BACKOFF_BASE_MS, backoffFor } from "@/lib/offline-queue";
import {
  DEFAULT_MAX_ATTEMPTS,
  claimDue,
  complete,
  fail,
  schedule,
  stats,
  type Job,
  type JobDraft,
} from "@/lib/job-queue";

/** A minimal, valid job draft with sensible defaults; override per test. */
const draft = (over: Partial<JobDraft> & { id: string }): JobDraft => ({
  kind: "email",
  runAt: 100,
  ...over,
});

/** Build a fully-formed job for hand-rolled fixtures. */
const job = (over: Partial<Job> & { id: string }): Job => ({
  kind: "email",
  runAt: 100,
  attempts: 0,
  maxAttempts: 3,
  leaseUntil: null,
  ...over,
});

describe("schedule", () => {
  it("appends a job with defaults for attempts, maxAttempts and leaseUntil", () => {
    const q = schedule([], draft({ id: "a" }));
    expect(q).toEqual([
      {
        id: "a",
        kind: "email",
        runAt: 100,
        attempts: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        leaseUntil: null,
      },
    ]);
  });

  it("honours explicit attempts, maxAttempts and leaseUntil", () => {
    const q = schedule([], draft({ id: "a", attempts: 2, maxAttempts: 7, leaseUntil: 999 }));
    expect(q[0]).toMatchObject({ attempts: 2, maxAttempts: 7, leaseUntil: 999 });
  });

  it("preserves insertion order across repeated schedules", () => {
    const q = schedule(schedule(schedule([], draft({ id: "a" })), draft({ id: "b" })), draft({ id: "c" }));
    expect(q.map((j) => j.id)).toEqual(["a", "b", "c"]);
  });

  it("returns a fresh array without mutating the input", () => {
    const input: Job[] = [];
    const out = schedule(input, draft({ id: "a" }));
    expect(input).toEqual([]);
    expect(out).not.toBe(input);
  });

  it("keeps the scheduled draft immutable", () => {
    const original = draft({ id: "a" });
    schedule([], original);
    expect(original).toEqual({ id: "a", kind: "email", runAt: 100 });
  });
});

describe("claimDue", () => {
  it("claims jobs whose runAt is at or before now, in runAt order", () => {
    const q = [
      job({ id: "late", runAt: 300 }),
      job({ id: "early", runAt: 100 }),
      job({ id: "mid", runAt: 200 }),
    ];
    const { claimed } = claimDue(q, 200, { limit: 10, leaseMs: 50 });
    expect(claimed.map((j) => j.id)).toEqual(["early", "mid"]);
  });

  it("does not claim jobs scheduled in the future", () => {
    const q = [job({ id: "future", runAt: 201 })];
    expect(claimDue(q, 200, { limit: 5, leaseMs: 50 }).claimed).toEqual([]);
  });

  it("treats runAt === now as due (inclusive boundary)", () => {
    const q = [job({ id: "edge", runAt: 200 })];
    expect(claimDue(q, 200, { limit: 5, leaseMs: 50 }).claimed.map((j) => j.id)).toEqual(["edge"]);
  });

  it("stamps a lease that expires leaseMs after now", () => {
    const q = [job({ id: "a", runAt: 100 })];
    const { claimed, queue } = claimDue(q, 1_000, { limit: 5, leaseMs: 250 });
    expect(claimed[0].leaseUntil).toBe(1_250);
    expect(queue[0].leaseUntil).toBe(1_250);
  });

  it("respects the limit and leaves the rest unclaimed", () => {
    const q = [job({ id: "a", runAt: 1 }), job({ id: "b", runAt: 2 }), job({ id: "c", runAt: 3 })];
    const { claimed, queue } = claimDue(q, 100, { limit: 2, leaseMs: 10 });
    expect(claimed.map((j) => j.id)).toEqual(["a", "b"]);
    expect(queue.map((j) => j.leaseUntil)).toEqual([110, 110, null]);
  });

  it("claims nothing for a zero limit", () => {
    const q = [job({ id: "a", runAt: 1 })];
    expect(claimDue(q, 100, { limit: 0, leaseMs: 10 }).claimed).toEqual([]);
  });

  it("treats a non-finite limit as 'everything due'", () => {
    const q = [job({ id: "a", runAt: 1 }), job({ id: "b", runAt: 2 })];
    expect(claimDue(q, 100, { limit: Number.POSITIVE_INFINITY, leaseMs: 10 }).claimed).toHaveLength(2);
  });

  it("keeps insertion order for jobs that share a runAt (stable tie-break)", () => {
    const q = [job({ id: "first", runAt: 50 }), job({ id: "second", runAt: 50 })];
    expect(claimDue(q, 100, { limit: 5, leaseMs: 10 }).claimed.map((j) => j.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("does not re-claim a job whose lease is still active", () => {
    const q = [job({ id: "a", runAt: 100, leaseUntil: 500 })];
    expect(claimDue(q, 400, { limit: 5, leaseMs: 10 }).claimed).toEqual([]);
  });

  it("re-claims a job once its lease has expired", () => {
    const q = [job({ id: "a", runAt: 100, leaseUntil: 400 })];
    expect(claimDue(q, 400, { limit: 5, leaseMs: 10 }).claimed.map((j) => j.id)).toEqual(["a"]);
  });

  it("clamps a negative leaseMs to a lease ending at now", () => {
    const { claimed } = claimDue([job({ id: "a", runAt: 1 })], 1_000, { limit: 5, leaseMs: -50 });
    expect(claimed[0].leaseUntil).toBe(1_000);
  });

  it("returns a fresh queue without mutating the input", () => {
    const q = [job({ id: "a", runAt: 100 })];
    const { queue } = claimDue(q, 200, { limit: 5, leaseMs: 10 });
    expect(q[0].leaseUntil).toBeNull();
    expect(queue).not.toBe(q);
  });

  it("returns claimed copies detached from the queue", () => {
    const { claimed, queue } = claimDue([job({ id: "a", runAt: 100 })], 200, { limit: 5, leaseMs: 10 });
    expect(claimed[0]).not.toBe(queue[0]);
    expect(claimed[0]).toEqual(queue[0]);
  });
});

describe("complete", () => {
  it("removes the acknowledged job and keeps the rest", () => {
    const q = [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })];
    expect(complete(q, "b").map((j) => j.id)).toEqual(["a", "c"]);
  });

  it("is a content no-op for an unknown id", () => {
    const q = [job({ id: "a" })];
    expect(complete(q, "zzz")).toMatchObject([{ id: "a" }]);
  });

  it("returns a fresh array without mutating the input", () => {
    const q = [job({ id: "a" })];
    const out = complete(q, "a");
    expect(q).toHaveLength(1);
    expect(out).not.toBe(q);
  });
});

describe("fail", () => {
  it("increments attempts and reschedules with exponential backoff", () => {
    const q = [job({ id: "a", runAt: 100, maxAttempts: 5 })];
    const out = fail(q, "a", 1_000);
    expect(out[0]).toMatchObject({ attempts: 1, runAt: 1_000 + BACKOFF_BASE_MS, leaseUntil: null });
  });

  it("follows the offline-queue backoff schedule across retries", () => {
    let q = [job({ id: "a", runAt: 0, maxAttempts: 9 })];
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      q = fail(q, "a", 10_000);
      delays.push(q[0].runAt - 10_000);
    }
    expect(delays).toEqual([1, 2, 3, 4].map((n) => backoffFor(n)));
  });

  it("clears an active lease when a job is rescheduled", () => {
    const q = [job({ id: "a", runAt: 0, maxAttempts: 5, leaseUntil: 9_999 })];
    expect(fail(q, "a", 1_000)[0].leaseUntil).toBeNull();
  });

  it("drops the job once attempts reach its own maxAttempts", () => {
    const q = [job({ id: "a", attempts: 1, maxAttempts: 2 })];
    expect(fail(q, "a", 1_000)).toEqual([]);
  });

  it("keeps retrying while below maxAttempts", () => {
    const q = [job({ id: "a", attempts: 0, maxAttempts: 2 })];
    expect(fail(q, "a", 1_000)).toMatchObject([{ attempts: 1 }]);
  });

  it("lets options.maxAttempts override the job's own cap", () => {
    const q = [job({ id: "a", attempts: 0, maxAttempts: 9 })];
    expect(fail(q, "a", 1_000, { maxAttempts: 1 })).toEqual([]);
  });

  it("is a content no-op for an unknown id", () => {
    const q = [job({ id: "a" })];
    expect(fail(q, "missing", 1_000)).toMatchObject([{ id: "a", attempts: 0 }]);
  });

  it("returns a fresh array without mutating the input", () => {
    const q = [job({ id: "a", maxAttempts: 5 })];
    const out = fail(q, "a", 1_000);
    expect(q[0].attempts).toBe(0);
    expect(out).not.toBe(q);
  });
});

describe("stats", () => {
  it("partitions jobs into due, running and pending at now", () => {
    const q = [
      job({ id: "due", runAt: 100 }),
      job({ id: "future", runAt: 9_000 }),
      job({ id: "running", runAt: 100, leaseUntil: 5_000 }),
    ];
    expect(stats(q, 1_000)).toMatchObject({ total: 3, due: 1, pending: 1, running: 1 });
  });

  it("excludes an expired lease from running and counts it due", () => {
    const q = [job({ id: "a", runAt: 100, leaseUntil: 900 })];
    expect(stats(q, 1_000)).toMatchObject({ due: 1, running: 0, pending: 0 });
  });

  it("counts jobs with failed attempts as retrying", () => {
    const q = [job({ id: "a", attempts: 2 }), job({ id: "b", attempts: 0 })];
    expect(stats(q, 1_000).retrying).toBe(1);
  });

  it("tallies jobs by kind", () => {
    const q = [job({ id: "a", kind: "email" }), job({ id: "b", kind: "email" }), job({ id: "c", kind: "webhook" })];
    expect(stats(q, 1_000).byKind).toEqual({ email: 2, webhook: 1 });
  });

  it("returns all-zero stats for an empty queue", () => {
    expect(stats([], 1_000)).toEqual({ total: 0, due: 0, running: 0, pending: 0, retrying: 0, byKind: {} });
  });
});
