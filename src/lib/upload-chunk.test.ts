import { describe, expect, it } from "vitest";
import {
  CHUNK_SIZE_DEFAULT,
  isComplete,
  planChunks,
  resumeFrom,
  totalParts,
  validateChunkPlan,
  type ChunkPart,
} from "@/lib/upload-chunk";

/**
 * Chunked-upload planning (pure helpers; no network, no DB).
 *
 * `planChunks` splits a byte count into contiguous `[start, end)` parts so a
 * large file can be sent as resumable pieces; the rest of the module answers
 * "how many", "is this plan valid", "what is left" and "are we done".
 */

/** Sum of every part's `size` (used to prove full, gapless coverage). */
const coveredBytes = (plan: readonly ChunkPart[]): number =>
  plan.reduce((sum, part) => sum + part.size, 0);

describe("planChunks", () => {
  it("splits an exact multiple into equal parts", () => {
    expect(planChunks(300, { chunkSize: 100 })).toEqual([
      { index: 0, start: 0, end: 100, size: 100 },
      { index: 1, start: 100, end: 200, size: 100 },
      { index: 2, start: 200, end: 300, size: 100 },
    ]);
  });

  it("gives the final part the remainder and no part overshoots", () => {
    const plan = planChunks(250, { chunkSize: 100 });
    expect(plan).toHaveLength(3);
    expect(plan[2]).toEqual({ index: 2, start: 200, end: 250, size: 50 });
    expect(coveredBytes(plan)).toBe(250);
    expect(plan.every((part) => part.end <= 250)).toBe(true);
  });

  it("returns a single part for a file smaller than one chunk", () => {
    expect(planChunks(10, { chunkSize: 100 })).toEqual([
      { index: 0, start: 0, end: 10, size: 10 },
    ]);
  });

  it("defaults the chunk size to CHUNK_SIZE_DEFAULT", () => {
    expect(Number.isInteger(CHUNK_SIZE_DEFAULT)).toBe(true);
    expect(CHUNK_SIZE_DEFAULT).toBeGreaterThan(0);
    const plan = planChunks(CHUNK_SIZE_DEFAULT + 1);
    expect(plan).toHaveLength(2);
    expect(plan[0]?.size).toBe(CHUNK_SIZE_DEFAULT);
    expect(plan[1]?.size).toBe(1);
  });

  it("plans no parts for an empty file", () => {
    expect(planChunks(0, { chunkSize: 100 })).toEqual([]);
  });

  it("guards negative, fractional and non-finite sizes with an empty plan", () => {
    expect(planChunks(-1, { chunkSize: 100 })).toEqual([]);
    expect(planChunks(1.5, { chunkSize: 100 })).toEqual([]);
    expect(planChunks(Number.NaN, { chunkSize: 100 })).toEqual([]);
    expect(planChunks(Number.POSITIVE_INFINITY, { chunkSize: 100 })).toEqual([]);
  });

  it("falls back to the default chunk size for an invalid one", () => {
    const asSingle = (part: ChunkPart[]): ChunkPart[] => part;
    expect(planChunks(4, { chunkSize: 0 })).toEqual(asSingle(planChunks(4)));
    expect(planChunks(4, { chunkSize: -5 })).toEqual(planChunks(4));
    expect(planChunks(4, { chunkSize: 2.5 })).toEqual(planChunks(4));
    expect(planChunks(4, { chunkSize: Number.NaN })).toEqual(planChunks(4));
  });

  it("produces contiguous, gapless coverage of the whole file", () => {
    const plan = planChunks(1024, { chunkSize: 300 });
    expect(plan.map((part) => part.index)).toEqual([0, 1, 2, 3]);
    expect(plan[0]?.start).toBe(0);
    expect(plan[plan.length - 1]?.end).toBe(1024);
    for (let i = 1; i < plan.length; i += 1) {
      expect(plan[i]?.start).toBe(plan[i - 1]?.end);
    }
    expect(coveredBytes(plan)).toBe(1024);
  });
});

describe("totalParts", () => {
  it("rounds up to whole parts", () => {
    expect(totalParts(300, 100)).toBe(3);
    expect(totalParts(301, 100)).toBe(4);
    expect(totalParts(100, 100)).toBe(1);
    expect(totalParts(99, 100)).toBe(1);
  });

  it("is zero for an empty or invalid file size", () => {
    expect(totalParts(0, 100)).toBe(0);
    expect(totalParts(-1, 100)).toBe(0);
    expect(totalParts(1.2, 100)).toBe(0);
    expect(totalParts(Number.NaN, 100)).toBe(0);
  });

  it("uses the default chunk size and agrees with planChunks", () => {
    expect(totalParts(CHUNK_SIZE_DEFAULT * 2 + 1)).toBe(3);
    expect(totalParts(12345, 1000)).toBe(planChunks(12345, { chunkSize: 1000 }).length);
    expect(totalParts(10, 0)).toBe(1); // invalid chunk size → default
  });
});

describe("validateChunkPlan", () => {
  it("accepts every plan planChunks produces (including the empty plan)", () => {
    expect(validateChunkPlan([])).toBe(true);
    expect(validateChunkPlan(planChunks(10, { chunkSize: 100 }))).toBe(true);
    expect(validateChunkPlan(planChunks(250, { chunkSize: 100 }))).toBe(true);
    expect(validateChunkPlan(planChunks(1024, { chunkSize: 300 }))).toBe(true);
  });

  it("rejects anything that is not an array of parts", () => {
    expect(validateChunkPlan(null)).toBe(false);
    expect(validateChunkPlan(undefined)).toBe(false);
    expect(validateChunkPlan("nope")).toBe(false);
    expect(validateChunkPlan({})).toBe(false);
  });

  it("rejects a part whose index is out of sequence", () => {
    expect(validateChunkPlan([{ index: 1, start: 0, end: 10, size: 10 }])).toBe(false);
  });

  it("rejects a gap or overlap between parts", () => {
    expect(
      validateChunkPlan([
        { index: 0, start: 0, end: 10, size: 10 },
        { index: 1, start: 11, end: 20, size: 9 },
      ]),
    ).toBe(false);
    expect(
      validateChunkPlan([
        { index: 0, start: 0, end: 10, size: 10 },
        { index: 1, start: 5, end: 10, size: 5 },
      ]),
    ).toBe(false);
  });

  it("rejects a size that does not match end - start", () => {
    expect(validateChunkPlan([{ index: 0, start: 0, end: 10, size: 9 }])).toBe(false);
  });

  it("rejects empty, fractional or misaligned parts", () => {
    expect(validateChunkPlan([{ index: 0, start: 0, end: 0, size: 0 }])).toBe(false);
    expect(validateChunkPlan([{ index: 0, start: 0.5, end: 10, size: 9.5 }])).toBe(false);
  });

  it("rejects a bare, non-empty plan that does not start at zero", () => {
    expect(validateChunkPlan([{ index: 0, start: 5, end: 15, size: 10 }])).toBe(false);
  });

  it("rejects a short part that is not the final one", () => {
    expect(
      validateChunkPlan([
        { index: 0, start: 0, end: 10, size: 10 },
        { index: 1, start: 10, end: 15, size: 5 },
        { index: 2, start: 15, end: 20, size: 5 },
      ]),
    ).toBe(false);
  });
});

describe("resumeFrom", () => {
  const plan = planChunks(250, { chunkSize: 100 }); // indexes 0, 1, 2

  it("returns the parts that have not been uploaded, in order", () => {
    expect(resumeFrom(plan, [0]).map((p) => p.index)).toEqual([1, 2]);
    expect(resumeFrom(plan, [1]).map((p) => p.index)).toEqual([0, 2]);
    expect(resumeFrom(plan, [0, 2]).map((p) => p.index)).toEqual([1]);
    expect(resumeFrom(plan, [2, 0, 1])).toEqual([]);
  });

  it("ignores unknown, out-of-range, fractional and non-finite indexes", () => {
    expect(resumeFrom(plan, [99, -1, 1.5, Number.NaN])).toEqual(plan);
    expect(resumeFrom(plan, [])).toEqual(plan);
  });

  it("tolerates a malformed plan or index list without throwing", () => {
    expect(resumeFrom(null as unknown as ChunkPart[], [0])).toEqual([]);
    expect(resumeFrom(plan, null as unknown as number[])).toEqual(plan);
  });

  it("does not mutate or alias the input plan", () => {
    const before = plan.map((p) => p.index);
    const remaining = resumeFrom(plan, [0]);
    expect(plan.map((p) => p.index)).toEqual(before);
    expect(remaining[0]).toBe(plan[1]);
  });
});

describe("isComplete", () => {
  const plan = planChunks(250, { chunkSize: 100 }); // indexes 0, 1, 2

  it("is true only once every part has been received", () => {
    expect(isComplete(plan, [0, 1, 2])).toBe(true);
    expect(isComplete(plan, [2, 0, 1])).toBe(true);
    expect(isComplete(plan, [0, 1])).toBe(false);
    expect(isComplete(plan, [])).toBe(false);
  });

  it("ignores duplicates and junk indexes", () => {
    expect(isComplete(plan, [0, 1, 1, 2])).toBe(true);
    expect(isComplete(plan, [0, 1, 2, 99, -3, 1.5])).toBe(true);
  });

  it("treats an empty plan as already complete", () => {
    expect(isComplete([], [])).toBe(true);
    expect(isComplete([], [5])).toBe(true);
  });

  it("is false for a malformed plan", () => {
    expect(isComplete(null as unknown as ChunkPart[], [0])).toBe(false);
  });
});
