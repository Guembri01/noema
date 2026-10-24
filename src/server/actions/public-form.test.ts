import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Public FORM submissions (`submitPublicFormAction`).
 *
 * The share token is the only credential. These tests keep the real form
 * engine, cell validation and row/cell writer, and mock only the transport
 * edges (Prisma, cookies/headers, the parent-scope query, webhooks). They pin
 * the properties that make a public write safe: the token resolves exactly one
 * FORM view of one database page, expired/deleted/mismatched links fail closed,
 * locked links refuse before any work, the form's own accepting switch is
 * honoured, answers are re-validated server-side, and the row plus every cell
 * commit in one transaction.
 */

const db = vi.hoisted(() => ({
  linkFindUnique: vi.fn(),
  propertyFindMany: vi.fn(),
  transaction: vi.fn(),
  txPageFindFirst: vi.fn(),
  txPageCreate: vi.fn(),
  txPropertyFindMany: vi.fn(),
  txValueFindMany: vi.fn(),
  txValueCreateMany: vi.fn(),
}));
const parent = vi.hoisted(() => ({ assertScopedParent: vi.fn() }));
const secrets = vi.hoisted(() => ({
  shareUnlockCookieName: vi.fn((token: string) => `share_${token}`),
  verifyShareUnlockToken: vi.fn(),
}));
const webhooks = vi.hoisted(() => ({ dispatchWebhooks: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    shareLink: { findUnique: db.linkFindUnique },
    property: { findMany: db.propertyFindMany },
    $transaction: db.transaction,
  },
}));
vi.mock("@/lib/page-parent", () => ({
  assertScopedParent: parent.assertScopedParent,
}));
vi.mock("@/lib/secrets", () => ({
  shareUnlockCookieName: secrets.shareUnlockCookieName,
  verifyShareUnlockToken: secrets.verifyShareUnlockToken,
}));
vi.mock("@/lib/webhooks", () => ({
  dispatchWebhooks: webhooks.dispatchWebhooks,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
}));

import { resetRateLimits } from "@/lib/rate-limit";
import { submitPublicFormAction } from "./public-form";

const STATUS_OPTIONS = [{ id: "todo", name: "Todo" }];
const PROPERTIES = [
  { id: "title", name: "Name", type: "TEXT", config: { primary: true } },
  {
    id: "status",
    name: "Status",
    type: "STATUS",
    config: { options: STATUS_OPTIONS },
  },
];
const FORM = {
  id: "view-1",
  databaseId: "db-1",
  title: "Requests",
  accepting: true,
  fields: [
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
  ],
};

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    passwordHash: null,
    expiresAt: null,
    view: {
      id: "view-1",
      databasePageId: "db-1",
      name: "Requests",
      type: "FORM",
      config: { form: FORM },
    },
    page: {
      id: "db-1",
      workspaceId: "ws-1",
      type: "DATABASE",
      deletedAt: null,
      createdById: "owner-1",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();

  parent.assertScopedParent.mockResolvedValue({ ok: true, parentId: "db-1" });
  secrets.verifyShareUnlockToken.mockReturnValue(false);
  webhooks.dispatchWebhooks.mockResolvedValue(undefined);

  db.linkFindUnique.mockResolvedValue(link());
  db.propertyFindMany.mockResolvedValue(PROPERTIES);
  db.txPageFindFirst.mockResolvedValue({ position: 2000 });
  db.txPageCreate.mockResolvedValue({ id: "row-1" });
  db.txPropertyFindMany.mockResolvedValue(PROPERTIES);
  db.txValueFindMany.mockResolvedValue([]);
  db.txValueCreateMany.mockResolvedValue({ count: 2 });
  db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      page: {
        findFirst: db.txPageFindFirst,
        create: db.txPageCreate,
      },
      property: { findMany: db.txPropertyFindMany },
      propertyValue: {
        findMany: db.txValueFindMany,
        createMany: db.txValueCreateMany,
      },
    }),
  );
});

describe("submitPublicFormAction", () => {
  it("creates the row and every cell in one transaction", async () => {
    const result = await submitPublicFormAction("token-1", {
      title: { text: "Public request" },
      status: { optionId: "todo" },
    });

    expect(result).toEqual({ ok: true });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.txPageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          parentId: "db-1",
          createdById: "owner-1",
          title: "Public request",
        }),
      }),
    );
    expect(db.txValueCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        { propertyId: "title", pageId: "row-1", value: { text: "Public request" } },
        { propertyId: "status", pageId: "row-1", value: { optionId: "todo" } },
      ]),
    });
    expect(webhooks.dispatchWebhooks).toHaveBeenCalledWith(
      "ws-1",
      "row.created",
      expect.objectContaining({ rowId: "row-1", databasePageId: "db-1" }),
    );
  });

  it("keeps a legacy fieldIds form working", async () => {
    db.linkFindUnique.mockResolvedValue(
      link({
        view: {
          ...link().view,
          config: { form: { fieldIds: ["title", "status"], required: ["title"] } },
        },
      }),
    );

    const result = await submitPublicFormAction("token-1", {
      title: { text: "Legacy" },
      status: { optionId: "todo" },
    });

    expect(result).toEqual({ ok: true });
    expect(db.txValueCreateMany.mock.calls[0][0].data).toEqual([
      { propertyId: "title", pageId: "row-1", value: { text: "Legacy" } },
      { propertyId: "status", pageId: "row-1", value: { optionId: "todo" } },
    ]);
  });

  it("refuses a missing link", async () => {
    db.linkFindUnique.mockResolvedValue(null);

    expect(await submitPublicFormAction("missing", {})).toEqual({
      error: "This form is no longer available.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a link with no form view", async () => {
    db.linkFindUnique.mockResolvedValue(link({ view: null }));

    expect(await submitPublicFormAction("token-1", {})).toEqual({
      error: "This form is no longer available.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a non-FORM view", async () => {
    db.linkFindUnique.mockResolvedValue(
      link({ view: { ...link().view, type: "TABLE" } }),
    );

    expect(await submitPublicFormAction("token-1", {})).toEqual({
      error: "This form is no longer available.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a view that belongs to another page", async () => {
    db.linkFindUnique.mockResolvedValue(
      link({ view: { ...link().view, databasePageId: "db-2" } }),
    );

    expect(await submitPublicFormAction("token-1", {})).toEqual({
      error: "This form is no longer available.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a deleted page or an expired link", async () => {
    db.linkFindUnique.mockResolvedValue(
      link({
        page: { ...link().page, deletedAt: new Date("2026-01-01T00:00:00Z") },
      }),
    );
    expect(await submitPublicFormAction("token-1", {})).toEqual({
      error: "This form is no longer available.",
    });

    db.linkFindUnique.mockResolvedValue(
      link({ expiresAt: new Date("2020-01-01T00:00:00Z") }),
    );
    expect(await submitPublicFormAction("token-1", {})).toEqual({
      error: "This form is no longer available.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("fails closed when the parent-scope check refuses the page", async () => {
    parent.assertScopedParent.mockResolvedValue({ error: "gone" });
    expect(await submitPublicFormAction("token-1", {})).toEqual({
      error: "This form is no longer available.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("fails closed when the scope guard resolves a different parent", async () => {
    parent.assertScopedParent.mockResolvedValue({ ok: true, parentId: "db-2" });
    expect(await submitPublicFormAction("token-1", {})).toEqual({
      error: "This form is no longer available.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a locked link until the unlock cookie verifies", async () => {
    db.linkFindUnique.mockResolvedValue(
      link({ passwordHash: "hashed", view: { ...link().view, config: { form: FORM } } }),
    );

    expect(await submitPublicFormAction("token-1", { title: { text: "Hi" } })).toEqual({
      error: "This form is password-protected. Unlock it first.",
    });
    expect(db.transaction).not.toHaveBeenCalled();

    secrets.verifyShareUnlockToken.mockReturnValue(true);
    expect(
      await submitPublicFormAction("token-1", { title: { text: "Hi" } }),
    ).toEqual({ ok: true });
  });

  it("honours the stored accepting switch", async () => {
    db.linkFindUnique.mockResolvedValue(
      link({
        view: { ...link().view, config: { form: { ...FORM, accepting: false } } },
      }),
    );

    expect(
      await submitPublicFormAction("token-1", { title: { text: "Too late" } }),
    ).toEqual({ error: "This form is not accepting responses." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects a missing required answer", async () => {
    expect(await submitPublicFormAction("token-1", {})).toEqual({
      error: "Please check the answers and try again.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid option even though the client thought it was fine", async () => {
    expect(
      await submitPublicFormAction("token-1", {
        title: { text: "Bad status" },
        status: { optionId: "not-an-option" },
      }),
    ).toEqual({ error: "Please check the answers and try again." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects a stored question for an unknown property", async () => {
    db.linkFindUnique.mockResolvedValue(
      link({
        view: {
          ...link().view,
          config: {
            form: {
              ...FORM,
              fields: [
                FORM.fields[0],
                { propertyId: "ghost", label: "Ghost", type: "TEXT" },
              ],
            },
          },
        },
      }),
    );

    expect(
      await submitPublicFormAction("token-1", {
        title: { text: "Hello" },
        ghost: { text: "boo" },
      }),
    ).toEqual({ error: "This form has an invalid configuration." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("drops upload questions that anonymous respondents cannot answer", async () => {
    const files = { id: "files", name: "Files", type: "FILES", config: {} };
    db.propertyFindMany.mockResolvedValue([PROPERTIES[0], files]);
    db.txPropertyFindMany.mockResolvedValue([PROPERTIES[0], files]);
    db.linkFindUnique.mockResolvedValue(
      link({
        view: {
          ...link().view,
          config: {
            form: {
              ...FORM,
              fields: [
                FORM.fields[0],
                { propertyId: "files", label: "Files", type: "FILES" },
              ],
            },
          },
        },
      }),
    );

    expect(
      await submitPublicFormAction("token-1", {
        title: { text: "Hello" },
        files: {
          files: [{ name: "report.pdf", url: "https://evil.example/report.pdf" }],
        },
      }),
    ).toEqual({ ok: true });
    // The file answer is not a public field, so it is never mapped to a cell.
    expect(db.txValueCreateMany.mock.calls[0][0].data).toEqual([
      { propertyId: "title", pageId: "row-1", value: { text: "Hello" } },
    ]);
  });

  it("refuses a form whose only questions need a signed-in picker", async () => {
    const people = { id: "people", name: "People", type: "PEOPLE", config: {} };
    db.propertyFindMany.mockResolvedValue([people]);
    db.linkFindUnique.mockResolvedValue(
      link({
        view: {
          ...link().view,
          config: {
            form: {
              ...FORM,
              fields: [{ propertyId: "people", label: "People", type: "PEOPLE" }],
            },
          },
        },
      }),
    );

    expect(await submitPublicFormAction("token-1", {})).toEqual({
      error: "This form has no questions that can be answered publicly.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("throttles one visitor before any write", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await submitPublicFormAction("token-1", {})).toEqual({
        error: "Please check the answers and try again.",
      });
    }

    expect(
      await submitPublicFormAction("token-1", { title: { text: "One too many" } }),
    ).toEqual({ error: "Too many submissions. Try again shortly." });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("propagates a cell-write failure so the transaction rolls back", async () => {
    db.txValueCreateMany.mockRejectedValue(new Error("cell write failed"));

    await expect(
      submitPublicFormAction("token-1", { title: { text: "Rollback" } }),
    ).rejects.toThrow("cell write failed");
    expect(db.txPageCreate).toHaveBeenCalledTimes(1);
  });
});
