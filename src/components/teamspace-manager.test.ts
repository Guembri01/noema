import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DS20 — teamspaces.
 *
 * The row view model (icon/label/member count) and the loading shape are pure
 * and pinned below; the `renderToStaticMarkup` passes prove a populated row
 * (member-count badge, hover actions, inline invite editor), the skeleton list
 * and the actionable empty state. Server Actions / sonner / Radix are stubbed.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/server/actions/teamspaces", () => ({
  createTeamspaceAction: vi.fn(async () => ({ ok: true, id: "new" })),
  deleteTeamspaceAction: vi.fn(async () => ({ ok: true })),
  addTeamspaceMemberAction: vi.fn(async () => ({ ok: true })),
  removeTeamspaceMemberAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/server/actions/teamspace-invites", () => ({
  inviteTeamspaceMemberAction: vi.fn(async () => ({ added: true, email: "x@y.com" })),
  revokeTeamspaceInviteAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@radix-ui/react-dialog", async () => {
  const { createElement: h } = await import("react");
  type MockProps = { children?: ReactNode; open?: boolean; [key: string]: unknown };
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
    Content: PassThrough,
  };
});

import {
  TEAMSPACE_SKELETON_MAX,
  TeamspaceManager,
  teamspaceMemberCount,
  teamspaceRowMeta,
  teamspaceSkeletonCount,
  type TeamspaceRow,
} from "./teamspace-manager";

const TEAMSPACES: TeamspaceRow[] = [
  {
    id: "ts1",
    name: "Design",
    icon: null,
    memberIds: ["m1", "m2"],
    invites: [{ id: "inv1", email: "new@example.com", role: "MEMBER" }],
  },
];

const MEMBERS = [
  { id: "m1", name: "Ada", email: "ada@example.com" },
  { id: "m2", name: "Bob", email: "bob@example.com" },
];

const render = (overrides: Partial<Parameters<typeof TeamspaceManager>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(TeamspaceManager, {
      workspaceId: "ws1",
      teamspaces: TEAMSPACES,
      members: MEMBERS,
      locale: "en",
      ...overrides,
    }),
  );

describe("teamspaceMemberCount", () => {
  it("counts unique, non-blank member ids", () => {
    expect(teamspaceMemberCount({ memberIds: ["a", "a", "b", ""] })).toBe(2);
    expect(teamspaceMemberCount({ memberIds: [] })).toBe(0);
    expect(teamspaceMemberCount({ memberIds: null })).toBe(0);
  });
});

describe("teamspaceRowMeta", () => {
  it("resolves the glyph, label and member count", () => {
    expect(teamspaceRowMeta(TEAMSPACES[0])).toEqual({
      icon: "👥",
      label: "Design",
      memberCount: 2,
    });
  });

  it("falls back for a blank name and icon", () => {
    const meta = teamspaceRowMeta({ id: "x", name: "  ", icon: "  ", memberIds: [], invites: [] });
    expect(meta.icon).toBe("👥");
    expect(meta.label).toBe("Teamspace");
  });
});

describe("teamspaceSkeletonCount", () => {
  it("clamps into 1..max", () => {
    expect(teamspaceSkeletonCount(0)).toBe(1);
    expect(teamspaceSkeletonCount(3)).toBe(3);
    expect(teamspaceSkeletonCount(99)).toBe(TEAMSPACE_SKELETON_MAX);
    expect(teamspaceSkeletonCount(Number.NaN)).toBe(1);
  });
});

describe("TeamspaceManager markup", () => {
  it("renders a row with the member-count badge, hover actions and inline invite editor", () => {
    const html = render();
    expect(html).toContain("<li");
    expect(html).toContain("Design");
    expect(html).toContain(">2<"); // member-count badge
    expect(html).toContain('aria-label="Delete Design"');
    expect(html).toContain('aria-label="Edit Design"');
    expect(html).toContain('aria-label="Invite by email to Design"');
    expect(html).toContain("Invite");
    expect(html).toContain("new@example.com · member · pending");
    // member chips with the accent selected state
    expect(html).toContain("Ada");
    expect(html).toContain("Bob");
    expect(html).toContain("bg-accent");
  });

  it("renders skeleton rows while loading", () => {
    const html = render({ loading: true });
    expect(html).toContain('data-skeleton="row"');
    expect(html).toContain('aria-busy="true"');
  });

  it("renders an actionable empty state with no teamspaces", () => {
    const html = render({ teamspaces: [] });
    expect(html).toContain('data-empty-state="compact"');
    expect(html).toContain("No teamspaces yet.");
    expect(html).toContain(">Add<");
    // the only "Create" control is the form submit
    expect(html.match(/Create/g)?.length).toBe(1);
  });

  it("surfaces a list error with a retry control", () => {
    const html = render({ error: "Could not load teamspaces", onRetry: () => {} });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load teamspaces");
    expect(html).toContain("Retry");
  });
});
