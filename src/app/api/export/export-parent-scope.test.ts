import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — the read side of the tenant boundary in the export routes.
 *
 * `Page.parentId` was unchecked before the fix, so a row of workspace A could
 * be filed under a database of workspace B. Those legacy rows are **not**
 * repaired by the deploy — every read has to filter them by the workspace of
 * the database they hang under, or the other tenant's row titles and cell
 * values end up in the export file.
 *
 * The fake database below applies the filters the real one would, so a missing
 * `workspaceId` in the query surfaces as a foreign row in the export.
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
  propertyValues: { id: string; propertyId: string; value: unknown }[];
};

const ROWS: FakeRow[] = [
  {
    id: "row-a",
    workspaceId: WORKSPACE_A,
    parentId: DATABASE_A,
    title: "Row in A",
    deletedAt: null,
    position: 1000,
    propertyValues: [{ id: "v1", propertyId: "prop-1", value: { text: "A's cell value" } }],
  },
  {
    id: "row-foreign",
    workspaceId: WORKSPACE_B,
    parentId: DATABASE_A,
    title: "Row in B (legacy cross-tenant link)",
    deletedAt: null,
    position: 2000,
    propertyValues: [{ id: "v2", propertyId: "prop-1", value: { text: "B's secret cell value" } }],
  },
];

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  propertyFindMany: vi.fn(),
  databaseViewFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique, findMany: db.pageFindMany },
    property: { findMany: db.propertyFindMany },
    databaseView: { findMany: db.databaseViewFindMany },
  },
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => ({ id: "user-1" })) }));
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));
// The module is mocked partially: the workspace access is the seam of the
// test, everything else (the role predicates the routes call) stays real — a
// mock that leaves `canEditContent` out would make the route under test throw
// instead of refusing.
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: vi.fn(async () => ({ role: "ADMIN" })) };
});
vi.mock("@/server/queries", () => ({
  getWorkspaceBySlug: vi.fn(async () => ({ id: WORKSPACE_A, slug: "acme", name: "Acme" })),
}));
vi.mock("@/lib/storage", () => ({
  storageDriver: vi.fn(() => ({ get: vi.fn(async () => null) })),
}));

const zipped = vi.hoisted(() => ({ files: [] as { path: string; content: string }[] }));
vi.mock("@/lib/export-format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export-format")>();
  return {
    ...actual,
    buildWorkspaceZip: vi.fn(async (input: { files: { path: string; content: string }[] }) => {
      zipped.files = input.files;
      return new Uint8Array([0x50, 0x4b]);
    }),
  };
});

import { GET as exportDatabase } from "./database/[pageId]/route";
import { GET as exportWorkspace } from "./workspace/[slug]/route";

const request = (url: string) => new Request(url);

beforeEach(() => {
  vi.clearAllMocks();
  zipped.files = [];

  db.pageFindUnique.mockImplementation(async (args: { where: { id: string } }) => {
    if (args.where.id !== DATABASE_A) return null;
    return {
      id: DATABASE_A,
      workspaceId: WORKSPACE_A,
      title: "Rows",
      type: "DATABASE",
    };
  });

  // The fake database applies the filters the real one would.
  db.pageFindMany.mockImplementation(
    async (args: {
      where?: {
        parentId?: string | null;
        workspaceId?: string;
        deletedAt?: null;
        type?: string;
      };
    }) => {
      const where = args.where ?? {};
      // The pages of the exported workspace.
      if (where.parentId === undefined) {
        return [
          {
            id: DATABASE_A,
            parentId: null,
            title: "Rows",
            type: "DATABASE",
            content: null,
            coverUrl: null,
          },
        ];
      }
      return ROWS.filter((row) => {
        if (where.parentId !== undefined && row.parentId !== where.parentId) return false;
        if (where.workspaceId !== undefined && row.workspaceId !== where.workspaceId) return false;
        if (where.deletedAt === null && row.deletedAt !== null) return false;
        return true;
      });
    },
  );

  db.propertyFindMany.mockResolvedValue([
    { id: "prop-1", name: "Name", type: "TEXT", position: 1000, config: { primary: true } },
  ]);
  db.databaseViewFindMany.mockResolvedValue([]);
});

describe("GET /api/export/database — row scope (B08)", () => {
  it("does not export a row of another workspace", async () => {
    const response = await exportDatabase(
      request("http://localhost/api/export/database/db-a?format=csv"),
      { params: Promise.resolve({ pageId: DATABASE_A }) },
    );

    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain("Row in A");
    expect(csv).not.toContain("Row in B (legacy cross-tenant link)");
    expect(csv).not.toContain("B's secret cell value");
  });

  it("scopes the row query to the workspace of the database", async () => {
    await exportDatabase(request("http://localhost/api/export/database/db-a?format=csv"), {
      params: Promise.resolve({ pageId: DATABASE_A }),
    });

    const rowQuery = db.pageFindMany.mock.calls.find((args) => {
      const where = (args[0] as { where?: { parentId?: unknown } })?.where;
      return where?.parentId === DATABASE_A;
    });
    expect(rowQuery?.[0]?.where).toMatchObject({ workspaceId: WORKSPACE_A });
  });
});

describe("GET /api/export/workspace — row scope (B08)", () => {
  it("does not export a row of another workspace", async () => {
    const response = await exportWorkspace(request("http://localhost/api/export/workspace/acme"), {
      params: Promise.resolve({ slug: "acme" }),
    });

    expect(response.status).toBe(200);
    const csv = zipped.files.map((file) => file.content).join("\n");
    expect(csv).not.toContain("Row in B (legacy cross-tenant link)");
    expect(csv).not.toContain("B's secret cell value");
  });

  it("scopes the row query to the workspace of the export", async () => {
    await exportWorkspace(request("http://localhost/api/export/workspace/acme"), {
      params: Promise.resolve({ slug: "acme" }),
    });

    const rowQuery = db.pageFindMany.mock.calls.find((args) => {
      const where = (args[0] as { where?: { parentId?: unknown } })?.where;
      return where?.parentId === DATABASE_A;
    });
    expect(rowQuery?.[0]?.where).toMatchObject({ workspaceId: WORKSPACE_A });
  });
});
