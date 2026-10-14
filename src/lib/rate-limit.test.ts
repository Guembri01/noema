import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_TIERS,
  RateLimiter,
  checkRateLimit,
  clientKey,
  pruneExpired,
  resetRateLimits,
  type RateTier,
  type SlidingState,
} from "@/lib/rate-limit";

describe("rate limiter", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to the limit then blocks", () => {
    const now = 0;
    expect(checkRateLimit("k", 2, 1000, now).ok).toBe(true);
    expect(checkRateLimit("k", 2, 1000, now).ok).toBe(true);
    const blocked = checkRateLimit("k", 2, 1000, now);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
  });

  it("resets after the window", () => {
    checkRateLimit("k", 1, 1000, 0);
    expect(checkRateLimit("k", 1, 1000, 500).ok).toBe(false);
    expect(checkRateLimit("k", 1, 1000, 1001).ok).toBe(true);
  });

  it("isolates keys", () => {
    expect(checkRateLimit("a", 1, 1000, 0).ok).toBe(true);
    expect(checkRateLimit("b", 1, 1000, 0).ok).toBe(true);
    expect(checkRateLimit("a", 1, 1000, 0).ok).toBe(false);
  });

  it("derives a key from forwarding headers", () => {
    const request = new Request("http://x", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(clientKey(request, "api")).toBe("api:1.2.3.4");
  });

  describe("window edges (injected clock)", () => {
    it("opens a new window exactly at resetAt (inclusive boundary)", () => {
      expect(checkRateLimit("k", 1, 1000, 0).ok).toBe(true); // resetAt = 1000
      expect(checkRateLimit("k", 1, 1000, 999).ok).toBe(false); // 1ms before reset: still blocked
      const rolled = checkRateLimit("k", 1, 1000, 1000); // now === resetAt: new window
      expect(rolled.ok).toBe(true);
      expect(rolled.remaining).toBe(0);
      expect(rolled.retryAfterMs).toBe(0);
    });

    it("re-anchors the window at now + windowMs after each rollover", () => {
      checkRateLimit("k", 2, 1000, 0); // window 1: [0, 1000)
      expect(checkRateLimit("k", 2, 1000, 1500)).toEqual({
        ok: true,
        remaining: 1,
        retryAfterMs: 0,
      }); // window 2: [1500, 2500)
      expect(checkRateLimit("k", 2, 1000, 2499)).toEqual({
        ok: true,
        remaining: 0,
        retryAfterMs: 0,
      });
      const blocked = checkRateLimit("k", 2, 1000, 2499);
      expect(blocked.ok).toBe(false);
      expect(blocked.retryAfterMs).toBe(1);
      expect(checkRateLimit("k", 2, 1000, 2500).ok).toBe(true); // window 3 opens
    });

    it("counts retryAfterMs down toward reset without drifting", () => {
      checkRateLimit("k", 1, 1000, 0); // resetAt = 1000
      expect(checkRateLimit("k", 1, 1000, 400).retryAfterMs).toBe(600);
      expect(checkRateLimit("k", 1, 1000, 750).retryAfterMs).toBe(250);
      expect(checkRateLimit("k", 1, 1000, 999).retryAfterMs).toBe(1);
    });

    it("blocked calls never consume budget", () => {
      checkRateLimit("k", 3, 1000, 0); // resetAt = 1000, count = 1
      expect(checkRateLimit("k", 3, 1000, 10).remaining).toBe(1); // count = 2
      expect(checkRateLimit("k", 3, 1000, 20).remaining).toBe(0); // count = 3 (at limit)
      expect(checkRateLimit("k", 3, 1000, 30).ok).toBe(false); // over limit
      expect(checkRateLimit("k", 3, 1000, 40).ok).toBe(false); // still over, count untouched
      // if blocked calls had counted, the next window would start degraded
      expect(checkRateLimit("k", 3, 1000, 1000)).toEqual({
        ok: true,
        remaining: 2,
        retryAfterMs: 0,
      });
    });

    it("treats limit as an exact boundary: N allowed, N+1 blocked", () => {
      const results = [0, 1, 2, 3].map((t) => checkRateLimit("k", 2, 1000, t));
      expect(results.map((r) => r.ok)).toEqual([true, true, false, false]);
      expect(results.map((r) => r.remaining)).toEqual([1, 0, 0, 0]);
    });
  });

  describe("clientKey derivation", () => {
    const req = (headers: Record<string, string>) =>
      new Request("http://x", { headers });

    it("falls back to x-real-ip when x-forwarded-for is absent", () => {
      expect(clientKey(req({ "x-real-ip": "9.9.9.9" }), "api")).toBe(
        "api:9.9.9.9",
      );
    });

    it("falls back to 'local' when no forwarding headers exist", () => {
      expect(clientKey(req({}), "api")).toBe("api:local");
    });

    it("prefers x-forwarded-for over x-real-ip", () => {
      expect(
        clientKey(
          req({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "9.9.9.9" }),
          "api",
        ),
      ).toBe("api:1.2.3.4");
    });

    it("ignores an empty/whitespace x-forwarded-for and uses the fallback chain", () => {
      expect(
        clientKey(
          req({ "x-forwarded-for": "  ", "x-real-ip": "9.9.9.9" }),
          "api",
        ),
      ).toBe("api:9.9.9.9");
      expect(clientKey(req({ "x-forwarded-for": "" }), "api")).toBe(
        "api:local",
      );
    });

    it("trims whitespace around the first hop only", () => {
      expect(
        clientKey(req({ "x-forwarded-for": "  1.2.3.4 ,5.6.7.8  " }), "api"),
      ).toBe("api:1.2.3.4");
    });

    it("qualifies keys by scope so scopes never share a bucket", () => {
      const request = req({ "x-forwarded-for": "1.2.3.4" });
      expect(clientKey(request, "chat")).not.toBe(clientKey(request, "upload"));
      expect(clientKey(request, "chat")).toBe("chat:1.2.3.4");
    });
  });

  describe("RateLimiter sliding window (slidingHit)", () => {
    const opts = { limit: 2, windowMs: 1000 };

    it("allows under-limit hits with a structured result", () => {
      const limiter = new RateLimiter();
      expect(limiter.slidingHit("k", 0, opts)).toEqual({
        allowed: true,
        remaining: 1,
        retryAfterMs: 0,
        limit: 2,
        resetAt: 1000,
      });
      expect(limiter.slidingHit("k", 10, opts)).toEqual({
        allowed: true,
        remaining: 0,
        retryAfterMs: 0,
        limit: 2,
        resetAt: 1010,
      });
    });

    it("denies at the boundary with correct retryAfterMs and resetAt", () => {
      const limiter = new RateLimiter();
      limiter.slidingHit("k", 0, opts); // hit 1: expires at 1000
      limiter.slidingHit("k", 10, opts); // hit 2: expires at 1010
      const denied = limiter.slidingHit("k", 20, opts);
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.limit).toBe(2);
      // retry is possible the moment the oldest hit slides out of the window
      expect(denied.retryAfterMs).toBe(980); // 0 + 1000 - 20
      expect(denied.resetAt).toBe(1000);
      const later = limiter.slidingHit("k", 500, opts);
      expect(later.retryAfterMs).toBe(500); // 0 + 1000 - 500
    });

    it("denied hits never consume budget", () => {
      const limiter = new RateLimiter();
      const one = { limit: 1, windowMs: 1000 };
      expect(limiter.slidingHit("k", 0, one).allowed).toBe(true);
      expect(limiter.slidingHit("k", 100, one).allowed).toBe(false);
      expect(limiter.slidingHit("k", 200, one).allowed).toBe(false);
      const freed = limiter.slidingHit("k", 1000, one); // hit@0 expired
      expect(freed.allowed).toBe(true);
      expect(freed.remaining).toBe(0);
    });

    it("does NOT allow a 2x burst across a fixed-window boundary", () => {
      const limiter = new RateLimiter();
      const burst = { limit: 5, windowMs: 1000 };
      for (let i = 0; i < 5; i++) {
        expect(limiter.slidingHit("k", 990 + i, burst).allowed).toBe(true);
      }
      // A fixed window re-opens at t=1000 and would allow 5 MORE hits here,
      // i.e. 10 hits within 10ms. The sliding window must deny.
      const denied = limiter.slidingHit("k", 1000, burst);
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBe(990); // oldest hit@990 expires at 1990
      expect(limiter.slidingHit("k", 1989, burst).allowed).toBe(false);
      // ...and frees exactly one slot as each hit ages out (still full, not a reset)
      const freed = limiter.slidingHit("k", 1990, burst);
      expect(freed.allowed).toBe(true);
      expect(freed.remaining).toBe(0);
    });

    it("isolates sliding counters by key", () => {
      const limiter = new RateLimiter();
      expect(limiter.slidingHit("a", 0, opts).allowed).toBe(true);
      expect(limiter.slidingHit("a", 0, opts).allowed).toBe(true);
      expect(limiter.slidingHit("a", 0, opts).allowed).toBe(false);
      expect(limiter.slidingHit("b", 0, opts).allowed).toBe(true);
    });

    it("is deterministic under an injected clock", () => {
      const run = (): unknown[] => {
        const limiter = new RateLimiter({ WRITE: { limit: 3, windowMs: 500 } });
        return [0, 100, 250, 499, 600, 750, 1250].map((now) =>
          limiter.hit({ key: "k", tier: "WRITE", now }),
        );
      };
      expect(run()).toEqual(run());
    });
  });

  describe("RateLimiter tiers (hit)", () => {
    it("ships a default tier table covering READ/WRITE/AUTH/AI", () => {
      expect(Object.keys(DEFAULT_RATE_TIERS).sort()).toEqual([
        "AI",
        "AUTH",
        "READ",
        "WRITE",
      ]);
      for (const tier of ["READ", "WRITE", "AUTH", "AI"] as RateTier[]) {
        expect(DEFAULT_RATE_TIERS[tier].limit).toBeGreaterThan(0);
        expect(DEFAULT_RATE_TIERS[tier].windowMs).toBeGreaterThan(0);
      }
      // auth is the tightest tier by default
      expect(DEFAULT_RATE_TIERS.AUTH.limit).toBeLessThan(
        DEFAULT_RATE_TIERS.READ.limit,
      );
    });

    it("applies the tier's policy in the structured result", () => {
      const limiter = new RateLimiter({ AUTH: { limit: 2, windowMs: 60_000 } });
      const first = limiter.hit({ key: "u", tier: "AUTH", now: 0 });
      expect(first).toEqual({
        allowed: true,
        remaining: 1,
        retryAfterMs: 0,
        limit: 2,
        resetAt: 60_000,
      });
      limiter.hit({ key: "u", tier: "AUTH", now: 10 });
      const denied = limiter.hit({ key: "u", tier: "AUTH", now: 20 });
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBe(59_980); // oldest hit@0 expires at 60000, denied at 20
    });

    it("keeps per-tier counters independent for the same key", () => {
      const limiter = new RateLimiter({ AUTH: { limit: 2, windowMs: 60_000 } });
      expect(limiter.hit({ key: "u", tier: "AUTH", now: 0 }).allowed).toBe(true);
      expect(limiter.hit({ key: "u", tier: "AUTH", now: 0 }).allowed).toBe(true);
      expect(limiter.hit({ key: "u", tier: "AUTH", now: 0 }).allowed).toBe(
        false,
      );
      // same key, different tier → untouched budget with its own policy
      const read = limiter.hit({ key: "u", tier: "READ", now: 0 });
      expect(read.allowed).toBe(true);
      expect(read.limit).toBe(DEFAULT_RATE_TIERS.READ.limit);
      expect(read.remaining).toBe(DEFAULT_RATE_TIERS.READ.limit - 1);
    });

    it("defaults to the shared tier table when no overrides are given", () => {
      const limiter = new RateLimiter();
      const ai = limiter.hit({ key: "u", tier: "AI", now: 0 });
      expect(ai.limit).toBe(DEFAULT_RATE_TIERS.AI.limit);
    });
  });

  describe("pruneExpired", () => {
    it("removes stale keys but keeps live ones", () => {
      const state: SlidingState = new Map([
        ["stale", { hits: [0, 50], windowMs: 1000 }],
        ["live", { hits: [900], windowMs: 1000 }],
        ["mixed", { hits: [100, 950], windowMs: 1000 }],
      ]);
      const removed = pruneExpired(state, 1100, 1000); // cutoff = 100
      expect(removed).toBe(1);
      expect(state.has("stale")).toBe(false);
      expect(state.get("live")?.hits).toEqual([900]);
      expect(state.get("mixed")?.hits).toEqual([950]);
    });

    it("uses per-entry windows when no explicit windowMs is passed", () => {
      const state: SlidingState = new Map([
        ["short", { hits: [500], windowMs: 1000 }],
        ["long", { hits: [500], windowMs: 5000 }],
      ]);
      expect(pruneExpired(state, 1500)).toBe(1); // cutoff = 500 each
      expect(state.has("short")).toBe(false); // 500 <= 500 → gone
      expect(state.get("long")?.hits).toEqual([500]); // 500 > -3500 → kept
    });

    it("lets the limiter prune its own state so the map stays bounded", () => {
      const limiter = new RateLimiter({ READ: { limit: 10, windowMs: 1000 } });
      limiter.hit({ key: "old", tier: "READ", now: 0 });
      limiter.hit({ key: "new", tier: "READ", now: 900 });
      expect(limiter.size()).toBe(2);
      expect(limiter.prune(1050)).toBe(1); // old's hit@0 expired (0 <= 50)
      expect(limiter.size()).toBe(1);
      // pruning fully frees the key: next hit starts from a clean window
      expect(limiter.hit({ key: "old", tier: "READ", now: 1050 })).toEqual({
        allowed: true,
        remaining: 9,
        retryAfterMs: 0,
        limit: 10,
        resetAt: 2050,
      });
    });

    it("clears everything via limiter.reset()", () => {
      const limiter = new RateLimiter();
      limiter.slidingHit("k", 0, { limit: 1, windowMs: 1000 });
      expect(limiter.size()).toBe(1);
      limiter.reset();
      expect(limiter.size()).toBe(0);
      expect(limiter.slidingHit("k", 0, { limit: 1, windowMs: 1000 }).allowed).toBe(
        true,
      );
    });
  });
});
