import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_LIFETIME_DAYS,
  customDateToIso,
  presetExpiryIso,
  resolveTokenExpiry,
} from "./api-token-expiry";

const now = new Date("2026-10-26T12:00:00.000Z");

describe("resolveTokenExpiry", () => {
  it("uses the 90-day default when no value is supplied", () => {
    const result = resolveTokenExpiry(undefined, now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.toISOString()).toBe(
        new Date(now.getTime() + DEFAULT_TOKEN_LIFETIME_DAYS * 86400000).toISOString(),
      );
    }
  });

  it("treats null as never expires", () => {
    expect(resolveTokenExpiry(null, now)).toEqual({ ok: true, value: null });
  });

  it("accepts a future custom date", () => {
    const result = resolveTokenExpiry("2026-11-01T00:00:00.000Z", now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("rejects past, invalid and far-future dates", () => {
    expect(resolveTokenExpiry("2026-10-01T00:00:00.000Z", now).ok).toBe(false);
    expect(resolveTokenExpiry("not-a-date", now).ok).toBe(false);
    expect(resolveTokenExpiry("2040-01-01T00:00:00.000Z", now).ok).toBe(false);
  });
});

describe("presetExpiryIso", () => {
  it("maps presets to deadlines", () => {
    expect(presetExpiryIso("7", now)).toBe(
      new Date(now.getTime() + 7 * 86400000).toISOString(),
    );
    expect(presetExpiryIso("never", now)).toBeNull();
    expect(presetExpiryIso("custom", now)).toBeUndefined();
    expect(presetExpiryIso("nope", now)).toBeUndefined();
  });
});

describe("customDateToIso", () => {
  it("accepts a date input and rejects malformed values", () => {
    expect(customDateToIso("2026-11-01")).toMatch(/^2026-11-01T/);
    expect(customDateToIso("2026-11-01T00:00")).toBeNull();
    expect(customDateToIso("")).toBeNull();
  });
});
