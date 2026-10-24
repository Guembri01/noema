import type { RichNode } from "./blocks";
import { nextRunFor, type TemplateRecurrence } from "./recurrence";
import {
  interpolate,
  interpolateBlocks,
  renderBuiltins,
  type TemplateContext,
} from "./template-variables";

/**
 * Recurring database-template schedule (docs/specs/templates.md
 * R31.18-R31.23, docs/specs/database-deep.md R89.17).
 *
 * Durable storage lives on the existing `Template.recurrence` / `nextRunAt`
 * columns plus `paused`/`lastRunAt`, and every materialized occurrence gets a
 * `TemplateRun` claim unique on `(templateId, occurrenceKey)`. This module owns
 * the pure decisions around that storage — validation, anchor pinning, the
 * catch-up advancement used by the cron, the due predicate and the
 * idempotency key — so the action, the UI and the cron can never disagree.
 *
 * No IO, no clock reads, no mutation of inputs.
 */

export const TEMPLATE_RECURRENCES: readonly TemplateRecurrence[] = [
  "daily",
  "weekly",
  "monthly",
] as const;

/** True for one of the three cadences the recurrence engine understands. */
export function isTemplateRecurrence(value: unknown): value is TemplateRecurrence {
  return (
    typeof value === "string" &&
    (TEMPLATE_RECURRENCES as readonly string[]).includes(value)
  );
}

/** Coerce an untrusted schedule value: a known cadence, or `null` for manual. */
export function normalizeTemplateRecurrence(value: unknown): TemplateRecurrence | null {
  return isTemplateRecurrence(value) ? value : null;
}

/** Off-like values accepted from a form as "no schedule". */
export function isOffScheduleValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" || value === "off";
}

export type TemplateScheduleValidation =
  | {
      ok: true;
      recurrence: TemplateRecurrence | null;
      hour: number | null;
      minute: number | null;
    }
  | { ok: false; error: string };

function integerInRange(value: unknown, lo: number, hi: number): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined;
  if (parsed < lo || parsed > hi) return undefined;
  return parsed;
}

/**
 * Validate the user-facing schedule fields (R31.20). A schedule is a cadence
 * plus an optional wall-clock time; an unknown cadence or an out-of-range time
 * is refused with a stable message instead of being coerced into a different
 * schedule. "off"/`null` clears the schedule and ignores the time fields.
 */
export function validateTemplateScheduleInput(input: {
  recurrence: unknown;
  hour?: unknown;
  minute?: unknown;
}): TemplateScheduleValidation {
  if (isOffScheduleValue(input.recurrence)) {
    return { ok: true, recurrence: null, hour: null, minute: null };
  }
  if (!isTemplateRecurrence(input.recurrence)) {
    return { ok: false, error: "Choose a valid schedule." };
  }
  const hour = integerInRange(input.hour, 0, 23);
  if (hour === undefined) {
    return { ok: false, error: "Schedule hour must be a whole number from 0 to 23." };
  }
  const minute = integerInRange(input.minute, 0, 59);
  if (minute === undefined) {
    return { ok: false, error: "Schedule minute must be a whole number from 0 to 59." };
  }
  if (hour === null && minute !== null) {
    return { ok: false, error: "Choose an hour before choosing a minute." };
  }
  return {
    ok: true,
    recurrence: input.recurrence,
    hour,
    minute: hour === null ? null : minute ?? 0,
  };
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * The schedule anchor: the wall clock every future occurrence is pinned to
 * (R31.20). With an explicit hour the anchor is today at that time; without
 * one it is `now` truncated to the minute so cron jitter never drifts the
 * series.
 */
export function templateScheduleAnchor(
  now: Date,
  hour: number | null = null,
  minute: number | null = null,
): Date {
  const anchor = validDate(now) ? new Date(now.getTime()) : new Date();
  if (hour !== null) {
    anchor.setHours(hour, minute ?? 0, 0, 0);
  } else {
    anchor.setSeconds(0, 0);
  }
  return anchor;
}

/** The first run for a schedule, or `null` when it is manual/invalid. */
export function nextRunForSchedule(
  recurrence: TemplateRecurrence | null,
  now: Date,
  anchor: Date | null = null,
): Date | null {
  if (recurrence === null || !validDate(now)) return null;
  return nextRunFor(recurrence, now, validDate(anchor) ? anchor : now);
}

/**
 * Advance a schedule after a run, pinned to the stored `nextRunAt` (not `now`)
 * and to the anchor (R31.20). A schedule stale by more than one period
 * catches up with a single row: the result is strictly after `now`, so the
 * next tick cannot flood with one row per missed occurrence (R31.22).
 */
export function advanceTemplateSchedule(
  recurrence: TemplateRecurrence,
  scheduledFor: Date,
  anchor: Date | null,
  now: Date,
): Date {
  const from = validDate(scheduledFor) ? scheduledFor : now;
  const base = validDate(anchor) ? anchor : from;
  const next = nextRunFor(recurrence, from, base);
  if (next.getTime() > now.getTime()) return next;
  return nextRunFor(recurrence, now, base);
}

/** The persisted anchor (`config.anchorAt`) when it is a usable timestamp. */
export function templateAnchorFromConfig(config: unknown): Date | null {
  const record =
    typeof config === "object" && config !== null && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : null;
  const raw = record?.anchorAt;
  if (typeof raw !== "string" && typeof raw !== "number" && !(raw instanceof Date)) {
    return null;
  }
  const parsed = raw instanceof Date ? raw : new Date(raw);
  return validDate(parsed) ? parsed : null;
}

export type TemplateScheduleRecord = {
  recurrence?: string | null;
  nextRunAt?: Date | string | null;
  paused?: boolean | null;
};

function dateOf(value: unknown): Date | null {
  if (value instanceof Date) return validDate(value) ? value : null;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return validDate(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Is this template due on this tick? Paused, manual and future-scheduled
 * templates are never due, so the cron query and this predicate agree.
 */
export function isTemplateDue(
  template: TemplateScheduleRecord,
  now: Date,
): boolean {
  if (!isTemplateRecurrence(template.recurrence)) return false;
  if (template.paused === true) return false;
  const next = dateOf(template.nextRunAt);
  return next !== null && next.getTime() <= now.getTime();
}

/**
 * Durable occurrence key for `TemplateRun`. Deterministic in `(templateId,
 * scheduledFor)`, so a replayed tick derives the same key and loses the unique
 * insert rather than creating a second row.
 */
export function templateOccurrenceKey(templateId: string, scheduledFor: Date): string {
  return `${templateId}:${scheduledFor.toISOString()}`;
}

/** Prisma's stable code for a unique-constraint violation. */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Who a scheduler-created row is attributed to (R31.1/R89.17): the template
 * author when known, else the database creator. `null` means neither exists —
 * the caller must refuse rather than write an orphan row.
 */
export function resolveTemplateActorId(
  template: { createdById?: string | null },
  database: { createdById?: string | null },
): string | null {
  return template.createdById || database.createdById || null;
}

/** Human-readable next run for a chip/panel; `null` when unset/invalid. */
export function formatTemplateNextRun(
  nextRunAt: Date | string | null | undefined,
  locale = "en",
): string | null {
  const date = dateOf(nextRunAt);
  if (!date) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * One-line schedule summary used by the menu and tests:
 * `"Manual"`, `"Daily · next 2 Nov 2026, 09:00"`, `"Weekly · paused"`.
 */
export function describeTemplateSchedule(
  template: TemplateScheduleRecord,
  locale = "en",
): string {
  if (!isTemplateRecurrence(template.recurrence)) return "Manual";
  const cadence =
    template.recurrence.charAt(0).toUpperCase() + template.recurrence.slice(1);
  if (template.paused === true) return `${cadence} · paused`;
  const next = formatTemplateNextRun(template.nextRunAt, locale);
  return next ? `${cadence} · next ${next}` : cadence;
}

/* -------------------------------------------------------------------------- *
 * Template variables (R31.17-R31.19)
 * -------------------------------------------------------------------------- */

/**
 * The built-in context for a materialization run. `date` is the run's calendar
 * day and `title` its ISO day (R31.18), so a weekly report created Monday is
 * stamped with *this* week's run — not the authoring date.
 */
export function templateVariableContext(now: Date, user?: string): TemplateContext {
  return renderBuiltins({ today: now, now, user });
}

/** Interpolate a template title/body with the run context. */
export function resolveTemplateText(text: string, context: TemplateContext): string {
  return interpolate(text, context);
}

/**
 * Interpolate a stored template body, preserving its document shape. A
 * ProseMirror `{ type: "doc", content: [...] }` keeps the wrapper; a bare block
 * array is mapped directly; anything else is returned untouched.
 */
export function resolveTemplateContent(
  content: unknown,
  context: TemplateContext,
): unknown {
  if (content === null || content === undefined) return content;
  if (Array.isArray(content)) {
    return interpolateBlocks(content as RichNode[], context);
  }
  if (typeof content === "object") {
    const doc = content as { content?: unknown };
    if (Array.isArray(doc.content)) {
      return {
        ...(content as Record<string, unknown>),
        content: interpolateBlocks(doc.content as RichNode[], context),
      };
    }
  }
  return content;
}

/**
 * Interpolate strings inside a stored property value (`{ text }`, `{ start }`,
 * multi-select option ids, …). Keys are preserved and inputs are never
 * mutated; values without tokens round-trip byte-identically.
 */
export function resolveTemplateValue(value: unknown, context: TemplateContext): unknown {
  if (typeof value === "string") return interpolate(value, context);
  if (Array.isArray(value)) return value.map((entry) => resolveTemplateValue(entry, context));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveTemplateValue(entry, context);
    }
    return out;
  }
  return value;
}

/**
 * `Template.config.values` → `{ propertyId: value }` map for the pure planner.
 * Malformed entries are ignored; duplicate property ids keep the last value
 * (matching `PropertyValue`'s `@@unique([propertyId, pageId])`).
 */
export function templatePropertyDefaults(config: unknown): Record<string, unknown> {
  const record =
    typeof config === "object" && config !== null && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : null;
  const entries = record?.values;
  if (!Array.isArray(entries)) return {};
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { propertyId?: unknown; value?: unknown };
    if (typeof candidate.propertyId !== "string" || candidate.propertyId === "") {
      continue;
    }
    out[candidate.propertyId] = candidate.value;
  }
  return out;
}
