import { describe, expect, it } from "vitest";
import {
  DEFAULT_INCREMENTAL_WINDOW,
  TYPOGRAPHY_RULES,
  applyRule,
  applySmartTypography,
  applySmartTypographyIncremental,
  type TypographyRule,
} from "@/lib/smart-typography";

/* Every string is fixed. The curly characters are written as \u escapes so the
   file stays ASCII and a bad copy/paste cannot silently change an expectation. */

const rule = (id: string): TypographyRule => {
  const found = TYPOGRAPHY_RULES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`unknown typography rule: ${id}`);
  return found;
};

const LEFT_DOUBLE = "\u201C";
const RIGHT_DOUBLE = "\u201D";
const LEFT_SINGLE = "\u2018";
const RIGHT_SINGLE = "\u2019";
const EN_DASH = "\u2013";
const EM_DASH = "\u2014";
const ELLIPSIS = "\u2026";
const COPYRIGHT = "\u00A9";
const REGISTERED = "\u00AE";
const TRADEMARK = "\u2122";
const FF_LIGATURE = "\uFB00";
const FI_LIGATURE = "\uFB01";
const FL_LIGATURE = "\uFB02";

describe("rule descriptors", () => {
  it("is a non-empty, uniquely identified, self-described list", () => {
    expect(TYPOGRAPHY_RULES.length).toBeGreaterThanOrEqual(9);
    expect(new Set(TYPOGRAPHY_RULES.map((r) => r.id)).size).toBe(
      TYPOGRAPHY_RULES.length,
    );
    expect(
      TYPOGRAPHY_RULES.every(
        (r) =>
          r.id.length > 0 &&
          r.pattern.length > 0 &&
          r.description.length > 0 &&
          typeof r.replace === "function",
      ),
    ).toBe(true);
  });

  it("marks only the ligature expansions optional", () => {
    expect(
      TYPOGRAPHY_RULES.filter((r) => r.optional).map((r) => r.id),
    ).toEqual(["ligature-ff", "ligature-fi", "ligature-fl"]);
  });
});

describe("dashes", () => {
  it("maps a triple hyphen to an em dash, a double to an en dash", () => {
    expect(applyRule(rule("em-dash"), "a---b")).toBe(`a${EM_DASH}b`);
    expect(applyRule(rule("en-dash"), "a--b")).toBe(`a${EN_DASH}b`);
  });

  it("keeps the en-dash rule independent of the em-dash rule", () => {
    // Applied alone, `--` eats the first two of `---`, proving the em-dash
    // rule must run first inside `applySmartTypography`.
    expect(applyRule(rule("en-dash"), "a---b")).toBe(`a${EN_DASH}-b`);
  });

  it("leaves a spaced single hyphen alone", () => {
    expect(applyRule(rule("en-dash"), "a - b")).toBe("a - b");
    expect(applySmartTypography("a - b")).toBe("a - b");
  });
});

describe("ellipsis", () => {
  it("collapses three periods, and only three", () => {
    expect(applyRule(rule("ellipsis"), "wait...")).toBe(`wait${ELLIPSIS}`);
    expect(applyRule(rule("ellipsis"), "wait..")).toBe("wait..");
  });
});

describe("symbols (case-insensitive)", () => {
  it("maps (c)/(C) to a copyright sign", () => {
    expect(applyRule(rule("copyright"), "(c)")).toBe(COPYRIGHT);
    expect(applyRule(rule("copyright"), "(C)")).toBe(COPYRIGHT);
    expect(applyRule(rule("copyright"), "(cc)")).toBe("(cc)");
  });

  it("maps (r)/(R) to a registered sign", () => {
    expect(applyRule(rule("registered"), "(r)")).toBe(REGISTERED);
    expect(applyRule(rule("registered"), "(R)")).toBe(REGISTERED);
  });

  it("maps (tm) in any case to a trademark sign", () => {
    expect(applyRule(rule("trademark"), "(tm)")).toBe(TRADEMARK);
    expect(applyRule(rule("trademark"), "(TM)")).toBe(TRADEMARK);
    expect(applyRule(rule("trademark"), "(Tm)")).toBe(TRADEMARK);
  });
});

describe("double quotes", () => {
  const dt = (text: string) => applyRule(rule("double-quote"), text);

  it("opens at the start of the text and closes at the end", () => {
    expect(dt('"hi"')).toBe(`${LEFT_DOUBLE}hi${RIGHT_DOUBLE}`);
    expect(dt('"')).toBe(LEFT_DOUBLE);
  });

  it("opens after whitespace and after an opening bracket", () => {
    expect(dt('say "hi"')).toBe(`say ${LEFT_DOUBLE}hi${RIGHT_DOUBLE}`);
    expect(dt('("hi")')).toBe(
      `(${LEFT_DOUBLE}hi${RIGHT_DOUBLE})`,
    );
  });

  it("closes after a word", () => {
    expect(dt('hi"')).toBe(`hi${RIGHT_DOUBLE}`);
  });

  it("leaves word-internal quotes conservative", () => {
    expect(dt('5"3')).toBe('5"3');
    expect(dt('a"b')).toBe('a"b');
  });
});

describe("single quotes / apostrophes", () => {
  const st = (text: string) => applyRule(rule("single-quote"), text);

  it("turns word-internal quotes into an apostrophe", () => {
    expect(st("it's")).toBe(`it${RIGHT_SINGLE}s`);
    expect(st("don't")).toBe(`don${RIGHT_SINGLE}t`);
  });

  it("treats a leading elision as an apostrophe, not an opening quote", () => {
    expect(st("'tis")).toBe(`${RIGHT_SINGLE}tis`);
    expect(st("'Twas")).toBe(`${RIGHT_SINGLE}Twas`);
    expect(st("'80s")).toBe(`${RIGHT_SINGLE}80s`);
  });

  it("opens a matched pair", () => {
    expect(st("'hi'")).toBe(`${LEFT_SINGLE}hi${RIGHT_SINGLE}`);
  });
});

describe("applySmartTypography end-to-end", () => {
  it("converts quotes, dashes and an ellipsis together", () => {
    expect(applySmartTypography('"Hello, world..."')).toBe(
      `${LEFT_DOUBLE}Hello, world${ELLIPSIS}${RIGHT_DOUBLE}`,
    );
    expect(applySmartTypography("It's a test -- really --- trust me")).toBe(
      `It${RIGHT_SINGLE}s a test ${EN_DASH} really ${EM_DASH} trust me`,
    );
  });

  it("handles nested single quotes inside double quotes", () => {
    expect(applySmartTypography('He said "she\'s here".')).toBe(
      `He said ${LEFT_DOUBLE}she${RIGHT_SINGLE}s here${RIGHT_DOUBLE}.`,
    );
  });

  it("converts symbols, quotes and dashes in one pass", () => {
    expect(applySmartTypography('"Don\'t" -- she said... (c)')).toBe(
      `${LEFT_DOUBLE}Don${RIGHT_SINGLE}t${RIGHT_DOUBLE} ${EN_DASH} she said${ELLIPSIS} ${COPYRIGHT}`,
    );
    expect(applySmartTypography("Copyright (c) 2026 Noema (r) (TM)")).toBe(
      `Copyright ${COPYRIGHT} 2026 Noema ${REGISTERED} ${TRADEMARK}`,
    );
  });

  it("is idempotent on already-converted prose", () => {
    const once = applySmartTypography('"a--b... (c) it\'s"');
    expect(applySmartTypography(once)).toBe(once);
    const elision = applySmartTypography("'tis -- don't");
    expect(applySmartTypography(elision)).toBe(elision);
  });
});

describe("ligatures", () => {
  const ligatures = `of${FI_LIGATURE}ce and ${FL_LIGATURE}ow and o${FF_LIGATURE}er`;

  it("is inert by default", () => {
    expect(applySmartTypography(ligatures)).toBe(ligatures);
  });

  it("expands every ligature when disableLigatures is set", () => {
    expect(applySmartTypography(ligatures, { disableLigatures: true })).toBe(
      "office and flow and offer",
    );
    expect(applyRule(rule("ligature-fi"), `of${FI_LIGATURE}ce`)).toBe("office");
  });

  it("still runs the other rules while expanding ligatures", () => {
    expect(
      applySmartTypography(`(c) of${FI_LIGATURE}ce -- ${FL_LIGATURE}ow`, {
        disableLigatures: true,
      }),
    ).toBe(`\u00A9 office ${EN_DASH} flow`);
  });

  it("stays idempotent with ligatures disabled", () => {
    const once = applySmartTypography(`of${FI_LIGATURE}ce`, {
      disableLigatures: true,
    });
    expect(applySmartTypography(once, { disableLigatures: true })).toBe(once);
  });
});

describe("applySmartTypographyIncremental", () => {
  it("processes the whole line for ordinary insertions", () => {
    expect(applySmartTypographyIncremental("Hello ", "world...")).toBe(
      `Hello world${ELLIPSIS}`,
    );
    expect(applySmartTypographyIncremental("It", "'s")).toBe(
      `It${RIGHT_SINGLE}s`,
    );
    expect(applySmartTypographyIncremental("prefix ", "end--")).toBe(
      `prefix end${EN_DASH}`,
    );
  });

  it("decides quote direction from the text before the cursor", () => {
    expect(applySmartTypographyIncremental("He said ", '"')).toBe(
      `He said ${LEFT_DOUBLE}`,
    );
    expect(applySmartTypographyIncremental(`He said ${LEFT_DOUBLE}hi`, '"')).toBe(
      `He said ${LEFT_DOUBLE}hi${RIGHT_DOUBLE}`,
    );
  });

  it("only reprocesses the requested tail window", () => {
    expect(applySmartTypographyIncremental("", "a---b", { windowSize: 8 })).toBe(
      `a${EM_DASH}b`,
    );
    // A window smaller than the pattern cannot see the whole run, so the text
    // is left as typed — the documented limitation of the incremental path.
    expect(applySmartTypographyIncremental("", "a---b", { windowSize: 2 })).toBe(
      "a---b",
    );
    expect(DEFAULT_INCREMENTAL_WINDOW).toBeGreaterThan(4);
  });
});
