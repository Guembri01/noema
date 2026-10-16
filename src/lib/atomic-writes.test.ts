import { describe, expect, it } from "vitest";
import {
  AtomicWriteError,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  PartialWriteError,
  RETRYABLE_TX_CODES,
  assertNoPartialWrite,
  chunkWrites,
  detectPartialWrite,
  isRetryableTxError,
  planAtomicWrites,
  withRetry,
  type RetryAttempt,
  type WriteOp,
  type WriteResult,
} from "@/lib/atomic-writes";

/** A write op with sane defaults so each test states only what it cares about. */
const op = (id: string, extra: Partial<WriteOp> = {}): WriteOp => ({
  id,
  kind: "create",
  model: "Page",
  ...extra,
});

/** Capture whatever `fn` throws, or `undefined` when it does not throw. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const result = (id: string, ok: boolean): WriteResult => ({ id, ok });

describe("isRetryableTxError", () => {
  it("exposes the Prisma and Postgres codes it retries", () => {
    for (const code of ["P2034", "P2002", "P2028", "40001", "40P01"]) {
      expect(RETRYABLE_TX_CODES.has(code)).toBe(true);
    }
    expect(RETRYABLE_TX_CODES.has("P2025")).toBe(false);
  });

  it("retries every Prisma transaction code by code", () => {
    for (const code of ["P2034", "P2002", "P2028"]) {
      expect(isRetryableTxError({ code })).toBe(true);
    }
  });

  it("retries every Postgres serialization / deadlock SQLSTATE by code", () => {
    expect(isRetryableTxError({ code: "40001" })).toBe(true);
    expect(isRetryableTxError({ code: "40P01" })).toBe(true);
  });

  it("accepts a numeric code", () => {
    expect(isRetryableTxError({ code: 40001 })).toBe(true);
  });

  it("reads the code from a nested meta object", () => {
    expect(isRetryableTxError({ meta: { code: "P2034" } })).toBe(true);
  });

  it("follows a wrapped cause", () => {
    expect(isRetryableTxError({ message: "outer", cause: { code: "40P01" } })).toBe(true);
  });

  it("recognises a deadlock by message", () => {
    expect(isRetryableTxError(new Error("deadlock detected"))).toBe(true);
  });

  it("recognises a serialization failure by message", () => {
    expect(isRetryableTxError(new Error("could not serialize access due to concurrent update"))).toBe(true);
    expect(isRetryableTxError(new Error("Transaction failed due to a write conflict or a deadlock"))).toBe(true);
  });

  it("recognises a bare code embedded in a message", () => {
    expect(isRetryableTxError("P2034")).toBe(true);
    expect(isRetryableTxError(new Error("SQLSTATE 40001"))).toBe(true);
  });

  it("passes through a non-retryable Prisma error", () => {
    expect(isRetryableTxError({ code: "P2025", message: "Record to update not found." })).toBe(false);
  });

  it("is total on junk inputs", () => {
    for (const junk of [undefined, null, 0, 42, "", "boom", [], {}, new Error("nope")]) {
      expect(isRetryableTxError(junk)).toBe(false);
    }
  });
});

describe("withRetry", () => {
  it("resolves the first attempt without sleeping", async () => {
    const delays: number[] = [];
    const value = await withRetry(() => Promise.resolve(7), {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(value).toBe(7);
    expect(delays).toEqual([]);
  });

  it("supports a synchronous function", async () => {
    await expect(withRetry(() => 42, { sleep: async () => {} })).resolves.toBe(42);
  });

  it("retries a retryable error then succeeds", async () => {
    let calls = 0;
    const value = await withRetry(
      () => {
        calls += 1;
        if (calls < 2) throw new Error("deadlock detected");
        return "ok";
      },
      { attempts: 3, baseDelayMs: 10, sleep: async () => {} },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(2);
  });

  it("waits base * 2^(n-1) between attempts, deterministically", async () => {
    const delays: number[] = [];
    let calls = 0;
    const value = await withRetry(
      () => {
        calls += 1;
        if (calls < 4) throw new Error("could not serialize access");
        return calls;
      },
      {
        attempts: 4,
        baseDelayMs: 100,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(value).toBe(4);
    expect(delays).toEqual([100, 200, 400]);
  });

  it("rethrows the last error once attempts are exhausted", async () => {
    const boom = new Error("Transaction failed due to a write conflict or a deadlock");
    const delays: number[] = [];
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          throw boom;
        },
        {
          attempts: 3,
          baseDelayMs: 5,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    ).rejects.toBe(boom);
    expect(calls).toBe(3);
    expect(delays).toEqual([5, 10]);
  });

  it("defaults to DEFAULT_RETRY_ATTEMPTS attempts", async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          throw new Error("deadlock detected");
        },
        { baseDelayMs: 0, sleep: async () => {} },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(DEFAULT_RETRY_ATTEMPTS);
    expect(DEFAULT_RETRY_ATTEMPTS).toBe(3);
  });

  it("passes a non-retryable error straight through without sleeping", async () => {
    const boom = new Error("Record to update not found.");
    const delays: number[] = [];
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          throw boom;
        },
        {
          attempts: 4,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    ).rejects.toBe(boom);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("honours a custom isRetryable classifier", async () => {
    const boom = new Error("P2034");
    await expect(
      withRetry(() => Promise.reject(boom), {
        attempts: 3,
        isRetryable: () => false,
        sleep: async () => {
          throw new Error("sleep should never run");
        },
      }),
    ).rejects.toBe(boom);
  });

  it("retries when a custom classifier says yes", async () => {
    let calls = 0;
    const value = await withRetry(
      () => {
        calls += 1;
        if (calls < 2) throw new Error("unrelated");
        return "recovered";
      },
      { attempts: 2, isRetryable: () => true, sleep: async () => {} },
    );
    expect(value).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("clamps a non-positive attempt count to a single attempt", async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          throw new Error("deadlock");
        },
        { attempts: 0, sleep: async () => {} },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("treats a non-finite attempt count as the default", async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          throw new Error("deadlock");
        },
        { attempts: Number.NaN, baseDelayMs: 0, sleep: async () => {} },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(DEFAULT_RETRY_ATTEMPTS);
  });

  it("timestamps each retry from the injected clock", async () => {
    const ticks = [1000, 2000];
    let tick = 0;
    const seen: RetryAttempt[] = [];
    const value = await withRetry(
      () => {
        if (seen.length < 2) throw new Error("deadlock detected");
        return "done";
      },
      {
        attempts: 5,
        baseDelayMs: 10,
        sleep: async () => {},
        now: () => ticks[tick++] ?? 0,
        onRetry: (attempt) => seen.push(attempt),
      },
    );
    expect(value).toBe("done");
    expect(seen.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(seen.map((attempt) => attempt.delayMs)).toEqual([10, 20]);
    expect(seen.map((attempt) => attempt.at)).toEqual([1000, 2000]);
    expect(DEFAULT_RETRY_BASE_DELAY_MS).toBe(50);
  });
});

describe("planAtomicWrites", () => {
  it("plans a single write as one atomic statement", () => {
    const plan = planAtomicWrites([op("page")]);
    expect(plan.atomic).toBe(true);
    expect(plan.statements).toEqual([
      { index: 0, id: "page", kind: "create", model: "Page", dependsOn: [], bestEffort: false },
    ]);
    expect(plan.ids).toEqual(["page"]);
  });

  it("keeps independent writes in input order (stable tie-break)", () => {
    const plan = planAtomicWrites([op("a"), op("b"), op("c")]);
    expect(plan.ids).toEqual(["a", "b", "c"]);
    expect(plan.statements.map((statement) => statement.index)).toEqual([0, 1, 2]);
  });

  it("orders a dependent write after its prerequisite", () => {
    const plan = planAtomicWrites([
      op("block", { kind: "create", model: "Block", dependsOn: ["page"] }),
      op("page", { kind: "create", model: "Page" }),
    ]);
    expect(plan.ids).toEqual(["page", "block"]);
    expect(plan.statements[1].dependsOn).toEqual(["page"]);
  });

  it("orders a chain transitively", () => {
    const plan = planAtomicWrites([
      op("c", { dependsOn: ["b"] }),
      op("a"),
      op("b", { dependsOn: ["a"] }),
    ]);
    expect(plan.ids).toEqual(["a", "b", "c"]);
  });

  it("is deterministic across repeated calls", () => {
    const ops = [op("c", { dependsOn: ["a"] }), op("a"), op("b", { dependsOn: ["a"] })];
    expect(planAtomicWrites(ops)).toEqual(planAtomicWrites(ops));
  });

  it("rejects a duplicate id", () => {
    const error = caught(() => planAtomicWrites([op("a"), op("a")]));
    expect(error).toBeInstanceOf(AtomicWriteError);
    if (!(error instanceof AtomicWriteError)) throw new Error("expected AtomicWriteError");
    expect(error.reason).toBe("duplicate-id");
  });

  it("rejects a dependency on an unknown op", () => {
    const error = caught(() => planAtomicWrites([op("a", { dependsOn: ["ghost"] })]));
    if (!(error instanceof AtomicWriteError)) throw new Error("expected AtomicWriteError");
    expect(error.reason).toBe("unknown-dependency");
  });

  it("rejects a self-dependency", () => {
    const error = caught(() => planAtomicWrites([op("a", { dependsOn: ["a"] })]));
    if (!(error instanceof AtomicWriteError)) throw new Error("expected AtomicWriteError");
    expect(error.reason).toBe("cyclic-dependency");
  });

  it("rejects a dependency cycle", () => {
    const error = caught(() =>
      planAtomicWrites([op("a", { dependsOn: ["b"] }), op("b", { dependsOn: ["a"] })]),
    );
    if (!(error instanceof AtomicWriteError)) throw new Error("expected AtomicWriteError");
    expect(error.reason).toBe("cyclic-dependency");
  });

  it("rejects an op with no id", () => {
    const error = caught(() => planAtomicWrites([{ id: "", kind: "create", model: "Page" }]));
    if (!(error instanceof AtomicWriteError)) throw new Error("expected AtomicWriteError");
    expect(error.reason).toBe("invalid-op");
  });

  it("rejects an op with no model", () => {
    const error = caught(() => planAtomicWrites([{ id: "a", kind: "create", model: "" }]));
    if (!(error instanceof AtomicWriteError)) throw new Error("expected AtomicWriteError");
    expect(error.reason).toBe("invalid-op");
  });

  it("rejects a best-effort write mixed into an atomic transaction", () => {
    const error = caught(() => planAtomicWrites([op("a", { bestEffort: true }), op("b")]));
    if (!(error instanceof AtomicWriteError)) throw new Error("expected AtomicWriteError");
    expect(error.reason).toBe("best-effort-mixed");
  });

  it("allows a lone best-effort write", () => {
    const plan = planAtomicWrites([op("a", { bestEffort: true })]);
    expect(plan.statements[0].bestEffort).toBe(true);
  });

  it("plans the empty batch", () => {
    const plan = planAtomicWrites([]);
    expect(plan.atomic).toBe(true);
    expect(plan.statements).toEqual([]);
    expect(plan.ids).toEqual([]);
  });
});

describe("chunkWrites", () => {
  const ops = [op("a"), op("b"), op("c"), op("d"), op("e")];

  it("splits into equal chunks", () => {
    const chunks = chunkWrites(ops, 2);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.ops.map((write) => write.id))).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
  });

  it("returns one chunk when the size covers everything", () => {
    const chunks = chunkWrites(ops, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].ops).toHaveLength(5);
  });

  it("falls back to one op per chunk for a non-positive or fractional size", () => {
    expect(chunkWrites(ops, 0).map((chunk) => chunk.ops)).toEqual(ops.map((write) => [write]));
    expect(chunkWrites(ops, -3).map((chunk) => chunk.ops)).toEqual(ops.map((write) => [write]));
  });

  it("treats a non-finite size as one chunk", () => {
    expect(chunkWrites(ops, Number.NaN)).toHaveLength(1);
    expect(chunkWrites(ops, Number.POSITIVE_INFINITY)).toHaveLength(1);
  });

  it("plans nothing for an empty batch", () => {
    expect(chunkWrites([], 3)).toEqual([]);
  });

  it("is deterministic and preserves op order", () => {
    expect(chunkWrites(ops, 2)).toEqual(chunkWrites(ops, 2));
    const flat = chunkWrites(ops, 2).flatMap((chunk) => chunk.ops);
    expect(flat).toEqual(ops);
  });
});

describe("assertNoPartialWrite", () => {
  const plan = planAtomicWrites([op("a"), op("b"), op("c")]);

  it("reports a fully committed plan as consistent", () => {
    const report = assertNoPartialWrite(plan, [result("a", true), result("b", true), result("c", true)]);
    expect(report.consistent).toBe(true);
    expect(report.committed).toEqual(["a", "b", "c"]);
    expect(report.failed).toEqual([]);
    expect(report.conflicts).toEqual([]);
  });

  it("reports a wholesale rollback as consistent (nothing committed)", () => {
    const report = detectPartialWrite(plan, [result("a", false), result("b", false), result("c", false)]);
    expect(report.consistent).toBe(true);
    expect(report.committed).toEqual([]);
    expect(report.failed).toEqual(["a", "b", "c"]);
    expect(report.conflicts).toEqual([]);
  });

  it("detects a partial write and lists the committed conflicts", () => {
    const report = detectPartialWrite(plan, [result("a", true), result("b", true), result("c", false)]);
    expect(report.consistent).toBe(false);
    expect(report.committed).toEqual(["a", "b"]);
    expect(report.failed).toEqual(["c"]);
    expect(report.conflicts).toEqual(["a", "b"]);
  });

  it("throws PartialWriteError carrying the report on a partial write", () => {
    const error = caught(() => assertNoPartialWrite(plan, [result("a", true), result("c", false)]));
    expect(error).toBeInstanceOf(PartialWriteError);
    if (!(error instanceof PartialWriteError)) throw new Error("expected PartialWriteError");
    expect(error.report.committed).toEqual(["a"]);
    expect(error.report.missing).toEqual(["b"]);
    expect(error.report.failed).toEqual(["c"]);
    expect(error.report.conflicts).toEqual(["a"]);
  });

  it("counts a missing result as unapplied while keeping the rollback consistent", () => {
    const report = detectPartialWrite(plan, [result("a", false)]);
    expect(report.consistent).toBe(true);
    expect(report.missing).toEqual(["b", "c"]);
  });

  it("ignores results for unknown ops", () => {
    const report = detectPartialWrite(plan, [
      result("a", true),
      result("b", true),
      result("c", true),
      result("ghost", false),
    ]);
    expect(report.consistent).toBe(true);
    expect(report.failed).toEqual([]);
  });

  it("treats the empty plan as consistent", () => {
    expect(detectPartialWrite(planAtomicWrites([]), []).consistent).toBe(true);
  });
});
