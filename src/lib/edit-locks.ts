/**
 * Coarse edit locks (§7 "Coarse edit locks") — the pure, headless lease engine.
 *
 * Before a full CRDT, a page still needs a way to stop two people from writing
 * over each other. This module owns that decision table without touching the
 * DB, a socket, React or the clock: a caller passes the current lock table and
 * an explicit `now`, and gets back the next table plus the lock it should
 * persist.
 *
 * A lock is a lease on a page with a *scope*:
 *
 * - a **`structural`** lock is a full takeover — while it is live, no other
 *   holder may acquire anything on that page;
 * - a **`content`** lock composes — several holders may hold a content lock on
 *   one page at once (their typing is expected to merge), but a content lock
 *   still blocks anybody else from taking the structural lock underneath them.
 *
 * A lease lapses the instant `now` reaches its `expiresAt` (the boundary itself
 * counts as expired), so a crashed editor cannot wedge a page forever;
 * {@link heartbeat} is how a live editor keeps it. Only an owner/admin (with
 * `force`) or an already-expired lease may be {@link steal}-ed. Everything is
 * immutable: no function mutates its arguments and every result is fresh, so a
 * React store can compare identities.
 */

/** How a lock was taken: a full page takeover or a composable content edit. */
export type EditLockScope = "structural" | "content";

/**
 * One live (or lapsed) edit lease. `acquiredAt` is when the holder first took
 * the page, `heartbeatAt` the last sign of life, and `expiresAt` when the lease
 * lapses — all epoch milliseconds.
 */
export type EditLock = {
  pageId: string;
  holderId: string;
  holderName: string;
  scope: EditLockScope;
  acquiredAt: number;
  expiresAt: number;
  heartbeatAt: number;
};

/**
 * A workspace role, reduced to the values the steal rule reads. Unknown or
 * differently-cased values are tolerated by {@link isPrivilegedRole}, which
 * fails closed for anything that is not an owner or admin.
 */
export type EditLockRole = "owner" | "admin" | "member" | "guest";

/**
 * Default lease length. A holder must {@link heartbeat} within this window or
 * the lock expires and another editor may take it.
 */
export const LOCK_TTL_MS = 60_000;

/** Options for {@link acquire}. */
export type AcquireOptions = {
  pageId: string;
  holderId: string;
  scope: EditLockScope;
  /** Epoch millis to acquire at. */
  now: number;
  /** Lease length; defaults to {@link LOCK_TTL_MS}. */
  ttlMs?: number;
  /** Display name stored on the lock; defaults to `holderId`. */
  holderName?: string;
};

/** Options for {@link heartbeat}. */
export type HeartbeatOptions = {
  pageId: string;
  holderId: string;
  /** Epoch millis to refresh at. */
  now: number;
  /** Lease length to re-grant; defaults to {@link LOCK_TTL_MS}. */
  ttlMs?: number;
};

/** Options for {@link release}. */
export type ReleaseOptions = {
  pageId: string;
  holderId: string;
  /** Epoch millis; accepted for symmetry (release is unconditional). */
  now?: number;
};

/** Options for {@link steal}. */
export type StealOptions = {
  pageId: string;
  newHolderId: string;
  /** Epoch millis to steal at. */
  now: number;
  /** Required to take a live lock from another holder. */
  force?: boolean;
  /** The actor's workspace role; only owner/admin may force a steal. */
  byRole?: unknown;
  /** Display name stored on the new lock; defaults to `newHolderId`. */
  newHolderName?: string;
  /** Lease length; defaults to {@link LOCK_TTL_MS}. */
  ttlMs?: number;
};

/** Options for {@link canEdit}. */
export type CanEditOptions = {
  pageId: string;
  holderId: string;
  scope: EditLockScope;
  now: number;
};

/** Options for {@link listLocks}. */
export type ListLocksOptions = {
  pageId: string;
};

/** The outcome of {@link acquire}: the lock to persist, or the blocker. */
export type AcquireResult =
  | { ok: true; lock: EditLock; locks: EditLock[] }
  | { ok: false; error: "held"; holder: EditLock };

/** The outcome of {@link heartbeat}: the refreshed lock, or that it lapsed. */
export type HeartbeatResult =
  | { ok: true; lock: EditLock; locks: EditLock[] }
  | { ok: false; error: "not_held" };

/** The outcome of {@link release}: the pruned table and whether anything went. */
export type ReleaseResult = {
  ok: true;
  released: boolean;
  locks: EditLock[];
};

/** The outcome of {@link steal}: the new lock, or a forbidden refusal. */
export type StealResult =
  | { ok: true; lock: EditLock; locks: EditLock[] }
  | { ok: false; error: "forbidden" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A finite epoch millis, else `0`. */
function toMillis(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Fresh, validated copies of a lock table; malformed rows are dropped. */
function normalizeLocks(locks: readonly EditLock[] | null | undefined): EditLock[] {
  if (!Array.isArray(locks)) return [];
  const out: EditLock[] = [];
  for (const raw of locks) {
    if (!isRecord(raw)) continue;
    const pageId = typeof raw.pageId === "string" ? raw.pageId : "";
    const holderId = typeof raw.holderId === "string" ? raw.holderId : "";
    if (pageId === "" || holderId === "") continue;
    out.push({
      pageId,
      holderId,
      holderName: typeof raw.holderName === "string" ? raw.holderName : "",
      scope: raw.scope === "structural" ? "structural" : "content",
      acquiredAt: toMillis(raw.acquiredAt),
      expiresAt: toMillis(raw.expiresAt),
      heartbeatAt: toMillis(raw.heartbeatAt),
    });
  }
  return out;
}

/** The lease length to use: a positive finite override, else the default. */
function resolveTtl(ttlMs: unknown): number {
  return typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : LOCK_TTL_MS;
}

/**
 * Whether a lease has lapsed at `now`. The boundary instant counts as expired,
 * so a lease is live only while `now < expiresAt`. A non-finite `now` is
 * treated as "not expired" (fail-safe: never expire on a bad clock).
 */
function isExpired(lock: EditLock, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  return now >= lock.expiresAt;
}

/** A live lease, i.e. the inverse of {@link isExpired}. */
function isLive(lock: EditLock, now: number): boolean {
  return !isExpired(lock, now);
}

/** Does a live lock `other` (by another holder) block a request of `scope`? */
function blocks(lock: EditLock, scope: EditLockScope): boolean {
  return lock.scope === "structural" || scope === "structural";
}

/** The display name to store: a non-blank name, else the holder's id. */
function holderNameFor(name: unknown, holderId: string): string {
  return typeof name === "string" && name.trim() !== "" ? name.trim() : holderId;
}

/** Case-insensitive owner/admin check; everything else fails closed. */
function isPrivilegedRole(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const role = value.trim().toUpperCase();
  return role === "OWNER" || role === "ADMIN";
}

/**
 * Take (or refresh) the edit lock on a page.
 *
 * - A free or lapsed page yields a fresh lock.
 * - The same holder re-acquiring refreshes the lease, preserving `acquiredAt`
 *   and swapping in the requested scope/name.
 * - A live lock by another holder refuses with `{ error: "held", holder }` —
 *   a structural lock blocks any scope, and any other lock blocks a structural
 *   request, so a content request succeeds only beside other content locks.
 *
 * The returned table drops the page's lapsed locks; locks on other pages are
 * left untouched. Neither the input nor its entries are mutated.
 */
export function acquire(
  locks: readonly EditLock[] | null | undefined,
  options: AcquireOptions,
): AcquireResult {
  const list = normalizeLocks(locks);
  const { pageId, holderId, scope } = options;
  const now = options.now;
  const ttl = resolveTtl(options.ttlMs);

  const blocker = list.find(
    (entry) => entry.pageId === pageId && entry.holderId !== holderId && isLive(entry, now) && blocks(entry, scope),
  );
  if (blocker) return { ok: false, error: "held", holder: blocker };

  const own = list.find((entry) => entry.pageId === pageId && entry.holderId === holderId && isLive(entry, now));
  const lock: EditLock = {
    pageId,
    holderId,
    holderName: holderNameFor(options.holderName, holderId),
    scope,
    acquiredAt: own ? own.acquiredAt : now,
    expiresAt: now + ttl,
    heartbeatAt: now,
  };

  const next: EditLock[] = [];
  let placed = false;
  for (const entry of list) {
    if (entry.pageId === pageId && entry.holderId === holderId) {
      if (!placed) {
        next.push(lock);
        placed = true;
      }
      continue;
    }
    if (entry.pageId === pageId && isExpired(entry, now)) continue;
    next.push(entry);
  }
  if (!placed) next.push(lock);
  return { ok: true, lock, locks: next };
}

/**
 * Refresh a held lease: bump `heartbeatAt` and push `expiresAt` out by the ttl.
 * A lease already at or past its expiry is gone, so this reports `not_held`
 * rather than resurrecting it. `acquiredAt` and the scope are preserved, and
 * other holders' locks are untouched.
 */
export function heartbeat(
  locks: readonly EditLock[] | null | undefined,
  options: HeartbeatOptions,
): HeartbeatResult {
  const list = normalizeLocks(locks);
  const { pageId, holderId } = options;
  const now = options.now;
  const ttl = resolveTtl(options.ttlMs);

  const index = list.findIndex(
    (entry) => entry.pageId === pageId && entry.holderId === holderId && isLive(entry, now),
  );
  if (index === -1) return { ok: false, error: "not_held" };

  const lock: EditLock = { ...list[index], heartbeatAt: now, expiresAt: now + ttl };
  const next = list.map((entry, i) => (i === index ? lock : entry));
  return { ok: true, lock, locks: next };
}

/**
 * Drop every lock the holder has on the page. Unconditional and idempotent —
 * a lapsed lease is cleaned up too, and a holder with no lock is a no-op. The
 * input table is never mutated.
 */
export function release(
  locks: readonly EditLock[] | null | undefined,
  options: ReleaseOptions,
): ReleaseResult {
  const list = normalizeLocks(locks);
  const { pageId, holderId } = options;
  const next = list.filter((entry) => !(entry.pageId === pageId && entry.holderId === holderId));
  return { ok: true, released: next.length < list.length, locks: next };
}

/**
 * Force a takeover of a page's live lock.
 *
 * - A vacant page or one whose only locks have lapsed is simply taken.
 * - A live lock by another holder needs both `force` and an owner/admin
 *   `byRole`; anything else is refused with `{ error: "forbidden" }`.
 *
 * On success every lock on the page is replaced by one fresh lock for the new
 * holder, inheriting the stolen scope (or `structural` when nothing was held).
 */
export function steal(
  locks: readonly EditLock[] | null | undefined,
  options: StealOptions,
): StealResult {
  const list = normalizeLocks(locks);
  const { pageId, newHolderId } = options;
  const now = options.now;
  const ttl = resolveTtl(options.ttlMs);

  const liveOthers = list.filter(
    (entry) => entry.pageId === pageId && entry.holderId !== newHolderId && isLive(entry, now),
  );
  const mayForce = options.force === true && isPrivilegedRole(options.byRole);
  if (liveOthers.length > 0 && !mayForce) return { ok: false, error: "forbidden" };

  const own = list.find(
    (entry) => entry.pageId === pageId && entry.holderId === newHolderId && isLive(entry, now),
  );
  const lock: EditLock = {
    pageId,
    holderId: newHolderId,
    holderName: holderNameFor(options.newHolderName, newHolderId),
    scope: liveOthers[0]?.scope ?? own?.scope ?? "structural",
    acquiredAt: now,
    expiresAt: now + ttl,
    heartbeatAt: now,
  };
  const next = [...list.filter((entry) => entry.pageId !== pageId), lock];
  return { ok: true, lock, locks: next };
}

/** Drop every lapsed lock; a non-finite `now` keeps them all (fail-safe). */
export function sweepExpired(
  locks: readonly EditLock[] | null | undefined,
  now: number,
): EditLock[] {
  return normalizeLocks(locks).filter((entry) => isLive(entry, now));
}

/**
 * May `holderId` perform a `scope` edit on the page right now? True when the
 * page is unlocked, the holder owns a lock, or the only live locks are other
 * holders' content locks and the request is a content edit. A live lock by
 * anyone else blocks a structural request, and any structural lock blocks all
 * requests.
 */
export function canEdit(
  locks: readonly EditLock[] | null | undefined,
  options: CanEditOptions,
): boolean {
  const list = normalizeLocks(locks);
  const { pageId, holderId, scope } = options;
  const now = options.now;
  return !list.some(
    (entry) =>
      entry.pageId === pageId &&
      entry.holderId !== holderId &&
      isLive(entry, now) &&
      blocks(entry, scope),
  );
}

/**
 * Every lock on a page as a fresh, deterministic list: oldest acquisition
 * first, ties broken by holder id so two callers render the same order. Lapsed
 * locks are included — callers that want only live ones should
 * {@link sweepExpired} first.
 */
export function listLocks(
  locks: readonly EditLock[] | null | undefined,
  options: ListLocksOptions,
): EditLock[] {
  return normalizeLocks(locks)
    .filter((entry) => entry.pageId === options.pageId)
    .sort((a, b) => {
      if (a.acquiredAt !== b.acquiredAt) return a.acquiredAt - b.acquiredAt;
      if (a.holderId === b.holderId) return 0;
      return a.holderId < b.holderId ? -1 : 1;
    });
}

/**
 * A one-line, human-facing summary for a chip or tooltip:
 * `"Alice editing structure · expires in 42s"`, the same with `"expired"`, or
 * `"No lock"` for a missing lock. Blank holder names fall back to the id (then
 * `"Unknown"`).
 */
export function describeLock(lock: EditLock | null | undefined, now: number): string {
  if (!lock) return "No lock";
  const name = holderNameFor(lock.holderName, lock.holderId) || "Unknown";
  const label = lock.scope === "structural" ? "structure" : "content";
  if (isExpired(lock, now)) return `Lock expired (was ${name} editing ${label})`;
  const remainingMs = Number.isFinite(now) ? lock.expiresAt - now : 0;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return `${name} editing ${label} · expires in ${seconds}s`;
}
