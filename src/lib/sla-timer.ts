/**
 * Ticket SLA timers — a pure service-level clock over ms epochs.
 *
 * A ticket gets two timers from its policy: a **response** deadline (first
 * reply) and a **resolve** deadline (closed). `computeSlaDue` turns a ticket's
 * creation instant plus a policy into the concrete due instants; `slaStatus`
 * grades a deadline as `ok` / `warning` / `overdue` for an injected `now`;
 * `nextBreach` picks the most urgent outstanding deadline across a queue; and
 * `formatRemaining` renders a duration for the UI.
 *
 * Pure and deterministic: the current time is always an explicit argument
 * (`now`), never `Date.now()`, and all comparisons happen on epoch ms, so the
 * same inputs give the same result on any machine. Malformed input (a bad
 * instant, a non-positive window) degrades to "no timer" rather than throwing.
 * No DB, no routes, no React, and nothing the caller passes is ever mutated.
 */

/** An instant accepted from callers: epoch ms, a `Date`, or a parsable string. */
export type SlaClock = number | Date | string;

/** Which deadline a policy timer describes. */
export type SlaKind = "response" | "resolve";

/**
 * A ticket's SLA budget in minutes. Either window may be any positive finite
 * number (fractions allowed); a non-positive / non-finite window means that
 * timer is not configured and `computeSlaDue` returns `null`.
 */
export type SlaPolicy = {
  responseMinutes: number;
  resolveMinutes: number;
  /**
   * Percentage of the window that may elapse before the status turns
   * `warning`. Clamped to `[0, 100]`; defaults to {@link DEFAULT_WARN_PERCENT}.
   */
  warnAtPercent?: number;
};

/** A resolved deadline for one ticket and one timer kind. */
export type SlaDue = {
  kind: SlaKind;
  /** Epoch ms the window opened (the ticket's creation instant). */
  startedAt: number;
  /** Epoch ms the deadline lands. */
  dueAt: number;
  /** Window length in ms (`dueAt - startedAt`), always positive. */
  windowMs: number;
};

/** Grade of a deadline relative to an injected `now`. */
export type SlaStatus = "ok" | "warning" | "overdue";

/** Result of {@link slaStatus}. */
export type SlaStatusResult = {
  status: SlaStatus;
  /** `dueAt - now` in ms; `0` at the deadline, negative once past it. */
  remainingMs: number;
};

/** Options for {@link slaStatus}. */
export type SlaStatusOptions = {
  /** Elapsed-window percentage at which to warn; see {@link SlaPolicy.warnAtPercent}. */
  warnAtPercent?: number;
  /**
   * Total window length in ms. The warning band is disabled unless this is a
   * positive finite number, so callers who only track a bare `dueAt` still get
   * a correct `ok` / `overdue` grade.
   */
  windowMs?: number;
};

/** One ticket queued for its SLA deadlines. */
export type SlaItem = {
  id: string;
  /** When the ticket entered the queue. */
  createdAt: SlaClock;
  /** Key into the `policies` map passed to {@link nextBreach}. */
  policyId: string;
  /** When set (non-null), the response timer is already satisfied. */
  respondedAt?: SlaClock | null;
  /** When set (non-null), the resolve timer is already satisfied. */
  resolvedAt?: SlaClock | null;
};

/** Policies keyed by `SlaItem.policyId`. */
export type SlaPolicies = Readonly<Record<string, SlaPolicy>>;

/** The most urgent outstanding deadline across a queue. */
export type SlaBreach = {
  itemId: string;
  kind: SlaKind;
  dueAt: number;
  policyId: string;
  /** Present only when `now` was supplied to {@link nextBreach}. */
  remainingMs?: number;
  /** Present only when `now` was supplied to {@link nextBreach}. */
  status?: SlaStatus;
};

/** Warning band used when a policy / call omits `warnAtPercent`. */
export const DEFAULT_WARN_PERCENT = 80;

const MINUTE_MS = 60_000;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Response deadlines sort ahead of resolve deadlines on an exact tie. */
const KIND_ORDER: Record<SlaKind, number> = { response: 0, resolve: 1 };

/** Normalise an instant to epoch ms, or `null` when it cannot be parsed. */
function toEpoch(value: SlaClock): number | null {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Clamp a percentage to `[0, 100]`, falling back for non-finite input. */
function clampPercent(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WARN_PERCENT;
  return Math.min(100, Math.max(0, value));
}

/**
 * Resolve the deadline for `createdAt` under `policy` for the requested timer
 * `kind`. Returns `null` when the creation instant cannot be parsed or the
 * corresponding window is not a positive finite number of minutes (no timer).
 */
export function computeSlaDue(
  createdAt: SlaClock,
  policy: SlaPolicy,
  options: { kind: SlaKind },
): SlaDue | null {
  const startedAt = toEpoch(createdAt);
  if (startedAt === null) return null;
  const minutes = options.kind === "response" ? policy.responseMinutes : policy.resolveMinutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  const windowMs = minutes * MINUTE_MS;
  return { kind: options.kind, startedAt, dueAt: startedAt + windowMs, windowMs };
}

/**
 * Grade a deadline for an injected `now`.
 *
 * - at or past `dueAt` (`remainingMs <= 0`) → `overdue`;
 * - inside the warning band → `warning`;
 * - otherwise → `ok`.
 *
 * The warning band runs from `windowMs * (1 - warnAtPercent / 100)` remaining
 * down to zero; `warnAtPercent` clamps to `[0, 100]` and defaults to
 * {@link DEFAULT_WARN_PERCENT}. Without a positive `windowMs` there is no
 * warning band. An unparseable `dueAt` counts as overdue with `NaN` remaining.
 */
export function slaStatus(
  now: SlaClock,
  dueAt: SlaClock,
  options: SlaStatusOptions = {},
): SlaStatusResult {
  const due = toEpoch(dueAt);
  if (due === null) return { status: "overdue", remainingMs: Number.NaN };
  const nowMs = toEpoch(now);
  if (nowMs === null) return { status: "overdue", remainingMs: Number.NaN };
  const remainingMs = due - nowMs;
  if (remainingMs <= 0) return { status: "overdue", remainingMs };
  const windowMs = options.windowMs;
  if (typeof windowMs === "number" && Number.isFinite(windowMs) && windowMs > 0) {
    const percent = clampPercent(options.warnAtPercent);
    const warnFrom = (windowMs * (100 - percent)) / 100;
    if (remainingMs <= warnFrom) return { status: "warning", remainingMs };
  }
  return { status: "ok", remainingMs };
}

/**
 * The most urgent outstanding deadline across `items`.
 *
 * Every unsatisfied timer contributes a candidate: the response timer is
 * skipped when `respondedAt` is set, likewise resolve / `resolvedAt`. Items
 * whose policy is missing or whose timer has no positive window are ignored.
 * Candidates sort by `dueAt` ascending, then response before resolve, then id —
 * so the winner is deterministic. When `now` is supplied, its `remainingMs`
 * and `status` are attached; otherwise only the schedule facts are returned.
 * Returns `null` when nothing is outstanding.
 */
export function nextBreach(
  items: readonly SlaItem[],
  policies: SlaPolicies,
  now?: SlaClock,
): SlaBreach | null {
  let best: SlaBreach | null = null;
  let bestWindowMs = 0;
  let bestPolicy: SlaPolicy | undefined;
  for (const item of items) {
    const responded = item.respondedAt != null;
    const resolved = item.resolvedAt != null;
    if (responded && resolved) continue;
    const policy = policies[item.policyId];
    if (!policy) continue;
    for (const kind of ["response", "resolve"] as const) {
      if (kind === "response" ? responded : resolved) continue;
      const due = computeSlaDue(item.createdAt, policy, { kind });
      if (!due) continue;
      const candidate: SlaBreach = {
        itemId: item.id,
        kind,
        dueAt: due.dueAt,
        policyId: item.policyId,
      };
      if (
        best === null ||
        candidate.dueAt < best.dueAt ||
        (candidate.dueAt === best.dueAt &&
          (KIND_ORDER[candidate.kind] < KIND_ORDER[best.kind] ||
            (KIND_ORDER[candidate.kind] === KIND_ORDER[best.kind] &&
              candidate.itemId.localeCompare(best.itemId) < 0)))
      ) {
        best = candidate;
        bestWindowMs = due.windowMs;
        bestPolicy = policy;
      }
    }
  }
  if (best === null) return null;
  const nowMs = now === undefined ? null : toEpoch(now);
  if (nowMs === null || bestPolicy === undefined) return best;
  const graded = slaStatus(nowMs, best.dueAt, {
    warnAtPercent: bestPolicy.warnAtPercent,
    windowMs: bestWindowMs,
  });
  return { ...best, remainingMs: graded.remainingMs, status: graded.status };
}

/**
 * Human-readable remaining time, largest two units only (`"2d 3h"`,
 * `"45m"`, `"30s"`). Durations under a second render `"0s"`; a past deadline
 * keeps its sign (`"-1m 30s"`). Non-finite input renders `""`.
 */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const negative = ms < 0;
  let seconds = Math.floor(Math.abs(ms) / MS_PER_SECOND);
  const units: readonly [number, string][] = [
    [MS_PER_DAY / MS_PER_SECOND, "d"],
    [MS_PER_HOUR / MS_PER_SECOND, "h"],
    [MS_PER_MINUTE / MS_PER_SECOND, "m"],
    [1, "s"],
  ];
  const parts: string[] = [];
  for (const [size, suffix] of units) {
    if (parts.length === 2) break;
    const value = Math.floor(seconds / size);
    if (value > 0 || (parts.length === 0 && suffix === "s")) {
      parts.push(`${value}${suffix}`);
      seconds -= value * size;
    }
  }
  return `${negative ? "-" : ""}${parts.join(" ")}`;
}
