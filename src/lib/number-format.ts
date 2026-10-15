/**
 * Number property formatting — pure, dependency-free math for turning a NUMBER
 * property value into a display string and back (docs/FEATURE_MATRIX.md :274
 * "Number format"; docs/FIX_PLAN.md B17 properties family).
 *
 * `database-query.ts` already renders NUMBER cells with a bespoke
 * percent/currency branch; this module is the general core behind it, built on
 * `Intl.NumberFormat` so nothing here needs a formatting dependency:
 *
 *   • `formatNumberValue(value, spec, locale?)` — spec → display string
 *   • `parseNumber(raw, spec)`                  — display string → number
 *   • `validateFormatSpec(spec)`                — untrusted spec → valid spec
 *   • `DEFAULT_NUMBER_FORMAT`                   — a plain grouped decimal
 *   • `describeFormat(spec)`                    — a human label ("US Dollar (USD)")
 *
 * Design rules, matching the rest of `src/lib`:
 *
 * - **Fail-safe by contract.** Stored config round-trips as untrusted JSON and
 *   a formatter is called inside render paths, so nothing here throws: an
 *   unknown style, a bad currency code, a non-finite number or an unusable
 *   locale degrade to a stable English-ish result rather than an exception.
 * - **Deterministic.** The default locale is the app's fixed `en-US`, so the
 *   server and client agree byte-for-byte; tests pass `en-US`/`de-DE` and
 *   never depend on the wall clock.
 * - **Round-trippable.** `parseNumber(formatNumberValue(v, spec), spec)`
 *   returns `v` (to the spec's precision) for every style.
 * - **`percent` stores a fraction.** `0.075` formats as `"7.5%"` and
 *   `"7.5%"` parses back to `0.075` — the same convention as the existing
 *   `database-query.ts` cell renderer.
 * - **`compact` maps to `notation: "compact"`**, not an `Intl` *style*;
 *   grouping and decimals still apply.
 */

/** The four display styles a NUMBER property supports. */
export type NumberFormatStyle = "decimal" | "percent" | "currency" | "compact";

/** A validated-or-untested display spec for a NUMBER property. */
export type NumberFormatSpec = {
  style: NumberFormatStyle;
  /**
   * ISO-4217 code for `style: "currency"` (case-insensitive on input,
   * upper-cased on output). Ignored and omitted for every other style.
   */
  currency?: string;
  /** Fixed fraction digits, clamped to a whole `0..20`. Omit for the `Intl` default. */
  decimals?: number;
  /** Thousands grouping. Defaults to `true`. */
  useGrouping?: boolean;
};

/** The default: a plain decimal with grouping, matching the app's `en-US` cells. */
export const DEFAULT_NUMBER_FORMAT: NumberFormatSpec = {
  style: "decimal",
  useGrouping: true,
};

const STYLES: readonly NumberFormatStyle[] = ["decimal", "percent", "currency", "compact"];
const DEFAULT_CURRENCY = "USD";
const DEFAULT_LOCALE = "en-US";

/** English names for the currencies a workspace is most likely to pick. */
const CURRENCY_NAMES: Record<string, string> = {
  USD: "US Dollar",
  EUR: "Euro",
  GBP: "British Pound",
  JPY: "Japanese Yen",
  CNY: "Chinese Yuan",
  CAD: "Canadian Dollar",
  AUD: "Australian Dollar",
  CHF: "Swiss Franc",
  INR: "Indian Rupee",
  BRL: "Brazilian Real",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStyle(value: unknown): value is NumberFormatStyle {
  return typeof value === "string" && (STYLES as readonly string[]).includes(value);
}

/** A whole, finite number of fraction digits clamped to `Intl`'s `0..20`. */
function normalizeDecimals(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(20, Math.max(0, Math.floor(value)));
}

/** Upper-case a 3-letter currency code, falling back to `USD`. */
function normalizeCurrency(value: unknown): string {
  if (typeof value === "string") {
    const code = value.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code)) return code;
  }
  return DEFAULT_CURRENCY;
}

/**
 * Coerce an untrusted spec into a guaranteed-valid one. Never throws: a
 * non-object, an unknown style, a malformed currency, an out-of-range
 * `decimals` or a non-boolean `useGrouping` are all repaired rather than
 * rejected. `currency` is only carried for `style: "currency"`, and the
 * default locale's grouping is on unless explicitly disabled.
 */
export function validateFormatSpec(spec?: unknown): NumberFormatSpec {
  const raw = isRecord(spec) ? spec : {};
  const style = isStyle(raw.style) ? raw.style : "decimal";
  const decimals = normalizeDecimals(raw.decimals);
  const useGrouping = typeof raw.useGrouping === "boolean" ? raw.useGrouping : true;

  if (style === "currency") {
    return { style, currency: normalizeCurrency(raw.currency), decimals, useGrouping };
  }
  return { style, decimals, useGrouping };
}

function normalizeLocale(locale?: string): string {
  return typeof locale === "string" && locale.trim() !== "" ? locale.trim() : DEFAULT_LOCALE;
}

/** `Intl` fraction options for a fixed `decimals`, or nothing for the default. */
function fractionOptions(decimals: number | undefined): Intl.NumberFormatOptions {
  if (decimals === undefined) return {};
  return { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
}

/** Translate a validated spec into `Intl.NumberFormat` options. */
function toIntlOptions(spec: NumberFormatSpec): Intl.NumberFormatOptions {
  const base = { useGrouping: spec.useGrouping, ...fractionOptions(spec.decimals) };
  switch (spec.style) {
    case "percent":
      return { style: "percent", ...base };
    case "currency":
      return { style: "currency", currency: spec.currency ?? DEFAULT_CURRENCY, ...base };
    case "compact":
      return { notation: "compact", compactDisplay: "short", ...base };
    case "decimal":
    default:
      return { style: "decimal", ...base };
  }
}

/**
 * Build a formatter, shedding whatever `Intl` rejects: first the requested
 * locale + options, then `en-US` + options, then the locale bare, then plain
 * `en-US`. `null` means even the bare fallback failed.
 */
function pickFormatter(
  locale: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat | null {
  try {
    return new Intl.NumberFormat(locale, options);
  } catch {
    /* fall through */
  }
  try {
    return new Intl.NumberFormat(DEFAULT_LOCALE, options);
  } catch {
    /* fall through */
  }
  try {
    return new Intl.NumberFormat(locale);
  } catch {
    /* fall through */
  }
  try {
    return new Intl.NumberFormat(DEFAULT_LOCALE);
  } catch {
    return null;
  }
}

/**
 * Format `value` for display under `spec`. A non-finite value is returned as
 * its own text (`"NaN"` / `"Infinity"`), an unusable locale falls back to
 * `en-US`, and a spec that `Intl` still refuses degrades to `String(value)` —
 * this never throws. The `locale` defaults to `en-US` for server/client parity.
 */
export function formatNumberValue(
  value: number,
  spec?: NumberFormatSpec | null,
  locale?: string,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  const normalized = validateFormatSpec(spec);
  const formatter = pickFormatter(normalizeLocale(locale), toIntlOptions(normalized));
  return formatter ? formatter.format(value) : String(value);
}

/** How many times `char` occurs in `text`. */
function countOf(text: string, char: string): number {
  let count = 0;
  for (const entry of text) if (entry === char) count += 1;
  return count;
}

/**
 * Split separator-and-digit text into integer/fraction digit runs.
 *
 * The rule is deterministic and English-biased, with a European fallback:
 * when both `,` and `.` appear the rightmost is the decimal separator; a lone
 * `.` is decimal, a lone `,` is decimal only when followed by 1–2 digits
 * (otherwise it is grouping), and repeated separators are always grouping.
 * So `"1,234"` → `1234`, `"1.234"` → `1.234`, `"1.234,56"` → `1234.56`.
 */
function splitGrouped(text: string): { int: string; frac: string } {
  const dots = countOf(text, ".");
  const commas = countOf(text, ",");
  if (dots === 0 && commas === 0) return { int: text, frac: "" };

  let decimalIndex = -1;
  if (dots > 0 && commas > 0) {
    decimalIndex = Math.max(text.lastIndexOf("."), text.lastIndexOf(","));
  } else if (commas > 0) {
    if (commas === 1) {
      const index = text.indexOf(",");
      const after = text.length - index - 1;
      if (after >= 1 && after <= 2) decimalIndex = index;
    }
  } else if (dots === 1) {
    decimalIndex = text.indexOf(".");
  }

  if (decimalIndex === -1) {
    return { int: text.replace(/[.,]/g, ""), frac: "" };
  }
  return {
    int: text.slice(0, decimalIndex).replace(/[.,]/g, ""),
    frac: text.slice(decimalIndex + 1).replace(/[.,]/g, ""),
  };
}

const COMPACT_SUFFIX = /([KMBT])\s*$/i;
const COMPACT_FACTOR: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/**
 * Read a stored/typed number back out of its display string. Grouping
 * separators and currency symbols/codes are stripped, a `%` (or a `percent`
 * spec) divides by 100, and a `compact` suffix (`K`/`M`/`B`/`T`) is expanded,
 * so a formatted value round-trips. A finite number passes straight through;
 * `null`, junk or an empty string yields `NaN` (never throws).
 */
export function parseNumber(raw: unknown, spec?: NumberFormatSpec | null): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : Number.NaN;
  if (typeof raw !== "string") return Number.NaN;

  const normalized = validateFormatSpec(spec);
  let text = raw.trim();
  if (text === "") return Number.NaN;

  let multiplier = 1;
  if (normalized.style === "compact") {
    const match = COMPACT_SUFFIX.exec(text);
    if (match) {
      multiplier = COMPACT_FACTOR[match[1].toUpperCase()] ?? 1;
      text = text.slice(0, match.index);
    }
  }

  const isPercent = normalized.style === "percent" || text.includes("%");
  const negative = /^\(.*\)$/.test(text) || /[-−]/.test(text);

  // Keep only digits and separators — this drops spaces, `%`, currency
  // symbols, currency codes and apostrophe grouping in one pass.
  const digits = text.replace(/[^0-9.,]/g, "");
  if (!/[0-9]/.test(digits)) return Number.NaN;

  const { int, frac } = splitGrouped(digits);
  const magnitude = Number(`${int === "" ? "0" : int}.${frac === "" ? "0" : frac}`);
  if (!Number.isFinite(magnitude)) return Number.NaN;

  const signed = negative ? -magnitude : magnitude;
  const scaled = signed * multiplier;
  return isPercent ? scaled / 100 : scaled;
}

/**
 * A short, locale-independent human label for a spec
 * (`"Number, 2 decimals"`, `"US Dollar (USD)"`, `"Compact number"`). Unknown
 * currencies fall back to their bare code; an unusable spec describes as the
 * default `"Number"`.
 */
export function describeFormat(spec?: NumberFormatSpec | null): string {
  const normalized = validateFormatSpec(spec);
  const parts: string[] = [];

  switch (normalized.style) {
    case "percent":
      parts.push("Percent");
      break;
    case "compact":
      parts.push("Compact number");
      break;
    case "currency": {
      const code = normalized.currency ?? DEFAULT_CURRENCY;
      parts.push(CURRENCY_NAMES[code] ? `${CURRENCY_NAMES[code]} (${code})` : code);
      break;
    }
    case "decimal":
    default:
      parts.push("Number");
      break;
  }

  if (normalized.decimals !== undefined) {
    parts.push(normalized.decimals === 1 ? "1 decimal" : `${normalized.decimals} decimals`);
  }
  if (normalized.useGrouping === false) parts.push("no grouping");

  return parts.join(", ");
}
