import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const access = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
const db = vi.hoisted(() => ({
  templateFindUnique: vi.fn(),
  templateCreate: vi.fn(),
}));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: access.getWorkspaceAccess };
});
vi.mock("@/lib/db", () => ({
  prisma: { template: { findUnique: db.templateFindUnique, create: db.templateCreate } },
}));
vi.mock("next/cache", () => cache);

import { duplicateWorkspaceTemplateAction } from "./home-templates";

const ROW = {
  databasePageId: "db-1",
  name: "Task",
  icon: "✅",
  content: { type: "doc", content: [] },
  config: { values: [] },
  position: 1000,
  databasePage: { workspaceId: "ws-1", permissions: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "u1", name: "Ada" });
  access.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });
  db.templateFindUnique.mockResolvedValue(ROW);
  db.templateCreate.mockResolvedValue({ id: "copy-1" });
});

describe("duplicateWorkspaceTemplateAction", () => {
  it("clones the template in the same database without recurrence or default flag", async () => {
    await expect(
      duplicateWorkspaceTemplateAction({ workspaceId: "ws-1", templateId: "t1" }),
    ).resolves.toEqual({ ok: true, id: "copy-1" });
    expect(db.templateCreate).toHaveBeenCalledWith({
      data: {
        databasePageId: "db-1",
        name: "Task copy",
        icon: "✅",
        content: ROW.content,
        config: ROW.config,
        position: 2000,
      },
      select: { id: true },
    });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/w", "layout");
  });

  it("refuses a foreign template and a read-only role", async () => {
    db.templateFindUnique.mockResolvedValue({
      ...ROW,
      databasePage: { ...ROW.databasePage, workspaceId: "ws-other" },
    });
    await expect(
      duplicateWorkspaceTemplateAction({ workspaceId: "ws-1", templateId: "t1" }),
    ).resolves.toEqual({ error: "That template does not exist." });

    db.templateFindUnique.mockResolvedValue(ROW);
    access.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
    await expect(
      duplicateWorkspaceTemplateAction({ workspaceId: "ws-1", templateId: "t1" }),
    ).resolves.toEqual({ error: "You do not have permission to duplicate templates." });
  });
});
