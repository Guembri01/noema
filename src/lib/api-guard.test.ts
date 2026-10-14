import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit } from "@/lib/api-guard";
import { resetRateLimits } from "@/lib/rate-limit";

const req = (headers?: Record<string, string>) =>
  new Request("http://localhost/api", { headers });

describe("api-guard rateLimit()", () => {
  beforeEach(() => resetRateLimits());

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

  it("keeps independent budgets per client ip", () => {
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
});
