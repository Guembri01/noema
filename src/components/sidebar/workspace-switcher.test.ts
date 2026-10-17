import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DS20 — workspace switcher.
 *
 * The ordering / role / search decisions live in pure helpers and are pinned
 * here; a `renderToStaticMarkup` pass (with Radix's dropdown mocked pass-through,
 * matching the repo's overlay tests) proves the menu wires the avatar rows, the
 * role tags, the current-workspace badge, the conditional search field and the
 * create / settings entries, on the `animate-rise` + `Z.popover` surface.
 */

vi.mock("@radix-ui/react-dropdown-menu", async () => {
  const { createElement: h } = await import("react");
  type MockProps = {
    children?: ReactNode;
    className?: string;
    style?: Record<string, unknown>;
  };
  const Pass = ({ children, className, style }: MockProps) =>
    h("div", { className, style }, (children as ReactNode) ?? null);
  return {
    Root: Pass,
    Trigger: Pass,
    Portal: Pass,
    Content: Pass,
    Item: Pass,
    Group: Pass,
    Label: Pass,
    Separator: Pass,
    Sub: Pass,
    RadioGroup: Pass,
    CheckboxItem: Pass,
    SubTrigger: Pass,
    SubContent: Pass,
  };
});

import {
  CURRENT_WORKSPACE_LABEL,
  WORKSPACE_ROLE_HUE,
  WORKSPACE_SEARCH_THRESHOLD,
  WorkspaceSwitcherMenu,
  filterWorkspaces,
  shouldShowWorkspaceSearch,
  workspaceLabel,
  workspaceRoleKey,
  workspaceRows,
  type WorkspaceSummary,
} from "./workspace-switcher";
import { DropdownMenu, DropdownMenuContentImpl } from "@/components/ui/dropdown-menu";

const WORKSPACES: WorkspaceSummary[] = [
  { id: "a", name: "Acme Inc.", slug: "acme", icon: null, role: "OWNER" },
  { id: "b", name: "Beta Lab", slug: "beta", icon: "🧪", role: "MEMBER" },
  { id: "c", name: "Gamma", slug: "gamma", icon: null },
];

const renderMenu = (workspaces: WorkspaceSummary[], currentSlug = "acme") =>
  renderToStaticMarkup(
    createElement(
      DropdownMenu,
      null,
      createElement(
        DropdownMenuContentImpl,
        { align: "start" },
        createElement(WorkspaceSwitcherMenu, {
          workspace: { name: "Acme Inc.", slug: currentSlug, icon: null, role: "OWNER" },
          workspaces,
          user: { email: "ada@example.com" },
          locale: "en",
          onCreateWorkspace: () => {},
        }),
      ),
    ),
  );

describe("workspaceLabel", () => {
  it("prefers the trimmed name, then the slug, then a stable fallback", () => {
    expect(workspaceLabel("  Acme  ", "acme")).toBe("Acme");
    expect(workspaceLabel("", "acme")).toBe("acme");
    expect(workspaceLabel("   ", "")).toBe("Workspace");
    expect(workspaceLabel(null, "acme")).toBe("acme");
  });
});

describe("workspaceRoleKey", () => {
  it("normalizes persisted and engine roles", () => {
    expect(workspaceRoleKey("OWNER")).toBe("owner");
    expect(workspaceRoleKey(" admin ")).toBe("admin");
    expect(workspaceRoleKey("MEMBER")).toBe("member");
    expect(workspaceRoleKey("guest")).toBe("guest");
  });

  it("returns null for unknown or non-string roles", () => {
    expect(workspaceRoleKey("superuser")).toBeNull();
    expect(workspaceRoleKey(undefined)).toBeNull();
    expect(workspaceRoleKey(42)).toBeNull();
  });

  it("maps every role to a tag hue", () => {
    expect(Object.keys(WORKSPACE_ROLE_HUE).sort()).toEqual([
      "admin",
      "guest",
      "member",
      "owner",
    ]);
  });
});

describe("workspaceRows", () => {
  it("puts the current workspace first, then preserves input order", () => {
    const rows = workspaceRows("beta", WORKSPACES);
    expect(rows.map((row) => row.slug)).toEqual(["beta", "acme", "gamma"]);
    expect(rows.find((row) => row.slug === "beta")?.current).toBe(true);
    expect(rows.filter((row) => row.current)).toHaveLength(1);
  });

  it("dedupes by slug and drops keyless rows", () => {
    const rows = workspaceRows("acme", [
      ...WORKSPACES,
      { id: "dup", name: "Acme copy", slug: "acme", icon: null },
      { id: "bad", name: "No slug", slug: "", icon: null },
    ]);
    expect(rows.map((row) => row.slug)).toEqual(["acme", "beta", "gamma"]);
  });

  it("resolves the label and role key for each row", () => {
    const rows = workspaceRows("acme", WORKSPACES);
    expect(rows[0]).toMatchObject({ label: "Acme Inc.", roleKey: "owner", current: true });
    expect(rows[1]).toMatchObject({ label: "Beta Lab", roleKey: "member", current: false });
    expect(rows[2]).toMatchObject({ label: "Gamma", roleKey: null, current: false });
  });
});

describe("search gate + filter", () => {
  it("shows search only above the threshold", () => {
    expect(shouldShowWorkspaceSearch(WORKSPACE_SEARCH_THRESHOLD)).toBe(false);
    expect(shouldShowWorkspaceSearch(WORKSPACE_SEARCH_THRESHOLD + 1)).toBe(true);
    expect(shouldShowWorkspaceSearch(0)).toBe(false);
  });

  it("filters case-insensitively over label and slug", () => {
    const rows = workspaceRows("acme", WORKSPACES);
    expect(filterWorkspaces(rows, "beta").map((row) => row.slug)).toEqual(["beta"]);
    expect(filterWorkspaces(rows, "ACME").map((row) => row.slug)).toEqual(["acme"]);
    expect(filterWorkspaces(rows, "  ").map((row) => row.slug)).toEqual([
      "acme",
      "beta",
      "gamma",
    ]);
    expect(filterWorkspaces(rows, "nope")).toHaveLength(0);
  });
});

describe("WorkspaceSwitcherMenu markup", () => {
  it("renders avatar rows, role tags and the current badge on a risen popover", () => {
    const html = renderMenu(WORKSPACES, "acme");
    expect(html).toContain("Acme Inc.");
    expect(html).toContain("Beta Lab");
    expect(html).toContain("Owner");
    expect(html).toContain("Member");
    expect(html).toContain(CURRENT_WORKSPACE_LABEL);
    expect(html).toContain('data-tone="accent"');
    // role tags ride the tag palette
    expect(html).toContain("tag-");
    // the menu surface is the shared popover: rise + Z.popover
    expect(html).toContain("animate-rise");
    expect(html).toContain("z-index:50");
    // create + settings entries
    expect(html).toContain("New workspace");
    expect(html).toContain("Workspace settings");
  });

  it("hides the search field at or below five workspaces", () => {
    const html = renderMenu(WORKSPACES, "acme");
    expect(html).not.toContain('aria-label="Search"');
  });

  it("shows the search field above five workspaces", () => {
    const many: WorkspaceSummary[] = Array.from({ length: 6 }, (_, index) => ({
      id: `w${index}`,
      name: `Workspace ${index}`,
      slug: `workspace-${index}`,
      icon: null,
    }));
    const html = renderMenu(many, "workspace-0");
    expect(html).toContain('aria-label="Search"');
    expect(html).toContain("Current workspace");
  });
});
