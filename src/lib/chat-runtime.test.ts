import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B35 — chat runtime routing + grounding tests.
 *
 * Pure unit tests: the DB (`@/lib/db`) and the ranked retrieval
 * (`@/server/queries`) are mocked, `globalThis.fetch` is replaced by a spy that
 * fails the test if anything reaches the network, and no API key is read.
 */

const mocks = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  ticketFindMany: vi.fn(),
  projectFindMany: vi.fn(),
  searchPagesForPrompt: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: mocks.pageFindUnique },
    workspace: { findUnique: mocks.workspaceFindUnique },
    ticket: { findMany: mocks.ticketFindMany },
    project: { findMany: mocks.projectFindMany },
  },
}));

vi.mock("@/server/queries", () => ({
  searchPagesForPrompt: mocks.searchPagesForPrompt,
}));

import { CHAT_SYSTEM_PROMPT, buildChatRequest } from "./chat-runtime";
import { detectIntents } from "./chat-context";

const originalFetch = globalThis.fetch;

function resetMocks() {
  mocks.pageFindUnique.mockReset().mockResolvedValue(null);
  mocks.workspaceFindUnique.mockReset().mockResolvedValue(null);
  mocks.ticketFindMany.mockReset().mockResolvedValue([]);
  mocks.projectFindMany.mockReset().mockResolvedValue([]);
  mocks.searchPagesForPrompt.mockReset().mockResolvedValue([]);
  mocks.fetch.mockReset().mockImplementation(() =>
    Promise.reject(new Error("network disabled in unit tests")),
  );
}

beforeEach(() => {
  resetMocks();
  globalThis.fetch = mocks.fetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("chat-runtime prompt contract", () => {
  it("ships a single markdown-first grounding prompt", () => {
    expect(typeof CHAT_SYSTEM_PROMPT).toBe("string");
    expect(CHAT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    expect(CHAT_SYSTEM_PROMPT).toContain("Markdown");
    expect(CHAT_SYSTEM_PROMPT).toContain("160 words");
  });

  it("forbids inventing data that is not in the provided context", () => {
    expect(CHAT_SYSTEM_PROMPT).toContain("Never invent");
    expect(CHAT_SYSTEM_PROMPT).toContain("never from the open internet");
  });
});

describe("deterministic keyword → data-intent routing", () => {
  it("routes the members branch (who/team/invite keywords)", () => {
    expect(detectIntents("Who are the members of my team?")).toEqual(["members"]);
    expect(detectIntents("PEOPLE")).toEqual(["members"]);
    expect(detectIntents("liste des membres invités")).toEqual(["members"]);
  });

  it("routes the projects branch (project/milestone/timeline keywords)", () => {
    expect(detectIntents("show the project milestones and timeline")).toEqual(["projects"]);
    expect(detectIntents("what is the roadmap deadline?")).toEqual(["projects"]);
  });

  it("routes the tickets branch (bug/backlog/estimate keywords)", () => {
    expect(detectIntents("list the bugs in the backlog")).toEqual(["tickets"]);
    expect(detectIntents("open issues with story points")).toEqual(["tickets"]);
  });

  it("routes the tasks branch (task/checklist/unfinished keywords)", () => {
    expect(detectIntents("any unfinished checklist items?")).toEqual(["tasks"]);
    expect(detectIntents("liste des tâches ouvertes")).toEqual(["tasks"]);
  });

  it("routes the notes branch (note/page/document keywords)", () => {
    expect(detectIntents("find my notes about onboarding")).toEqual(["notes"]);
    expect(detectIntents("which page documents the API?")).toEqual(["notes"]);
  });

  it("falls back to notes when no keyword matches at all", () => {
    expect(detectIntents("")).toEqual(["notes"]);
    expect(detectIntents("   ")).toEqual(["notes"]);
    expect(detectIntents("hmm...")).toEqual(["notes"]);
  });

  it("keeps every matching branch for ambiguous input, in rule order", () => {
    expect(detectIntents("Who on the team wrote notes about the project bugs?")).toEqual([
      "members",
      "projects",
      "tickets",
      "notes",
    ]);
    expect(detectIntents("what's the sprint timeline?")).toEqual(["projects", "tickets"]);
    expect(detectIntents("list tasks from the notes")).toEqual(["tasks", "notes"]);
  });

  it("is case-insensitive and matches whole words only", () => {
    expect(detectIntents("MEMBERS")).toEqual(["members"]);
    // Neither "documentation" (superset of "doc") nor "taskmaster" (superset
    // of "task") is a whole-word hit, so routing falls back to notes.
    expect(detectIntents("documentation of the taskmaster")).toEqual(["notes"]);
  });
});

describe("buildChatRequest grounding per intent branch", () => {
  it("uses the shared system prompt and passes intel through", async () => {
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "find my notes about onboarding",
    });
    expect(request.system).toBe(CHAT_SYSTEM_PROMPT);
    expect(request.user).toBe("find my notes about onboarding");
    expect(request.intel.intents).toEqual(["notes"]);
    expect(Array.isArray(request.intel.activity)).toBe(true);
  });

  it("grounds a members question in the workspace roster only", async () => {
    mocks.workspaceFindUnique.mockResolvedValue({
      owner: { name: "Ada", email: "ada@x.test" },
      members: [{ role: "ADMIN", user: { name: "Bob", email: "bob@x.test" } }],
      invites: [{ email: "new@x.test", role: "MEMBER" }],
    });
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "who are the members of my team?",
    });

    expect(mocks.workspaceFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceFindUnique.mock.calls[0][0]).toMatchObject({
      where: { id: "ws1" },
    });
    expect(request.context).toContain("Workspace members (2): Ada (ada@x.test, owner)");
    expect(request.context).toContain("Bob (bob@x.test, admin)");
    expect(request.context).toContain("Pending invitations: new@x.test (member)");
    expect(request.intel.activity).toContain("Checked members");
    // Routing isolation: no other data source was consulted.
    expect(mocks.ticketFindMany).not.toHaveBeenCalled();
    expect(mocks.projectFindMany).not.toHaveBeenCalled();
    expect(mocks.searchPagesForPrompt).not.toHaveBeenCalled();
    expect(mocks.pageFindUnique).not.toHaveBeenCalled();
  });

  it("grounds a tickets question in the ticket list only", async () => {
    mocks.ticketFindMany.mockResolvedValue([
      {
        key: "ENG-1",
        title: "Fix login",
        status: "open",
        priority: "high",
        estimate: 3,
        estimateUnit: "points",
        dueDate: null,
        assignee: { name: "Ada" },
        labels: [{ label: { name: "bug" } }],
      },
    ]);
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "list the bugs in the backlog",
    });

    expect(mocks.ticketFindMany).toHaveBeenCalledTimes(1);
    expect(request.context).toContain("Tickets (1, 1 open · 3 points remaining):");
    expect(request.context).toContain("- ENG-1 [open, high] @Ada · 3 points · bug — Fix login");
    expect(request.intel.activity).toContain("Reviewed tickets");
    expect(mocks.workspaceFindUnique).not.toHaveBeenCalled();
    expect(mocks.projectFindMany).not.toHaveBeenCalled();
    expect(mocks.searchPagesForPrompt).not.toHaveBeenCalled();
  });

  it("grounds a projects question in the project/milestone list only", async () => {
    mocks.projectFindMany.mockResolvedValue([
      {
        id: "proj1",
        name: "Apollo",
        status: "active",
        startDate: null,
        dueDate: new Date("2026-03-01T00:00:00.000Z"),
        _count: { pages: 4 },
        milestones: [
          { name: "M1", status: "done", dueDate: null },
          { name: "M2", status: "todo", dueDate: new Date("2026-03-01T00:00:00.000Z") },
        ],
      },
    ]);
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "show the project milestones and timeline",
    });

    expect(mocks.projectFindMany).toHaveBeenCalledTimes(1);
    expect(request.context).toContain(
      "- Apollo (active), due 2026-03-01, 1/2 milestones, next: M2 (2026-03-01), 4 notes",
    );
    expect(request.intel.activity).toContain("Reviewed projects");
    expect(mocks.ticketFindMany).not.toHaveBeenCalled();
    expect(mocks.workspaceFindUnique).not.toHaveBeenCalled();
    expect(mocks.searchPagesForPrompt).not.toHaveBeenCalled();
  });

  it("grounds a notes question in ranked page search and links references", async () => {
    mocks.searchPagesForPrompt.mockResolvedValue([
      { id: "p1", title: "Onboarding guide", icon: ":book:", snippet: "First week…" },
    ]);
    const question = "find my notes about onboarding";
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question,
    });

    expect(mocks.searchPagesForPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.searchPagesForPrompt).toHaveBeenCalledWith("ws1", question, 5);
    expect(request.context).toContain("Matching notes:");
    expect(request.context).toContain('- "Onboarding guide" (id p1): First week…');
    expect(request.intel.references).toEqual([
      { id: "p1", title: "Onboarding guide", icon: ":book:" },
    ]);
    expect(request.intel.activity).toContain("Searched notes");
    expect(mocks.ticketFindMany).not.toHaveBeenCalled();
    expect(mocks.workspaceFindUnique).not.toHaveBeenCalled();
    expect(mocks.projectFindMany).not.toHaveBeenCalled();
  });

  it("opens the pinned note and lists only its unchecked tasks", async () => {
    mocks.pageFindUnique.mockResolvedValue({
      id: "p1",
      title: "Sprint notes",
      icon: null,
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [{ type: "text", text: "Ship the report" }],
          },
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [{ type: "text", text: "Done thing" }],
          },
        ],
      },
    });
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: "p1",
      question: "any unfinished checklist items?",
    });

    expect(mocks.pageFindUnique).toHaveBeenCalledTimes(1);
    expect(request.context).toContain('Current note "Sprint notes":');
    expect(request.context).toContain("Open tasks in this note:\n- Ship the report");
    expect(request.context).not.toContain("- Done thing");
    expect(request.intel.activity).toContain("Opened the current note");
    expect(request.intel.activity).toContain("Checked tasks");
    expect(mocks.searchPagesForPrompt).not.toHaveBeenCalled();
    expect(mocks.ticketFindMany).not.toHaveBeenCalled();
  });

  it("opens the pinned note without the task panel when every task is checked", async () => {
    mocks.pageFindUnique.mockResolvedValue({
      id: "p1",
      title: "Weekly review",
      icon: null,
      content: {
        type: "doc",
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [{ type: "text", text: "Everything shipped" }],
          },
        ],
      },
    });
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: "p1",
      question: "any unfinished checklist items?",
    });

    expect(request.context).toContain('Current note "Weekly review":');
    expect(request.context).not.toContain("Open tasks in this note");
    expect(request.intel.activity).toContain("Opened the current note");
    expect(request.intel.activity).not.toContain("Checked tasks");
  });

  it("uses the default question and notes fallback for empty input", async () => {
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "",
    });

    expect(request.user).toBe("Summarize this note and suggest next steps.");
    expect(request.system).toBe(CHAT_SYSTEM_PROMPT);
    expect(request.intel.intents).toEqual(["notes"]);
    expect(mocks.searchPagesForPrompt).toHaveBeenCalledWith("ws1", "", 5);
    // No page, no matches → no context block at all.
    expect(request.context).toBeUndefined();
    expect(request.intel.references).toEqual([]);
  });

  it("leaves context undefined when the branch finds nothing", async () => {
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "find my notes about onboarding",
    });

    expect(request.intel.intents).toEqual(["notes"]);
    expect(request.context).toBeUndefined();
    expect(request.intel.activity).toEqual([]);
  });

  it("never touches the network (fetch is mocked and stays unused)", async () => {
    await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "who are the members of my team?",
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
