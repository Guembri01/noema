import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatList,
  formatNumber,
  formatRelativeTime,
  pluralize,
} from "./i18n-format";

/**
 * §16 i18n — locale-aware formatting helpers.
 *
 * The translation layer (`i18n.ts`) turns keys into words; this pins the
 * `Intl`-backed formatters that turn *values* into words — numbers, relative
 * times, plurals, lists and file sizes — without pulling a dependency for it.
 *
 * Every case is deterministic: fixed locales, fixed numbers and fixed dates
 * (never the wall clock), and the fallbacks for junk input are assertions in
 * their own right because a formatter that throws in a render path is a bug.
 *
 * Red-first: this file failed to import before `i18n-format.ts` existed.
 */

const BASE = new Date("2026-05-09T12:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A date `ms` away from the fixed base (never `Date + number`). */
const at = (ms: number): Date => new Date(BASE.getTime() + ms);

describe("formatNumber", () => {
  it("groups and separates according to the locale", () => {
    expect(formatNumber(1234567.891, "en-US")).toBe("1,234,567.891");
    expect(formatNumber(1234567.891, "de-DE")).toBe("1.234.567,891");
  });

  it("passes Intl number options through", () => {
    expect(formatNumber(0.25, "en-US", { style: "percent" })).toBe("25%");
    expect(
      formatNumber(1234.5, "en-US", { style: "currency", currency: "USD" }),
    ).toBe("$1,234.50");
  });

  it("falls back to English for an unusable locale", () => {
    expect(formatNumber(1234.5, "!!!")).toBe("1,234.5");
  });

  it("drops options that Intl rejects instead of throwing", () => {
    // `currency` style without a currency code is a range error.
    expect(formatNumber(1234.5, "de-DE", { style: "currency" })).toBe("1.234,5");
  });

  it("never throws on non-finite values", () => {
    expect(formatNumber(Number.NaN, "en-US")).toBe("NaN");
    expect(formatNumber(Number.POSITIVE_INFINITY, "en-US")).toBe("Infinity");
  });
});

describe("formatRelativeTime", () => {
  it("renders the present as now", () => {
    expect(formatRelativeTime(BASE, { base: BASE, locale: "en" })).toBe("now");
  });

  it("buckets the recent past into seconds, minutes and hours", () => {
    expect(formatRelativeTime(at(-30 * SECOND), { base: BASE, locale: "en" })).toBe(
      "30 seconds ago",
    );
    expect(formatRelativeTime(at(-5 * MINUTE), { base: BASE, locale: "en" })).toBe(
      "5 minutes ago",
    );
    expect(formatRelativeTime(at(-3 * HOUR), { base: BASE, locale: "en" })).toBe(
      "3 hours ago",
    );
  });

  it("uses auto wording for +/- one day", () => {
    expect(formatRelativeTime(at(-DAY), { base: BASE, locale: "en" })).toBe(
      "yesterday",
    );
    expect(formatRelativeTime(at(DAY), { base: BASE, locale: "en" })).toBe(
      "tomorrow",
    );
  });

  it("renders multi-day, month and year buckets in both directions", () => {
    expect(formatRelativeTime(at(-2 * DAY), { base: BASE, locale: "en" })).toBe(
      "2 days ago",
    );
    expect(formatRelativeTime(at(2 * DAY), { base: BASE, locale: "en" })).toBe(
      "in 2 days",
    );
    expect(formatRelativeTime(at(-40 * DAY), { base: BASE, locale: "en" })).toBe(
      "last month",
    );
    expect(formatRelativeTime(at(-90 * DAY), { base: BASE, locale: "en" })).toBe(
      "3 months ago",
    );
    expect(formatRelativeTime(at(730 * DAY), { base: BASE, locale: "en" })).toBe(
      "in 2 years",
    );
  });

  it("localises the wording", () => {
    expect(formatRelativeTime(at(-2 * DAY), { base: BASE, locale: "fr" })).toBe(
      "avant-hier",
    );
  });

  it("accepts a numeric timestamp for both ends", () => {
    expect(formatRelativeTime(at(2 * DAY).getTime(), { base: BASE.getTime() })).toBe(
      "in 2 days",
    );
  });

  it("returns an empty string for an invalid date and falls back for a bad locale", () => {
    expect(formatRelativeTime("not a date", { base: BASE, locale: "en" })).toBe("");
    expect(formatRelativeTime(at(-3 * DAY), { base: BASE, locale: "!!!" })).toBe(
      "3 days ago",
    );
  });
});

describe("pluralize", () => {
  const files = { one: "{count} file", other: "{count} files" };

  it("selects the form with Intl.PluralRules", () => {
    expect(pluralize(1, files, "en")).toBe("1 file");
    expect(pluralize(3, files, "en")).toBe("3 files");
    expect(pluralize(0, files, "en")).toBe("0 files");
  });

  it("interpolates the {n} alias too", () => {
    expect(pluralize(5, { one: "{n} file", other: "{n} files" }, "en")).toBe(
      "5 files",
    );
  });

  it("honours an explicit zero form", () => {
    expect(pluralize(0, { ...files, zero: "No files" }, "en")).toBe("No files");
  });

  it("follows locale rules — French counts zero as singular", () => {
    const fr = { one: "{n} fichier", other: "{n} fichiers" };
    expect(pluralize(0, fr, "fr")).toBe("0 fichier");
    expect(pluralize(2, fr, "fr")).toBe("2 fichiers");
  });

  it("falls back to other for categories it was not given", () => {
    // Arabic selects the "two" category for 2; only one/other are supplied.
    expect(pluralize(2, { one: "ملف", other: "{n} ملفات" }, "ar")).toBe("2 ملفات");
  });

  it("treats a non-finite count as zero and survives a bad locale", () => {
    expect(pluralize(Number.NaN, files, "en")).toBe("0 files");
    expect(pluralize(1, files, "!!!")).toBe("1 file");
  });
});

describe("formatList", () => {
  it("joins with a conjunction in the locale", () => {
    expect(formatList(["a", "b", "c"], "en")).toBe("a, b, and c");
    expect(formatList(["a", "b"], "en")).toBe("a and b");
    expect(formatList(["a"], "en")).toBe("a");
    expect(formatList([], "en")).toBe("");
  });

  it("uses the locale's conjunction", () => {
    expect(formatList(["a", "b", "c"], "fr")).toBe("a, b et c");
  });

  it("falls back to English for a bad locale and to a comma for a non-array", () => {
    expect(formatList(["a", "b", "c"], "!!!")).toBe("a, b, and c");
    expect(formatList(undefined as unknown as string[], "en")).toBe("");
  });
});

describe("formatBytes", () => {
  it("renders bytes and binary units with a trimmed fraction", () => {
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(1024, "en")).toBe("1 KB");
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 2, "en")).toBe("5 MB");
    expect(formatBytes(2 * 1024 ** 3, "en")).toBe("2 GB");
  });

  it("localises the numeric part", () => {
    expect(formatBytes(1234567, "de-DE")).toBe("1,2 MB");
    expect(formatBytes(1536, "fr")).toBe("1,5 KB");
  });

  it("never throws on unusable input", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
    expect(formatBytes(-1, "en")).toBe("0 B");
    expect(formatBytes(Number.NaN, "en")).toBe("0 B");
    expect(formatBytes(1536, "!!!")).toBe("1.5 KB");
  });
});
