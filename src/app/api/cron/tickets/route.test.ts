import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * `POST /api/cron/tickets` — guards and aggregation.
 *
 * The durable/idempotent work lives in
 * `materializeRecurringTicketRunAction` (proved in
 * `src/server/actions/automations.test.ts`); this suite pins the route's own
 * contract: fail closed without `CRON_SECRET`, materialize exactly the due
 * schedules it was handed, aggregate created/skipped/failed, and report the
 * next run. The action module is the transport edge mocked here.
 */

type DueRow = {
  id: string;
  workspaceId: string;
  nextRunAt: Date | null;
};

type RunResult =
  | { ok: true; created: number; skipped: boolean; keys: string[]; nextRunAt: string | null }
  | { error: string };

const store = vi.hoisted(() => ({
  due: [] as DueRow[],
  scheduled: 0,
  listError: null as string | null,
  calls: [] as { secret: string; id: string; now: string }[],
  results: new Map<string, RunResult>(),
}));

vi.mock("@/server/actions/automations", () => ({
  listDueAutomationsForCronAction: vi.fn(async () =>
    store.listError
      ? { error: store.listError }
      : {
          ok: true,
          scheduled: Array.from({ length: store.scheduled }, () => ({})),
          recurring: store.due,
        },
  ),
  materializeRecurringTicketRunAction: vi.fn(
    async (input: { secret: string; id: string; now: string }) => {
      store.calls.push(input);
      return (
        store.results.get(input.id) ?? {
          ok: true,
          created: 1,
          skipped: false,
          keys: [],
          nextRunAt: null,
        }
      );
    },
  ),
}));

import { POST } from "./route";

const SECRET = "cron-test-secret";
const NOW = "2026-01-03T12:00:00.000Z";

const call = (headers: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost/api/cron/tickets", {
      method: "POST",
      headers: {
        "x-cron-secret": SECRET,
        "x-forwarded-for": "10.57.0.9",
        ...headers,
      },
    }),
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.CRON_SECRET = SECRET;
  store.due = [];
  store.scheduled = 0;
  store.listError = null;
  store.calls = [];
  store.results = new Map();
  vi.clearAllMocks();
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CRON_SECRET;
});

describe("POST /api/cron/tickets — guards", () => {
  it("fails closed when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const response = await call();
    expect(response.status).toBe(503);
    expect(store.calls).toHaveLength(0);
  });

  it("rejects a wrong secret before touching the store", async () => {
    const response = await call({ "x-cron-secret": "nope" });
    expect(response.status).toBe(401);
    expect(store.calls).toHaveLength(0);
  });

  it("returns 403 when the durable rule read is refused", async () => {
    store.listError = "Unauthorized";
    const response = await call();
    expect(response.status).toBe(403);
  });
});

describe("POST /api/cron/tickets — materialization", () => {
  it("runs each due schedule once and aggregates the outcomes", async () => {
    store.due = [
      { id: "a", workspaceId: "ws-1", nextRunAt: new Date("2026-01-04T00:00:00.000Z") },
      { id: "b", workspaceId: "ws-1", nextRunAt: null },
    ];
    store.scheduled = 2;
    store.results.set("a", {
      ok: true,
      created: 2,
      skipped: false,
      keys: ["a:1", "a:2"],
      nextRunAt: "2026-01-04T00:00:00.000Z",
    });
    store.results.set("b", {
      ok: true,
      created: 0,
      skipped: true,
      keys: [],
      nextRunAt: null,
    });

    const response = await call();
    const body = await response.json();

    expect(store.calls).toEqual([
      { secret: SECRET, id: "a", now: NOW },
      { secret: SECRET, id: "b", now: NOW },
    ]);
    expect(body).toMatchObject({
      scheduledAutomations: 2,
      recurring: { due: 2, created: 2, skipped: 1, failed: [] },
      upcoming: [
        { id: "a", nextRunAt: "2026-01-04T00:00:00.000Z" },
        { id: "b", nextRunAt: null },
      ],
    });
  });

  it("reports a failed materialization without aborting the other schedules", async () => {
    store.due = [
      { id: "bad", workspaceId: "ws-1", nextRunAt: null },
      { id: "good", workspaceId: "ws-1", nextRunAt: null },
    ];
    store.results.set("bad", { error: "Workspace not found." });
    store.results.set("good", {
      ok: true,
      created: 1,
      skipped: false,
      keys: ["good:1"],
      nextRunAt: null,
    });

    const response = await call();
    const body = await response.json();

    expect(body.recurring.created).toBe(1);
    expect(body.recurring.failed).toEqual([
      { id: "bad", error: "Workspace not found." },
    ]);
  });

  it("does nothing when no schedule is due", async () => {
    const response = await call();
    const body = await response.json();

    expect(store.calls).toHaveLength(0);
    expect(body.recurring).toEqual({ due: 0, created: 0, skipped: 0, failed: [] });
  });
});
