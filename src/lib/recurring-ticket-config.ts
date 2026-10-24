/**
 * Serialization + form mapping for recurring-ticket schedules.
 *
 * The scheduling maths lives in `@/lib/recurring-tickets` (pure, clock-free);
 * this module is the narrow bridge between that engine and the two places a
 * rule is stored or typed: the `Automation.triggerConfig` / `Automation.action`
 * JSON columns and the tracker's "Recurring ticket" form. Everything here is
 * pure, so the same mapping is used by the server action, the cron materializer
 * and the UI — and can be pinned without a database or a DOM.
 */

import {
  RecurrenceRuleError,
  describeRule,
  parseRule,
  type RecurrenceRule,
} from "./recurring-tickets";

/** The ticket a schedule clones. `labels` are workspace label ids. */
export type RecurringTicketTemplate = {
  templateId: string;
  title: string;
  projectId: string | null;
  priority: string | null;
  labels: string[];
};

/** The one action a recurring schedule performs. */
export type RecurringTicketAction = {
  kind: "create_ticket";
  template: RecurringTicketTemplate;
};

/** A rule with dates as ISO strings — what the JSON column can hold. */
export type SerializedRecurrenceRule = {
  freq: RecurrenceRule["freq"];
  interval: number;
  byWeekday?: string[];
  byMonthDay?: number[];
  count?: number;
  until?: string;
  start?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Max labels a template may carry — a schedule is not a bulk-label tool. */
export const MAX_RECURRING_LABELS = 20;

/** Only `create_ticket` schedules are supported today; anything else fails closed. */
export const RECURRING_TICKET_ACTION_KIND = "create_ticket" as const;

/**
 * Copy a normalized rule into the JSON-safe shape stored in
 * `Automation.triggerConfig.rule`. Dates become ISO strings because Prisma's
 * `Json` columns cannot carry `Date` instances.
 */
export function serializeRecurringRule(rule: RecurrenceRule): SerializedRecurrenceRule {
  return {
    freq: rule.freq,
    interval: rule.interval,
    ...(rule.byWeekday && rule.byWeekday.length > 0
      ? { byWeekday: [...rule.byWeekday] }
      : {}),
    ...(rule.byMonthDay && rule.byMonthDay.length > 0
      ? { byMonthDay: [...rule.byMonthDay] }
      : {}),
    ...(rule.count !== undefined ? { count: rule.count } : {}),
    ...(rule.until ? { until: rule.until.toISOString() } : {}),
    ...(rule.start ? { start: rule.start.toISOString() } : {}),
  };
}

/**
 * Read a stored schedule rule. Accepts either the `{ rule }` wrapper the
 * column stores or a bare rule object, and re-validates it through
 * `parseRule` — stored JSON is never trusted just because it was written once.
 */
export function readRecurringRule(value: unknown): RecurrenceRule {
  const source = isRecord(value) && "rule" in value ? value.rule : value;
  return parseRule(source);
}

/** Read a stored schedule action, failing closed on a malformed template. */
export function readRecurringAction(value: unknown): RecurringTicketAction {
  if (!isRecord(value) || value.kind !== RECURRING_TICKET_ACTION_KIND) {
    throw new RecurrenceRuleError("The recurring ticket action is not valid.");
  }
  if (!isRecord(value.template)) {
    throw new RecurrenceRuleError("The recurring ticket template is not valid.");
  }
  const template = value.template;
  const templateId =
    typeof template.templateId === "string" ? template.templateId.trim() : "";
  const title = typeof template.title === "string" ? template.title.trim() : "";
  if (!templateId || !title) {
    throw new RecurrenceRuleError("The recurring ticket template is missing its id or title.");
  }
  return {
    kind: RECURRING_TICKET_ACTION_KIND,
    template: {
      templateId,
      title,
      projectId: typeof template.projectId === "string" ? template.projectId : null,
      priority: typeof template.priority === "string" ? template.priority : null,
      labels: readLabelIds(template.labels),
    },
  };
}

/**
 * Coerce a submitted label list into unique, trimmed strings. Unknown ids are
 * dropped by the server action (it re-checks them against the workspace); this
 * function only guarantees the shape a template stores.
 */
export function readLabelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const label = entry.trim();
    if (!label || labels.includes(label)) continue;
    labels.push(label);
    if (labels.length >= MAX_RECURRING_LABELS) break;
  }
  return labels;
}

/** Serialize a template into the `Automation.action` JSON column. */
export function serializeRecurringAction(
  template: RecurringTicketTemplate,
): RecurringTicketAction {
  return {
    kind: RECURRING_TICKET_ACTION_KIND,
    template: {
      templateId: template.templateId,
      title: template.title,
      projectId: template.projectId,
      priority: template.priority,
      labels: readLabelIds(template.labels),
    },
  };
}

/** The fields the tracker's create form owns. */
export type RecurringRuleForm = {
  freq: string;
  interval?: string | number;
  /** Weekly rules: the one weekday the form offers (`mon`…`sun`). */
  weekday?: string;
  /** Monthly/yearly rules: the day of the month (1..31). */
  monthDay?: string | number;
};

export type RecurringRuleFormResult =
  | { ok: true; rule: RecurrenceRule }
  | { ok: false; error: string };

/**
 * Map the form's strings onto a raw rule and validate it through `parseRule`.
 * Blank optional fields are omitted (so the engine applies its documented
 * defaults); a malformed value comes back as a friendly error instead of an
 * exception, and nothing invalid ever reaches `saveRecurringTicketAction`.
 */
export function ruleFromForm(input: RecurringRuleForm): RecurringRuleFormResult {
  const raw: Record<string, unknown> = { freq: input.freq };

  const interval =
    typeof input.interval === "string"
      ? input.interval.trim() === ""
        ? undefined
        : Number(input.interval)
      : input.interval;
  if (interval !== undefined) raw.interval = interval;

  if (input.freq === "weekly" && input.weekday?.trim()) {
    raw.byWeekday = [input.weekday.trim()];
  }
  if (
    (input.freq === "monthly" || input.freq === "yearly") &&
    input.monthDay !== undefined &&
    String(input.monthDay).trim() !== ""
  ) {
    raw.byMonthDay = [Number(input.monthDay)];
  }

  try {
    return { ok: true, rule: parseRule(raw) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "That recurrence rule is not valid.",
    };
  }
}

/** One-line human summary for a stored rule (`Every 2 weeks on Tue, Thu`). */
export function recurringScheduleSummary(rule: RecurrenceRule): string {
  return describeRule(rule);
}
