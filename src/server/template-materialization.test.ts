import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R31.4/R31.5/R31.18/R31.22 — the shared materializer used by both the manual
 * "new row from template" action and the cron scheduler.
 *
 * The fake transaction records which writes happened in the same unit of work;
 * the unique-claim failure path proves a replayed occurrence never creates a
 * row.
 */

const db = vi.hoisted(() => ({
  propertyFindMany: vi.fn(),
  transaction: vi.fn(),
  tx: {
    page: { findFirst: vi.fn(), create: vi.fn() },
    propertyValue: { createMany: vi.fn() },
    templateRun: { create: vi.fn(), update: vi.fn() },
    template: { update: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    property: { findMany: db.propertyFindMany },
    $transaction: db.transaction,
  },
}));

import { materializeTemplateRow } from "./template-materialization";

const now = new Date(2026, 0, 5, 9, 30);
const scheduledFor = new Date(2026, 0, 5, 9, 0);
const nextRunAt = new Date(2026, 0, 6, 9, 0);

const template = {
  id: "t-1",
  databasePageId: "db-1",
  name: "Weekly {{date}}",
  icon: "🗓️",
  content: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Run {{date}}" }] }],
  },
  config: {
    values: [
      { propertyId: "p-live", value: { text: "Due {{date}}" } },
      { propertyId: "p-stale", value: { text: "gone" } },
    ],
  },
  createdById: "author-1",
};

const database = {
  id: "db-1",
  workspaceId: "ws-1",
  createdById: "db-owner",
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.propertyFindMany.mockResolvedValue([{ id: "p-live" }]);
  db.transaction.mockImplementation(async (fn: (tx: typeof db.tx) => Promise<unknown>) =>
    fn(db.tx),
  );
  db.tx.page.findFirst.mockResolvedValue({ position: 1000 });
  db.tx.page.create.mockResolvedValue({ id: "row-1" });
  db.tx.propertyValue.createMany.mockResolvedValue({ count: 1 });
  db.tx.templateRun.create.mockResolvedValue({});
  db.tx.templateRun.update.mockResolvedValue({});
  db.tx.template.update.mockResolvedValue({});
});

describe("materializeTemplateRow — manual application", () => {
  it("writes a fresh row with the run's variable values, searchText and valid cells only", async () => {
    const result = await materializeTemplateRow({
      template,
      database,
      actorId: "user-1",
      now,
    });

    expect(result).toMatchObject({
      status: "created",
      pageId: "row-1",
      skippedValues: 1,
      occurrenceKey: null,
    });

    const row = db.tx.page.create.mock.calls[0]?.[0] as {
      data: {
        workspaceId: string;
        parentId: string;
        title: string;
        createdById: string;
        searchText: string;
        content: { content: { content: { text: string }[] }[] };
      };
    };
    expect(row.data.workspaceId).toBe("ws-1");
    expect(row.data.parentId).toBe("db-1");
    expect(row.data.title).toBe("Weekly 2026-01-05");
    expect(row.data.createdById).toBe("user-1");
    expect(row.data.searchText).toContain("Run 2026-01-05");
    expect(row.data.content.content[0].content[0].text).toBe("Run 2026-01-05");

    expect(db.tx.propertyValue.createMany).toHaveBeenCalledWith({
      data: [{ propertyId: "p-live", pageId: "row-1", value: { text: "Due 2026-01-05" } }],
    });
    // Manual application never touches the schedule ledger or next run.
    expect(db.tx.templateRun.create).not.toHaveBeenCalled();
    expect(db.tx.template.update).not.toHaveBeenCalled();
  });

  it("refuses a trashed database without writing", async () => {
    const result = await materializeTemplateRow({
      template,
      database: { ...database, deletedAt: new Date() },
      actorId: "user-1",
      now,
    });
    expect(result).toEqual({ status: "unavailable", reason: "database_unavailable" });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("materializeTemplateRow — scheduled occurrence", () => {
  it("claims the occurrence, creates the row and advances nextRunAt in one transaction", async () => {
    const result = await materializeTemplateRow({
      template,
      database,
      actorId: "author-1",
      now,
      occurrence: { scheduledFor, nextRunAt },
    });

    expect(result).toMatchObject({ status: "created", pageId: "row-1" });

    expect(db.tx.templateRun.create).toHaveBeenCalledWith({
      data: {
        templateId: "t-1",
        occurrenceKey: `t-1:${scheduledFor.toISOString()}`,
        scheduledFor,
        ranAt: now,
      },
    });
    expect(db.tx.templateRun.update).toHaveBeenCalledWith({
      where: {
        templateId_occurrenceKey: {
          templateId: "t-1",
          occurrenceKey: `t-1:${scheduledFor.toISOString()}`,
        },
      },
      data: { pageId: "row-1" },
    });
    expect(db.tx.template.update).toHaveBeenCalledWith({
      where: { id: "t-1" },
      data: { nextRunAt, lastRunAt: now },
    });
  });

  it("a replayed occurrence loses the unique claim and creates no row", async () => {
    db.tx.templateRun.create.mockRejectedValue({ code: "P2002" });

    const result = await materializeTemplateRow({
      template,
      database,
      actorId: "author-1",
      now,
      occurrence: { scheduledFor, nextRunAt },
    });

    expect(result).toEqual({
      status: "duplicate",
      occurrenceKey: `t-1:${scheduledFor.toISOString()}`,
    });
    expect(db.tx.page.create).not.toHaveBeenCalled();
    expect(db.tx.propertyValue.createMany).not.toHaveBeenCalled();
    expect(db.tx.template.update).not.toHaveBeenCalled();
  });
});
