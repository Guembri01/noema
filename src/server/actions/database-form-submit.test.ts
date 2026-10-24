import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Atomic internal-form submission (`submitFormAction`, R89.29).
 *
 * The respondent UI validates for immediate feedback, but that is only a UX
 * shortcut. This gate exercises the server action with the real form engine and
 * only the transport edges mocked, so it proves the action:
 *
 * - re-reads the stored `config.form` (not a client-supplied schema),
 * - keeps legacy `fieldIds` forms working,
 * - honours `accepting: false`,
 * - re-validates required / malformed answers and rejects unknown columns,
 *   computed columns and non-app file URLs,
 * - throttles per user,
 * - writes the row and every cell in one transaction.
 */

const db = vi.hoisted(() => ({
  viewFindUnique: vi.fn(),
  pageFindUnique: vi.fn(),
  propertyFindMany: vi.fn(),
  transaction: vi.fn(),
  txPageFindFirst: vi.fn(),
  txPageCreate: vi.fn(),
  txPropertyFindMany: vi.fn(),
  txValueCreateMany: vi.fn(),
}));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const perm = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canEditContent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    databaseView: { findUnique: db.viewFindUnique },
    page: { findUnique: db.pageFindUnique },
    property: { findMany: db.propertyFindMany },
    $transaction: db.transaction,
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: perm.getWorkspaceAccess,
  canEditContent: perm.canEditContent,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));

import { resetRateLimits } from "@/lib/rate-limit";
import { submitFormAction } from "./database";

const STATUS_OPTIONS = [
  { id: "todo", name: "Todo" },
  { id: "done", name: "Done" },
];

const PROPERTIES = [
  {
    id: "title",
    name: "Name",
    type: "TEXT",
    config: { primary: true },
  },
  {
    id: "status",
    name: "Status",
    type: "STATUS",
    config: { options: STATUS_OPTIONS },
  },
  {
    id: "notes",
    name: "Notes",
    type: "TEXT",
    config: {},
  },
  {
    id: "formula",
    name: "Score",
    type: "FORMULA",
    config: { expression: "1 + 1" },
  },
  {
    id: "files",
    name: "Files",
    type: "FILES",
    config: {},
  },
];

const FORM_FIELDS = [
  {
    propertyId: "title",
    label: "Name",
    type: "TEXT",
    required: true,
    primary: true,
    config: { primary: true },
  },
  {
    propertyId: "status",
    label: "Status",
    type: "STATUS",
    config: { options: STATUS_OPTIONS },
  },
  {
    propertyId: "notes",
    label: "Notes",
    type: "TEXT",
    config: {},
  },
];

function formView(config: unknown) {
  return {
    id: "view-1",
    databasePageId: "db-1",
    name: "Requests",
    type: "FORM",
    config,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();

  auth.requireUser.mockResolvedValue({ id: "user-1" });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  perm.canEditContent.mockReturnValue(true);

  db.pageFindUnique.mockResolvedValue({
    id: "db-1",
    workspaceId: "ws-1",
    type: "DATABASE",
    schemaLocked: false,
    permissions: [],
  });
  db.propertyFindMany.mockResolvedValue(PROPERTIES);
  db.viewFindUnique.mockResolvedValue(
    formView({
      form: {
        id: "view-1",
        databaseId: "db-1",
        title: "Requests",
        accepting: true,
        fields: FORM_FIELDS,
      },
    }),
  );

  db.txPageFindFirst.mockResolvedValue({ position: 2000 });
  db.txPageCreate.mockResolvedValue({ id: "row-1" });
  db.txPropertyFindMany.mockResolvedValue(PROPERTIES);
  db.txValueCreateMany.mockResolvedValue({ count: 3 });
  db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      page: {
        findFirst: db.txPageFindFirst,
        create: db.txPageCreate,
      },
      property: { findMany: db.txPropertyFindMany },
      propertyValue: { createMany: db.txValueCreateMany },
    }),
  );
});

describe("submitFormAction", () => {
  it("creates the row and every cell in one transaction", async () => {
    const result = await submitFormAction("view-1", {
      title: { text: "Quarterly plan" },
      status: { optionId: "todo" },
      notes: { text: "Ship it" },
    });

    expect(result).toEqual({ ok: true, id: "row-1" });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.txPageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          parentId: "db-1",
          title: "Quarterly plan",
        }),
      }),
    );
    expect(db.txValueCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        { propertyId: "title", pageId: "row-1", value: { text: "Quarterly plan" } },
        { propertyId: "status", pageId: "row-1", value: { optionId: "todo" } },
        { propertyId: "notes", pageId: "row-1", value: { text: "Ship it" } },
      ]),
    });
    expect(db.txValueCreateMany.mock.calls[0][0].data).toHaveLength(3);
  });

  it("writes only answered questions and leaves optional cells empty", async () => {
    const result = await submitFormAction("view-1", {
      title: { text: "Only the title" },
    });

    expect(result).toEqual({ ok: true, id: "row-1" });
    expect(db.txValueCreateMany.mock.calls[0][0].data).toEqual([
      { propertyId: "title", pageId: "row-1", value: { text: "Only the title" } },
    ]);
  });

  it("keeps a legacy fieldIds form working", async () => {
    db.viewFindUnique.mockResolvedValue(
      formView({
        form: {
          fieldIds: ["title", "status"],
          required: ["title"],
        },
      }),
    );

    const result = await submitFormAction("view-1", {
      title: { text: "Legacy form" },
      status: { optionId: "done" },
    });

    expect(result).toEqual({ ok: true, id: "row-1" });
    expect(db.txValueCreateMany.mock.calls[0][0].data).toEqual([
      { propertyId: "title", pageId: "row-1", value: { text: "Legacy form" } },
      { propertyId: "status", pageId: "row-1", value: { optionId: "done" } },
    ]);
  });

  it("refuses a closed form before writing anything", async () => {
    db.viewFindUnique.mockResolvedValue(
      formView({
        form: {
          title: "Requests",
          accepting: false,
          fields: FORM_FIELDS,
        },
      }),
    );

    const result = await submitFormAction("view-1", {
      title: { text: "Too late" },
    });

    expect(result).toEqual({ error: "This form is not accepting responses." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects a missing required answer", async () => {
    const result = await submitFormAction("view-1", {
      status: { optionId: "todo" },
    });

    expect(result).toEqual({ error: "Please check the answers and try again." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid option even though the client thought it was fine", async () => {
    const result = await submitFormAction("view-1", {
      title: { text: "Bad status" },
      status: { optionId: "not-an-option" },
    });

    expect(result).toEqual({ error: "Please check the answers and try again." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects a stored question that points at an unknown property", async () => {
    db.viewFindUnique.mockResolvedValue(
      formView({
        form: {
          title: "Requests",
          fields: [
            FORM_FIELDS[0],
            {
              propertyId: "ghost",
              label: "Ghost",
              type: "TEXT",
            },
          ],
        },
      }),
    );

    const result = await submitFormAction("view-1", {
      title: { text: "Hello" },
      ghost: { text: "boo" },
    });

    expect(result).toEqual({ error: "This form has an invalid configuration." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects a computed property smuggled into a stored form", async () => {
    db.viewFindUnique.mockResolvedValue(
      formView({
        form: {
          title: "Requests",
          fields: [
            FORM_FIELDS[0],
            {
              propertyId: "formula",
              label: "Score",
              type: "FORMULA",
            },
          ],
        },
      }),
    );

    const result = await submitFormAction("view-1", {
      title: { text: "Hello" },
      formula: 42,
    });

    expect(result).toEqual({ error: "This form has an invalid question." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("validates a stored default before writing it", async () => {
    const properties = PROPERTIES.map((property) =>
      property.id === "notes" ? { ...property, config: { maxLength: 3 } } : property,
    );
    db.propertyFindMany.mockResolvedValue(properties);
    db.txPropertyFindMany.mockResolvedValue(properties);
    db.viewFindUnique.mockResolvedValue(
      formView({
        form: {
          title: "Requests",
          fields: [
            FORM_FIELDS[0],
            {
              propertyId: "notes",
              label: "Notes",
              type: "TEXT",
              default: { text: "too long" },
              config: { maxLength: 3 },
            },
          ],
        },
      }),
    );

    const result = await submitFormAction("view-1", {
      title: { text: "Hello" },
    });

    expect(result).toEqual({ error: "Please check the answers and try again." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects a file URL that is not owned by the app", async () => {
    db.viewFindUnique.mockResolvedValue(
      formView({
        form: {
          title: "Requests",
          fields: [
            FORM_FIELDS[0],
            {
              propertyId: "files",
              label: "Files",
              type: "FILES",
            },
          ],
        },
      }),
    );

    const result = await submitFormAction("view-1", {
      title: { text: "Hello" },
      files: {
        files: [{ name: "report.pdf", url: "https://evil.example/report.pdf" }],
      },
    });

    expect(result).toEqual({ error: "That file link is not allowed." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a FORM view", async () => {
    db.viewFindUnique.mockResolvedValue({
      ...formView({}),
      type: "TABLE",
    });

    const result = await submitFormAction("view-1", {
      title: { text: "Hello" },
    });

    expect(result).toEqual({ error: "Form not found." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a missing view", async () => {
    db.viewFindUnique.mockResolvedValue(null);

    const result = await submitFormAction("missing", {
      title: { text: "Hello" },
    });

    expect(result).toEqual({ error: "Form not found." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a user without edit permission", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "db-1",
      workspaceId: "ws-1",
      type: "DATABASE",
      schemaLocked: false,
      permissions: [{ level: "VIEW" }],
    });

    const result = await submitFormAction("view-1", {
      title: { text: "Hello" },
    });

    expect(result).toEqual({ error: "No permission." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("throttles repeated submissions per user and view", async () => {
    // The first 20 malformed submissions are refused by answer validation but
    // still charge the per-user window; the 21st never reaches validation.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await submitFormAction("view-1", {});
      expect(result).toEqual({ error: "Please check the answers and try again." });
    }

    const blocked = await submitFormAction("view-1", {
      title: { text: "One too many" },
    });

    expect(blocked).toEqual({
      error: "Too many submissions. Try again shortly.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("propagates a cell-write failure so the transaction rolls back", async () => {
    db.txValueCreateMany.mockRejectedValue(new Error("cell write failed"));

    await expect(
      submitFormAction("view-1", {
        title: { text: "Will roll back" },
      }),
    ).rejects.toThrow("cell write failed");
    // The page was created inside the same transaction callback; the mock
    // rejects before commit, which is the seam the real Prisma transaction
    // turns into a rollback.
    expect(db.txPageCreate).toHaveBeenCalledTimes(1);
  });
});
