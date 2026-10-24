import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PromptTemplate } from "@/lib/ai-prompt-library";

/**
 * Render proof for settings → Prompt library.
 *
 * The page used to hold its library in component state, so a reload erased
 * every prompt. It is now a server component: it resolves the workspace from
 * the slug, gates on membership, and seeds the client editor from
 * `listPromptsAction`. These tests render it the way the router would and pin
 * the persistence seam — the workspace id passed to the action, the rows it
 * returns reaching the card list, and the read-only note a guest sees.
 */

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const permissions = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canEditContent: vi.fn(),
}));
const queries = vi.hoisted(() => ({ getWorkspaceBySlug: vi.fn() }));
const actions = vi.hoisted(() => ({
  listPromptsAction: vi.fn(),
  createPromptAction: vi.fn(),
  updatePromptAction: vi.fn(),
  deletePromptAction: vi.fn(),
  clonePromptAction: vi.fn(),
}));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: permissions.getWorkspaceAccess,
  canEditContent: permissions.canEditContent,
}));
vi.mock("@/server/queries", () => ({ getWorkspaceBySlug: queries.getWorkspaceBySlug }));
vi.mock("@/server/actions/prompts", () => actions);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: navigation.notFound,
  usePathname: () => "/w/acme/settings/prompts",
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      h("a", { href, ...rest }, children as never),
  };
});

import PromptLibraryPage from "./page";

const PROMPT: PromptTemplate = {
  id: "p1",
  name: "Weekly summary",
  body: "Summarize {{notes}}.",
  variables: ["notes"],
  scope: "workspace",
  tags: ["weekly"],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

async function renderPage() {
  return renderToStaticMarkup(
    await PromptLibraryPage({ params: Promise.resolve({ slug: "acme" }) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "u1", locale: "en" });
  queries.getWorkspaceBySlug.mockResolvedValue({ id: "ws-1", name: "Acme", slug: "acme" });
  permissions.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  permissions.canEditContent.mockReturnValue(true);
  actions.listPromptsAction.mockResolvedValue({ ok: true, prompts: [PROMPT], canEdit: true });
});

describe("prompt library page", () => {
  it("loads the visible prompts from the server action for this workspace", async () => {
    const html = await renderPage();

    expect(actions.listPromptsAction).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect(html).toContain("Weekly summary");
    expect(html).toContain("Summarize");
    expect(html).toContain("Prompt library");
  });

  it("does not render the guest read-only note for a member who can edit", async () => {
    const html = await renderPage();

    expect(html).not.toContain("Guests cannot create or edit them.");
  });

  it("marks a guest's view read-only", async () => {
    permissions.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
    permissions.canEditContent.mockReturnValue(false);
    actions.listPromptsAction.mockResolvedValue({ ok: true, prompts: [PROMPT], canEdit: false });

    const html = await renderPage();

    expect(html).toContain("Guests cannot create or edit them.");
    expect(html).toContain("Weekly summary");
  });

  it("shows the action's error instead of silently pretending the library is empty", async () => {
    actions.listPromptsAction.mockResolvedValue({ ok: false, error: "The library is unavailable." });

    const html = await renderPage();

    expect(html).toContain("The library is unavailable.");
  });

  it("404s a caller who is not a member", async () => {
    permissions.getWorkspaceAccess.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
    expect(actions.listPromptsAction).not.toHaveBeenCalled();
  });
});
