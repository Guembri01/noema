import { describe, expect, it } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffFor,
  coalesce,
  enqueue,
  markDone,
  markFailed,
  nextBatch,
  pendingCount,
  replayOrder,
  type MutationDraft,
  type QueuedMutation,
} from "@/lib/offline-queue";

/** A minimal, valid draft with sensible defaults; override per test. */
const draft = (over: Partial<MutationDraft> & { id: string }): MutationDraft => ({
  kind: "update",
  targetId: "block-1",
  payload: { text: "x" },
  createdAt: 100,
  ...over,
});

/** Build a fully-formed queued mutation for hand-rolled fixtures. */
const raw = (over: Partial<QueuedMutation> & { id: string }): QueuedMutation => ({
  seq: 1,
  kind: "update",
  targetId: "block-1",
  payload: { text: "x" },
  createdAt: 100,
  attempts: 0,
  ...over,
});

describe("enqueue", () => {
  it("assigns a monotonic seq starting at 1", () => {
    const q1 = enqueue([], draft({ id: "a" }));
    const q2 = enqueue(q1, draft({ id: "b" }));
    const q3 = enqueue(q2, draft({ id: "c" }));
    expect([q1, q2, q3].map((q) => q.map((m) => m.seq))).toEqual([[1], [1, 2], [1, 2, 3]]);
    expect(q3.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("appends without mutating the input queue", () => {
    const input: QueuedMutation[] = [];
    const out = enqueue(input, draft({ id: "a" }));
    expect(input).toEqual([]);
    expect(out).not.toBe(input);
    expect(out).toHaveLength(1);
  });

  it("defaults attempts to 0 but honours an explicit value", () => {
    expect([
      enqueue([], draft({ id: "a", payload: {} }))[0].attempts,
      enqueue([], draft({ id: "b", attempts: 3 }))[0].attempts,
    ]).toEqual([0, 3]);
  });

  it("stays monotonic after earlier rows are drained", () => {
    const q = enqueue(enqueue([], draft({ id: "a" })), draft({ id: "b" }));
    const next = enqueue(markDone(q, ["a"]), draft({ id: "c" }));
    expect(next.map((m) => m.seq)).toEqual([2, 3]);
  });
});

describe("replayOrder", () => {
  it("returns seq-ascending order without mutating the input", () => {
    const input = [raw({ id: "c", seq: 3 }), raw({ id: "a", seq: 1 }), raw({ id: "b", seq: 2 })];
    const ordered = replayOrder(input);
    expect(ordered.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(ordered).not.toBe(input);
    expect(input.map((m) => m.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps insertion order for equal seq values (stable)", () => {
    const input = [raw({ id: "first", seq: 7 }), raw({ id: "second", seq: 7 })];
    expect(replayOrder(input).map((m) => m.id)).toEqual(["first", "second"]);
  });
});

describe("coalesce", () => {
  it("merges consecutive same-target same-field writes, keeping the last", () => {
    const q = enqueue(
      enqueue([], draft({ id: "a", payload: { text: "one" }, createdAt: 1 })),
      draft({ id: "b", payload: { text: "two" }, createdAt: 2 }),
    );
    const merged = coalesce(q);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ ...q[1], payload: { text: "two" }, attempts: 0 });
  });

  it("leaves a lone mutation untouched", () => {
    const q = enqueue([], draft({ id: "a" }));
    expect(coalesce(q)).toEqual([q[0]]);
  });

  it("does not merge non-adjacent writes to the same target", () => {
    const q = enqueue(
      enqueue(
        enqueue([], draft({ id: "a", targetId: "X", payload: { text: "1" } })),
        draft({ id: "b", targetId: "Y", payload: { text: "2" } }),
      ),
      draft({ id: "c", targetId: "X", payload: { text: "3" } }),
    );
    expect(coalesce(q)).toHaveLength(3);
  });

  it("does not merge disjoint fields", () => {
    const q = enqueue(
      enqueue([], draft({ id: "a", payload: { text: "1" } })),
      draft({ id: "b", payload: { color: "red" } }),
    );
    expect(coalesce(q)).toHaveLength(2);
  });

  it("merges overlapping fields with last-write-wins while keeping siblings", () => {
    const q = enqueue(
      enqueue([], draft({ id: "a", payload: { text: "a", color: "red" } })),
      draft({ id: "b", payload: { text: "b" } }),
    );
    expect(coalesce(q)[0].payload).toEqual({ text: "b", color: "red" });
  });

  it("does not merge across different kinds", () => {
    const q = enqueue(
      enqueue([], draft({ id: "a", kind: "update", payload: { text: "1" } })),
      draft({ id: "b", kind: "create", payload: { text: "2" } }),
    );
    expect(coalesce(q)).toHaveLength(2);
  });

  it("preserves the highest attempt count when merging", () => {
    const q = enqueue(
      enqueue([], draft({ id: "a", attempts: 2, payload: { text: "1" } })),
      draft({ id: "b", attempts: 1, payload: { text: "2" } }),
    );
    expect(coalesce(q)[0].attempts).toBe(2);
  });
});

describe("nextBatch", () => {
  it("takes the first `max` mutations in seq order", () => {
    const q = enqueue(
      enqueue(enqueue([], draft({ id: "a" })), draft({ id: "b" })),
      draft({ id: "c" }),
    );
    expect(nextBatch(q, { max: 2 }).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("clamps: max 0 yields nothing, oversize max yields everything", () => {
    const q = enqueue(enqueue([], draft({ id: "a" })), draft({ id: "b" }));
    expect(nextBatch(q, { max: 0 })).toEqual([]);
    expect(nextBatch(q, { max: 99 })).toHaveLength(2);
  });

  it("does not mutate the input queue", () => {
    const q = enqueue(enqueue([], draft({ id: "a" })), draft({ id: "b" }));
    nextBatch(q, { max: 1 });
    expect(q).toHaveLength(2);
  });
});

describe("markDone", () => {
  it("removes matching ids and keeps the rest, immutably", () => {
    const q = enqueue(
      enqueue(enqueue([], draft({ id: "a" })), draft({ id: "b" })),
      draft({ id: "c" }),
    );
    const done = markDone(q, ["a", "c"]);
    expect(done.map((m) => m.id)).toEqual(["b"]);
    expect(done).not.toBe(q);
  });

  it("is a no-op content-wise for unknown ids", () => {
    const q = enqueue([], draft({ id: "a" }));
    expect(markDone(q, ["zzz"])).toMatchObject([{ id: "a" }]);
  });
});

describe("markFailed", () => {
  it("increments attempts while below maxAttempts", () => {
    const q = enqueue([], draft({ id: "a" }));
    expect(markFailed(q, "a", { maxAttempts: 3 })).toMatchObject([{ id: "a", attempts: 1 }]);
  });

  it("drops the mutation once it reaches maxAttempts", () => {
    let q = enqueue([], draft({ id: "a" }));
    q = markFailed(q, "a", { maxAttempts: 2 });
    expect(q[0].attempts).toBe(1);
    q = markFailed(q, "a", { maxAttempts: 2 });
    expect(q).toEqual([]);
  });

  it("is safe for an unknown id", () => {
    const q = enqueue([], draft({ id: "a" }));
    expect(markFailed(q, "missing", { maxAttempts: 5 })).toMatchObject([{ id: "a", attempts: 0 }]);
  });
});

describe("backoffFor", () => {
  it("follows the exponential schedule from the first attempt", () => {
    expect([1, 2, 3, 4].map(backoffFor)).toEqual([
      BACKOFF_BASE_MS,
      BACKOFF_BASE_MS * 2,
      BACKOFF_BASE_MS * 4,
      BACKOFF_BASE_MS * 8,
    ]);
  });

  it("caps the delay and floors non-positive attempts to zero", () => {
    expect([backoffFor(50), backoffFor(0), backoffFor(-3)]).toEqual([BACKOFF_CAP_MS, 0, 0]);
  });
});

describe("pendingCount", () => {
  it("counts the mutations left in the queue", () => {
    const q = enqueue(enqueue([], draft({ id: "a" })), draft({ id: "b" }));
    expect([pendingCount([]), pendingCount(q), pendingCount(markDone(q, ["a"]))]).toEqual([0, 2, 1]);
  });
});
