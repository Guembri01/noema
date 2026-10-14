import { describe, expect, it } from "vitest";
import {
  applyDiff,
  commonPrefix,
  commonSuffix,
  diffStats,
  diffText,
  hasChanges,
  type DiffSegment,
} from "./text-diff";

/**
 * Character-level text diff (F7) — pure, red-first.
 *
 * `src/lib/text-diff.ts` did not exist when this file was first written
 * (module-not-found -> suite red; docs/LOOP_PLAYBOOK "red-first"). Unlike the
 * block-id diff in `version-history.ts`, this works on raw strings, so it can
 * power inline "what changed in this block" previews.
 *
 * Contract pinned here:
 *  - code-unit safe: a segment never ends up holding half of a surrogate
 *    pair, so an emoji is an indivisible unit;
 *  - `applyDiff(a, diffText(a, b)) === b` for every input;
 *  - canonical shape: adjacent same-op segments are merged and empty segments
 *    are dropped;
 *  - `diffStats` counts Unicode code points (an emoji is one char);
 *  - input is never mutated.
 */

/** True when `text` contains a high or low surrogate with no valid partner. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertCanonical(diff: readonly DiffSegment[]): void {
  diff.forEach((segment, index) => {
    expect(segment.text.length).toBeGreaterThan(0);
    expect(hasLoneSurrogate(segment.text)).toBe(false);
    if (index > 0) expect(segment.op).not.toBe(diff[index - 1].op);
  });
}

/** Deterministic PRNG so the fuzz cases are reproducible across runs. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe("commonPrefix / commonSuffix", () => {
  it("counts the shared leading code units", () => {
    expect(commonPrefix("hello", "hello")).toBe(5);
    expect(commonPrefix("hello", "help")).toBe(3);
    expect(commonPrefix("abc", "abd")).toBe(2);
  });

  it("treats empty input as zero overlap", () => {
    expect(commonPrefix("", "abc")).toBe(0);
    expect(commonPrefix("abc", "")).toBe(0);
    expect(commonPrefix("", "")).toBe(0);
  });

  it("counts the shared trailing code units", () => {
    expect(commonSuffix("hello", "hello")).toBe(5);
    expect(commonSuffix("walking", "running")).toBe(3); // "ing"
    expect(commonSuffix("abc", "xyz")).toBe(0);
    expect(commonSuffix("abc", "")).toBe(0);
  });

  it("keeps a shared suffix from overlapping a reserved prefix", () => {
    // "abc" vs "abc" with two leading chars reserved leaves one trailing unit.
    expect(commonSuffix("abc", "abc", 2)).toBe(1);
    expect(commonSuffix("abc", "abc", 3)).toBe(0);
  });
});

describe("unicode safety (surrogate pairs)", () => {
  const grin = "\u{1F600}"; // D83D DE00
  const beam = "\u{1F601}"; // D83D DE01

  it("advances a shared prefix over a whole astral character", () => {
    expect(commonPrefix(`${grin}x`, `${grin}y`)).toBe(2);
    expect(commonSuffix(`x${grin}`, `y${grin}`)).toBe(2);
  });

  it("never returns a boundary that splits a surrogate pair", () => {
    expect(commonPrefix(grin, beam)).toBe(0);
    expect(commonSuffix(grin, beam)).toBe(0);
  });

  it("emits whole code points when an emoji changes", () => {
    const diff = diffText(grin, beam);
    expect(diff).toEqual([
      { op: "delete", text: grin },
      { op: "insert", text: beam },
    ]);
    assertCanonical(diff);
    expect(hasLoneSurrogate(diff.map((segment) => segment.text).join(""))).toBe(false);
  });
});

describe("diffText", () => {
  it("returns a single equal segment for identical text", () => {
    expect(diffText("abc", "abc")).toEqual([{ op: "equal", text: "abc" }]);
  });

  it("returns no segments for two empty strings", () => {
    expect(diffText("", "")).toEqual([]);
  });

  it("reports a pure insertion", () => {
    expect(diffText("ac", "abc")).toEqual([
      { op: "equal", text: "a" },
      { op: "insert", text: "b" },
      { op: "equal", text: "c" },
    ]);
  });

  it("reports a pure deletion", () => {
    expect(diffText("abc", "ac")).toEqual([
      { op: "equal", text: "a" },
      { op: "delete", text: "b" },
      { op: "equal", text: "c" },
    ]);
  });

  it("reports a full replacement", () => {
    expect(diffText("abc", "xyz")).toEqual([
      { op: "delete", text: "abc" },
      { op: "insert", text: "xyz" },
    ]);
  });

  it("handles an empty side", () => {
    expect(diffText("", "abc")).toEqual([{ op: "insert", text: "abc" }]);
    expect(diffText("abc", "")).toEqual([{ op: "delete", text: "abc" }]);
  });

  it("merges adjacent edits into one segment each", () => {
    const diff = diffText("abc", "aXYc");
    expect(diff).toEqual([
      { op: "equal", text: "a" },
      { op: "delete", text: "b" },
      { op: "insert", text: "XY" },
      { op: "equal", text: "c" },
    ]);
    assertCanonical(diff);
  });

  it("is deterministic for the same inputs", () => {
    expect(diffText("kitten", "sitting")).toEqual(diffText("kitten", "sitting"));
  });
});

describe("applyDiff", () => {
  it("reconstructs the target from explicit cases", () => {
    expect(applyDiff("abc", diffText("abc", "abc"))).toBe("abc");
    expect(applyDiff("ac", diffText("ac", "abc"))).toBe("abc");
    expect(applyDiff("abc", diffText("abc", "ac"))).toBe("ac");
    expect(applyDiff("abc", diffText("abc", "xyz"))).toBe("xyz");
    expect(applyDiff("", diffText("", "abc"))).toBe("abc");
    expect(applyDiff("abc", diffText("abc", ""))).toBe("");
  });

  it("round-trips every generated pair, unicode included", () => {
    const random = mulberry32(0xf7d1ff);
    const alphabet = ["a", "b", "c", " ", "\n", "\u00e9", "\u{1F600}", "\u597d", "z"];
    const pick = () => alphabet[Math.floor(random() * alphabet.length)];
    const makeText = () => {
      const length = Math.floor(random() * 14);
      let text = "";
      for (let index = 0; index < length; index += 1) text += pick();
      return text;
    };

    for (let iteration = 0; iteration < 120; iteration += 1) {
      const a = makeText();
      const b = makeText();
      const diff = diffText(a, b);
      expect(applyDiff(a, diff)).toBe(b);
      assertCanonical(diff);
      expect(hasChanges(diff)).toBe(a !== b);
    }
  });

  it("does not mutate its inputs", () => {
    const a = "source";
    const b = "sauce";
    const diff = diffText(a, b);
    applyDiff(a, diff);
    expect(a).toBe("source");
    expect(b).toBe("sauce");
  });
});

describe("diffStats / hasChanges", () => {
  it("counts inserted, removed and unchanged code points", () => {
    expect(diffStats(diffText("ac", "abc"))).toEqual({ added: 1, removed: 0, unchanged: 2 });
    expect(diffStats(diffText("abc", "ac"))).toEqual({ added: 0, removed: 1, unchanged: 2 });
    expect(diffStats(diffText("abc", "xyz"))).toEqual({ added: 3, removed: 3, unchanged: 0 });
  });

  it("counts an astral character as one", () => {
    expect(diffStats([{ op: "insert", text: "\u{1F600}" }])).toEqual({
      added: 1,
      removed: 0,
      unchanged: 0,
    });
  });

  it("flags whether a diff changes anything", () => {
    expect(hasChanges(diffText("same", "same"))).toBe(false);
    expect(hasChanges(diffText("", ""))).toBe(false);
    expect(hasChanges([])).toBe(false);
    expect(hasChanges(diffText("a", "b"))).toBe(true);
    expect(hasChanges(diffText("", "a"))).toBe(true);
  });
});
