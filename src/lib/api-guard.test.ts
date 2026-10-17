import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rateLimit } from "@/lib/api-guard";
import {
  rateLimitBucketCount,
  resetRateLimits,
  userRateLimitBucketCount,
} from "@/lib/rate-limit";

const req = (headers?: Record<string, string>) =>
  new Request("http://localhost/api", { headers });

describe("api-guard rateLimit()", () => {
  beforeEach(() => resetRateLimits());
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_HOPS;
  });

  it("returns null (pass-through) while under the limit", () => {
    expect(rateLimit(req({ "x-forwarded-for": "1.1.1.1" }), "t-under", 2)).toBe(
      null,
    );
    expect(rateLimit(req({ "x-forwarded-for": "1.1.1.1" }), "t-under", 2)).toBe(
      null,
    );
  });

  it("uses the default budget of 120 per window", () => {
    expect(rateLimit(req({ "x-forwarded-for": "1.1.1.2" }), "t-default")).toBe(
      null,
    );
  });

  it("returns a 429 with a bounded retry-after header once over the limit", async () => {
    expect(
      rateLimit(req({ "x-forwarded-for": "2.2.2.2" }), "t-429", 1, 60_000),
    ).toBe(null);
    const res = rateLimit(
      req({ "x-forwarded-for": "2.2.2.2" }),
      "t-429",
      1,
      60_000,
    );
    expect(res).not.toBeNull();
    expect(res?.status).toBe(429);
    await expect(res?.json()).resolves.toEqual({
      error: "Rate limit exceeded",
    });
    const retryAfter = Number(res?.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("keeps independent budgets per client ip when a proxy is trusted", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(
      rateLimit(req({ "x-forwarded-for": "3.3.3.3" }), "t-ip", 1, 60_000),
    ).toBe(null);
    expect(
      rateLimit(req({ "x-forwarded-for": "3.3.3.3" }), "t-ip", 1, 60_000),
    ).not.toBeNull();
    expect(
      rateLimit(req({ "x-forwarded-for": "4.4.4.4" }), "t-ip", 1, 60_000),
    ).toBe(null);
  });

  it("keeps independent budgets per scope", () => {
    expect(
      rateLimit(req({ "x-forwarded-for": "5.5.5.5" }), "t-scope-a", 1, 60_000),
    ).toBe(null);
    expect(
      rateLimit(req({ "x-forwarded-for": "5.5.5.5" }), "t-scope-a", 1, 60_000),
    ).not.toBeNull();
    expect(
      rateLimit(req({ "x-forwarded-for": "5.5.5.5" }), "t-scope-b", 1, 60_000),
    ).toBe(null);
  });

  it("shares one fallback budget for callers without forwarding headers", () => {
    expect(rateLimit(req(), "t-local", 1, 60_000)).toBe(null);
    expect(rateLimit(req(), "t-local", 1, 60_000)).not.toBeNull();
    expect(rateLimit(req({}), "t-local", 1, 60_000)).not.toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * B12 — a spoofed forwarding header must not buy a fresh budget.
   * ---------------------------------------------------------------- */

  it("does not let a spoofed x-forwarded-for buy a fresh budget", () => {
    expect(
      rateLimit(req({ "x-forwarded-for": "10.0.0.1" }), "t-spoof", 1, 60_000),
    ).toBe(null);
    expect(
      rateLimit(req({ "x-forwarded-for": "10.0.0.2" }), "t-spoof", 1, 60_000),
    ).not.toBeNull();
    expect(
      rateLimit(req({ "x-forwarded-for": "10.0.0.3" }), "t-spoof", 1, 60_000),
    ).not.toBeNull();
  });

  it("enforces a per-user budget that a spoofed ip cannot dodge", () => {
    // A trusted proxy gives every request its own client-IP bucket …
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(
      rateLimit(req({ "x-forwarded-for": "10.0.0.1" }), "t-user", 1, 60_000, {
        userId: "u-1",
      }),
    ).toBe(null);
    // … but the user id comes from the session, so rotating the (spoofed) ip
    // does not buy a fresh allowance. Every call uses a *different* ip, so
    // the client-IP budget can never be the reason for the 429 — only the
    // per-user budget can be.
    expect(
      rateLimit(req({ "x-forwarded-for": "10.0.0.2" }), "t-user", 1, 60_000, {
        userId: "u-1",
      }),
    ).not.toBeNull();
    // Another user has its own budget.
    expect(
      rateLimit(req({ "x-forwarded-for": "10.0.0.3" }), "t-user", 1, 60_000, {
        userId: "u-2",
      }),
    ).toBe(null);
  });

  it("checks the per-user budget before the client-ip budget", () => {
    // The user budget is the one a caller cannot dodge, so it is the binding
    // one: it is checked first and a request it blocks never opens a fresh
    // client-IP bucket. Otherwise a caller that rotates its (spoofed) ip
    // would fill the bucket store with entries it never gets to use.
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(
      rateLimit(req({ "x-forwarded-for": "10.1.0.1" }), "t-order", 1, 60_000, {
        userId: "u-1",
      }),
    ).toBe(null);
    // The account budget is spent: the request is refused …
    expect(
      rateLimit(req({ "x-forwarded-for": "10.1.0.2" }), "t-order", 1, 60_000, {
        userId: "u-1",
      }),
    ).not.toBeNull();
    // … and the refused request created no client-IP bucket: the address store
    // holds the ip bucket of the first call only — the ip of the refused
    // request never made it in.
    expect(rateLimitBucketCount()).toBe(1);
    // The per-user budget lives in its own store and holds the user bucket.
    expect(userRateLimitBucketCount()).toBe(1);
    // The other user's request still gets its own allowance.
    expect(
      rateLimit(req({ "x-forwarded-for": "10.1.0.3" }), "t-order", 1, 60_000, {
        userId: "u-2",
      }),
    ).toBe(null);
  });

  /* ---------------------------------------------------------------- *
   * B12 round 2 — the per-user budget must survive a key-space flood.
   * ---------------------------------------------------------------- */

  it("keeps the per-user budget when a flood of forged addresses fills the address store", () => {
    // A trusted proxy gives every request its own client-IP bucket, so the
    // address key space is one an unauthenticated caller controls.
    process.env.TRUSTED_PROXY_HOPS = "1";
    const victim = req({ "x-forwarded-for": "192.0.2.1" });

    // The victim spends its per-user budget …
    expect(rateLimit(victim, "t-flood", 1, 60_000, { userId: "u-1" })).toBe(null);
    // … and is refused from then on.
    expect(
      rateLimit(victim, "t-flood", 1, 60_000, { userId: "u-1" }),
    ).not.toBeNull();

    // The attacker floods the *address* store with 10 000 distinct (forged)
    // client addresses — one bucket each. This is enough to fill the store
    // and evict its oldest entries.
    for (let i = 0; i < 10_000; i += 1) {
      const ip = `10.${Math.floor(i / 256)}.${i % 256}.1`;
      rateLimit(req({ "x-forwarded-for": ip }), "t-flood", 100_000, 60_000);
    }
    expect(rateLimitBucketCount()).toBe(10_000);

    // The victim's budget must still be spent: the flood must not reset the
    // budget that cannot be spoofed. (Before the fix the victim's user bucket
    // was the oldest key in the shared store and the flood evicted it — the
    // request below was answered 200 instead of 429.)
    const after = rateLimit(victim, "t-flood", 1, 60_000, { userId: "u-1" });
    expect(after).not.toBeNull();
    expect(after?.status).toBe(429);
  });
});
