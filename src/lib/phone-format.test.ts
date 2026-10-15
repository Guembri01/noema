import { describe, expect, it } from "vitest";
import {
  formatPhone,
  isValidPhone,
  normalizePhone,
  parsePhone,
  stripPhone,
} from "@/lib/phone-format";

/**
 * Phone number helpers.
 *
 * Pure and defensive: best-effort normalization to an E.164-ish `+digits`
 * form, E.164 validation, a couple of country-aware presentation groupings
 * (US/GB/FR/DE/IN) and small decomposition helpers. Nothing here performs
 * network lookups and no input ever throws.
 */

describe("normalizePhone", () => {
  it("keeps an explicit international number and strips separators", () => {
    expect(normalizePhone("+1 (415) 555-2671")).toBe("+14155552671");
    expect(normalizePhone("  +44 20 7946 0958 ")).toBe("+442079460958");
  });

  it("treats a leading 00 as the international prefix", () => {
    expect(normalizePhone("00 44 20 7946 0958")).toBe("+442079460958");
  });

  it("prepends the default country calling code for national input", () => {
    expect(normalizePhone("(415) 555-2671", { defaultCountry: "US" })).toBe(
      "+14155552671",
    );
    expect(normalizePhone("4155552671", { defaultCountry: "us" })).toBe(
      "+14155552671",
    );
  });

  it("drops the national trunk zero for trunk-prefixed countries", () => {
    expect(normalizePhone("020 7946 0958", { defaultCountry: "GB" })).toBe(
      "+442079460958",
    );
    expect(normalizePhone("01 23 45 67 89", { defaultCountry: "FR" })).toBe(
      "+33123456789",
    );
    expect(normalizePhone("030 123456", { defaultCountry: "DE" })).toBe(
      "+4930123456",
    );
    expect(normalizePhone("098765 43210", { defaultCountry: "IN" })).toBe(
      "+919876543210",
    );
  });

  it("is best-effort and never throws on junk", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("   ")).toBe("");
    expect(normalizePhone("not a phone")).toBe("");
    expect(normalizePhone("415-555-2671")).toBe("+4155552671");
    expect(normalizePhone("020 7946 0958", { defaultCountry: "ZZ" })).toBe(
      "+02079460958",
    );
  });
});

describe("isValidPhone", () => {
  it("accepts plausible E.164 numbers", () => {
    expect(isValidPhone("+14155552671")).toBe(true);
    expect(isValidPhone("+442079460958")).toBe(true);
    expect(isValidPhone("(415) 555-2671", { defaultCountry: "US" })).toBe(true);
  });

  it("rejects malformed or implausible numbers", () => {
    expect(isValidPhone("")).toBe(false);
    expect(isValidPhone("not a phone")).toBe(false);
    expect(isValidPhone("+0123456789")).toBe(false);
    expect(isValidPhone("+1234567")).toBe(false);
    expect(isValidPhone("+1234567890123456789")).toBe(false);
  });
});

describe("formatPhone", () => {
  it("groups US numbers for the international and national styles", () => {
    expect(formatPhone("+14155552671")).toBe("+1 415 555 2671");
    expect(formatPhone("+14155552671", { style: "national" })).toBe(
      "(415) 555-2671",
    );
  });

  it("groups GB, FR, DE and IN numbers", () => {
    expect(formatPhone("+442079460958")).toBe("+44 20 7946 0958");
    expect(formatPhone("+442079460958", { style: "national" })).toBe(
      "020 7946 0958",
    );
    expect(formatPhone("+33123456789")).toBe("+33 1 23 45 67 89");
    expect(formatPhone("+33123456789", { style: "national" })).toBe(
      "01 23 45 67 89",
    );
    expect(formatPhone("+4930123456")).toBe("+49 30 123 456");
    expect(formatPhone("+4930123456", { style: "national" })).toBe(
      "030 123 456",
    );
    expect(formatPhone("+919876543210")).toBe("+91 98765 43210");
    expect(formatPhone("+919876543210", { style: "national" })).toBe(
      "098765 43210",
    );
  });

  it("falls back gracefully for unknown country codes", () => {
    expect(formatPhone("+358401234567")).toBe("+358401234567");
    expect(formatPhone("")).toBe("");
  });
});

describe("parsePhone", () => {
  it("splits the calling code from the national number", () => {
    expect(parsePhone("+14155552671")).toEqual({
      countryCode: "+1",
      national: "4155552671",
    });
    expect(parsePhone("+442079460958")).toEqual({
      countryCode: "+44",
      national: "2079460958",
    });
  });

  it("normalizes national input before splitting", () => {
    expect(parsePhone("(415) 555-2671", { defaultCountry: "US" })).toEqual({
      countryCode: "+1",
      national: "4155552671",
    });
  });

  it("reports no country code when the prefix is unknown", () => {
    expect(parsePhone("+358401234567")).toEqual({ national: "358401234567" });
    expect(parsePhone("")).toEqual({ national: "" });
  });
});

describe("stripPhone", () => {
  it("keeps only the digits", () => {
    expect(stripPhone("+1 (415) 555-2671")).toBe("14155552671");
    expect(stripPhone("+44 20 7946 0958")).toBe("442079460958");
    expect(stripPhone("not a phone")).toBe("");
  });
});
