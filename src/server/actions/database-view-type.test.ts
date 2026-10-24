import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FORM view type plumbing (docs/specs/database-deep.md R89.29).
 *
 * The pure form engine and the respondent renderer already had coverage; this
 * gate covers the two writes that used to reject `FORM`: creating a view and
 * changing a view's type/config. It also proves a form config survives the
 * server action's normaliser, which is what previously erased `config.form`.
 */
const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  viewFindFirst: vi.fn(),
  viewCreate: vi.fn(),
  viewFindUnique: vi.fn(),
  viewUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique },
    databaseView: {
      findFirst: db.viewFindFirst,
      create: db.viewCreate,
      findUnique: db.viewFindUnique,
      update: db.viewUpdate,
    },
  },
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createViewAction, updateViewAction } from "./database";

const FORM_CONFIG = {
  id: "form-1",
  databaseId: "db-1",
  title: "Requests",
  fields: [{ propertyId: "title", label: "Title", required: true }],
  accepting: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockResolvedValue({
    id: "db-1",
    workspaceId: "ws-1",
    type: "DATABASE",
    schemaLocked: false,
    permissions: [],
  });
  db.viewFindFirst.mockResolvedValue(null);
  db.viewCreate.mockResolvedValue({ id: "view-form" });
  db.viewFindUnique.mockResolvedValue({ databasePageId: "db-1" });
  db.viewUpdate.mockResolvedValue({ id: "view-form" });
});

describe("FORM view type", () => {
  it("creates a FORM view through the normal view path", async () => {
    await expect(createViewAction("db-1", "FORM", "Responses")).resolves.toEqual({
      ok: true,
      id: "view-form",
    });
    expect(db.viewCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "FORM", name: "Responses" }),
      }),
    );
  });

  it("updates a view to FORM and round-trips config.form", async () => {
    await expect(
      updateViewAction("view-form", {
        type: "FORM",
        config: { viewType: "FORM", form: FORM_CONFIG },
      }),
    ).resolves.toEqual({ ok: true });

    expect(db.viewUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "FORM",
          config: expect.objectContaining({ form: FORM_CONFIG }),
        }),
      }),
    );
  });

  it("still rejects an unknown view type", async () => {
    await expect(updateViewAction("view-form", { type: "MYSTERY" })).resolves.toEqual({
      error: "Unknown view type.",
    });
    expect(db.viewUpdate).not.toHaveBeenCalled();
  });
});
