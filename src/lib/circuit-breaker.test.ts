import { describe, expect, it } from "vitest";
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_SUCCESS_THRESHOLD,
  canAttempt,
  createBreaker,
  onFailure,
  onSuccess,
  stateName,
  type BreakerState,
} from "@/lib/circuit-breaker";

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const COOLDOWN = 30_000;

const config = { failureThreshold: 3, successThreshold: 2, cooldownMs: COOLDOWN };

/** Drive `count` consecutive failures from `state`, one second apart. */
function failTimes(state: BreakerState, count: number, now = BASE): BreakerState {
  let next = state;
  for (let i = 0; i < count; i += 1) next = onFailure(next, now + i * 1_000);
  return next;
}

/** Effective state plus attemptability at `now`, as one comparable tuple. */
function gating(state: BreakerState, now: number): [string, boolean] {
  return [stateName(state, now), canAttempt(state, now)];
}

describe("createBreaker — initial state and config normalisation", () => {
  it("starts closed, unarmed, using the documented defaults", () => {
    expect(createBreaker()).toStrictEqual({
      failureThreshold: DEFAULT_FAILURE_THRESHOLD,
      successThreshold: DEFAULT_SUCCESS_THRESHOLD,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      phase: "closed",
      failures: 0,
      successes: 0,
      openedAt: null,
    });
  });

  it("is permissive while freshly closed", () => {
    expect(gating(createBreaker(config), BASE)).toStrictEqual(["closed", true]);
  });

  it("floors thresholds to at least 1 and clamps a negative cooldown to 0", () => {
    expect(createBreaker({ failureThreshold: 0, successThreshold: -3, cooldownMs: -100 })).toStrictEqual({
      failureThreshold: 1,
      successThreshold: 1,
      cooldownMs: 0,
      phase: "closed",
      failures: 0,
      successes: 0,
      openedAt: null,
    });
  });

  it("truncates fractional counts and falls back for non-finite values", () => {
    expect(
      createBreaker({
        failureThreshold: 2.9,
        successThreshold: Number.NaN,
        cooldownMs: Number.POSITIVE_INFINITY,
      }),
    ).toStrictEqual({
      failureThreshold: 2,
      successThreshold: DEFAULT_SUCCESS_THRESHOLD,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      phase: "closed",
      failures: 0,
      successes: 0,
      openedAt: null,
    });
  });
});

describe("stateName / canAttempt — gating on the injected clock", () => {
  it("stays closed and permissive below the failure threshold", () => {
    const state = failTimes(createBreaker(config), 2);
    expect(state.failures).toBe(2);
    expect(gating(state, BASE)).toStrictEqual(["closed", true]);
  });

  it("rejects everything while open, up to but not including the cooldown edge", () => {
    const opened = failTimes(createBreaker(config), 3);
    const openedAt = BASE + 2_000;
    expect([
      opened.openedAt,
      ...gating(opened, openedAt),
      canAttempt(opened, openedAt + COOLDOWN - 1),
    ]).toStrictEqual([openedAt, "open", false, false]);
  });

  it("turns half-open exactly at the cooldown boundary and lets a probe through", () => {
    const opened = failTimes(createBreaker(config), 3);
    const edge = BASE + 2_000 + COOLDOWN;
    expect(gating(opened, edge)).toStrictEqual(["half-open", true]);
  });

  it("becomes half-open immediately when the cooldown is zero", () => {
    const opened = failTimes(createBreaker({ ...config, cooldownMs: 0 }), 3);
    expect(gating(opened, BASE + 2_000)).toStrictEqual(["half-open", true]);
  });
});

describe("onFailure — consecutive-failure accounting", () => {
  it("increments the failure counter while closed", () => {
    expect(onFailure(createBreaker(config), BASE)).toStrictEqual({
      failureThreshold: 3,
      successThreshold: 2,
      cooldownMs: COOLDOWN,
      phase: "closed",
      failures: 1,
      successes: 0,
      openedAt: null,
    });
  });

  it("trips open and stamps openedAt once the threshold is reached", () => {
    const opened = failTimes(createBreaker(config), 3);
    expect([opened.phase, opened.openedAt, opened.successes]).toStrictEqual(["open", BASE + 2_000, 0]);
  });

  it("trips on the very first failure when the threshold is 1", () => {
    const opened = onFailure(createBreaker({ ...config, failureThreshold: 1 }), BASE);
    expect([stateName(opened, BASE), opened.openedAt]).toStrictEqual(["open", BASE]);
  });

  it("ignores a failure reported while the breaker is still rejecting", () => {
    const opened = failTimes(createBreaker(config), 3);
    expect(onFailure(opened, BASE + 3_000)).toStrictEqual(opened);
  });
});

describe("onSuccess in the closed state", () => {
  it("clears accumulated consecutive failures and stays closed", () => {
    const cleared = onSuccess(failTimes(createBreaker(config), 2), BASE + 10_000);
    expect([cleared.failures, cleared.phase]).toStrictEqual([0, "closed"]);
  });

  it("resets the count so an intervening success prevents a later trip", () => {
    let state = createBreaker(config);
    state = onFailure(state, BASE);
    state = onFailure(state, BASE + 1);
    state = onSuccess(state, BASE + 2);
    state = onFailure(state, BASE + 3);
    state = onFailure(state, BASE + 4);
    expect([state.failures, stateName(state, BASE + 4)]).toStrictEqual([2, "closed"]);
  });

  it("ignores a success reported while the breaker is still rejecting", () => {
    const opened = failTimes(createBreaker(config), 3);
    expect(onSuccess(opened, BASE + 3_000)).toStrictEqual(opened);
  });
});

describe("half-open probes", () => {
  it("accumulates probe successes without closing below successThreshold", () => {
    const opened = failTimes(createBreaker(config), 3);
    const edge = BASE + 2_000 + COOLDOWN;
    const one = onSuccess(opened, edge);
    expect([one.successes, stateName(one, edge)]).toStrictEqual([1, "half-open"]);
  });

  it("closes and resets once successThreshold probe successes land", () => {
    const opened = failTimes(createBreaker(config), 3);
    const edge = BASE + 2_000 + COOLDOWN;
    const closed = onSuccess(onSuccess(opened, edge), edge);
    expect([stateName(closed, edge), closed.failures, closed.successes, closed.openedAt]).toStrictEqual([
      "closed",
      0,
      0,
      null,
    ]);
  });

  it("closes on the first probe when successThreshold is 1", () => {
    const opened = failTimes(createBreaker({ ...config, successThreshold: 1 }), 3);
    const edge = BASE + 2_000 + COOLDOWN;
    expect(stateName(onSuccess(opened, edge), edge)).toBe("closed");
  });

  it("re-opens with a fresh cooldown when a probe fails", () => {
    const opened = failTimes(createBreaker(config), 3);
    const edge = BASE + 2_000 + COOLDOWN;
    const reopened = onFailure(onSuccess(opened, edge), edge + 500);
    expect([
      reopened.phase,
      reopened.openedAt,
      reopened.successes,
      canAttempt(reopened, edge + 500),
      stateName(reopened, edge + 500 + COOLDOWN),
    ]).toStrictEqual(["open", edge + 500, 0, false, "half-open"]);
  });
});

describe("lifecycle, purity and determinism", () => {
  it("walks closed → open → half-open → closed across the clock", () => {
    const breaker = { failureThreshold: 2, successThreshold: 2, cooldownMs: 1_000 };
    let state = createBreaker(breaker);
    state = onFailure(state, BASE);
    state = onFailure(state, BASE + 1);
    const openedAt = BASE + 1;
    const beforeEdge = stateName(state, openedAt + 999);
    state = onSuccess(state, openedAt + 1_000);
    const probedName = stateName(state, openedAt + 1_000);
    state = onSuccess(state, openedAt + 1_001);
    expect([
      beforeEdge,
      probedName,
      stateName(state, openedAt + 1_001),
      canAttempt(state, openedAt + 1_001),
    ]).toStrictEqual(["open", "half-open", "closed", true]);
  });

  it("never mutates the state it is handed", () => {
    const opened = failTimes(createBreaker(config), 3);
    const snapshot = JSON.stringify(opened);
    onSuccess(opened, BASE + COOLDOWN);
    onFailure(opened, BASE + COOLDOWN);
    canAttempt(opened, BASE + COOLDOWN);
    stateName(opened, BASE + COOLDOWN);
    expect(JSON.stringify(opened)).toBe(snapshot);
  });

  it("returns the same value for the same input on repeated calls", () => {
    const state = createBreaker(config);
    expect(onFailure(state, BASE)).toStrictEqual(onFailure(state, BASE));
    expect(onSuccess(state, BASE)).toStrictEqual(onSuccess(state, BASE));
    expect(gating(state, BASE)).toStrictEqual(gating(state, BASE));
  });
});
