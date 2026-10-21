import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TK02 — the chat action execute path.
 *
 * Proposals may only be applied through `executeChatActionAction`, which
 * re-checks workspace permission and delegates to the real ticket/page server
 * actions. These tests mock the transports (prisma, auth, cache, the ticket and
 * page actions, the AI provider) and let the action's own ordering and
 * permission logic run for real.
 */

const db = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  threadFindUnique: vi.fn(),
  threadUpdate: vi.fn(),
  messageFindUnique: vi.fn(),
  messageCreate: vi.fn(),
  messageUpdate: vi.fn(),
  messageUpdateMany: vi.fn(),
  ticketFindUnique: vi.fn(),
  ticketFindFirst: vi.fn(),
  ticketFindMany: vi.fn(),
  ticketDelete: vi.fn(),
  ticketLabelFindMany: vi.fn(),
  activityCreate: vi.fn(),
  projectFindFirst: vi.fn(),
  projectFindMany: vi.fn(),
  labelFindFirst: vi.fn(),
}));

const tickets = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  move: vi.fn(),
  archive: vi.fn(),
  toggleLabel: vi.fn(),
}));

const pages = vi.hoisted(() => ({ create: vi.fn() }));
const ai = vi.hoisted(() => ({ resolveAiConfig: vi.fn(), chatComplete: vi.fn() }));
const runtime = vi.hoisted(() => ({ buildChatRequest: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findUnique: db.memberFindUnique },
    workspace: { findUnique: db.workspaceFindUnique },
    chatThread: { findUnique: db.threadFindUnique, update: db.threadUpdate },
    chatMessage: {
      findUnique: db.messageFindUnique,
      create: db.messageCreate,
      update: db.messageUpdate,
      updateMany: db.messageUpdateMany,
    },
    ticket: {
      findUnique: db.ticketFindUnique,
      findFirst: db.ticketFindFirst,
      findMany: db.ticketFindMany,
      delete: db.ticketDelete,
    },
    ticketLabel: { findMany: db.ticketLabelFindMany },
    activity: { create: db.activityCreate },
    project: { findFirst: db.projectFindFirst, findMany: db.projectFindMany },
    label: { findFirst: db.labelFindFirst },
  },
}));
vi.mock("@/server/actions/tickets", () => ({
  createTicketAction: tickets.create,
  updateTicketAction: tickets.update,
  moveTicketAction: tickets.move,
  archiveTicketAction: tickets.archive,
  toggleTicketLabelAction: tickets.toggleLabel,
}));
vi.mock("@/server/actions/pages", () => ({ createPageAction: pages.create }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "user-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/ai-provider", () => ({
  resolveAiConfig: ai.resolveAiConfig,
  chatComplete: ai.chatComplete,
}));
vi.mock("@/lib/chat-runtime", () => ({ buildChatRequest: runtime.buildChatRequest }));
vi.mock("@/lib/chat-context", () => ({ linkifyReferences: vi.fn((text: string) => text) }));

import { executeChatActionAction, postChatMessageAction } from "./chat";
import type { ChatActionProposal } from "@/lib/chat-actions";

const CONFIG = {
  provider: "mock",
  baseUrl: "http://localhost",
  model: "m1",
  apiKey: "k",
  source: "env" as const,
};

const createProposal: ChatActionProposal = {
  kind: "createTicket",
  args: { title: "Ship the beta" },
  summary: 'Create ticket "Ship the beta"',
  requiresConfirm: true,
};

/**
 * The proposal a confirmation names: the assistant turn that stored it. A
 * confirmation is only bound to such a stored proposal (B17).
 */
function storeProposal(
  proposal: ChatActionProposal = createProposal,
  meta: Record<string, unknown> = {},
) {
  db.messageFindUnique.mockResolvedValue({
    threadId: "thread-1",
    meta: { proposal, ...meta },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
  db.workspaceFindUnique.mockResolvedValue({
    ownerId: "user-1",
    owner: { id: "user-1", name: "Demo", email: "demo@noema.local" },
    members: [],
  });
  db.threadFindUnique.mockResolvedValue({
    id: "thread-1",
    workspaceId: "ws-1",
    title: "New discussion",
    _count: { messages: 0 },
    pageId: null,
  });
  db.threadUpdate.mockResolvedValue({});
  db.messageCreate.mockResolvedValue({ id: "msg-1" });
  db.messageFindUnique.mockResolvedValue(null);
  db.messageUpdate.mockResolvedValue({});
  db.messageUpdateMany.mockResolvedValue({ count: 1 });
  db.ticketFindUnique.mockResolvedValue({ id: "t1", key: "DW-1", workspaceId: "ws-1" });
  db.ticketFindFirst.mockResolvedValue(null);
  db.ticketFindMany.mockResolvedValue([]);
  db.ticketDelete.mockResolvedValue({});
  db.ticketLabelFindMany.mockResolvedValue([]);
  db.activityCreate.mockResolvedValue({});
  db.projectFindFirst.mockResolvedValue(null);
  db.projectFindMany.mockResolvedValue([]);
  db.labelFindFirst.mockResolvedValue(null);

  tickets.create.mockResolvedValue({ ok: true, id: "t1", key: "DW-1" });
  tickets.update.mockResolvedValue({ ok: true });
  tickets.move.mockResolvedValue({ ok: true });
  tickets.archive.mockResolvedValue({ ok: true });
  tickets.toggleLabel.mockResolvedValue({ ok: true, attached: true });
  pages.create.mockResolvedValue({ ok: true, id: "p1", slug: "demo" });

  ai.resolveAiConfig.mockResolvedValue(CONFIG);
  ai.chatComplete.mockResolvedValue({ ok: true, text: "A grounded answer." });
  runtime.buildChatRequest.mockResolvedValue({
    system: "sys",
    context: "ctx",
    user: "usr",
    intel: { activity: [], intents: [], references: [] },
  });
});

describe("executeChatActionAction — permission", () => {
  it("refuses a guest and never touches the tickets", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "GUEST" });

    await expect(
      executeChatActionAction({ threadId: "thread-1", action: createProposal }),
    ).resolves.toEqual({ error: "You do not have permission to change this workspace." });

    expect(tickets.create).not.toHaveBeenCalled();
    expect(db.messageCreate).not.toHaveBeenCalled();
  });

  it("refuses a non-member", async () => {
    db.memberFindUnique.mockResolvedValue(null);
    db.workspaceFindUnique.mockResolvedValue({ ownerId: "someone-else" });

    await expect(
      executeChatActionAction({ threadId: "thread-1", action: createProposal }),
    ).resolves.toMatchObject({ error: expect.stringContaining("permission") });
    expect(tickets.create).not.toHaveBeenCalled();
  });
});

describe("executeChatActionAction — create", () => {
  it("creates the ticket and appends the assistant confirmation", async () => {
    storeProposal();

    const result = await executeChatActionAction({
      threadId: "thread-1",
      action: createProposal,
      proposalMessageId: "msg-0",
    });

    expect(tickets.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", title: "Ship the beta" }),
    );
    expect(result).toEqual({ ok: true, message: expect.stringContaining("DW-1") });
    expect(db.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "thread-1",
        role: "assistant",
        body: expect.stringContaining("Created"),
      }),
    });
  });

  it("resolves an assignee name to a workspace member id", async () => {
    db.workspaceFindUnique.mockResolvedValue({
      ownerId: "user-1",
      owner: { id: "user-1", name: "Demo", email: "demo@noema.local" },
      members: [{ user: { id: "user-2", name: "Jane", email: "jane@noema.local" } }],
    });
    const action: ChatActionProposal = {
      ...createProposal,
      args: { title: "Ship the beta", assigneeName: "Jane" },
    };
    storeProposal(action);

    await executeChatActionAction({
      threadId: "thread-1",
      action,
      proposalMessageId: "msg-0",
    });

    expect(tickets.create).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: "user-2" }),
    );
  });

  it("marks the proposal turn applied", async () => {
    storeProposal();

    await executeChatActionAction({
      threadId: "thread-1",
      action: createProposal,
      proposalMessageId: "msg-0",
    });

    expect(db.messageUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "msg-0", threadId: "thread-1" }),
      data: { meta: expect.objectContaining({ applied: true }) },
    });
  });
});

describe("executeChatActionAction — delete", () => {
  it("deletes the ticket and records workspace activity", async () => {
    const action: ChatActionProposal = {
      kind: "deleteTicket",
      args: { ticketId: "t1", ticketKey: "DW-1" },
      summary: "Delete DW-1",
      requiresConfirm: true,
    };
    storeProposal(action);

    const result = await executeChatActionAction({
      threadId: "thread-1",
      action,
      proposalMessageId: "msg-0",
    });

    expect(db.ticketDelete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(db.activityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "ticket.deleted", targetId: "t1" }),
    });
    expect(result).toEqual({ ok: true, message: expect.stringContaining("Deleted") });
  });
});

describe("executeChatActionAction — update and move", () => {
  it("applies status changes through updateTicketAction", async () => {
    const action: ChatActionProposal = {
      kind: "updateTicket",
      args: { ticketId: "t1", ticketKey: "DW-1", changes: { status: "done" } },
      summary: "Update DW-1",
      requiresConfirm: true,
    };
    storeProposal(action);

    await executeChatActionAction({
      threadId: "thread-1",
      action,
      proposalMessageId: "msg-0",
    });
    expect(tickets.update).toHaveBeenCalledWith({ ticketId: "t1", status: "done" });
  });

  it("moves through moveTicketAction", async () => {
    const action: ChatActionProposal = {
      kind: "moveTicket",
      args: { ticketId: "t1", ticketKey: "DW-1", status: "in_progress" },
      summary: "Move DW-1",
      requiresConfirm: true,
    };
    storeProposal(action);

    await executeChatActionAction({
      threadId: "thread-1",
      action,
      proposalMessageId: "msg-0",
    });
    expect(tickets.move).toHaveBeenCalledWith({ ticketId: "t1", status: "in_progress" });
  });
});

describe("executeChatActionAction — the confirmation is bound to the stored proposal (B17)", () => {
  it("refuses an action that was never proposed", async () => {
    // The client sends the action; the server stores the proposal in the
    // assistant turn. An action with no stored proposal behind it must not
    // run — that is the human-in-the-loop confirmation.
    db.messageFindUnique.mockResolvedValue(null);

    await expect(
      executeChatActionAction({
        threadId: "thread-1",
        action: createProposal,
        proposalMessageId: "msg-0",
      }),
    ).resolves.toEqual({ error: "That proposal is no longer available." });

    expect(tickets.create).not.toHaveBeenCalled();
    expect(db.messageCreate).not.toHaveBeenCalled();
  });

  it("refuses a confirmation that names no proposal at all", async () => {
    await expect(
      executeChatActionAction({ threadId: "thread-1", action: createProposal }),
    ).resolves.toEqual({ error: "That proposal is no longer available." });

    expect(tickets.create).not.toHaveBeenCalled();
  });

  it("refuses an action that differs from the stored proposal", async () => {
    storeProposal();

    await expect(
      executeChatActionAction({
        threadId: "thread-1",
        action: { ...createProposal, args: { title: "Ship the beta — and delete production" } },
        proposalMessageId: "msg-0",
      }),
    ).resolves.toEqual({ error: "That proposal does not match the request." });

    expect(tickets.create).not.toHaveBeenCalled();
  });

  it("refuses an action of another kind than the stored proposal", async () => {
    storeProposal();

    await expect(
      executeChatActionAction({
        threadId: "thread-1",
        action: { kind: "createNote", args: { title: "Ship the beta" }, summary: "", requiresConfirm: true },
        proposalMessageId: "msg-0",
      }),
    ).resolves.toEqual({ error: "That proposal does not match the request." });

    expect(pages.create).not.toHaveBeenCalled();
    expect(tickets.create).not.toHaveBeenCalled();
  });

  it("refuses a proposal that belongs to another thread", async () => {
    db.messageFindUnique.mockResolvedValue({
      threadId: "thread-2",
      meta: { proposal: createProposal },
    });

    await expect(
      executeChatActionAction({
        threadId: "thread-1",
        action: createProposal,
        proposalMessageId: "msg-0",
      }),
    ).resolves.toEqual({ error: "That proposal is no longer available." });

    expect(tickets.create).not.toHaveBeenCalled();
  });

  it("refuses a proposal that was already applied", async () => {
    storeProposal(createProposal, { applied: true });

    await expect(
      executeChatActionAction({
        threadId: "thread-1",
        action: createProposal,
        proposalMessageId: "msg-0",
      }),
    ).resolves.toEqual({ error: "That proposal is no longer available." });

    expect(tickets.create).not.toHaveBeenCalled();
  });

  it("applies the stored proposal when the confirmation matches it", async () => {
    storeProposal();

    const result = await executeChatActionAction({
      threadId: "thread-1",
      action: createProposal,
      proposalMessageId: "msg-0",
    });

    expect(tickets.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", title: "Ship the beta" }),
    );
    expect(result).toEqual({ ok: true, message: expect.stringContaining("DW-1") });
  });

  it("accepts a confirmation that carries the proposal without its decoration", async () => {
    // The summary and the confirm flag are decoration; the kind and its
    // arguments decide the effect. The stored proposal is what runs.
    storeProposal();

    const result = await executeChatActionAction({
      threadId: "thread-1",
      action: { kind: "createTicket", args: { title: "Ship the beta" } } as ChatActionProposal,
      proposalMessageId: "msg-0",
    });

    expect(tickets.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", title: "Ship the beta" }),
    );
    expect(result).toEqual({ ok: true, message: expect.stringContaining("DW-1") });
  });
});

describe("postChatMessageAction — the model is bypassed for actions", () => {
  it("does not call the model for a create request (proposal instead)", async () => {
    const result = await postChatMessageAction("thread-1", "create a ticket called Ship the beta");

    expect(result).toMatchObject({ ok: true, answered: true });
    expect(ai.chatComplete).not.toHaveBeenCalled();
    expect(db.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: "assistant",
        meta: expect.objectContaining({ proposal: expect.objectContaining({ kind: "createTicket" }) }),
      }),
    });
  });

  it("asks a clarifying question for an ambiguous action", async () => {
    const result = await postChatMessageAction("thread-1", "delete the ticket");

    expect(result).toMatchObject({ ok: true, answered: true });
    expect(ai.chatComplete).not.toHaveBeenCalled();
    expect(db.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ body: expect.stringContaining("Which ticket") }),
    });
  });

  it("still answers a plain question from the model", async () => {
    await postChatMessageAction("thread-1", "what tickets are open?");

    expect(ai.chatComplete).toHaveBeenCalledTimes(1);
  });
});
