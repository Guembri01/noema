import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * dz09 — members roster: the pure mappings (role → assignable roles, the
 * member/guest partition, the role → tag-hue map) plus a live render of the
 * three sections, their empty states and the loading skeleton.
 *
 * The component is a client component, so the Next router, the toast layer and
 * the Server Actions it calls are mocked; the render runs through
 * `react-dom/server` (the node test environment has no DOM).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/server/actions/workspaces", () => ({
  leaveWorkspaceAction: vi.fn(),
  removeMemberAction: vi.fn(),
  setMemberRoleAction: vi.fn(),
  transferOwnershipAction: vi.fn(),
}));
vi.mock("@/server/actions/email", () => ({
  sendWorkspaceInviteAction: vi.fn(),
}));

import { TAG_HUES, isTagHue } from "@/lib/design-tokens";
import { roleLabelKey } from "@/lib/workspace-role-map";
import {
  MembersManager,
  ROLE_HUES,
  assignableRolesFor,
  groupMembers,
  roleHue,
  roleSelectOptions,
  type MemberRow,
} from "./members-manager";

const h = createElement;

const members: MemberRow[] = [
  { userId: "u1", name: "Ada Owner", email: "ada@example.test", role: "OWNER" },
  { userId: "u2", name: "Bob Admin", email: "bob@example.test", role: "ADMIN" },
  { userId: "u3", name: "Cleo Member", email: "cleo@example.test", role: "MEMBER" },
  { userId: "u4", name: "Gus Guest", email: "gus@example.test", role: "GUEST" },
];

const render = (over: Partial<Parameters<typeof MembersManager>[0]> = {}) =>
  renderToStaticMarkup(
    h(MembersManager, {
      workspaceId: "w1",
      workspaceName: "Demo",
      ownerId: "u1",
      currentUserId: "u1",
      currentUserRole: "OWNER",
      locale: "en",
      members,
      ...over,
    }),
  );

describe("assignableRolesFor", () => {
  it("mirrors the engine: only roles strictly below the actor", () => {
    expect(assignableRolesFor("OWNER")).toEqual(["ADMIN", "MEMBER", "GUEST"]);
    expect(assignableRolesFor("ADMIN")).toEqual(["MEMBER", "GUEST"]);
    expect(assignableRolesFor("MEMBER")).toEqual([]);
    expect(assignableRolesFor("GUEST")).toEqual([]);
  });

  it("fails closed for unknown actors", () => {
    expect(assignableRolesFor("SUPERUSER")).toEqual([]);
    expect(assignableRolesFor(null)).toEqual([]);
  });
});

describe("roleSelectOptions", () => {
  it("localises every assignable role", () => {
    expect(roleSelectOptions("OWNER", "en")).toEqual([
      { value: "ADMIN", label: "Admin" },
      { value: "MEMBER", label: "Member" },
      { value: "GUEST", label: "Guest" },
    ]);
  });
});

describe("groupMembers", () => {
  it("partitions guests from everyone else, in encounter order", () => {
    const groups = groupMembers([
      { userId: "g1", name: "G", email: "g@x.test", role: "GUEST" },
      { userId: "m1", name: "M", email: "m@x.test", role: "MEMBER" },
      { userId: "o1", name: "O", email: "o@x.test", role: "OWNER" },
    ]);
    expect(groups.members.map((row) => row.userId)).toEqual(["m1", "o1"]);
    expect(groups.guests.map((row) => row.userId)).toEqual(["g1"]);
  });

  it("drops rows with no usable id and tolerates junk input", () => {
    expect(groupMembers([{ userId: "  ", name: "x", email: "x@x.test", role: "MEMBER" }])).toEqual({
      members: [],
      guests: [],
    });
    expect(groupMembers(null)).toEqual({ members: [], guests: [] });
    expect(groupMembers(undefined)).toEqual({ members: [], guests: [] });
  });
});

describe("roleHue", () => {
  it("maps each persisted role to a known tag hue", () => {
    expect(ROLE_HUES).toEqual({
      OWNER: "purple",
      ADMIN: "blue",
      MEMBER: "green",
      GUEST: "gray",
    });
    for (const role of ["OWNER", "ADMIN", "MEMBER", "GUEST"]) {
      expect(isTagHue(roleHue(role))).toBe(true);
    }
  });

  it("fails closed to gray and reads a lowercase role", () => {
    expect(roleHue("guest")).toBe("gray");
    expect(roleHue("nope")).toBe("gray");
    expect(roleHue(null)).toBe("gray");
    expect(roleLabelKey("ADMIN")).toBe("admin");
    expect(roleLabelKey("nope")).toBe("member");
  });
});

describe("MembersManager render", () => {
  it("asks the owner for their password before the transfer (B138)", () => {
    // The dialog is interactive and the repository has no DOM test, so the
    // plumbing is pinned on the source: the field exists and the call carries
    // the password. The security boundary itself is pinned by the test of the
    // action (`src/server/actions/workspaces.test.ts`).
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "members-manager.tsx"),
      "utf8",
    );
    expect(source).toContain(
      "transferOwnershipAction(workspaceId, target.userId, transferPassword)",
    );
    expect(source).toContain('type="password"');
  });

  it("renders Members / Pending invites / Guests sections with the roster", () => {
    const html = render();
    expect(html).toContain("Members");
    expect(html).toContain("Pending invites");
    expect(html).toContain("Guests");
    expect(html).toContain("Ada Owner");
    expect(html).toContain("Bob Admin");
    expect(html).toContain("Cleo Member");
    expect(html).toContain("Gus Guest");
    // The empty pending-invite section is actionable.
    expect(html).toContain("No pending invites");
  });

  it("offers a role Select for editable rows but never for the owner or self", () => {
    const html = render();
    const rowPickers = html.match(/aria-label="Role for /g) ?? [];
    // Bob (admin) and Cleo (member) are editable by the owner; Ada is self/owner.
    expect(rowPickers.length).toBe(2);
    expect(html).toContain('aria-label="Role for Bob Admin"');
  });

  it("renders a spinner on each pending invite row", () => {
    const html = render({
      pendingInvites: [{ id: "i1", email: "pat@example.test", role: "MEMBER" }],
    });
    expect(html).toContain("pat@example.test");
    expect(html).toContain('role="status"');
  });

  it("renders an actionable empty state when there are no members", () => {
    const html = render({ members: [] });
    expect(html).toContain('data-empty-state="compact"');
    expect(html).toContain("No members to show.");
    expect(html).not.toContain('aria-label="Role for');
  });

  it("renders a skeleton instead of the list while loading", () => {
    const html = render({ loading: true });
    expect(html).toContain("notion-skeleton");
    expect(html).not.toContain("No members to show.");
    expect(html).not.toContain("No pending invites");
  });

  it("only ever paints role chips with a known tag hue", () => {
    const html = render();
    const hues = html.match(/--tag-([a-z]+)-/g) ?? [];
    expect(hues.length).toBeGreaterThan(0);
    for (const hue of hues) {
      expect(TAG_HUES.some((known) => hue.includes(`-${known}-`))).toBe(true);
    }
  });
});
