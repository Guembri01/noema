import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `updateTicketAction`'s description write.
 *
 * The rich description editor hands its document to the server as JSON *text*,
 * and this is why: ProseMirror shares a single `attrs` object between every mark
 * carrying the same attributes, and React's action encoder swaps a shared object
 * graph for a temporary reference (`"$T"`). Sending the object directly therefore
 * reached the server with `attrs: "$T"`, and the parsed document lost exactly the
 * attributes that carry meaning — a text colour, a highlight, a link's `href` —
 * while keeping the mark itself, so the description silently saved uncoloured.
 * Only the database edge, auth and `next/cache` are mocked; the parse runs for real.
 */

const db = vi.hoisted(() => ({
  ticket: { findUnique: vi.fn(), update: vi.fn() },
  ticketActivity: { create: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: (role: string) => role !== "GUEST",
  canManageMembers: () => false,
}));

import { updateTicketAction } from "./tickets";

/** A doc with the two marks whose meaning lives in their attributes. */
const DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Colour me and link me",
          marks: [
            { type: "textStyle", attrs: { color: "var(--tag-blue-fg)" } },
            { type: "link", attrs: { href: "https://example.com/docs" } },
          ],
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  db.ticket.findUnique.mockResolvedValue({
    id: "t1",
    workspaceId: "ws1",
    status: "todo",
    title: "Ticket one",
    key: "NOE-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    assigneeId: null,
    projectId: null,
  });
  db.ticket.update.mockResolvedValue({ id: "t1" });
  db.ticketActivity.create.mockResolvedValue({ id: "a1" });
});

describe("updateTicketAction description document", () => {
  it("takes the editor's serialised doc and keeps every mark's attributes", async () => {
    const result = await updateTicketAction({ ticketId: "t1", descriptionDoc: JSON.stringify(DOC) });

    expect(result).toEqual({ ok: true });
    expect(db.ticket.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { description: DOC },
    });
  });

  it("still accepts a doc handed over as an object", async () => {
    const result = await updateTicketAction({ ticketId: "t1", descriptionDoc: DOC });

    expect(result).toEqual({ ok: true });
    expect(db.ticket.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { description: DOC },
    });
  });

  it("refuses a serialised doc that is not a page document", async () => {
    const result = await updateTicketAction({ ticketId: "t1", descriptionDoc: '{"type":"nope"}' });

    expect(result).toEqual({ error: "That description is too large." });
    expect(db.ticket.update).not.toHaveBeenCalled();
  });
});
