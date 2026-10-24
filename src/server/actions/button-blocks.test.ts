import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server-side gate for the Template button / Button block.
 *
 * The actions are HTTP-reachable server endpoints: the page, workspace and
 * template ids all come from the client, so the tests below prove they are
 * re-derived and re-authorized before any write. Red cases first: a READ-only
 * page member, a foreign/deleted template and a property outside the row's
 * database all fail without touching `propertyValue.upsert`.
 */

const WORKSPACE = "ws-1";
const PAGE = "page-1";
const DATABASE = "db-1";
const PROPERTY = "prop-1";

type FakePage = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  type?: string;
  deletedAt: Date | null;
  locked: boolean;
  permissions: { level: string }[];
};

const db = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  pageFindFirst: vi.fn(),
  templateFindUnique: vi.fn(),
  propertyFindFirst: vi.fn(),
}));
const databaseActions = vi.hoisted(() => ({ setPropertyValueAction: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findUnique: db.memberFindUnique },
    workspace: { findUnique: db.workspaceFindUnique },
    page: { findFirst: db.pageFindFirst },
    template: { findUnique: db.templateFindUnique },
    property: { findFirst: db.propertyFindFirst },
  },
}));
vi.mock("@/server/actions/database", () => ({
  setPropertyValueAction: databaseActions.setPropertyValueAction,
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1", name: "Ada" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  executeButtonBlockAction,
  resolveTemplateInsertAction,
} from "./button-blocks";

const rowPage: FakePage = {
  id: PAGE,
  workspaceId: WORKSPACE,
  parentId: DATABASE,
  deletedAt: null,
  locked: false,
  permissions: [],
};

const readOnlyRow: FakePage = {
  ...rowPage,
  permissions: [{ level: "READ" }],
};

const databasePage: FakePage = {
  id: DATABASE,
  workspaceId: WORKSPACE,
  parentId: null,
  type: "DATABASE",
  deletedAt: null,
  locked: false,
  permissions: [],
};

const plainPage: FakePage = {
  id: "plain-page",
  workspaceId: WORKSPACE,
  parentId: null,
  deletedAt: null,
  locked: false,
  permissions: [],
};

function installPages(pages: FakePage[]) {
  db.pageFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const found = pages.find(
      (page) =>
        page.id === where.id &&
        page.workspaceId === where.workspaceId &&
        (where.deletedAt === undefined || page.deletedAt === where.deletedAt),
    );
    return found ?? null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.memberFindUnique.mockResolvedValue({ role: "MEMBER" });
  db.workspaceFindUnique.mockResolvedValue(null);
  databaseActions.setPropertyValueAction.mockResolvedValue({ ok: true });
  db.propertyFindFirst.mockResolvedValue({ id: PROPERTY });
  installPages([rowPage, databasePage, plainPage]);
});

describe("resolveTemplateInsertAction", () => {
  it("refuses a caller who is not a workspace member", async () => {
    db.memberFindUnique.mockResolvedValue(null);
    db.workspaceFindUnique.mockResolvedValue({ ownerId: "someone-else" });
    await expect(
      resolveTemplateInsertAction({ workspaceId: WORKSPACE, pageId: PAGE, templateId: "tpl-1" }),
    ).resolves.toEqual({ error: "You do not have access to this workspace." });
  });

  it("refuses a caller with read-only page access before reading a template", async () => {
    installPages([readOnlyRow]);
    await expect(
      resolveTemplateInsertAction({ workspaceId: WORKSPACE, pageId: PAGE, templateId: "tpl-1" }),
    ).resolves.toEqual({ error: "You do not have permission to run this button." });
    expect(db.templateFindUnique).not.toHaveBeenCalled();
  });

  it("returns materialized blocks for a saved template in the same workspace", async () => {
    db.templateFindUnique.mockResolvedValue({
      id: "tpl-1",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hi {{user}}" }] },
        ],
      },
      databasePage: {
        workspaceId: WORKSPACE,
        deletedAt: null,
        permissions: [],
      },
    });

    const result = await resolveTemplateInsertAction({
      workspaceId: WORKSPACE,
      pageId: PAGE,
      templateId: "tpl-1",
    });

    expect(result).toMatchObject({ ok: true, templateId: "tpl-1" });
    if ("error" in result) throw new Error("expected blocks");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.content?.[0]?.text).toBe("Hi Ada");
  });

  it("treats a template from another workspace as missing (no existence oracle)", async () => {
    db.templateFindUnique.mockResolvedValue({
      id: "tpl-foreign",
      content: { type: "doc", content: [] },
      databasePage: {
        workspaceId: "ws-2",
        deletedAt: null,
        permissions: [],
      },
    });

    await expect(
      resolveTemplateInsertAction({
        workspaceId: WORKSPACE,
        pageId: PAGE,
        templateId: "tpl-foreign",
      }),
    ).resolves.toEqual({ error: "Template not found." });
  });

  it("treats a deleted template as missing", async () => {
    db.templateFindUnique.mockResolvedValue(null);
    await expect(
      resolveTemplateInsertAction({ workspaceId: WORKSPACE, pageId: PAGE, templateId: "gone" }),
    ).resolves.toEqual({ error: "Template not found." });
  });

  it("serves a built-in template even without a stored row", async () => {
    const result = await resolveTemplateInsertAction({
      workspaceId: WORKSPACE,
      pageId: PAGE,
      templateId: "meeting",
    });
    expect(result).toMatchObject({ ok: true, templateId: "meeting" });
    if ("error" in result) throw new Error("expected blocks");
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(db.templateFindUnique).not.toHaveBeenCalled();
  });
});

describe("executeButtonBlockAction", () => {
  it("refuses the action when the page is read-only", async () => {
    installPages([readOnlyRow]);
    await expect(
      executeButtonBlockAction({
        workspaceId: WORKSPACE,
        pageId: PAGE,
        action: { kind: "open_url", url: "https://example.com" },
      }),
    ).resolves.toEqual({ error: "You do not have permission to run this button." });
  });

  it("refuses an invalid action from the client", async () => {
    await expect(
      executeButtonBlockAction({
        workspaceId: WORKSPACE,
        pageId: PAGE,
        action: { kind: "explode" },
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("not a supported action") });
  });

  it("returns materialized blocks for insert_template", async () => {
    db.templateFindUnique.mockResolvedValue({
      id: "tpl-1",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
      databasePage: { workspaceId: WORKSPACE, deletedAt: null, permissions: [] },
    });

    const result = await executeButtonBlockAction({
      workspaceId: WORKSPACE,
      pageId: PAGE,
      action: { kind: "insert_template", templateId: "tpl-1" },
    });
    expect(result).toMatchObject({ ok: true, kind: "insert_template", templateId: "tpl-1" });
    if ("error" in result || result.kind !== "insert_template") throw new Error("expected blocks");
    expect(result.blocks).toHaveLength(1);
  });

  it("refuses a missing template instead of inserting nothing", async () => {
    db.templateFindUnique.mockResolvedValue(null);
    await expect(
      executeButtonBlockAction({
        workspaceId: WORKSPACE,
        pageId: PAGE,
        action: { kind: "insert_template", templateId: "gone" },
      }),
    ).resolves.toEqual({ error: "Template not found." });
  });

  it("writes a property on a database row", async () => {
    const result = await executeButtonBlockAction({
      workspaceId: WORKSPACE,
      pageId: PAGE,
      action: { kind: "set_property", propertyId: PROPERTY, value: "Done" },
    });
    expect(result).toMatchObject({ ok: true, kind: "set_property", propertyId: PROPERTY });
    // The canonical property write path owns validation, relations and
    // UNIQUE_ID allocation; the button action only authorizes and delegates.
    expect(databaseActions.setPropertyValueAction).toHaveBeenCalledWith(PAGE, PROPERTY, "Done");
  });

  it("refuses a property write on a page that is not a database row", async () => {
    installPages([plainPage]);
    await expect(
      executeButtonBlockAction({
        workspaceId: WORKSPACE,
        pageId: "plain-page",
        action: { kind: "set_property", propertyId: PROPERTY, value: "Done" },
      }),
    ).resolves.toEqual({ error: "Property writes need a database row with that property." });
    expect(databaseActions.setPropertyValueAction).not.toHaveBeenCalled();
  });

  it("refuses a property that does not belong to the row's database", async () => {
    db.propertyFindFirst.mockResolvedValue(null);
    await expect(
      executeButtonBlockAction({
        workspaceId: WORKSPACE,
        pageId: PAGE,
        action: { kind: "set_property", propertyId: "foreign-property", value: "Done" },
      }),
    ).resolves.toEqual({ error: "That property does not belong to this row's database." });
    expect(databaseActions.setPropertyValueAction).not.toHaveBeenCalled();
  });

  it("disables a notification explicitly", async () => {
    await expect(
      executeButtonBlockAction({
        workspaceId: WORKSPACE,
        pageId: PAGE,
        action: { kind: "notify", message: "Ping" },
      }),
    ).resolves.toEqual({
      error: "This block has no recipient list, so notifications are disabled.",
    });
  });

  it("does not pretend to execute a link server-side", async () => {
    await expect(
      executeButtonBlockAction({
        workspaceId: WORKSPACE,
        pageId: PAGE,
        action: { kind: "open_url", url: "https://example.com" },
      }),
    ).resolves.toEqual({
      error: "Links open in the browser and are not sent to the server.",
    });
  });
});
