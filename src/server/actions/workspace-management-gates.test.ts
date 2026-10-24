import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the management and roster reads ask the same question as their writes.
 *
 * Five read actions answered "is a workspace member", which is also true for a
 * `GUEST`:
 *
 *  - `getEmailSummary` / `getAiProviderSummary` — the SMTP host, the sender
 *    address and the AI provider of the workspace. Their screens only show
 *    them to an admin, so the read now asks for an admin.
 *  - `listAutomationRulesAction` — the workspace's automations. Writing one
 *    asks for `canManageMembers`, so reading them asks the same.
 *  - `listRecurringTicketsAction` — the recurring ticket schedules. Writing
 *    one asks for `canEditContent`, so reading them asks the same.
 *  - `listProjectRolesAction` — the member roster (every member's name). It
 *    needs the member-directory permission.
 *  - `listOwnershipTransfersAction` — the ownership history. Starting a
 *    transfer is owner-only, so the history is management data too.
 *
 * The real role matrix runs here; only the transport edges are mocked.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  emailConfigFindUnique: vi.fn(),
  aiProviderConfigFindUnique: vi.fn(),
  workspaceMemberFindMany: vi.fn(),
  projectFindUnique: vi.fn(),
  projectMemberFindMany: vi.fn(),
  automationFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    emailConfig: { findUnique: h.emailConfigFindUnique },
    aiProviderConfig: { findUnique: h.aiProviderConfigFindUnique },
    workspaceMember: { findMany: h.workspaceMemberFindMany },
    project: { findUnique: h.projectFindUnique },
    projectMember: { findMany: h.projectMemberFindMany },
    automation: { findMany: h.automationFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));

import { getEmailSummary } from "./email";
import { getAiProviderSummary } from "./ai-settings";
import { listAutomationRulesAction, listRecurringTicketsAction } from "./automations";
import { listProjectRolesAction, listOwnershipTransfersAction } from "./workspaces";

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  h.emailConfigFindUnique.mockResolvedValue(null);
  h.aiProviderConfigFindUnique.mockResolvedValue(null);
  h.workspaceMemberFindMany.mockResolvedValue([]);
  h.projectFindUnique.mockResolvedValue({ id: "p1", workspaceId: "ws1", ownerId: "u2" });
  h.projectMemberFindMany.mockResolvedValue([]);
  h.automationFindMany.mockResolvedValue([]);
});

describe("getEmailSummary", () => {
  it("refuses a guest and never reads the configuration", async () => {
    expect(await getEmailSummary("ws1")).toBeNull();
    expect(h.emailConfigFindUnique).not.toHaveBeenCalled();
  });

  it("refuses a member — the settings screen only shows it to an admin", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    expect(await getEmailSummary("ws1")).toBeNull();
    expect(h.emailConfigFindUnique).not.toHaveBeenCalled();
  });

  it("serves an admin", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });

    expect(await getEmailSummary("ws1")).not.toBeNull();
  });
});

describe("getAiProviderSummary", () => {
  it("refuses a guest and never reads the configuration", async () => {
    expect(await getAiProviderSummary("ws1")).toBeNull();
    expect(h.aiProviderConfigFindUnique).not.toHaveBeenCalled();
  });

  it("serves an admin", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });

    expect(await getAiProviderSummary("ws1")).not.toBeNull();
  });
});

describe("listAutomationRulesAction", () => {
  it("refuses a guest", async () => {
    const result = await listAutomationRulesAction("ws1");

    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("serves an admin", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });

    const result = await listAutomationRulesAction("ws1");

    expect(result).toMatchObject({ ok: true });
  });
});

describe("listRecurringTicketsAction", () => {
  it("refuses a guest", async () => {
    const result = await listRecurringTicketsAction("ws1");

    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("serves a member", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await listRecurringTicketsAction("ws1");

    expect(result).toMatchObject({ ok: true });
  });
});

describe("listProjectRolesAction", () => {
  it("refuses a guest and never reads the roster", async () => {
    const result = await listProjectRolesAction("p1");

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(h.workspaceMemberFindMany).not.toHaveBeenCalled();
  });

  it("serves a member", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await listProjectRolesAction("p1");

    expect(result).toMatchObject({ ok: true });
  });
});

describe("listOwnershipTransfersAction", () => {
  it("refuses a guest", async () => {
    const result = await listOwnershipTransfersAction("ws1");

    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("serves an admin", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });

    const result = await listOwnershipTransfersAction("ws1");

    expect(result).toMatchObject({ ok: true });
  });
});
