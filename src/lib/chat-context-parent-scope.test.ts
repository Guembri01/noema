import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — the chat context must not carry a row of another workspace.
 *
 * `Page.parentId` was unchecked before the fix, so a row of workspace A could
 * be filed under a database of workspace B. Those legacy rows are **not**
 * repaired by the deploy, so every read has to filter them by the workspace.
 *
 * The chat context read the rows of the workspace's databases without that
 * filter — the foreign row's **title and cell values** ended up in the AI
 * prompt. The fake database below applies the filters the real one would, so a
 * missing `workspaceId` in the query surfaces as the foreign row in the
 * assembled context.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const DATABASE_A = "db-a";

type FakeRow = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  deletedAt: Date | null;
  position: number;
  propertyValues: { value: unknown; property: { name: string } }[];
};

const ROWS: FakeRow[] = [
  {
    id: "row-a",
    workspaceId: WORKSPACE_A,
    parentId: DATABASE_A,
    title: "Row in A",
    deletedAt: null,
    position: 1000,
    propertyValues: [{ value: { text: "A's cell value" }, property: { name: "Name" } }],
  },
  {
    id: "row-foreign",
    workspaceId: WORKSPACE_B,
    parentId: DATABASE_A,
    title: "Row in B (legacy cross-tenant link)",
    deletedAt: null,
    position: 2000,
    propertyValues: [{ value: { text: "B's secret cell value" }, property: { name: "Name" } }],
  },
];

const db = vi.hoisted(() => ({
  pageFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  pageCount: vi.fn(),
  propertyFindMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
  ticketFindMany: vi.fn(),
  projectFindMany: vi.fn(),
  labelCount: vi.fn(),
  labelFindMany: vi.fn(),
  commentCount: vi.fn(),
  commentFindMany: vi.fn(),
  chatThreadCount: vi.fn(),
  chatThreadFindMany: vi.fn(),
  chatMessageFindMany: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    page: {
      findFirst: db.pageFindFirst,
      findMany: db.pageFindMany,
      count: db.pageCount,
    },
    property: { findMany: db.propertyFindMany },
    workspace: { findUnique: db.workspaceFindUnique },
    ticket: { findMany: db.ticketFindMany },
    project: { findMany: db.projectFindMany },
    label: { count: db.labelCount, findMany: db.labelFindMany },
    comment: { count: db.commentCount, findMany: db.commentFindMany },
    chatThread: { count: db.chatThreadCount, findMany: db.chatThreadFindMany },
    chatMessage: { findMany: db.chatMessageFindMany },
  },
}));

vi.mock("@/server/queries", () => ({
  searchPagesForPrompt: vi.fn(async () => []),
}));

import { gatherChatIntel } from "./chat-context";

beforeEach(() => {
  vi.clearAllMocks();

  db.pageFindFirst.mockResolvedValue(null);
  db.pageCount.mockResolvedValue(0);
  db.propertyFindMany.mockResolvedValue([]);
  db.workspaceFindUnique.mockResolvedValue({ name: "Workspace A" });
  db.ticketFindMany.mockResolvedValue([]);
  db.projectFindMany.mockResolvedValue([]);
  db.labelCount.mockResolvedValue(0);
  db.labelFindMany.mockResolvedValue([]);
  db.commentCount.mockResolvedValue(0);
  db.commentFindMany.mockResolvedValue([]);
  db.chatThreadCount.mockResolvedValue(0);
  db.chatThreadFindMany.mockResolvedValue([]);
  db.chatMessageFindMany.mockResolvedValue([]);

  db.pageFindMany.mockImplementation(
    async (args: {
      where?: {
        type?: string;
        parentId?: string | null | { in: string[] };
        workspaceId?: string;
        deletedAt?: null;
      };
    }) => {
      const where = args.where ?? {};
      // The workspace's databases.
      if (where.type === "DATABASE") {
        return [
          {
            id: DATABASE_A,
            title: "Database in A",
            icon: null,
            properties: [],
            _count: { children: ROWS.length },
          },
        ];
      }
      // The rows of those databases.
      if (where.parentId && typeof where.parentId === "object" && Array.isArray(where.parentId.in)) {
        return ROWS.filter((row) => {
          if (!where.parentId.in.includes(row.parentId ?? "")) return false;
          // The real database filters by the workspace when the query asks for
          // it — and returns the foreign row when it does not.
          if (where.workspaceId !== undefined && row.workspaceId !== where.workspaceId) return false;
          if (where.deletedAt === null && row.deletedAt !== null) return false;
          return true;
        });
      }
      return [];
    },
  );
});

describe("gatherChatIntel — database rows (B08)", () => {
  it("keeps a row of another workspace out of the prompt context", async () => {
    const intel = await gatherChatIntel({
      workspaceId: WORKSPACE_A,
      question: "which rows are in the database?",
    });

    expect(intel.context).toContain("Row in A");
    expect(intel.context).not.toContain("Row in B (legacy cross-tenant link)");
  });

  it("keeps the cell values of a row of another workspace out of the prompt context", async () => {
    const intel = await gatherChatIntel({
      workspaceId: WORKSPACE_A,
      question: "which rows are in the database?",
    });

    expect(intel.context).not.toContain("B's secret cell value");
  });

  it("scopes the row query to the workspace of the databases", async () => {
    await gatherChatIntel({ workspaceId: WORKSPACE_A, question: "rows?" });

    const rowQuery = db.pageFindMany.mock.calls.find((args) => {
      const where = (args[0] as { where?: { parentId?: unknown } })?.where;
      return (
        typeof where?.parentId === "object" &&
        where?.parentId !== null &&
        Array.isArray((where?.parentId as { in?: unknown }).in)
      );
    });
    expect(rowQuery?.[0]?.where).toMatchObject({ workspaceId: WORKSPACE_A });
  });
});
