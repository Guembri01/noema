import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B99 — a cell value may not be filed under a column of a foreign database.
 *
 * `setPropertyValueAction` takes the property id from the client and writes
 * the value with it. The id used to be written into the table unchecked, so a
 * member of workspace A could file a value under a column of a database in
 * workspace B: the value is invisible in B (B reads its rows by `pageId`),
 * but it hijacks the UNIQUE_ID counter of that foreign column. The same
 * shape exists in `runAiAutofillAction`, where the target column comes out of
 * the stored, untrusted column config.
 *
 * The rule: the column has to belong to the row's **own** database — the same
 * database the call was authorised against. The refusal must be the same as
 * for a column id that does not exist, so the caller learns nothing about the
 * foreign id (no existence oracle).
 *
 * Only the transport edges are mocked (`@/lib/db`, `@/lib/auth`,
 * `getWorkspaceAccess`, `next/cache`, `@/lib/ai-provider`); the action logic
 * runs for real. The fake database applies the filters the real one would
 * apply — a `where` with a `databasePageId` only matches a column of that
 * database — so a missing binding in the action shows up here instead of
 * passing silently.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const DATABASE_A = "db-a";
const DATABASE_B = "db-b";
const DATABASE_C = "db-c";

type FakePage = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  type: string;
  schemaLocked: boolean;
  propertyValues: { value: unknown; property: { name: string } }[];
};

type FakeProperty = {
  id: string;
  databasePageId: string;
  type: string;
  config: unknown;
};

/**
 * The pages of the fake database:
 *
 *   - `db-a` — the database of workspace A, the caller's database,
 *   - `row-a` — a normal row of `db-a`,
 *   - `db-b` — the database of workspace B (the foreign one),
 *   - `row-b` — a row of `db-b`,
 *   - `db-c` — a second database **of workspace A** (the row's database is
 *     `db-a`, so a column of `db-c` is foreign here as well).
 *
 * `row-missing` does not exist — it is the reference for "Row not found.".
 */
const PAGES: FakePage[] = [
  {
    id: DATABASE_A,
    workspaceId: WORKSPACE_A,
    parentId: null,
    type: "DATABASE",
    schemaLocked: false,
    propertyValues: [],
  },
  {
    id: "row-a",
    workspaceId: WORKSPACE_A,
    parentId: DATABASE_A,
    type: "PAGE",
    schemaLocked: false,
    propertyValues: [{ value: { text: "Body text" }, property: { name: "Notes" } }],
  },
  {
    id: DATABASE_B,
    workspaceId: WORKSPACE_B,
    parentId: null,
    type: "DATABASE",
    schemaLocked: false,
    propertyValues: [],
  },
  {
    id: "row-b",
    workspaceId: WORKSPACE_B,
    parentId: DATABASE_B,
    type: "PAGE",
    schemaLocked: false,
    propertyValues: [],
  },
  {
    id: DATABASE_C,
    workspaceId: WORKSPACE_A,
    parentId: null,
    type: "DATABASE",
    schemaLocked: false,
    propertyValues: [],
  },
];

/**
 * The columns of the fake database:
 *
 *   - `prop-a` — a column of `db-a` (the caller's database),
 *   - `prop-b` — a column of `db-b` (the foreign one),
 *   - `prop-ai` — an AI-autofill column of `db-a`, whose config names
 *     `prop-b` as its target (the forged configuration of the finding),
 *   - `prop-ai-own` — an AI-autofill column of `db-a` without a target, so
 *     the run writes into the column itself,
 *   - `prop-ai-unknown` — an AI-autofill column of `db-a` whose config names
 *     a target that does not exist,
 *   - `prop-c` — a column of `db-c` (another database of the same workspace),
 *   - `prop-ai-c` — an AI-autofill column of `db-c` whose config names
 *     `prop-c` as its target: the column and its target live in `db-c`, the
 *     row in `db-a`. A target that is bound to the **column's** database
 *     would be accepted here — only the binding to the **row's** database
 *     refuses it.
 */
const PROPERTIES: FakeProperty[] = [
  { id: "prop-a", databasePageId: DATABASE_A, type: "TEXT", config: {} },
  { id: "prop-b", databasePageId: DATABASE_B, type: "TEXT", config: {} },
  {
    id: "prop-ai",
    databasePageId: DATABASE_A,
    type: "AI_AUTOFILL",
    config: { prompt: "Summarize the row.", targetPropertyId: "prop-b" },
  },
  {
    id: "prop-ai-own",
    databasePageId: DATABASE_A,
    type: "AI_AUTOFILL",
    config: { prompt: "Summarize the row." },
  },
  {
    id: "prop-ai-unknown",
    databasePageId: DATABASE_A,
    type: "AI_AUTOFILL",
    config: { prompt: "Summarize the row.", targetPropertyId: "prop-unknown" },
  },
  { id: "prop-c", databasePageId: DATABASE_C, type: "TEXT", config: {} },
  {
    id: "prop-ai-c",
    databasePageId: DATABASE_C,
    type: "AI_AUTOFILL",
    config: { prompt: "Summarize the row.", targetPropertyId: "prop-c" },
  },
];

const h = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  propertyFindFirst: vi.fn(),
  propertyFindUnique: vi.fn(),
  propertyValueUpsert: vi.fn(),
  activityCreate: vi.fn(),
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  revalidatePath: vi.fn(),
  resolveAiConfig: vi.fn(),
  chatComplete: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: h.pageFindUnique },
    property: { findFirst: h.propertyFindFirst, findUnique: h.propertyFindUnique },
    propertyValue: { upsert: h.propertyValueUpsert },
    activity: { create: h.activityCreate },
  },
}));

vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));

// Only the membership lookup is mocked — the role check (`canEditContent`)
// stays the real one.
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));

vi.mock("@/lib/ai-provider", () => ({
  AI_NOT_CONFIGURED: "AI is not configured.",
  resolveAiConfig: h.resolveAiConfig,
  chatComplete: h.chatComplete,
}));

import { runAiAutofillAction } from "./ai-autofill";
import { setPropertyValueAction } from "./database";

/** The error message of a result, or `null` when the action succeeded. */
function errorOf(result: unknown): string | null {
  return result && typeof result === "object" && "error" in result
    ? String((result as { error: string }).error)
    : null;
}

/** The property ids the action wrote a value under. */
function writtenPropertyIds(): string[] {
  return h.propertyValueUpsert.mock.calls.map(
    (call) =>
      (call[0] as { where: { propertyId_pageId: { propertyId: string } } }).where
        .propertyId_pageId.propertyId,
  );
}

/** The `data` of the activity entries the action wrote. */
function activityWorkspaces(): string[] {
  return h.activityCreate.mock.calls.map(
    (call) => (call[0] as { data: { workspaceId: string } }).data.workspaceId,
  );
}

/**
 * The order of the **last** call of a mock — the global invocation order, so
 * the order of two different mocks can be compared with each other.
 */
function lastCallOrder(mock: { mock: { invocationCallOrder: number[] } }): number {
  const order = mock.mock.invocationCallOrder;
  return order[order.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();

  h.requireUser.mockResolvedValue({
    id: "user-a",
    email: "member@example.test",
    name: "Member",
    avatarUrl: null,
    theme: "system",
    locale: "en",
  });
  h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

  // The fake database applies the filters the real one would: the `where`
  // clause is honoured (including a `databasePageId`, when the action asks for
  // one) and the `select` decides which fields come back.
  h.pageFindUnique.mockImplementation(
    async (args: {
      where: { id?: string; workspaceId?: string };
      select?: Record<string, boolean>;
    }) => {
      const where = args.where ?? {};
      const page = PAGES.find((candidate) => {
        if (where.id !== undefined && candidate.id !== where.id) return false;
        if (
          where.workspaceId !== undefined &&
          candidate.workspaceId !== where.workspaceId
        ) {
          return false;
        }
        return true;
      });
      if (!page) return null;
      if (!args.select) return { ...page };
      const selected: Record<string, unknown> = {};
      for (const [field, wanted] of Object.entries(args.select)) {
        if (wanted) selected[field] = page[field as keyof FakePage];
      }
      return selected;
    },
  );

  // A column is only found when it belongs to the database the query names —
  // exactly the filter the real database applies.
  h.propertyFindFirst.mockImplementation(
    async (args: {
      where: { id?: string; databasePageId?: string };
      select?: Record<string, boolean>;
    }) => {
      const where = args.where ?? {};
      const property = PROPERTIES.find((candidate) => {
        if (where.id !== undefined && candidate.id !== where.id) return false;
        if (
          where.databasePageId !== undefined &&
          candidate.databasePageId !== where.databasePageId
        ) {
          return false;
        }
        return true;
      });
      if (!property) return null;
      if (!args.select) return { ...property };
      const selected: Record<string, unknown> = {};
      for (const [field, wanted] of Object.entries(args.select)) {
        if (wanted) selected[field] = property[field as keyof FakeProperty];
      }
      return selected;
    },
  );

  // The AI column is read with a `select` — the fake database returns
  // **only the selected fields**, every other field is `undefined`, exactly
  // as in the real database. A binding that reads an unselected field (for
  // example `databasePageId`) therefore finds `undefined` here and cannot
  // pass silently.
  h.propertyFindUnique.mockImplementation(
    async (args: {
      where: { id?: string };
      select?: Record<string, boolean>;
    }) => {
      const property = PROPERTIES.find(
        (candidate) => candidate.id === args.where?.id,
      );
      if (!property) return null;
      const row = {
        id: property.id,
        type: property.type,
        config: property.config,
        databasePage: {
          workspaceId:
            PAGES.find((page) => page.id === property.databasePageId)
              ?.workspaceId ?? "",
        },
      };
      if (!args.select) return { ...row };
      const selected: Record<string, unknown> = {};
      for (const [field, wanted] of Object.entries(args.select)) {
        if (wanted) selected[field] = row[field as keyof typeof row];
      }
      return selected;
    },
  );

  h.propertyValueUpsert.mockResolvedValue({ id: "cell-1" });
  h.activityCreate.mockResolvedValue({ id: "activity-1" });
  h.resolveAiConfig.mockResolvedValue({ provider: "mock", source: "env" });
  h.chatComplete.mockResolvedValue({ ok: true, text: "generated value" });
});

describe("setPropertyValueAction — property scope (B99)", () => {
  it("does not write a cell value under a column of another database", async () => {
    const result = await setPropertyValueAction("row-a", "prop-b", {
      text: "written from A",
    });

    expect(result).toEqual({ error: "Property not found." });
    expect(h.propertyValueUpsert).not.toHaveBeenCalled();
    expect(h.activityCreate).not.toHaveBeenCalled();
  });

  it("answers a foreign column exactly like a column that does not exist", async () => {
    const foreign = await setPropertyValueAction("row-a", "prop-b", {
      text: "written from A",
    });
    const missing = await setPropertyValueAction("row-a", "prop-missing", {
      text: "written from A",
    });

    expect(errorOf(missing)).toBe("Property not found.");
    expect(errorOf(foreign)).toBe(errorOf(missing));
    expect(h.propertyValueUpsert).not.toHaveBeenCalled();
  });

  it("writes the value under a column of the row's own database", async () => {
    const result = await setPropertyValueAction("row-a", "prop-a", {
      text: "A's value",
    });

    expect(result).toEqual({ ok: true });
    expect(h.propertyValueUpsert).toHaveBeenCalledTimes(1);
    expect(h.propertyValueUpsert.mock.calls[0][0]).toMatchObject({
      where: { propertyId_pageId: { propertyId: "prop-a", pageId: "row-a" } },
      create: { propertyId: "prop-a", pageId: "row-a", value: { text: "A's value" } },
    });
  });

  it("files the activity entry in the workspace of the row", async () => {
    await setPropertyValueAction("row-a", "prop-a", { text: "A's value" });

    expect(h.activityCreate).toHaveBeenCalledTimes(1);
    expect(activityWorkspaces()).toEqual([WORKSPACE_A]);
  });
});

describe("runAiAutofillAction — target property scope (B99)", () => {
  it("does not write the generated value under a column of another database", async () => {
    const result = await runAiAutofillAction({
      workspaceId: WORKSPACE_A,
      rowId: "row-a",
      propertyId: "prop-ai",
    });

    expect(result).toEqual({
      ok: false,
      error: "That target property does not belong to this database.",
    });
    // The target check runs **before** the provider: a run that cannot write
    // is not worth a model call.
    expect(h.resolveAiConfig).not.toHaveBeenCalled();
    expect(h.chatComplete).not.toHaveBeenCalled();
    expect(h.propertyValueUpsert).not.toHaveBeenCalled();
    expect(writtenPropertyIds()).not.toContain("prop-b");
  });

  it("does not write the generated value under a column of another database of the same workspace", async () => {
    // The AI column `prop-ai-c` and its target `prop-c` both live in `db-c`,
    // the row in `db-a`: the target has to be bound to the **row's**
    // database, not to the database of the column that names it.
    const result = await runAiAutofillAction({
      workspaceId: WORKSPACE_A,
      rowId: "row-a",
      propertyId: "prop-ai-c",
    });

    expect(result).toEqual({
      ok: false,
      error: "That target property does not belong to this database.",
    });
    expect(h.resolveAiConfig).not.toHaveBeenCalled();
    expect(h.chatComplete).not.toHaveBeenCalled();
    expect(h.propertyValueUpsert).not.toHaveBeenCalled();
    expect(writtenPropertyIds()).not.toContain("prop-c");
  });

  it("checks the target before the provider is called", async () => {
    const result = await runAiAutofillAction({
      workspaceId: WORKSPACE_A,
      rowId: "row-a",
      propertyId: "prop-ai-own",
    });

    expect(result.ok).toBe(true);
    // The target check (`property.findFirst`) has to run before the provider
    // (`chatComplete`) — the order is part of the rule, not an accident.
    expect(lastCallOrder(h.propertyFindFirst)).toBeLessThan(
      lastCallOrder(h.chatComplete),
    );
  });

  it("answers a foreign target exactly like a target that does not exist", async () => {
    const foreign = await runAiAutofillAction({
      workspaceId: WORKSPACE_A,
      rowId: "row-a",
      propertyId: "prop-ai",
    });
    const missing = await runAiAutofillAction({
      workspaceId: WORKSPACE_A,
      rowId: "row-a",
      propertyId: "prop-ai-unknown",
    });

    expect(missing.ok).toBe(false);
    expect(foreign.ok).toBe(false);
    expect((foreign as { error: string }).error).toBe(
      (missing as { error: string }).error,
    );
    expect(h.propertyValueUpsert).not.toHaveBeenCalled();
  });

  it("writes the generated value into a target of the row's own database", async () => {
    const result = await runAiAutofillAction({
      workspaceId: WORKSPACE_A,
      rowId: "row-a",
      propertyId: "prop-ai-own",
    });

    expect(result).toEqual({
      ok: true,
      propertyId: "prop-ai-own",
      value: "generated value",
    });
    expect(writtenPropertyIds()).toEqual(["prop-ai-own"]);
    expect(h.propertyValueUpsert.mock.calls[0][0]).toMatchObject({
      where: { propertyId_pageId: { propertyId: "prop-ai-own", pageId: "row-a" } },
      create: {
        propertyId: "prop-ai-own",
        pageId: "row-a",
        value: { text: "generated value" },
      },
    });
  });
});
