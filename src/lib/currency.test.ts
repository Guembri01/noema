import { describe, expect, it } from "vitest";
import {
  CURRENCIES,
  currencyInfo,
  formatCurrency,
  isCurrencyCode,
  minorUnits,
  parseAmount,
} from "./currency";

/**
 * Currency support — a curated ISO-4217 subset plus pure helpers for
 * validating a code, looking one up, formatting an amount with `Intl`, parsing
 * user/CSV input back to a number and reporting the currency's minor units.
 *
 * Companion to `i18n-format.ts`: that module formats plain numbers; this one
 * owns the *money* rules (which codes exist, how many decimals each has, and
 * how to round/parse against them). Unknown codes fall back to USD so callers
 * never have to null-check, and no function throws on junk input.
 *
 * Red-first: this file failed to import before `currency.ts` existed.
 */

/** Non-breaking space `Intl` inserts in the `de-DE` currency pattern. */
const NBSP = "\u00a0";

describe("CURRENCIES", () => {
  it("is a non-empty, well-formed subset of ISO 4217", () => {
    expect(CURRENCIES.length).toBeGreaterThan(20);
    for (const entry of CURRENCIES) {
      expect(entry.code).toMatch(/^[A-Z]{3}$/);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.symbol.length).toBeGreaterThan(0);
      expect([0, 2, 3]).toContain(entry.decimals);
    }
  });

  it("contains no duplicate codes", () => {
    const codes = CURRENCIES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("carries the expected decimals for 2-, 0- and 3-decimal currencies", () => {
    expect(currencyInfo("USD").decimals).toBe(2);
    expect(currencyInfo("EUR").decimals).toBe(2);
    expect(currencyInfo("JPY").decimals).toBe(0);
    expect(currencyInfo("KWD").decimals).toBe(3);
  });
});

describe("isCurrencyCode", () => {
  it("accepts known codes case-insensitively, ignoring surrounding space", () => {
    expect(isCurrencyCode("USD")).toBe(true);
    expect(isCurrencyCode("eur")).toBe(true);
    expect(isCurrencyCode("  jpy  ")).toBe(true);
    expect(isCurrencyCode("KWD")).toBe(true);
  });

  it("rejects unknown codes, malformed strings and non-strings", () => {
    expect(isCurrencyCode("XYZ")).toBe(false);
    expect(isCurrencyCode("US")).toBe(false);
    expect(isCurrencyCode("")).toBe(false);
    expect(isCurrencyCode(null)).toBe(false);
    expect(isCurrencyCode(undefined)).toBe(false);
    expect(isCurrencyCode(123)).toBe(false);
    expect(isCurrencyCode({ code: "USD" })).toBe(false);
  });
});

describe("currencyInfo", () => {
  it("returns the registry entry for a known code", () => {
    expect(currencyInfo("USD")).toEqual({
      code: "USD",
      name: "US Dollar",
      symbol: "$",
      decimals: 2,
    });
    expect(currencyInfo("jpy").code).toBe("JPY");
  });

  it("falls back to USD for unknown codes and non-strings", () => {
    expect(currencyInfo("ZZZ")).toEqual(currencyInfo("USD"));
    expect(currencyInfo(null).code).toBe("USD");
    expect(currencyInfo(42).code).toBe("USD");
  });
});

describe("minorUnits", () => {
  it("reports how many minor units make one major unit", () => {
    expect(minorUnits("USD")).toBe(100);
    expect(minorUnits("JPY")).toBe(1);
    expect(minorUnits("KWD")).toBe(1000);
  });

  it("falls back to the USD scale for an unknown code", () => {
    expect(minorUnits("ZZZ")).toBe(100);
    expect(minorUnits(undefined)).toBe(100);
  });
});

describe("formatCurrency", () => {
  it("renders the symbol, grouping and the currency's decimals", () => {
    expect(formatCurrency(1234.56, "USD", "en-US")).toBe("$1,234.56");
    expect(formatCurrency(1234.56, "GBP", "en-GB")).toBe("£1,234.56");
    expect(formatCurrency(1234.56, "JPY", "en-US")).toBe("¥1,235");
  });

  it("localises the grouping and symbol placement", () => {
    expect(formatCurrency(1234.56, "EUR", "de-DE")).toBe(`1.234,56${NBSP}€`);
    expect(formatCurrency(1234.56, "USD", "de-DE")).toBe(`1.234,56${NBSP}$`);
  });

  it("handles zero and negative amounts", () => {
    expect(formatCurrency(0, "USD", "en-US")).toBe("$0.00");
    expect(formatCurrency(-5, "USD", "en-US")).toBe("-$5.00");
  });

  it("falls back to USD for an unknown code and to English for a bad locale", () => {
    expect(formatCurrency(12.5, "ZZZ", "en-US")).toBe("$12.50");
    expect(formatCurrency(12.5, "USD", "!!!")).toBe("$12.50");
  });

  it("never throws on non-finite amounts", () => {
    expect(formatCurrency(Number.NaN, "USD", "en-US")).toBe("$NaN");
    expect(formatCurrency(Number.POSITIVE_INFINITY, "USD", "en-US")).toBe("$∞");
  });
});

describe("parseAmount", () => {
  it("passes finite numbers through, rounded to the currency's decimals", () => {
    expect(parseAmount(12.5, "USD")).toBe(12.5);
    expect(parseAmount(12.567, "USD")).toBe(12.57);
    expect(parseAmount(12.567, "JPY")).toBe(13);
  });

  it("parses plain and grouped numeric strings", () => {
    expect(parseAmount("1234.56", "USD")).toBe(1234.56);
    expect(parseAmount("1,234,567", "USD")).toBe(1234567);
    expect(parseAmount("$1,234.56", "USD")).toBe(1234.56);
  });

  it("understands both decimal-comma and decimal-dot layouts", () => {
    expect(parseAmount("1.234,56", "EUR")).toBe(1234.56);
    expect(parseAmount("12,50", "EUR")).toBe(12.5);
    expect(parseAmount("1.234.567", "EUR")).toBe(1234567);
  });

  it("round-trips what formatCurrency produced", () => {
    expect(parseAmount(formatCurrency(1234.56, "USD", "en-US"), "USD")).toBe(1234.56);
    expect(parseAmount(formatCurrency(1234.56, "EUR", "de-DE"), "EUR")).toBe(1234.56);
    expect(parseAmount(formatCurrency(1234.56, "JPY", "en-US"), "JPY")).toBe(1235);
  });

  it("strips the currency code and symbol in either position", () => {
    expect(parseAmount("USD 1234.56", "USD")).toBe(1234.56);
    expect(parseAmount("¥1,235", "JPY")).toBe(1235);
  });

  it("handles signs, parentheses and 3-decimal rounding", () => {
    expect(parseAmount("-$5.00", "USD")).toBe(-5);
    expect(parseAmount("(5.00)", "USD")).toBe(-5);
    expect(parseAmount("1.2345", "KWD")).toBe(1.235);
  });

  it("returns NaN for empty, non-numeric or code-only input", () => {
    expect(Number.isNaN(parseAmount("", "USD"))).toBe(true);
    expect(Number.isNaN(parseAmount("abc", "USD"))).toBe(true);
    expect(Number.isNaN(parseAmount("USD", "USD"))).toBe(true);
    expect(Number.isNaN(parseAmount(null, "USD"))).toBe(true);
    expect(Number.isNaN(parseAmount(Number.NaN, "USD"))).toBe(true);
  });
});
