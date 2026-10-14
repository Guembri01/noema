/**
 * Sub-tickets & dependency tree: roll-up of child estimates.
 * docs/MISSING_FEATURES.md top gap #1 — parent/child issues exist in the
 * schema, but nothing rolls nested estimates up the tree.
 *
 * Pure functions only: given flat tickets `{ id, parentId?, estimate?, done?,
 * state? }` (plus optional `assigneeId`) this builds the child tree, rolls the
 * estimates up a whole subtree, reports progress / remaining effort and groups
 * a subtree per assignee. No DB, no routes, no React, and never a mutation of
 * the caller's array.
 *
 * Closed-ness: an explicit boolean `done` wins; otherwise `state` is mapped
 * through tickets' `isClosed` (`done` / `cancelled` close). Estimates that are
 * `null`, `undefined` or non-finite count as 0; sums are rounded to 2 decimals
 * so the displayed total and the arithmetic agree.
 *
 * Integrity: `validateTicketTree` reports self-parents, orphans (parent id not
 * in the list) and cycles. Traversals are cycle-guarded, so malformed input
 * yields issues, never an infinite loop.
 */

import { isClosed, UNASSIGNED_BUCKET } from "@/lib/tickets";

export type RollupTicket = {
  id: string;
  /** `null`/absent = top level. */
  parentId?: string | null;
  estimate?: number | null;
  /** Explicit done flag; when present it wins over `state`. */
  done?: boolean;
  /** Ticket status id (e.g. `"done"`, `"cancelled"`), read via `isClosed`. */
  state?: string | null;
  /** Used by {@link rollupByAssignee}; blank/absent falls into `UNASSIGNED_BUCKET`. */
  assigneeId?: string | null;
};

/** Whether a ticket counts as closed: `done` wins, else `state` via `isClosed`. */
export function isTicketClosed(ticket: { done?: boolean; state?: string | null }): boolean {
  if (typeof ticket.done === "boolean") return ticket.done;
  return isClosed(ticket.state ?? "");
}

/** An integrity problem found by {@link validateTicketTree}. */
export type TicketTreeIssue =
  | { kind: "self-parent"; id: string }
  | { kind: "orphan"; id: string; parentId: string }
  /** A parent cycle; `path` is a concrete closed walk (`[a, b, c, a]`). */
  | { kind: "cycle"; path: string[] };

/** A node of the child tree built by {@link buildTicketTree}. */
export type TicketNode<T extends RollupTicket = RollupTicket> = {
  ticket: T;
  children: TicketNode<T>[];
};

const parentOf = (ticket: RollupTicket): string | null => ticket.parentId ?? null;

const finiteEstimate = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** id → that id's direct children, in input order (null bucket = top level). */
function childrenIndex<T extends RollupTicket>(tickets: readonly T[]): Map<string | null, T[]> {
  const groups = new Map<string | null, T[]>();
  for (const ticket of tickets) {
    const key = parentOf(ticket);
    const bucket = groups.get(key);
    if (bucket) bucket.push(ticket);
    else groups.set(key, [ticket]);
  }
  return groups;
}

/**
 * `id` plus every descendant, depth-first pre-order, siblings in input order.
 * Unknown ids yield an empty list; a cycle is visited once (each node appears
 * at most once).
 */
export function subtreeTickets<T extends RollupTicket>(
  tickets: readonly T[],
  rootId: string,
): T[] {
  const root = tickets.find((ticket) => ticket.id === rootId);
  if (!root) return [];
  const groups = childrenIndex(tickets);
  const out: T[] = [];
  const visited = new Set<string>();
  const stack: T[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node.id)) continue; // cycle guard
    visited.add(node.id);
    out.push(node);
    const kids = groups.get(node.id);
    if (kids) for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return out;
}

/**
 * Build the forest of roots. A root is a top-level ticket (`parentId` null or
 * absent) or an orphan (parent id not in the list); children keep input order.
 * Tickets reachable from a root are nested under it; a pure cycle has no root,
 * so its component is omitted here — {@link validateTicketTree} reports it.
 * Ids are assumed unique (the first wins).
 */
export function buildTicketTree<T extends RollupTicket>(tickets: readonly T[]): TicketNode<T>[] {
  const known = new Set(tickets.map((ticket) => ticket.id));
  const groups = childrenIndex(tickets);
  const visited = new Set<string>();

  const build = (ticket: T): TicketNode<T> => {
    visited.add(ticket.id);
    const children: TicketNode<T>[] = [];
    for (const child of groups.get(ticket.id) ?? []) {
      if (visited.has(child.id)) continue; // cycle / already collected
      children.push(build(child));
    }
    return { ticket, children };
  };

  const roots: TicketNode<T>[] = [];
  for (const ticket of tickets) {
    if (visited.has(ticket.id)) continue;
    const parent = parentOf(ticket);
    if (parent !== null && known.has(parent)) continue; // reached via its parent
    roots.push(build(ticket));
  }
  return roots;
}

/**
 * Summed estimate of a subtree (root included), or of the whole set when
 * `rootId` is omitted. Unknown roots sum nothing; missing/non-finite estimates
 * count as 0. Rounded to 2 decimals. Units are not converted — keep one unit
 * per tree (the ticket shape carries a bare number).
 */
export function rollupPoints(tickets: readonly RollupTicket[], rootId?: string | null): number {
  const scope = rootId == null ? tickets : subtreeTickets(tickets, rootId);
  let total = 0;
  for (const ticket of scope) total += finiteEstimate(ticket.estimate);
  return round2(total);
}

/** The roll-up {@link rollupEstimate} reports for one scope. */
export type EstimateRollup = {
  /** The rooted id, or null for the whole set. */
  rootId: string | null;
  /** Σ estimate over every ticket in scope (closed included), 2dp. */
  total: number;
  /** Σ estimate of the open tickets only, 2dp. */
  remaining: number;
  count: number;
  done: number;
  open: number;
};

/**
 * Roll a subtree (or the whole set) up: total estimate, remaining (open only),
 * ticket count and the done/open split. `rootId` is echoed back (normalized to
 * `null` for the whole set); an unknown root rolls up to zeroes.
 */
export function rollupEstimate(
  tickets: readonly RollupTicket[],
  rootId?: string | null,
): EstimateRollup {
  const scope = rootId == null ? tickets : subtreeTickets(tickets, rootId);
  let total = 0;
  let remaining = 0;
  let done = 0;
  for (const ticket of scope) {
    const estimate = finiteEstimate(ticket.estimate);
    total += estimate;
    if (isTicketClosed(ticket)) done += 1;
    else remaining += estimate;
  }
  return {
    rootId: rootId ?? null,
    total: round2(total),
    remaining: round2(remaining),
    count: scope.length,
    done,
    open: scope.length - done,
  };
}

/** A done/open split with a rounded percentage. */
export type TicketProgress = {
  total: number;
  done: number;
  open: number;
  /** `done / total` as a whole percent; 0 when there is nothing. */
  percent: number;
};

/** Progress of a flat set of tickets: done vs total plus the rounded percentage. */
export function progressOf(tickets: readonly RollupTicket[]): TicketProgress {
  const total = tickets.length;
  let done = 0;
  for (const ticket of tickets) if (isTicketClosed(ticket)) done += 1;
  return {
    total,
    done,
    open: total - done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

/** One assignee's share of a subtree roll-up. */
export type AssigneeRollup = {
  /** Assignee id, or `UNASSIGNED_BUCKET`. */
  assigneeId: string;
  count: number;
  /** Number of open tickets assigned. */
  open: number;
  /** Σ estimate over all their tickets in scope, 2dp. */
  points: number;
  /** Σ estimate over their open tickets only, 2dp. */
  remaining: number;
};

/**
 * Group a subtree (or the whole set) per assignee, with total points and the
 * open remainder. Blank/missing assignees bucket under `UNASSIGNED_BUCKET`.
 * Rows sort by points desc, then open desc, then assignee id asc, so the panel
 * renders deterministically.
 */
export function rollupByAssignee(
  tickets: readonly RollupTicket[],
  rootId?: string | null,
): AssigneeRollup[] {
  const scope = rootId == null ? tickets : subtreeTickets(tickets, rootId);
  const buckets = new Map<string, AssigneeRollup>();
  for (const ticket of scope) {
    const raw = ticket.assigneeId?.trim();
    const assigneeId = raw ? raw : UNASSIGNED_BUCKET;
    const bucket =
      buckets.get(assigneeId) ??
      ({ assigneeId, count: 0, open: 0, points: 0, remaining: 0 } satisfies AssigneeRollup);
    bucket.count += 1;
    const estimate = finiteEstimate(ticket.estimate);
    bucket.points += estimate;
    if (!isTicketClosed(ticket)) {
      bucket.open += 1;
      bucket.remaining += estimate;
    }
    buckets.set(assigneeId, bucket);
  }
  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, points: round2(bucket.points), remaining: round2(bucket.remaining) }))
    .sort(
      (a, b) =>
        b.points - a.points || b.open - a.open || a.assigneeId.localeCompare(b.assigneeId),
    );
}

/**
 * Structural problems in `tickets`, in a stable order: self-parent and orphan
 * issues in input order, then one entry per distinct parent cycle (with a
 * concrete closed path). Never throws — malformed data produces issues.
 */
export function validateTicketTree(tickets: readonly RollupTicket[]): TicketTreeIssue[] {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const issues: TicketTreeIssue[] = [];

  for (const ticket of tickets) {
    const parent = parentOf(ticket);
    if (parent === ticket.id) issues.push({ kind: "self-parent", id: ticket.id });
    else if (parent !== null && !byId.has(parent)) {
      issues.push({ kind: "orphan", id: ticket.id, parentId: parent });
    }
  }

  // Walk parent links from every not-yet-settled ticket; the first repeat on
  // the current path is a cycle, reported with the concrete closed path.
  const settled = new Set<string>();
  for (const start of tickets) {
    if (settled.has(start.id)) continue;
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let current: string | null = start.id;
    while (current !== null) {
      if (settled.has(current)) break;
      const at = onPath.get(current);
      if (at !== undefined) {
        issues.push({ kind: "cycle", path: path.slice(at).concat(current) });
        break;
      }
      const ticket = byId.get(current);
      if (!ticket) break; // unknown parent terminates the walk
      if (parentOf(ticket) === ticket.id) break; // self-parent, reported above
      onPath.set(current, path.length);
      path.push(current);
      current = parentOf(ticket);
    }
    for (const id of path) settled.add(id);
  }
  return issues;
}
