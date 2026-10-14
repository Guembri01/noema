import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, clientKey, resetRateLimits } from "@/lib/rate-limit";

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
});
