import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B100 — the target of a relation must lie inside the viewer's **read** scope.
 *
 * `getDatabase()` resolves the target of every RELATION property and reads its
 * rows, its cell values and its schema. Since the relation-target fix (B98) the
 * target has to be a database of the *same workspace* — but the **guest scope**
 * was never consulted: a guest who may read `db-a` received the rows, the cell
 * values and the schema of `db-a-2`, a second database of the same workspace
 * that was never shared with them.
 *
 * The rule is the one the linked-database actions already follow (B90): the
 * **read** scope of `lib/guest-access.ts` — the pages shared with the guest
 * plus their whole subtree, never an ancestor (the canonical inheritance rule
 * of `lib/access-inheritance.ts`). It is *not* the display scope
 * (`pageScopeFor` / `guestVisiblePageIds`), which also carries the ancestors
 * of the shared pages so the sidebar can draw the breadcrumb chain.
 *
 * Only the transport edges are mocked (`@/lib/db`, `@/lib/auth`,
 * `@/lib/permissions`, `next/cache`): the real scope computation
 * (`lib/guest-access.ts`), the real action (`actions/linked-database.ts`) and
 * the real query (`server/queries.ts`) run. The prisma mock is an in-memory
 * store that applies the filters the real database would apply — a `where` on
 * the workspace really excludes the rows of another workspace, and a nested
 * relation filter (`permissions: { where: { userId } }`,
 * `teamspace: { workspaceId }`) really narrows the result — so the scope the
 * guest gets is the scope the database would give them.
 */

type Row = Record<string, unknown>;

/** The in-memory store the prisma mock reads from. */
const h = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {
    user: [],
    page: [],
    pagePermission: [],
    teamspace: [],
    teamspaceMember: [],
    property: [],
    propertyValue: [],
    databaseView: [],
    template: [],
    activity: [],
  };
  /** Every call the mock received — the queries the code under test ran. */
  const calls: { model: string; op: string; args: Row }[] = [];
  return { tables, calls };
});

const auth = vi.hoisted(() => ({
  requireUser: vi.fn(async () => ({ id: "user-guest" })),
}));

const perm = vi.hoisted(() => ({
  /** The role of the current actor — the seam the test switches. */
  getWorkspaceAccess: vi.fn(async () => ({ role: "GUEST" })),
  canEditContent: vi.fn((role: string) => role !== "GUEST"),
}));

vi.mock("@/lib/db", () => {
  const TABLES = h.tables;

  type Model = string;

  /** The relations the queries use. `dir` says which way the join goes. */
  const RELATIONS: Record<
    string,
    Record<string, { model: Model; key: string; dir: "one" | "many" }>
  > = {
    page: {
      createdBy: { model: "user", key: "createdById", dir: "one" },
      permissions: { model: "pagePermission", key: "pageId", dir: "many" },
      propertyValues: { model: "propertyValue", key: "pageId", dir: "many" },
    },
    property: { databasePage: { model: "page", key: "databasePageId", dir: "one" } },
    activity: { actor: { model: "user", key: "actorId", dir: "one" } },
    teamspaceMember: { teamspace: { model: "teamspace", key: "teamspaceId", dir: "one" } },
  };

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const relationSpec = (model: Model, name: string) => RELATIONS[model]?.[name] ?? null;

  /**
   * The rows of a relation — the join the database would do.
   *
   * `dir: "many"` is the has-many direction (the child carries the foreign
   * key), `dir: "one"` the belongs-to direction (the parent is named by the
   * foreign key on this row).
   */
  const relatedRows = (model: Model, row: Row, name: string): Row[] => {
    const spec = relationSpec(model, name);
    if (!spec) return [];
    return spec.dir === "many"
      ? TABLES[spec.model].filter((entry) => entry[spec.key] === row.id)
      : TABLES[spec.model].filter((entry) => entry.id === row[spec.key]);
  };

  /** A single column filter: equality, `null`, `in`, `notIn`, `not`. */
  const matchesScalar = (value: unknown, condition: unknown): boolean => {
    if (condition === null) return value === null || value === undefined;
    if (isPlainObject(condition)) {
      if ("in" in condition) return (condition.in as unknown[]).includes(value);
      if ("notIn" in condition) return !(condition.notIn as unknown[]).includes(value);
      if ("not" in condition) {
        const not = condition.not;
        if (not === null) return value !== null && value !== undefined;
        return value !== not;
      }
      if ("equals" in condition) return value === condition.equals;
      return true;
    }
    return value === condition;
  };

  /** The `where` interpreter — the heart of the mock. */
  const matchesWhere = (model: Model, row: Row, where: unknown): boolean => {
    if (!isPlainObject(where)) return true;
    for (const [key, condition] of Object.entries(where)) {
      if (key === "AND") {
        const list = (condition as unknown[]) ?? [];
        if (!list.every((entry) => matchesWhere(model, row, entry))) return false;
        continue;
      }
      if (key === "OR") {
        const list = (condition as unknown[]) ?? [];
        if (!list.some((entry) => matchesWhere(model, row, entry))) return false;
        continue;
      }
      const spec = relationSpec(model, key);
      if (spec) {
        // A relation filter: the joined row has to match the condition.
        const related = relatedRows(model, row, key);
        if (!related.some((entry) => matchesWhere(spec.model, entry, condition))) {
          return false;
        }
        continue;
      }
      if (!matchesScalar(row[key], condition)) return false;
    }
    return true;
  };

  /** The rows of a relation, projected by the relation's own `select`. */
  const relationValue = (model: Model, row: Row, name: string, spec: unknown): unknown => {
    const relation = relationSpec(model, name);
    if (!relation) return null;
    let rows = relatedRows(model, row, name);
    const wanted = isPlainObject(spec) ? spec : {};
    if (wanted.where) {
      rows = rows.filter((entry) => matchesWhere(relation.model, entry, wanted.where));
    }
    const projected = rows.map((entry) => project(relation.model, entry, wanted.select));
    return relation.dir === "many" ? projected : (projected[0] ?? null);
  };

  /** The `select` projection of one row. */
  function project(model: Model, row: Row, select?: unknown): Row {
    if (!isPlainObject(select)) return { ...row };
    const out: Row = {};
    for (const [name, wanted] of Object.entries(select)) {
      if (!wanted) continue;
      out[name] = isPlainObject(wanted) ? relationValue(model, row, name, wanted) : row[name];
    }
    return out;
  }

  /** The `include` projection — the relations a row carries along. */
  const withIncludes = (model: Model, row: Row, include: unknown): Row => {
    if (!isPlainObject(include)) return { ...row };
    const out: Row = { ...row };
    for (const [name, spec] of Object.entries(include)) {
      if (!spec) continue;
      if (spec === true) {
        out[name] = relatedRows(model, row, name).map((entry) => ({ ...entry }));
        continue;
      }
      out[name] = relationValue(model, row, name, spec);
    }
    return out;
  };

  const compareValues = (a: unknown, b: unknown): number => {
    if (a === b) return 0;
    if (a instanceof Date || b instanceof Date) {
      return (a as Date).getTime() < (b as Date).getTime() ? -1 : 1;
    }
    if (typeof a === "number" && typeof b === "number") {
      return a < b ? -1 : 1;
    }
    return String(a) < String(b) ? -1 : 1;
  };

  const sortRows = (rows: Row[], orderBy: unknown): Row[] => {
    if (!isPlainObject(orderBy) && !Array.isArray(orderBy)) return rows;
    const entries = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<
      string,
      string
    >[];
    return [...rows].sort((left, right) => {
      for (const entry of entries) {
        for (const [key, direction] of Object.entries(entry)) {
          const cmp = compareValues(left[key], right[key]);
          if (cmp === 0) continue;
          return direction === "desc" ? -cmp : cmp;
        }
      }
      return 0;
    });
  };

  const findMany = async (model: Model, args: Record<string, unknown> = {}) => {
    h.calls.push({ model, op: "findMany", args });
    let rows = TABLES[model].filter((row) => matchesWhere(model, row, args.where));
    rows = sortRows(rows, args.orderBy);
    if (typeof args.skip === "number") rows = rows.slice(args.skip);
    if (typeof args.take === "number") rows = rows.slice(0, args.take);
    return rows.map((row) => {
      const selected = project(model, row, args.select);
      return withIncludes(model, selected, args.include);
    });
  };

  const findFirst = async (model: Model, args: Record<string, unknown> = {}) => {
    const rows = await findMany(model, { ...args, take: 1 });
    return rows[0] ?? null;
  };

  const findUnique = async (model: Model, args: Record<string, unknown> = {}) => {
    const rows = await findMany(model, args);
    return rows[0] ?? null;
  };

  const prisma = {
    page: {
      findMany: (args: Record<string, unknown>) => findMany("page", args),
      findFirst: (args: Record<string, unknown>) => findFirst("page", args),
      findUnique: (args: Record<string, unknown>) => findUnique("page", args),
    },
    pagePermission: {
      findMany: (args: Record<string, unknown>) => findMany("pagePermission", args),
    },
    teamspaceMember: {
      findMany: (args: Record<string, unknown>) => findMany("teamspaceMember", args),
    },
    property: {
      findMany: (args: Record<string, unknown>) => findMany("property", args),
      findFirst: (args: Record<string, unknown>) => findFirst("property", args),
    },
    propertyValue: {
      findMany: (args: Record<string, unknown>) => findMany("propertyValue", args),
    },
    databaseView: {
      findMany: (args: Record<string, unknown>) => findMany("databaseView", args),
    },
    template: {
      findMany: (args: Record<string, unknown>) => findMany("template", args),
    },
    activity: {
      findMany: (args: Record<string, unknown>) => findMany("activity", args),
    },
    user: {
      findMany: (args: Record<string, unknown>) => findMany("user", args),
    },
  };

  return { prisma };
});

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: perm.getWorkspaceAccess,
  canEditContent: perm.canEditContent,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getLinkedDatabaseAction } from "./linked-database";
import { getDatabase } from "@/server/queries";
import { guestReadablePageIds } from "@/lib/guest-access";

const WORKSPACE_ID = "ws-1";
const GUEST_ID = "user-guest";
const MEMBER_ID = "user-member";

/**
 * The workspace's tree:
 *
 *   parent-1                 (an ordinary page, never shared)
 *   db-a                     (the database the guest may read)
 *   └── row-a
 *   db-a-2                   (a second database — the target of `rel-a`)
 *   └── row-a-2
 *   parent-2                 (an ordinary page above `db-a-3`)
 *   └── db-a-3               (the target of `rel-b`)
 *       └── row-a-3
 */
const PAGES = [
  { id: "parent-1", parentId: null, type: "PAGE", title: "Parent" },
  { id: "db-a", parentId: null, type: "DATABASE", title: "A's database" },
  { id: "row-a", parentId: "db-a", type: "PAGE", title: "A's row" },
  { id: "db-a-2", parentId: null, type: "DATABASE", title: "A's second database" },
  { id: "row-a-2", parentId: "db-a-2", type: "PAGE", title: "A's second row" },
  { id: "parent-2", parentId: null, type: "PAGE", title: "Another parent" },
  { id: "db-a-3", parentId: "parent-2", type: "DATABASE", title: "A's third database" },
  { id: "row-a-3", parentId: "db-a-3", type: "PAGE", title: "A's third row" },
];

/** The guest's page grants — page id → permission levels. */
let grants: Record<string, string[]>;

/** The queries that compute the read scope (`guestReadablePageIds`). */
function scopeQueries(): { model: string; op: string; args: Row }[] {
  return h.calls.filter((call) => {
    if (call.model !== "page" || call.op !== "findMany") return false;
    const select = call.args.select as Record<string, unknown> | undefined;
    return Boolean(select && "permissions" in select);
  });
}

/** The queries that read the rows of a relation target. */
function targetRowQueries(targetDatabaseId: string): { model: string; op: string; args: Row }[] {
  return h.calls.filter((call) => {
    if (call.model !== "page" || call.op !== "findMany") return false;
    const where = call.args.where as Record<string, unknown> | undefined;
    return where?.parentId === targetDatabaseId;
  });
}

function seed() {
  for (const table of Object.values(h.tables)) table.length = 0;
  h.calls.length = 0;

  h.tables.user.push({ id: GUEST_ID, name: "Gina" }, { id: MEMBER_ID, name: "Mona" });

  for (const page of PAGES) {
    h.tables.page.push({
      ...page,
      workspaceId: WORKSPACE_ID,
      icon: null,
      deletedAt: null,
      position: 0,
      teamspaceId: null,
      createdById: MEMBER_ID,
    });
  }

  for (const [pageId, levels] of Object.entries(grants)) {
    for (const level of levels) {
      h.tables.pagePermission.push({
        id: `perm-${pageId}-${level}`,
        pageId,
        userId: GUEST_ID,
        level,
      });
    }
  }

  h.tables.property.push(
    {
      id: "rel-a",
      databasePageId: "db-a",
      name: "Relation to A's second database",
      type: "RELATION",
      config: { targetDatabaseId: "db-a-2" },
      position: 0,
    },
    {
      id: "rel-b",
      databasePageId: "db-a",
      name: "Relation to A's third database",
      type: "RELATION",
      config: { targetDatabaseId: "db-a-3" },
      position: 1,
    },
    {
      id: "p-a",
      databasePageId: "db-a",
      name: "Notes",
      type: "TEXT",
      config: {},
      position: 2,
    },
    {
      id: "p-a-2",
      databasePageId: "db-a-2",
      name: "Amount",
      type: "NUMBER",
      config: {},
      position: 0,
    },
    {
      id: "p-a-3",
      databasePageId: "db-a-3",
      name: "Total",
      type: "NUMBER",
      config: {},
      position: 0,
    },
  );

  h.tables.propertyValue.push(
    { id: "pv-a-2", propertyId: "p-a-2", pageId: "row-a-2", value: { number: 42 } },
    { id: "pv-a-3", propertyId: "p-a-3", pageId: "row-a-3", value: { number: 7 } },
  );

  h.tables.databaseView.push({
    id: "view-a",
    databasePageId: "db-a",
    name: "All rows",
    type: "TABLE",
    position: 0,
    config: {},
  });
}

/** The read scope of the guest — the real computation, on the mocked prisma. */
async function guestScope(): Promise<ReadonlySet<string>> {
  return guestReadablePageIds(GUEST_ID, WORKSPACE_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  grants = {};

  auth.requireUser.mockResolvedValue({ id: GUEST_ID });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  seed();
});

describe("getDatabase — the relation target follows the read scope", () => {
  it("delivers no rows, no values and no schema of a target outside the scope", async () => {
    // The guest may read `db-a`; `db-a-2` was never shared with them.
    grants = { "db-a": ["READ"] };
    seed();

    const database = await getDatabase("db-a", await guestScope());

    expect(database.relationData["rel-a"]).toEqual({
      options: [],
      valuesByRow: {},
      properties: [],
    });

    // The payload carries nothing of the target.
    const payload = JSON.stringify(database.relationData);
    expect(payload).not.toContain("A's second row");
    expect(payload).not.toContain("42");
    expect(payload).not.toContain("Amount");
    expect(payload).not.toContain("row-a-2");
  });

  it("does not read the target at all when it is outside the scope", async () => {
    grants = { "db-a": ["READ"] };
    seed();

    await getDatabase("db-a", await guestScope());

    // The target's rows were never queried — the check stands in front of the
    // content query.
    expect(targetRowQueries("db-a-2")).toHaveLength(0);
  });

  it("delivers the options, the values and the schema of a target inside the scope", async () => {
    // The guest may read `db-a` and `db-a-2`.
    grants = { "db-a": ["READ"], "db-a-2": ["READ"] };
    seed();

    const database = await getDatabase("db-a", await guestScope());

    expect(database.relationData["rel-a"].options).toEqual([
      { id: "row-a-2", title: "A's second row", icon: null },
    ]);
    // The rollup values of the related row.
    expect(database.relationData["rel-a"].valuesByRow["row-a-2"]).toEqual({
      "p-a-2": { number: 42 },
    });
    // The schema of the related database.
    expect(database.relationData["rel-a"].properties).toEqual([
      { id: "p-a-2", name: "Amount", type: "NUMBER" },
    ]);
    // And the target was read.
    expect(targetRowQueries("db-a-2")).not.toHaveLength(0);
  });

  it("filters nothing without a scope — the full-access path", async () => {
    grants = { "db-a": ["READ"] };
    seed();

    // No scope at all: nothing is filtered (the member's path).
    const database = await getDatabase("db-a", null);

    expect(database.relationData["rel-a"].options).toEqual([
      { id: "row-a-2", title: "A's second row", icon: null },
    ]);
    expect(database.relationData["rel-a"].valuesByRow["row-a-2"]).toEqual({
      "p-a-2": { number: 42 },
    });
  });
});

describe("the inheritance rule — a grant covers the subtree, never an ancestor", () => {
  it("does not deliver a target whose only grant is one of its rows", async () => {
    // The guest was given a single row of `db-a-2` — the database above it
    // stays out of reach (an ancestor is never inherited).
    grants = { "db-a": ["READ"], "row-a-2": ["READ"] };
    seed();

    const scope = await guestScope();
    expect(scope.has("row-a-2")).toBe(true);
    expect(scope.has("db-a-2")).toBe(false);

    const database = await getDatabase("db-a", scope);

    expect(database.relationData["rel-a"]).toEqual({
      options: [],
      valuesByRow: {},
      properties: [],
    });
  });

  it("delivers a target below a page the guest was given", async () => {
    // The guest was given `parent-2` — the database below it is inherited.
    grants = { "db-a": ["READ"], "parent-2": ["READ"] };
    seed();

    const scope = await guestScope();
    expect(scope.has("db-a-3")).toBe(true);

    const database = await getDatabase("db-a", scope);

    expect(database.relationData["rel-b"].options).toEqual([
      { id: "row-a-3", title: "A's third row", icon: null },
    ]);
    expect(database.relationData["rel-b"].valuesByRow["row-a-3"]).toEqual({
      "p-a-3": { number: 7 },
    });
  });
});

describe("getLinkedDatabaseAction — the scope reaches the query", () => {
  it("does not read the rows of a target outside the guest's scope", async () => {
    // The guest may read `db-a`; `db-a-2` was never shared with them.
    grants = { "db-a": ["READ"] };
    seed();

    await getLinkedDatabaseAction("db-a");

    // The scope was computed ...
    expect(scopeQueries()).toHaveLength(1);
    // ... and the target was never read.
    expect(targetRowQueries("db-a-2")).toHaveLength(0);
  });

  it("reads the target of a guest whose scope contains it", async () => {
    grants = { "db-a": ["READ"], "db-a-2": ["READ"] };
    seed();

    await getLinkedDatabaseAction("db-a");

    expect(scopeQueries()).toHaveLength(1);
    expect(targetRowQueries("db-a-2")).not.toHaveLength(0);
  });

  it("asks for no scope for a member and reads everything as before", async () => {
    auth.requireUser.mockResolvedValue({ id: MEMBER_ID });
    perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await getLinkedDatabaseAction("db-a");

    expect("error" in result).toBe(false);
    // No scope query for a member — they see the whole workspace.
    expect(scopeQueries()).toHaveLength(0);
    expect(targetRowQueries("db-a-2")).not.toHaveLength(0);
  });
});
