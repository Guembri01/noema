import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TK02 — the chat action parser.
 *
 * The parser is pure and deterministic: each imperative verb becomes a proposed
 * action, underspecified phrasing becomes a clarifying question, and a plain
 * question returns `null`. Ticket resolution (key / exact title / partial,
 * plus the ambiguous case) is exercised against a mocked prisma.
 */

const db = vi.hoisted(() => ({
  ticketFindFirst: vi.fn(),
  ticketFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { ticket: { findFirst: db.ticketFindFirst, findMany: db.ticketFindMany } },
}));

import {
  normalizeStatus,
  parseChatAction,
  planChatAction,
  resolveTicketRef,
} from "./chat-actions";

const NOW = new Date("2026-10-15T12:00:00.000Z");

beforeEach(() => {
  db.ticketFindFirst.mockReset();
  db.ticketFindMany.mockReset();
  db.ticketFindFirst.mockResolvedValue(null);
  db.ticketFindMany.mockResolvedValue([]);
});

describe("parseChatAction — createTicket", () => {
  it("parses 'create a ticket called …'", () => {
    const action = parseChatAction('create a ticket called "Ship the beta"', { now: NOW });
    expect(action).toMatchObject({
      kind: "createTicket",
      requiresConfirm: true,
      args: { title: "Ship the beta" },
    });
  });

  it("parses an unquoted title", () => {
    expect(parseChatAction("create a ticket called Ship the beta", { now: NOW })).toMatchObject({
      kind: "createTicket",
      args: { title: "Ship the beta" },
    });
  });

  it("captures priority, estimate and due date and stops the title there", () => {
    const action = parseChatAction("create a ticket called Fix login with priority high", { now: NOW });
    expect(action).toMatchObject({ kind: "createTicket", args: { title: "Fix login", priority: "high" } });
  });

  it("clarifies when the title is missing", () => {
    expect(parseChatAction("create a ticket", { now: NOW })).toEqual({
      clarify: "What should the ticket be called?",
    });
  });
});

describe("parseChatAction — createNote", () => {
  it("parses a note creation", () => {
    expect(parseChatAction('create a note called "Sprint ideas"')).toMatchObject({
      kind: "createNote",
      args: { title: "Sprint ideas" },
    });
  });

  it("clarifies a note without a title", () => {
    expect(parseChatAction("create a note")).toEqual({ clarify: "What should the note be called?" });
  });
});

describe("parseChatAction — moveTicket", () => {
  it("moves to a normalised status", () => {
    expect(parseChatAction("move ABC-3 to Done")).toMatchObject({
      kind: "moveTicket",
      args: { ticketRef: "ABC-3", status: "done" },
    });
    expect(parseChatAction("move ABC-3 to in progress")).toMatchObject({
      kind: "moveTicket",
      args: { status: "in_progress" },
    });
  });

  it("clarifies an unknown status", () => {
    const action = parseChatAction("move ABC-3 to shipped");
    expect(action).toMatchObject({ clarify: expect.stringContaining("shipped") });
  });

  it("clarifies a missing ticket", () => {
    expect(parseChatAction("move the ticket to Done")).toEqual({
      clarify: "Which ticket should I move? Give its key (like ABC-3) or its exact title.",
    });
  });
});

describe("parseChatAction — deleteTicket / archiveTicket", () => {
  it("deletes by key", () => {
    expect(parseChatAction("delete ABC-3")).toMatchObject({
      kind: "deleteTicket",
      args: { ticketRef: "ABC-3" },
    });
  });

  it("archives by title", () => {
    expect(parseChatAction('archive "Ship the beta"')).toMatchObject({
      kind: "archiveTicket",
      args: { ticketRef: "Ship the beta" },
    });
  });

  it("clarifies delete without a ticket", () => {
    expect(parseChatAction("delete the ticket")).toMatchObject({
      clarify: expect.stringContaining("Which ticket should I delete"),
    });
  });
});

describe("parseChatAction — updateTicket", () => {
  it("changes a status", () => {
    expect(parseChatAction("mark ABC-3 as done")).toMatchObject({
      kind: "updateTicket",
      args: { ticketRef: "ABC-3", changes: { status: "done" } },
    });
  });

  it("changes a priority", () => {
    expect(parseChatAction("set ABC-3 priority to high")).toMatchObject({
      kind: "updateTicket",
      args: { ticketRef: "ABC-3", changes: { priority: "high" } },
    });
  });

  it("reassigns", () => {
    expect(parseChatAction("assign ABC-3 to Jane")).toMatchObject({
      kind: "updateTicket",
      args: { ticketRef: "ABC-3", changes: { assigneeName: "Jane" } },
    });
  });

  it("changes the estimate", () => {
    expect(parseChatAction("set estimate of ABC-3 to 5 points")).toMatchObject({
      kind: "updateTicket",
      args: { ticketRef: "ABC-3", changes: { estimate: 5, estimateUnit: "points" } },
    });
  });

  it("changes the due date", () => {
    expect(parseChatAction("change ABC-3 due date to 2026-03-01")).toMatchObject({
      kind: "updateTicket",
      args: { ticketRef: "ABC-3", changes: { dueDate: "2026-03-01" } },
    });
  });

  it("adds a label", () => {
    expect(parseChatAction("add label bug to ABC-3")).toMatchObject({
      kind: "updateTicket",
      args: { ticketRef: "ABC-3", changes: { labels: ["bug"] } },
    });
  });

  it("clarifies when nothing concrete changes", () => {
    const action = parseChatAction("update ABC-3");
    expect(action).toMatchObject({ clarify: expect.stringContaining("What should I change") });
  });
});

describe("parseChatAction — plain questions and comments return null", () => {
  for (const question of [
    "what tickets are open?",
    "list my tickets",
    "how many tickets do we have?",
    "what is the status of ABC-3?",
    "summarize this note",
    "who is on the team?",
    "delete the label bug",
    "",
  ]) {
    it(`returns null for: ${JSON.stringify(question)}`, () => {
      expect(parseChatAction(question, { now: NOW })).toBeNull();
    });
  }

  it("still accepts the /ask prefix", () => {
    expect(parseChatAction("/ask create a ticket called Ship the beta", { now: NOW })).toMatchObject({
      kind: "createTicket",
    });
  });
});

describe("normalizeStatus", () => {
  it("maps user phrasing to canonical ids", () => {
    expect(normalizeStatus("Done")).toBe("done");
    expect(normalizeStatus("in progress")).toBe("in_progress");
    expect(normalizeStatus("to-do")).toBe("todo");
    expect(normalizeStatus("nonsense")).toBeNull();
  });
});

describe("resolveTicketRef", () => {
  const ticket = { id: "t1", key: "ABC-3", title: "Ship the beta", status: "todo" };

  it("resolves by exact key (upper-cased)", async () => {
    db.ticketFindFirst.mockResolvedValueOnce(ticket);
    await expect(resolveTicketRef("ws-1", "abc-3")).resolves.toEqual({ ok: true, ticket });
    expect(db.ticketFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws-1", key: "ABC-3" }) }),
    );
  });

  it("resolves by exact title", async () => {
    db.ticketFindFirst.mockResolvedValue(ticket);
    await expect(resolveTicketRef("ws-1", "Ship the beta")).resolves.toEqual({ ok: true, ticket });
  });

  it("resolves a unique partial title", async () => {
    db.ticketFindMany.mockResolvedValueOnce([ticket]);
    await expect(resolveTicketRef("ws-1", "beta")).resolves.toEqual({ ok: true, ticket });
  });

  it("reports ambiguity for several partial matches", async () => {
    db.ticketFindMany.mockResolvedValueOnce([
      ticket,
      { id: "t2", key: "ABC-4", title: "Ship the gamma", status: "todo" },
    ]);
    const result = await resolveTicketRef("ws-1", "Ship");
    expect(result).toMatchObject({ ok: false, reason: "ambiguous" });
    if (!result.ok && result.reason === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("reports not-found", async () => {
    await expect(resolveTicketRef("ws-1", "nothing")).resolves.toEqual({ ok: false, reason: "not-found" });
  });
});

describe("planChatAction", () => {
  const ticket = { id: "t1", key: "ABC-3", title: "Ship the beta", status: "todo" };

  it("returns a proposal for a create (no resolution needed)", async () => {
    const plan = await planChatAction("ws-1", "create a ticket called Ship the beta", { now: NOW });
    expect(plan).toMatchObject({ status: "proposal", proposal: { kind: "createTicket" } });
  });

  it("resolves the ticket and annotates the proposal", async () => {
    db.ticketFindFirst.mockResolvedValueOnce(ticket);
    const plan = await planChatAction("ws-1", "delete ABC-3");
    expect(plan).toMatchObject({
      status: "proposal",
      proposal: { kind: "deleteTicket", args: { ticketId: "t1", ticketKey: "ABC-3" } },
    });
  });

  it("asks instead of guessing when several tickets match", async () => {
    db.ticketFindMany.mockResolvedValueOnce([
      ticket,
      { id: "t2", key: "ABC-4", title: "Ship the gamma", status: "todo" },
    ]);
    const plan = await planChatAction("ws-1", "archive the ticket called Ship");
    expect(plan).toMatchObject({ status: "clarify" });
    if (plan?.status === "clarify") expect(plan.message).toContain("several tickets");
  });

  it("asks instead of guessing when nothing matches", async () => {
    const plan = await planChatAction("ws-1", "delete ABC-9");
    expect(plan).toMatchObject({ status: "clarify" });
  });

  it("returns null for a plain question", async () => {
    await expect(planChatAction("ws-1", "how many tickets are open?")).resolves.toBeNull();
  });
});
