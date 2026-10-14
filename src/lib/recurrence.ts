export type TemplateRecurrence = "daily" | "weekly" | "monthly";

/**
 * Next occurrence for a recurrence, pinned to the schedule's wall clock (D4).
 *
 * - `from` is the point the schedule advances *from* — the stored `nextRunAt`
 *   in the cron route, never "now", so execution jitter cannot drift the
 *   schedule (a 09:00 schedule stays 09:00 however late the tick fires).
 * - `anchor` is the schedule's own wall-clock time: its time-of-day pins
 *   daily/weekly runs; its day-of-month pins monthly runs with a **last-day
 *   clamp** — Jan 31 → Feb 28/29 → Mar 31: the day-of-month is remembered,
 *   never incremented, so a 31st schedule never skips February (the shipped
 *   `setMonth(+1)` from Jan 31 landed on Mar 3). Defaults to `from` for
 *   callers without a stored anchor.
 */
export function nextRunFor(
  recurrence: TemplateRecurrence,
  from: Date = new Date(),
  anchor: Date = from,
): Date {
  const next = new Date(from);
  if (recurrence === "daily") {
    next.setDate(next.getDate() + 1);
  } else if (recurrence === "weekly") {
    next.setDate(next.getDate() + 7);
  } else {
    // Monthly: remember the anchor day-of-month, clamped to the target
    // month's last day. setDate(1) first — rolling the month from Jan 31
    // directly would overflow to Mar 3 and skip February entirely.
    const dayOfMonth = anchor.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(dayOfMonth, lastDay));
  }
  next.setHours(
    anchor.getHours(),
    anchor.getMinutes(),
    anchor.getSeconds(),
    anchor.getMilliseconds(),
  );
  return next;
}
