/**
 * Phone number helpers.
 *
 * Pure, dependency-free and offline: best-effort normalization to an
 * E.164-ish `+digits` form, E.164 validation, a small amount of country-aware
 * presentation grouping (US/GB/FR/DE/IN) and decomposition helpers. Nothing
 * performs a network lookup, and no input ever throws — malformed values
 * degrade to an empty string or the closest digit form rather than an error.
 *
 * This is deliberately *not* a full libphonenumber port: the country table
 * only needs to cover the codes whose grouping we render, and everything else
 * falls back to the raw digit string (`+<digits>`). The DB column, picker and
 * parse-on-blur UI are separate slices.
 */

/** Options accepted by the parse/format/normalize helpers. */
export type PhoneOptions = {
  /** ISO 3166-1 alpha-2 country used to interpret national input, e.g. `"US"`. */
  defaultCountry?: string;
};

/** Presentation style for {@link formatPhone}. */
export type PhoneFormatStyle = "international" | "national";

export type PhoneFormatOptions = {
  /** `"international"` (default) → `+1 415 555 2671`; `"national"` → `(415) 555-2671`. */
  style?: PhoneFormatStyle;
};

/** A decomposed phone number. `countryCode` is omitted when unrecognised. */
export type ParsedPhone = {
  /** Calling code with the leading `+`, e.g. `"+1"`. */
  countryCode?: string;
  /** The national significant number (digits only, no trunk prefix). */
  national: string;
};

/**
 * ISO alpha-2 → calling code for the countries we know about. Kept to the
 * set we can group (plus a few common neighbours) so behaviour stays
 * predictable.
 */
const COUNTRY_CALLING_CODES: Record<string, string> = {
  AU: "61",
  BR: "55",
  CA: "1",
  CN: "86",
  DE: "49",
  ES: "34",
  FR: "33",
  GB: "44",
  IN: "91",
  IT: "39",
  JP: "81",
  NL: "31",
  US: "1",
};

/** Longest first so `44` wins over a hypothetical `4` when matching a prefix. */
const KNOWN_CALLING_CODES = Array.from(
  new Set(Object.values(COUNTRY_CALLING_CODES)),
).sort((a, b) => b.length - a.length);

/** Countries whose national notation uses a `0` trunk prefix. */
const TRUNK_ZERO_CALLING_CODES = new Set(["44", "33", "49", "91"]);

/** Digit grouping for the national significant number, per calling code. */
const GROUPING: Record<string, number[]> = {
  "1": [3, 3, 4],
  "44": [2, 4, 4],
  "33": [1, 2, 2, 2, 2],
  "49": [2, 3, 4],
  "91": [5, 5],
};

function toDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function callingCodeFor(country: string | undefined): string | undefined {
  if (!country) return undefined;
  return COUNTRY_CALLING_CODES[country.trim().toUpperCase()];
}

/** Split `digits` according to `groups`; an over-long tail joins the last group. */
function groupDigits(digits: string, groups: number[]): string {
  const parts: string[] = [];
  let index = 0;
  for (let g = 0; g < groups.length && index < digits.length; g += 1) {
    const isLast = g === groups.length - 1;
    const size = isLast ? digits.length - index : groups[g];
    parts.push(digits.slice(index, index + size));
    index += size;
  }
  return parts.join(" ");
}

/**
 * Best-effort normalize to `+` followed by digits. Handles an explicit `+`,
 * a `00` international prefix, or national input interpreted through
 * `defaultCountry` (dropping its `0` trunk prefix). Never throws.
 */
export function normalizePhone(
  raw: string,
  options: PhoneOptions = {},
): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const digits = toDigits(trimmed);
  if (!digits) return "";

  if (trimmed.startsWith("+")) return `+${digits}`;

  if (trimmed.startsWith("00")) {
    const rest = digits.slice(2);
    return rest ? `+${rest}` : "";
  }

  const callingCode = callingCodeFor(options.defaultCountry);
  if (callingCode) {
    const national =
      TRUNK_ZERO_CALLING_CODES.has(callingCode) && digits.startsWith("0")
        ? digits.replace(/^0+/, "")
        : digits;
    return `+${callingCode}${national}`;
  }

  return `+${digits}`;
}

/**
 * Best-effort E.164 check: `+`, a non-zero leading digit and 8–15 digits
 * total. Input is normalized first, so national numbers need a
 * `defaultCountry` to validate.
 */
export function isValidPhone(raw: string, options: PhoneOptions = {}): boolean {
  const e164 = normalizePhone(raw, options);
  return /^\+[1-9]\d{7,14}$/.test(e164);
}

/**
 * Decompose a number into its calling code (when recognised) and the national
 * significant number. Input is normalized first; junk yields `{ national: "" }`.
 */
export function parsePhone(raw: string, options: PhoneOptions = {}): ParsedPhone {
  const e164 = normalizePhone(raw, options);
  const digits = e164.startsWith("+") ? e164.slice(1) : toDigits(e164);
  if (!digits) return { national: "" };

  for (const callingCode of KNOWN_CALLING_CODES) {
    if (digits.startsWith(callingCode)) {
      return {
        countryCode: `+${callingCode}`,
        national: digits.slice(callingCode.length),
      };
    }
  }

  return { national: digits };
}

/**
 * Render a number for display. `style: "international"` (default) keeps the
 * `+<cc>`; `"national"` drops it and re-adds the `0` trunk prefix where the
 * country uses one. Unknown country codes fall back to `+<digits>`.
 */
export function formatPhone(
  e164: string,
  options: PhoneFormatOptions = {},
): string {
  const normalized = normalizePhone(e164);
  const { countryCode, national } = parsePhone(normalized);
  if (!national) return "";

  const style = options.style ?? "international";
  const callingCode = countryCode?.slice(1);
  const groups = callingCode ? GROUPING[callingCode] : undefined;

  if (!callingCode || !groups) {
    return style === "national" ? national : normalized;
  }

  const grouped = groupDigits(national, groups);

  if (style === "national") {
    if (callingCode === "1" && national.length === 10) {
      return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
    }
    return TRUNK_ZERO_CALLING_CODES.has(callingCode)
      ? `0${grouped}`
      : grouped;
  }

  return `+${callingCode} ${grouped}`;
}

/** Strip every non-digit character, leaving the raw digit string. */
export function stripPhone(raw: string): string {
  if (typeof raw !== "string") return "";
  return toDigits(raw);
}
