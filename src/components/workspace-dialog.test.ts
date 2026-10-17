import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DS20 — workspace create/edit dialog.
 *
 * The slug preview + validation are pure and pinned below; the two
 * `renderToStaticMarkup` passes prove the default dialog (name + live slug
 * preview + icon picker) and the invalid dialog (rejected slug → danger ring +
 * message + blocked submit). Radix and the Server Actions are stubbed — there is
 * no Next runtime or DB here.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/server/actions/workspaces", () => ({
  createWorkspaceAction: vi.fn(async () => ({ ok: true, slug: "new", pageId: null })),
  updateWorkspaceAction: vi.fn(async () => ({ ok: true })),
  deleteWorkspaceAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@radix-ui/react-dialog", async () => {
  const { createElement: h } = await import("react");
  type MockProps = {
    children?: ReactNode;
    open?: boolean;
    role?: string;
    className?: string;
    "aria-modal"?: string | boolean;
    [key: string]: unknown;
  };
  const PassThrough = ({ children }: { children?: ReactNode }) =>
    h("div", null, (children as ReactNode) ?? null);
  return {
    Root: ({ open, children }: MockProps) =>
      open === false ? null : h("div", null, (children as ReactNode) ?? null),
    Trigger: PassThrough,
    Close: PassThrough,
    Title: PassThrough,
    Description: PassThrough,
    Portal: PassThrough,
    Overlay: PassThrough,
    Content: ({ children, role, className, ...rest }: MockProps) =>
      h("div", { role, className, "aria-modal": rest["aria-modal"] }, (children as ReactNode) ?? null),
  };
});

import {
  MAX_WORKSPACE_SLUG,
  PRESET_ICONS,
  WorkspaceDialog,
  validateWorkspaceSlug,
  slugifyWorkspaceName,
  workspaceSlugMessage,
  workspaceSlugPreview,
} from "./workspace-dialog";

const render = (props: Partial<Parameters<typeof WorkspaceDialog>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(WorkspaceDialog, {
      open: true,
      mode: "create",
      locale: "en",
      onClose: () => {},
      ...props,
    }),
  );

describe("slugifyWorkspaceName", () => {
  it("lowercases and hyphens anything slug-shaped", () => {
    expect(slugifyWorkspaceName("Acme Inc.")).toBe("acme-inc");
    expect(slugifyWorkspaceName("  Hello   World  ")).toBe("hello-world");
    expect(slugifyWorkspaceName("A/B & C")).toBe("a-b-c");
    expect(slugifyWorkspaceName("Café")).toBe("cafe");
    expect(slugifyWorkspaceName("Ünïcode")).toBe("unicode");
  });

  it("collapses edge and repeated separators", () => {
    expect(slugifyWorkspaceName("---weird---")).toBe("weird");
    expect(slugifyWorkspaceName("a---b")).toBe("a-b");
    expect(slugifyWorkspaceName("!!!")).toBe("");
    expect(slugifyWorkspaceName("")).toBe("");
  });

  it("caps the slug at the maximum length", () => {
    expect(slugifyWorkspaceName("a".repeat(80)).length).toBe(MAX_WORKSPACE_SLUG);
  });
});

describe("validateWorkspaceSlug", () => {
  it("accepts a well-formed slug", () => {
    expect(validateWorkspaceSlug("acme-inc")).toBe("ok");
    expect(validateWorkspaceSlug("a1")).toBe("ok");
  });

  it("names the first problem", () => {
    expect(validateWorkspaceSlug("")).toBe("empty");
    expect(validateWorkspaceSlug("a")).toBe("too-short");
    expect(validateWorkspaceSlug("Acme")).toBe("invalid");
    expect(validateWorkspaceSlug("a--b")).toBe("invalid");
    expect(validateWorkspaceSlug("a".repeat(MAX_WORKSPACE_SLUG + 1))).toBe("too-long");
  });
});

describe("workspaceSlugPreview + message", () => {
  it("marks a derived slug valid", () => {
    expect(workspaceSlugPreview("Acme Inc.")).toEqual({
      slug: "acme-inc",
      status: "ok",
      valid: true,
    });
  });

  it("marks an all-punctuation name invalid", () => {
    expect(workspaceSlugPreview("!!!")).toEqual({ slug: "", status: "empty", valid: false });
  });

  it("maps every status to a message or null", () => {
    expect(workspaceSlugMessage("ok")).toBeNull();
    expect(workspaceSlugMessage("empty")).toMatch(/name/i);
    expect(workspaceSlugMessage("too-short")).toContain("2");
    expect(workspaceSlugMessage("invalid")).toMatch(/lowercase/i);
    expect(workspaceSlugMessage("too-long")).toContain(String(MAX_WORKSPACE_SLUG));
  });

  it("keeps the preset icon the e2e flow relies on", () => {
    expect(PRESET_ICONS).toContain("🧠");
  });
});

describe("WorkspaceDialog markup", () => {
  it("renders the name field, the live slug preview and the icon picker", () => {
    const html = render({ initialName: "Acme Inc." });
    expect(html).toContain("Create a workspace");
    expect(html).toContain('id="workspace-name"');
    expect(html).toContain(">Name");
    expect(html).toContain('id="workspace-slug"');
    expect(html).toContain('value="acme-inc"');
    expect(html).toContain("readonly");
    expect(html).toContain("Create workspace");
    // no validation error → submit is not disabled
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('aria-label="Custom emoji"');
    expect(html).toContain("Use 🧠");
    expect(html).toContain("emoji-picker-trigger");
  });

  it("flags an invalid slug with a danger message and a blocked submit", () => {
    const html = render({ initialName: "!!!" });
    expect(html).toContain("Add a name to build a web address.");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('disabled=""');
  });

  it("offers the danger delete only in edit mode with permission", () => {
    const without = render({ mode: "edit", workspaceId: "ws_1", initialName: "Acme" });
    expect(without).not.toContain("Delete this workspace…");
    const withDelete = render({
      mode: "edit",
      workspaceId: "ws_1",
      initialName: "Acme",
      canDelete: true,
    });
    expect(withDelete).toContain("Delete this workspace…");
    expect(withDelete).toContain("Danger zone");
  });
});
