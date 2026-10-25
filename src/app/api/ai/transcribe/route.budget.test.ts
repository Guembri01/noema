import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R25.13 — transcription runs through the same workspace guard and meter.
 *
 * Audio has no provider-reported tokens, so the guard uses a zero estimate
 * (refusing only a workspace that is already over its ceiling) and the
 * transcript is recorded with the documented `chars / 4` estimate. The access
 * check runs before the budget query, so a foreign workspace id cannot read or
 * write another tenant's counters.
 */

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const guard = vi.hoisted(() => ({ rateLimit: vi.fn() }));
const permissions = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));

const db = vi.hoisted(() => {
  const budgets = new Map<
    string,
    { monthlyTokenLimit: number; warnPercent: number; hardStop: boolean }
  >();
  const usage: {
    workspaceId: string;
    period: string;
    surface: string;
    tokensIn: number;
    tokensOut: number;
    requests: number;
    failures: number;
  }[] = [];

  const prisma = {
    aiBudget: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId: string } }) => {
        return budgets.get(where.workspaceId) ?? null;
      }),
    },
    aiUsage: {
      aggregate: vi.fn(
        async ({ where }: { where: { workspaceId: string; period: string } }) => {
          const rows = usage.filter(
            (row) => row.workspaceId === where.workspaceId && row.period === where.period,
          );
          return {
            _sum: {
              tokensIn: rows.reduce((sum, row) => sum + row.tokensIn, 0),
              tokensOut: rows.reduce((sum, row) => sum + row.tokensOut, 0),
              requests: rows.reduce((sum, row) => sum + row.requests, 0),
            },
          };
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: {
            workspaceId_period_surface: {
              workspaceId: string;
              period: string;
              surface: string;
            };
          };
          create: (typeof usage)[number];
          update: {
            tokensIn?: { increment: number };
            tokensOut?: { increment: number };
            requests?: { increment: number };
            failures?: { increment: number };
          };
        }) => {
          const key = where.workspaceId_period_surface;
          let row = usage.find(
            (entry) =>
              entry.workspaceId === key.workspaceId &&
              entry.period === key.period &&
              entry.surface === key.surface,
          );
          if (!row) {
            row = { ...create };
            usage.push(row);
            return row;
          }
          row.tokensIn += update.tokensIn?.increment ?? 0;
          row.tokensOut += update.tokensOut?.increment ?? 0;
          row.requests += update.requests?.increment ?? 0;
          row.failures += update.failures?.increment ?? 0;
          return row;
        },
      ),
    },
  };

  return { budgets, usage, prisma };
});

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));
vi.mock("@/lib/api-guard", () => ({ rateLimit: guard.rateLimit }));
vi.mock("@/lib/permissions", () => ({ getWorkspaceAccess: permissions.getWorkspaceAccess }));

const WORKSPACE = "clx1a2b3c4d5e6f7g8h9i0jkl";

async function loadPost() {
  vi.resetModules();
  vi.stubEnv("AI_TRANSCRIBE_API_KEY", "sk-transcribe-test");
  vi.stubEnv("AI_TRANSCRIBE_BASE_URL", "http://localhost:1/v1");
  const mod = await import("./route");
  return mod.POST;
}

function transcriptionRequest(workspaceId = WORKSPACE): Request {
  const form = new FormData();
  form.append("workspaceId", workspaceId);
  form.append("file", new File([new Uint8Array([1, 2, 3])], "clip.wav", { type: "audio/wav" }));
  return new Request("http://test/api/ai/transcribe", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.budgets.clear();
  db.usage.length = 0;
  auth.getCurrentUser.mockResolvedValue({ id: "u1" });
  guard.rateLimit.mockReturnValue(null);
  permissions.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
});

describe("transcription budget guard", () => {
  it("refuses an already-over workspace before calling the provider", async () => {
    db.budgets.set(WORKSPACE, { monthlyTokenLimit: 100, warnPercent: 80, hardStop: true });
    // One seed counter at 101 tokens: over the 100-token ceiling.
    db.usage.push({
      workspaceId: WORKSPACE,
      period: new Date().toISOString().slice(0, 7),
      surface: "chat",
      tokensIn: 101,
      tokensOut: 0,
      requests: 1,
      failures: 0,
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "unused" })));
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadPost();
    const response = await POST(transcriptionRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "AI_BUDGET_EXCEEDED" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.usage.filter((row) => row.surface === "transcribe")).toHaveLength(0);
  });

  it("refuses a workspace the caller cannot access before querying its budget", async () => {
    permissions.getWorkspaceAccess.mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadPost();
    const response = await POST(transcriptionRequest());

    expect(response.status).toBe(403);
    expect(db.prisma.aiBudget.findUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records the transcript's estimated tokens under the transcribe surface", async () => {
    db.budgets.set(WORKSPACE, { monthlyTokenLimit: 1000, warnPercent: 80, hardStop: true });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "hello world" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadPost();
    const response = await POST(transcriptionRequest());
    const body = (await response.json()) as { text: string; usage?: { outputTokens: number } };

    expect(response.status).toBe(200);
    expect(body.text).toBe("hello world");
    // ceil(11 / 4) = 3
    expect(body.usage?.outputTokens).toBe(3);
    expect(db.usage).toHaveLength(1);
    expect(db.usage[0]).toMatchObject({
      workspaceId: WORKSPACE,
      surface: "transcribe",
      tokensIn: 0,
      tokensOut: 3,
      requests: 1,
      failures: 0,
    });
  });
});
