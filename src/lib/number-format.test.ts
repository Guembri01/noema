import { describe, expect, it } from "vitest";
import {
  DEFAULT_NUMBER_FORMAT,
  describeFormat,
  formatNumberValue,
  parseNumber,
  validateFormatSpec,
  type NumberFormatSpec,
} from "./number-format";

/**
 * Number property formatting (docs/FEATURE_MATRIX.md :274 "Number format";
 * docs/FIX_PLAN.md B17 properties family).
 *
 * `database-query.ts` renders a NUMBER cell with a hard-coded percent/currency
 * branch. This module is the pure, dependency-free core that generalises it:
 * an `Intl.NumberFormat`-backed `spec → string` formatter, a matching
 * `string → number` parser, a fail-safe spec normaliser and a human label.
 *
 * Every case is deterministic: a fixed locale (or none at all, which pins
 * `en-US`) and fixed numbers — never the wall clock. The fallbacks are
 * assertions in their own right, because a formatter that throws in a render
 * path is a bug.
 *
 * Red-first: this file failed to import before `number-format.ts` existed.
 */

describe("DEFAULT_NUMBER_FORMAT & validateFormatSpec", () => {
  it("ships a plain grouped decimal as the default spec", () => {
    expect(DEFAULT_NUMBER_FORMAT).toEqual({ style: "decimal", useGrouping: true });
  });

  it("repairs a missing, non-object or unknown-style spec to the default", () => {
    expect(validateFormatSpec(undefined)).toEqual(DEFAULT_NUMBER_FORMAT);
    expect(validateFormatSpec("nope")).toEqual(DEFAULT_NUMBER_FORMAT);
    expect(validateFormatSpec({ style: "sci" }).style).toBe("decimal");
  });

  it("clamps decimals to a whole number in 0..20 and drops non-numbers", () => {
    expect(validateFormatSpec({ style: "decimal", decimals: -2 }).decimals).toBe(0);
    expect(validateFormatSpec({ style: "decimal", decimals: 99 }).decimals).toBe(20);
    expect(validateFormatSpec({ style: "decimal", decimals: 2.7 }).decimals).toBe(2);
    expect(validateFormatSpec({ style: "decimal", decimals: "2" }).decimals).toBeUndefined();
  });

  it("normalises the currency code and defaults it to USD", () => {
    expect(validateFormatSpec({ style: "currency", currency: "eur" }).currency).toBe("EUR");
    expect(validateFormatSpec({ style: "currency", currency: "dollars" }).currency).toBe("USD");
    expect(validateFormatSpec({ style: "currency" }).currency).toBe("USD");
  });

  it("drops a currency from non-currency styles and coerces useGrouping", () => {
    expect(validateFormatSpec({ style: "percent", currency: "EUR" })).not.toHaveProperty(
      "currency",
    );
    expect(validateFormatSpec({ style: "decimal", useGrouping: false }).useGrouping).toBe(false);
    expect(validateFormatSpec({ style: "decimal", useGrouping: "no" }).useGrouping).toBe(true);
  });
});

describe("formatNumberValue", () => {
  it("groups and separates digits according to the locale", () => {
    expect(formatNumberValue(1234567.891, { style: "decimal" }, "en-US")).toBe(
      "1,234,567.891",
    );
    expect(formatNumberValue(1234567.891, { style: "decimal" }, "de-DE")).toBe(
      "1.234.567,891",
    );
  });

  it("honours the decimals count and an explicit grouping off", () => {
    expect(formatNumberValue(1234.5, { style: "decimal", decimals: 0 }, "en-US")).toBe(
      "1,235",
    );
    expect(formatNumberValue(1234.5, { style: "decimal", decimals: 1 }, "en-US")).toBe(
      "1,234.5",
    );
    expect(
      formatNumberValue(1234567, { style: "decimal", useGrouping: false }, "en-US"),
    ).toBe("1234567");
  });

  it("renders fractions as percents", () => {
    expect(formatNumberValue(0.25, { style: "percent" }, "en-US")).toBe("25%");
    expect(formatNumberValue(0.075, { style: "percent", decimals: 1 }, "en-US")).toBe(
      "7.5%",
    );
  });

  it("renders currency with the requested code and decimals", () => {
    expect(
      formatNumberValue(1234.5, { style: "currency", currency: "USD" }, "en-US"),
    ).toBe("$1,234.50");
    expect(
      formatNumberValue(1234.5, { style: "currency", currency: "EUR" }, "en-US"),
    ).toBe("€1,234.50");
    expect(
      formatNumberValue(
        1234.5,
        { style: "currency", currency: "usd", decimals: 0 },
        "en-US",
      ),
    ).toBe("$1,235");
  });

  it("renders compact notation for large magnitudes", () => {
    expect(formatNumberValue(1200, { style: "compact" }, "en-US")).toBe("1.2K");
    expect(formatNumberValue(2500000000, { style: "compact" }, "en-US")).toBe("2.5B");
    expect(formatNumberValue(999, { style: "compact" }, "en-US")).toBe("999");
  });

  it("falls back to a fixed locale, a default spec and plain text for junk", () => {
    expect(formatNumberValue(1234.5, { style: "decimal" }, "!!!")).toBe("1,234.5");
    expect(formatNumberValue(1234.5, undefined, "en-US")).toBe("1,234.5");
    expect(formatNumberValue(Number.NaN, { style: "decimal" }, "en-US")).toBe("NaN");
    expect(formatNumberValue(Number.POSITIVE_INFINITY, { style: "decimal" }, "en-US")).toBe(
      "Infinity",
    );
  });
});

describe("parseNumber", () => {
  it("strips grouping separators and reads the decimal part", () => {
    expect(parseNumber("1,234.56", { style: "decimal" })).toBe(1234.56);
    expect(parseNumber("1234", { style: "decimal" })).toBe(1234);
  });

  it("understands the swapped separators of a European number", () => {
    expect(parseNumber("1.234,56", { style: "decimal" })).toBe(1234.56);
    expect(parseNumber("1'234.50", { style: "decimal" })).toBe(1234.5);
  });

  it("strips currency symbols, codes and spaces", () => {
    expect(parseNumber("$1,234.50", { style: "currency", currency: "USD" })).toBe(1234.5);
    expect(parseNumber("1 234,50 €", { style: "currency", currency: "EUR" })).toBe(1234.5);
  });

  it("divides a percent back into a fraction", () => {
    expect(parseNumber("7.5%", { style: "percent" })).toBeCloseTo(0.075);
    expect(parseNumber("25%", { style: "percent" })).toBe(0.25);
  });

  it("expands a compact suffix", () => {
    expect(parseNumber("1.2K", { style: "compact" })).toBe(1200);
    expect(parseNumber("2.5B", { style: "compact" })).toBe(2500000000);
  });

  it("reads a leading sign and an accounting (parenthesised) negative", () => {
    expect(parseNumber("-1,234.5", { style: "decimal" })).toBe(-1234.5);
    expect(parseNumber("(1,234.50)", { style: "decimal" })).toBe(-1234.5);
  });

  it("returns NaN for junk and passes a finite number straight through", () => {
    expect(parseNumber("", { style: "decimal" })).toBeNaN();
    expect(parseNumber("abc", { style: "decimal" })).toBeNaN();
    expect(parseNumber(null, { style: "decimal" })).toBeNaN();
    expect(parseNumber(1234.5, { style: "decimal" })).toBe(1234.5);
  });

  it("round-trips what the formatter produced", () => {
    const money = { style: "currency", currency: "USD" } as const;
    expect(parseNumber(formatNumberValue(99.5, money), money)).toBe(99.5);
    const pct: NumberFormatSpec = { style: "percent", decimals: 1 };
    expect(parseNumber(formatNumberValue(0.125, pct), pct)).toBeCloseTo(0.125);
    const compact: NumberFormatSpec = { style: "compact" };
    expect(parseNumber(formatNumberValue(3400, compact), compact)).toBe(3400);
  });
});

describe("describeFormat", () => {
  it("names the default and unknown specs plainly", () => {
    expect(describeFormat(DEFAULT_NUMBER_FORMAT)).toBe("Number");
    expect(describeFormat(undefined)).toBe("Number");
  });

  it("appends the decimals and grouping modifiers", () => {
    expect(describeFormat({ style: "decimal", decimals: 2 })).toBe("Number, 2 decimals");
    expect(describeFormat({ style: "decimal", decimals: 1 })).toBe("Number, 1 decimal");
    expect(describeFormat({ style: "decimal", useGrouping: false })).toBe(
      "Number, no grouping",
    );
  });

  it("names percent, compact and currency styles", () => {
    expect(describeFormat({ style: "percent" })).toBe("Percent");
    expect(describeFormat({ style: "compact" })).toBe("Compact number");
    expect(describeFormat({ style: "currency", currency: "USD" })).toBe("US Dollar (USD)");
    expect(describeFormat({ style: "currency", currency: "gbp" })).toBe(
      "British Pound (GBP)",
    );
    expect(describeFormat({ style: "currency", currency: "XYZ" })).toBe("XYZ");
  });

  it("combines a currency label with its modifiers", () => {
    expect(
      describeFormat({ style: "currency", currency: "EUR", decimals: 0, useGrouping: false }),
    ).toBe("Euro (EUR), 0 decimals, no grouping");
  });
});
