import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `runAiAutofillAction` — run an AI-autofill column's prompt for a row and
 * write the target property. The column config is untrusted stored JSON, so the
 * action must validate it before calling the provider, it must never write
 * across a workspace boundary, and the column the value is written into must
 * belong to the row's own database (B99).
 *
 * Only prisma, auth, permissions, the provider and the cache are mocked; the
 * action's validation and ordering logic run for real.
 */

const db = vi.hoisted(() => ({
  propertyFindUnique: vi.fn(),
  propertyFindFirst: vi.fn(),
  pageFindUnique: vi.fn(),
  valueUpsert: vi.fn(),
}));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const perm = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn(), canEditContent: vi.fn() }));
const ai = vi.hoisted(() => ({ resolveAiConfig: vi.fn(), chatComplete: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    property: { findUnique: db.propertyFindUnique, findFirst: db.propertyFindFirst },
    page: { findUnique: db.pageFindUnique },
    propertyValue: { upsert: db.valueUpsert },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: perm.getWorkspaceAccess,
  canEditContent: perm.canEditContent,
}));
vi.mock("@/lib/ai-provider", () => ({
  AI_NOT_CONFIGURED: "AI is not configured.",
  chatComplete: ai.chatComplete,
  resolveAiConfig: ai.resolveAiConfig,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { runAiAutofillAction } from "./ai-autofill";

const CONFIG = {
  provider: "mock",
  baseUrl: "http://localhost:1/v1",
  model: "m",
  apiKey: "k",
  source: "env" as const,
};

const INPUT = { workspaceId: "ws1", rowId: "row1", propertyId: "p1" };

/**
 * The columns of the fake database: the AI column `p1` and its target `p2`,
 * both of them columns of the database `db1` the row hangs under. A column of
 * another database is not found — the fake applies the filter the real
 * database applies.
 */
const COLUMNS = [
  { id: "p1", databasePageId: "db1" },
  { id: "p2", databasePageId: "db1" },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "u1" });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  perm.canEditContent.mockReturnValue(true);
  db.propertyFindUnique.mockResolvedValue({
    id: "p1",
    type: "AI_AUTOFILL",
    config: { prompt: "Summarize the row.", targetPropertyId: "p2" },
    databasePage: { workspaceId: "ws1" },
  });
  db.propertyFindFirst.mockImplementation(
    async (args: { where: { id?: string; databasePageId?: string } }) => {
      const where = args.where ?? {};
      const column = COLUMNS.find(
        (candidate) =>
          (where.id === undefined || candidate.id === where.id) &&
          (where.databasePageId === undefined ||
            candidate.databasePageId === where.databasePageId),
      );
      return column ? { id: column.id } : null;
    },
  );
  db.pageFindUnique.mockResolvedValue({
    id: "row1",
    workspaceId: "ws1",
    parentId: "db1",
    title: "Launch plan",
    propertyValues: [{ value: { text: "Body text" }, property: { name: "Notes" } }],
  });
  db.valueUpsert.mockResolvedValue({});
  ai.resolveAiConfig.mockResolvedValue(CONFIG);
  ai.chatComplete.mockResolvedValue({ ok: true, text: "  generated value  " });
});

describe("access control", () => {
  it("refuses a guest without calling the provider", async () => {
    perm.canEditContent.mockReturnValue(false);
    await expect(runAiAutofillAction(INPUT)).resolves.toEqual({
      ok: false,
      error: "You do not have permission to run AI autofill.",
    });
    expect(ai.chatComplete).not.toHaveBeenCalled();
  });

  it("refuses a column from another workspace", async () => {
    db.propertyFindUnique.mockResolvedValue({
      id: "p1",
      type: "AI_AUTOFILL",
      config: { prompt: "x" },
      databasePage: { workspaceId: "other" },
    });
    await expect(runAiAutofillAction(INPUT)).resolves.toEqual({
      ok: false,
      error: "That column does not belong to this workspace.",
    });
  });

  it("refuses a row from another workspace", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "row1",
      workspaceId: "other",
      title: "T",
      propertyValues: [],
    });
    await expect(runAiAutofillAction(INPUT)).resolves.toEqual({
      ok: false,
      error: "That row does not belong to this workspace.",
    });
  });
});

describe("config validation", () => {
  it("rejects a non-AI-autofill column", async () => {
    db.propertyFindUnique.mockResolvedValue({
      id: "p1",
      type: "TEXT",
      config: {},
      databasePage: { workspaceId: "ws1" },
    });
    await expect(runAiAutofillAction(INPUT)).resolves.toEqual({
      ok: false,
      error: "That property is not an AI-autofill column.",
    });
  });

  it("rejects a config with an empty prompt before calling the provider", async () => {
    db.propertyFindUnique.mockResolvedValue({
      id: "p1",
      type: "AI_AUTOFILL",
      config: { prompt: "   " },
      databasePage: { workspaceId: "ws1" },
    });
    const result = await runAiAutofillAction(INPUT);
    expect(result.ok).toBe(false);
    expect(ai.chatComplete).not.toHaveBeenCalled();
  });

  it("reports AI as unconfigured when no provider resolves", async () => {
    ai.resolveAiConfig.mockResolvedValue(null);
    await expect(runAiAutofillAction(INPUT)).resolves.toEqual({
      ok: false,
      error: "AI is not configured.",
    });
  });
});

describe("writing the target property", () => {
  it("writes the trimmed completion into the configured target", async () => {
    await expect(runAiAutofillAction(INPUT)).resolves.toEqual({
      ok: true,
      propertyId: "p2",
      value: "generated value",
    });
    expect(db.valueUpsert).toHaveBeenCalledWith({
      where: { propertyId_pageId: { propertyId: "p2", pageId: "row1" } },
      create: { propertyId: "p2", pageId: "row1", value: { text: "generated value" } },
      update: { value: { text: "generated value" } },
    });
    expect(ai.chatComplete).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.stringContaining("Body text") }),
      CONFIG,
    );
  });

  it("falls back to the column itself when no target is set", async () => {
    db.propertyFindUnique.mockResolvedValue({
      id: "p1",
      type: "AI_AUTOFILL",
      config: { prompt: "Write something." },
      databasePage: { workspaceId: "ws1" },
    });
    await expect(runAiAutofillAction(INPUT)).resolves.toEqual({
      ok: true,
      propertyId: "p1",
      value: "generated value",
    });
  });

  it("does not write when the provider fails", async () => {
    ai.chatComplete.mockResolvedValue({ ok: false, status: 502, error: "provider down" });
    await expect(runAiAutofillAction(INPUT)).resolves.toEqual({
      ok: false,
      error: "provider down",
    });
    expect(db.valueUpsert).not.toHaveBeenCalled();
  });
});
