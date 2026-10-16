import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/lib/slack-blocks.ts` wiring through `notifyPageUpdated`.
 *
 * The repo has **no** Slack client — only generic outbound webhooks — so the
 * Slack integration renders the page-update notification as a Block Kit payload
 * with the module and posts it to a Slack incoming webhook (`hooks.slack.com`)
 * discovered on the workspace. Only the transport edges (prisma/auth/webhooks/
 * cache/fetch) are mocked; the payload itself is built by the real module, so
 * the assertions pin the wire shape Slack receives.
 */

const ORIGIN = "https://app.example.test";
const PREV_APP_URL = process.env.APP_URL;
const SLACK_URL = "https://hooks.slack.com/services/T000/B000/XXXX";
const OTHER_URL = "https://example.test/not-slack";

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFollowFindMany: vi.fn(),
  userFindMany: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationCreateMany: vi.fn(),
  webhookFindMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
}));

const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique },
    pageFollow: { findMany: db.pageFollowFindMany },
    user: { findMany: db.userFindMany },
    notification: {
      findMany: db.notificationFindMany,
      createMany: db.notificationCreateMany,
    },
    webhook: { findMany: db.webhookFindMany },
    workspace: { findUnique: db.workspaceFindUnique },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({
    id: "author",
    name: "Ada",
    email: "ada@example.test",
  })),
}));

vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { notifyPageUpdated } from "./notifications";

type FetchResult = { ok: boolean; status: number };

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<FetchResult>>(
  async () => ({ ok: true, status: 200 }),
);

function slackPosts(): { url: string; body: Record<string, unknown> }[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  process.env.APP_URL = ORIGIN;

  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  db.pageFindUnique.mockResolvedValue({
    id: "page-1",
    workspaceId: "ws-1",
    title: "Roadmap <v2>",
    deletedAt: null,
  });
  db.pageFollowFindMany.mockResolvedValue([{ userId: "f1" }]);
  db.userFindMany.mockResolvedValue([{ id: "f1", notificationPrefs: null }]);
  db.notificationFindMany.mockResolvedValue([]);
  db.notificationCreateMany.mockResolvedValue({ count: 1 });
  db.webhookFindMany.mockResolvedValue([{ url: SLACK_URL }, { url: OTHER_URL }]);
  db.workspaceFindUnique.mockResolvedValue({ slug: "acme" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (PREV_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = PREV_APP_URL;
});

describe("page-update Slack payload (slack-blocks)", () => {
  it("posts a validated Block Kit message to the Slack webhook only", async () => {
    await notifyPageUpdated("page-1");

    expect(db.notificationCreateMany).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const posts = slackPosts();
    expect(posts[0].url).toBe(SLACK_URL); // the non-Slack hook is untouched

    const { body } = posts[0];
    expect(body.text).toBe("Ada updated Roadmap <v2>");
    const blocks = body.blocks as {
      type: string;
      text?: { type: string; text: string };
      elements?: { type: string; url?: string }[];
    }[];
    expect(blocks.map((block) => block.type)).toEqual([
      "header",
      "section",
      "actions",
    ]);
    expect(blocks[0].text?.text).toBe("Page updated");
    // User text is escaped — the `<v2>` cannot become Slack markup.
    expect(blocks[1].text?.text).toContain("Roadmap &lt;v2&gt;");
    expect(blocks[1].text?.text).not.toContain("<v2>");
    // The button links back to the edited page's absolute URL.
    expect(blocks[2].elements?.[0]).toMatchObject({
      type: "button",
      url: `${ORIGIN}/w/acme/page-1`,
    });
  });

  it("does not post when the workspace has no Slack webhook", async () => {
    db.webhookFindMany.mockResolvedValue([{ url: OTHER_URL }]);
    await notifyPageUpdated("page-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not post without an absolute app origin (the button needs one)", async () => {
    delete process.env.APP_URL;
    await notifyPageUpdated("page-1");
    expect(db.webhookFindMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failing Slack post never breaks the notification dispatch", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(notifyPageUpdated("page-1")).resolves.toBeUndefined();
    expect(db.notificationCreateMany).toHaveBeenCalledTimes(1);
  });
});
