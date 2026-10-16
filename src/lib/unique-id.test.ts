import { describe, expect, it } from "vitest";
import {
  allocate,
  allocateIds,
  collisionCheck,
  describeUniqueId,
  formatUniqueId,
  hasUniqueId,
  isValidPrefix,
  nextNumbers,
  nextUniqueId,
  parseUniqueId,
  parseUniqueIdConfig,
  sortBySeq,
  validateUniqueIdConfig,
} from "@/lib/unique-id";
import type { Counter, ParsedUniqueId, UniqueIdConfig, UniqueIdParseError } from "@/lib/unique-id";

/** Assert a parse returned a specific error without losing type narrowing. */
function expectParseError(result: ParsedUniqueId, error: UniqueIdParseError) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBe(error);
}

describe("formatUniqueId", () => {
  it("zero-pads to the default width of 4", () => {
    expect(formatUniqueId({ prefix: "PROJ" }, 1)).toBe("PROJ-0001");
    expect(formatUniqueId({ prefix: "PROJ" }, 42)).toBe("PROJ-0042");
  });

  it("honours custom separator, zeroPad and startAt", () => {
    expect(formatUniqueId({ prefix: "T", zeroPad: 2, separator: "_" }, 7)).toBe("T_07");
    expect(formatUniqueId({ prefix: "AB", zeroPad: 6, separator: "." }, 3)).toBe("AB.000003");
  });

  it("crosses 10000 without truncating", () => {
    expect(formatUniqueId({ prefix: "PROJ" }, 10_000)).toBe("PROJ-10000");
    expect(formatUniqueId({ prefix: "PROJ" }, 123_456)).toBe("PROJ-123456");
  });

  it("rejects numbers that are not positive integers", () => {
    expect(() => formatUniqueId({ prefix: "A" }, 0)).toThrow();
    expect(() => formatUniqueId({ prefix: "A" }, 1.5)).toThrow();
    expect(() => formatUniqueId({ prefix: "A" }, Number.NaN)).toThrow();
  });
});

describe("parseUniqueId", () => {
  it("parses a canonical id", () => {
    const result = parseUniqueId("PROJ-0042", { prefix: "PROJ" });
    expect(result).toEqual({ ok: true, number: 42, prefix: "PROJ", seq: 42 });
  });

  it("round-trips formatUniqueId, including across 10000", () => {
    const config: UniqueIdConfig = { prefix: "PROJ" };
    for (const n of [1, 42, 9999, 10_000]) {
      const parsed = parseUniqueId(formatUniqueId(config, n), config);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.number).toBe(n);
    }
  });

  it("matches the prefix case-insensitively", () => {
    const result = parseUniqueId("proj-0042", { prefix: "PROJ" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.number).toBe(42);
    expect(parseUniqueId("PROJ-0042", { prefix: "proj" }).ok).toBe(true);
  });

  it("rejects a mismatched prefix", () => {
    expectParseError(parseUniqueId("TASK-0042", { prefix: "PROJ" }), "wrong_prefix");
    expectParseError(parseUniqueId("PRO-0042", { prefix: "PROJ" }), "wrong_prefix");
  });

  it("rejects a mismatched separator", () => {
    expectParseError(parseUniqueId("PROJ:0042", { prefix: "PROJ" }), "wrong_separator");
    expectParseError(parseUniqueId("PROJ_0042", { prefix: "PROJ" }), "wrong_separator");
    expectParseError(parseUniqueId("PROJ0042", { prefix: "PROJ" }), "wrong_separator");
    // Custom separator is exact: the default dash no longer matches.
    expectParseError(parseUniqueId("PROJ-0042", { prefix: "PROJ", separator: ":" }), "wrong_separator");
    expect(parseUniqueId("PROJ:0042", { prefix: "PROJ", separator: ":" }).ok).toBe(true);
  });

  it("rejects letters or junk in the numeric part", () => {
    expectParseError(parseUniqueId("PROJ-00A2", { prefix: "PROJ" }), "invalid_number");
    expectParseError(parseUniqueId("PROJ-0042abc", { prefix: "PROJ" }), "invalid_number");
    expectParseError(parseUniqueId("PROJ-0042 ", { prefix: "PROJ" }), "invalid_number");
    expectParseError(parseUniqueId("PROJ-0042-1", { prefix: "PROJ" }), "invalid_number");
  });

  it("enforces the zeroPad minimum and a positive value", () => {
    expectParseError(parseUniqueId("PROJ-42", { prefix: "PROJ" }), "invalid_number");
    expectParseError(parseUniqueId("PROJ-0042", { prefix: "PROJ", zeroPad: 6 }), "invalid_number");
    expectParseError(parseUniqueId("PROJ-0000", { prefix: "PROJ" }), "invalid_number");
    expect(parseUniqueId("PROJ-00042", { prefix: "PROJ" }).ok).toBe(true);
  });

  it("rejects empty input", () => {
    expectParseError(parseUniqueId("", { prefix: "PROJ" }), "empty");
    expectParseError(parseUniqueId("   ", { prefix: "PROJ" }), "empty");
  });
});

describe("nextNumbers", () => {
  it("starts at startAt for an empty list", () => {
    expect(nextNumbers({ prefix: "PROJ" }, [])).toEqual([1]);
    expect(nextNumbers({ prefix: "PROJ", startAt: 10 }, [])).toEqual([10]);
  });

  it("continues after the max, so gaps and deletions don't reuse ids", () => {
    expect(nextNumbers({ prefix: "PROJ" }, ["PROJ-0001", "PROJ-0002", "PROJ-0007"])).toEqual([8]);
    expect(nextNumbers({ prefix: "PROJ" }, ["PROJ-0009", "PROJ-0003"])).toEqual([10]);
  });

  it("ignores unparseable entries without throwing", () => {
    expect(nextNumbers({ prefix: "PROJ" }, ["nonsense", "PROJ-0003", "", "PROJ-99"])).toEqual([4]);
    expect(nextNumbers({ prefix: "PROJ" }, ["", "   "])).toEqual([1]);
  });

  it("returns consecutive numbers for a count", () => {
    expect(nextNumbers({ prefix: "PROJ" }, ["PROJ-0004"], 3)).toEqual([5, 6, 7]);
    expect(nextNumbers({ prefix: "PROJ" }, [], 0)).toEqual([]);
  });

  it("never dips below startAt", () => {
    expect(nextNumbers({ prefix: "PROJ", startAt: 100 }, ["PROJ-0005"])).toEqual([100]);
  });
});

describe("allocateIds", () => {
  it("allocates a unique, monotonic batch", () => {
    const first = allocateIds({ prefix: "PROJ" }, ["PROJ-0001", "PROJ-0002"], 3);
    expect(first).toEqual(["PROJ-0003", "PROJ-0004", "PROJ-0005"]);
    const second = allocateIds({ prefix: "PROJ" }, [...first], 2);
    expect(second).toEqual(["PROJ-0006", "PROJ-0007"]);
    expect(new Set([...first, ...second]).size).toBe(5);
  });
});

describe("hasUniqueId", () => {
  it("compares case-insensitively", () => {
    const existing = ["PROJ-0001", "proj-0002"];
    expect(hasUniqueId(existing, "PROJ-0002")).toBe(true);
    expect(hasUniqueId(existing, "proj-0002")).toBe(true);
    expect(hasUniqueId(existing, "PROJ-0003")).toBe(false);
    expect(hasUniqueId(existing, "")).toBe(false);
  });
});

describe("isValidPrefix", () => {
  it("accepts word-character prefixes", () => {
    expect(isValidPrefix("PROJ")).toBe(true);
    expect(isValidPrefix("p1")).toBe(true);
    expect(isValidPrefix("TEAM_2")).toBe(true);
  });

  it("rejects empty, spaced, separator-bearing or non-string prefixes", () => {
    expect(isValidPrefix("")).toBe(false);
    expect(isValidPrefix("   ")).toBe(false);
    expect(isValidPrefix("PRO J")).toBe(false);
    expect(isValidPrefix("PRO-J")).toBe(false);
    expect(isValidPrefix("PROJ:")).toBe(false);
    expect(isValidPrefix(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R89.25 — the richer Unique ID engine: config parsing, validation, an atomic
// counter allocator, seq-aware sorting and collision guarding. Additive to the
// formatting/parsing helpers above; both call shapes coexist.
// ---------------------------------------------------------------------------

/** A canonical new-style config. */
const TASK: UniqueIdConfig = { prefix: "TASK", padding: 4 };

/** Issue codes from `validateUniqueIdConfig`, in report order. */
const issueCodes = (config: unknown): string[] =>
  validateUniqueIdConfig(config).map((issue) => issue.code);

describe("parseUniqueIdConfig", () => {
  it("fills in ID / padding 4 / startAt 1 for missing input", () => {
    expect(parseUniqueIdConfig(undefined)).toEqual({ prefix: "ID", padding: 4, startAt: 1 });
    expect(parseUniqueIdConfig({})).toEqual({ prefix: "ID", padding: 4, startAt: 1 });
  });

  it("reads the canonical prefix / padding / startAt", () => {
    expect(parseUniqueIdConfig({ prefix: "TASK", padding: 2, startAt: 5 })).toEqual({
      prefix: "TASK",
      padding: 2,
      startAt: 5,
    });
  });

  it("accepts the legacy `zeroPad` key as `padding`", () => {
    expect(parseUniqueIdConfig({ prefix: "T", zeroPad: 6, startAt: 3 })).toEqual({
      prefix: "T",
      padding: 6,
      startAt: 3,
    });
  });

  it("parses JSON strings and unwraps a `uniqueId` block", () => {
    expect(parseUniqueIdConfig('{"prefix":"TASK","padding":3}')).toEqual({
      prefix: "TASK",
      padding: 3,
      startAt: 1,
    });
    expect(parseUniqueIdConfig({ uniqueId: { prefix: "X", padding: 2 } })).toEqual({
      prefix: "X",
      padding: 2,
      startAt: 1,
    });
  });

  it("sanitises out-of-range numbers without throwing", () => {
    expect(parseUniqueIdConfig({ prefix: "T", padding: 20 }).padding).toBe(12);
    expect(parseUniqueIdConfig({ prefix: "T", padding: 0 }).padding).toBe(4);
    expect(parseUniqueIdConfig({ prefix: "T", padding: 2.5 }).padding).toBe(4);
    expect(parseUniqueIdConfig({ prefix: "T", startAt: 0 }).startAt).toBe(1);
    expect(parseUniqueIdConfig({ prefix: "T", startAt: -3 }).startAt).toBe(1);
    expect(parseUniqueIdConfig(42)).toEqual({ prefix: "ID", padding: 4, startAt: 1 });
  });

  it("preserves a legacy separator only when one was authored", () => {
    expect(parseUniqueIdConfig({ prefix: "TASK", separator: "_" })).toEqual({
      prefix: "TASK",
      padding: 4,
      startAt: 1,
      separator: "_",
    });
    expect("separator" in parseUniqueIdConfig({ prefix: "TASK" })).toBe(false);
  });
});

describe("formatUniqueId (seq-first overload)", () => {
  it("formats TASK-0042 with the seq-first argument order", () => {
    expect(formatUniqueId(42, TASK)).toBe("TASK-0042");
    expect(formatUniqueId(1, { prefix: "TASK", padding: 4 })).toBe("TASK-0001");
  });

  it("honours the padding boundaries 1 and 12", () => {
    expect(formatUniqueId(1, { prefix: "T", padding: 1 })).toBe("T-1");
    expect(formatUniqueId(7, { prefix: "T", padding: 12 })).toBe("T-000000000007");
  });

  it("never truncates a number wider than the padding", () => {
    expect(formatUniqueId(10_000, TASK)).toBe("TASK-10000");
    expect(formatUniqueId(123_456, { prefix: "TASK", padding: 1 })).toBe("TASK-123456");
  });

  it("keeps the legacy config-first order working", () => {
    expect(formatUniqueId({ prefix: "PROJ" }, 42)).toBe("PROJ-0042");
  });

  it("rejects a non-positive or non-integer seq", () => {
    expect(() => formatUniqueId(0, TASK)).toThrow();
    expect(() => formatUniqueId(1.5, TASK)).toThrow();
  });
});

describe("validateUniqueIdConfig", () => {
  it("accepts a valid config and an all-defaults config", () => {
    expect(validateUniqueIdConfig({ prefix: "TASK", padding: 4, startAt: 1 })).toEqual([]);
    expect(validateUniqueIdConfig({})).toEqual([]);
  });

  it("flags a prefix outside the charset", () => {
    expect(issueCodes({ prefix: "BAD PREFIX" })).toContain("INVALID_PREFIX");
    expect(issueCodes({ prefix: "TASK-ID" })).toContain("INVALID_PREFIX");
    expect(issueCodes({ prefix: "TASK:1" })).toContain("INVALID_PREFIX");
  });

  it("flags an empty or over-long prefix", () => {
    expect(issueCodes({ prefix: "" })).toContain("INVALID_PREFIX");
    expect(issueCodes({ prefix: "A".repeat(13) })).toContain("INVALID_PREFIX");
    expect(issueCodes({ prefix: "A".repeat(12) })).not.toContain("INVALID_PREFIX");
  });

  it("requires padding in 1..12", () => {
    expect(issueCodes({ padding: 0 })).toContain("PADDING_OUT_OF_RANGE");
    expect(issueCodes({ padding: 13 })).toContain("PADDING_OUT_OF_RANGE");
    expect(issueCodes({ padding: 2.5 })).toContain("PADDING_OUT_OF_RANGE");
    expect(issueCodes({ zeroPad: 0 })).toContain("PADDING_OUT_OF_RANGE");
    expect(issueCodes({ padding: 12 })).not.toContain("PADDING_OUT_OF_RANGE");
  });

  it("requires startAt to be an integer >= 1", () => {
    expect(issueCodes({ startAt: 0 })).toContain("START_AT_OUT_OF_RANGE");
    expect(issueCodes({ startAt: -1 })).toContain("START_AT_OUT_OF_RANGE");
    expect(issueCodes({ startAt: 1.5 })).toContain("START_AT_OUT_OF_RANGE");
    expect(issueCodes({ startAt: 1 })).not.toContain("START_AT_OUT_OF_RANGE");
  });

  it("tolerates malformed input without throwing", () => {
    expect(validateUniqueIdConfig(null)).toEqual([]);
    expect(validateUniqueIdConfig("not json")).toEqual([]);
    expect(validateUniqueIdConfig({ padding: "wide" })).toContainEqual(
      expect.objectContaining({ code: "PADDING_OUT_OF_RANGE" }),
    );
  });
});

describe("nextUniqueId", () => {
  it("advances a fresh counter to the first id", () => {
    const next = nextUniqueId({ databaseId: "db", lastSeq: 0 }, TASK);
    expect(next).toEqual({ counter: { databaseId: "db", lastSeq: 1 }, seq: 1, id: "TASK-0001" });
  });

  it("is immutable — the input counter is untouched", () => {
    const counter: Counter = { databaseId: "db", lastSeq: 5 };
    nextUniqueId(counter, TASK);
    expect(counter).toEqual({ databaseId: "db", lastSeq: 5 });
  });

  it("respects startAt for a counter that has never issued an id", () => {
    const next = nextUniqueId({ databaseId: "db", lastSeq: 0 }, {
      prefix: "T",
      padding: 2,
      startAt: 10,
    });
    expect(next.seq).toBe(10);
    expect(next.id).toBe("T-10");
  });

  it("is monotonic and never reuses a sequence", () => {
    let counter: Counter = { databaseId: "db", lastSeq: 0 };
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const next = nextUniqueId(counter, TASK);
      counter = next.counter;
      ids.push(next.id);
    }
    expect(ids).toEqual(["TASK-0001", "TASK-0002", "TASK-0003"]);
    expect(counter.lastSeq).toBe(3);
  });
});

describe("allocate", () => {
  it("allocates a contiguous block from the counter's high-water mark", () => {
    const result = allocate([{ databaseId: "db", lastSeq: 2 }], "db", 3, TASK);
    expect(result.seqs).toEqual([3, 4, 5]);
    expect(result.ids).toEqual(["TASK-0003", "TASK-0004", "TASK-0005"]);
    expect(result.counter).toEqual({ databaseId: "db", lastSeq: 5 });
  });

  it("keeps every block contiguous", () => {
    const { seqs } = allocate([{ databaseId: "db", lastSeq: 40 }], "db", 4, TASK);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i] - seqs[i - 1]).toBe(1);
  });

  it("is immutable — the input counters are not mutated", () => {
    const counters: Counter[] = [{ databaseId: "db", lastSeq: 2 }];
    const result = allocate(counters, "db", 3, TASK);
    expect(counters).toEqual([{ databaseId: "db", lastSeq: 2 }]);
    expect(result.counters).not.toBe(counters);
  });

  it("is monotonic and never reuses across chained calls", () => {
    const first = allocate([{ databaseId: "db", lastSeq: 0 }], "db", 3, TASK);
    const second = allocate(first.counters, "db", 2, TASK);
    expect(first.seqs).toEqual([1, 2, 3]);
    expect(second.seqs).toEqual([4, 5]);
    expect(new Set([...first.ids, ...second.ids]).size).toBe(5);
  });

  it("creates a counter for an unknown database", () => {
    const result = allocate([], "fresh", 2, TASK);
    expect(result.ids).toEqual(["TASK-0001", "TASK-0002"]);
    expect(result.counter).toEqual({ databaseId: "fresh", lastSeq: 2 });
    expect(result.counters).toHaveLength(1);
  });

  it("allocates nothing for a zero count and leaves the counter untouched", () => {
    const result = allocate([{ databaseId: "db", lastSeq: 9 }], "db", 0, TASK);
    expect(result.ids).toEqual([]);
    expect(result.seqs).toEqual([]);
    expect(result.counter).toEqual({ databaseId: "db", lastSeq: 9 });
  });

  it("interleaved callers that share a base cannot silently reuse ids", () => {
    const base: Counter[] = [{ databaseId: "db", lastSeq: 0 }];
    // Two callers read the SAME base (the classic race). Each produces the same
    // block; the invariant is enforced by chaining the returned counters.
    const a = allocate(base, "db", 2, TASK);
    const b = allocate(base, "db", 2, TASK);
    expect(a.seqs).toEqual([1, 2]);
    expect(b.seqs).toEqual([1, 2]);
    // Chaining the winner's result continues past both blocks — no reuse.
    const c = allocate(a.counters, "db", 2, TASK);
    expect(c.seqs).toEqual([3, 4]);
    expect(new Set([...c.ids, ...a.ids]).size).toBe(4);
  });
});

describe("parseUniqueId (metadata)", () => {
  it("returns the prefix and seq for a round-trip", () => {
    const result = parseUniqueId("TASK-0042", TASK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefix).toBe("TASK");
      expect(result.seq).toBe(42);
    }
  });

  it("round-trips the seq-first formatter, including across 10000", () => {
    for (const n of [1, 42, 9999, 10_000]) {
      const parsed = parseUniqueId(formatUniqueId(n, TASK), TASK);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.seq).toBe(n);
    }
  });

  it("matches a prefix literally, immune to regex metacharacters", () => {
    const config: UniqueIdConfig = { prefix: "A+B" };
    expect(formatUniqueId(7, config)).toBe("A+B-0007");
    const parsed = parseUniqueId("A+B-0007", config);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.seq).toBe(7);
    // `+` must not act as a wildcard.
    expect(parseUniqueId("AAAB-0007", config).ok).toBe(false);
    expect(parseUniqueId("AXB-0007", { prefix: "A.B" }).ok).toBe(false);
  });
});

describe("sortBySeq", () => {
  it("sorts by numeric seq, not the padded string", () => {
    const rows = [
      { id: 1, code: "T-10" },
      { id: 2, code: "T-2" },
      { id: 3, code: "T-9" },
    ];
    const sorted = sortBySeq(rows, { key: "code", config: { prefix: "T", padding: 1 } });
    expect(sorted.map((row) => row.id)).toEqual([2, 3, 1]);
  });

  it("does not mutate the input array", () => {
    const rows = [{ code: "T-2" }, { code: "T-1" }];
    sortBySeq(rows, { key: "code", config: { prefix: "T", padding: 1 } });
    expect(rows.map((row) => row.code)).toEqual(["T-2", "T-1"]);
  });

  it("keeps unparseable rows stable at the end", () => {
    const rows = [{ code: "nope" }, { code: "T-2" }, { code: "T-1" }];
    const sorted = sortBySeq(rows, { key: "code", config: { prefix: "T", padding: 1 } });
    expect(sorted.map((row) => row.code)).toEqual(["T-1", "T-2", "nope"]);
  });

  it("sorts raw numeric keys numerically too", () => {
    const rows = [{ n: 10 }, { n: 2 }, { n: 1 }];
    expect(sortBySeq(rows, { key: "n" }).map((row) => row.n)).toEqual([1, 2, 10]);
  });
});

describe("describeUniqueId", () => {
  it("describes the prefix, padding and start", () => {
    expect(describeUniqueId({ prefix: "TASK", padding: 4, startAt: 1 })).toBe(
      'Unique ID "TASK": 4-digit sequence starting at 1 (e.g. TASK-0001)',
    );
  });

  it("falls back to the engine defaults", () => {
    expect(describeUniqueId({})).toBe(
      'Unique ID "ID": 4-digit sequence starting at 1 (e.g. ID-0001)',
    );
  });
});

describe("collisionCheck", () => {
  it("detects duplicates case-insensitively", () => {
    expect(collisionCheck(["A-1", "A-2", "a-1"])).toEqual({ ok: false, duplicates: ["A-1"] });
  });

  it("reports each collision once, in first-seen order", () => {
    expect(collisionCheck(["A-1", "A-1", "B-2", "b-2", "A-1"]).duplicates).toEqual([
      "A-1",
      "B-2",
    ]);
  });

  it("passes a clean list", () => {
    expect(collisionCheck(["A-1", "A-2"])).toEqual({ ok: true, duplicates: [] });
  });

  it("ignores blanks and non-string values", () => {
    expect(collisionCheck(["", "  ", null, undefined, 42, 42])).toEqual({
      ok: true,
      duplicates: [],
    });
  });

  it("trims before comparing", () => {
    expect(collisionCheck([" A-1 ", "A-1"]).duplicates).toEqual(["A-1"]);
  });
});
