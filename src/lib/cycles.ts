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

export type CycleTicket = TicketLike & {
  completedAt?: string | Date | null;
  /** Used to place the completion on the burndown axis. */
  updatedAt?: string | Date | null;
};

const DAY = 24 * 60 * 60 * 1000;

const at = (value: string | Date) => (value instanceof Date ? value : new Date(value));

/** Whole days between two instants (inclusive), floored at 1. */
export function cycleDays(cycle: CycleLike): number {
  const span = at(cycle.endDate).getTime() - at(cycle.startDate).getTime();
  return Math.max(1, Math.round(span / DAY) + 1);
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
  cycle: CycleLike,
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
  const start = at(cycle.startDate).getTime();
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
