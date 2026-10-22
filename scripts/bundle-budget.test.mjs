import { describe, expect, it } from "vitest";
import { evaluateBudget, summarizeChunks } from "./bundle-budget.mjs";

describe("bundle budget", () => {
  it("dedupes chunk files and sums raw + gzip bytes", () => {
    const summary = summarizeChunks([
      { file: "a.js", raw: 100, gzip: 40 },
      { file: "a.js", raw: 100, gzip: 40 },
      { file: "b.js", raw: 60, gzip: 25 },
    ]);

    expect(summary).toEqual({ files: 2, raw: 160, gzip: 65 });
  });

  it("reports the exact overage and treats equality as passing", () => {
    expect(evaluateBudget(930_001, 930_000)).toEqual({ ok: false, overBy: 1 });
    expect(evaluateBudget(930_000, 930_000)).toEqual({ ok: true, overBy: 0 });
    expect(evaluateBudget(929_999, 930_000)).toEqual({ ok: true, overBy: 0 });
  });
});
