/**
 * Sprints (cycles) and velocity. Pure functions so the maths behind the progress
 * bars and the burndown chart is testable without a database.
 */

import { isClosed, sumEstimates, type TicketLike } from "@/lib/tickets";

export type CycleLike = {
  id: string;
  name: string;
  startDate: string | Date;
  endDate: string | Date;
};

/**
 * The stored cycle shape (ISO instants). Kept separate from `CycleLike` so the
 * pure burndown/scope helpers can be driven by a plain API payload, while the
 * richer `CycleLike` rows the UI ships keep working unchanged.
 */
export type Cycle = {
  id: string;
  name: string;
  /** ISO instant the cycle starts (interpreted in UTC). */
  start: string;
  /** ISO instant the cycle ends (inclusive, UTC). */
  end: string;
};

export type CycleTicket = TicketLike & {
  completedAt?: string | Date | null;
  /** Used to place the completion on the burndown axis. */
  updatedAt?: string | Date | null;
  /** Creation instant, used to spot scope added after the cycle started. */
  createdAt?: string | Date | null;
};

const DAY = 24 * 60 * 60 * 1000;

const at = (value: string | Date) => (value instanceof Date ? value : new Date(value));

/** Anything date-ish -> UTC-midnight epoch (ms), or null when unparseable. */
function utcDay(value: unknown): number | null {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? new Date(value).getTime()
        : Number.NaN;
  if (Number.isNaN(time)) return null;
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** `YYYY-MM-DD` for a UTC-midnight epoch (ms). */
function isoDay(dayMs: number): string {
  return new Date(dayMs).toISOString().slice(0, 10);
}

/** Inclusive UTC-midnight bounds of a cycle, tolerating either shape. */
function cycleBounds(cycle: Cycle | CycleLike): { start: number; end: number } {
  const rawStart = utcDay("start" in cycle ? cycle.start : cycle.startDate);
  const rawEnd = utcDay("start" in cycle ? cycle.end : cycle.endDate);
  const start = rawStart ?? rawEnd ?? 0;
  return { start, end: Math.max(start, rawEnd ?? start) };
}

/** Whole days between two instants (inclusive), floored at 1. */
export function cycleDays(cycle: Cycle | CycleLike): number {
  // Preserve the original instant-based maths for the `startDate`/`endDate` rows.
  if (!("start" in cycle)) {
    const span = at(cycle.endDate).getTime() - at(cycle.startDate).getTime();
    return Math.max(1, Math.round(span / DAY) + 1);
  }
  const { start, end } = cycleBounds(cycle);
  return Math.max(1, Math.round((end - start) / DAY) + 1);
}

/** Which cycle contains `now` (or the next one to start). */
export function activeCycle<T extends CycleLike>(cycles: T[], now = new Date()): T | null {
  const time = now.getTime();
  const current = cycles.find(
    (cycle) => at(cycle.startDate).getTime() <= time && at(cycle.endDate).getTime() >= time,
  );
  if (current) return current;
  const upcoming = cycles
    .filter((cycle) => at(cycle.startDate).getTime() > time)
    .sort((a, b) => at(a.startDate).getTime() - at(b.startDate).getTime());
  return upcoming[0] ?? null;
}

/**
 * Committed vs completed effort, the completion percentage, and a burndown
 * series: per day, the remaining points against the ideal straight line.
 */
export function cycleProgress(
  tickets: CycleTicket[],
  cycle: Cycle | CycleLike,
  now = new Date(),
): {
  committed: number;
  completed: number;
  remaining: number;
  unit: string;
  percent: number;
  days: number;
  daysElapsed: number;
  daysLeft: number;
  burndown: { day: number; remaining: number | null; ideal: number }[];
} {
  const committed = sumEstimates(tickets).total;
  const unit = sumEstimates(tickets).unit;
  const completed = sumEstimates(tickets.filter((ticket) => isClosed(ticket.status))).total;
  const days = cycleDays(cycle);
  const start = "start" in cycle ? cycleBounds(cycle).start : at(cycle.startDate).getTime();
  const elapsed = Math.min(days, Math.max(0, Math.floor((now.getTime() - start) / DAY) + 1));

  // Remaining effort after each day: closed tickets count from the day they closed.
  const closedAt = new Map<string, number>();
  for (const ticket of tickets) {
    if (!isClosed(ticket.status)) continue;
    const stamp = ticket.completedAt ?? ticket.updatedAt ?? null;
    const index = stamp ? Math.floor((at(stamp).getTime() - start) / DAY) + 1 : days;
    closedAt.set(ticket.id, Math.min(days, Math.max(1, index)));
  }

  const burndown: { day: number; remaining: number | null; ideal: number }[] = [];
  for (let day = 1; day <= days; day += 1) {
    let burned = 0;
    for (const [id, atDay] of closedAt) {
      if (atDay > day) continue;
      const ticket = tickets.find((candidate) => candidate.id === id);
      burned += ticket?.estimate ?? 0;
    }
    burndown.push({
      day,
      remaining: day <= elapsed ? Math.max(0, Math.round((committed - burned) * 100) / 100) : null,
      ideal: Math.round((committed - ((committed * (day - 1)) / Math.max(1, days - 1))) * 100) / 100,
    });
  }

  return {
    committed,
    completed,
    remaining: Math.max(0, Math.round((committed - completed) * 100) / 100),
    unit,
    percent: committed === 0 ? 0 : Math.round((completed / committed) * 100),
    days,
    daysElapsed: elapsed,
    daysLeft: Math.max(0, days - elapsed),
    burndown,
  };
}

/** Average completed points per finished cycle, most recent first. */
export function velocity(
  cycles: (CycleLike & { tickets: CycleTicket[] })[],
  now = new Date(),
): { name: string; completed: number; committed: number }[] {
  return cycles
    .filter((cycle) => at(cycle.endDate).getTime() < now.getTime())
    .sort((a, b) => at(b.startDate).getTime() - at(a.startDate).getTime())
    .slice(0, 6)
    .map((cycle) => ({
      name: cycle.name,
      completed: sumEstimates(cycle.tickets.filter((ticket) => isClosed(ticket.status))).total,
      committed: sumEstimates(cycle.tickets).total,
    }));
}

/* ------------------------------------------------------------------------ *
 * Burndown & scope (MISSING_FEATURES §3 — "cycles & sprints"). Pure and
 * UTC-safe: every day boundary is a UTC midnight, so a series is identical
 * whatever the machine's timezone is.
 * ------------------------------------------------------------------------ */

/** Read a ticket field by name (the completion/creation field is configurable). */
function fieldOf(ticket: object, field: string): unknown {
  return (ticket as Record<string, unknown>)[field];
}

export type CycleScopeOptions = {
  /** Field holding the completion instant. Default `"completedAt"`. */
  completedAtField?: string;
};

export type CycleHistoryOptions = {
  /** Field holding the creation instant. Default `"createdAt"`. */
  createdAtField?: string;
};

/**
 * Tickets that belong to a cycle's inclusive UTC window. Each ticket is placed
 * by its completion instant (the field named by `completedAtField`, default
 * `completedAt`) when it carries one, otherwise by its scheduled `startDate`
 * then `dueDate`. Tickets with none of those dates are left out.
 */
export function ticketsInCycle<T extends CycleTicket>(
  tickets: T[],
  cycle: Cycle,
  options: CycleScopeOptions = {},
): T[] {
  const { start, end } = cycleBounds(cycle);
  const field = options.completedAtField ?? "completedAt";
  return tickets.filter((ticket) => {
    const day =
      utcDay(fieldOf(ticket, field)) ?? utcDay(ticket.startDate) ?? utcDay(ticket.dueDate);
    return day !== null && day >= start && day <= end;
  });
}

/** One point of a burndown: the date, the estimate still open, and the ideal. */
export type BurndownPoint = {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  /** Open estimate at the end of that day, or null for days not yet measured. */
  remaining: number | null;
  /** Straight line from the committed total down to zero. */
  ideal: number;
};

/**
 * Per-day burndown for a cycle. `remaining` is the sum of the estimates still
 * open at the end of each day: a closed ticket (`isClosed`) burns on its
 * completion day (falling back to `updatedAt`, and to the last day when it has
 * neither stamp). Days after `now`'s UTC day are `null` — nothing has been
 * measured yet; omit `now` to measure the whole cycle. `ideal` is the linear
 * run from the committed total to zero across the cycle.
 */
export function burndownSeries(
  cycle: Cycle,
  tickets: CycleTicket[],
  options: { now?: Date } = {},
): BurndownPoint[] {
  const { start, end } = cycleBounds(cycle);
  const days = Math.max(1, Math.round((end - start) / DAY) + 1);
  const total = sumEstimates(tickets).total;
  const clockDay = options.now ? utcDay(options.now) : null;
  const measuredThrough = clockDay === null ? days - 1 : Math.floor((clockDay - start) / DAY);

  // The day each closed ticket burned, clamped into the window.
  const burnDay = new Map<string, number>();
  for (const ticket of tickets) {
    if (!isClosed(ticket.status)) continue;
    const raw = utcDay(ticket.completedAt ?? ticket.updatedAt ?? null);
    const index = raw === null ? days - 1 : Math.floor((raw - start) / DAY);
    burnDay.set(ticket.id, Math.min(days - 1, Math.max(0, index)));
  }

  const series: BurndownPoint[] = [];
  for (let day = 0; day < days; day += 1) {
    let burned = 0;
    for (const ticket of tickets) {
      const closedOn = burnDay.get(ticket.id);
      if (closedOn !== undefined && closedOn <= day) burned += ticket.estimate ?? 0;
    }
    series.push({
      date: isoDay(start + day * DAY),
      remaining: day <= measuredThrough ? Math.round((total - burned) * 100) / 100 : null,
      ideal: Math.round((total - (total * day) / Math.max(1, days - 1)) * 100) / 100,
    });
  }
  return series;
}

/**
 * Tickets added to a cycle after it started: created on a later UTC day than
 * the start (and no later than the end). Tickets with no creation stamp are
 * never flagged.
 */
export function addedMidCycle<T extends CycleTicket>(
  tickets: T[],
  cycle: Cycle,
  options: CycleHistoryOptions = {},
): T[] {
  const { start, end } = cycleBounds(cycle);
  const field = options.createdAtField ?? "createdAt";
  return tickets.filter((ticket) => {
    const created = utcDay(fieldOf(ticket, field));
    return created !== null && created > start && created <= end;
  });
}

export type ScopeChange = {
  /** Tickets already in scope when the cycle started. */
  planned: number;
  /** Tickets added mid-cycle. */
  added: number;
  /** Estimate points carried by the added tickets. */
  addedEstimate: number;
  /** `added / (planned + added)`, rounded to 2dp; 0 for an empty scope. */
  ratio: number;
};

/**
 * How much a cycle's scope grew after it started. Tickets created after the
 * cycle ends are outside its history and ignored; tickets with no creation
 * stamp count as planned (they were there from the outset).
 */
export function scopeChange<T extends CycleTicket>(
  tickets: T[],
  cycle: Cycle,
  options: CycleHistoryOptions = {},
): ScopeChange {
  const { end } = cycleBounds(cycle);
  const field = options.createdAtField ?? "createdAt";
  const added = addedMidCycle(tickets, cycle, options);
  const history = tickets.filter((ticket) => {
    const created = utcDay(fieldOf(ticket, field));
    return created === null || created <= end;
  });
  const planned = history.length - added.length;
  const scope = planned + added.length;
  return {
    planned,
    added: added.length,
    addedEstimate: sumEstimates(added).total,
    ratio: scope === 0 ? 0 : Math.round((added.length / scope) * 100) / 100,
  };
}
