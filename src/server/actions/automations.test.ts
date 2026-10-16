import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Automation rule store + dispatcher (`@/server/actions/automations`), the
 * reachable surface over `@/lib/automations` and `@/lib/recurring-tickets`.
 * Only the transport edges are mocked; the engines validate and plan for real.
 */

const db = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findUnique: db.memberFindUnique },
    workspace: { findUnique: db.workspaceFindUnique },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  deleteAutomationRuleAction,
  deleteRecurringTicketAction,
  dispatchAutomationEventAction,
  listAutomationRulesAction,
  listDueAutomationsForCronAction,
  listRecurringTicketsAction,
  saveAutomationRuleAction,
  saveRecurringTicketAction,
} from "./automations";

beforeEach(() => {
  vi.clearAllMocks();
  db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
});

describe("automation rules", () => {
  it("rejects a malformed rule with field-level issues", async () => {
    const result = await saveAutomationRuleAction({
      workspaceId: "ws-auto-bad",
      trigger: { event: "ticket.status_changed" },
      actions: [],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("This automation is not valid.");
      expect(result.issues?.length).toBeGreaterThan(0);
    }
  });

  it("stores a valid rule and lists it back", async () => {
    const saved = await saveAutomationRuleAction({
      workspaceId: "ws-auto-1",
      name: "Notify on done",
      trigger: { event: "ticket.status_changed" },
      actions: [{ kind: "notify", message: "Ticket moved" }],
    });
    if (!("ok" in saved)) throw new Error(saved.error);

    const list = await listAutomationRulesAction("ws-auto-1");
    if (!("ok" in list)) throw new Error(list.error);
    expect(list.rules.map((rule) => rule.id)).toContain(saved.id);

    await expect(deleteAutomationRuleAction("ws-auto-1", saved.id)).resolves.toEqual({ ok: true });
    const after = await listAutomationRulesAction("ws-auto-1");
    if (!("ok" in after)) throw new Error(after.error);
    expect(after.rules.map((rule) => rule.id)).not.toContain(saved.id);
  });

  it("plans a matching event through the automations engine", async () => {
    await saveAutomationRuleAction({
      workspaceId: "ws-dispatch",
      name: "Ping",
      trigger: { event: "ticket.status_changed" },
      actions: [{ kind: "notify", message: "Moved to {{status}}" }],
    });
    const result = await dispatchAutomationEventAction(
      "ws-dispatch",
      { kind: "ticket.status_changed", fields: { status: "done" } },
      { now: "2026-01-01T00:00:00.000Z" },
    );
    if (!("ok" in result)) throw new Error(result.error);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({ status: "planned", runnable: true });
  });
});

describe("recurring tickets", () => {
  it("validates the recurrence rule with parseRule", async () => {
    await expect(
      saveRecurringTicketAction({
        workspaceId: "ws-recur",
        title: "Standup",
        rule: { freq: "hourly" },
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("freq") });

    const saved = await saveRecurringTicketAction({
      workspaceId: "ws-recur",
      title: "Standup",
      rule: { freq: "weekly", interval: 1, byWeekday: ["mon"] },
    });
    expect(saved).toMatchObject({ ok: true });
  });

  it("lists and deletes recurring ticket schedules", async () => {
    const saved = await saveRecurringTicketAction({
      workspaceId: "ws-recur-list",
      title: "Weekly report",
      rule: { freq: "weekly", interval: 1 },
    });
    if (!("ok" in saved)) throw new Error(saved.error);

    const list = await listRecurringTicketsAction("ws-recur-list");
    if (!("ok" in list)) throw new Error(list.error);
    expect(list.tickets.map((ticket) => ticket.id)).toContain(saved.id);

    await expect(deleteRecurringTicketAction("ws-recur-list", saved.id)).resolves.toEqual({ ok: true });
    const after = await listRecurringTicketsAction("ws-recur-list");
    if (!("ok" in after)) throw new Error(after.error);
    expect(after.tickets.map((ticket) => ticket.id)).not.toContain(saved.id);
  });

  it("exposes schedule rules to the cron route only behind CRON_SECRET", async () => {
    await saveAutomationRuleAction({
      workspaceId: "ws-cron",
      name: "Scheduled",
      trigger: { event: "schedule" },
      actions: [{ kind: "notify", message: "tick" }],
    });
    process.env.CRON_SECRET = "secret-1";

    await expect(listDueAutomationsForCronAction("wrong")).resolves.toEqual({ error: "Unauthorized" });
    const due = await listDueAutomationsForCronAction("secret-1");
    if (!("ok" in due)) throw new Error(due.error);
    expect(due.scheduled).toHaveLength(1);
    expect(due.scheduled[0].trigger.event).toBe("schedule");
  });
});
