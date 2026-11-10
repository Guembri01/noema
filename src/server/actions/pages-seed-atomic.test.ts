import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1-T01 — `createPageAction` must write the page and its database seed as
 * one atomic unit: a `DATABASE` page whose seed half-committed leaves
 * permanently broken properties/views, so everything commits through one
 * transaction.
 *
 * The fake prisma models real commit semantics: writes issued against the
 * global client land in the ledger immediately (auto-commit), while writes
 * issued inside `$transaction` are enqueued and only enter the ledger when
 * the callback resolves — a rejection discards the enqueue, i.e. nothing
 * survives a rollback.
 */

const state = vi.hoisted(() => {
  const behavior = {
    workspaceFindUnique: vi.fn(),
    pageFindFirst: vi.fn(),
    pageFindUniqueOrThrow: vi.fn(),
    pageCreate: vi.fn(),
    projectFindFirst: vi.fn(),
    propertyCreate: vi.fn(),
    databaseViewCreateMany: vi.fn(),
    propertyValueCreate: vi.fn(),
    transaction: vi.fn(),
  };

  /** Op names that reached a commit. */
  const committed: string[] = [];
  /** Op names inside an open transaction, not yet committed. */
  const pending: string[] = [];

  const track =
    (sink: string[]) =>
    (op: string, mock: (typeof behavior)["pageCreate"]) =>
    async (args: unknown) => {
      const result = await mock(args);
      sink.push(op);
      return result;
    };
  /** Global writes auto-commit: record as soon as they succeed. */
  const recordCommit = track(committed);
  /** Transaction writes: record into the enqueue; promotion happens on commit. */
  const recordPending = track(pending);

  const prisma = {
    workspace: { findUnique: behavior.workspaceFindUnique },
    project: { findFirst: behavior.projectFindFirst },
    page: {
      findFirst: behavior.pageFindFirst,
      findUniqueOrThrow: behavior.pageFindUniqueOrThrow,
      create: recordCommit("page.create", behavior.pageCreate),
    },
    property: { create: recordCommit("property.create", behavior.propertyCreate) },
    databaseView: {
      createMany: recordCommit("databaseView.createMany", behavior.databaseViewCreateMany),
    },
    propertyValue: {
      create: recordCommit("propertyValue.create", behavior.propertyValueCreate),
    },
    $transaction: behavior.transaction,
  };

  const txClient = {
    workspace: { findUnique: behavior.workspaceFindUnique },
    project: { findFirst: behavior.projectFindFirst },
    page: {
      findFirst: behavior.pageFindFirst,
      findUniqueOrThrow: behavior.pageFindUniqueOrThrow,
      create: recordPending("page.create", behavior.pageCreate),
    },
    property: { create: recordPending("property.create", behavior.propertyCreate) },
    databaseView: {
      createMany: recordPending("databaseView.createMany", behavior.databaseViewCreateMany),
    },
    propertyValue: {
      create: recordPending("propertyValue.create", behavior.propertyValueCreate),
    },
  };

  return { behavior, prisma, txClient, committed, pending };
});

vi.mock("@/lib/db", () => ({
  prisma: state.prisma,
}));

vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "user-1", email: "member@example.test" }),
}));

vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: async () => ({ role: "MEMBER" }),
  canEditContent: () => true,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn() }));

import { createPageAction } from "./pages";

const count = (ledger: string[], op: string) =>
  ledger.filter((entry) => entry === op).length;

beforeEach(() => {
  vi.clearAllMocks();
  state.committed.length = 0;
  state.pending.length = 0;

  state.behavior.workspaceFindUnique.mockResolvedValue({ slug: "team" });
  state.behavior.pageFindFirst.mockResolvedValue(null);
  state.behavior.pageFindUniqueOrThrow.mockResolvedValue({
    workspaceId: "ws-1",
    createdById: "user-1",
  });
  state.behavior.pageCreate.mockResolvedValue({ id: "page-1" });
  state.behavior.projectFindFirst.mockResolvedValue(null);
  state.behavior.propertyCreate.mockImplementation(
    async (args: { data: { name: string } }) => ({
      id: `property-${args.data.name}`,
    }),
  );
  state.behavior.databaseViewCreateMany.mockResolvedValue({ count: 3 });
  state.behavior.propertyValueCreate.mockResolvedValue({});

  state.behavior.transaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) => {
      state.pending.length = 0;
      const result = await callback(state.txClient);
      state.committed.push(...state.pending);
      state.pending.length = 0;
      return result;
    },
  );
});

describe("createPageAction — database seed atomicity", () => {
  it("does not survive a failed seed: no DATABASE page row is committed", async () => {
    state.behavior.propertyCreate.mockRejectedValueOnce(new Error("seed failure"));

    await expect(
      createPageAction({ workspaceId: "ws-1", type: "DATABASE" }),
    ).rejects.toThrow("seed failure");

    expect(count(state.committed, "page.create")).toBe(0);
    expect(count(state.committed, "property.create")).toBe(0);
    expect(count(state.committed, "databaseView.createMany")).toBe(0);
    expect(count(state.committed, "propertyValue.create")).toBe(0);
  });

  it("commits page, 4 properties, 3 views and 2 seeded rows together", async () => {
    const result = await createPageAction({
      workspaceId: "ws-1",
      type: "DATABASE",
    });

    expect(result).toEqual({ ok: true, id: "page-1", slug: "team" });
    expect(count(state.committed, "page.create")).toBe(3);
    expect(count(state.committed, "property.create")).toBe(4);
    expect(count(state.committed, "databaseView.createMany")).toBe(1);
    expect(count(state.committed, "propertyValue.create")).toBe(4);
  });

  it("does not seed a plain PAGE", async () => {
    const result = await createPageAction({
      workspaceId: "ws-1",
      type: "PAGE",
    });

    expect(result).toEqual({ ok: true, id: "page-1", slug: "team" });
    expect(count(state.committed, "page.create")).toBe(1);
    expect(count(state.committed, "property.create")).toBe(0);
    expect(count(state.committed, "databaseView.createMany")).toBe(0);
    expect(count(state.committed, "propertyValue.create")).toBe(0);
  });
});
