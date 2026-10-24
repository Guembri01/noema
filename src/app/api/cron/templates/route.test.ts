import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * B57 — D3 defect coverage (docs/specs/templates.md D3 / R31.5, R31.23):
 * the cron loop had no per-template try/catch and no transaction — one poison
 * template (dangling `propertyId`, failing row insert) 500'd the request and
 * wedged every later due template; a crash between the row create and the
 * `nextRunAt` advance could double-create on the next tick.
 *
 * Written RED-first against `route.ts` as shipped (old behaviour in brackets):
 * - poison first in the queue → old: POST rejects (no try/catch) [red]
 * - dangling config.values id → old: FK throw inside createMany, 500 [red]
 * - materialization not run through `prisma.$transaction` [red]
 * - advance computed from `new Date()` → 09:37 jitter drifts a 09:00 schedule [red]
 * - `{ due, created }` response has no `skipped`/`failed` [red]
 * Guards (503/401) are characterization tests — green from the start, they
 * prove the D3 fix did not weaken the fail-closed edge.
 *
 * Only transport edges (`@/lib/db`) are mocked; the guard, rate limiter and
 * response shaping run for real.
 */

const db = vi.hoisted(() => ({
  templateFindMany: vi.fn(),
  templateUpdate: vi.fn(),
  pageFindUnique: vi.fn(),
  pageFindFirst: vi.fn(),
  pageCreate: vi.fn(),
  propertyFindMany: vi.fn(),
  propertyValueCreateMany: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
  tx: {
    page: { findFirst: vi.fn(), create: vi.fn() },
    propertyValue: { createMany: vi.fn() },
    template: { update: vi.fn() },
    templateRun: { create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    template: { findMany: db.templateFindMany, update: db.templateUpdate },
    page: {
      findUnique: db.pageFindUnique,
      findFirst: db.pageFindFirst,
      create: db.pageCreate,
    },
    property: { findMany: db.propertyFindMany },
    propertyValue: { createMany: db.propertyValueCreateMany },
    activity: { create: db.activityCreate },
    $transaction: db.transaction,
  },
}));

import { POST as cron } from "./route";

const SECRET = "cron-test-secret";
const DATABASE = { workspaceId: "ws-1", createdById: "user-1", deletedAt: null };

const template = (over: Record<string, unknown> = {}) => ({
  id: "t-ok",
  databasePageId: "db-1",
  name: "Standup",
  icon: "🗓️",
  content: null,
  config: null,
  recurrence: "daily",
  nextRunAt: new Date(2026, 0, 1, 9, 0),
  ...over,
});

const call = (headers: Record<string, string> = {}) =>
  cron(
    new Request("http://localhost/api/cron/templates", {
      method: "POST",
      headers: {
        "x-cron-secret": SECRET,
        "x-forwarded-for": "10.57.0.1",
        ...headers,
      },
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  process.env.CRON_SECRET = SECRET;
  db.transaction.mockImplementation(async (fn: (tx: typeof db.tx) => Promise<unknown>) =>
    fn(db.tx),
  );
  db.templateFindMany.mockResolvedValue([template()]);
  db.pageFindUnique.mockResolvedValue(DATABASE);
  db.pageCreate.mockResolvedValue({ id: "row-legacy" });
  db.pageFindFirst.mockResolvedValue({ position: 1000 });
  db.propertyFindMany.mockResolvedValue([]);
  db.propertyValueCreateMany.mockResolvedValue({ count: 0 });
  db.templateUpdate.mockResolvedValue({});
  db.tx.page.findFirst.mockResolvedValue({ position: 1000 });
  db.tx.page.create.mockResolvedValue({ id: "row-1" });
  db.tx.propertyValue.createMany.mockResolvedValue({ count: 0 });
  db.tx.template.update.mockResolvedValue({});
  db.tx.templateRun.create.mockResolvedValue({});
  db.tx.templateRun.update.mockResolvedValue({});
  db.activityCreate.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CRON_SECRET;
});

describe("guards (characterization — must not weaken)", () => {
  it("503 when CRON_SECRET is unset (fail closed)", async () => {
    delete process.env.CRON_SECRET;
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("CRON_SECRET"),
    });
  });

  it("401 on a wrong x-cron-secret", async () => {
    const res = await call({ "x-cron-secret": "nope" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});

describe("D3 — per-template isolation", () => {
  it("a failing first template lands in failed[] and later due templates still materialize", async () => {
    db.templateFindMany.mockResolvedValue([
      template({ id: "t-boom", name: "boom-template" }),
      template({ id: "t-ok", name: "ok-template" }),
    ]);
    db.tx.page.create.mockImplementation(async (args: { data: { title: string } }) => {
      if (args.data.title === "boom-template") throw new Error("constraint violated");
      return { id: "row-ok" };
    });

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ due: 2, created: 1, skipped: 0 });
    expect(body.failed).toEqual([{ id: "t-boom", error: "constraint violated" }]);

    // The healthy template advanced — inside the materialization transaction.
    // Both templates enter a transaction; the poison one's rejects (rolls
    // back whole), the healthy one's commits and carries the advance.
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(db.tx.template.update).toHaveBeenCalledWith({
      where: { id: "t-ok" },
      data: { nextRunAt: expect.any(Date), lastRunAt: expect.any(Date) },
    });
    // …while the poison template never advanced (retried next tick) and was
    // never advanced outside the transaction either.
    expect(db.tx.template.update).toHaveBeenCalledTimes(1);
    expect(db.templateUpdate).not.toHaveBeenCalled();
  });

  it("stale config.values propertyIds are skipped and counted — the row still materializes", async () => {
    db.templateFindMany.mockResolvedValue([
      template({
        id: "t-poison",
        config: {
          values: [
            { propertyId: "p-live", value: { text: "hi" } },
            { propertyId: "p-deleted", value: { text: "stale" } },
          ],
        },
      }),
    ]);
    db.propertyFindMany.mockResolvedValue([{ id: "p-live" }]);
    // The poison path as shipped: a dangling id reaching createMany violates
    // the FK on PropertyValue.propertyId.
    db.propertyValueCreateMany.mockImplementation(
      async (args: { data: { propertyId: string }[] }) => {
        if (args.data.some((entry) => entry.propertyId === "p-deleted")) {
          throw new Error('FOREIGN KEY constraint failed: "PropertyValue_propertyId_fkey"');
        }
        return { count: args.data.length };
      },
    );

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ due: 1, created: 1, skipped: 1 });
    expect(body.failed).toEqual([]);
    // The write path is transactional and only carries the surviving values.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.pageCreate).not.toHaveBeenCalled();
    expect(db.tx.propertyValue.createMany).toHaveBeenCalledWith({
      data: [{ propertyId: "p-live", pageId: "row-1", value: { text: "hi" } }],
    });
  });

  it("a crash inside the materialization transaction loses row AND advance together (no double-create)", async () => {
    db.templateFindMany.mockResolvedValue([
      template({
        id: "t-flaky",
        config: { values: [{ propertyId: "p-live", value: { text: "hi" } }] },
      }),
    ]);
    db.propertyFindMany.mockResolvedValue([{ id: "p-live" }]);
    db.tx.propertyValue.createMany.mockRejectedValue(new Error("deadlock detected"));

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ created: 0 });
    expect(body.failed).toEqual([{ id: "t-flaky", error: "deadlock detected" }]);
    // The advance is part of the same transaction — it must not have run, so
    // the next tick retries instead of the row existing twice.
    expect(db.tx.template.update).not.toHaveBeenCalled();
    expect(db.templateUpdate).not.toHaveBeenCalled();
  });
});

describe("D4 — the cron advances from the stored schedule", () => {
  it("execution jitter cannot drift the schedule: stored 09:00 advances to tomorrow 09:00", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 9, 37)); // cron fired 37 min late
    db.templateFindMany.mockResolvedValue([
      template({ id: "t-drift", nextRunAt: new Date(2026, 0, 1, 9, 0) }), // scheduled 09:00
    ]);

    const res = await call();
    const body = await res.json();
    expect(body).toMatchObject({ created: 1 });
    expect(db.tx.template.update).toHaveBeenCalledWith({
      where: { id: "t-drift" },
      data: { nextRunAt: new Date(2026, 0, 2, 9, 0), lastRunAt: expect.any(Date) }, // NOT 09:37
    });
  });

  it("catch-up: a 12-day-stale schedule produces one row and jumps past now, time pinned", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 9, 37));
    db.templateFindMany.mockResolvedValue([
      template({ id: "t-stale", nextRunAt: new Date(2025, 11, 20, 9, 0) }),
    ]);

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ created: 1 });
    const advanced = db.tx.template.update.mock.calls[0]?.[0] as {
      data: { nextRunAt: Date };
    };
    // Strictly in the future → not re-due next tick (no per-missed-tick flood)…
    expect(advanced.data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    // …and still pinned to the 09:00 schedule.
    expect(advanced.data.nextRunAt).toEqual(new Date(2026, 0, 2, 9, 0));
  });

  it("monthly month-end end-to-end: anchor Jan 31 clamps Feb 28 and remembers Mar 31", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 1, 0, 5)); // Mar 1 00:05
    db.templateFindMany.mockResolvedValue([
      template({
        id: "t-monthly",
        recurrence: "monthly",
        nextRunAt: new Date(2026, 1, 28, 9, 0), // Feb 28 09:00 (clamped run)
        config: { anchorAt: new Date(2026, 0, 31, 9, 0).toISOString() },
      }),
    ]);

    const res = await call();
    expect(res.status).toBe(200);
    expect(db.tx.template.update).toHaveBeenCalledWith({
      where: { id: "t-monthly" },
      data: { nextRunAt: new Date(2026, 2, 31, 9, 0), lastRunAt: expect.any(Date) }, // Mar 31 — Feb was not skipped
    });
  });
});

describe("D3 — preserved skip semantics", () => {
  it("missing/trashed database: skipped + advanced, later templates still run", async () => {
    db.templateFindMany.mockResolvedValue([
      template({ id: "t-gone" }),
      template({ id: "t-ok" }),
    ]);
    db.pageFindUnique.mockResolvedValueOnce(null).mockResolvedValue(DATABASE);

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ due: 2, created: 1, skipped: 1, failed: [] });
    expect(db.templateUpdate).toHaveBeenCalledWith({
      where: { id: "t-gone" },
      data: { nextRunAt: expect.any(Date) },
    });
    expect(db.tx.template.update).toHaveBeenCalledWith({
      where: { id: "t-ok" },
      data: { nextRunAt: expect.any(Date), lastRunAt: expect.any(Date) },
    });
  });
});

describe("R31.22 — durable idempotency and pause", () => {
  it("queries only unpaused schedules", async () => {
    db.templateFindMany.mockResolvedValue([]);
    await call();
    expect(db.templateFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ paused: false, recurrence: { not: null } }),
      }),
    );
  });

  it("a concurrent/replayed tick loses the unique occurrence claim without creating a row", async () => {
    db.templateFindMany.mockResolvedValue([template({ id: "t-claim" })]);
    db.tx.templateRun.create.mockRejectedValue({ code: "P2002" });

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ due: 1, created: 0, skipped: 1, failed: [] });
    expect(db.tx.page.create).not.toHaveBeenCalled();
    expect(db.tx.template.update).not.toHaveBeenCalled();
    expect(db.templateUpdate).toHaveBeenCalledWith({
      where: { id: "t-claim" },
      data: { nextRunAt: expect.any(Date) },
    });
  });

  it("claims the stored scheduled instant, not the execution time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 9, 37));
    db.templateFindMany.mockResolvedValue([
      template({ id: "t-claim", nextRunAt: new Date(2026, 0, 1, 9, 0) }),
    ]);

    await call();
    expect(db.tx.templateRun.create).toHaveBeenCalledWith({
      data: {
        templateId: "t-claim",
        occurrenceKey: `t-claim:${new Date(2026, 0, 1, 9, 0).toISOString()}`,
        scheduledFor: new Date(2026, 0, 1, 9, 0),
        ranAt: new Date(2026, 0, 1, 9, 37),
      },
    });
  });

  it("attributes the row to the template creator and records a system activity actor", async () => {
    db.templateFindMany.mockResolvedValue([
      template({ id: "t-actor", createdById: "template-author" }),
    ]);

    await call();
    const row = db.tx.page.create.mock.calls[0]?.[0] as {
      data: { createdById: string };
    };
    expect(row.data.createdById).toBe("template-author");
    expect(db.activityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: null,
        action: "page.created",
        meta: expect.objectContaining({
          source: "template-schedule",
          templateId: "t-actor",
          attributedTo: "template-author",
        }),
      }),
    });
  });

  it("resolves template variables against the run time (R31.18)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 9, 30));
    db.templateFindMany.mockResolvedValue([
      template({
        id: "t-vars",
        name: "Weekly report {{date}}",
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Run on {{date}}" }] },
          ],
        },
        nextRunAt: new Date(2026, 0, 5, 9, 0),
      }),
    ]);

    await call();
    const row = db.tx.page.create.mock.calls[0]?.[0] as {
      data: {
        title: string;
        searchText: string;
        content: { content: { content: { text: string }[] }[] };
      };
    };
    expect(row.data.title).toBe("Weekly report 2026-01-05");
    expect(row.data.searchText).toContain("Run on 2026-01-05");
    expect(row.data.content.content[0].content[0].text).toBe("Run on 2026-01-05");
  });
});
