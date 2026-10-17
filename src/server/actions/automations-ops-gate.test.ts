import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * B30 — the ops gate on the **action** surface.
 *
 * `src/server/actions/automations.ts` exports server actions from a
 * `"use server"` file: they are HTTP endpoints of their own (the cron tick
 * calls them in-process, an attacker calls them over HTTP). The gate there
 * is a *deployment-wide* budget of 120 calls per minute
 * (`checkRateLimit`), keyed by the **configured** secret — never by the
 * presented one, or every guess would get a fresh bucket and the limit
 * would be useless.
 *
 * This suite deliberately does **not** mock `@/lib/rate-limit`: the real
 * `checkRateLimit` runs, the bucket is really spent, and the assertion is
 * the observable contract:
 *
 *   - the first 120 calls with 120 *different* wrong secrets answer
 *     "Unauthorized", the **121st** answers "Rate limit exceeded." — the
 *     guesses share one bucket, so the guessing is bounded;
 *   - the correct secret is limited from the 121st call on: that is the
 *     documented price of a deployment-wide budget (an attacker who spends
 *     it slows the legitimate tick down).
 *
 * The transport edges (the session, the database, `next/cache`) are mocked;
 * the limiter is not.
 */

const db = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findUnique: db.memberFindUnique },
    workspace: { findUnique: db.workspaceFindUnique },
  },
}));

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  commitRecurringRunAction,
  listDueAutomationsForCronAction,
} from "./automations";

const SECRET = "b30-action-secret";

/** A wrong secret — every call presents a different one. */
const guess = (index: number): string => `wrong-secret-${index}`;

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  process.env.CRON_SECRET = SECRET;
  db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("the cron action gate — the budget is spent before the secret is compared", () => {
  it("spends one shared bucket: 120 different wrong secrets, the 121st call is over budget", async () => {
    const answers: string[] = [];
    for (let index = 0; index < 121; index += 1) {
      const result = await listDueAutomationsForCronAction(guess(index));
      answers.push("error" in result ? result.error : "ok");
    }

    // The first 120 guesses are answered with "Unauthorized" …
    expect(answers.slice(0, 120).every((answer) => answer === "Unauthorized")).toBe(true);
    // … the 121st is over budget — the measured index of the first limited
    // call. A key built from the *guess* would answer "Unauthorized" here
    // and never be limited.
    expect(answers.findIndex((answer) => answer === "Rate limit exceeded.")).toBe(120);
    expect(answers[120]).toBe("Rate limit exceeded.");
  });

  it("does not hand a fresh bucket to a varying guess (the key is the configured secret)", async () => {
    // 119 wrong secrets …
    for (let index = 0; index < 119; index += 1) {
      await expect(listDueAutomationsForCronAction(guess(index))).resolves.toEqual({
        error: "Unauthorized",
      });
    }
    // … then the correct secret uses the 120th and last slot …
    await expect(listDueAutomationsForCronAction(SECRET)).resolves.toMatchObject({ ok: true });
    // … and the next call is over budget, whatever secret it presents.
    await expect(listDueAutomationsForCronAction(guess(500))).resolves.toEqual({
      error: "Rate limit exceeded.",
    });
  });

  it("limits the correct secret from the 121st call on (the documented price)", async () => {
    for (let index = 0; index < 120; index += 1) {
      await listDueAutomationsForCronAction(guess(index));
    }
    await expect(listDueAutomationsForCronAction(SECRET)).resolves.toEqual({
      error: "Rate limit exceeded.",
    });
  });

  it("guards the second action with the same budget", async () => {
    for (let index = 0; index < 120; index += 1) {
      await listDueAutomationsForCronAction(guess(index));
    }
    await expect(
      commitRecurringRunAction({
        secret: SECRET,
        id: "recur-1",
        keys: [],
        spawnedAt: new Date(0).toISOString(),
      }),
    ).resolves.toEqual({ error: "Rate limit exceeded." });
  });
});
