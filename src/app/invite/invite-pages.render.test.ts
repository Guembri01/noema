import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { generateInviteToken } from "@/lib/invite-token";

/**
 * Render proof for the two invitation pages.
 *
 * Both pages used to accept during render, so a single GET of an invitation link
 * — which a mail scanner, a chat-app link preview or a browser prefetch performs
 * just as readily as the invitee — spent the single-use token. The pages now read
 * (`preview*`) and post the acceptance from a form.
 *
 * These tests render each page exactly as the router would and assert the two
 * things that follow: the card names what is being joined and carries a form to
 * accept, and **nothing was written** — every write the acceptance path can make
 * is asserted untouched. If a page ever accepts during render again, the write
 * assertion is what fails.
 *
 * `next/link` is stubbed (node has no router), and `redirect` throws the way
 * Next's does, so a redirect stops the page and can be asserted on.
 */

const db = vi.hoisted(() => ({
  inviteFindUnique: vi.fn(),
  inviteUpdate: vi.fn(),
  workspaceMemberUpsert: vi.fn(),
  projectMemberUpsert: vi.fn(),
  teamspaceInviteFindUnique: vi.fn(),
  teamspaceInviteUpdate: vi.fn(),
  teamspaceMemberUpsert: vi.fn(),
}));

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), requireUser: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    invite: { findUnique: db.inviteFindUnique, update: db.inviteUpdate },
    workspaceMember: { upsert: db.workspaceMemberUpsert },
    projectMember: { upsert: db.projectMemberUpsert },
    teamspaceInvite: {
      findUnique: db.teamspaceInviteFindUnique,
      update: db.teamspaceInviteUpdate,
    },
    teamspaceMember: { upsert: db.teamspaceMemberUpsert },
  },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: auth.getCurrentUser,
  requireUser: auth.requireUser,
}));

vi.mock("next/cache", () => ({ revalidatePath: cache.revalidatePath }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      h("a", { href, ...rest }, children as never),
  };
});

import WorkspaceInvitePage from "./[token]/page";
import TeamspaceInvitePage from "./teamspace/[token]/page";

const USER = { id: "new-user", name: "New Member", email: "new.member@example.test", locale: "en" };

const writes = () => [
  db.inviteUpdate,
  db.workspaceMemberUpsert,
  db.projectMemberUpsert,
  db.teamspaceInviteUpdate,
  db.teamspaceMemberUpsert,
];

const renderWorkspace = async (token: string) =>
  renderToStaticMarkup(await WorkspaceInvitePage({ params: Promise.resolve({ token }) }));

const renderTeamspace = async (token: string) =>
  renderToStaticMarkup(await TeamspaceInvitePage({ params: Promise.resolve({ token }) }));

beforeEach(() => {
  vi.clearAllMocks();
  // Pin the clock: expiry is a real comparison against now, and the fixtures are
  // dated against the release window.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T09:00:00.000Z"));
  auth.getCurrentUser.mockResolvedValue(USER);
  auth.requireUser.mockResolvedValue(USER);
  db.inviteFindUnique.mockResolvedValue({
    id: "inv-1",
    email: USER.email,
    role: "MEMBER",
    projectId: null,
    acceptedAt: null,
    expiresAt: new Date("2026-03-24T09:00:00.000Z"),
    project: null,
    workspace: { id: "ws-1", name: "Acme", slug: "acme" },
  });
  db.teamspaceInviteFindUnique.mockResolvedValue({
    id: "ts-inv-1",
    teamspaceId: "ts-1",
    email: USER.email,
    role: "ADMIN",
    acceptedAt: null,
    expiresAt: new Date("2026-03-24T09:00:00.000Z"),
    teamspace: { name: "Design", workspace: { id: "ws-1", slug: "acme" } },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the workspace invitation page", () => {
  it("offers the invitation to accept, and spends nothing on the way", async () => {
    const html = await renderWorkspace(generateInviteToken());

    expect(html).toContain("Acme");
    expect(html).toContain("Member");
    expect(html).toContain("Accept invitation");
    expect(html).toMatch(/<form[^>]*>[\s\S]*Accept invitation[\s\S]*<\/form>/);

    for (const write of writes()) expect(write).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("shows the invitation's own refusal instead of a form", async () => {
    db.inviteFindUnique.mockResolvedValue(null);

    const html = await renderWorkspace(generateInviteToken());

    expect(html).toContain("Invitation could not be accepted");
    expect(html).toContain("That invitation link is not valid.");
    expect(html).not.toMatch(/<form[^>]*>/);
  });

  it("sends a signed-out visitor through the login and back", async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    const token = generateInviteToken();

    await expect(renderWorkspace(token)).rejects.toThrow(
      `REDIRECT:/login?next=${encodeURIComponent(`/invite/${token}`)}`,
    );
    expect(db.inviteFindUnique).not.toHaveBeenCalled();
  });
});

describe("the teamspace invitation page", () => {
  it("offers the invitation to accept, and spends nothing on the way", async () => {
    const html = await renderTeamspace(generateInviteToken());

    expect(html).toContain("Design");
    expect(html).toContain("Admin");
    expect(html).toContain("Accept invitation");
    expect(html).toMatch(/<form[^>]*>[\s\S]*Accept invitation[\s\S]*<\/form>/);

    for (const write of writes()) expect(write).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("shows the invitation's own refusal instead of a form", async () => {
    db.teamspaceInviteFindUnique.mockResolvedValue(null);

    const html = await renderTeamspace(generateInviteToken());

    expect(html).toContain("Invitation could not be accepted");
    expect(html).not.toMatch(/<form[^>]*>/);
  });
});
