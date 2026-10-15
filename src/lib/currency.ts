/**
 * Currency support — a curated ISO-4217 subset plus the pure helpers for
 * working with it.
 *
 * `i18n-format.ts` formats plain numbers; this module owns the *money* rules:
 * which codes we ship, how many decimals each has, how to render an amount in
 * a locale, how to parse user/CSV input back to a number, and how many minor
 * units make one major unit.
 *
 * Everything here is pure and dependency-free, and prefers the platform
 * `Intl.NumberFormat` over a hard-coded symbol table. The guiding rule is that
 * these helpers are called in render/import paths, so they never throw: an
 * unknown code falls back to `USD`, an unusable locale falls back to English,
 * and an unparseable amount becomes `NaN` rather than an exception. The
 * fallback is deterministic — `currencyInfo("ZZZ")` is always `USD`.
 */

/** A currency the app recognises. */
export type CurrencyInfo = {
  /** ISO 4217 alphabetic code, uppercase (e.g. `"USD"`). */
  code: string;
  /** Human-readable English name. */
  name: string;
  /** Conventional symbol (e.g. `"$"`, `"€"`); informational, `Intl` does the real work. */
  symbol: string;
  /** ISO 4217 minor-unit digits: `0`, `2` or `3`. */
  decimals: number;
};

/** The fallback currency every unknown code resolves to. */
const FALLBACK: CurrencyInfo = {
  code: "USD",
  name: "US Dollar",
  symbol: "$",
  decimals: 2,
};

/**
 * Curated ISO-4217 subset, USD first. Covers the common 0-, 2- and 3-decimal
 * currencies (JPY/KRW/VND/CLP/ISK have no minor unit; KWD/BHD/OMR/JOD/TND have
 * three) so the picker and imports stay realistic without shipping the whole
 * ISO table.
 */
export const CURRENCIES: readonly CurrencyInfo[] = [
  FALLBACK,
  { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
  { code: "GBP", name: "British Pound", symbol: "£", decimals: 2 },
  { code: "JPY", name: "Japanese Yen", symbol: "¥", decimals: 0 },
  { code: "CNY", name: "Chinese Yuan", symbol: "¥", decimals: 2 },
  { code: "CHF", name: "Swiss Franc", symbol: "CHF", decimals: 2 },
  { code: "CAD", name: "Canadian Dollar", symbol: "CA$", decimals: 2 },
  { code: "AUD", name: "Australian Dollar", symbol: "A$", decimals: 2 },
  { code: "NZD", name: "New Zealand Dollar", symbol: "NZ$", decimals: 2 },
  { code: "INR", name: "Indian Rupee", symbol: "₹", decimals: 2 },
  { code: "BRL", name: "Brazilian Real", symbol: "R$", decimals: 2 },
  { code: "MXN", name: "Mexican Peso", symbol: "MX$", decimals: 2 },
  { code: "KRW", name: "South Korean Won", symbol: "₩", decimals: 0 },
  { code: "SGD", name: "Singapore Dollar", symbol: "S$", decimals: 2 },
  { code: "HKD", name: "Hong Kong Dollar", symbol: "HK$", decimals: 2 },
  { code: "SEK", name: "Swedish Krona", symbol: "kr", decimals: 2 },
  { code: "NOK", name: "Norwegian Krone", symbol: "kr", decimals: 2 },
  { code: "DKK", name: "Danish Krone", symbol: "kr", decimals: 2 },
  { code: "PLN", name: "Polish Zloty", symbol: "zł", decimals: 2 },
  { code: "TRY", name: "Turkish Lira", symbol: "₺", decimals: 2 },
  { code: "RUB", name: "Russian Ruble", symbol: "₽", decimals: 2 },
  { code: "ZAR", name: "South African Rand", symbol: "R", decimals: 2 },
  { code: "AED", name: "UAE Dirham", symbol: "د.إ", decimals: 2 },
  { code: "SAR", name: "Saudi Riyal", symbol: "﷼", decimals: 2 },
  { code: "THB", name: "Thai Baht", symbol: "฿", decimals: 2 },
  { code: "IDR", name: "Indonesian Rupiah", symbol: "Rp", decimals: 2 },
  { code: "MYR", name: "Malaysian Ringgit", symbol: "RM", decimals: 2 },
  { code: "PHP", name: "Philippine Peso", symbol: "₱", decimals: 2 },
  { code: "VND", name: "Vietnamese Dong", symbol: "₫", decimals: 0 },
  { code: "CLP", name: "Chilean Peso", symbol: "CLP$", decimals: 0 },
  { code: "ISK", name: "Icelandic Krona", symbol: "kr", decimals: 0 },
  { code: "CZK", name: "Czech Koruna", symbol: "Kč", decimals: 2 },
  { code: "HUF", name: "Hungarian Forint", symbol: "Ft", decimals: 2 },
  { code: "ILS", name: "Israeli New Shekel", symbol: "₪", decimals: 2 },
  { code: "KWD", name: "Kuwaiti Dinar", symbol: "KD", decimals: 3 },
  { code: "BHD", name: "Bahraini Dinar", symbol: "BD", decimals: 3 },
  { code: "OMR", name: "Omani Rial", symbol: "OMR", decimals: 3 },
  { code: "JOD", name: "Jordanian Dinar", symbol: "JD", decimals: 3 },
  { code: "TND", name: "Tunisian Dinar", symbol: "DT", decimals: 3 },
];

const BY_CODE = new Map<string, CurrencyInfo>(
  CURRENCIES.map((entry) => [entry.code, entry]),
);

/** A usable, trimmed locale tag, or `"en"` when the caller gave nothing. */
function normalizeLocale(locale?: string): string {
  return typeof locale === "string" && locale.trim() !== "" ? locale.trim() : "en";
}

/** Coerce a raw code to a known uppercase code, defaulting to USD. */
function resolveCode(code: unknown): string {
  if (typeof code !== "string") return FALLBACK.code;
  const upper = code.trim().toUpperCase();
  return BY_CODE.has(upper) ? upper : FALLBACK.code;
}

/**
 * Type guard for the curated currency codes. Case-insensitive and
 * whitespace-tolerant, so it narrows raw form values directly; anything that
 * is not a string, or an unknown code, is rejected.
 */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && BY_CODE.has(value.trim().toUpperCase());
}

/**
 * Registry lookup. Returns the entry for a known code (case-insensitive) and
 * the USD entry for anything else, so callers never have to null-check.
 */
export function currencyInfo(code: unknown): CurrencyInfo {
  return BY_CODE.get(resolveCode(code)) ?? FALLBACK;
}

/**
 * How many minor units make one major unit: `100` for a 2-decimal currency,
 * `1` for a 0-decimal one, `1000` for a 3-decimal one. Unknown codes use the
 * USD scale.
 */
export function minorUnits(code: unknown): number {
  return 10 ** currencyInfo(code).decimals;
}

/** Round `value` to `decimals` places (half-up), tolerating a negative input. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Render a non-finite value as its own text rather than throwing from `toFixed`. */
function toFixed(value: number, decimals: number): string {
  return Number.isFinite(value) ? value.toFixed(decimals) : String(value);
}

/**
 * Format `amount` as currency for `code` in `locale`, using the platform
 * `Intl.NumberFormat` (so grouping, symbol placement and negative style follow
 * the locale). An unknown code falls back to USD, an unusable locale falls
 * back to English, and a non-finite amount renders as `"$NaN"` / `"$∞"`.
 * Never throws.
 */
export function formatCurrency(amount: number, code: unknown, locale?: string): string {
  const info = currencyInfo(code);
  const value = Number(amount);
  const tag = normalizeLocale(locale);

  const candidates = tag === "en" ? ["en"] : [tag, "en"];
  for (const candidate of candidates) {
    try {
      return new Intl.NumberFormat(candidate, {
        style: "currency",
        currency: info.code,
      }).format(value);
    } catch {
      /* unusable locale — try the next candidate */
    }
  }
  // Last resort: even Intl for "en" failed, so build a stable string by hand.
  return `${info.symbol}${toFixed(value, info.decimals)}`;
}

/**
 * Normalise the grouping/decimal separators in `text` to a JS-parseable
 * `"1234.56"`:
 *   • both `,` and `.` present — the rightmost is the decimal separator;
 *   • a lone `,` followed by exactly 3 digits (or repeated) is grouping,
 *     otherwise it is a decimal comma;
 *   • a lone `.` is a decimal point; repeated `.` are grouping dots.
 */
function normalizeSeparators(text: string): string {
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");

  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const group = decimal === "." ? "," : ".";
    return text.split(group).join("").replace(decimal, ".");
  }
  if (lastComma >= 0) {
    const parts = text.split(",");
    const last = parts[parts.length - 1];
    if (parts.length > 2 || last.length === 3) return parts.join("");
    return `${parts.slice(0, -1).join("")}.${last}`;
  }
  if (text.split(".").length > 2) return text.split(".").join("");
  return text;
}

/**
 * Parse `raw` (a number or a display string like `"$1,234.56"`, `"1.234,56 €"`
 * or `"(5.00)"`) into an amount for `code`. The symbol/code, spaces, grouping
 * separators and an accounting-style negative are stripped, the string is
 * normalised to a single decimal point, and the result is rounded to the
 * currency's `decimals`. Returns `NaN` (never throws) for empty, code-only or
 * otherwise unparseable input; a non-finite number is `NaN`.
 */
export function parseAmount(raw: unknown, code: unknown): number {
  const info = currencyInfo(code);

  if (typeof raw === "number") {
    return Number.isFinite(raw) ? roundTo(raw, info.decimals) : Number.NaN;
  }
  if (typeof raw !== "string") return Number.NaN;

  let text = raw.trim();
  if (text === "") return Number.NaN;
  if (info.symbol) text = text.split(info.symbol).join("");
  text = text.replace(new RegExp(info.code, "gi"), "");
  text = text.replace(/[\s\u00a0\u202f]/g, "");

  let negative = false;
  if (text.length > 1 && text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }
  if (text === "") return Number.NaN;

  const value = Number(normalizeSeparators(text));
  if (!Number.isFinite(value)) return Number.NaN;

  const rounded = roundTo(value, info.decimals);
  const signed = negative ? -rounded : rounded;
  return signed === 0 ? 0 : signed;
}
