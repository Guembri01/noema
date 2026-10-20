import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * B01 — the public share page must not open on a forged unlock cookie.
 *
 * The vulnerability lived on the *read* side: the page only asked whether the
 * cookie `share_<token>` was present, so any client could send
 * `Cookie: share_<token>=1` and read a password-protected page. The unlock
 * state is now an HMAC over the share token and an expiry, and the page
 * verifies it before it renders anything.
 *
 * This suite renders the page exactly as the router would and asserts what it
 * shows: the password form (and *no* content) for every cookie that does not
 * verify for this share token, and the content only for one that does. The
 * forged `"1"` cookie is the regression case — without the fix it opens the
 * page and the first content assertion below fails.
 *
 * Only the edges are mocked: the Prisma read, the session lookup, the cookie
 * jar and the router-less `next/link`. The signing and the verification run
 * for real.
 */

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name) as string } : undefined,
  }),
}));

const db = vi.hoisted(() => ({ shareLinkFindUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { shareLink: { findUnique: db.shareLinkFindUnique } },
}));

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      h("a", { href, ...rest }, children as never),
  };
});

// The share dialog is a client component that pulls in server actions and the
// router; the public page only needs its button to exist.
vi.mock("@/components/share-dialog", () => ({
  CopyLinkButton: () => null,
}));

import PublicSharedPage from "./page";
import { createShareUnlockToken, shareUnlockCookieName } from "@/lib/secrets";

const TOKEN = "share-token-abc";
const OTHER_TOKEN = "another-share-token";
const MARKER = "PROTECTED-SHARE-CONTENT";
const ORIGINAL_SECRET = process.env.AUTH_SECRET;

const page = (title: string) => ({
  title,
  icon: null,
  coverUrl: null,
  content: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: MARKER }] },
    ],
  },
  deletedAt: null,
  type: "DOC",
});

const link = (passwordHash: string | null, title = "Locked page") => ({
  token: TOKEN,
  passwordHash,
  permission: "READ",
  indexing: true,
  expiresAt: null,
  page: page(title),
});

beforeEach(() => {
  vi.clearAllMocks();
  jar.clear();
  process.env.AUTH_SECRET = "test-secret-for-share-page-tests";
  auth.getCurrentUser.mockResolvedValue(null);
  db.shareLinkFindUnique.mockResolvedValue(link("$2a$12$notarealhashnotarealhashnotareal"));
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_SECRET;
});

const render = async () =>
  renderToStaticMarkup(
    await PublicSharedPage({
      params: Promise.resolve({ token: TOKEN }),
      searchParams: Promise.resolve({}),
    }),
  );

describe("the public share page (B01)", () => {
  it("asks for the password when no unlock cookie is sent", async () => {
    const html = await render();

    expect(html).toContain("Password required");
    expect(html).not.toContain(MARKER);
  });

  it("does NOT open the page for a forged `share_<token>=1` cookie", async () => {
    jar.set(shareUnlockCookieName(TOKEN), "1");

    const html = await render();

    expect(html).toContain("Password required");
    expect(html).not.toContain(MARKER);
  });

  it("does NOT open the page for a cookie minted for another share token", async () => {
    jar.set(shareUnlockCookieName(TOKEN), createShareUnlockToken(OTHER_TOKEN));

    const html = await render();

    expect(html).toContain("Password required");
    expect(html).not.toContain(MARKER);
  });

  it("does NOT open the page for an expired unlock cookie", async () => {
    jar.set(
      shareUnlockCookieName(TOKEN),
      createShareUnlockToken(TOKEN, { expiresAt: 1_000, now: 1_000 }),
    );

    const html = await render();

    expect(html).toContain("Password required");
    expect(html).not.toContain(MARKER);
  });

  it("opens the page for a valid, unexpired unlock cookie", async () => {
    jar.set(shareUnlockCookieName(TOKEN), createShareUnlockToken(TOKEN));

    const html = await render();

    expect(html).toContain(MARKER);
    expect(html).not.toContain("Password required");
  });

  it("opens a link that has no password without any cookie", async () => {
    db.shareLinkFindUnique.mockResolvedValue(link(null, "Open page"));

    const html = await render();

    expect(html).toContain(MARKER);
    expect(html).not.toContain("Password required");
  });
});
