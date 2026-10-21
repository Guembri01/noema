import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B30 — the order of the ops gate, measured against the **real** limiter.
 *
 * The other order test (`src/app/api/ops-gate-order.test.ts`) mocks the
 * limiter and therefore only sees the **status** an answer carries. This test
 * measures the thing that actually distinguishes the two orders — **who
 * spends the budget**:
 *
 * - the limit runs **before** the comparison ⇒ a wrong secret spends the
 *   budget ⇒ the attempt after the budget is spent is answered `429`;
 * - the comparison runs first ⇒ a wrong secret never spends the budget ⇒
 *   every attempt is answered `401` and the guessing stays unbounded.
 *
 * The limiter is therefore **not** mocked here (`@/lib/api-guard` and
 * `@/lib/rate-limit` run as they do in production); only the transport edges
 * are — a refused request returns before the route touches the database.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    template: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  },
}));

import { POST as templatesPost } from "./cron/templates/route";

const SECRET = "cron-test-secret";
/** The budget of the cron routes: 12 per minute. */
const BUDGET = 12;

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/cron/templates", {
    method: "POST",
    headers: { "x-forwarded-for": "10.60.0.9", ...headers },
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("POST /api/cron/templates — the limit runs before the comparison", () => {
  it("spends the budget on a wrong secret, so the next attempt is throttled", async () => {
    // The wrong secret is refused — and refused **after** the limit has
    // spent the budget.
    for (let attempt = 0; attempt < BUDGET; attempt += 1) {
      const res = await templatesPost(request({ "x-cron-secret": "wrong" }));
      expect(res.status).toBe(401);
    }

    // The budget is spent: the next attempt is throttled, whatever the secret.
    const throttled = await templatesPost(request({ "x-cron-secret": "wrong" }));
    expect(throttled.status).toBe(429);
  });
});
