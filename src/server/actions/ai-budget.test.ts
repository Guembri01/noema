import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R25.13/R25.14 — settings authorization and scoping.
 *
 * Writes are workspace-manager gated and reads return `null` to everyone else;
 * every query is scoped to the workspace the action was called with, so one
 * workspace can never read or reset another's spend.
 */

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const permissions = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canManageMembers: vi.fn(),
}));
const db = vi.hoisted(() => ({
  prisma: {
    aiBudget: { findUnique: vi.fn(), upsert: vi.fn() },
    aiUsage: {
      findMany: vi.fn(),
      aggregate: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
    aiProviderConfig: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: permissions.getWorkspaceAccess,
  canManageMembers: permissions.canManageMembers,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/ai-provider", () => ({
  chatComplete: vi.fn(),
  listProviderModels: vi.fn(),
  resolveAiConfig: vi.fn(),
}));

import {
  getAiBudgetSummary,
  resetAiUsageAction,
  saveAiBudgetAction,
} from "@/server/actions/ai-settings";
import { budgetPeriod } from "@/lib/ai-metering";

const WORKSPACE = "clx1a2b3c4d5e6f7g8h9i0jkl";
const OTHER_WORKSPACE = "clx9z8y7x6w5v4u3t2s1r0qpo";
const PERIOD = budgetPeriod();

function grant(role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST" | null) {
  permissions.getWorkspaceAccess.mockResolvedValue(role ? { role } : null);
  permissions.canManageMembers.mockImplementation(
    (value: string) => value === "OWNER" || value === "ADMIN",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "u1" });
  grant("ADMIN");
  db.prisma.aiBudget.findUnique.mockResolvedValue({
    monthlyTokenLimit: 1000,
    warnPercent: 80,
    hardStop: true,
  });
  db.prisma.aiBudget.upsert.mockResolvedValue({});
  db.prisma.aiUsage.findMany.mockResolvedValue([
    { surface: "ask", tokensIn: 600, tokensOut: 100, requests: 2, failures: 0 },
    { surface: "chat", tokensIn: 100, tokensOut: 50, requests: 1, failures: 1 },
  ]);
  db.prisma.aiUsage.deleteMany.mockResolvedValue({ count: 2 });
});

describe("getAiBudgetSummary — reads never leak another workspace", () => {
  it("returns the current month for an admin, scoped to the workspace", async () => {
    const summary = await getAiBudgetSummary(WORKSPACE);

    expect(summary).toMatchObject({
      period: PERIOD,
      configured: true,
      monthlyTokenLimit: 1000,
      warnPercent: 80,
      hardStop: true,
      usedTokens: 850,
      tokensIn: 700,
      tokensOut: 150,
      requests: 3,
      failures: 1,
      percent: 85,
      state: "warn",
      remainingTokens: 150,
    });
    expect(summary?.bySurface.map((row) => row.surface)).toEqual(["ask", "chat"]);
    expect(db.prisma.aiUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WORKSPACE, period: PERIOD } }),
    );
    expect(db.prisma.aiBudget.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WORKSPACE } }),
    );
  });

  it("returns null for a member without querying usage", async () => {
    grant("MEMBER");
    expect(await getAiBudgetSummary(WORKSPACE)).toBeNull();
    expect(db.prisma.aiUsage.findMany).not.toHaveBeenCalled();
    expect(db.prisma.aiBudget.findUnique).not.toHaveBeenCalled();
  });

  it("returns null for a non-member and a guest", async () => {
    grant(null);
    expect(await getAiBudgetSummary(OTHER_WORKSPACE)).toBeNull();
    grant("GUEST");
    expect(await getAiBudgetSummary(OTHER_WORKSPACE)).toBeNull();
    expect(db.prisma.aiUsage.findMany).not.toHaveBeenCalled();
  });
});

describe("saveAiBudgetAction — manager-gated writes", () => {
  it("refuses a member and never writes", async () => {
    grant("MEMBER");
    const result = await saveAiBudgetAction({
      workspaceId: WORKSPACE,
      monthlyTokenLimit: 5000,
      warnPercent: 70,
      hardStop: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toMatch(/admin/i);
    expect(db.prisma.aiBudget.upsert).not.toHaveBeenCalled();
  });

  it("refuses invalid numbers before touching the database", async () => {
    const negative = await saveAiBudgetAction({
      workspaceId: WORKSPACE,
      monthlyTokenLimit: -1,
    });
    const warnOutOfRange = await saveAiBudgetAction({
      workspaceId: WORKSPACE,
      monthlyTokenLimit: 1000,
      warnPercent: 101,
    });

    expect(negative.ok).toBe(false);
    expect(warnOutOfRange.ok).toBe(false);
    expect(db.prisma.aiBudget.upsert).not.toHaveBeenCalled();
  });

  it("upserts the ceiling for an admin with the caller as the updater", async () => {
    const result = await saveAiBudgetAction({
      workspaceId: WORKSPACE,
      monthlyTokenLimit: 250_000,
      warnPercent: 75,
      hardStop: false,
    });

    expect(result).toEqual({ ok: true });
    expect(db.prisma.aiBudget.upsert).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE },
      create: {
        workspaceId: WORKSPACE,
        monthlyTokenLimit: 250_000,
        warnPercent: 75,
        hardStop: false,
        updatedById: "u1",
      },
      update: {
        monthlyTokenLimit: 250_000,
        warnPercent: 75,
        hardStop: false,
        updatedById: "u1",
      },
    });
  });
});

describe("resetAiUsageAction — manager-gated current period", () => {
  it("refuses a non-manager and never deletes", async () => {
    grant("MEMBER");
    const result = await resetAiUsageAction(WORKSPACE);

    expect(result.ok).toBe(false);
    expect(db.prisma.aiUsage.deleteMany).not.toHaveBeenCalled();
  });

  it("clears only the named workspace's current period for an admin", async () => {
    const result = await resetAiUsageAction(WORKSPACE);

    expect(result).toEqual({ ok: true, removed: 2 });
    expect(db.prisma.aiUsage.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, period: PERIOD },
    });
    expect(db.prisma.aiUsage.deleteMany).not.toHaveBeenCalledWith({
      where: { workspaceId: OTHER_WORKSPACE, period: PERIOD },
    });
  });
});
