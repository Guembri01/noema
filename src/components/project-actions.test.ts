import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Project actions — both controls ride the design-system `Button`, so the
 * shared states contract (`.focus-ring`, `.u-interactive`, token colours) is
 * what the markup carries rather than bespoke classes.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/server/actions/pages", () => ({
  createPageAction: vi.fn(async () => ({ ok: true, id: "pg2" })),
}));

vi.mock("@/server/actions/email", () => ({
  sendWorkspaceInviteAction: vi.fn(async () => ({ ok: true, link: "https://x", emailed: true })),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { ProjectActions } = await import("@/components/project-actions");

const h = createElement;

describe("renderToStaticMarkup — project actions", () => {
  const html = renderToStaticMarkup(
    h(ProjectActions, {
      workspaceId: "w1",
      workspaceSlug: "ws",
      projectId: "p1",
      projectName: "Apollo",
      locale: "en",
    }),
  );

  it("renders the two actions on the shared Button contract", () => {
    expect(html.match(/<button/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("focus-ring");
    expect(html).toContain("u-interactive");
  });

  it("uses token colours for the secondary button", () => {
    expect(html).toContain("border-border");
    expect(html).toContain("bg-bg");
  });
});
