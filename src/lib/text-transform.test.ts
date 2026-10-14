import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_TRANSFORM_STATE,
  TEXT_TRANSFORMS,
  applyTextTransform,
  applyTextTransformState,
  createTextTransformState,
  isTextTransformKind,
  setTextTransform,
  toAllCaps,
  toSmallCaps,
  type TextTransformKind,
} from "@/lib/text-transform";

/* Small-capital and superscript code points are written as \u escapes so the
   file stays ASCII and a bad copy/paste cannot silently change an expectation. */

const SC = {
  a: "\u1D00",
  b: "\u0299",
  c: "\u1D04",
  d: "\u1D05",
  e: "\u1D07",
  f: "\uA730",
  g: "\u0262",
  h: "\u029C",
  i: "\u026A",
  j: "\u1D0A",
  k: "\u1D0B",
  l: "\u029F",
  m: "\u1D0D",
  n: "\u0274",
  o: "\u1D0F",
  p: "\u1D18",
  r: "\u0280",
  s: "\uA731",
  t: "\u1D1B",
  u: "\u1D1C",
  v: "\u1D20",
  w: "\u1D21",
  y: "\u028F",
  z: "\u1D22",
} as const;

const SUP = {
  "0": "\u2070",
  "1": "\u00B9",
  "2": "\u00B2",
  "3": "\u00B3",
  "4": "\u2074",
  "5": "\u2075",
  "6": "\u2076",
  "7": "\u2077",
  "8": "\u2078",
  "9": "\u2079",
} as const;

/** Combining acute accent, left detached so precomposed input can be built. */
const ACUTE = "\u0301";

describe("toAllCaps", () => {
  it("uppercases letters and leaves digits and punctuation", () => {
    expect(toAllCaps("Hello, world!")).toBe("HELLO, WORLD!");
    expect(toAllCaps("v1.2.3")).toBe("V1.2.3");
  });

  it("uppercases across Unicode while keeping emoji untouched", () => {
    expect(toAllCaps("café")).toBe("CAFÉ");
    expect(toAllCaps("🚀 déjà vu")).toBe("🚀 DÉJÀ VU");
  });

  it("uppercases a non-Latin script without changing anything else", () => {
    expect(toAllCaps("привет")).toBe("ПРИВЕТ");
  });

  it("is a no-op on the empty string and is idempotent", () => {
    expect(toAllCaps("")).toBe("");
    expect(toAllCaps(toAllCaps("abc"))).toBe("ABC");
  });
});

describe("toSmallCaps", () => {
  it("maps lowercase latin letters to small-capital figures", () => {
    expect(toSmallCaps("hello")).toBe(
      `${SC.h}${SC.e}${SC.l}${SC.l}${SC.o}`,
    );
    expect(toSmallCaps("notion")).toBe(
      `${SC.n}${SC.o}${SC.t}${SC.i}${SC.o}${SC.n}`,
    );
  });

  it("maps uppercase letters to the same small-capital figures", () => {
    expect(toSmallCaps("HELLO")).toBe(toSmallCaps("hello"));
    expect(toSmallCaps("Notion")).toBe(toSmallCaps("notion"));
  });

  it("leaves digits alone by default", () => {
    expect(toSmallCaps("abc123")).toBe(`${SC.a}${SC.b}${SC.c}123`);
  });

  it("maps digits to superscript figures when the option is set", () => {
    expect(toSmallCaps("2026", { digits: true })).toBe(
      `${SUP["2"]}${SUP["0"]}${SUP["2"]}${SUP["6"]}`,
    );
    expect(toSmallCaps("a1", { digits: true })).toBe(`${SC.a}${SUP["1"]}`);
  });

  it("passes punctuation, spaces, symbols and emoji through untouched", () => {
    expect(toSmallCaps("A-B! 🚀")).toBe(`${SC.a}-${SC.b}! 🚀`);
    expect(toSmallCaps("a b\nc")).toBe(`${SC.a} ${SC.b}\n${SC.c}`);
  });

  it("passes through characters with no small-capital figure (q, x)", () => {
    expect(toSmallCaps("quiz")).toBe(`q${SC.u}${SC.i}${SC.z}`);
    expect(toSmallCaps("tax")).toBe(`${SC.t}${SC.a}x`);
  });

  it("preserves combining marks whether precomposed or decomposed", () => {
    expect(toSmallCaps("café")).toBe(`${SC.c}${SC.a}${SC.f}${SC.e}${ACUTE}`);
    expect(toSmallCaps(`cafe${ACUTE}`)).toBe(
      `${SC.c}${SC.a}${SC.f}${SC.e}${ACUTE}`,
    );
  });

  it("passes non-Latin scripts through untouched", () => {
    expect(toSmallCaps("привет")).toBe("привет");
    expect(toSmallCaps("日本語")).toBe("日本語");
  });

  it("is idempotent on its own output", () => {
    expect(toSmallCaps(toSmallCaps("hello"))).toBe(toSmallCaps("hello"));
  });
});

describe("TEXT_TRANSFORMS catalog", () => {
  it("lists the three supported kinds in order", () => {
    expect(TEXT_TRANSFORMS.map((t) => t.kind)).toEqual([
      "none",
      "uppercase",
      "smallcaps",
    ]);
  });

  it("is uniquely identified and self-described", () => {
    expect(new Set(TEXT_TRANSFORMS.map((t) => t.kind)).size).toBe(
      TEXT_TRANSFORMS.length,
    );
    expect(
      TEXT_TRANSFORMS.every(
        (t) => t.label.length > 0 && t.description.length > 0,
      ),
    ).toBe(true);
  });
});

describe("applyTextTransform", () => {
  it("returns the text unchanged for 'none'", () => {
    expect(applyTextTransform("none", "Hello")).toBe("Hello");
  });

  it("delegates 'uppercase' to toAllCaps", () => {
    expect(applyTextTransform("uppercase", "Hello")).toBe("HELLO");
  });

  it("delegates 'smallcaps' to toSmallCaps, forwarding options", () => {
    expect(applyTextTransform("smallcaps", "abc")).toBe(toSmallCaps("abc"));
    expect(applyTextTransform("smallcaps", "1", { digits: true })).toBe(
      SUP["1"],
    );
  });

  it("handles the empty string for every kind", () => {
    const kinds: TextTransformKind[] = ["none", "uppercase", "smallcaps"];
    for (const kind of kinds) expect(applyTextTransform(kind, "")).toBe("");
  });
});

describe("text transform state", () => {
  it("defaults to 'none'", () => {
    expect(DEFAULT_TEXT_TRANSFORM_STATE).toEqual({ transform: "none" });
    expect(createTextTransformState()).toEqual({ transform: "none" });
    expect(createTextTransformState("smallcaps")).toEqual({
      transform: "smallcaps",
    });
  });

  it("setTextTransform returns a new state without mutating the source", () => {
    const before = createTextTransformState("none");
    const after = setTextTransform(before, "uppercase");
    expect(after).toEqual({ transform: "uppercase" });
    expect(before).toEqual({ transform: "none" });
    expect(after).not.toBe(before);
  });

  it("recognises only the supported kinds", () => {
    expect(isTextTransformKind("none")).toBe(true);
    expect(isTextTransformKind("uppercase")).toBe(true);
    expect(isTextTransformKind("smallcaps")).toBe(true);
    expect(isTextTransformKind("lowercase")).toBe(false);
    expect(isTextTransformKind(undefined)).toBe(false);
  });

  it("applies the transform held by the state", () => {
    expect(
      applyTextTransformState(createTextTransformState("uppercase"), "hi"),
    ).toBe("HI");
    expect(applyTextTransformState({ transform: "smallcaps" }, "ab")).toBe(
      `${SC.a}${SC.b}`,
    );
  });
});
