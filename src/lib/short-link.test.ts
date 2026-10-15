import { describe, expect, it, vi } from "vitest";
import {
  RESERVED_CODES,
  base62,
  generateShortCode,
  isValidShortCode,
  shortUrl,
  withCollisionRetry,
} from "@/lib/short-link";

const ALPHABET = /^[0-9A-Za-z]+$/;

describe("base62()", () => {
  it("encodes the zero and the single-digit range", () => {
    expect(base62(0)).toBe("0");
    expect(base62(9)).toBe("9");
    expect(base62(35)).toBe("Z");
    expect(base62(61)).toBe("z");
  });

  it("rolls over at the radix boundary", () => {
    expect(base62(62)).toBe("10");
    expect(base62(62 ** 7)).toBe(`1${"0".repeat(7)}`);
    expect(base62(62 ** 7)).toHaveLength(8);
  });

  it("rejects negative and non-integer inputs", () => {
    expect(() => base62(-1)).toThrow(RangeError);
    expect(() => base62(1.5)).toThrow(RangeError);
    expect(() => base62(Number.NaN)).toThrow(RangeError);
  });
});

describe("generateShortCode()", () => {
  it("defaults to a 7-char base62 code", () => {
    const code = generateShortCode();
    expect(code).toHaveLength(7);
    expect(ALPHABET.test(code)).toBe(true);
  });

  it("honours a custom length", () => {
    expect(generateShortCode({ length: 10 })).toHaveLength(10);
    expect(generateShortCode({ length: 1 })).toHaveLength(1);
  });

  it("is deterministic for the same seed", () => {
    expect(generateShortCode({ seed: "alpha" })).toBe(
      generateShortCode({ seed: "alpha" }),
    );
    expect(generateShortCode({ seed: 42 })).toBe(
      generateShortCode({ seed: 42 }),
    );
  });

  it("produces different codes for different seeds", () => {
    expect(generateShortCode({ seed: "alpha" })).not.toBe(
      generateShortCode({ seed: "beta" }),
    );
  });

  it("produces distinct, well-formed codes without a seed", () => {
    const codes = new Set(Array.from({ length: 8 }, () => generateShortCode()));
    for (const code of codes) {
      expect(ALPHABET.test(code)).toBe(true);
      expect(code).toHaveLength(7);
    }
    expect(codes.size).toBeGreaterThan(1);
  });

  it("rejects an invalid length", () => {
    expect(() => generateShortCode({ length: 0 })).toThrow(RangeError);
    expect(() => generateShortCode({ length: -3 })).toThrow(RangeError);
    expect(() => generateShortCode({ length: 2.5 })).toThrow(RangeError);
  });
});

describe("isValidShortCode()", () => {
  it("accepts generated and hand-written base62 codes", () => {
    expect(isValidShortCode(generateShortCode())).toBe(true);
    expect(isValidShortCode("aB3xY9")).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isValidShortCode(null as unknown as string)).toBe(false);
    expect(isValidShortCode(undefined as unknown as string)).toBe(false);
    expect(isValidShortCode(12345 as unknown as string)).toBe(false);
  });

  it("rejects codes outside the length bounds", () => {
    expect(isValidShortCode("abc")).toBe(false);
    expect(isValidShortCode("a".repeat(33))).toBe(false);
    expect(isValidShortCode("")).toBe(false);
  });

  it("rejects codes with characters outside the base62 alphabet", () => {
    expect(isValidShortCode("abc-def")).toBe(false);
    expect(isValidShortCode("abc def")).toBe(false);
    expect(isValidShortCode("abc_def")).toBe(false);
    expect(isValidShortCode("abc.de")).toBe(false);
  });

  it("rejects reserved words that would shadow real routes", () => {
    expect(isValidShortCode("admin")).toBe(false);
    expect(RESERVED_CODES.has("admin")).toBe(true);
    expect(RESERVED_CODES.has("api")).toBe(true);
    expect(RESERVED_CODES.size).toBeGreaterThan(0);
  });
});

describe("withCollisionRetry()", () => {
  it("returns the first code the store does not already have", () => {
    const generate = vi.fn(() => "code001");
    const exists = vi.fn(() => false);
    expect(withCollisionRetry(generate, exists, { maxAttempts: 5 })).toBe(
      "code001",
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("retries past codes that already exist", () => {
    let n = 0;
    const generate = vi.fn(() => `code00${++n}`);
    const taken = new Set(["code001", "code002"]);
    const exists = (code: string) => taken.has(code);
    expect(withCollisionRetry(generate, exists, { maxAttempts: 5 })).toBe(
      "code003",
    );
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting every attempt", () => {
    const generate = vi.fn(() => "code001");
    const exists = () => true;
    expect(() =>
      withCollisionRetry(generate, exists, { maxAttempts: 3 }),
    ).toThrow(/unique/i);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("never returns a reserved code, even when the store is empty", () => {
    const generate = vi.fn(() => "admin");
    const exists = vi.fn(() => false);
    expect(() =>
      withCollisionRetry(generate, exists, { maxAttempts: 2 }),
    ).toThrow(/unique/i);
    expect(exists).not.toHaveBeenCalled();
  });
});

describe("shortUrl()", () => {
  it("appends the code to a bare origin", () => {
    expect(shortUrl("https://n.example", "code001")).toBe(
      "https://n.example/code001",
    );
  });

  it("does not double up slashes", () => {
    expect(shortUrl("https://n.example/", "code001")).toBe(
      "https://n.example/code001",
    );
    expect(shortUrl("https://n.example", "/code001")).toBe(
      "https://n.example/code001",
    );
    expect(shortUrl("https://n.example/", "/code001")).toBe(
      "https://n.example/code001",
    );
  });

  it("preserves a base path prefix", () => {
    expect(shortUrl("https://n.example/s/", "code001")).toBe(
      "https://n.example/s/code001",
    );
  });
});
