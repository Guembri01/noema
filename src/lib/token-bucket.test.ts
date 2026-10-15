import { describe, expect, it } from "vitest";
import {
  createBucket,
  peek,
  refill,
  tryConsume,
  type TokenBucket,
} from "@/lib/token-bucket";

/** Consume `tokens` and return the resulting bucket (asserting it was allowed). */
function drain(bucket: TokenBucket, now: number, tokens?: number): TokenBucket {
  const result = tryConsume(bucket, tokens === undefined ? { now } : { now, tokens });
  expect(result.allowed).toBe(true);
  return result.bucket;
}

describe("token bucket", () => {
  describe("createBucket", () => {
    it("starts full, anchored at t=0", () => {
      const bucket = createBucket({ capacity: 10, refillPerSecond: 1 });
      expect(bucket).toEqual({
        capacity: 10,
        refillPerSecond: 1,
        tokens: 10,
        lastRefillAt: 0,
      });
    });

    it("normalizes invalid config to an empty, non-refilling bucket", () => {
      expect(createBucket({ capacity: -5, refillPerSecond: -1 })).toEqual({
        capacity: 0,
        refillPerSecond: 0,
        tokens: 0,
        lastRefillAt: 0,
      });
      expect(createBucket({ capacity: NaN, refillPerSecond: Infinity })).toEqual({
        capacity: 0,
        refillPerSecond: 0,
        tokens: 0,
        lastRefillAt: 0,
      });
    });

    it("starts empty when capacity is zero", () => {
      expect(createBucket({ capacity: 0, refillPerSecond: 5 }).tokens).toBe(0);
    });
  });

  describe("refill", () => {
    it("adds tokens in proportion to elapsed time", () => {
      const empty = drain(createBucket({ capacity: 10, refillPerSecond: 2 }), 0, 10);
      expect(empty.tokens).toBe(0);
      expect(refill(empty, 1000).tokens).toBe(2); // 1s @ 2/s
      expect(refill(empty, 250).tokens).toBe(0.5); // 0.25s @ 2/s
    });

    it("caps at capacity and never overfills", () => {
      const half = drain(createBucket({ capacity: 10, refillPerSecond: 2 }), 0, 5);
      expect(half.tokens).toBe(5);
      expect(refill(half, 10_000).tokens).toBe(10);
    });

    it("advances the anchor so consecutive refills do not double-count", () => {
      const first = refill(createBucket({ capacity: 10, refillPerSecond: 1 }), 1000);
      expect(first.lastRefillAt).toBe(1000);
      // Already full, so still 10; a second refill from the new anchor stays put.
      expect(refill(first, 2000).tokens).toBe(10);
    });

    it("does not mutate its input or move backwards on a non-positive elapsed", () => {
      const empty = drain(createBucket({ capacity: 5, refillPerSecond: 1 }), 0, 5);
      const same = refill(empty, 0);
      expect(same).toBe(empty); // no-op returns the same state
      expect(refill(empty, -250)).toBe(empty); // clock going back is ignored
      expect(empty.tokens).toBe(0);
      expect(empty.lastRefillAt).toBe(0);
    });
  });

  describe("tryConsume", () => {
    it("consumes one token by default and returns the new bucket", () => {
      const result = tryConsume(createBucket({ capacity: 3, refillPerSecond: 1 }), {
        now: 0,
      });
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBe(0);
      expect(result.bucket.tokens).toBe(2);
    });

    it("supports consuming an explicit number of tokens", () => {
      const result = tryConsume(createBucket({ capacity: 5, refillPerSecond: 1 }), {
        now: 0,
        tokens: 3,
      });
      expect(result.allowed).toBe(true);
      expect(result.bucket.tokens).toBe(2);
    });

    it("allows consuming exactly the available tokens (boundary)", () => {
      const result = tryConsume(createBucket({ capacity: 2, refillPerSecond: 1 }), {
        now: 0,
        tokens: 2,
      });
      expect(result.allowed).toBe(true);
      expect(result.bucket.tokens).toBe(0);
    });

    it("denies when empty and reports the wait for the next token", () => {
      const empty = drain(createBucket({ capacity: 1, refillPerSecond: 1 }), 0, 1);
      const denied = tryConsume(empty, { now: 0 });
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBe(1000); // 1 token @ 1/s
      expect(denied.bucket.tokens).toBe(0); // a denied call consumes nothing
    });

    it("refills before deciding, so a later call succeeds", () => {
      const empty = drain(createBucket({ capacity: 1, refillPerSecond: 1 }), 0, 1);
      const allowed = tryConsume(empty, { now: 1000 });
      expect(allowed.allowed).toBe(true);
      expect(allowed.bucket.tokens).toBe(0);
      expect(allowed.bucket.lastRefillAt).toBe(1000);
    });

    it("does not mutate the input bucket", () => {
      const bucket = createBucket({ capacity: 4, refillPerSecond: 1 });
      tryConsume(bucket, { now: 0, tokens: 2 });
      expect(bucket.tokens).toBe(4);
      expect(bucket.lastRefillAt).toBe(0);
    });

    it("keeps denying with a stable wait while tokens are unavailable", () => {
      const empty = drain(createBucket({ capacity: 2, refillPerSecond: 2 }), 0, 2);
      const first = tryConsume(empty, { now: 0 });
      const second = tryConsume(empty, { now: 0 });
      expect(first.allowed).toBe(false);
      expect(first.retryAfterMs).toBe(500); // 1 token @ 2/s
      expect(second.retryAfterMs).toBe(500);
      expect(second.bucket.tokens).toBe(0);
    });

    it("rounds the wait up to whole milliseconds", () => {
      const empty = drain(createBucket({ capacity: 1, refillPerSecond: 3 }), 0, 1);
      const denied = tryConsume(empty, { now: 0 });
      expect(denied.retryAfterMs).toBe(334); // ceil(1000 / 3)
    });

    it("reports an unreachable wait (Infinity) when the rate is zero", () => {
      const empty = drain(createBucket({ capacity: 3, refillPerSecond: 0 }), 0, 3);
      const denied = tryConsume(empty, { now: 1000 });
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBe(Infinity);
    });

    it("reports an unreachable wait when more tokens are asked than capacity", () => {
      const bucket = createBucket({ capacity: 5, refillPerSecond: 10 });
      const denied = tryConsume(bucket, { now: 0, tokens: 6 });
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBe(Infinity);
    });

    it("always denies a zero-capacity bucket", () => {
      const denied = tryConsume(createBucket({ capacity: 0, refillPerSecond: 9 }), {
        now: 5000,
      });
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBe(Infinity);
    });

    it("treats a non-positive request as a no-op that consumes nothing", () => {
      const bucket = createBucket({ capacity: 2, refillPerSecond: 1 });
      const zero = tryConsume(bucket, { now: 0, tokens: 0 });
      expect(zero.allowed).toBe(true);
      expect(zero.bucket.tokens).toBe(2);
      expect(zero.retryAfterMs).toBe(0);
    });
  });

  describe("peek", () => {
    it("returns available tokens after refilling, without consuming", () => {
      const empty = drain(createBucket({ capacity: 4, refillPerSecond: 2 }), 0, 4);
      expect(peek(empty, 500)).toBe(1);
      expect(peek(empty, 5000)).toBe(4); // capped at capacity
      expect(empty.tokens).toBe(0); // peek never mutates
    });
  });

  describe("determinism", () => {
    it("produces identical results for an identical injected-clock sequence", () => {
      const run = () => {
        let bucket = createBucket({ capacity: 3, refillPerSecond: 1 });
        return [0, 0, 0, 0, 500, 1000, 1000, 2500].map((now) => {
          const result = tryConsume(bucket, { now });
          bucket = result.bucket;
          return [result.allowed, result.bucket.tokens, result.retryAfterMs];
        });
      };
      expect(run()).toEqual(run());
      expect(run()).toEqual([
        [true, 2, 0],
        [true, 1, 0],
        [true, 0, 0],
        [false, 0, 1000],
        [false, 0.5, 500],
        [true, 0, 0],
        [false, 0, 1000],
        [true, 0.5, 0],
      ]);
    });
  });
});
