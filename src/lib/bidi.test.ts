import { describe, expect, it } from "vitest";
import {
  BIDI_CONTROL_CHARS,
  applyDirAttr,
  contentDirProps,
  describeDirection,
  detectDirection,
  inlineBidiProps,
  isBidiControl,
  isMixed,
  mirrorChar,
  normalizeMarks,
  resolveDir,
  splitBidiRuns,
  toLogical,
  toVisual,
} from "@/lib/bidi";

/* Every RTL string is written with \u escapes so the file stays ASCII and a
   bad copy/paste cannot silently swap a Hebrew letter for a Latin lookalike. */

const HEBREW = "\u05D0\u05D1\u05D2"; // אבג
const ARABIC = "\u0645\u0631\u062D\u0628\u0627"; // مرحبا
const RLM = "\u200F";
const LRM = "\u200E";
const ALM = "\u061C";
const LRE = "\u202A";
const PDF = "\u202C";
const RLI = "\u2067";
const PDI = "\u2069";
const ARABIC_INDIC = "\u0661\u0662\u0663"; // ١٢٣

describe("detectDirection", () => {
  it("reports ltr for Latin script", () => {
    expect(detectDirection("Hello, world")).toBe("ltr");
    expect(detectDirection("caf\u00E9")).toBe("ltr");
  });

  it("reports rtl for Hebrew and Arabic", () => {
    expect(detectDirection(HEBREW)).toBe("rtl");
    expect(detectDirection(ARABIC)).toBe("rtl");
  });

  it("uses the first strong character in mixed text", () => {
    expect(detectDirection(`${ARABIC} hello`)).toBe("rtl");
    expect(detectDirection(`hello ${ARABIC}`)).toBe("ltr");
  });

  it("skips weak numbers and neutrals to find the first strong character", () => {
    expect(detectDirection(`123 ${ARABIC}`)).toBe("rtl");
    expect(detectDirection("123 hello")).toBe("ltr");
  });

  it("falls back to auto when nothing strong is present", () => {
    expect(detectDirection("")).toBe("auto");
    expect(detectDirection("   ")).toBe("auto");
    expect(detectDirection("123 456")).toBe("auto");
    expect(detectDirection("!!! 42")).toBe("auto");
    expect(detectDirection("\u{1F600}")).toBe("auto");
  });

  it("ignores bidi control characters", () => {
    expect(detectDirection(`${RLM}hello`)).toBe("ltr");
    expect(detectDirection(`${LRM}${ALM}${HEBREW}`)).toBe("rtl");
  });
});

describe("resolveDir", () => {
  it("lets an explicit text direction override the block direction", () => {
    expect(resolveDir("rtl", "ltr")).toBe("ltr");
    expect(resolveDir("ltr", "rtl")).toBe("rtl");
  });

  it("falls back to the block direction when the text is auto", () => {
    expect(resolveDir("rtl", "auto")).toBe("rtl");
    expect(resolveDir("ltr", "auto")).toBe("ltr");
  });

  it("uses the default when neither direction is known", () => {
    expect(resolveDir("auto", "auto")).toBe("ltr");
    expect(resolveDir("auto", "auto", "rtl")).toBe("rtl");
  });
});

describe("splitBidiRuns", () => {
  it("returns one run for uniform text", () => {
    expect(splitBidiRuns("hello")).toEqual([
      { text: "hello", dir: "ltr", level: 0 },
    ]);
    expect(splitBidiRuns(HEBREW)).toEqual([
      { text: HEBREW, dir: "rtl", level: 1 },
    ]);
  });

  it("splits an ltr paragraph around an embedded rtl word", () => {
    expect(splitBidiRuns("abc \u05D0\u05D1\u05D2 def")).toEqual([
      { text: "abc ", dir: "ltr", level: 0 },
      { text: "\u05D0\u05D1\u05D2", dir: "rtl", level: 1 },
      { text: " def", dir: "ltr", level: 0 },
    ]);
  });

  it("splits an rtl paragraph around an embedded latin word", () => {
    expect(splitBidiRuns("\u05D0\u05D1\u05D2 abc")).toEqual([
      { text: "\u05D0\u05D1\u05D2 ", dir: "rtl", level: 1 },
      { text: "abc", dir: "ltr", level: 2 },
    ]);
  });

  it("assigns european numbers the paragraph base level", () => {
    expect(splitBidiRuns("abc 123 \u05D0\u05D1\u05D2")).toEqual([
      { text: "abc 123 ", dir: "ltr", level: 0 },
      { text: "\u05D0\u05D1\u05D2", dir: "rtl", level: 1 },
    ]);
    // In an rtl context the digits ride along in the rtl run.
    expect(splitBidiRuns("\u05D0\u05D1\u05D2 123")).toEqual([
      { text: "\u05D0\u05D1\u05D2 123", dir: "rtl", level: 1 },
    ]);
  });

  it("treats arabic-indic digits as rtl", () => {
    expect(splitBidiRuns(`abc ${ARABIC_INDIC}`)).toEqual([
      { text: "abc ", dir: "ltr", level: 0 },
      { text: ARABIC_INDIC, dir: "rtl", level: 1 },
    ]);
  });

  it("joins neutrals that sit between equal levels and falls back between unequal ones", () => {
    // hyphen between two ltr runs is invisible; between ltr and rtl it takes the base.
    expect(splitBidiRuns("abc-123")).toEqual([
      { text: "abc-123", dir: "ltr", level: 0 },
    ]);
    expect(splitBidiRuns("abc-\u05D0\u05D1\u05D2")).toEqual([
      { text: "abc-", dir: "ltr", level: 0 },
      { text: "\u05D0\u05D1\u05D2", dir: "rtl", level: 1 },
    ]);
  });

  it("honours an explicit base direction", () => {
    expect(splitBidiRuns("hello", "rtl")).toEqual([
      { text: "hello", dir: "ltr", level: 2 },
    ]);
    expect(splitBidiRuns("", "rtl")).toEqual([]);
  });
});

describe("mirrorChar", () => {
  it("mirrors ascii and guillemet brackets", () => {
    expect(mirrorChar("(")).toBe(")");
    expect(mirrorChar(")")).toBe("(");
    expect(mirrorChar("[")).toBe("]");
    expect(mirrorChar("{")).toBe("}");
    expect(mirrorChar("\u00AB")).toBe("\u00BB");
    expect(mirrorChar("\u00BB")).toBe("\u00AB");
    expect(mirrorChar("\u2039")).toBe("\u203A");
  });

  it("mirrors curly quotes and angle brackets", () => {
    expect(mirrorChar("\u201C")).toBe("\u201D");
    expect(mirrorChar("\u2018")).toBe("\u2019");
    expect(mirrorChar("\u27E8")).toBe("\u27E9");
    expect(mirrorChar("\u300A")).toBe("\u300B");
    expect(mirrorChar("\uFF08")).toBe("\uFF09");
  });

  it("returns unmirrored characters unchanged", () => {
    expect(mirrorChar("a")).toBe("a");
    expect(mirrorChar("\u05D0")).toBe("\u05D0");
    expect(mirrorChar("")).toBe("");
  });
});

describe("isMixed", () => {
  it("is false for uniform text, numbers and emoji", () => {
    expect(isMixed("hello")).toBe(false);
    expect(isMixed(HEBREW)).toBe(false);
    expect(isMixed(`123 ${ARABIC_INDIC} \u{1F600} ---`)).toBe(false);
    expect(isMixed("")).toBe(false);
  });

  it("is true when both strong directions appear", () => {
    expect(isMixed(`abc ${HEBREW}`)).toBe(true);
    expect(isMixed(`${ARABIC} abc`)).toBe(true);
  });
});

describe("normalizeMarks", () => {
  it("strips rlm/lrm/alm marks", () => {
    expect(normalizeMarks(`a${RLM}b${LRM}c${ALM}d`)).toBe("abcd");
  });

  it("strips explicit embedding and isolate controls", () => {
    expect(normalizeMarks(`${LRE}abc${PDF}`)).toBe("abc");
    expect(normalizeMarks(`${RLI}${HEBREW}${PDI}`)).toBe(HEBREW);
    expect(BIDI_CONTROL_CHARS).toContain(RLM);
    expect(isBidiControl(RLM)).toBe(true);
    expect(isBidiControl("a")).toBe(false);
  });

  it("leaves ordinary strong text untouched", () => {
    const text = `${HEBREW} 123 abc`;
    expect(normalizeMarks(text)).toBe(text);
  });
});

describe("toVisual / toLogical", () => {
  it("leaves pure ltr text unchanged", () => {
    expect(toVisual("abc def")).toBe("abc def");
    expect(toLogical("abc def")).toBe("abc def");
  });

  it("reorders runs and reverses rtl runs for an rtl base", () => {
    expect(toVisual(`${HEBREW} abc`, "rtl")).toBe("abc \u05D2\u05D1\u05D0");
    expect(toVisual(`(${HEBREW})`, "rtl")).toBe("(\u05D2\u05D1\u05D0)");
  });

  it("round-trips an ltr paragraph with an embedded rtl word", () => {
    const text = `abc ${HEBREW} def`;
    expect(toLogical(toVisual(text, "ltr"), "ltr")).toBe(text);
  });

  it("round-trips an rtl paragraph with embedded latin and brackets", () => {
    const text = `${HEBREW} (abc) def`;
    expect(toLogical(toVisual(text, "rtl"), "rtl")).toBe(text);
  });

  it("round-trips mixed text that contains digits", () => {
    const text = `abc 123 ${HEBREW} 456`;
    expect(toLogical(toVisual(text, "ltr"), "ltr")).toBe(text);
  });
});

describe("applyDirAttr", () => {
  it("derives a direction and class from text alone", () => {
    expect(applyDirAttr("hello")).toEqual({
      dir: "ltr",
      className: "dir-ltr",
    });
    expect(applyDirAttr(HEBREW)).toEqual({ dir: "rtl", className: "dir-rtl" });
  });

  it("flags mixed content with an extra class", () => {
    expect(applyDirAttr({ textContent: `abc ${HEBREW}` })).toEqual({
      dir: "ltr",
      className: "dir-ltr dir-mixed",
    });
  });

  it("lets an explicit dir attribute win over detection", () => {
    expect(applyDirAttr({ dir: "ltr", textContent: HEBREW })).toEqual({
      dir: "ltr",
      className: "dir-ltr",
    });
    expect(applyDirAttr({ dir: "rtl", textContent: "hello" })).toEqual({
      dir: "rtl",
      className: "dir-rtl",
    });
  });

  it("marks content with no strong character as auto", () => {
    expect(applyDirAttr("123")).toEqual({
      dir: "ltr",
      className: "dir-ltr dir-auto",
    });
  });
});

describe("contentDirProps", () => {
  it("gives strong text its own direction and the shared class", () => {
    expect(contentDirProps("Hello, world")).toEqual({
      dir: "ltr",
      className: "dir-ltr",
    });
    expect(contentDirProps(HEBREW)).toEqual({ dir: "rtl", className: "dir-rtl" });
    expect(contentDirProps(ARABIC)).toEqual({ dir: "rtl", className: "dir-rtl" });
  });

  it("keeps auto for empty and number-only fields so they inherit the document", () => {
    expect(contentDirProps("")).toEqual({ dir: "auto", className: "dir-auto" });
    expect(contentDirProps("123 456")).toEqual({ dir: "auto", className: "dir-auto" });
  });

  it("isolates mixed text without changing its resolved base direction", () => {
    expect(contentDirProps(`hello ${ARABIC}`)).toEqual({
      dir: "ltr",
      className: "dir-ltr dir-mixed",
    });
    expect(contentDirProps(`${HEBREW} hello`)).toEqual({
      dir: "rtl",
      className: "dir-rtl dir-mixed",
    });
  });
});

describe("inlineBidiProps", () => {
  it("always isolates an inline fragment", () => {
    expect(inlineBidiProps("Ada").className).toContain("bidi-isolate");
    expect(inlineBidiProps(HEBREW).className).toContain("bidi-isolate");
    expect(inlineBidiProps("").className).toContain("bidi-isolate");
  });

  it("derives the fragment direction from its own first strong character", () => {
    expect(inlineBidiProps("Ada")).toEqual({
      dir: "ltr",
      className: "dir-ltr bidi-isolate",
    });
    expect(inlineBidiProps(ARABIC)).toEqual({
      dir: "rtl",
      className: "dir-rtl bidi-isolate",
    });
    expect(inlineBidiProps("42")).toEqual({
      dir: "auto",
      className: "bidi-isolate",
    });
  });

  it("keeps the extra mixed marker on a mixed fragment", () => {
    expect(inlineBidiProps(`abc ${HEBREW}`).className).toBe(
      "dir-ltr bidi-isolate dir-mixed",
    );
  });
});

describe("describeDirection", () => {
  it("describes plain ltr text", () => {
    expect(describeDirection("hello")).toEqual({
      hint: "ltr",
      dir: "ltr",
      mixed: false,
      strong: true,
      hasNumbers: false,
      runCount: 1,
    });
  });

  it("describes mixed text with its run count", () => {
    const described = describeDirection(`abc ${HEBREW} def`);
    expect(described.mixed).toBe(true);
    expect(described.dir).toBe("ltr");
    expect(described.runCount).toBe(3);
  });

  it("describes numeric-only text as auto", () => {
    expect(describeDirection("123")).toEqual({
      hint: "auto",
      dir: "ltr",
      mixed: false,
      strong: false,
      hasNumbers: true,
      runCount: 1,
    });
  });

  it("describes rtl text", () => {
    const described = describeDirection(ARABIC);
    expect(described.hint).toBe("rtl");
    expect(described.dir).toBe("rtl");
    expect(described.mixed).toBe(false);
    expect(described.strong).toBe(true);
  });
});
