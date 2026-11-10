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

// The short-code resolver (P1-T02) redirects to the canonical token URL; the
// router-less render surfaces that as a thrown sentinel carrying the target.
const navigation = vi.hoisted(() => ({
  redirect: (url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/navigation", () => navigation);

const db = vi.hoisted(() => ({
  shareLinkFindUnique: vi.fn(),
  shareLinkFindFirst: vi.fn(),
  pageFindUnique: vi.fn(),
  propertyFindMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    shareLink: { findUnique: db.shareLinkFindUnique, findFirst: db.shareLinkFindFirst },
    page: { findUnique: db.pageFindUnique },
    property: { findMany: db.propertyFindMany },
  },
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

// The public form wrapper is a client component that imports a server action;
// the route test only needs to prove the page picked the form branch and passed
// the resolved properties/config through.
vi.mock("@/components/database/public-form", async () => {
  const { createElement: h } = await import("react");
  return {
    PublicForm: ({
      token,
      properties,
      config,
    }: {
      token: string;
      properties: unknown[];
      config?: unknown;
    }) =>
      h(
        "div",
        { "data-testid": "public-form" },
        `${token}:${properties.length}:${JSON.stringify(config)}`,
      ),
  };
});

import PublicSharedPage, { generateMetadata } from "./page";
import { createShareUnlockToken, shareUnlockCookieName } from "@/lib/secrets";
import { generateShortCode } from "@/lib/short-link";

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

const formLink = (overrides: Record<string, unknown> = {}) => {
  const base = link(null, "Requests database");
  return {
    ...base,
    page: { ...base.page, id: "db-1", type: "DATABASE" },
    view: {
      id: "view-1",
      type: "FORM",
      name: "Requests",
      databasePageId: "db-1",
      config: {
        form: {
          id: "view-1",
          databaseId: "db-1",
          title: "Requests",
          accepting: true,
          fields: [{ propertyId: "title", label: "Name", type: "TEXT" }],
        },
      },
    },
    ...overrides,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  jar.clear();
  process.env.AUTH_SECRET = "test-secret-for-share-page-tests";
  auth.getCurrentUser.mockResolvedValue(null);
  db.shareLinkFindUnique.mockResolvedValue(link("$2a$12$notarealhashnotarealhashnotareal"));
  db.shareLinkFindFirst.mockResolvedValue(null);
  db.pageFindUnique.mockResolvedValue(null);
  db.propertyFindMany.mockResolvedValue([
    { id: "title", name: "Name", type: "TEXT", config: { primary: true } },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  // B31: in production the unlock cookie carries the `__Host-` prefix. The
  // reader has to ask for the very same name, or the page would ask for the
  // password again although the visitor unlocked the link.
  it("opens the page for the host-bound unlock cookie in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
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

/**
 * B36 — the metadata must not disclose the title before the password check.
 *
 * `generateMetadata` read the link without `passwordHash` and `expiresAt`, so
 * the page's own title went into the `<title>` tag and into the Open Graph
 * metadata of the *password prompt* — the title of a page the reader may not
 * see yet, handed to anyone who knows the link. The metadata now applies the
 * same state check the body makes: a locked, expired or deleted page stays
 * anonymous, an open (or unlocked) page may name itself.
 */
describe("the share page metadata (B36)", () => {
  const metadata = async () =>
    generateMetadata({ params: Promise.resolve({ token: TOKEN }) });

  it("does not disclose the title of a password-protected page", async () => {
    const meta = await metadata();

    expect(meta.title).toBe("Shared page");
    expect(meta.title).not.toBe("Locked page");
  });

  it("does not disclose the title for a forged unlock cookie", async () => {
    jar.set(shareUnlockCookieName(TOKEN), "1");

    const meta = await metadata();

    expect(meta.title).toBe("Shared page");
  });

  it("discloses the title once the link is unlocked", async () => {
    jar.set(shareUnlockCookieName(TOKEN), createShareUnlockToken(TOKEN));

    const meta = await metadata();

    expect(meta.title).toBe("Locked page");
  });

  it("discloses the title of a link that has no password", async () => {
    db.shareLinkFindUnique.mockResolvedValue(link(null, "Open page"));

    const meta = await metadata();

    expect(meta.title).toBe("Open page");
  });

  it("does not disclose the title of an expired link", async () => {
    db.shareLinkFindUnique.mockResolvedValue({
      ...link(null, "Expired page"),
      expiresAt: new Date(Date.now() - 60_000),
    });

    const meta = await metadata();

    expect(meta.title).toBe("Shared page");
  });

  it("does not disclose the title of a deleted page", async () => {
    db.shareLinkFindUnique.mockResolvedValue({
      ...link(null, "Deleted page"),
      page: { ...page("Deleted page"), deletedAt: new Date() },
    });

    const meta = await metadata();

    expect(meta.title).toBe("Shared page");
  });

  it("does not disclose anything for an unknown link", async () => {
    db.shareLinkFindUnique.mockResolvedValue(null);

    const meta = await metadata();

    expect(meta.title).toBe("Shared page");
  });

  it("keeps the publisher's indexing choice", async () => {
    db.shareLinkFindUnique.mockResolvedValue({ ...link(null, "Open page"), indexing: false });

    const meta = await metadata();

    expect(meta.title).toBe("Open page");
    expect(meta.robots).toEqual({ index: false, follow: false });
  });
});

describe("the public form route (R89.29 / O89.1)", () => {
  it("renders the form branch with live properties for a FORM view", async () => {
    db.shareLinkFindUnique.mockResolvedValue(formLink());

    const html = await render();

    expect(html).toContain('data-testid="public-form"');
    expect(html).toContain(TOKEN);
    expect(html).toContain("Requests");
    expect(html).not.toContain(MARKER);
    expect(db.propertyFindMany).toHaveBeenCalledWith({
      where: { databasePageId: "db-1" },
      orderBy: { position: "asc" },
      select: { id: true, name: true, type: true, config: true },
    });
  });

  it("rejects a non-FORM view even with a valid token", async () => {
    db.shareLinkFindUnique.mockResolvedValue(
      formLink({ view: { ...formLink().view, type: "TABLE" } }),
    );

    expect(await render()).toContain("This link is no longer available");
  });

  it("rejects a FORM view whose database page is not the shared page", async () => {
    db.shareLinkFindUnique.mockResolvedValue(
      formLink({ view: { ...formLink().view, databasePageId: "db-2" } }),
    );

    expect(await render()).toContain("This link is no longer available");
  });

  it("uses the form name in metadata and always noindexes the link", async () => {
    db.shareLinkFindUnique.mockResolvedValue(formLink());

    const meta = await generateMetadata({ params: Promise.resolve({ token: TOKEN }) });

    expect(meta.title).toBe("Requests");
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it("keeps a password-protected form behind the unlock prompt", async () => {
    db.shareLinkFindUnique.mockResolvedValue(
      formLink({ passwordHash: "$2a$12$notarealhashnotarealhashnotareal" }),
    );

    const html = await render();

    expect(html).toContain("Password required");
    expect(html).not.toContain('data-testid="public-form"');
  });
});

/**
 * P1-T02 — the share dialog advertises `https://host/s/<code>` where `<code>`
 * is the deterministic `generateShortCode({ seed: pageId })`, but the only
 * resolver matched full random tokens, so every copied short link landed on
 * "no longer available". The resolver branch consults the unique, indexed
 * `Page.shortCode` alias, re-derives the code to guard a stale row, then
 * redirects to the page's LIVE published page-level token. Everything else —
 * unpublished, expired, deleted, unclaimed — fails closed.
 */
describe("the short-code resolver (P1-T02)", () => {
  const CODE = generateShortCode({ seed: "page-1" });
  const LIVE_TOKEN = "live-share-token";

  const renderShortCode = async (token: string = CODE) => {
    try {
      return {
        kind: "rendered" as const,
        html: await renderToStaticMarkup(
          await PublicSharedPage({
            params: Promise.resolve({ token }),
            searchParams: Promise.resolve({}),
          }),
        ),
      };
    } catch (thrown) {
      return { kind: "redirect" as const, target: String((thrown as never as Error).message) };
    }
  };

  it("redirects a short code to the page's live published page-level token", async () => {
    db.shareLinkFindUnique.mockResolvedValue(null);
    db.pageFindUnique.mockResolvedValue({ id: "page-1" });
    db.shareLinkFindFirst.mockResolvedValue({ token: LIVE_TOKEN });

    await expect(renderShortCode()).resolves.toEqual({
      kind: "redirect",
      target: `NEXT_REDIRECT:/s/${LIVE_TOKEN}`,
    });
  });

  it("resolves through the indexed alias — never a scan — and only for a live link", async () => {
    db.shareLinkFindUnique.mockResolvedValue(null);
    db.pageFindUnique.mockResolvedValue({ id: "page-1" });
    db.shareLinkFindFirst.mockResolvedValue({ token: LIVE_TOKEN });

    await renderShortCode();

    expect(db.pageFindUnique).toHaveBeenCalledWith({
      where: { shortCode: CODE },
      select: { id: true },
    });
    expect(db.shareLinkFindFirst).toHaveBeenCalledWith({
      where: {
        pageId: "page-1",
        viewId: null,
        page: { deletedAt: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      select: { token: true },
    });
  });

  it("fails closed for an unknown short code", async () => {
    db.shareLinkFindUnique.mockResolvedValue(null);
    db.pageFindUnique.mockResolvedValue(null);

    const outcome = await renderShortCode();

    expect(outcome).toMatchObject({ kind: "rendered" });
    expect((outcome as { html: string }).html).toContain(
      "This link is no longer available",
    );
    expect(db.shareLinkFindFirst).not.toHaveBeenCalled();
  });

  it("fails closed when the page has no live published link (unpublished or expired)", async () => {
    db.shareLinkFindUnique.mockResolvedValue(null);
    db.pageFindUnique.mockResolvedValue({ id: "page-1" });
    db.shareLinkFindFirst.mockResolvedValue(null);

    const outcome = await renderShortCode();

    expect(outcome).toMatchObject({ kind: "rendered" });
    expect((outcome as { html: string }).html).toContain(
      "This link is no longer available",
    );
  });

  it("fails closed when the stored alias does not re-derive to the requested code", async () => {
    db.shareLinkFindUnique.mockResolvedValue(null);
    db.pageFindUnique.mockResolvedValue({ id: "page-2" });

    const outcome = await renderShortCode();

    expect(outcome).toMatchObject({ kind: "rendered" });
    expect((outcome as { html: string }).html).toContain(
      "This link is no longer available",
    );
    expect(db.shareLinkFindFirst).not.toHaveBeenCalled();
  });

  it("never enters the short-code branch for a real full token (miss included)", async () => {
    db.shareLinkFindUnique.mockResolvedValue(null);

    const outcome = await renderShortCode("another-share-token");

    expect(outcome).toMatchObject({ kind: "rendered" });
    expect((outcome as { html: string }).html).toContain(
      "This link is no longer available",
    );
    expect(db.pageFindUnique).not.toHaveBeenCalled();
  });

  it("keeps the direct path authoritative when a base62 token IS a real link", async () => {
    db.shareLinkFindUnique.mockResolvedValue(link(null, "Open page"));

    const outcome = await renderShortCode("abc123");

    expect(outcome).toMatchObject({ kind: "rendered" });
    expect((outcome as { html: string }).html).toContain(MARKER);
    expect(db.pageFindUnique).not.toHaveBeenCalled();
  });
});
