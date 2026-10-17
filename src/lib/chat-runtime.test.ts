import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B35 — chat runtime grounding tests.
 *
 * Pure unit tests: the DB (`@/lib/db`) and the ranked retrieval
 * (`@/server/queries`) are mocked, `globalThis.fetch` is replaced by a spy that
 * fails the test if anything reaches the network, and no API key is read.
 *
 * The assistant is handed the WHOLE workspace every time — there is no keyword
 * gating. `detectIntents` survives only to label activity in the UI.
 */

type MockArgs = { where?: Record<string, unknown>; select?: Record<string, unknown> };
type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  pageCount: vi.fn(),
  workspaceFindUnique: vi.fn(),
  ticketFindMany: vi.fn(),
  projectFindMany: vi.fn(),
  propertyFindMany: vi.fn(),
  labelCount: vi.fn(),
  labelFindMany: vi.fn(),
  commentCount: vi.fn(),
  commentFindMany: vi.fn(),
  chatThreadCount: vi.fn(),
  chatThreadFindMany: vi.fn(),
  chatMessageFindMany: vi.fn(),
  searchPagesForPrompt: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findUnique: mocks.pageFindUnique,
      findFirst: mocks.pageFindFirst,
      findMany: mocks.pageFindMany,
      count: mocks.pageCount,
    },
    workspace: { findUnique: mocks.workspaceFindUnique },
    ticket: { findMany: mocks.ticketFindMany },
    project: { findMany: mocks.projectFindMany },
    property: { findMany: mocks.propertyFindMany },
    label: { count: mocks.labelCount, findMany: mocks.labelFindMany },
    comment: { count: mocks.commentCount, findMany: mocks.commentFindMany },
    chatThread: { count: mocks.chatThreadCount, findMany: mocks.chatThreadFindMany },
    chatMessage: { findMany: mocks.chatMessageFindMany },
  },
}));

vi.mock("@/server/queries", () => ({
  searchPagesForPrompt: mocks.searchPagesForPrompt,
}));

import { CHAT_SYSTEM_PROMPT, buildChatRequest } from "./chat-runtime";
import {
  DEFAULT_CONTEXT_CHARS,
  detectIntents,
  fitBlocks,
  resolveContextBudget,
} from "./chat-context";

const originalFetch = globalThis.fetch;

/* ------------------------------------------------------------- mock stores */

/** Rows returned for the PAGES index query. */
let pageIndexRows: Row[] = [];
/** Children of the current page (the `parentId` string query). */
let currentPageChildren: Row[] = [];
/** Database pages (with properties + child count). */
let databaseRows: Row[] = [];
/** Rows of database pages (with property values). */
let databaseRowValues: Row[] = [];
/** The handful of recently edited pages in the overview. */
let recentPageRows: Row[] = [];
let notesCount = 0;
let databaseCount = 0;
let pageTotal = 0;

function resetStores() {
  pageIndexRows = [];
  currentPageChildren = [];
  databaseRows = [];
  databaseRowValues = [];
  recentPageRows = [];
  notesCount = 0;
  databaseCount = 0;
  pageTotal = 0;
}

function resetMocks() {
  resetStores();
  mocks.pageFindUnique.mockReset().mockResolvedValue(null);
  mocks.pageFindFirst.mockReset().mockResolvedValue(null);
  mocks.pageFindMany.mockReset().mockImplementation(async (args: MockArgs = {}) => {
    const where = args.where ?? {};
    if (where.type === "DATABASE") return databaseRows;
    if (typeof where.parentId === "object" && where.parentId !== null && "in" in where.parentId) {
      return databaseRowValues;
    }
    if (typeof where.parentId === "string") return currentPageChildren;
    if (where.type === "PAGE") return recentPageRows;
    if (args.select && "parentId" in args.select) return pageIndexRows;
    return pageIndexRows;
  });
  mocks.pageCount.mockReset().mockImplementation(async (args: MockArgs = {}) => {
    const where = args.where ?? {};
    if (where.type === "PAGE") return notesCount;
    if (where.type === "DATABASE") return databaseCount;
    return pageTotal;
  });
  mocks.workspaceFindUnique.mockReset().mockResolvedValue(null);
  mocks.ticketFindMany.mockReset().mockResolvedValue([]);
  mocks.projectFindMany.mockReset().mockResolvedValue([]);
  mocks.propertyFindMany.mockReset().mockResolvedValue([]);
  mocks.labelCount.mockReset().mockResolvedValue(0);
  mocks.labelFindMany.mockReset().mockResolvedValue([]);
  mocks.commentCount.mockReset().mockResolvedValue(0);
  mocks.commentFindMany.mockReset().mockResolvedValue([]);
  mocks.chatThreadCount.mockReset().mockResolvedValue(0);
  mocks.chatThreadFindMany.mockReset().mockResolvedValue([]);
  mocks.chatMessageFindMany.mockReset().mockResolvedValue([]);
  mocks.searchPagesForPrompt.mockReset().mockResolvedValue([]);
  mocks.fetch.mockReset().mockImplementation(() =>
    Promise.reject(new Error("network disabled in unit tests")),
  );
}

/* ------------------------------------------------------------ seed helpers */

/**
 * Seed `page.findFirst`, which `resolveCurrentPage` uses both for the page and
 * for each ancestor in the breadcrumb walk. Scoping is part of the contract: a
 * row whose `workspaceId` differs is NOT returned, which is how a page id from
 * another workspace is rejected.
 */
function seedPages(
  pages: {
    id: string;
    workspaceId?: string;
    title?: string;
    type?: "PAGE" | "DATABASE";
    parentId?: string | null;
    content?: unknown;
    updatedAt?: Date;
  }[],
) {
  const rows = pages.map((page) => ({
    workspaceId: "ws1",
    title: "",
    type: "PAGE" as const,
    parentId: null,
    content: null,
    updatedAt: new Date("2026-05-09T10:00:00Z"),
    ...page,
  }));
  mocks.pageFindFirst.mockImplementation(
    (args: { where: { id: string; workspaceId: string } }) =>
      Promise.resolve(
        rows.find(
          (row) => row.id === args.where.id && row.workspaceId === args.where.workspaceId,
        ) ?? null,
      ),
  );
  return rows;
}

/** Child pages of the open page (sub-pages of a note, or rows of a database). */
function seedChildren(children: { title: string; type?: "PAGE" | "DATABASE" }[]) {
  currentPageChildren = children.map((child, index) => ({
    title: child.title,
    type: child.type ?? "PAGE",
    position: index,
  }));
}

/** The workspace's page index (every page, newest first). */
function seedIndex(
  pages: {
    id: string;
    title?: string;
    type?: "PAGE" | "DATABASE";
    parentId?: string | null;
    icon?: string | null;
    updatedAt?: Date;
  }[],
) {
  pageIndexRows = pages.map((page) => ({
    id: page.id,
    title: page.title ?? "",
    type: page.type ?? "PAGE",
    parentId: page.parentId ?? null,
    icon: page.icon ?? null,
    updatedAt: page.updatedAt ?? new Date("2026-05-09T10:00:00Z"),
  }));
}

/** Every database page with its properties and its child count. */
function seedDatabases(
  databases: {
    id: string;
    title?: string;
    icon?: string | null;
    properties?: { name: string; type: string }[];
    rows?: number;
  }[],
) {
  databaseRows = databases.map((database) => ({
    id: database.id,
    title: database.title ?? "",
    icon: database.icon ?? null,
    properties: database.properties ?? [],
    _count: { children: database.rows ?? 0 },
  }));
}

/** Rows of database pages, each with its property values. */
function seedDatabaseRows(
  rows: {
    id: string;
    title: string;
    parentId: string;
    values?: { name: string; value: unknown }[];
  }[],
) {
  databaseRowValues = rows.map((row) => ({
    id: row.id,
    title: row.title,
    parentId: row.parentId,
    propertyValues: (row.values ?? []).map((value) => ({
      value: value.value,
      property: { name: value.name },
    })),
  }));
}

function seedOverviewCounts(counts: { notes?: number; databases?: number; total?: number }) {
  notesCount = counts.notes ?? 0;
  databaseCount = counts.databases ?? 0;
  pageTotal = counts.total ?? notesCount + databaseCount;
}

function seedRecentPages(pages: { title: string; updatedAt?: Date }[]) {
  recentPageRows = pages.map((page, index) => ({
    title: page.title,
    updatedAt: page.updatedAt ?? new Date(`2026-05-0${index + 1}T10:00:00Z`),
  }));
}

/** A working workspace roster, returned by `workspace.findUnique` for both the
 * overview (name) and the members block (owner/members/invites). */
function seedWorkspace(extra: Row = {}) {
  mocks.workspaceFindUnique.mockResolvedValue({ name: "Acme", ...extra });
}

beforeEach(() => {
  resetMocks();
  globalThis.fetch = mocks.fetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/* ------------------------------------------------------------------ prompt */

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

  it("tells the model it receives a complete snapshot it must reason over", () => {
    expect(CHAT_SYSTEM_PROMPT).toContain("COMPLETE snapshot");
    expect(CHAT_SYSTEM_PROMPT).toContain("PAGES index");
    expect(CHAT_SYSTEM_PROMPT).toContain("DATABASES");
    expect(CHAT_SYSTEM_PROMPT).toContain("genuinely absent from the snapshot");
  });
});

/* ---------------------------------------------------------------- intents */

describe("detectIntents — UI activity labels only (never gates data)", () => {
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

/* --------------------------------------------------- no keyword gating */

describe("the snapshot is complete — no keyword gating", () => {
  function seedFullWorkspace() {
    seedWorkspace({
      owner: { name: "Ada", email: "ada@x.test" },
      members: [{ role: "ADMIN", user: { name: "Bob", email: "bob@x.test" } }],
      invites: [{ email: "new@x.test", role: "MEMBER" }],
    });
    seedOverviewCounts({ notes: 2, databases: 1, total: 3 });
    seedIndex([
      { id: "p1", title: "Roadmap", type: "PAGE" },
      { id: "p2", title: "Onboarding", type: "PAGE", parentId: "p1" },
      { id: "db1", title: "Tickets", type: "DATABASE" },
    ]);
    seedDatabases([
      {
        id: "db1",
        title: "Tickets",
        rows: 1,
        properties: [{ name: "Status", type: "STATUS" }],
      },
    ]);
    seedDatabaseRows([
      { id: "r1", title: "Fix login", parentId: "db1", values: [{ name: "Status", value: "Open" }] },
    ]);
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
    mocks.projectFindMany.mockResolvedValue([
      {
        id: "proj1",
        name: "Apollo",
        status: "active",
        startDate: null,
        dueDate: new Date("2026-03-01T00:00:00.000Z"),
        _count: { pages: 2 },
        milestones: [
          { name: "M1", status: "done", dueDate: null },
          { name: "M2", status: "todo", dueDate: new Date("2026-03-01T00:00:00.000Z") },
        ],
      },
    ]);
    mocks.labelFindMany.mockResolvedValue([{ name: "bug" }, { name: "feature" }]);
    mocks.chatThreadFindMany.mockResolvedValue([{ title: "Launch" }]);
    mocks.chatThreadCount.mockResolvedValue(1);
  }

  it('answers a question with NO keywords ("hello there") from the full snapshot', async () => {
    seedFullWorkspace();
    const question = "hello there";
    // The keyword router sees nothing here — proving the data below does not
    // depend on it.
    expect(detectIntents(question)).toEqual(["notes"]);

    const request = await buildChatRequest({ workspaceId: "ws1", pageId: null, question });

    expect(request.context).toContain("PAGES — every page in the workspace (3):");
    expect(request.context).toContain('"Roadmap" · note · Roadmap · edited 2026-05-09');
    expect(request.context).toContain('"Onboarding" · note · Roadmap / Onboarding');
    expect(request.context).toContain("DATABASES — every database and its rows (1):");
    expect(request.context).toContain('- "Tickets" — 1 row · properties: Status (STATUS)');
    expect(request.context).toContain('  - "Fix login" · Status: Open');
    expect(request.context).toContain("Tickets (1, 1 open · 3 points remaining):");
    expect(request.context).toContain("Projects:");
    expect(request.context).toContain("Workspace members (2): Ada (ada@x.test, owner)");
    expect(request.context).toContain("RECENT MESSAGES: none");
    expect(request.context).toContain("LABELS & DISCUSSIONS");

    expect(request.intel.activity).toEqual(
      expect.arrayContaining([
        "Read the workspace overview",
        "Indexed the pages",
        "Read the databases",
        "Reviewed tickets",
        "Reviewed projects",
        "Checked members",
        "Read recent messages",
        "Read the labels and discussions",
      ]),
    );
    expect(request.intel.references.map((reference) => reference.id)).toEqual(
      expect.arrayContaining(["db1", "p1", "p2"]),
    );
  });

  it("returns tickets even when the question never mentions them", async () => {
    seedWorkspace();
    mocks.ticketFindMany.mockResolvedValue([
      {
        key: "ENG-1",
        title: "Fix login",
        status: "open",
        priority: "high",
        estimate: 3,
        estimateUnit: "points",
        dueDate: new Date("2026-01-01T00:00:00.000Z"),
        assignee: { name: "Ada" },
        labels: [{ label: { name: "bug" } }],
      },
    ]);
    const question = "what should we focus on?";
    expect(detectIntents(question)).not.toContain("tickets");

    const request = await buildChatRequest({ workspaceId: "ws1", pageId: null, question });

    expect(request.context).toContain("Tickets (1, 1 open · 3 points remaining):");
    expect(request.context).toContain("- ENG-1 [open, high] @Ada · 3 points · due 2026-01-01 · bug — Fix login");
    expect(request.intel.activity).toContain("Reviewed tickets");
  });

  it("still includes databases and projects for a tickets question", async () => {
    seedWorkspace();
    seedDatabases([{ id: "db1", title: "Tickets", rows: 1 }]);
    mocks.projectFindMany.mockResolvedValue([
      { id: "proj1", name: "Apollo", status: "active", startDate: null, dueDate: null, _count: { pages: 1 }, milestones: [] },
    ]);
    mocks.ticketFindMany.mockResolvedValue([
      { key: "ENG-2", title: "Slow search", status: "todo", priority: "low", estimate: null, estimateUnit: "points", dueDate: null, assignee: null, labels: [] },
    ]);

    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "which tickets are overdue?",
    });

    expect(request.context).toContain("DATABASES — every database and its rows (1):");
    expect(request.context).toContain("Projects:");
    expect(request.context).toContain("Tickets (");
  });

  it("notes the truncation of the page index and database rows", async () => {
    seedWorkspace();
    // 402 pages in the index → the last is never shown, "…and 2 more" appears.
    seedIndex(
      Array.from({ length: 400 }, (_, index) => ({ id: `p${index}`, title: `Page ${index}` })),
    );
    seedOverviewCounts({ notes: 402, total: 402 });
    seedDatabases([{ id: "db1", title: "Tickets", rows: 60 }]);
    seedDatabaseRows(
      Array.from({ length: 50 }, (_, index) => ({
        id: `r${index}`,
        title: `Row ${index}`,
        parentId: "db1",
      })),
    );

    const request = await buildChatRequest({ workspaceId: "ws1", pageId: null, question: "hello" });

    expect(request.context).toContain("PAGES — every page in the workspace (402):");
    expect(request.context).toContain("- …and 2 more");
    expect(request.context).toContain("  - …and 10 more rows");
  });
});

/* ----------------------------------------------- workspace overview block */

describe("workspace overview (always-on grounding)", () => {
  it("includes live counts even when no intent matches the question", async () => {
    seedWorkspace();
    seedOverviewCounts({ notes: 3, databases: 1 });
    mocks.ticketFindMany.mockResolvedValue([
      { status: "todo", dueDate: null, assigneeId: "u1", estimate: 2, estimateUnit: "points", title: "A", key: "A-1", priority: "high", assignee: { name: "Ada" }, labels: [] },
      { status: "done", dueDate: null, assigneeId: "u1", estimate: 3, estimateUnit: "points", title: "B", key: "A-2", priority: "low", assignee: { name: "Ada" }, labels: [] },
    ]);
    mocks.projectFindMany.mockResolvedValue([
      {
        name: "Apollo",
        status: "active",
        dueDate: null,
        milestones: [{ name: "M2", status: "todo", dueDate: new Date("2026-03-01T00:00:00.000Z") }],
      },
    ]);

    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "hmm, what is going on here?",
    });

    expect(request.context).toContain('WORKSPACE OVERVIEW — "Acme"');
    expect(request.context).toContain("Notes: 3");
    expect(request.context).toContain("Databases: 1");
    expect(request.context).toContain("Tickets: 2 (1 open, 2 points remaining)");
    expect(request.context).toContain("Next milestone: M2 (Apollo) due 2026-03-01");
    expect(request.intel.activity).toContain("Read the workspace overview");
  });

  it("answers 'my last message' from the recent-messages block", async () => {
    seedWorkspace();
    mocks.commentFindMany.mockResolvedValue([
      {
        body: "Ping about the launch",
        createdAt: new Date("2026-05-01T10:00:00.000Z"),
        author: { name: "Ada" },
        page: { id: "p1", title: "Launch plan" },
      },
    ]);

    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "what is my last message?",
    });

    expect(request.intel.intents).toContain("messages");
    expect(request.context).toContain("RECENT MESSAGES (newest first):");
    expect(request.context).toContain('comment on "Launch plan" by Ada');
    expect(request.context).toContain("Ping about the launch");
  });

  it("says so explicitly when there are no messages", async () => {
    seedWorkspace();
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "show me the latest comments",
    });
    expect(request.context).toContain("RECENT MESSAGES: none");
  });
});

/* -------------------------------------------------- buildChatRequest */

describe("buildChatRequest grounding", () => {
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

  it("grounds a members question in the roster and keeps the rest of the snapshot", async () => {
    seedWorkspace({
      owner: { name: "Ada", email: "ada@x.test" },
      members: [{ role: "ADMIN", user: { name: "Bob", email: "bob@x.test" } }],
      invites: [{ email: "new@x.test", role: "MEMBER" }],
    });
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "who are the members of my team?",
    });

    expect(mocks.workspaceFindUnique).toHaveBeenCalled();
    expect(
      mocks.workspaceFindUnique.mock.calls.some(
        (call) => "members" in ((call[0] as { select?: object }).select ?? {}),
      ),
    ).toBe(true);
    expect(request.context).toContain("Workspace members (2): Ada (ada@x.test, owner)");
    expect(request.context).toContain("Bob (bob@x.test, admin)");
    expect(request.context).toContain("Pending invitations: new@x.test (member)");
    expect(request.intel.activity).toContain("Checked members");
    // No tickets/projects were seeded, so those blocks stay absent — but the
    // retrieval is always attempted (no keyword gate decides whether it runs).
    expect(request.context).not.toContain("Tickets (");
    expect(request.context).not.toContain("Apollo");
    expect(mocks.searchPagesForPrompt).toHaveBeenCalled();
    expect(mocks.pageFindUnique).not.toHaveBeenCalled();
  });

  it("grounds a tickets question in the ticket list", async () => {
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

    expect(mocks.ticketFindMany).toHaveBeenCalled();
    expect(request.context).toContain("Tickets (1, 1 open · 3 points remaining):");
    expect(request.context).toContain("- ENG-1 [open, high] @Ada · 3 points · bug — Fix login");
    expect(request.intel.activity).toContain("Reviewed tickets");
    expect(request.context).not.toContain("Workspace members (");
    expect(request.context).not.toContain("Apollo");
    expect(mocks.searchPagesForPrompt).toHaveBeenCalled();
  });

  it("grounds a projects question in the project/milestone list", async () => {
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

    expect(mocks.projectFindMany).toHaveBeenCalled();
    expect(request.context).toContain(
      "- Apollo (active), due 2026-03-01, 1/2 milestones, next: M2 (2026-03-01), 4 notes",
    );
    expect(request.intel.activity).toContain("Reviewed projects");
    expect(request.context).not.toContain("Tickets (");
    expect(request.context).not.toContain("Workspace members (");
    expect(mocks.searchPagesForPrompt).toHaveBeenCalled();
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
    expect(request.context).not.toContain("Tickets (ENG-");
    expect(request.context).not.toContain("Workspace members (");
    expect(request.context).not.toContain("Apollo");
  });

  it("opens the pinned note and lists only its unchecked tasks", async () => {
    seedPages([
      {
        id: "p1",
        title: "Sprint notes",
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
      },
    ]);
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: "p1",
      question: "any unfinished checklist items?",
    });

    expect(request.context).toContain("CURRENT PAGE — the user has this open on screen right now");
    expect(request.context).toContain('- Title: "Sprint notes"');
    // The page's own text is in the excerpt (so a checked item may legitimately
    // appear there); the task SUMMARY must list only the unchecked one.
    expect(request.context).toContain('Open tasks in this page: "Ship the report"');
    expect(request.context).not.toContain('"Done thing"');
    expect(request.intel.activity).toContain("Read the current page");
    expect(mocks.searchPagesForPrompt).toHaveBeenCalled();
    expect(request.context).not.toContain("Tickets (");
  });

  it("opens the pinned note without the task panel when every task is checked", async () => {
    seedPages([
      {
        id: "p1",
        title: "Weekly review",
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
      },
    ]);
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: "p1",
      question: "any unfinished checklist items?",
    });

    expect(request.context).toContain("CURRENT PAGE — the user has this open on screen right now");
    expect(request.context).toContain('- Title: "Weekly review"');
    expect(request.context).not.toContain("Open tasks in this page");
    expect(request.intel.activity).toContain("Read the current page");
  });

  it("uses the default question for empty input and still grounds it", async () => {
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "",
    });

    expect(request.user).toBe("Summarize this note and suggest next steps.");
    expect(request.system).toBe(CHAT_SYSTEM_PROMPT);
    expect(request.intel.intents).toEqual(["notes"]);
    expect(mocks.searchPagesForPrompt).toHaveBeenCalledWith("ws1", "", 5);
    // No page and no data at all — but the "no messages" line is always there so
    // the model is never told "no context" and can answer that nothing exists.
    expect(request.context).toContain("RECENT MESSAGES: none");
    expect(request.intel.references).toEqual([]);
  });

  it("still provides context when a branch finds nothing", async () => {
    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "find my notes about onboarding",
    });

    expect(request.intel.intents).toEqual(["notes"]);
    expect(request.context).toContain("RECENT MESSAGES: none");
    expect(request.intel.activity).toEqual(["Read recent messages"]);
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

/* ---------------------------------------------------- the open page */

describe("the page you are looking at is grounded", () => {
  it("answers 'what page am I in?' from the OPEN page, not the workspace counts", async () => {
    // This is the exact question that used to get a workspace-counts answer.
    // The workspace itself has to exist for the overview block to be built at all.
    seedWorkspace({ name: "Demo Workspace" });
    seedPages([{ id: "p9", title: "Editor tips", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Use /slash commands to insert blocks." }] }] } }]);

    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      activePageId: "p9",
      question: "what is this page that I'm in??",
    });

    expect(request.context).toBeDefined();
    const pageIndex = request.context!.indexOf("CURRENT PAGE");
    const overviewIndex = request.context!.indexOf("WORKSPACE OVERVIEW");
    // The page comes first: it is the most pertinent context for the question.
    expect(pageIndex).toBeGreaterThanOrEqual(0);
    expect(overviewIndex).toBeGreaterThan(pageIndex);
    expect(request.context).toContain('- Title: "Editor tips"');
    expect(request.context).toContain("- Type: note (a document)");
    expect(request.context).toContain("Use /slash commands to insert blocks.");
    expect(request.intel.intents).toContain("page");
    expect(request.intel.activity).toContain("Read the current page");
    expect(request.system).toContain("CURRENT PAGE");
  });

  it("builds a breadcrumb and lists sub-pages", async () => {
    seedPages([
      { id: "root", title: "Demo Workspace" },
      { id: "mid", title: "Getting started", parentId: "root" },
      { id: "leaf", title: "Editor tips", parentId: "mid" },
    ]);
    seedChildren([{ title: "Shortcuts" }, { title: "Markdown" }]);

    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      activePageId: "leaf",
      question: "describe this page",
    });

    expect(request.context).toContain("- Path: Demo Workspace / Getting started / Editor tips");
    expect(request.context).toContain('- Sub-pages (2 shown): "Shortcuts", "Markdown"');
  });

  it("describes a database page by its properties and rows", async () => {
    seedPages([{ id: "db1", title: "Tickets", type: "DATABASE" }]);
    seedChildren([{ title: "Fix login" }, { title: "Slow search" }, { title: "Docs pass" }]);
    mocks.propertyFindMany.mockResolvedValue([
      { name: "Status", type: "STATUS" },
      { name: "Owner", type: "PERSON" },
    ]);

    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      activePageId: "db1",
      question: "what is this page?",
    });

    expect(request.context).toContain("- Type: database (3 rows)");
    expect(request.context).toContain("- Properties: Status (STATUS), Owner (PERSON)");
    expect(request.context).toContain('- Rows (3 shown): "Fix login", "Slow search", "Docs pass"');
  });

  it("ignores a page id that belongs to another workspace", async () => {
    // Scoping is the security property: the client supplies this id.
    seedPages([{ id: "foreign", title: "Private notes", workspaceId: "ws-other" }]);

    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      activePageId: "foreign",
      question: "what page am I in?",
    });

    expect(request.context ?? "").not.toContain("Private notes");
    expect(request.context ?? "").not.toContain("CURRENT PAGE");
  });

  it("includes the pinned page as well when it differs from the open one", async () => {
    seedPages([
      { id: "open", title: "Open page" },
      { id: "pinned", title: "Pinned page" },
    ]);

    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: "pinned",
      activePageId: "open",
      question: "what is this page?",
    });

    expect(request.context).toContain("CURRENT PAGE");
    expect(request.context).toContain('- Title: "Open page"');
    expect(request.context).toContain("PINNED NOTE");
    expect(request.context).toContain('- Title: "Pinned page"');
  });

  it("does not duplicate the page when the pin and the open page are the same", async () => {
    seedPages([{ id: "p1", title: "Same page" }]);

    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: "p1",
      activePageId: "p1",
      question: "what is this page?",
    });

    expect(request.context).toContain("CURRENT PAGE");
    expect(request.context).not.toContain("PINNED NOTE");
  });

  it("lists databases with their rows whenever a database exists", async () => {
    seedDatabases([
      {
        id: "db1",
        title: "Tickets",
        rows: 1,
        properties: [{ name: "Status", type: "STATUS" }],
      },
    ]);
    seedDatabaseRows([
      { id: "r1", title: "Fix login", parentId: "db1", values: [{ name: "Status", value: "In progress" }] },
    ]);

    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "which databases do I have and what properties does the tickets table have?",
    });

    expect(request.intel.intents).toContain("databases");
    expect(request.context).toContain("DATABASES — every database and its rows (1):");
    expect(request.context).toContain('- "Tickets" — 1 row · properties: Status (STATUS)');
    expect(request.context).toContain('  - "Fix login" · Status: In progress');
    expect(request.intel.activity).toContain("Read the databases");
  });
});

/* ---------------------------------------------------- fitBlocks trimming */

describe("fitBlocks — priority trimming", () => {
  it("keeps every block in priority order when they all fit", () => {
    expect(fitBlocks(["first", "second", "third"], 1000)).toBe("first\n\nsecond\n\nthird");
  });

  it("truncates the block that only partly fits instead of dropping it", () => {
    const result = fitBlocks(["short", "x".repeat(500)], 100);
    expect(result.startsWith("short\n\n")).toBe(true);
    expect(result).toContain("… (context truncated)");
    expect(result).toContain("xxx");
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.length).toBeGreaterThan("short".length);
  });

  it("never exceeds the budget", () => {
    const blocks = Array.from({ length: 20 }, (_, index) => `block-${index}-${"y".repeat(50)}`);
    for (const budget of [0, 1, 10, 100, 333, 1000, 10_000]) {
      expect(fitBlocks(blocks, budget).length).toBeLessThanOrEqual(budget);
    }
  });

  it("drops the lowest-priority blocks when the budget runs out", () => {
    const result = fitBlocks(
      ["alpha".repeat(10), "beta".repeat(10), "gamma".repeat(10)],
      95,
    );
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).not.toContain("gamma");
  });

  it("ignores empty blocks and non-block input", () => {
    expect(fitBlocks(["", "a", ""], 100)).toBe("a");
    expect(fitBlocks([], 100)).toBe("");
  });

  it("returns an empty string for a non-positive or invalid budget", () => {
    expect(fitBlocks(["a"], 0)).toBe("");
    expect(fitBlocks(["a"], -5)).toBe("");
    expect(fitBlocks(["a"], Number.NaN)).toBe("");
  });
});

/* ------------------------------------------------ context budget override */

describe("context budget is configurable", () => {
  it("defaults to DEFAULT_CONTEXT_CHARS and rejects invalid env values", () => {
    expect(resolveContextBudget({})).toBe(DEFAULT_CONTEXT_CHARS);
    expect(resolveContextBudget({ NOEMA_CHAT_CONTEXT_CHARS: "" })).toBe(DEFAULT_CONTEXT_CHARS);
    expect(resolveContextBudget({ NOEMA_CHAT_CONTEXT_CHARS: "0" })).toBe(DEFAULT_CONTEXT_CHARS);
    expect(resolveContextBudget({ NOEMA_CHAT_CONTEXT_CHARS: "-5" })).toBe(DEFAULT_CONTEXT_CHARS);
    expect(resolveContextBudget({ NOEMA_CHAT_CONTEXT_CHARS: "abc" })).toBe(DEFAULT_CONTEXT_CHARS);
    expect(resolveContextBudget({ NOEMA_CHAT_CONTEXT_CHARS: "12.5" })).toBe(DEFAULT_CONTEXT_CHARS);
    expect(resolveContextBudget({ NOEMA_CHAT_CONTEXT_CHARS: "1234" })).toBe(1234);
  });

  it("honours NOEMA_CHAT_CONTEXT_CHARS when assembling the context", async () => {
    const previous = process.env.NOEMA_CHAT_CONTEXT_CHARS;
    process.env.NOEMA_CHAT_CONTEXT_CHARS = "600";
    try {
      seedWorkspace();
      seedIndex(
        Array.from({ length: 40 }, (_, index) => ({
          id: `p${index}`,
          title: `Page number ${index} with a fairly long title`,
        })),
      );
      seedOverviewCounts({ notes: 40, total: 40 });

      const request = await buildChatRequest({
        workspaceId: "ws1",
        pageId: null,
        question: "hello there",
      });

      expect(request.context).toBeDefined();
      expect(request.context!.length).toBeLessThanOrEqual(600);
      expect(request.context).toContain("… (context truncated)");
    } finally {
      if (previous === undefined) delete process.env.NOEMA_CHAT_CONTEXT_CHARS;
      else process.env.NOEMA_CHAT_CONTEXT_CHARS = previous;
    }
  });
});

/* ---------------------------------------------------- references bounding */

describe("references are complete but bounded", () => {
  it("deduplicates by id and caps the list", async () => {
    seedWorkspace();
    seedIndex(
      Array.from({ length: 120 }, (_, index) => ({ id: `p${index}`, title: `Page ${index}` })),
    );
    seedOverviewCounts({ notes: 120, total: 120 });

    const request = await buildChatRequest({
      workspaceId: "ws1",
      pageId: null,
      question: "list my pages",
    });

    const ids = request.intel.references.map((reference) => reference.id);
    expect(ids.length).toBeLessThanOrEqual(60);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
