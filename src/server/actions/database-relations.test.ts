import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Relation/rollup write-path contract tests.
 *
 * The transport edges are mocked; the actions run for real against a small
 * in-memory store. The cases pin the R21 invariants that are easy to regress:
 * target ids are validated, single relations clamp, reciprocal writes happen in
 * one transaction, two-way enable/disable keeps both configs coherent, the
 * picker pages with a cursor, and rollup/formula configs are validated before
 * they are stored.
 */

type StoredPage = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  type: string;
  title: string;
  icon: string | null;
  deletedAt: Date | null;
  schemaLocked: boolean;
  permissions: { userId: string; level: string }[];
  position?: number;
};
type StoredProperty = {
  id: string;
  databasePageId: string;
  name: string;
  type: string;
  config: unknown;
  position: number;
};
type StoredValue = { propertyId: string; pageId: string; value: unknown };

const h = vi.hoisted(() => {
  const db = {
    page: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    property: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    propertyValue: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  return {
    db,
    auth: { requireUser: vi.fn() },
    perms: { getWorkspaceAccess: vi.fn() },
    guest: { guestReadablePageIds: vi.fn() },
    activity: { logActivity: vi.fn() },
    cache: { revalidatePath: vi.fn() },
  };
});

vi.mock("@/lib/db", () => ({ prisma: h.db }));
vi.mock("@/lib/auth", () => ({ requireUser: h.auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: h.perms.getWorkspaceAccess,
}));
vi.mock("@/lib/guest-access", () => ({
  guestReadablePageIds: h.guest.guestReadablePageIds,
}));
vi.mock("@/lib/activity", () => ({ logActivity: h.activity.logActivity }));
vi.mock("next/cache", () => ({ revalidatePath: h.cache.revalidatePath }));

import {
  searchRelationTargetsAction,
  setPropertyValueAction,
  setRelationTwoWayAction,
  updatePropertyAction,
} from "./database";

const pages = new Map<string, StoredPage>();
const properties = new Map<string, StoredProperty>();
const values = new Map<string, StoredValue>();

const page = (id: string, overrides: Partial<StoredPage> = {}): StoredPage => ({
  id,
  workspaceId: "ws1",
  parentId: null,
  type: "PAGE",
  title: id,
  icon: null,
  deletedAt: null,
  schemaLocked: false,
  permissions: [],
  ...overrides,
});
const property = (
  id: string,
  databasePageId: string,
  type: string,
  config: unknown,
  position = 1000,
): StoredProperty => ({ id, databasePageId, name: id, type, config, position });

function matches(
  candidate: Record<string, unknown>,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (key === "AND") {
      const clauses = expected as Record<string, unknown>[];
      if (!clauses.every((clause) => matches(candidate, clause))) return false;
      continue;
    }
    const actual = candidate[key];
    if (
      expected &&
      typeof expected === "object" &&
      !Array.isArray(expected) &&
      !(expected instanceof Date)
    ) {
      const operator = expected as Record<string, unknown>;
      if ("in" in operator) {
        if (!(operator.in as unknown[]).includes(actual)) return false;
        continue;
      }
      if ("gt" in operator) {
        if (typeof actual !== "string" || actual <= String(operator.gt)) return false;
        continue;
      }
      if ("equals" in operator) {
        if (actual !== operator.equals) return false;
        continue;
      }
      if ("not" in operator) {
        if (actual === operator.not) return false;
        continue;
      }
      return false;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function allPages(): Record<string, unknown>[] {
  return [...pages.values()] as unknown as Record<string, unknown>[];
}
function allProperties(): Record<string, unknown>[] {
  return [...properties.values()] as unknown as Record<string, unknown>[];
}

beforeEach(() => {
  pages.clear();
  properties.clear();
  values.clear();
  vi.clearAllMocks();

  h.auth.requireUser.mockResolvedValue({ id: "u1", name: "Ada" });
  h.perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  h.guest.guestReadablePageIds.mockResolvedValue(new Set(["db-a"]));
  h.activity.logActivity.mockResolvedValue(undefined);
  h.cache.revalidatePath.mockReturnValue(undefined);
  h.db.$transaction.mockImplementation(
    async (fn: (tx: typeof h.db) => Promise<unknown>) => fn(h.db),
  );

  h.db.page.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => pages.get(where.id) ?? null,
  );
  h.db.page.findFirst.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) =>
      allPages().find((candidate) => matches(candidate, where)) ?? null,
  );
  h.db.page.findMany.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) =>
      allPages().filter((candidate) => matches(candidate, where)),
  );

  h.db.property.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => properties.get(where.id) ?? null,
  );
  h.db.property.findFirst.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) => {
      if (where && typeof where.id === "string") {
        return properties.get(where.id) ?? null;
      }
      return allProperties().find((candidate) => matches(candidate, where)) ?? null;
    },
  );
  h.db.property.findMany.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> }) =>
      allProperties().filter((candidate) => matches(candidate, where)),
  );
  h.db.property.update.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { config?: unknown; name?: string };
    }) => {
      const current = properties.get(where.id);
      if (!current) throw new Error("missing property");
      const next = {
        ...current,
        ...(data.config !== undefined ? { config: data.config } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
      };
      properties.set(where.id, next);
      return next;
    },
  );
  h.db.property.create.mockImplementation(
    async ({ data }: { data: Omit<StoredProperty, "id"> }) => {
      const created = { ...data, id: `created-${properties.size + 1}` };
      properties.set(created.id, created);
      return created;
    },
  );
  h.db.propertyValue.findUnique.mockImplementation(
    async ({
      where,
    }: {
      where: { propertyId_pageId: { propertyId: string; pageId: string } };
    }) =>
      values.get(
        `${where.propertyId_pageId.propertyId}:${where.propertyId_pageId.pageId}`,
      ) ?? null,
  );
  h.db.propertyValue.findMany.mockImplementation(
    async ({ where }: { where?: { propertyId?: string } }) =>
      [...values.values()].filter(
        (entry) => !where?.propertyId || entry.propertyId === where.propertyId,
      ),
  );
  h.db.propertyValue.upsert.mockImplementation(
    async ({
      where,
      create,
      update,
    }: {
      where: { propertyId_pageId: { propertyId: string; pageId: string } };
      create: StoredValue;
      update: { value: unknown };
    }) => {
      const key = `${where.propertyId_pageId.propertyId}:${where.propertyId_pageId.pageId}`;
      const existing = values.get(key);
      const next = existing
        ? { ...existing, value: update.value }
        : { ...create };
      values.set(key, next);
      return next;
    },
  );
});

function seedDatabase(id: string) {
  pages.set(id, page(id, { type: "DATABASE", title: id }));
}
function seedRow(id: string, databaseId: string, title = id) {
  pages.set(
    id,
    page(id, { parentId: databaseId, type: "PAGE", title }),
  );
}

describe("setPropertyValueAction — relation writes", () => {
  beforeEach(() => {
    seedDatabase("db-a");
    seedDatabase("db-b");
    seedRow("a1", "db-a");
    seedRow("b1", "db-b");
    seedRow("b2", "db-b");
    properties.set(
      "rel",
      property("rel", "db-a", "RELATION", {
        targetDatabaseId: "db-b",
        multi: true,
        inversePropertyId: "back",
      }),
    );
    properties.set(
      "back",
      property("back", "db-b", "RELATION", {
        targetDatabaseId: "db-a",
        multi: true,
        inversePropertyId: "rel",
      }),
    );
  });

  it("writes the source and the reciprocal cell in one transaction", async () => {
    const result = await setPropertyValueAction("a1", "rel", {
      pageIds: ["b1"],
    });

    expect(result).toEqual({ ok: true });
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(values.get("rel:a1")?.value).toEqual({ pageIds: ["b1"] });
    expect(values.get("back:b1")?.value).toEqual({ pageIds: ["a1"] });
    expect(h.activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "a1", action: "row.edited" }),
    );
    expect(h.activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "b1", action: "row.edited" }),
    );
  });

  it("removes the reciprocal link when the source selection shrinks", async () => {
    values.set("rel:a1", {
      propertyId: "rel",
      pageId: "a1",
      value: { pageIds: ["b1"] },
    });
    values.set("back:b1", {
      propertyId: "back",
      pageId: "b1",
      value: { pageIds: ["a1"] },
    });

    const result = await setPropertyValueAction("a1", "rel", { pageIds: [] });

    expect(result).toEqual({ ok: true });
    expect(values.get("rel:a1")?.value).toEqual({ pageIds: [] });
    expect(values.get("back:b1")?.value).toEqual({ pageIds: [] });
  });

  it("prunes unknown ids, refuses a self link and clamps a single relation", async () => {
    properties.set(
      "rel",
      property("rel", "db-a", "RELATION", {
        targetDatabaseId: "db-b",
        multi: false,
        inversePropertyId: "back",
      }),
    );

    const result = await setPropertyValueAction("a1", "rel", {
      pageIds: ["a1", "missing", "b2", "b1"],
    });

    expect(result).toEqual({ ok: true });
    expect(values.get("rel:a1")?.value).toEqual({ pageIds: ["b2"] });
    expect(values.get("back:b2")?.value).toEqual({ pageIds: ["a1"] });
    expect(values.get("back:b1")).toBeUndefined();
  });

  it("refuses an unconfigured relation and a malformed value", async () => {
    properties.set(
      "rel",
      property("rel", "db-a", "RELATION", {
        targetDatabaseId: null,
        multi: true,
        inversePropertyId: null,
      }),
    );
    expect(
      await setPropertyValueAction("a1", "rel", { pageIds: ["b1"] }),
    ).toEqual({ error: "Configure the relation first." });

    properties.set(
      "rel",
      property("rel", "db-a", "RELATION", {
        targetDatabaseId: "db-b",
        multi: true,
        inversePropertyId: null,
      }),
    );
    expect(await setPropertyValueAction("a1", "rel", { nope: [] })).toEqual({
      error: "Relation value is not valid.",
    });
  });

  it("detaches a target from an older source when the reciprocal is single", async () => {
    properties.set(
      "back",
      property("back", "db-b", "RELATION", {
        targetDatabaseId: "db-a",
        multi: false,
        inversePropertyId: "rel",
      }),
    );
    seedRow("a2", "db-a");
    values.set("back:b1", {
      propertyId: "back",
      pageId: "b1",
      value: { pageIds: ["a2"] },
    });
    values.set("rel:a2", {
      propertyId: "rel",
      pageId: "a2",
      value: { pageIds: ["b1"] },
    });

    const result = await setPropertyValueAction("a1", "rel", {
      pageIds: ["b1"],
    });

    expect(result).toEqual({ ok: true });
    expect(values.get("back:b1")?.value).toEqual({ pageIds: ["a1"] });
    expect(values.get("rel:a2")?.value).toEqual({ pageIds: [] });
  });
});

describe("searchRelationTargetsAction", () => {
  beforeEach(() => {
    seedDatabase("db-a");
    seedDatabase("db-b");
    properties.set(
      "rel",
      property("rel", "db-a", "RELATION", {
        targetDatabaseId: "db-b",
        multi: true,
        inversePropertyId: null,
      }),
    );
    for (let index = 1; index <= 21; index += 1) {
      seedRow(`b${String(index).padStart(2, "0")}`, "db-b");
    }
  });

  it("returns an id-ordered page and a cursor for the next one", async () => {
    const result = await searchRelationTargetsAction("rel", "", null);

    expect(result).toMatchObject({
      ok: true,
      nextCursor: "b20",
    });
    if (!("ok" in result)) throw new Error("expected ok");
    expect(result.items).toHaveLength(20);
    expect(result.items[0].id).toBe("b01");
  });

  it("passes the debounced query, cursor and guest scope into the page query", async () => {
    h.perms.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
    h.guest.guestReadablePageIds.mockResolvedValue(new Set(["db-a", "db-b"]));
    h.db.page.findMany.mockResolvedValueOnce([
      { id: "b21", title: "b21", icon: null },
    ]);

    const result = await searchRelationTargetsAction("rel", " b2 ", "b20");

    expect(result).toEqual({
      ok: true,
      items: [{ id: "b21", title: "b21", icon: null }],
      nextCursor: null,
    });
    const args = h.db.page.findMany.mock.calls[0][0];
    expect(args.take).toBe(21);
    expect(args.orderBy).toEqual({ id: "asc" });
    expect(JSON.stringify(args.where)).toContain("\"gt\":\"b20\"");
    expect(JSON.stringify(args.where)).toContain("b2");
  });

  it("returns an empty page for a guest outside the target scope", async () => {
    h.perms.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
    h.guest.guestReadablePageIds.mockResolvedValue(new Set(["db-a"]));

    const result = await searchRelationTargetsAction("rel", "", null);

    expect(result).toEqual({ ok: true, items: [], nextCursor: null });
    expect(h.db.page.findMany).not.toHaveBeenCalled();
  });
});

describe("setRelationTwoWayAction", () => {
  beforeEach(() => {
    seedDatabase("db-a");
    seedDatabase("db-b");
    seedRow("a1", "db-a");
    seedRow("a2", "db-a");
    seedRow("b1", "db-b");
    properties.set(
      "rel",
      property("rel", "db-a", "RELATION", {
        targetDatabaseId: "db-b",
        multi: true,
        inversePropertyId: null,
      }),
    );
    values.set("rel:a1", {
      propertyId: "rel",
      pageId: "a1",
      value: { pageIds: ["b1"] },
    });
    values.set("rel:a2", {
      propertyId: "rel",
      pageId: "a2",
      value: { pageIds: ["b1"] },
    });
  });

  it("creates the reciprocal column, pairs both configs and backfills", async () => {
    h.db.page.findMany.mockResolvedValueOnce([{ id: "b1" }]);
    h.db.property.create.mockImplementationOnce(
      async ({ data }: { data: Omit<StoredProperty, "id"> }) => {
        const created = { ...data, id: "back" };
        properties.set(created.id, created);
        return created;
      },
    );

    const result = await setRelationTwoWayAction("rel", true);

    expect(result).toEqual({ ok: true, inversePropertyId: "back" });
    expect(properties.get("rel")?.config).toMatchObject({
      targetDatabaseId: "db-b",
      inversePropertyId: "back",
    });
    expect(properties.get("back")?.config).toMatchObject({
      targetDatabaseId: "db-a",
      inversePropertyId: "rel",
    });
    expect(values.get("back:b1")?.value).toEqual({ pageIds: ["a1", "a2"] });
  });

  it("re-enables by reusing an unpaired same-named relation", async () => {
    properties.set(
      "back",
      property("back", "db-b", "RELATION", {
        targetDatabaseId: "db-a",
        multi: true,
        inversePropertyId: null,
      }),
    );
    properties.get("back")!.name = "rel";
    h.db.page.findMany.mockResolvedValueOnce([{ id: "b1" }]);

    const result = await setRelationTwoWayAction("rel", true);

    expect(result).toEqual({ ok: true, inversePropertyId: "back" });
    expect(h.db.property.create).not.toHaveBeenCalled();
  });

  it("disables by clearing both pair pointers without deleting values", async () => {
    properties.set(
      "rel",
      property("rel", "db-a", "RELATION", {
        targetDatabaseId: "db-b",
        multi: true,
        inversePropertyId: "back",
      }),
    );
    properties.set(
      "back",
      property("back", "db-b", "RELATION", {
        targetDatabaseId: "db-a",
        multi: true,
        inversePropertyId: "rel",
      }),
    );

    const result = await setRelationTwoWayAction("rel", false);

    expect(result).toEqual({ ok: true, inversePropertyId: null });
    expect(properties.get("rel")?.config).toMatchObject({
      inversePropertyId: null,
    });
    expect(properties.get("back")?.config).toMatchObject({
      inversePropertyId: null,
    });
  });
});

describe("updatePropertyAction — relation/rollup/formula config validation", () => {
  beforeEach(() => {
    seedDatabase("db-a");
    seedDatabase("db-b");
    seedRow("b1", "db-b");
    properties.set(
      "rel",
      property("rel", "db-a", "RELATION", {
        targetDatabaseId: "db-b",
        multi: true,
        inversePropertyId: null,
      }),
    );
    properties.set(
      "points",
      property("points", "db-b", "NUMBER", null),
    );
    properties.set(
      "roll",
      property("roll", "db-a", "ROLLUP", {
        relationPropertyId: "rel",
        targetPropertyId: "points",
        function: "sum",
      }),
    );
    properties.set(
      "formula",
      property("formula", "db-a", "FORMULA", { expression: "1 + 1" }),
    );
  });

  it("stores the canonical relation shape", async () => {
    const result = await updatePropertyAction("rel", {
      config: { targetDatabaseId: " db-b ", multi: false },
    });

    expect(result).toEqual({ ok: true });
    expect(properties.get("rel")?.config).toEqual({
      targetDatabaseId: "db-b",
      multi: false,
      inversePropertyId: null,
    });
  });

  it("keeps both sides of a two-way pair on the same cardinality", async () => {
    properties.set(
      "rel",
      property("rel", "db-a", "RELATION", {
        targetDatabaseId: "db-b",
        multi: true,
        inversePropertyId: "back",
      }),
    );
    properties.set(
      "back",
      property("back", "db-b", "RELATION", {
        targetDatabaseId: "db-a",
        multi: true,
        inversePropertyId: "rel",
      }),
    );

    const result = await updatePropertyAction("rel", {
      config: {
        targetDatabaseId: "db-b",
        multi: false,
        inversePropertyId: "back",
      },
    });

    expect(result).toEqual({ ok: true });
    expect(properties.get("rel")?.config).toMatchObject({ multi: false });
    expect(properties.get("back")?.config).toMatchObject({ multi: false });
  });

  it("repairs a half-pair instead of leaving a one-sided reciprocal", async () => {
    properties.set(
      "rel",
      property("rel", "db-a", "RELATION", {
        targetDatabaseId: "db-b",
        multi: true,
        inversePropertyId: "back",
      }),
    );
    properties.set(
      "back",
      property("back", "db-b", "RELATION", {
        targetDatabaseId: "db-a",
        multi: true,
        inversePropertyId: null,
      }),
    );

    const result = await updatePropertyAction("rel", {
      config: {
        targetDatabaseId: "db-b",
        multi: true,
        inversePropertyId: "back",
      },
    });

    expect(result).toEqual({ ok: true });
    expect(properties.get("back")?.config).toMatchObject({
      inversePropertyId: "rel",
    });
  });

  it("refuses a rollup whose function cannot aggregate the target type", async () => {
    const result = await updatePropertyAction("roll", {
      config: {
        relationPropertyId: "rel",
        targetPropertyId: "points",
        function: "checked",
      },
    });

    expect(result).toEqual({
      error: '"checked" cannot aggregate a NUMBER target.',
    });
    expect(properties.get("roll")?.config).toMatchObject({ function: "sum" });
  });

  it("refuses an unparseable formula before writing it", async () => {
    const result = await updatePropertyAction("formula", {
      config: { expression: "1 +" },
    });

    expect("error" in result).toBe(true);
    expect(properties.get("formula")?.config).toEqual({ expression: "1 + 1" });
  });
});
