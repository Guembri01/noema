/**
 * API token expiration policy shared by the settings UI and the server action.
 *
 * A missing value keeps the historical 90-day default; an explicit `null` means
 * "never expires"; an ISO string is the user's custom deadline. The server
 * validates every path again, so a compromised client cannot mint a token with
 * an invalid or absurd lifetime.
 */

export const DEFAULT_TOKEN_LIFETIME_DAYS = 90;
export const MAX_TOKEN_LIFETIME_DAYS = 3650;

export type TokenExpiryChoice =
  | { kind: "default" }
  | { kind: "never" }
  | { kind: "custom"; at: Date };

export type TokenExpiryResult =
  | { ok: true; value: Date | null }
  | { ok: false; error: string };

function daysFromNow(days: number, now: Date): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Resolve the action argument.
 *
 * - `undefined` → the legacy 90-day deadline
 * - `null` → never expires
 * - ISO/date string → custom deadline (must be in the future, ≤ 10 years)
 */
export function resolveTokenExpiry(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): TokenExpiryResult {
  if (expiresAt === undefined) {
    return { ok: true, value: daysFromNow(DEFAULT_TOKEN_LIFETIME_DAYS, now) };
  }
  if (expiresAt === null) return { ok: true, value: null };

  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "That expiration date is not valid." };
  }
  // One minute of clock skew is tolerated for a deadline chosen "now".
  if (parsed.getTime() <= now.getTime() - 60_000) {
    return { ok: false, error: "The expiration date must be in the future." };
  }
  const max = daysFromNow(MAX_TOKEN_LIFETIME_DAYS, now);
  if (parsed.getTime() > max.getTime()) {
    return { ok: false, error: "The expiration date is too far in the future." };
  }
  return { ok: true, value: parsed };
}

/** Preset chooser values for the create-token form. */
export const TOKEN_EXPIRY_PRESETS: readonly {
  value: string;
  days: number | null;
  label: string;
}[] = [
  { value: "7", days: 7, label: "7 days" },
  { value: "30", days: 30, label: "30 days" },
  { value: "90", days: 90, label: "90 days" },
  { value: "365", days: 365, label: "1 year" },
  { value: "never", days: null, label: "Never" },
  { value: "custom", days: null, label: "Custom date" },
];

/** ISO deadline for a preset value, or `undefined` for the custom/unknown case. */
export function presetExpiryIso(
  value: string,
  now: Date = new Date(),
): string | null | undefined {
  const preset = TOKEN_EXPIRY_PRESETS.find((entry) => entry.value === value);
  if (!preset) return undefined;
  if (preset.value === "custom") return undefined;
  if (preset.days === null) return null;
  return daysFromNow(preset.days, now).toISOString();
}

/** Convert a `YYYY-MM-DD` date input into the end of that local day. */
export function customDateToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T23:59:59`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
