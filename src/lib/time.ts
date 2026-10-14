/**
 * Date formatting that survives hydration.
 *
 * Server rendering formats dates with the server's locale and timezone; the
 * browser then formats the same date with the user's, so the text differs and
 * React reports a hydration mismatch (#418) — which detaches every handler on
 * the page. `stableTime` is deterministic (fixed locale + UTC) for the server and
 * the first client paint; `localTime` is the user's own formatting, applied after
 * mount by `<LocalTime>`.
 */

export type TimeMode = "datetime" | "date" | "time";

const OPTIONS: Record<TimeMode, Intl.DateTimeFormatOptions> = {
  datetime: { dateStyle: "medium", timeStyle: "short" },
  date: { dateStyle: "medium" },
  time: { timeStyle: "short" },
};

const toDate = (value: string | Date) =>
  typeof value === "string" ? new Date(value) : value;

/** Deterministic: fixed locale + UTC, so server and client agree byte for byte. */
export function stableTime(value: string | Date, mode: TimeMode = "datetime"): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { ...OPTIONS[mode], timeZone: "UTC" }).format(date);
}

/** The user's own formatting — only safe after mount. */
export function localTime(value: string | Date, mode: TimeMode = "datetime"): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, OPTIONS[mode]).format(date);
}
