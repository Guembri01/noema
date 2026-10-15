/**
 * Session idle-timeout math — the pure, deterministic core.
 *
 * A live session is a single `SessionState` carrying two epoch-ms instants:
 *
 *  - `lastActivityAt` — when the session was last used;
 *  - `expiresAt`      — the hard deadline the session is currently scheduled
 *                       to end at (the earlier of the idle deadline and the
 *                       absolute ceiling).
 *
 * Two clocks drive it:
 *
 *  - the IDLE window (`idleMs`): silence ends the session, so `touch` slides
 *    the deadline to `now + idleMs`;
 *  - the ABSOLUTE ceiling (`maxMs`): a cap a single touch may not schedule
 *    past — the deadline is clipped to `now + maxMs`.
 *
 * `SessionState` deliberately carries no creation timestamp, so the ceiling is
 * anchored to `now` on every call. A caller enforcing a fixed lifetime from
 * session creation passes the remaining budget as `maxMs`
 * (`maxMs = startedAt + capMs - now`), which keeps the bound absolute across
 * touches; `refresh` restarts the whole window from scratch.
 *
 * `now` is injected everywhere and nothing reads the wall clock, the DB or the
 * environment, so identical inputs always produce identical state.
 * `touch`/`refresh` return new objects and never mutate their input.
 */

/** A session's live timing, in milliseconds since the epoch. */
export type SessionState = {
  /** Instant of the last activity. */
  lastActivityAt: number;
  /** Current hard deadline; the session is over at (and after) this instant. */
  expiresAt: number;
};

/** Inputs that shape a keep-alive `touch`. */
export type TouchOptions = {
  /** Idle window granted from `now`; the session dies after this much silence. */
  idleMs: number;
  /** Absolute ceiling: the deadline is never scheduled past `now + maxMs`. */
  maxMs: number;
};

/** Inputs for `refresh`, which restarts the session's clock. */
export type RefreshOptions = {
  /** Fresh absolute window: the new deadline is `now + maxMs`. */
  maxMs: number;
};

/** Inputs for `shouldWarn`. */
export type WarnOptions = {
  /** Warn once at most this many ms remain (while time is still left). */
  warnBeforeMs: number;
};

/** Coerce a window to a finite, non-negative number; bad input ⇒ 0. */
function windowMs(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Record activity at `now` and slide the deadline to `now + idleMs`, clipped
 * to the absolute ceiling `now + maxMs`. Returns a new state; the input is
 * left untouched. Pure: a caller that must not resurrect a dead session should
 * check `shouldExpire` before touching it.
 */
export function touch(state: SessionState, now: number, options: TouchOptions): SessionState {
  const idle = windowMs(options.idleMs);
  const ceiling = windowMs(options.maxMs);
  return {
    lastActivityAt: now,
    expiresAt: now + Math.min(idle, ceiling),
  };
}

/**
 * Restart the session at `now`: activity is stamped now and the deadline is a
 * fresh absolute window, `now + maxMs`. Expressed as a touch with no idle
 * slack, so both clocks reset together. Returns a new state.
 */
export function refresh(state: SessionState, now: number, options: RefreshOptions): SessionState {
  const maxMs = windowMs(options.maxMs);
  return touch(state, now, { idleMs: maxMs, maxMs });
}

/**
 * Milliseconds until `state.expiresAt`, clamped to `[0, ∞)`: zero exactly at
 * the deadline and once it has passed, never negative.
 */
export function remainingMs(state: SessionState, now: number): number {
  return Math.max(0, state.expiresAt - now);
}

/**
 * Whether the session is over at `now`. Inclusive and fail-closed: the exact
 * deadline already counts as expired (`now >= expiresAt`).
 */
export function shouldExpire(state: SessionState, now: number): boolean {
  return now >= state.expiresAt;
}

/**
 * Whether to warn that the session is about to end: time is still left
 * (`remainingMs > 0`) and at most `warnBeforeMs` of it. A non-positive window
 * never warns, and an already-expired session does not warn — it expires.
 */
export function shouldWarn(state: SessionState, now: number, options: WarnOptions): boolean {
  const remaining = remainingMs(state, now);
  return remaining > 0 && remaining <= windowMs(options.warnBeforeMs);
}
