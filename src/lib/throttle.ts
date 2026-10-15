/**
 * Deterministic throttle scheduling math (no timers).
 *
 * This is the *pure* core of a throttle: given an injected clock value
 * `now`, it decides whether an event produces a call and when the next
 * call may happen. Callers own the timer (or event loop) and simply feed
 * `now` in — nothing here reads the wall clock, so a given timeline
 * replays identically.
 *
 * Window semantics (a "window" lasts `intervalMs`):
 *  - `leading: true`  → the first event of a burst calls immediately.
 *  - `trailing: true` → events suppressed during a window schedule a
 *    single call for the end of that window (at `lastCallAt + intervalMs`).
 *  - Both together give the familiar "call now, and again at the end if
 *    more events arrived" behaviour.
 *
 * State is immutable: `onEvent` derives and returns a new state and never
 * mutates the one it is handed, so callers can diff or replay timelines.
 *
 * The scheduler drives this by calling `onEvent` whenever an event arrives
 * *or* when the previous result's `nextAt` is reached, passing that
 * timestamp as `now` (the latter flushes a pending trailing call).
 */

export type ThrottleConfig = {
  /** Minimum spacing between calls, in milliseconds. Must be > 0. */
  intervalMs: number;
  /** Call on the leading edge of a window. Defaults to `true`. */
  leading?: boolean;
  /** Schedule a single call at the trailing edge of a window. Defaults to `false`. */
  trailing?: boolean;
};

export type ThrottleState = {
  /** Time of the most recent call, or `null` before the first call. */
  lastCallAt: number | null;
  /** Time a trailing call is due, or `null` when none is scheduled. */
  pendingAt: number | null;
};

export type ThrottleResult = {
  /** Whether an event at `now` should invoke the throttled function. */
  call: boolean;
  /**
   * Earliest time the next call may happen — the scheduled trailing call,
   * or when the current window reopens.
   */
  nextAt?: number;
  /** The state to carry into the next `onEvent` (immutable). */
  state: ThrottleState;
};

export type Throttle = {
  readonly intervalMs: number;
  readonly leading: boolean;
  readonly trailing: boolean;
  /** Decide whether an event at `now` calls, plus the state to carry on. */
  onEvent(state: ThrottleState, now: number): ThrottleResult;
  /** True when an event at `now` would be suppressed (i.e. `!call`). */
  isThrottled(state: ThrottleState, now: number): boolean;
  /** Fresh state for a new timeline. */
  reset(): ThrottleState;
};

/** Shared idle state; returned by every `reset()` (frozen, never mutated). */
export const THROTTLE_INITIAL_STATE: ThrottleState = Object.freeze({
  lastCallAt: null,
  pendingAt: null,
});

export function createThrottle(config: ThrottleConfig): Throttle {
  const { intervalMs } = config;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("throttle intervalMs must be a finite number > 0");
  }
  const leading = config.leading ?? true;
  const trailing = config.trailing ?? false;
  if (!leading && !trailing) {
    throw new RangeError("throttle needs leading or trailing enabled");
  }

  function decide(state: ThrottleState, now: number): ThrottleResult {
    const { lastCallAt, pendingAt } = state;

    // 1) A pending trailing call is due: flush it. Anchoring `lastCallAt`
    //    to the scheduled time (not the wake time) keeps a late scheduler
    //    from shifting the window and collapsing missed calls into one.
    if (pendingAt !== null && now >= pendingAt) {
      return {
        call: true,
        nextAt: pendingAt + intervalMs,
        state: { lastCallAt: pendingAt, pendingAt: null },
      };
    }

    // 2) A trailing call is already scheduled and not yet due: we are
    //    inside that window. Keep the anchor fixed — later events do not
    //    push the pending call further out.
    if (pendingAt !== null) {
      return { call: false, nextAt: pendingAt, state };
    }

    // 3) Never called yet: honour the leading edge, else schedule trailing.
    if (lastCallAt === null) {
      if (leading) {
        return {
          call: true,
          nextAt: now + intervalMs,
          state: { lastCallAt: now, pendingAt: null },
        };
      }
      const pending = now + intervalMs;
      return {
        call: false,
        nextAt: pending,
        state: { lastCallAt: null, pendingAt: pending },
      };
    }

    // 4) The window has reopened → a new leading edge.
    if (now - lastCallAt >= intervalMs) {
      if (leading) {
        return {
          call: true,
          nextAt: now + intervalMs,
          state: { lastCallAt: now, pendingAt: null },
        };
      }
      const pending = now + intervalMs;
      return {
        call: false,
        nextAt: pending,
        state: { lastCallAt, pendingAt: pending },
      };
    }

    // 5) Inside the open window: suppress, but remember one trailing call
    //    pinned to the window end (`lastCallAt + intervalMs`).
    if (trailing) {
      const pending = lastCallAt + intervalMs;
      return {
        call: false,
        nextAt: pending,
        state: { lastCallAt, pendingAt: pending },
      };
    }
    return { call: false, nextAt: lastCallAt + intervalMs, state };
  }

  return {
    intervalMs,
    leading,
    trailing,
    onEvent(state, now) {
      return decide(state, now);
    },
    isThrottled(state, now) {
      return !decide(state, now).call;
    },
    reset() {
      return THROTTLE_INITIAL_STATE;
    },
  };
}
