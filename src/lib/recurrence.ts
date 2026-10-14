export type TemplateRecurrence = "daily" | "weekly" | "monthly";

/** Next occurrence for a recurrence, from a given time. */
export function nextRunFor(
  recurrence: TemplateRecurrence,
  from: Date = new Date(),
): Date {
  const next = new Date(from);
  if (recurrence === "daily") next.setDate(next.getDate() + 1);
  else if (recurrence === "weekly") next.setDate(next.getDate() + 7);
  else next.setMonth(next.getMonth() + 1);
  return next;
}
