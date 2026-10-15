import { describe, expect, it } from "vitest";
import {
  refresh,
  remainingMs,
  shouldExpire,
  shouldWarn,
  touch,
  type SessionState,
} from "./session-timeout";

/**
 * Session idle-timeout math — the pure, deterministic core.
 *
 * Red-first: this file was written BEFORE `src/lib/session-timeout.ts` existed,
 * so every import resolved to module-not-found and collection failed. It pins a
 * two-clock session model over a single `SessionState = { lastActivityAt,
 * expiresAt }` (epoch ms, `now` injected):
 *
 *  - `touch`    slides the deadline to `now + idleMs`, clipped to the absolute
 *               ceiling `now + maxMs`, and stamps the activity;
 *  - `refresh`  restarts the absolute window (`now + maxMs`);
 *  - `remainingMs` / `shouldExpire` / `shouldWarn` read the stored deadline.
 *
 * Nothing reads the wall clock, so identical inputs always give identical
 * state — every assertion below is deterministic.
 */

const NOW = 1_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A live-ish session: active now, an hour of headroom. */
const state = (overrides: Partial<SessionState> = {}): SessionState => ({
  lastActivityAt: NOW,
  expiresAt: NOW + HOUR,
  ...overrides,
});

describe("touch — idle window and absolute ceiling", () => {
  it("slides the deadline by the idle window when it fits under the ceiling", () => {
    const next = touch(state({ lastActivityAt: NOW - 5 * MIN, expiresAt: NOW + 10 * MIN }), NOW, {
      idleMs: 30 * MIN,
      maxMs: HOUR,
    });
    expect(next.lastActivityAt).toBe(NOW);
    expect(next.expiresAt).toBe(NOW + 30 * MIN);
  });

  it("clips the deadline to the absolute ceiling when the idle window is larger", () => {
    expect(touch(state(), NOW, { idleMs: 4 * HOUR, maxMs: HOUR }).expiresAt).toBe(NOW + HOUR);
  });

  it("treats an idle window equal to the ceiling as the ceiling", () => {
    expect(touch(state(), NOW, { idleMs: HOUR, maxMs: HOUR }).expiresAt).toBe(NOW + HOUR);
  });

  it("always stamps `now` as the latest activity", () => {
    expect(touch(state({ lastActivityAt: 0 }), NOW, { idleMs: MIN, maxMs: HOUR }).lastActivityAt).toBe(
      NOW,
    );
  });

  it("clamps a zero or negative idle window to an immediate deadline", () => {
    expect(touch(state(), NOW, { idleMs: 0, maxMs: HOUR }).expiresAt).toBe(NOW);
    expect(touch(state(), NOW, { idleMs: -MIN, maxMs: HOUR }).expiresAt).toBe(NOW);
  });

  it("clamps a negative ceiling to zero, so the deadline is now", () => {
    expect(touch(state(), NOW, { idleMs: MIN, maxMs: -HOUR }).expiresAt).toBe(NOW);
  });

  it("is deterministic and does not mutate its input", () => {
    const before = state({ lastActivityAt: 0, expiresAt: NOW });
    const snapshot = { ...before };
    expect(touch(before, NOW, { idleMs: MIN, maxMs: HOUR })).toEqual(
      touch(before, NOW, { idleMs: MIN, maxMs: HOUR }),
    );
    expect(before).toEqual(snapshot);
  });
});

describe("remainingMs", () => {
  it("counts down to the stored deadline", () => {
    expect(remainingMs(state({ expiresAt: NOW + 90 * MIN }), NOW)).toBe(90 * MIN);
    expect(remainingMs(state({ expiresAt: NOW + 90 * MIN }), NOW + 30 * MIN)).toBe(60 * MIN);
  });

  it("is zero exactly at the deadline", () => {
    expect(remainingMs(state({ expiresAt: NOW }), NOW)).toBe(0);
  });

  it("never goes negative once the deadline has passed", () => {
    expect(remainingMs(state({ expiresAt: NOW - HOUR }), NOW)).toBe(0);
  });

  it("depends only on the deadline, not on lastActivityAt", () => {
    expect(remainingMs(state({ lastActivityAt: 0, expiresAt: NOW + MIN }), NOW)).toBe(MIN);
    expect(remainingMs(state({ lastActivityAt: NOW - HOUR, expiresAt: NOW + MIN }), NOW)).toBe(MIN);
  });
});

describe("shouldExpire", () => {
  it("is false while time remains", () => {
    expect(shouldExpire(state({ expiresAt: NOW + 1 }), NOW)).toBe(false);
  });

  it("is true exactly at the deadline (inclusive, fail-closed)", () => {
    expect(shouldExpire(state({ expiresAt: NOW }), NOW)).toBe(true);
  });

  it("is true after the deadline", () => {
    expect(shouldExpire(state({ expiresAt: NOW - HOUR }), NOW)).toBe(true);
  });
});

describe("shouldWarn", () => {
  it("is false while more than the warning window remains", () => {
    expect(shouldWarn(state({ expiresAt: NOW + 10 * MIN }), NOW, { warnBeforeMs: 5 * MIN })).toBe(
      false,
    );
  });

  it("is true exactly at the warning boundary", () => {
    expect(shouldWarn(state({ expiresAt: NOW + 5 * MIN }), NOW, { warnBeforeMs: 5 * MIN })).toBe(
      true,
    );
  });

  it("is true inside the warning window", () => {
    expect(shouldWarn(state({ expiresAt: NOW + MIN }), NOW, { warnBeforeMs: 5 * MIN })).toBe(true);
  });

  it("does not warn once the session has expired", () => {
    expect(shouldWarn(state({ expiresAt: NOW }), NOW, { warnBeforeMs: 5 * MIN })).toBe(false);
    expect(shouldWarn(state({ expiresAt: NOW - MIN }), NOW, { warnBeforeMs: 5 * MIN })).toBe(false);
  });

  it("never warns for a non-positive warning window", () => {
    expect(shouldWarn(state({ expiresAt: NOW + MIN }), NOW, { warnBeforeMs: 0 })).toBe(false);
    expect(shouldWarn(state({ expiresAt: NOW + MIN }), NOW, { warnBeforeMs: -MIN })).toBe(false);
  });
});

describe("refresh", () => {
  it("restarts activity and the absolute window from `now`", () => {
    const next = refresh(state({ lastActivityAt: 0, expiresAt: 0 }), NOW, { maxMs: 8 * HOUR });
    expect(next.lastActivityAt).toBe(NOW);
    expect(next.expiresAt).toBe(NOW + 8 * HOUR);
  });

  it("can push a nearer deadline further out", () => {
    expect(refresh(state({ expiresAt: NOW + MIN }), NOW, { maxMs: HOUR }).expiresAt).toBe(NOW + HOUR);
  });

  it("clamps a negative window to an immediate deadline", () => {
    expect(refresh(state(), NOW, { maxMs: -HOUR }).expiresAt).toBe(NOW);
  });

  it("does not mutate its input", () => {
    const before = state({ lastActivityAt: 0, expiresAt: 0 });
    const snapshot = { ...before };
    refresh(before, NOW, { maxMs: HOUR });
    expect(before).toEqual(snapshot);
  });
});

describe("composition — a touch and its consequences", () => {
  it("warns near the end and expires exactly on the idle deadline", () => {
    const touched = touch(state(), NOW, { idleMs: 30 * MIN, maxMs: HOUR });
    expect(remainingMs(touched, NOW)).toBe(30 * MIN);
    expect(shouldExpire(touched, NOW + 30 * MIN - 1)).toBe(false);
    expect(shouldWarn(touched, NOW + 25 * MIN, { warnBeforeMs: 5 * MIN })).toBe(true);
    expect(shouldExpire(touched, NOW + 30 * MIN)).toBe(true);
    expect(shouldWarn(touched, NOW + 30 * MIN, { warnBeforeMs: 5 * MIN })).toBe(false);
  });
});
