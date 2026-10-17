import { describe, expect, it } from "vitest";
import { randomBytes, randomInt, randomToken, toBase64Url, toHex } from "@/lib/random";

/**
 * Isomorphic randomness.
 *
 * The point of this module is that it must work identically on the server and in
 * a client component — it exists because `node:crypto` cannot be bundled for the
 * browser (which broke `next build`). These tests pin behaviour and, importantly,
 * the *unbiased* distribution of `randomInt`.
 *
 * **The CSPRNG is replaced in the tests that look at the draws.** The
 * distribution of `randomInt` is a property of the *mapping* of a draw to a
 * bucket, not of the luck of the draw — so those tests script the source (and,
 * for the distribution, seed it). A test that draws from the real CSPRNG and
 * then checks a statistical bound is a lottery: it turns a legitimate sample
 * into a red build every now and then, and it says nothing about the code when
 * it does.
 */

/**
 * The `Uint32Array` the implementation hands to the CSPRNG, seen the way the
 * implementation sees it — the platform's byte order, so the scripted draw is
 * the draw the code reads.
 */
function writeDraw(array: Uint8Array, draw: number): void {
  new Uint32Array(array.buffer, array.byteOffset, 1)[0] = draw >>> 0;
}

/** Run `body` with a CSPRNG that hands out the given 32-bit draws, in order. */
function withDraws(draws: number[], body: () => void): void {
  const original = globalThis.crypto.getRandomValues;
  let index = 0;
  globalThis.crypto.getRandomValues = ((array: Uint8Array) => {
    const draw = draws[index++];
    if (draw === undefined) throw new Error("the test asked for more draws than it scripted");
    writeDraw(array, draw);
    return array;
  }) as typeof globalThis.crypto.getRandomValues;
  try {
    body();
  } finally {
    globalThis.crypto.getRandomValues = original;
  }
}

/**
 * Run `body` with a **seeded** CSPRNG (mulberry32 — a small, well-known
 * generator with a full 32-bit output). The same seed gives the same draws on
 * every run, so a distribution measured over them is a fact about the code and
 * not about the moment the test runs.
 */
function withSeed(seed: number, body: () => void): void {
  const original = globalThis.crypto.getRandomValues;
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  globalThis.crypto.getRandomValues = ((array: Uint8Array) => {
    writeDraw(array, next());
    return array;
  }) as typeof globalThis.crypto.getRandomValues;
  try {
    body();
  } finally {
    globalThis.crypto.getRandomValues = original;
  }
}

/** The largest draw `randomInt(max)` may use — the ones above are rejected. */
function ceilingOf(max: number): number {
  return Math.floor(0x1_0000_0000 / max) * max;
}

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

  it("randomInt rejects the draws above the ceiling and uses the next one", () => {
    // The ceiling is where the bias would come from: a naive `% max` would map
    // the draws above it into the low buckets. The rejection sampling does not
    // use them — and with a scripted source the test can say so exactly.
    const ceiling = ceilingOf(62);
    const used: number[] = [];
    withDraws([ceiling, ceiling + 1, 5], () => {
      used.push(randomInt(62));
    });
    // The first two draws are at or above the ceiling → rejected. The third is
    // used, and it lands in its own bucket.
    expect(used).toEqual([5]);
  });

  it("randomInt maps an accepted draw to its own bucket", () => {
    // Every accepted draw maps to `draw % max` — and the draws that would
    // fall outside the range are never used.
    const ceiling = ceilingOf(62);
    const draws: number[] = [];
    for (let i = 0; i < 62 * 3; i += 1) draws.push(i);
    const seen: number[] = [];
    withDraws(draws, () => {
      for (let i = 0; i < 62 * 3; i += 1) seen.push(randomInt(62));
    });
    expect(seen).toEqual(draws.map((draw) => draw % 62));
    expect(draws.every((draw) => draw < ceiling)).toBe(true);
  });

  it("randomInt is not measurably biased across a non-power-of-two range", () => {
    // 62 buckets (the short-code alphabet). The source is **seeded**, so the
    // counts are the same on every run: the bound below is a fact about the
    // implementation and not a lottery. A naive `% 62` over the same draws
    // would show the bias in these very counts.
    const counts = new Array<number>(62).fill(0);
    const draws = 62 * 60;
    withSeed(0x5eed_1234, () => {
      for (let i = 0; i < draws; i += 1) counts[randomInt(62)] += 1;
    });
    expect(counts.every((count) => count > 0)).toBe(true);
    const expected = draws / 62;
    for (const count of counts) {
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
  });

  it("toHex matches Node's own encoder (so trace/span ids keep their shape)", () => {
    for (const length of [0, 1, 2, 8, 16, 32]) {
      const bytes = randomBytes(length);
      expect(toHex(bytes)).toBe(Buffer.from(bytes).toString("hex"));
    }
  });

  it("toHex pads every byte to two characters", () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
  });
});
