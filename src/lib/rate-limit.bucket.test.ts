import { describe, expect, it } from "vitest";
import { RateLimiter, TokenBucketLimiter } from "@/lib/rate-limit";

/**
 * Additive coverage for the LRU-bounded sliding limiter and the new
 * keyed token-bucket limiter wired into the sliding windows in `rate-limit.ts`.
 * The pre-existing suite (`rate-limit.test.ts`) still pins the exact
 * sliding-window behaviour; this file pins the two adoptions on top of it.
 */
describe("RateLimiter LRU-bounded key space", () => {
  it("evicts the least-recently-used key once maxKeys is exceeded", () => {
    const tiers = { READ: { limit: 2, windowMs: 1000 } };
    const limiter = new RateLimiter(tiers, { maxKeys: 2 });
    limiter.hit({ key: "a", tier: "READ", now: 0 });
    limiter.hit({ key: "b", tier: "READ", now: 1 });
    expect(limiter.size()).toBe(2);

    limiter.hit({ key: "c", tier: "READ", now: 2 }); // evicts the coldest, "a"
    expect(limiter.size()).toBe(2);

    // "a" was evicted, so it starts a fresh window: a full budget of 2.
    expect(limiter.hit({ key: "a", tier: "READ", now: 3 }).remaining).toBe(1);
    // "c" (most recently used) kept its budget: its second hit drops to 0.
    expect(limiter.hit({ key: "c", tier: "READ", now: 5 }).remaining).toBe(0);
  });

  it("keeps pruning working over the LRU-backed state", () => {
    const limiter = new RateLimiter({ READ: { limit: 10, windowMs: 1000 } });
    limiter.hit({ key: "old", tier: "READ", now: 0 });
    limiter.hit({ key: "new", tier: "READ", now: 900 });
    expect(limiter.prune(1050)).toBe(1);
    expect(limiter.size()).toBe(1);
  });
});

describe("TokenBucketLimiter", () => {
  it("allows a burst up to capacity, then denies with a retry hint", () => {
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1 });
    expect(limiter.hit("k", 0).allowed).toBe(true);
    expect(limiter.hit("k", 0).allowed).toBe(true);

    const denied = limiter.hit("k", 0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000);

    // One second later a token has accrued, so the next hit succeeds again.
    expect(limiter.hit("k", 1000).allowed).toBe(true);
  });

  it("isolates buckets by key and bounds the key space", () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 1 });
    expect(limiter.hit("a", 0).allowed).toBe(true);
    expect(limiter.hit("b", 0).allowed).toBe(true); // evicts "a"
    expect(limiter.size()).toBe(1);
    // "a" was evicted, so its bucket is fresh and full again.
    expect(limiter.hit("a", 0).allowed).toBe(true);
  });

  it("reset() drops every bucket", () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 });
    limiter.hit("k", 0);
    expect(limiter.size()).toBe(1);
    limiter.reset();
    expect(limiter.size()).toBe(0);
  });
});
