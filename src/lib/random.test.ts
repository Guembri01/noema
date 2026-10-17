import { describe, expect, it, vi } from "vitest";
import {
  randomBase36,
  randomBytes,
  randomInt,
  randomToken,
  toBase64Url,
} from "@/lib/random";

/**
 * Isomorphic randomness.
 *
 * The point of this module is that it must work identically on the server and in
 * a client component — it exists because `node:crypto` cannot be bundled for the
 * browser (which broke `next build`). These tests pin behaviour and, importantly,
 * the *unbiased* distribution of `randomInt`.
 */
describe("random", () => {
  it("returns the requested number of bytes", () => {
    expect(randomBytes(0)).toHaveLength(0);
    expect(randomBytes(1)).toHaveLength(1);
    expect(randomBytes(32)).toHaveLength(32);
  });

  it("is not repeating itself", () => {
    const a = Buffer.from(randomBytes(16)).toString("hex");
    const b = Buffer.from(randomBytes(16)).toString("hex");
    expect(a).not.toBe(b);
  });

  it("rejects nonsense lengths instead of quietly returning something", () => {
    expect(() => randomBytes(-1)).toThrow(RangeError);
    expect(() => randomBytes(2.5)).toThrow(RangeError);
  });

  it("randomInt stays inside [0, max)", () => {
    for (let i = 0; i < 200; i += 1) {
      const value = randomInt(7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it("randomInt(1) is always 0 and bad bounds throw", () => {
    expect(randomInt(1)).toBe(0);
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(-5)).toThrow(RangeError);
    expect(() => randomInt(1.5)).toThrow(RangeError);
  });

  it("randomInt covers its whole range (no off-by-one)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) seen.add(randomInt(4));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it("randomInt is not measurably biased across a non-power-of-two range", () => {
    // 62 buckets (the short-code alphabet). Rejection sampling should land every
    // bucket; a naive `% 62` over 2000 draws would still land most, so this is a
    // sanity bound rather than a statistical test.
    const counts = new Array<number>(62).fill(0);
    const draws = 62 * 60;
    for (let i = 0; i < draws; i += 1) counts[randomInt(62)] += 1;
    expect(counts.every((count) => count > 0)).toBe(true);
    const expected = draws / 62;
    for (const count of counts) {
      // Inclusive: `expected * 0.5` is exactly 30 here, and a legitimate
      // sample can land on the boundary. The bound catches real bias without
      // turning a one-in-ten-thousand draw into a flaky red build.
      expect(Math.abs(count - expected)).toBeLessThanOrEqual(expected * 0.5);
    }
  });

  it("base64url matches Node's own encoder (so persisted tokens do not change)", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 24, 31, 32]) {
      const bytes = randomBytes(length);
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  it("randomToken is URL-safe base64url of the requested entropy", () => {
    const token = randomToken(24);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toHaveLength(32); // 24 bytes → 32 base64url chars, no padding
    expect(randomToken(24)).not.toBe(token);
    expect(randomToken()).toHaveLength(32); // default 24 bytes
  });

  it("randomBase36 returns exactly the requested number of characters", () => {
    expect(randomBase36(0)).toBe("");
    expect(randomBase36(1)).toHaveLength(1);
    expect(randomBase36(8)).toHaveLength(8);
    expect(randomBase36(32)).toHaveLength(32);
  });

  it("randomBase36 stays inside the base36 alphabet", () => {
    expect(randomBase36(64)).toMatch(/^[0-9a-z]{64}$/);
  });

  it("randomBase36 covers the whole alphabet and never repeats itself", () => {
    const seen = new Set<string>();
    const alphabet = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const value = randomBase36(8);
      seen.add(value);
      for (const character of value) alphabet.add(character);
    }
    expect(seen.size).toBe(500);
    expect(alphabet.size).toBe(36);
  });

  it("randomBase36 rejects nonsense lengths instead of quietly returning something", () => {
    expect(() => randomBase36(-1)).toThrow(RangeError);
    expect(() => randomBase36(2.5)).toThrow(RangeError);
  });

  it("randomBase36 does not touch Math.random", () => {
    const spy = vi.spyOn(Math, "random");
    try {
      randomBase36(8);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
