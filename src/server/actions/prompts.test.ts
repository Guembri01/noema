import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Persistence seam for the prompt library (R25.22).
 *
 * These actions are the only way the settings page touches the database. The
 * interesting guarantees are authorisation ones: a personal prompt is invisible
 * to and untouchable by anyone but its creator, a workspace prompt is readable
 * by every member but writable only with `canEditContent`, and a guest can
 * never write. The pure engine still owns validation/normalisation, so the
 * tests assert the rows it produces as well as the rows it refuses.
 */

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const permissions = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canEditContent: vi.fn(),
}));
const db = vi.hoisted(() => ({
  prisma: {
    workspacePrompt: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: permissions.getWorkspaceAccess,
  canEditContent: permissions.canEditContent,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  clonePromptAction,
  createPromptAction,
  deletePromptAction,
  listPromptsAction,
  updatePromptAction,
} from "@/server/actions/prompts";

const CREATED = new Date("2026-10-01T00:00:00.000Z");
const UPDATED = new Date("2026-10-02T00:00:00.000Z");

type Row = {
  id: string;
  workspaceId: string;
  createdById: string;
  name: string;
  body: string;
  scope: string;
  tags: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "p1",
    workspaceId: "ws-1",
    createdById: "u1",
    name: "Weekly summary",
    body: "Summarize {{notes}}.",
    scope: "workspace",
    tags: ["weekly"],
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "u1" });
  permissions.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  permissions.canEditContent.mockImplementation((role: string) => role !== "GUEST");
  db.prisma.workspacePrompt.findMany.mockResolvedValue([]);
  db.prisma.workspacePrompt.findFirst.mockResolvedValue(null);
  db.prisma.workspacePrompt.create.mockImplementation(async ({ data }: { data: Row }) =>
    row({ ...data, id: "p-new", createdAt: CREATED, updatedAt: CREATED }),
  );
  db.prisma.workspacePrompt.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Partial<Row> }) =>
      row({ ...data, id: where.id, updatedAt: UPDATED }),
  );
  db.prisma.workspacePrompt.delete.mockResolvedValue(row());
});

describe("authorisation", () => {
  it("refuses a caller who is not a member of the workspace", async () => {
    permissions.getWorkspaceAccess.mockResolvedValue(null);

    const listed = await listPromptsAction({ workspaceId: "ws-1" });
    const created = await createPromptAction({
      workspaceId: "ws-1",
      name: "x",
      body: "y",
      scope: "personal",
    });

    expect(listed).toEqual({ ok: false, error: "You are not a member of this workspace." });
    expect(created.ok).toBe(false);
    expect(db.prisma.workspacePrompt.findMany).not.toHaveBeenCalled();
    expect(db.prisma.workspacePrompt.create).not.toHaveBeenCalled();
  });

  it("lets a guest read but not write", async () => {
    permissions.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
    db.prisma.workspacePrompt.findMany.mockResolvedValue([row()]);

    const listed = await listPromptsAction({ workspaceId: "ws-1" });
    const created = await createPromptAction({
      workspaceId: "ws-1",
      name: "x",
      body: "y",
      scope: "personal",
    });
    const updated = await updatePromptAction({ workspaceId: "ws-1", id: "p1", name: "y" });
    const deleted = await deletePromptAction({ workspaceId: "ws-1", id: "p1" });

    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.canEdit).toBe(false);
      expect(listed.prompts).toHaveLength(1);
    }
    expect(created).toEqual({
      ok: false,
      error: "You do not have permission to change prompts in this workspace.",
    });
    expect(updated.ok).toBe(false);
    expect(deleted.ok).toBe(false);
    expect(db.prisma.workspacePrompt.create).not.toHaveBeenCalled();
    expect(db.prisma.workspacePrompt.update).not.toHaveBeenCalled();
    expect(db.prisma.workspacePrompt.delete).not.toHaveBeenCalled();
  });
});

describe("listPromptsAction", () => {
  it("scopes the query to shared prompts plus the caller's own personal ones", async () => {
    await listPromptsAction({ workspaceId: "ws-1" });

    expect(db.prisma.workspacePrompt.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        OR: [{ scope: "workspace" }, { scope: "personal", createdById: "u1" }],
      },
      orderBy: { updatedAt: "desc" },
    });
  });

  it("narrows by scope in the database and by tag/query in the engine", async () => {
    db.prisma.workspacePrompt.findMany.mockResolvedValue([
      row({ id: "a", name: "Weekly summary", tags: ["weekly"] }),
      row({ id: "b", name: "Release notes", tags: ["release"], body: "Draft {{notes}}." }),
    ]);

    const result = await listPromptsAction({
      workspaceId: "ws-1",
      scope: "workspace",
      tag: "RELEASE",
    });

    expect(db.prisma.workspacePrompt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "ws-1", scope: "workspace" }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompts.map((prompt) => prompt.id)).toEqual(["b"]);
  });

  it("maps rows through the engine: variables are derived, tags are read safely", async () => {
    db.prisma.workspacePrompt.findMany.mockResolvedValue([
      row({ tags: ["weekly", 42, null] }),
    ]);

    const result = await listPromptsAction({ workspaceId: "ws-1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompts[0]).toMatchObject({
      id: "p1",
      name: "Weekly summary",
      variables: ["notes"],
      scope: "workspace",
      tags: ["weekly"],
      createdAt: "2026-10-01T00:00:00.000Z",
    });
  });
});

describe("createPromptAction", () => {
  it("persists a normalised prompt and returns its derived variables", async () => {
    const result = await createPromptAction({
      workspaceId: "ws-1",
      name: "  Weekly summary  ",
      body: "Summarize {{notes}} for {{audience}}.",
      scope: "personal",
      tags: [" weekly ", "Weekly", "summary"],
    });

    expect(db.prisma.workspacePrompt.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws-1",
        createdById: "u1",
        name: "Weekly summary",
        body: "Summarize {{notes}} for {{audience}}.",
        scope: "personal",
        tags: ["weekly", "summary"],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prompt.variables).toEqual(["audience", "notes"]);
      expect(result.prompt.scope).toBe("personal");
    }
  });

  it("refuses a duplicate name within the same scope", async () => {
    db.prisma.workspacePrompt.findMany.mockResolvedValue([row()]);

    const result = await createPromptAction({
      workspaceId: "ws-1",
      name: "weekly SUMMARY",
      body: "Another body.",
      scope: "workspace",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("already exists");
    expect(db.prisma.workspacePrompt.create).not.toHaveBeenCalled();
  });

  it("allows the same name in a different scope", async () => {
    db.prisma.workspacePrompt.findMany.mockResolvedValue([row()]);

    const result = await createPromptAction({
      workspaceId: "ws-1",
      name: "Weekly summary",
      body: "Private notes.",
      scope: "personal",
    });

    expect(result.ok).toBe(true);
    expect(db.prisma.workspacePrompt.create).toHaveBeenCalled();
  });

  it("refuses blank fields and an unknown scope", async () => {
    const blank = await createPromptAction({
      workspaceId: "ws-1",
      name: "  ",
      body: "body",
      scope: "workspace",
    });
    const noBody = await createPromptAction({
      workspaceId: "ws-1",
      name: "name",
      body: "  ",
      scope: "workspace",
    });
    const badScope = await createPromptAction({
      workspaceId: "ws-1",
      name: "name",
      body: "body",
      scope: "shared",
    });

    expect(blank.ok).toBe(false);
    expect(noBody.ok).toBe(false);
    expect(badScope.ok).toBe(false);
    expect(db.prisma.workspacePrompt.create).not.toHaveBeenCalled();
  });

  it("enforces the engine's tag bounds", async () => {
    const tooMany = await createPromptAction({
      workspaceId: "ws-1",
      name: "Tagged",
      body: "Body.",
      scope: "workspace",
      tags: Array.from({ length: 11 }, (_, index) => `tag-${index}`),
    });
    const tooLong = await createPromptAction({
      workspaceId: "ws-1",
      name: "Tagged",
      body: "Body.",
      scope: "workspace",
      tags: ["x".repeat(33)],
    });

    expect(tooMany.ok).toBe(false);
    expect(tooLong.ok).toBe(false);
    expect(db.prisma.workspacePrompt.create).not.toHaveBeenCalled();
  });
});

describe("updatePromptAction", () => {
  it("edits a shared prompt for any member with write access", async () => {
    db.prisma.workspacePrompt.findFirst.mockResolvedValue(row({ createdById: "u2" }));
    db.prisma.workspacePrompt.findMany.mockResolvedValue([row({ createdById: "u2" })]);

    const result = await updatePromptAction({
      workspaceId: "ws-1",
      id: "p1",
      name: "Weekly digest",
      body: "Digest {{notes}}.",
      tags: ["digest"],
    });

    expect(result.ok).toBe(true);
    expect(db.prisma.workspacePrompt.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: {
        name: "Weekly digest",
        body: "Digest {{notes}}.",
        scope: "workspace",
        tags: ["digest"],
      },
    });
    if (result.ok) expect(result.prompt.variables).toEqual(["notes"]);
  });

  it("hides another member's personal prompt", async () => {
    db.prisma.workspacePrompt.findFirst.mockResolvedValue(
      row({ scope: "personal", createdById: "u2" }),
    );

    const result = await updatePromptAction({ workspaceId: "ws-1", id: "p1", name: "Mine now" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Prompt not found.");
    expect(db.prisma.workspacePrompt.update).not.toHaveBeenCalled();
  });

  it("lets the creator edit their own personal prompt", async () => {
    db.prisma.workspacePrompt.findFirst.mockResolvedValue(
      row({ scope: "personal", createdById: "u1" }),
    );
    db.prisma.workspacePrompt.findMany.mockResolvedValue([
      row({ scope: "personal", createdById: "u1" }),
    ]);

    const result = await updatePromptAction({
      workspaceId: "ws-1",
      id: "p1",
      body: "Private {{notes}}.",
    });

    expect(result.ok).toBe(true);
    expect(db.prisma.workspacePrompt.update).toHaveBeenCalled();
  });

  it("only lets the creator change a prompt's scope", async () => {
    db.prisma.workspacePrompt.findFirst.mockResolvedValue(row({ createdById: "u2" }));
    db.prisma.workspacePrompt.findMany.mockResolvedValue([row({ createdById: "u2" })]);

    const result = await updatePromptAction({
      workspaceId: "ws-1",
      id: "p1",
      scope: "personal",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("creator");
    expect(db.prisma.workspacePrompt.update).not.toHaveBeenCalled();
  });

  it("refuses an unknown prompt and an empty name", async () => {
    const missing = await updatePromptAction({ workspaceId: "ws-1", id: "nope", name: "x" });

    db.prisma.workspacePrompt.findFirst.mockResolvedValue(row());
    db.prisma.workspacePrompt.findMany.mockResolvedValue([row()]);
    const blank = await updatePromptAction({ workspaceId: "ws-1", id: "p1", name: "  " });

    expect(missing.ok).toBe(false);
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error).toContain("name");
    expect(db.prisma.workspacePrompt.update).not.toHaveBeenCalled();
  });
});

describe("deletePromptAction", () => {
  it("deletes a shared prompt for a member with write access", async () => {
    db.prisma.workspacePrompt.findFirst.mockResolvedValue({
      id: "p1",
      scope: "workspace",
      createdById: "u2",
    });

    const result = await deletePromptAction({ workspaceId: "ws-1", id: "p1" });

    expect(result).toEqual({ ok: true });
    expect(db.prisma.workspacePrompt.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
  });

  it("refuses another member's personal prompt and a missing row", async () => {
    db.prisma.workspacePrompt.findFirst.mockResolvedValue({
      id: "p1",
      scope: "personal",
      createdById: "u2",
    });
    const personal = await deletePromptAction({ workspaceId: "ws-1", id: "p1" });

    db.prisma.workspacePrompt.findFirst.mockResolvedValue(null);
    const missing = await deletePromptAction({ workspaceId: "ws-1", id: "p2" });

    expect(personal.ok).toBe(false);
    expect(missing).toEqual({ ok: false, error: "Prompt not found." });
    expect(db.prisma.workspacePrompt.delete).not.toHaveBeenCalled();
  });
});

describe("clonePromptAction", () => {
  it("copies a shared prompt into the caller's library with a unique name", async () => {
    const source = row({ createdById: "u2" });
    db.prisma.workspacePrompt.findFirst.mockResolvedValue(source);
    db.prisma.workspacePrompt.findMany.mockResolvedValue([source]);

    const result = await clonePromptAction({ workspaceId: "ws-1", id: "p1" });

    expect(result.ok).toBe(true);
    expect(db.prisma.workspacePrompt.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws-1",
        createdById: "u1",
        name: "Weekly summary (copy)",
        body: "Summarize {{notes}}.",
        scope: "workspace",
        tags: ["weekly"],
      },
    });
    if (result.ok) {
      expect(result.prompt.id).toBe("p-new");
      expect(result.prompt.variables).toEqual(["notes"]);
    }
  });

  it("numbers a second copy instead of creating a duplicate name", async () => {
    const source = row();
    db.prisma.workspacePrompt.findFirst.mockResolvedValue(source);
    db.prisma.workspacePrompt.findMany.mockResolvedValue([
      source,
      row({ id: "p2", name: "Weekly summary (copy)" }),
    ]);

    const result = await clonePromptAction({ workspaceId: "ws-1", id: "p1" });

    expect(db.prisma.workspacePrompt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Weekly summary (copy 2)" }) }),
    );
    expect(result.ok).toBe(true);
  });

  it("can clone a personal prompt the caller owns, keeping it personal", async () => {
    const source = row({ id: "mine", scope: "personal", createdById: "u1", name: "Notes" });
    db.prisma.workspacePrompt.findFirst.mockResolvedValue(source);
    db.prisma.workspacePrompt.findMany.mockResolvedValue([source]);

    await clonePromptAction({ workspaceId: "ws-1", id: "mine" });

    expect(db.prisma.workspacePrompt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scope: "personal", name: "Notes (copy)" }),
      }),
    );
  });

  it("does not reveal another member's personal prompt", async () => {
    db.prisma.workspacePrompt.findFirst.mockResolvedValue(
      row({ scope: "personal", createdById: "u2" }),
    );

    const result = await clonePromptAction({ workspaceId: "ws-1", id: "p1" });

    expect(result).toEqual({ ok: false, error: "Prompt not found." });
    expect(db.prisma.workspacePrompt.create).not.toHaveBeenCalled();
  });

  it("accepts an explicit name and target scope", async () => {
    const source = row({ scope: "personal", createdById: "u1" });
    db.prisma.workspacePrompt.findFirst.mockResolvedValue(source);
    db.prisma.workspacePrompt.findMany.mockResolvedValue([source]);

    const result = await clonePromptAction({
      workspaceId: "ws-1",
      id: "p1",
      name: "Shared digest",
      scope: "workspace",
    });

    expect(result.ok).toBe(true);
    expect(db.prisma.workspacePrompt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Shared digest", scope: "workspace" }),
      }),
    );
  });
});
