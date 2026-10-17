import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B98 — a RELATION property may not point at a database of another workspace.
 *
 * Two sides are covered:
 *
 * - the **write** side (`updatePropertyAction`): `Property.config` is untrusted
 *   stored JSON and was persisted verbatim, so a `config.targetDatabaseId` that
 *   names a database of another workspace must be refused — with the same
 *   answer a missing target gets, so the response is no existence oracle. The
 *   id is normalized before it is stored, so the stored configuration names
 *   exactly the target that was checked (and the read path resolves it);
 * - the **copy** side (`duplicateDatabaseAction`): a copy may not carry a
 *   relation target that the write side would refuse;
 * - the **read** side (`getDatabase`): a relation that points outside the
 *   workspace (an old revision, an import, a direct database edit) must not
 *   deliver the foreign rows, their cell values or the foreign schema.
 *
 * Only the transport edges are mocked (`@/lib/db`, `@/lib/auth`,
 * `@/lib/permissions`, `next/cache`); the action and the query logic run for
 * real. The prisma mock is an in-memory store that applies the filters the
 * real database would apply — a `workspaceId` in a `where` really excludes the
 * rows of the other workspace — so the test fails without the fix.
 */

type Row = Record<string, unknown>;

/** The in-memory store the prisma mock reads from. */
const h = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {
    user: [],
    page: [],
    property: [],
    propertyValue: [],
    databaseView: [],
    template: [],
    activity: [],
    workspaceMember: [],
  };
  return {
    tables,
    propertyUpdate: vi.fn(async (args: { where: { id: string }; data: Row }) => {
      const row = tables.property.find((entry) => entry.id === args.where.id);
      if (!row) throw new Error("Property not found.");
      Object.assign(row, args.data);
      return { ...row };
    }),
  };
});

const auth = vi.hoisted(() => ({
  requireUser: vi.fn(async () => ({ id: "user-a" })),
}));

const perm = vi.hoisted(() => ({
  /** The real module reads the membership rows; so does this mock. */
  getWorkspaceAccess: vi.fn(async (userId: string, workspaceId: string) => {
    const member = h.tables.workspaceMember.find(
      (entry) => entry.workspaceId === workspaceId && entry.userId === userId,
    );
    return member ? { role: member.role as string } : null;
  }),
  /** The real rule: everybody but a guest may edit content. */
  canEditContent: vi.fn((role: string) => role !== "GUEST"),
}));

vi.mock("@/lib/db", () => {
  const TABLES = h.tables;

  type Model = string;

  /** The relation filters the queries use. */
  const RELATIONS: Record<
    string,
    Record<string, { model: Model; key: string }>
  > = {
    property: { databasePage: { model: "page", key: "databasePageId" } },
    page: { createdBy: { model: "user", key: "createdById" } },
    activity: { actor: { model: "user", key: "actorId" } },
  };

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const relationSpec = (model: Model, name: string) => RELATIONS[model]?.[name] ?? null;

  /** The rows of a relation, resolved like the database would resolve them. */
  const relatedRows = (model: Model, row: Row, name: string): Row[] => {
    if (model === "page" && name === "propertyValues") {
      return TABLES.propertyValue.filter((entry) => entry.pageId === row.id);
    }
    const spec = relationSpec(model, name);
    if (!spec) return [];
    const found = TABLES[spec.model].find((entry) => entry.id === row[spec.key]);
    return found ? [found] : [];
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
        const related = TABLES[spec.model].find((entry) => entry.id === row[spec.key]);
        if (!related) return false;
        if (!matchesWhere(spec.model, related, condition)) return false;
        continue;
      }
      if (!matchesScalar(row[key], condition)) return false;
    }
    return true;
  };

  function relationValue(
    model: Model,
    row: Row,
    name: string,
    spec: unknown,
  ): unknown {
    const rows = relatedRows(model, row, name);
    if (model === "page" && name === "propertyValues") {
      return rows.map((entry) => ({ ...entry }));
    }
    const first = rows[0];
    if (!first) return null;
    if (isPlainObject(spec) && isPlainObject(spec.select)) {
      const relation = relationSpec(model, name);
      return relation ? project(relation.model, first, spec.select) : null;
    }
    return { ...first };
  }

  /** The `select`/`include` projection. */
  function project(
    model: Model,
    row: Row,
    select?: unknown,
    include?: unknown,
  ): Row {
    if (isPlainObject(select)) {
      const out: Row = {};
      for (const [name, wanted] of Object.entries(select)) {
        if (!wanted) continue;
        out[name] = isPlainObject(wanted)
          ? relationValue(model, row, name, wanted)
          : row[name];
      }
      return out;
    }
    const out: Row = { ...row };
    if (isPlainObject(include)) {
      for (const [name, spec] of Object.entries(include)) {
        out[name] = relationValue(model, row, name, spec);
      }
    }
    return out;
  }

  const compareValues = (a: unknown, b: unknown): number => {
    if (a === b) return 0;
    if (a instanceof Date || b instanceof Date) {
      return (a as Date).getTime() < (b as Date).getTime() ? -1 : 1;
    }
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
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
    let rows = TABLES[model].filter((row) => matchesWhere(model, row, args.where));
    rows = sortRows(rows, args.orderBy);
    if (typeof args.skip === "number") rows = rows.slice(args.skip);
    if (typeof args.take === "number") rows = rows.slice(0, args.take);
    return rows.map((row) => project(model, row, args.select, args.include));
  };

  const findFirst = async (model: Model, args: Record<string, unknown> = {}) => {
    const rows = await findMany(model, { ...args, take: 1 });
    return rows[0] ?? null;
  };

  const findUnique = async (model: Model, args: Record<string, unknown> = {}) => {
    const rows = await findMany(model, args);
    return rows[0] ?? null;
  };

  /** Insert one row (`create`). */
  const create = async (model: Model, args: Record<string, unknown> = {}) => {
    const row = { ...((args.data ?? {}) as Row) };
    TABLES[model].push(row);
    return { ...row };
  };

  /** Insert many rows (`createMany`). */
  const createMany = async (model: Model, args: Record<string, unknown> = {}) => {
    const rows = (args.data as Row[]) ?? [];
    for (const row of rows) TABLES[model].push({ ...row });
    return { count: rows.length };
  };

  const models = {
    page: {
      findMany: (args: Record<string, unknown>) => findMany("page", args),
      findFirst: (args: Record<string, unknown>) => findFirst("page", args),
      findUnique: (args: Record<string, unknown>) => findUnique("page", args),
      create: (args: Record<string, unknown>) => create("page", args),
      createMany: (args: Record<string, unknown>) => createMany("page", args),
    },
    property: {
      findMany: (args: Record<string, unknown>) => findMany("property", args),
      findFirst: (args: Record<string, unknown>) => findFirst("property", args),
      findUnique: (args: Record<string, unknown>) => findUnique("property", args),
      update: h.propertyUpdate,
      create: (args: Record<string, unknown>) => create("property", args),
      createMany: (args: Record<string, unknown>) => createMany("property", args),
    },
    propertyValue: {
      findMany: (args: Record<string, unknown>) => findMany("propertyValue", args),
      createMany: (args: Record<string, unknown>) => createMany("propertyValue", args),
    },
    databaseView: {
      findMany: (args: Record<string, unknown>) => findMany("databaseView", args),
      createMany: (args: Record<string, unknown>) => createMany("databaseView", args),
    },
    template: {
      findMany: (args: Record<string, unknown>) => findMany("template", args),
      createMany: (args: Record<string, unknown>) => createMany("template", args),
    },
    activity: {
      findMany: (args: Record<string, unknown>) => findMany("activity", args),
    },
  };

  const prisma = {
    ...models,
    /** The interactive transaction — the callback gets the same client. */
    $transaction: async (fn: (tx: typeof models) => Promise<unknown>) => fn(models),
  };

  return { prisma };
});

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));

vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: perm.getWorkspaceAccess,
  canEditContent: perm.canEditContent,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { updatePropertyAction, duplicateDatabaseAction } from "./database";
import { getDatabase } from "@/server/queries";

const WS_A = "ws-a";
const WS_B = "ws-b";

const AT = new Date("2026-01-01T00:00:00.000Z");

/**
 * Two tenants:
 *
 * - `ws-a` — `db-a` (the caller's database), `db-a-2` (a second database of
 *   the same workspace), `page-a` (a plain page), `db-a-deleted`;
 * - `ws-b` — `db-b` with the rows and the cell values the relation must never
 *   deliver.
 */
function seed() {
  for (const table of Object.values(h.tables)) table.length = 0;

  h.tables.user.push(
    { id: "user-a", name: "Ada" },
    { id: "user-b", name: "Bob" },
  );
  h.tables.workspaceMember.push(
    { workspaceId: WS_A, userId: "user-a", role: "MEMBER" },
    { workspaceId: WS_B, userId: "user-b", role: "OWNER" },
  );

  h.tables.page.push(
    {
      id: "db-a",
      workspaceId: WS_A,
      parentId: null,
      type: "DATABASE",
      title: "A's database",
      icon: null,
      deletedAt: null,
      schemaLocked: false,
      position: 0,
      createdById: "user-a",
      createdAt: AT,
    },
    {
      id: "db-a-2",
      workspaceId: WS_A,
      parentId: null,
      type: "DATABASE",
      title: "A's second database",
      icon: null,
      deletedAt: null,
      schemaLocked: false,
      position: 1,
      createdById: "user-a",
      createdAt: AT,
    },
    {
      id: "page-a",
      workspaceId: WS_A,
      parentId: null,
      type: "PAGE",
      title: "A's plain page",
      icon: null,
      deletedAt: null,
      schemaLocked: false,
      position: 2,
      createdById: "user-a",
      createdAt: AT,
    },
    {
      id: "db-a-deleted",
      workspaceId: WS_A,
      parentId: null,
      type: "DATABASE",
      title: "A's deleted database",
      icon: null,
      deletedAt: new Date("2026-02-01T00:00:00.000Z"),
      schemaLocked: false,
      position: 3,
      createdById: "user-a",
      createdAt: AT,
    },
    {
      id: "db-b",
      workspaceId: WS_B,
      parentId: null,
      type: "DATABASE",
      title: "B's database",
      icon: "🏢",
      deletedAt: null,
      schemaLocked: false,
      position: 0,
      createdById: "user-b",
      createdAt: AT,
    },
    {
      id: "row-a-1",
      workspaceId: WS_A,
      parentId: "db-a",
      type: "PAGE",
      title: "A's row",
      icon: null,
      deletedAt: null,
      schemaLocked: false,
      position: 0,
      createdById: "user-a",
      createdAt: AT,
    },
    {
      id: "row-a-2",
      workspaceId: WS_A,
      parentId: "db-a-2",
      type: "PAGE",
      title: "A's second row",
      icon: null,
      deletedAt: null,
      schemaLocked: false,
      position: 0,
      createdById: "user-a",
      createdAt: AT,
    },
    {
      id: "row-b-1",
      workspaceId: WS_B,
      parentId: "db-b",
      type: "PAGE",
      title: "ACME Corp",
      icon: "🏢",
      deletedAt: null,
      schemaLocked: false,
      position: 0,
      createdById: "user-b",
      createdAt: AT,
    },
    {
      id: "row-b-2",
      workspaceId: WS_B,
      parentId: "db-b",
      type: "PAGE",
      title: "Globex GmbH",
      icon: null,
      deletedAt: null,
      schemaLocked: false,
      position: 1,
      createdById: "user-b",
      createdAt: AT,
    },
  );

  h.tables.property.push(
    {
      id: "rel-legacy",
      databasePageId: "db-a",
      name: "Legacy relation",
      type: "RELATION",
      config: { targetDatabaseId: "db-b" },
      position: 0,
    },
    {
      id: "rel-same",
      databasePageId: "db-a",
      name: "Relation to A's second database",
      type: "RELATION",
      config: { targetDatabaseId: "db-a-2" },
      position: 1000,
    },
    {
      id: "rel-write",
      databasePageId: "db-a",
      name: "Relation to configure",
      type: "RELATION",
      config: { targetDatabaseId: null },
      position: 2000,
    },
    {
      id: "p-a",
      databasePageId: "db-a",
      name: "Notes",
      type: "TEXT",
      config: {},
      position: 3000,
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
      id: "p-b",
      databasePageId: "db-b",
      name: "Secret notes",
      type: "TEXT",
      config: {},
      position: 0,
    },
    {
      id: "uid-b",
      databasePageId: "db-b",
      name: "Ticket",
      type: "UNIQUE_ID",
      config: {},
      position: 1000,
    },
  );

  h.tables.propertyValue.push(
    { id: "pv-a-2", propertyId: "p-a-2", pageId: "row-a-2", value: { number: 42 } },
    {
      id: "pv-b-1",
      propertyId: "p-b",
      pageId: "row-b-1",
      value: { text: "B's confidential cell value: revenue 4.2M" },
    },
    {
      id: "pv-b-2",
      propertyId: "p-b",
      pageId: "row-b-2",
      value: { text: "B's second confidential cell value" },
    },
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

/** The error a result carries, if it is an error. */
function errorOf(result: unknown): string | undefined {
  return (result as { error?: string }).error;
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("updatePropertyAction — the relation target must stay in the workspace", () => {
  it("refuses a database of another workspace and writes nothing", async () => {
    const result = await updatePropertyAction("rel-write", {
      config: { targetDatabaseId: "db-b" },
    });

    expect(result).toEqual({ error: "Database not found." });
    expect(h.propertyUpdate).not.toHaveBeenCalled();
  });

  it("answers a foreign target exactly like a missing one", async () => {
    const foreign = await updatePropertyAction("rel-write", {
      config: { targetDatabaseId: "db-b" },
    });
    const missing = await updatePropertyAction("rel-write", {
      config: { targetDatabaseId: "no-such-database" },
    });

    expect(errorOf(foreign)).toBe("Database not found.");
    expect(errorOf(foreign)).toBe(errorOf(missing));
    expect(foreign).toEqual(missing);
    expect(h.propertyUpdate).not.toHaveBeenCalled();
  });

  it("refuses a target that is not a database", async () => {
    const result = await updatePropertyAction("rel-write", {
      config: { targetDatabaseId: "page-a" },
    });

    expect(result).toEqual({ error: "Database not found." });
    expect(h.propertyUpdate).not.toHaveBeenCalled();
  });

  it("refuses a deleted database of the same workspace", async () => {
    const result = await updatePropertyAction("rel-write", {
      config: { targetDatabaseId: "db-a-deleted" },
    });

    expect(result).toEqual({ error: "Database not found." });
    expect(h.propertyUpdate).not.toHaveBeenCalled();
  });

  it("writes a database of the same workspace and the value is readable", async () => {
    const result = await updatePropertyAction("rel-write", {
      config: { targetDatabaseId: "db-a-2" },
    });

    expect(result).toEqual({ ok: true });
    expect(h.propertyUpdate).toHaveBeenCalledWith({
      where: { id: "rel-write" },
      data: { config: { targetDatabaseId: "db-a-2" } },
    });

    const database = await getDatabase("db-a");
    expect(database.relationData["rel-write"].options).toEqual([
      { id: "row-a-2", title: "A's second row", icon: null },
    ]);
  });

  it("stores the trimmed target id, so the read path resolves the relation", async () => {
    const result = await updatePropertyAction("rel-write", {
      config: { targetDatabaseId: " db-a-2 " },
    });

    expect(result).toEqual({ ok: true });
    // The stored config carries the trimmed id — the very id that was checked.
    expect(h.propertyUpdate).toHaveBeenCalledWith({
      where: { id: "rel-write" },
      data: { config: { targetDatabaseId: "db-a-2" } },
    });

    // And the read path resolves it: the relation is not empty.
    const database = await getDatabase("db-a");
    expect(database.relationData["rel-write"].options).toEqual([
      { id: "row-a-2", title: "A's second row", icon: null },
    ]);
    expect(database.relationData["rel-write"].valuesByRow["row-a-2"]).toEqual({
      "p-a-2": { number: 42 },
    });
  });
});

describe("duplicateDatabaseAction — a copy carries only a target of this workspace", () => {
  it("clears a foreign target and keeps a target of the own workspace", async () => {
    const result = await duplicateDatabaseAction("db-a");
    if ("error" in result) throw new Error(`duplicate failed: ${result.error}`);

    const copied = h.tables.property.filter((row) => row.databasePageId === result.id);

    // The legacy relation of another workspace is not carried over: the copy
    // stores an empty relation instead of a target the write side refuses.
    const legacy = copied.find((row) => row.name === "Legacy relation");
    expect(legacy?.config).toEqual({ targetDatabaseId: null });

    // A target of the own workspace stays valid — the copy lives in that
    // workspace, too.
    const same = copied.find((row) => row.name === "Relation to A's second database");
    expect(same?.config).toEqual({ targetDatabaseId: "db-a-2" });

    // The source itself is untouched.
    const source = h.tables.property.find((row) => row.id === "rel-legacy");
    expect(source?.config).toEqual({ targetDatabaseId: "db-b" });
  });
});

describe("getDatabase — a relation never resolves a foreign database", () => {
  it("delivers no rows, no values and no schema of another workspace", async () => {
    const database = await getDatabase("db-a");

    expect(database.relationData["rel-legacy"]).toEqual({
      options: [],
      valuesByRow: {},
      properties: [],
    });

    const payload = JSON.stringify(database.relationData);
    expect(payload).not.toContain("ACME Corp");
    expect(payload).not.toContain("Globex GmbH");
    expect(payload).not.toContain("confidential");
    expect(payload).not.toContain("row-b-1");
    expect(payload).not.toContain("Secret notes");
  });

  it("still delivers the options, the values and the schema of the own workspace", async () => {
    const database = await getDatabase("db-a");

    expect(database.relationData["rel-same"].options).toEqual([
      { id: "row-a-2", title: "A's second row", icon: null },
    ]);
    // The rollup values of the related row.
    expect(database.relationData["rel-same"].valuesByRow["row-a-2"]).toEqual({
      "p-a-2": { number: 42 },
    });
    // The schema of the related database.
    expect(database.relationData["rel-same"].properties).toEqual([
      { id: "p-a-2", name: "Amount", type: "NUMBER" },
    ]);
  });
});
