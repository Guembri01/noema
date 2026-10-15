import { describe, expect, it } from "vitest";
import {
  COMMON_PASSWORDS,
  PASSWORD_POLICY,
  PASSWORD_STRENGTH_LABELS,
  isCommonPassword,
  maskPassword,
  scorePassword,
  validatePassword,
} from "./password-policy";

/**
 * Password policy (red-first).
 *
 * Pure, dependency-free validation + strength scoring for signup and the
 * change-password flow. `validatePassword` returns the missing requirements as
 * a stable list of issue codes; `scorePassword` blends a length/variety entropy
 * heuristic with penalties for the patterns attackers try first (denylisted
 * passwords, repeated units, keyboard/sequential runs). Nothing here may throw,
 * whatever a caller passes.
 */

describe("PASSWORD_POLICY - defaults", () => {
  it("exposes the documented shape and values", () => {
    expect(PASSWORD_POLICY).toEqual({
      minLength: 8,
      requireUpper: true,
      requireLower: true,
      requireDigit: true,
      requireSymbol: false,
      forbidCommon: true,
    });
    expect(PASSWORD_POLICY.minLength).toBeGreaterThanOrEqual(8);
  });
});

describe("validatePassword", () => {
  it("accepts a password that satisfies the default policy", () => {
    const result = validatePassword("Tr0ub4dor&3");
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("reports every missing requirement in a stable order", () => {
    const result = validatePassword("abc");
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(["too_short", "missing_upper", "missing_digit"]);
  });

  it("flags a denylisted password even when it is long enough", () => {
    expect(validatePassword("password").issues).toContain("common");
    expect(validatePassword("Password1").issues).toContain("common");
    expect(validatePassword("Password1").ok).toBe(false);
  });

  it("honours a custom policy", () => {
    const strict = { ...PASSWORD_POLICY, minLength: 12, requireSymbol: true };
    expect(validatePassword("Abcdefgh1", strict).issues).toEqual(["too_short", "missing_symbol"]);
    expect(validatePassword("Abcdefghij1!", strict).ok).toBe(true);
  });

  it("never throws on empty or non-string input", () => {
    expect(validatePassword("")).toEqual({ ok: false, issues: ["empty"] });
    expect(validatePassword(undefined)).toEqual({ ok: false, issues: ["not_a_string"] });
    expect(validatePassword(12345 as unknown)).toEqual({ ok: false, issues: ["not_a_string"] });
  });

  it("rejects passwords past the hard length cap", () => {
    const huge = `Aa1${"x".repeat(400)}`;
    expect(validatePassword(huge).issues).toContain("too_long");
  });
});

describe("scorePassword", () => {
  it("scores the empty password 0 / very weak", () => {
    expect(scorePassword("")).toEqual({ score: 0, label: "very weak" });
  });

  it("gives denylisted and degenerate passwords the floor", () => {
    expect(scorePassword("password").score).toBe(0); // denylist
    expect(scorePassword("aaaaaaaa").score).toBe(0); // repeated single character
    expect(scorePassword("abcabcabc").score).toBe(0); // repeated unit
  });

  it("keeps short-but-varied passwords low", () => {
    expect(scorePassword("a9Bz4q").score).toBe(1); // only 6 chars
    expect(scorePassword("abc123").score).toBe(0); // ...but this one is denylisted
    expect(scorePassword("abcd1234").score).toBe(1); // sequential runs penalised
    expect(scorePassword("qwertyuio").score).toBe(1); // keyboard run penalised
  });

  it("rewards genuinely mixed long passwords", () => {
    expect(scorePassword("Tr0ub4dor&3")).toEqual({ score: 3, label: "good" });
    expect(scorePassword("7K#pL2$qR9@vN4&m")).toEqual({ score: 4, label: "strong" });
  });

  it("is monotonic across a weak -> strong ladder", () => {
    const ladder = ["pass", "abcdefgh", "abcd1234", "Tr0ub4dor&3", "7K#pL2$qR9@vN4&m"];
    const scores = ladder.map((pw) => scorePassword(pw).score);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
    expect(scores.at(-1)).toBe(4);
  });

  it("always reports a label that matches its score", () => {
    for (const pw of ["", "password", "abc123", "Tr0ub4dor&3", "7K#pL2$qR9@vN4&m"]) {
      const { score, label } = scorePassword(pw);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(4);
      expect(label).toBe(PASSWORD_STRENGTH_LABELS[score]);
    }
  });

  it("never throws on non-string input", () => {
    expect(scorePassword(null as unknown)).toEqual({ score: 0, label: "very weak" });
    expect(scorePassword(42 as unknown).score).toBe(0);
  });
});

describe("common-password denylist", () => {
  it("recognises well-known passwords and obvious variants", () => {
    expect(isCommonPassword("password")).toBe(true);
    expect(isCommonPassword("PASSWORD")).toBe(true);
    expect(isCommonPassword("qwerty123")).toBe(true);
    expect(isCommonPassword("letmein")).toBe(true);
    expect(isCommonPassword("password!!")).toBe(true); // symbols stripped to the root
  });

  it("does not flag a genuinely random password", () => {
    expect(isCommonPassword("7K#pL2$qR9@vN4&m")).toBe(false);
    expect(isCommonPassword("")).toBe(false);
    expect(isCommonPassword(undefined)).toBe(false);
  });

  it("ships a non-trivial denylist", () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThan(10);
    expect(COMMON_PASSWORDS.has("password")).toBe(true);
  });
});

describe("maskPassword", () => {
  it("masks every character while preserving length", () => {
    const mask = maskPassword("hunter2secret");
    expect(mask).toBe("•".repeat(13));
    expect(mask.length).toBe("hunter2secret".length);
  });

  it("can reveal the trailing characters (type-ahead affordance)", () => {
    expect(maskPassword("hunter2", { reveal: 2 })).toBe("•••••r2");
    expect(maskPassword("hunter2", { reveal: 99 })).toBe("hunter2");
    expect(maskPassword("hunter2", { reveal: -3 })).toBe("•••••••");
  });

  it("supports a custom mask character", () => {
    expect(maskPassword("abc", { mask: "*" })).toBe("***");
  });

  it("returns an empty string for empty or non-string input", () => {
    expect(maskPassword("")).toBe("");
    expect(maskPassword(undefined)).toBe("");
    expect(maskPassword(123 as unknown)).toBe("");
  });
});
