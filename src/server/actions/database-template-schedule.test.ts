import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R31.20/R31.22 — the user-facing schedule actions: set/edit/clear, pause and
 * resume, authorization and input validation.
 *
 * Authorization is the same `authorizeDatabase` path manual template
 * application uses; the tests prove an unavailable database refuses before any
 * update, and that config (saved values) survives a schedule change.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  templateFindUnique: vi.fn(),
  templateUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique },
    template: {
      findUnique: db.templateFindUnique,
      update: db.templateUpdate,
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: vi.fn(() => true),
}));
vi.mock("@/lib/guest-access", () => ({
  guestReadablePageIds: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  setTemplatePausedAction,
  setTemplateRecurrenceAction,
} from "./database";

const DB = "db-1";
const now = new Date(2026, 0, 5, 9, 37);

const databasePage = {
  id: DB,
  workspaceId: "ws-1",
  type: "DATABASE",
  schemaLocked: false,
  permissions: [],
};

const template = (over: Record<string, unknown> = {}) => ({
  id: "t-1",
  databasePageId: DB,
  config: { values: [{ propertyId: "p-1", value: { text: "hello" } }] },
  recurrence: "daily",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockResolvedValue(databasePage);
  db.templateFindUnique.mockImplementation(
    async (args: { where: { id?: string }; select?: Record<string, boolean> }) => {
      if (args.where?.id !== "t-1") return null;
      const source = template();
      if (!args.select) return source;
      const projected: Record<string, unknown> = {};
      for (const [field, wanted] of Object.entries(args.select)) {
        if (wanted) projected[field] = (source as Record<string, unknown>)[field];
      }
      return projected;
    },
  );
  db.templateUpdate.mockResolvedValue({});
});

/** The `data` of the last `template.update` call. */
function updated(): Record<string, unknown> {
  const call = db.templateUpdate.mock.calls.at(-1);
  return ((call?.[0] as { data?: Record<string, unknown> })?.data ?? {}) as Record<
    string,
    unknown
  >;
}

describe("setTemplateRecurrenceAction (R31.20)", () => {
  it("stores the cadence, a pinned next run and the anchor while preserving values", async () => {
    const result = await setTemplateRecurrenceAction("t-1", "weekly", {
      hour: 9,
      minute: 0,
      now,
    });

    expect(result).toEqual({
      ok: true,
      nextRunAt: new Date(2026, 0, 12, 9, 0).toISOString(),
      paused: false,
    });
    expect(updated()).toMatchObject({
      recurrence: "weekly",
      nextRunAt: new Date(2026, 0, 12, 9, 0),
      paused: false,
    });
    expect(updated().config).toMatchObject({
      anchorAt: new Date(2026, 0, 5, 9, 0).toISOString(),
      values: [{ propertyId: "p-1", value: { text: "hello" } }],
    });
  });

  it("clears the schedule without dropping saved values or the anchor", async () => {
    const result = await setTemplateRecurrenceAction("t-1", null, { now });
    expect(result).toMatchObject({ ok: true, nextRunAt: null, paused: false });
    expect(updated()).toMatchObject({ recurrence: null, nextRunAt: null, paused: false });
    expect(updated().config).not.toHaveProperty("anchorAt");
    expect(updated().config).toMatchObject({
      values: [{ propertyId: "p-1", value: { text: "hello" } }],
    });
  });

  it("refuses an unknown cadence before writing", async () => {
    const result = await setTemplateRecurrenceAction("t-1", "yearly", { now });
    expect(result).toEqual({ error: "Choose a valid schedule." });
    expect(db.templateUpdate).not.toHaveBeenCalled();
  });

  it("answers a missing template exactly like an unknown one", async () => {
    const result = await setTemplateRecurrenceAction("t-missing", "daily", { now });
    expect(result).toEqual({ error: "Template not found." });
    expect(db.templateUpdate).not.toHaveBeenCalled();
  });

  it("refuses when the caller cannot edit the owning database", async () => {
    db.pageFindUnique.mockResolvedValue(null);
    const result = await setTemplateRecurrenceAction("t-1", "daily", { now });
    expect(result).toEqual({ error: "Database not found." });
    expect(db.templateUpdate).not.toHaveBeenCalled();
  });
});

describe("setTemplatePausedAction (R31.22)", () => {
  it("pauses without losing the cadence", async () => {
    const result = await setTemplatePausedAction("t-1", true, { now });
    expect(result).toEqual({ ok: true, paused: true, nextRunAt: null });
    expect(updated()).toEqual({ paused: true });
  });

  it("resumes by re-deriving nextRunAt from now, never back-filling", async () => {
    db.templateFindUnique.mockResolvedValue({
      databasePageId: DB,
      recurrence: "daily",
      config: { anchorAt: new Date(2025, 0, 1, 9, 0).toISOString() },
    });

    const result = await setTemplatePausedAction("t-1", false, { now });
    expect(result).toEqual({
      ok: true,
      paused: false,
      nextRunAt: new Date(2026, 0, 6, 9, 0).toISOString(),
    });
    expect(updated()).toEqual({
      paused: false,
      nextRunAt: new Date(2026, 0, 6, 9, 0),
    });
  });

  it("refuses to pause a manual template", async () => {
    db.templateFindUnique.mockResolvedValue({
      databasePageId: DB,
      recurrence: null,
      config: null,
    });
    const result = await setTemplatePausedAction("t-1", true, { now });
    expect(result).toEqual({ error: "Template has no schedule." });
    expect(db.templateUpdate).not.toHaveBeenCalled();
  });
});
