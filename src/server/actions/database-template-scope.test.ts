import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B97 — the **scope of the row/template ids** in the database template actions.
 *
 * `saveRowAsTemplateAction` authorized the database the client named, but then
 * read the row over a second, client-supplied id **without any binding**:
 * `prisma.page.findUnique({ where: { id: rowId } })`. A member of workspace A
 * could therefore name the cuid of a row of workspace B and copy its **body
 * and every cell value** into a template of A — and read it back from A's own
 * RSC payload, or materialize it as a row of A.
 *
 * `createRowFromTemplateAction` had the same shape one function further down:
 * the template was resolved over an unbound id, so a template of a foreign
 * database was materialized into the caller's database.
 *
 * The fake database below applies the same filters the real one would — a
 * `where` with a `workspaceId`/`parentId` that does not match the row returns
 * nothing. Without that, the tests would stay green even without the fix.
 * It also honours the `select`: the real database returns **only** the
 * selected fields, so a field that the query does not select is `undefined`.
 * A mock that hands out the whole record would hide a comparison against a
 * field the query never asked for.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const DATABASE_A = "db-a";
/** A database of another workspace. */
const DATABASE_B = "db-b";
/** Another database of the **same** workspace — the binding is per database. */
const DATABASE_C = "db-c";

type FakePage = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  type: string;
  schemaLocked: boolean;
  icon: string | null;
  content: unknown;
  propertyValues: { propertyId: string; value: unknown }[];
};

type FakeTemplate = {
  id: string;
  databasePageId: string;
  name: string;
  icon: string | null;
  content: unknown;
  config: { values?: { propertyId: string; value: unknown }[] } | null;
};

const PAGES: FakePage[] = [
  {
    id: DATABASE_A,
    workspaceId: WORKSPACE_A,
    parentId: null,
    type: "DATABASE",
    schemaLocked: false,
    icon: null,
    content: null,
    propertyValues: [],
  },
  {
    id: DATABASE_B,
    workspaceId: WORKSPACE_B,
    parentId: null,
    type: "DATABASE",
    schemaLocked: false,
    icon: null,
    content: null,
    propertyValues: [],
  },
  {
    id: DATABASE_C,
    workspaceId: WORKSPACE_A,
    parentId: null,
    type: "DATABASE",
    schemaLocked: false,
    icon: null,
    content: null,
    propertyValues: [],
  },
  {
    id: "row-in-a",
    workspaceId: WORKSPACE_A,
    parentId: DATABASE_A,
    type: "PAGE",
    schemaLocked: false,
    icon: "🧭",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "A's own row body" }] },
      ],
    },
    propertyValues: [{ propertyId: "prop-a", value: { text: "A's own cell value" } }],
  },
  {
    id: "row-in-b",
    workspaceId: WORKSPACE_B,
    parentId: DATABASE_B,
    type: "PAGE",
    schemaLocked: false,
    icon: "🔒",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "B's secret row body" }] },
      ],
    },
    propertyValues: [
      { propertyId: "prop-b", value: { text: "B's secret cell value" } },
    ],
  },
  {
    id: "row-in-c",
    workspaceId: WORKSPACE_A,
    parentId: DATABASE_C,
    type: "PAGE",
    schemaLocked: false,
    icon: "🗂",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "C's row body" }] },
      ],
    },
    propertyValues: [{ propertyId: "prop-c", value: { text: "C's cell value" } }],
  },
  {
    /**
     * A **legacy** row: it hangs under the authorized database (`db-a`) — but
     * it belongs to **another** workspace (`ws-b`). Such rows exist where a
     * row was linked across the workspace boundary before the binding was
     * enforced. The parent is not enough here: only the workspace binding
     * keeps this row out of the caller's template.
     */
    id: "row-legacy",
    workspaceId: WORKSPACE_B,
    parentId: DATABASE_A,
    type: "PAGE",
    schemaLocked: false,
    icon: "🕰️",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Legacy row body" }] },
      ],
    },
    propertyValues: [{ propertyId: "prop-b", value: { text: "Legacy cell value" } }],
  },
];

const TEMPLATES: FakeTemplate[] = [
  {
    id: "template-in-a",
    databasePageId: DATABASE_A,
    name: "A's template",
    icon: "📋",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "A's template body" }] },
      ],
    },
    config: { values: [{ propertyId: "prop-a", value: { text: "A's template cell value" } }] },
  },
  {
    id: "template-in-b",
    databasePageId: DATABASE_B,
    name: "B's secret template",
    icon: "🔒",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "B's secret template body" }] },
      ],
    },
    config: {
      values: [{ propertyId: "prop-b", value: { text: "B's secret template cell value" } }],
    },
  },
  {
    id: "template-in-c",
    databasePageId: DATABASE_C,
    name: "C's template",
    icon: "🗂",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "C's template body" }] },
      ],
    },
    config: { values: [{ propertyId: "prop-c", value: { text: "C's template cell value" } }] },
  },
];

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindFirst: vi.fn(),
  pageCreate: vi.fn(),
  templateFindUnique: vi.fn(),
  templateCreate: vi.fn(),
  propertyValueCreateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findUnique: db.pageFindUnique,
      findFirst: db.pageFindFirst,
      create: db.pageCreate,
    },
    template: {
      findUnique: db.templateFindUnique,
      create: db.templateCreate,
    },
    propertyValue: { createMany: db.propertyValueCreateMany },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: vi.fn(() => true),
}));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createRowFromTemplateAction,
  saveRowAsTemplateAction,
} from "./database";

type ActionResult = { ok?: boolean; id?: string; error?: string };

/** The `data` the action wrote into a new template. */
function createdTemplate(): {
  databasePageId?: string;
  name?: string;
  icon?: string | null;
  content?: unknown;
  config?: { values?: { propertyId: string; value: unknown }[] };
} {
  const call = db.templateCreate.mock.calls[0];
  return (call?.[0] as { data: Record<string, unknown> })?.data ?? {};
}

/** The `data` the action wrote into the new row. */
function createdRow(): {
  workspaceId?: string;
  parentId?: string;
  title?: string;
  content?: unknown;
} {
  const call = db.pageCreate.mock.calls[0];
  return (call?.[0] as { data: Record<string, unknown> })?.data ?? {};
}

/** The cell values the action wrote for the new row. */
function createdCellValues(): {
  propertyId: string;
  pageId?: string;
  value: unknown;
}[] {
  const call = db.propertyValueCreateMany.mock.calls[0];
  const data = (call?.[0] as { data?: { propertyId: string; value: unknown }[] })?.data;
  return data ?? [];
}

/** The query the action used to read the row. */
function rowQuery(): {
  where?: { id?: string; parentId?: unknown; workspaceId?: unknown };
  select?: Record<string, boolean>;
} {
  const call = db.pageFindUnique.mock.calls.find((args) => {
    const where = (args[0] as { where?: { id?: string } })?.where;
    return where?.id !== undefined && where.id !== DATABASE_A;
  });
  return (call?.[0] as { where?: never; select?: never }) ?? {};
}

/**
 * The fields the real database returns: **only** the selected ones. A field
 * that the query does not select is `undefined` — a comparison against it can
 * never succeed, and a mock that hands out the whole record would hide that.
 */
function selectedFields(
  row: object,
  select: Record<string, boolean> | undefined,
): Record<string, unknown> {
  const source = row as Record<string, unknown>;
  if (!select) return source;
  const projected: Record<string, unknown> = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) projected[field] = source[field];
  }
  return projected;
}

beforeEach(() => {
  vi.clearAllMocks();

  // The fake database applies every filter of the `where` clause, exactly as
  // the real one does — a row of another workspace or another database is not
  // found under a bound query — and it returns only the selected fields.
  db.pageFindUnique.mockImplementation(
    async (args: {
      where: { id?: string; parentId?: unknown; workspaceId?: unknown };
      select?: Record<string, boolean>;
    }) => {
      const where = args.where ?? {};
      const page = PAGES.find((entry) => entry.id === where.id);
      if (!page) return null;
      if (where.parentId !== undefined && page.parentId !== where.parentId) return null;
      if (where.workspaceId !== undefined && page.workspaceId !== where.workspaceId) {
        return null;
      }
      return selectedFields(page, args.select);
    },
  );

  db.pageFindFirst.mockResolvedValue({ position: 1000 });
  db.pageCreate.mockResolvedValue({ id: "row-created" });
  db.templateCreate.mockResolvedValue({ id: "template-created" });
  db.propertyValueCreateMany.mockResolvedValue({ count: 1 });

  db.templateFindUnique.mockImplementation(
    async (args: { where: { id?: string }; select?: Record<string, boolean> }) => {
      const template = TEMPLATES.find((entry) => entry.id === args.where?.id);
      if (!template) return null;
      return selectedFields(template, args.select);
    },
  );
});

describe("saveRowAsTemplateAction — the row must belong to the authorized database (B97)", () => {
  it("does not copy the body or the cell values of a row of another workspace", async () => {
    const result = (await saveRowAsTemplateAction(DATABASE_A, "row-in-b", "Stolen")) as ActionResult;

    expect(result.error).toBe("Row not found.");
    expect(db.templateCreate).not.toHaveBeenCalled();
  });

  it("answers a foreign row exactly like an unknown row", async () => {
    const foreign = (await saveRowAsTemplateAction(DATABASE_A, "row-in-b", "Stolen")) as ActionResult;
    const missing = (await saveRowAsTemplateAction(DATABASE_A, "row-unknown", "Stolen")) as ActionResult;

    expect(foreign.error).toBe(missing.error);
    expect(foreign.error).toBe("Row not found.");
  });

  it("does not copy a row of another database of the same workspace", async () => {
    const result = (await saveRowAsTemplateAction(DATABASE_A, "row-in-c", "Stolen")) as ActionResult;

    expect(result.error).toBe("Row not found.");
    expect(db.templateCreate).not.toHaveBeenCalled();
  });

  it("does not copy a legacy row that hangs under the database of another workspace", async () => {
    // `row-legacy` sits under `db-a` — but belongs to `ws-b`. The parent is
    // right, the workspace is not: the row must be refused like any other
    // foreign row, and no template may be created from it.
    const result = (await saveRowAsTemplateAction(DATABASE_A, "row-legacy", "Stolen")) as ActionResult;

    expect(result.error).toBe("Row not found.");
    expect(db.templateCreate).not.toHaveBeenCalled();
  });

  it("copies the body and the cell values of a row of the authorized database", async () => {
    const result = (await saveRowAsTemplateAction(DATABASE_A, "row-in-a", "Mine")) as ActionResult;

    expect(result).toMatchObject({ ok: true, id: "template-created" });
    expect(db.templateCreate).toHaveBeenCalledTimes(1);
    const template = createdTemplate();
    expect(template.databasePageId).toBe(DATABASE_A);
    expect(template.content).toEqual(
      PAGES.find((page) => page.id === "row-in-a")?.content,
    );
    expect(template.config?.values).toEqual([
      { propertyId: "prop-a", value: { text: "A's own cell value" } },
    ]);
  });

  it("binds the row query to the database and the workspace of the caller", async () => {
    await saveRowAsTemplateAction(DATABASE_A, "row-in-a", "Mine");

    const query = rowQuery();
    const boundInWhere =
      query.where?.parentId === DATABASE_A && query.where?.workspaceId === WORKSPACE_A;
    const boundInSelect =
      query.select?.parentId === true && query.select?.workspaceId === true;
    expect(boundInWhere || boundInSelect).toBe(true);
  });
});

describe("createRowFromTemplateAction — the template must belong to the authorized database (B97)", () => {
  it("does not materialize a template of another workspace", async () => {
    const result = (await createRowFromTemplateAction(DATABASE_A, "template-in-b")) as ActionResult;

    expect(result.error).toBe("Template not found.");
    expect(db.pageCreate).not.toHaveBeenCalled();
    expect(db.propertyValueCreateMany).not.toHaveBeenCalled();
  });

  it("answers a foreign template exactly like an unknown template", async () => {
    const foreign = (await createRowFromTemplateAction(DATABASE_A, "template-in-b")) as ActionResult;
    const missing = (await createRowFromTemplateAction(DATABASE_A, "template-unknown")) as ActionResult;

    expect(foreign.error).toBe(missing.error);
    expect(foreign.error).toBe("Template not found.");
  });

  it("does not materialize a template of another database of the same workspace", async () => {
    const result = (await createRowFromTemplateAction(DATABASE_A, "template-in-c")) as ActionResult;

    expect(result.error).toBe("Template not found.");
    expect(db.pageCreate).not.toHaveBeenCalled();
    expect(db.propertyValueCreateMany).not.toHaveBeenCalled();
  });

  it("materializes a template of the authorized database", async () => {
    const result = (await createRowFromTemplateAction(DATABASE_A, "template-in-a")) as ActionResult;

    expect(result).toMatchObject({ ok: true, id: "row-created" });
    expect(db.pageCreate).toHaveBeenCalledTimes(1);
    const row = createdRow();
    expect(row.parentId).toBe(DATABASE_A);
    expect(row.workspaceId).toBe(WORKSPACE_A);
    expect(row.title).toBe("A's template");
    expect(JSON.stringify(row.content)).toContain("A's template body");
    expect(createdCellValues()).toEqual([
      {
        propertyId: "prop-a",
        pageId: "row-created",
        value: { text: "A's template cell value" },
      },
    ]);
  });
});
