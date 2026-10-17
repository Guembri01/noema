/**
 * Locale-aware value formatting.
 *
 * `i18n.ts` turns translation *keys* into words; this module turns *values*
 * into words — numbers, relative times, plurals, lists and file sizes — using
 * the platform `Intl` objects so nothing here needs a formatting dependency.
 *
 *   • `formatNumber(value, locale?, opts?)`                  — `Intl.NumberFormat`
 *   • `formatRelativeTime(date, { base?, locale? })`         — `Intl.RelativeTimeFormat`
 *   • `pluralize(count, { one, other, zero? }, locale?)`     — `Intl.PluralRules`
 *   • `formatList(items, locale?)`                           — `Intl.ListFormat`
 *   • `formatBytes(n, locale?)`                              — `Intl.NumberFormat`
 *
 * The guiding rule is that a formatter is called inside render paths, so it
 * must never throw: an unusable locale, a non-finite number, an invalid date
 * or options `Intl` rejects all fall back to a stable, English-ish result or
 * the input's own text rather than propagating an exception.
 */

/** Relative-time units this module buckets into. */
type RelativeUnit = "second" | "minute" | "hour" | "day" | "month" | "year";

/**
 * How much room the phrase gets. `"long"` (the default) reads
 * `"5 minutes ago"`; `"compact"` trades words for space — `"5m ago"` — for a
 * status bar or a footer. Both come from the same `Intl.RelativeTimeFormat`,
 * so there is no second implementation to drift.
 */
export type RelativeTimeStyle = "long" | "compact";

/** Options for {@link formatRelativeTime}. */
export type RelativeTimeOptions = {
  /** Reference instant. Defaults to now; pass a fixed value in tests. */
  base?: Date | number | string;
  /** BCP-47 locale. Unusable values fall back to English. */
  locale?: string;
  /** Output shape. Defaults to `"long"`. */
  style?: RelativeTimeStyle;
};

/**
 * Forms for {@link pluralize}. `one` and `other` are required; `zero` is an
 * explicit override for a count of exactly `0` (English normally uses `other`
 * for zero, and some locales use `one`).
 */
export type PluralForms = {
  one: string;
  other: string;
  zero?: string;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** A usable, trimmed locale tag, or `"en"` when the caller gave nothing. */
function normalizeLocale(locale?: string): string {
  return typeof locale === "string" && locale.trim() !== "" ? locale.trim() : "en";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Parse a `Date | number | string` into a valid `Date`, or `null`. */
function toDate(value: Date | number | string | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value) : null;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Build an `Intl.NumberFormat`, shedding whatever `Intl` rejects: first the
 * requested locale + options, then English + options, then the locale without
 * options, then plain English. `null` means even the bare fallback failed.
 */
function pickNumberFormatter(
  locale: string,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat | null {
  try {
    return new Intl.NumberFormat(locale, options);
  } catch {
    /* fall through */
  }
  try {
    return new Intl.NumberFormat("en", options);
  } catch {
    /* fall through */
  }
  try {
    return new Intl.NumberFormat(locale);
  } catch {
    /* fall through */
  }
  try {
    return new Intl.NumberFormat("en");
  } catch {
    return null;
  }
}

/** Format a number for `locale`, honouring any `Intl.NumberFormat` options. */
export function formatNumber(
  value: number,
  locale?: string,
  options?: Intl.NumberFormatOptions,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  const formatter = pickNumberFormatter(normalizeLocale(locale), options);
  return formatter ? formatter.format(value) : String(value);
}

/** Bucket a millisecond delta into a rounded value + `Intl` relative unit. */
function relativeBucket(diff: number): { value: number; unit: RelativeUnit } {
  const abs = Math.abs(diff);
  const sign = diff < 0 ? -1 : 1;
  const round = (unitMs: number) => sign * Math.round(abs / unitMs);

  if (abs < 45 * SECOND) return { value: Math.round(diff / SECOND), unit: "second" };
  if (abs < 90 * SECOND) return { value: sign, unit: "minute" };
  if (abs < 45 * MINUTE) return { value: round(MINUTE), unit: "minute" };
  if (abs < 90 * MINUTE) return { value: sign, unit: "hour" };
  if (abs < 22 * HOUR) return { value: round(HOUR), unit: "hour" };
  if (abs < 36 * HOUR) return { value: sign, unit: "day" };
  if (abs < 25 * DAY) return { value: round(DAY), unit: "day" };
  if (abs < 45 * DAY) return { value: sign, unit: "month" };
  if (abs < 320 * DAY) return { value: round(30 * DAY), unit: "month" };
  if (abs < 548 * DAY) return { value: sign, unit: "year" };
  return { value: round(365 * DAY), unit: "year" };
}

/** Map our two shapes onto the `Intl` `style` option. */
function relativeStyle(style: RelativeTimeStyle | undefined): "long" | "narrow" {
  return style === "compact" ? "narrow" : "long";
}

/**
 * Human relative time between `date` and `base` (default: now), bucketed into
 * seconds/minutes/hours/days/months/years and rendered with auto wording, so
 * `-1 day` reads "yesterday" and `+2 days` reads "in 2 days". Invalid dates
 * return `""`; an unusable locale falls back to English.
 *
 * This is the **single entry point** for relative labels; `humanizeDuration`
 * (`@/lib/duration`) and `describeLastEdited` (`@/lib/last-edited`) delegate
 * here so a page can never read "Edited 3 days ago" in one place and "3d ago"
 * in another. Pass `{ style: "compact" }` when a caller genuinely needs the
 * short form (`"3d ago"`).
 */
export function formatRelativeTime(
  date: Date | number | string,
  options: RelativeTimeOptions = {},
): string {
  const target = toDate(date);
  if (!target) return "";
  const base = toDate(options.base) ?? new Date();
  const { value, unit } = relativeBucket(target.getTime() - base.getTime());
  const locale = normalizeLocale(options.locale);
  const style = relativeStyle(options.style);
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style }).format(value, unit);
  } catch {
    /* unusable locale — fall back to English */
  }
  try {
    return new Intl.RelativeTimeFormat("en", { numeric: "auto", style }).format(value, unit);
  } catch {
    return "";
  }
}

/** Pick a plural category, tolerating a locale `Intl.PluralRules` rejects. */
function pluralCategory(count: number, locale: string): Intl.LDMLPluralRule {
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    try {
      return new Intl.PluralRules("en").select(count);
    } catch {
      return "other";
    }
  }
}

/** Replace the `{count}` / `{n}` placeholders with the count. */
function interpolate(template: string, count: number): string {
  return template.replace(/\{count\}|\{n\}/g, String(count));
}

/**
 * Choose the right form for `count` using `Intl.PluralRules`. Categories the
 * caller did not supply (`two`, `few`, `many`) map to `other`; a provided
 * `zero` wins for a count of exactly `0`, and a non-finite count is treated as
 * `0`. `{count}`/`{n}` in the chosen form are replaced with the count.
 */
export function pluralize(count: number, forms: PluralForms, locale?: string): string {
  const other = forms && isString(forms.other) ? forms.other : "";
  const numeric = typeof count === "number" ? count : Number(count);
  const safeCount = Number.isFinite(numeric) ? numeric : 0;

  let template = other;
  if (forms && safeCount === 0 && isString(forms.zero)) {
    template = forms.zero;
  } else if (forms && pluralCategory(safeCount, normalizeLocale(locale)) === "one") {
    template = isString(forms.one) ? forms.one : other;
  }
  return interpolate(template, safeCount);
}

/**
 * Join items with the locale's list conjunction ("a, b, and c" / "a, b et c").
 * Empty input returns `""`; an unusable locale falls back to English, then to
 * a plain comma join.
 */
export function formatList(items: readonly string[], locale?: string): string {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return "";
  const localeTag = normalizeLocale(locale);
  try {
    return new Intl.ListFormat(localeTag, { style: "long", type: "conjunction" }).format(
      list,
    );
  } catch {
    /* unusable locale — fall back to English */
  }
  try {
    return new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(list);
  } catch {
    return list.join(", ");
  }
}

/**
 * Human-readable byte size in binary units ("1.5 KB", "5 MB"), localising the
 * numeric part. Zero, negative and non-finite sizes collapse to "0 B".
 */
export function formatBytes(n: number, locale?: string): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return `${formatNumber(0, locale)} B`;
  }
  const exponent = Math.min(
    Math.max(0, Math.floor(Math.log(n) / Math.log(1024))),
    BYTE_UNITS.length - 1,
  );
  const value = n / 1024 ** exponent;
  const formatted = formatNumber(value, locale, {
    maximumFractionDigits: exponent === 0 ? 0 : 1,
  });
  return `${formatted} ${BYTE_UNITS[exponent]}`;
}
