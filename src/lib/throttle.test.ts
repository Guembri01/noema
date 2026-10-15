import { describe, expect, it } from "vitest";
import {
  THROTTLE_INITIAL_STATE,
  createThrottle,
  type ThrottleState,
} from "@/lib/throttle";

const leadingOnly = () => createThrottle({ intervalMs: 1000 });
const trailingOnly = () =>
  createThrottle({ intervalMs: 1000, leading: false, trailing: true });
const both = () =>
  createThrottle({ intervalMs: 1000, leading: true, trailing: true });

describe("throttle config", () => {
  it("defaults to a leading-only throttle", () => {
    const t = leadingOnly();
    expect(t.intervalMs).toBe(1000);
    expect(t.leading).toBe(true);
    expect(t.trailing).toBe(false);
  });

  it("rejects a non-positive or non-finite interval", () => {
    expect(() => createThrottle({ intervalMs: 0 })).toThrow(RangeError);
    expect(() => createThrottle({ intervalMs: -1 })).toThrow(RangeError);
    expect(() => createThrottle({ intervalMs: Number.NaN })).toThrow(RangeError);
  });

  it("rejects a throttle with neither edge enabled", () => {
    expect(() =>
      createThrottle({ intervalMs: 1000, leading: false, trailing: false }),
    ).toThrow(RangeError);
  });
});

describe("leading-only throttle", () => {
  it("calls on the first event and then suppresses inside the window", () => {
    const t = leadingOnly();
    const first = t.onEvent(THROTTLE_INITIAL_STATE, 0);
    expect(first.call).toBe(true);
    expect(first.nextAt).toBe(1000);

    const second = t.onEvent(first.state, 1);
    expect(second.call).toBe(false);
    expect(second.nextAt).toBe(1000); // reopens at lastCallAt + intervalMs
    expect(second.state).toEqual(first.state); // suppression keeps state intact
  });

  it("reopens exactly at the interval boundary (inclusive)", () => {
    const t = leadingOnly();
    const first = t.onEvent(THROTTLE_INITIAL_STATE, 0);
    expect(t.onEvent(first.state, 999).call).toBe(false);
    const reopened = t.onEvent(first.state, 1000);
    expect(reopened.call).toBe(true);
    expect(reopened.state.lastCallAt).toBe(1000);
  });

  it("paces a long, irregular timeline to one call per interval", () => {
    const t = leadingOnly();
    let state = THROTTLE_INITIAL_STATE;
    const calls: number[] = [];
    for (const now of [0, 100, 200, 1000, 1500, 2001, 4000]) {
      const r = t.onEvent(state, now);
      state = r.state;
      if (r.call) calls.push(now);
    }
    expect(calls).toEqual([0, 1000, 2001, 4000]);
  });
});

describe("trailing-only throttle", () => {
  it("schedules the first call instead of calling immediately", () => {
    const t = trailingOnly();
    const r = t.onEvent(THROTTLE_INITIAL_STATE, 0);
    expect(r.call).toBe(false);
    expect(r.state.lastCallAt).toBeNull();
    expect(r.state.pendingAt).toBe(1000);
    expect(r.nextAt).toBe(1000);
  });

  it("fires one trailing call when the scheduled time arrives", () => {
    const t = trailingOnly();
    const scheduled = t.onEvent(THROTTLE_INITIAL_STATE, 0);
    const flush = t.onEvent(scheduled.state, 1000);
    expect(flush.call).toBe(true);
    expect(flush.state.lastCallAt).toBe(1000);
    expect(flush.state.pendingAt).toBeNull();
    expect(flush.nextAt).toBe(2000);
  });

  it("collapses several missed windows into a single (late) call", () => {
    const t = trailingOnly();
    const scheduled = t.onEvent(THROTTLE_INITIAL_STATE, 0); // due at 1000
    const late = t.onEvent(scheduled.state, 1500);
    expect(late.call).toBe(true);
    expect(late.state.lastCallAt).toBe(1000); // anchored to the schedule
    expect(late.state.pendingAt).toBeNull();
  });

  it("rebases to the next window after a call instead of drifting", () => {
    const t = trailingOnly();
    const s0 = t.onEvent(THROTTLE_INITIAL_STATE, 0);
    const fired = t.onEvent(s0.state, 1000);
    const quiet = t.onEvent(fired.state, 5000); // reopen: schedule, don't call
    expect(quiet.call).toBe(false);
    expect(quiet.state.pendingAt).toBe(6000);
  });
});

describe("leading + trailing throttle", () => {
  it("emits one leading call then one trailing call for a burst", () => {
    const t = both();
    let state = THROTTLE_INITIAL_STATE;
    const calls: number[] = [];
    for (const now of [0, 300, 600, 900]) {
      const r = t.onEvent(state, now);
      state = r.state;
      if (r.call) calls.push(now);
    }
    const trailing = t.onEvent(state, 1000);
    expect(calls).toEqual([0]); // only the leading call so far
    expect(trailing.call).toBe(true); // trailing flush at the window end
    expect(trailing.state.lastCallAt).toBe(1000);
  });

  it("keeps the trailing call pinned to the window end as events pile up", () => {
    const t = both();
    const lead = t.onEvent(THROTTLE_INITIAL_STATE, 0);
    const a = t.onEvent(lead.state, 200);
    const b = t.onEvent(a.state, 700);
    expect(a.nextAt).toBe(1000);
    expect(b.nextAt).toBe(1000); // never drifts past lastCallAt + intervalMs
    expect(t.onEvent(b.state, 1000).call).toBe(true);
  });

  it("schedules no trailing call when no event arrived during the window", () => {
    const t = both();
    const lead = t.onEvent(THROTTLE_INITIAL_STATE, 0);
    expect(lead.state.pendingAt).toBeNull();
    const quiet = t.onEvent(lead.state, 1000); // window reopened, nothing pending
    expect(quiet.call).toBe(true);
    expect(quiet.state.pendingAt).toBeNull();
  });

  it("lets an event landing exactly on the trailing time flush it", () => {
    const t = both();
    const lead = t.onEvent(THROTTLE_INITIAL_STATE, 0);
    const suppressed = t.onEvent(lead.state, 400);
    const exact = t.onEvent(suppressed.state, 1000);
    expect(suppressed.call).toBe(false);
    expect(exact.call).toBe(true);
  });
});

describe("reset and isThrottled", () => {
  it("reports not-throttled before the first call and throttled inside the window", () => {
    const t = leadingOnly();
    expect(t.isThrottled(THROTTLE_INITIAL_STATE, 0)).toBe(false);
    const first = t.onEvent(THROTTLE_INITIAL_STATE, 0);
    expect(t.isThrottled(first.state, 500)).toBe(true);
    expect(t.isThrottled(first.state, 1000)).toBe(false);
  });

  it("keeps isThrottled the exact negation of the next decision", () => {
    const t = both();
    let state: ThrottleState = THROTTLE_INITIAL_STATE;
    for (const now of [0, 250, 500, 1000, 1200]) {
      const r = t.onEvent(state, now);
      expect(t.isThrottled(state, now)).toBe(!r.call);
      state = r.state;
    }
  });

  it("reset returns the shared initial state", () => {
    const t = both();
    const lead = t.onEvent(THROTTLE_INITIAL_STATE, 0);
    const used = t.onEvent(lead.state, 300);
    expect(t.reset()).toEqual(THROTTLE_INITIAL_STATE);
    expect(t.reset()).toBe(THROTTLE_INITIAL_STATE);
    expect(used.state.pendingAt).not.toBeNull();
  });

  it("never mutates the state it is handed", () => {
    const t = both();
    const snapshot: ThrottleState = { lastCallAt: 0, pendingAt: null };
    const frozen = Object.freeze(snapshot);
    const r = t.onEvent(frozen, 300);
    expect(snapshot).toEqual({ lastCallAt: 0, pendingAt: null });
    expect(r.state).not.toBe(frozen);
  });
});
