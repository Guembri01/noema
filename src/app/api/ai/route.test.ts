import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B87 — the AI grounding search must respect the guest page scope.
 *
 * The attack: a `GUEST` posts a prompt to `POST /api/ai` in the mode "ask".
 * The route grounds the answer in a workspace-wide page search, so the model
 * context carries the titles and the text of pages the guest was never shared
 * with.
 *
 * Only the transport edges are mocked — auth, rate limiting, workspace access
 * and the provider client. The scope helper (`pageScopeFor` →
 * `guestVisiblePageIds`), the grounding query and the response shaping run for
 * real against an in-memory database that honours the `where` clause, so the
 * leak is observed exactly where it happens: in the context handed to the
 * model.
 */

type Row = Record<string, unknown>;
type FindManyArgs = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown>;
  take?: number;
  select?: Record<string, unknown>;
};
type ChatInput = {
  system: string;
  user?: string;
  context?: string;
  temperature?: number;
  maxTokens?: number;
};

const db = vi.hoisted(() => {
  const doc = (text: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

  const time = (value: unknown): number => (value instanceof Date ? value.getTime() : 0);

  /** Two pages of the same workspace: one shared with the guest, one not. */
  const pages: Row[] = [
    {
      id: "page-visible",
      workspaceId: "ws1",
      parentId: null,
      teamspaceId: null,
      title: "Revenue plan (shared)",
      icon: ":book:",
      type: "PAGE",
      content: doc("The revenue plan grows by 20% next quarter."),
      deletedAt: null,
      createdById: "owner1",
      updatedAt: new Date("2026-02-02T00:00:00.000Z"),
    },
    {
      id: "page-hidden",
      workspaceId: "ws1",
      parentId: null,
      teamspaceId: null,
      title: "Revenue plan (confidential)",
      icon: ":lock:",
      type: "PAGE",
      content: doc("The revenue plan grows by 40% next quarter. Salary bands are listed here."),
      deletedAt: null,
      createdById: "owner1",
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    },
  ];

  /** The guest may read `page-visible` — and nothing else. */
  let permissions: Row[] = [{ userId: "guest1", pageId: "page-visible" }];

  const pageFindMany = vi.fn((args: FindManyArgs = {}): Row[] => {
    const where = args.where ?? {};
    let rows = pages.slice();
    if (typeof where.workspaceId === "string") {
      rows = rows.filter((row) => row.workspaceId === where.workspaceId);
    }
    if (where.deletedAt === null) {
      rows = rows.filter((row) => row.deletedAt === null);
    }
    if (typeof where.createdById === "string") {
      rows = rows.filter((row) => row.createdById === where.createdById);
    }
    const idFilter = where.id;
    if (idFilter && typeof idFilter === "object" && "in" in idFilter) {
      const allowed = new Set((idFilter as { in: string[] }).in);
      rows = rows.filter((row) => allowed.has(String(row.id)));
    }
    rows.sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
    return typeof args.take === "number" ? rows.slice(0, args.take) : rows;
  });

  const pagePermissionFindMany = vi.fn((args: FindManyArgs = {}): Row[] => {
    const where = args.where ?? {};
    const scope = where.page as { workspaceId?: string } | undefined;
    return permissions.filter((row) => {
      if (where.userId !== undefined && row.userId !== where.userId) return false;
      if (scope?.workspaceId !== undefined) {
        const page = pages.find((candidate) => candidate.id === row.pageId);
        if (page?.workspaceId !== scope.workspaceId) return false;
      }
      return true;
    });
  });

  const teamspaceMemberFindMany = vi.fn((): Row[] => []);

  return {
    pageFindMany,
    pagePermissionFindMany,
    teamspaceMemberFindMany,
    /** The pages the guest has been given access to. */
    setPermissions(rows: Row[]) {
      permissions = rows;
    },
  };
});

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn<() => Promise<{ id: string } | null>>() }));
const guard = vi.hoisted(() => ({ rateLimit: vi.fn<(...args: unknown[]) => Response | null>() }));
const permissions = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn<
    (userId: string, workspaceId: string) => Promise<{ role: string } | null>
  >(),
}));
const provider = vi.hoisted(() => ({
  resolveAiConfigForUser: vi.fn(),
  resolveAiConfig: vi.fn<(workspaceId?: string | null) => Promise<unknown>>(),
  chatComplete: vi.fn<(input: ChatInput, config: unknown) => Promise<unknown>>(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findMany: db.pageFindMany },
    pagePermission: { findMany: db.pagePermissionFindMany },
    teamspaceMember: { findMany: db.teamspaceMemberFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));
vi.mock("@/lib/api-guard", () => ({ rateLimit: guard.rateLimit }));
vi.mock("@/lib/permissions", () => ({ getWorkspaceAccess: permissions.getWorkspaceAccess }));
vi.mock("@/lib/ai-provider", () => ({
  AI_NOT_CONFIGURED: "AI is not configured.",
  chatComplete: provider.chatComplete,
  resolveAiConfig: provider.resolveAiConfig,
  // The route resolves the provider through the workspace-scoped helper
  // (B13); the mock has to offer it, or the route gets a function that is
  // not there.
  resolveAiConfigForUser: provider.resolveAiConfigForUser,
}));

import { POST } from "./route";

const CONFIG = {
  provider: "mock",
  baseUrl: "http://localhost:1/v1",
  model: "m",
  apiKey: "k",
  source: "env" as const,
};

const ask = (body: unknown) =>
  POST(
    new Request("http://test/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** The context the model was handed — the exact surface the leak flows through. */
const grounding = (): string => provider.chatComplete.mock.calls[0]?.[0]?.context ?? "";

/** The query the grounding search ran (the one that reads page content). */
const groundingQuery = (): FindManyArgs | undefined =>
  db.pageFindMany.mock.calls.map((call) => call[0]).find((args) => args?.select?.content);

beforeEach(() => {
  vi.clearAllMocks();
  db.setPermissions([{ userId: "guest1", pageId: "page-visible" }]);
  auth.getCurrentUser.mockResolvedValue({ id: "guest1" });
  guard.rateLimit.mockReturnValue(null);
  permissions.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  provider.resolveAiConfig.mockResolvedValue(CONFIG);
  // The route resolves the provider through the workspace-scoped helper.
  provider.resolveAiConfigForUser.mockResolvedValue(CONFIG);
  provider.chatComplete.mockResolvedValue({ ok: true, text: "MODEL OUTPUT" });
});

describe("the AI grounding respects the guest page scope", () => {
  it("grounds a guest's answer in the shared page, never in the hidden one", async () => {
    const response = await ask({
      mode: "ask",
      workspaceId: "ws1",
      prompt: "What is the revenue plan?",
    });

    expect(response.status).toBe(200);
    const context = grounding();
    expect(context).toContain("Revenue plan (shared)");
    expect(context).not.toContain("confidential");
    expect(context).not.toContain("Salary bands");
  });

  it("scopes the grounding query itself, so hidden pages never enter the window", async () => {
    await ask({ mode: "ask", workspaceId: "ws1", prompt: "What is the revenue plan?" });

    expect(groundingQuery()?.where).toMatchObject({ id: { in: ["page-visible"] } });
  });

  it("grounds a guest in nothing when no page was shared with them", async () => {
    db.setPermissions([]);

    const response = await ask({
      mode: "ask",
      workspaceId: "ws1",
      prompt: "What is the revenue plan?",
    });

    expect(response.status).toBe(200);
    expect(grounding()).toBe("");
    // An empty scope filters the query down to nothing — it never widens it.
    expect(groundingQuery()?.where).toMatchObject({ id: { in: [] } });
  });

  it("never grounds a guest's answer in a page they were not given", async () => {
    const response = await ask({
      mode: "ask",
      workspaceId: "ws1",
      prompt: "What are the salary bands?",
    });

    expect(response.status).toBe(200);
    expect(grounding()).toBe("");
  });

  it("grounds a member in the whole workspace", async () => {
    permissions.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const response = await ask({
      mode: "ask",
      workspaceId: "ws1",
      prompt: "What is the revenue plan?",
    });

    expect(response.status).toBe(200);
    const context = grounding();
    expect(context).toContain("Revenue plan (shared)");
    expect(context).toContain("confidential");
  });

  it("grounds nobody when the caller is not a workspace member", async () => {
    permissions.getWorkspaceAccess.mockResolvedValue(null);

    const response = await ask({
      mode: "ask",
      workspaceId: "ws1",
      prompt: "What is the revenue plan?",
    });

    expect(response.status).toBe(200);
    expect(grounding()).toBe("");
  });
});
