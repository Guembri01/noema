import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canRedeem, isWellFormedToken } from "@/lib/invite-token";
import { hashToken } from "@/lib/secrets";

/**
 * `src/lib/invite-token.ts` wiring — `sendWorkspaceInviteAction` mints the raw
 * token through the module and stores only its hash; `acceptWorkspaceInviteAction`
 * verifies the presented token through the module. The assertions are a real
 * sign → verify round-trip: the link carries a well-formed raw token, the row
 * stores `hashToken(raw)`, and acceptance only succeeds when the presented token
 * hashes back to the stored digest with an unexpired, unused invite.
 */

const ORIGIN = "https://app.example.test";
const PREV_APP_URL = process.env.APP_URL;

const db = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  projectFindUnique: vi.fn(),
  inviteDeleteMany: vi.fn(),
  inviteCreate: vi.fn(),
  inviteFindUnique: vi.fn(),
  inviteUpdate: vi.fn(),
  workspaceMemberUpsert: vi.fn(),
  projectMemberUpsert: vi.fn(),
}));

const mailer = vi.hoisted(() => ({ sendMail: vi.fn() }));
const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: db.workspaceFindUnique },
    project: { findUnique: db.projectFindUnique },
    invite: {
      deleteMany: db.inviteDeleteMany,
      create: db.inviteCreate,
      findUnique: db.inviteFindUnique,
      update: db.inviteUpdate,
    },
    workspaceMember: { upsert: db.workspaceMemberUpsert },
    projectMember: { upsert: db.projectMemberUpsert },
  },
}));

vi.mock("@/lib/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mailer")>();
  return { ...actual, sendMail: mailer.sendMail };
});

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));

vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

import {
  acceptWorkspaceInviteAction,
  sendWorkspaceInviteAction,
} from "./email";

type CreatedInvite = {
  workspaceId: string;
  email: string;
  role: string;
  token: string;
  expiresAt: Date;
};

function createdInvite(): CreatedInvite {
  const calls = db.inviteCreate.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].data as CreatedInvite;
}

async function mint(): Promise<string> {
  const result = await sendWorkspaceInviteAction({
    workspaceId: "ws-1",
    email: "new.member@example.test",
  });
  if ("error" in result) throw new Error(`mint failed: ${result.error}`);
  const raw = result.link.split("/invite/")[1];
  expect(raw).toBeTruthy();
  return raw;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T09:00:00.000Z"));
  process.env.APP_URL = ORIGIN;

  auth.requireUser.mockResolvedValue({
    id: "admin-1",
    name: "Ada Admin",
    email: "admin@example.test",
  });
  perms.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });
  db.workspaceFindUnique.mockResolvedValue({
    name: "Acme",
    slug: "acme",
    ownerId: "owner-1",
    owner: { email: "owner@example.test" },
    _count: { members: 0, invites: 0 },
  });
  db.projectFindUnique.mockResolvedValue(null);
  db.inviteDeleteMany.mockResolvedValue({ count: 0 });
  db.inviteCreate.mockResolvedValue({ id: "inv-1" });
  db.inviteUpdate.mockResolvedValue({ id: "inv-1" });
  db.workspaceMemberUpsert.mockResolvedValue({ id: "wm-1" });
  db.projectMemberUpsert.mockResolvedValue({ id: "pm-1" });
  mailer.sendMail.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  if (PREV_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = PREV_APP_URL;
});

describe("invite minting through the module", () => {
  it("mints a well-formed token, emails the raw value and stores only its hash", async () => {
    const raw = await mint();

    expect(isWellFormedToken(raw)).toBe(true);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{22,}$/);

    const stored = createdInvite();
    expect(stored.token).toBe(hashToken(raw));
    expect(stored.token).not.toBe(raw);
    expect(stored.token).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    // 14-day TTL, computed from the module's minting call.
    expect(stored.expiresAt).toEqual(new Date("2026-03-24T09:00:00.000Z"));

    // The email carries the raw link, never the stored digest.
    const message = mailer.sendMail.mock.calls[0][1] as {
      text: string;
      html: string;
    };
    expect(message.text).toContain(raw);
    expect(message.text).not.toContain(stored.token);
  });
});

describe("invite acceptance verifies through the module", () => {
  it("round-trips: a token minted by the action is accepted", async () => {
    const raw = await mint();
    const stored = createdInvite();

    auth.requireUser.mockResolvedValue({
      id: "new-user",
      name: "New Member",
      email: "new.member@example.test",
    });
    db.inviteFindUnique.mockImplementation(
      async (args: { where: { token: string } }) =>
        args.where.token === stored.token
          ? {
              id: "inv-1",
              email: stored.email,
              role: stored.role,
              projectId: null,
              acceptedAt: null,
              expiresAt: stored.expiresAt,
              workspace: { id: "ws-1", name: "Acme", slug: "acme" },
            }
          : null,
    );

    const result = await acceptWorkspaceInviteAction(raw);
    expect(result).toEqual({
      ok: true,
      slug: "acme",
      workspaceName: "Acme",
      role: "MEMBER",
    });
    expect(db.inviteFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { token: hashToken(raw) } }),
    );
    expect(db.workspaceMemberUpsert).toHaveBeenCalledTimes(1);
    expect(db.inviteUpdate).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed token before any database lookup", async () => {
    const result = await acceptWorkspaceInviteAction("not a token!");
    expect(result).toEqual({ error: "That invitation link is not valid." });
    expect(db.inviteFindUnique).not.toHaveBeenCalled();
  });

  it("rejects an expired invite (canRedeem precedence)", async () => {
    // A well-formed token whose digest maps to an expired row.
    const { generateInviteToken } = await import("@/lib/invite-token");
    const raw = generateInviteToken();
    db.inviteFindUnique.mockResolvedValue({
      id: "inv-2",
      email: "new.member@example.test",
      role: "MEMBER",
      projectId: null,
      acceptedAt: null,
      expiresAt: new Date("2026-03-09T09:00:00.000Z"), // yesterday
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });
    const result = await acceptWorkspaceInviteAction(raw);
    expect(result).toEqual({ error: "That invitation has expired." });
    expect(db.workspaceMemberUpsert).not.toHaveBeenCalled();
  });

  it("rejects an already-used invite", async () => {
    const { generateInviteToken } = await import("@/lib/invite-token");
    const raw = generateInviteToken();
    db.inviteFindUnique.mockResolvedValue({
      id: "inv-3",
      email: "new.member@example.test",
      role: "MEMBER",
      projectId: null,
      acceptedAt: new Date("2026-03-10T08:00:00.000Z"),
      expiresAt: new Date("2026-03-24T09:00:00.000Z"),
      workspace: { id: "ws-1", name: "Acme", slug: "acme" },
    });
    const result = await acceptWorkspaceInviteAction(raw);
    expect(result).toEqual({ error: "That invitation has already been used." });
  });

  it("the module's decision agrees with an unexpired, unused invite", () => {
    const decision = canRedeem({
      expiresAt: new Date("2026-03-24T09:00:00.000Z"),
      usedAt: null,
      maxUses: 1,
      usedCount: 0,
    });
    expect(decision).toEqual({ ok: true, reason: null, remainingUses: 1 });
  });
});
