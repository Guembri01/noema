import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ATTEMPTS,
  JobQueue,
  backoffDelay,
  type Job,
} from "./job-queue";

/**
 * In-process background-job runner (docs/FEATURE_MATRIX.md §17, "Background
 * jobs").
 *
 * Red-first: this file was written BEFORE `src/lib/job-queue.ts` existed, so
 * every import resolved to module-not-found and collection failed. It pins a
 * pure, deterministic `JobQueue`: FIFO ordering by `runAt` then insertion,
 * exponential backoff on failure, dead-lettering after `maxAttempts`,
 * idempotent completion and honest stats. The clock is always injected — via
 * the explicit `now` arguments (`claim`, `fail`, `retryDue`) and the
 * `{ now }` provider used by `drainOnce` — so no case reads the wall clock.
 */

describe("backoffDelay", () => {
  it("returns the base delay for the first retry", () => {
    expect(backoffDelay(1, { baseMs: 1000, factor: 2, maxMs: 60_000 })).toBe(1000);
  });

  it("grows geometrically by the factor", () => {
    expect(backoffDelay(3, { baseMs: 1000, factor: 2, maxMs: 60_000 })).toBe(4000);
  });

  it("caps the delay at maxMs", () => {
    expect(backoffDelay(10, { baseMs: 1000, factor: 2, maxMs: 5000 })).toBe(5000);
  });

  it("honours a custom base and factor", () => {
    expect(backoffDelay(2, { baseMs: 500, factor: 3, maxMs: 60_000 })).toBe(1500);
  });

  it("uses documented defaults when options are omitted", () => {
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);
  });

  it("clamps non-positive attempts to the first step", () => {
    expect(backoffDelay(0, { baseMs: 1000 })).toBe(1000);
    expect(backoffDelay(-5, { baseMs: 1000 })).toBe(1000);
  });

  it("falls back to defaults for non-finite tuning", () => {
    expect(
      backoffDelay(1, { baseMs: Number.NaN, factor: Number.NaN, maxMs: Number.NaN }),
    ).toBe(1000);
  });

  it("never exceeds maxMs even when maxMs is below baseMs", () => {
    expect(backoffDelay(1, { baseMs: 1000, maxMs: 250 })).toBe(250);
  });
});

describe("JobQueue.enqueue", () => {
  it("creates a queued job with sensible defaults", () => {
    const job = new JobQueue().enqueue({ kind: "import", payload: { pageId: "p1" } });
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(job.runAt).toBe(0);
    expect(job.claimedAt).toBeNull();
    expect(job.completedAt).toBeNull();
    expect(job.lastError).toBeNull();
    expect(job.payload).toEqual({ pageId: "p1" });
  });

  it("assigns unique, insertion-ordered ids", () => {
    const queue = new JobQueue();
    const first = queue.enqueue({ kind: "a" });
    const second = queue.enqueue({ kind: "b" });
    expect(first.id).not.toBe(second.id);
    expect(first.seq).toBeLessThan(second.seq);
  });

  it("honours a custom maxAttempts", () => {
    expect(new JobQueue().enqueue({ kind: "a", maxAttempts: 5 }).maxAttempts).toBe(5);
  });

  it("accepts a number or a Date for runAt", () => {
    const queue = new JobQueue();
    expect(queue.enqueue({ kind: "a", runAt: 1234 }).runAt).toBe(1234);
    expect(queue.enqueue({ kind: "b", runAt: new Date(5000) }).runAt).toBe(5000);
  });

  it("defaults to immediately eligible (runAt 0)", () => {
    const queue = new JobQueue();
    const job = queue.enqueue({ kind: "a" });
    expect(queue.claim(0, { limit: 1 })).toHaveLength(1);
    expect(queue.get(job.id)?.status).toBe("running");
  });

  it("rejects an empty kind", () => {
    expect(() => new JobQueue().enqueue({ kind: "   " })).toThrow(TypeError);
  });

  it("defaults an omitted payload to an empty object", () => {
    expect(new JobQueue().enqueue({ kind: "a" }).payload).toEqual({});
  });
});

describe("JobQueue.claim", () => {
  it("claims due jobs in FIFO order and marks them running", () => {
    const queue = new JobQueue();
    queue.enqueue({ kind: "a" });
    queue.enqueue({ kind: "b" });
    const claimed = queue.claim(10, { limit: 2 });
    expect(claimed.map((job) => job.kind)).toEqual(["a", "b"]);
    expect(claimed.every((job) => job.status === "running")).toBe(true);
    expect(claimed.every((job) => job.claimedAt === 10)).toBe(true);
  });

  it("increments attempts on each claim", () => {
    const queue = new JobQueue();
    const job = queue.enqueue({ kind: "a", maxAttempts: 3 });
    expect(queue.claim(0, { limit: 1 })[0]!.attempts).toBe(1);
    queue.fail(job.id, "boom", 0);
    expect(queue.claim(1000, { limit: 1 })[0]!.attempts).toBe(2);
  });

  it("respects the limit across successive claims", () => {
    const queue = new JobQueue();
    queue.enqueue({ kind: "a" });
    queue.enqueue({ kind: "b" });
    queue.enqueue({ kind: "c" });
    expect(queue.claim(0, { limit: 2 })).toHaveLength(2);
    expect(queue.claim(0, { limit: 2 })).toHaveLength(1);
  });

  it("skips jobs whose runAt is in the future", () => {
    const queue = new JobQueue();
    queue.enqueue({ kind: "later", runAt: 5000 });
    expect(queue.claim(4999, { limit: 5 })).toEqual([]);
    expect(queue.claim(5000, { limit: 5 })).toHaveLength(1);
  });

  it("orders by runAt first, then insertion", () => {
    const queue = new JobQueue();
    queue.enqueue({ kind: "c", runAt: 200 });
    queue.enqueue({ kind: "a", runAt: 100 });
    queue.enqueue({ kind: "b", runAt: 200 });
    expect(queue.claim(1000, { limit: 5 }).map((job) => job.kind)).toEqual(["a", "c", "b"]);
  });

  it("breaks runAt ties by insertion order", () => {
    const queue = new JobQueue();
    const first = queue.enqueue({ kind: "first", runAt: 100 });
    const second = queue.enqueue({ kind: "second", runAt: 100 });
    expect(queue.claim(100, { limit: 5 }).map((job) => job.id)).toEqual([first.id, second.id]);
  });

  it("will not re-claim a running or completed job", () => {
    const queue = new JobQueue();
    const job = queue.enqueue({ kind: "a" });
    queue.claim(0, { limit: 1 });
    expect(queue.claim(0, { limit: 1 })).toEqual([]);
    queue.complete(job.id, 0);
    expect(queue.claim(0, { limit: 1 })).toEqual([]);
  });

  it("returns an empty array for a non-positive limit", () => {
    const queue = new JobQueue();
    queue.enqueue({ kind: "a" });
    expect(queue.claim(0, { limit: 0 })).toEqual([]);
  });
});

describe("JobQueue.fail and backoff", () => {
  it("requeues a failed job after the first backoff delay", () => {
    const queue = new JobQueue({ backoff: { baseMs: 1000, factor: 2, maxMs: 60_000 } });
    const job = queue.enqueue({ kind: "a", maxAttempts: 5 });
    queue.claim(0, { limit: 1 });
    const failed = queue.fail(job.id, "boom", 0);
    expect(failed?.status).toBe("queued");
    expect(failed?.runAt).toBe(1000);
    expect(failed?.lastError).toBe("boom");
  });

  it("uses a growing delay on successive failures", () => {
    const queue = new JobQueue({ backoff: { baseMs: 1000, factor: 2, maxMs: 60_000 } });
    const job = queue.enqueue({ kind: "a", maxAttempts: 5 });
    queue.claim(0, { limit: 1 });
    queue.fail(job.id, "one", 0);
    queue.claim(1000, { limit: 1 });
    const failed = queue.fail(job.id, "two", 1000);
    expect(failed?.runAt).toBe(3000); // 1000 + backoffDelay(2) === 3000
  });

  it("dead-letters a job once maxAttempts are exhausted", () => {
    const queue = new JobQueue({ backoff: { baseMs: 1000, factor: 2, maxMs: 60_000 } });
    const job = queue.enqueue({ kind: "a", maxAttempts: 2 });
    queue.claim(0, { limit: 1 });
    expect(queue.fail(job.id, "first", 0)?.status).toBe("queued");
    queue.claim(1000, { limit: 1 });
    const dead = queue.fail(job.id, "second", 1000);
    expect(dead?.status).toBe("dead");
    expect(dead?.lastError).toBe("second");
  });

  it("stringifies a non-Error rejection", () => {
    const queue = new JobQueue();
    const job = queue.enqueue({ kind: "a", maxAttempts: 3 });
    queue.claim(0, { limit: 1 });
    expect(queue.fail(job.id, { code: 42 }, 0)?.lastError).toBe("[object Object]");
  });

  it("prefers the message of an Error", () => {
    const queue = new JobQueue();
    const job = queue.enqueue({ kind: "a", maxAttempts: 3 });
    queue.claim(0, { limit: 1 });
    expect(queue.fail(job.id, new Error("kaboom"), 0)?.lastError).toBe("kaboom");
  });

  it("returns null when failing an unknown job", () => {
    expect(new JobQueue().fail("nope", "boom", 0)).toBeNull();
  });

  it("does not resurrect a completed job", () => {
    const queue = new JobQueue();
    const job = queue.enqueue({ kind: "a", maxAttempts: 3 });
    queue.claim(0, { limit: 1 });
    queue.complete(job.id, 0);
    expect(queue.fail(job.id, "late", 10)?.status).toBe("done");
  });

  it("makes a retried job claimable exactly at its runAt", () => {
    const queue = new JobQueue({ backoff: { baseMs: 1000, factor: 2, maxMs: 60_000 } });
    const job = queue.enqueue({ kind: "a", maxAttempts: 5 });
    queue.claim(0, { limit: 1 });
    queue.fail(job.id, "boom", 0);
    expect(queue.claim(999, { limit: 1 })).toEqual([]);
    expect(queue.claim(1000, { limit: 1 })).toHaveLength(1);
  });
});

describe("JobQueue.complete", () => {
  it("marks a job done and stamps completedAt", () => {
    const queue = new JobQueue();
    const job = queue.enqueue({ kind: "a" });
    queue.claim(0, { limit: 1 });
    const done = queue.complete(job.id, 50);
    expect(done?.status).toBe("done");
    expect(done?.completedAt).toBe(50);
  });

  it("is idempotent — a second completion changes nothing", () => {
    const queue = new JobQueue();
    const job = queue.enqueue({ kind: "a" });
    queue.complete(job.id, 50);
    const again = queue.complete(job.id, 9999);
    expect(again?.status).toBe("done");
    expect(again?.completedAt).toBe(50);
    expect(queue.stats().done).toBe(1);
  });

  it("returns null for an unknown job", () => {
    expect(new JobQueue().complete("nope")).toBeNull();
  });

  it("cannot claim a completed job again", () => {
    const queue = new JobQueue();
    const job = queue.enqueue({ kind: "a" });
    queue.claim(0, { limit: 1 });
    queue.complete(job.id, 0);
    expect(queue.claim(0, { limit: 1 })).toEqual([]);
  });

  it("completes a job that was never claimed", () => {
    const queue = new JobQueue();
    const job = queue.enqueue({ kind: "a" });
    expect(queue.complete(job.id, 1)?.status).toBe("done");
  });
});

describe("JobQueue.retryDue", () => {
  it("lists queued jobs that are due, in order", () => {
    const queue = new JobQueue();
    queue.enqueue({ kind: "b", runAt: 200 });
    queue.enqueue({ kind: "a", runAt: 100 });
    expect(queue.retryDue(200).map((job) => job.kind)).toEqual(["a", "b"]);
    expect(queue.retryDue(99)).toEqual([]);
  });

  it("excludes running, done and dead jobs", () => {
    const queue = new JobQueue();
    queue.enqueue({ kind: "running" });
    const done = queue.enqueue({ kind: "done" });
    const dead = queue.enqueue({ kind: "dead", maxAttempts: 1 });
    const pending = queue.enqueue({ kind: "pending", runAt: 50 });
    queue.claim(0, { limit: 3 });
    queue.complete(done.id, 0);
    queue.fail(dead.id, "boom", 0);
    expect(queue.retryDue(10_000).map((job) => job.id)).toEqual([pending.id]);
  });

  it("matches what claim would take, without mutating", () => {
    const queue = new JobQueue();
    queue.enqueue({ kind: "a" });
    queue.enqueue({ kind: "b", runAt: 100 });
    const due = queue.retryDue(100).map((job) => job.id);
    expect(queue.stats().running).toBe(0);
    expect(queue.claim(100, { limit: 5 }).map((job) => job.id)).toEqual(due);
  });
});

describe("JobQueue.stats", () => {
  it("reports all zeros for an empty queue", () => {
    expect(new JobQueue().stats()).toEqual({ total: 0, queued: 0, running: 0, done: 0, dead: 0 });
  });

  it("counts jobs by status", () => {
    const queue = new JobQueue();
    queue.enqueue({ kind: "q1" });
    queue.enqueue({ kind: "q2" });
    const done = queue.enqueue({ kind: "d" });
    const dead = queue.enqueue({ kind: "x", maxAttempts: 1 });
    queue.claim(0, { limit: 4 });
    queue.complete(done.id, 0);
    queue.fail(dead.id, "boom", 0);
    expect(queue.stats()).toEqual({ total: 4, queued: 0, running: 2, done: 1, dead: 1 });
  });

  it("reflects a requeue after a retryable failure", () => {
    const queue = new JobQueue();
    const job = queue.enqueue({ kind: "a", maxAttempts: 3 });
    queue.claim(0, { limit: 1 });
    queue.fail(job.id, "boom", 0);
    expect(queue.stats()).toEqual({ total: 1, queued: 1, running: 0, done: 0, dead: 0 });
  });

  it("keeps total equal to the sum of the buckets", () => {
    const queue = new JobQueue();
    for (let i = 0; i < 5; i += 1) queue.enqueue({ kind: `k${i}` });
    const stats = queue.stats();
    expect(stats.total).toBe(stats.queued + stats.running + stats.done + stats.dead);
  });
});

describe("JobQueue.drainOnce", () => {
  const NOW = 1000;

  it("runs the handler and completes each claimed job", async () => {
    const queue = new JobQueue({ now: () => NOW });
    queue.enqueue({ kind: "a" });
    queue.enqueue({ kind: "b" });
    const seen: string[] = [];
    const result = await queue.drainOnce((job) => {
      seen.push(job.kind);
    });
    expect(seen).toEqual(["a", "b"]);
    expect(result).toEqual({ claimed: 2, completed: 2, retried: 0, dead: 0 });
    expect(queue.stats()).toEqual({ total: 2, queued: 0, running: 0, done: 2, dead: 0 });
  });

  it("retries a job whose handler throws", async () => {
    const queue = new JobQueue({ now: () => NOW, backoff: { baseMs: 1000 } });
    queue.enqueue({ kind: "a", maxAttempts: 3 });
    const result = await queue.drainOnce(() => {
      throw new Error("boom");
    });
    expect(result).toEqual({ claimed: 1, completed: 0, retried: 1, dead: 0 });
    expect(queue.stats().queued).toBe(1);
  });

  it("dead-letters a job that throws on its final attempt", async () => {
    const queue = new JobQueue({ now: () => NOW });
    queue.enqueue({ kind: "a", maxAttempts: 1 });
    const result = await queue.drainOnce(() => {
      throw new Error("fatal");
    });
    expect(result).toEqual({ claimed: 1, completed: 0, retried: 0, dead: 1 });
    expect(queue.stats().dead).toBe(1);
  });

  it("honours the drain limit", async () => {
    const queue = new JobQueue({ now: () => NOW });
    queue.enqueue({ kind: "a" });
    queue.enqueue({ kind: "b" });
    queue.enqueue({ kind: "c" });
    const result = await queue.drainOnce(() => undefined, { limit: 2 });
    expect(result.claimed).toBe(2);
    expect(queue.stats().queued).toBe(1);
  });

  it("hands the handler the claimed job snapshot", async () => {
    const queue = new JobQueue({ now: () => NOW });
    queue.enqueue({ kind: "import", payload: { pageId: "p1" }, maxAttempts: 4 });
    const received: Job[] = [];
    await queue.drainOnce((job) => {
      received.push(job);
    });
    expect(received[0]?.kind).toBe("import");
    expect(received[0]?.payload).toEqual({ pageId: "p1" });
    expect(received[0]?.attempts).toBe(1);
    expect(received[0]?.status).toBe("running");
  });

  it("supports an explicit now override for determinism", async () => {
    const queue = new JobQueue({ now: () => 0 });
    queue.enqueue({ kind: "a", runAt: 5000 });
    expect((await queue.drainOnce(() => undefined, { now: 4999 })).claimed).toBe(0);
    expect((await queue.drainOnce(() => undefined, { now: 5000 })).claimed).toBe(1);
  });
});
