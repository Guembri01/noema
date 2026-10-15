/**
 * Circuit breaker — a pure, time-injected state machine over ms epochs.
 *
 * A breaker guards a fallible dependency (a webhook target, an AI provider, a
 * remote fetch) by tracking how it fails. It is *closed* by default: calls are
 * allowed and consecutive failures are counted. When `failureThreshold`
 * consecutive failures land it *opens* at the failure instant, rejecting calls
 * until `cooldownMs` has elapsed. After the cooldown it is *half-open*: a probe
 * is let through, and `successThreshold` consecutive probe successes close it
 * again while a single probe failure re-opens it with a fresh cooldown.
 *
 * Everything is pure and deterministic. The current time is always an explicit
 * `now` argument (epoch ms), never `Date.now()`, so the same inputs give the
 * same result on any machine. `half-open` is *derived* — a breaker stores only
 * `closed` / `open`; it reads as half-open once `now` reaches
 * `openedAt + cooldownMs`. That keeps `stateName` and `canAttempt` in exact
 * agreement at every instant without mutating on read. No DB, no routes, no
 * React, and nothing the caller passes is ever mutated.
 */

/** Reported breaker state for an injected `now`. */
export type BreakerName = "closed" | "open" | "half-open";

/** Stored phase; `half-open` is derived from `open` + the cooldown winding down. */
export type BreakerPhase = "closed" | "open";

/** Tuning for a breaker; every field is optional and normalised on creation. */
export type BreakerConfig = {
  /** Consecutive failures that trip a closed breaker open. Defaults to {@link DEFAULT_FAILURE_THRESHOLD}. */
  failureThreshold?: number;
  /** Consecutive probe successes that close a half-open breaker. Defaults to {@link DEFAULT_SUCCESS_THRESHOLD}. */
  successThreshold?: number;
  /** Time (ms) an open breaker rejects before going half-open. Defaults to {@link DEFAULT_COOLDOWN_MS}. */
  cooldownMs?: number;
};

/** A breaker's full persistent state. Treat as immutable; transitions return copies. */
export type BreakerState = {
  /** Normalised trip threshold, always `>= 1`. */
  failureThreshold: number;
  /** Normalised recovery threshold, always `>= 1`. */
  successThreshold: number;
  /** Normalised cooldown in ms, always `>= 0`. */
  cooldownMs: number;
  /** The stored phase; `half-open` is derived from `open` and `now`. */
  phase: BreakerPhase;
  /** Consecutive failures observed while closed. */
  failures: number;
  /** Consecutive probe successes observed while effectively half-open. */
  successes: number;
  /** Epoch ms the breaker opened; `null` while it has never opened. */
  openedAt: number | null;
};

/** Trip threshold used when a config omits `failureThreshold`. */
export const DEFAULT_FAILURE_THRESHOLD = 5;

/** Recovery threshold used when a config omits `successThreshold`. */
export const DEFAULT_SUCCESS_THRESHOLD = 2;

/** Cooldown in ms used when a config omits `cooldownMs`. */
export const DEFAULT_COOLDOWN_MS = 30_000;

/** Coerce a threshold to a whole count of at least 1, falling back on non-finite input. */
function toCount(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/** Coerce a duration to a whole, non-negative number of ms, falling back on non-finite input. */
function toDuration(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/**
 * Create a fresh, closed breaker from `config`, normalising every field:
 * thresholds become whole numbers `>= 1`, the cooldown a whole number `>= 0`,
 * and non-finite values fall back to the documented defaults.
 */
export function createBreaker(config: BreakerConfig = {}): BreakerState {
  return {
    failureThreshold: toCount(config.failureThreshold, DEFAULT_FAILURE_THRESHOLD),
    successThreshold: toCount(config.successThreshold, DEFAULT_SUCCESS_THRESHOLD),
    cooldownMs: toDuration(config.cooldownMs, DEFAULT_COOLDOWN_MS),
    phase: "closed",
    failures: 0,
    successes: 0,
    openedAt: null,
  };
}

/** Whether an open breaker has served its cooldown and may now be probed. */
function isHalfOpen(state: BreakerState, now: number): boolean {
  return (
    state.phase === "open" &&
    state.openedAt !== null &&
    now - state.openedAt >= state.cooldownMs
  );
}

/**
 * The breaker's effective state at `now`: `closed`, `open`, or `half-open`.
 * An open breaker reports `half-open` once `now` reaches `openedAt + cooldownMs`
 * (the boundary instant is inclusive).
 */
export function stateName(state: BreakerState, now: number): BreakerName {
  if (state.phase === "closed") return "closed";
  return isHalfOpen(state, now) ? "half-open" : "open";
}

/**
 * Whether a call may be attempted at `now`. True while `closed` or `half-open`;
 * false while `open` (before the cooldown elapses).
 */
export function canAttempt(state: BreakerState, now: number): boolean {
  return stateName(state, now) !== "open";
}

/**
 * Record a success at `now`.
 *
 * - `closed`: clear the consecutive-failure count and stay closed;
 * - `half-open`: count the probe success, closing and resetting once
 *   `successThreshold` are reached;
 * - `open` (still rejecting): ignored, since no probe was permitted.
 */
export function onSuccess(state: BreakerState, now: number): BreakerState {
  const name = stateName(state, now);
  if (name === "open") return state;
  if (name === "closed") return { ...state, failures: 0, successes: 0 };
  const successes = state.successes + 1;
  if (successes >= state.successThreshold) {
    return { ...state, phase: "closed", failures: 0, successes: 0, openedAt: null };
  }
  return { ...state, successes };
}

/**
 * Record a failure at `now`.
 *
 * - `closed`: count the consecutive failure, tripping open (and stamping
 *   `openedAt`) once `failureThreshold` is reached;
 * - `half-open`: re-open immediately with a fresh cooldown starting at `now`
 *   and the probe-success count cleared;
 * - `open` (still rejecting): ignored, since no probe was permitted.
 */
export function onFailure(state: BreakerState, now: number): BreakerState {
  const name = stateName(state, now);
  if (name === "open") return state;
  if (name === "half-open") {
    return { ...state, phase: "open", failures: state.failureThreshold, successes: 0, openedAt: now };
  }
  const failures = state.failures + 1;
  if (failures >= state.failureThreshold) {
    return { ...state, phase: "open", failures, successes: 0, openedAt: now };
  }
  return { ...state, failures };
}
