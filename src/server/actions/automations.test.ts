import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * Automation rules + recurring tickets, now backed by the durable
 * `Automation` / `AutomationRun` tables.
 *
 * The pure engines (`@/lib/automations`, `@/lib/recurring-tickets`) and the
 * authorization matrix run for real. Only the transport edges are mocked:
 * `@/lib/auth`, `next/cache` and an in-memory Prisma delegate that implements
 * exactly the queries the actions issue (including the unique claim on
 * `AutomationRun`), so persistence and cron idempotency are exercised through
 * the real action code.
 */

const db = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    automations: [] as Row[],
    runs: [] as Row[],
    ticketCounter: 0,
    sequence: 0,
  };

  const clone = <T,>(value: T): T =>
    value === null || value === undefined ? value : structuredClone(value);

  const matches = (row: Row, where: Row): boolean => {
    for (const [key, value] of Object.entries(where)) {
      if (key === "OR") {
        if (!Array.isArray(value) || !value.some((clause) => matches(row, clause as Row))) {
          return false;
        }
        continue;
      }
      if (key === "ranAt") {
        const range = value as { gte?: Date };
        if (range?.gte && !((row.ranAt as Date) >= range.gte)) return false;
        continue;
      }
      if (row[key] !== value) return false;
    }
    return true;
  };

  const nextId = (prefix: string) => `${prefix}-${(state.sequence += 1)}`;

  const prisma = {
    workspaceMember: { findUnique: vi.fn() },
    workspace: {
      findUnique: vi.fn(async () => ({ name: "Demo", ownerId: "actor-1" })),
      update: vi.fn(async () => {
        state.ticketCounter += 1;
        return { ticketCounter: state.ticketCounter };
      }),
    },
    project: { findFirst: vi.fn() },
    label: { findMany: vi.fn(async () => []) },
    automation: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        state.automations.filter((row) => matches(row, where)).map(clone),
      ),
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const row = state.automations.find((candidate) => matches(candidate, where));
        return row ? clone(row) : null;
      }),
      findUnique: vi.fn(async ({ where }: { where: Row }) => {
        const row = state.automations.find((candidate) => candidate.id === where.id);
        return row ? clone(row) : null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row: Row = {
          kind: "rule",
          enabled: true,
          lastRunAt: null,
          nextRunAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        if (!row.id) row.id = nextId("automation");
        state.automations.push(row);
        return clone(row);
      }),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = state.automations.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("Row not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return clone(row);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const row of state.automations) {
          if (!matches(row, where)) continue;
          Object.assign(row, data, { updatedAt: new Date() });
          count += 1;
        }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        const removed = state.automations
          .filter((row) => matches(row, where))
          .map((row) => row.id);
        state.automations = state.automations.filter(
          (row) => !removed.includes(row.id),
        );
        state.runs = state.runs.filter(
          (run) => !removed.includes(run.automationId),
        );
        return { count: removed.length };
      }),
    },
    automationRun: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        state.runs.filter((row) => matches(row, where)).map(clone),
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const duplicate = state.runs.some(
          (row) =>
            row.automationId === data.automationId &&
            row.occurrenceKey === data.occurrenceKey,
        );
        if (duplicate) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row: Row = {
          id: nextId("run"),
          ranAt: new Date(),
          createdTicketIds: null,
          ...data,
        };
        state.runs.push(row);
        return clone(row);
      }),
    },
    ticket: {
      create: vi.fn(async ({ data }: { data: Row }) => ({
        id: nextId("ticket"),
        ...clone(data),
      })),
    },
  };

  const transaction = vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => {
    const snapshot = {
      automations: state.automations.map(clone),
      runs: state.runs.map(clone),
      ticketCounter: state.ticketCounter,
    };
    try {
      return await fn(prisma);
    } catch (error) {
      state.automations = snapshot.automations;
      state.runs = snapshot.runs;
      state.ticketCounter = snapshot.ticketCounter;
      throw error;
    }
  });

  return {
    state,
    prisma: {
      ...prisma,
      $transaction: transaction,
    },
    reset() {
      state.automations = [];
      state.runs = [];
      state.ticketCounter = 0;
      state.sequence = 0;
      for (const delegate of Object.values(prisma)) {
        for (const value of Object.values(delegate as Record<string, unknown>)) {
          if (typeof value === "function" && "mockClear" in value) {
            (value as { mockClear: () => void }).mockClear();
          }
        }
      }
      transaction.mockClear();
    },
    seedAutomation(row: Row) {
      state.automations.push({
        kind: "recurring_ticket",
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...row,
      });
    },
  };
});

vi.mock("@/lib/db", () => ({ prisma: db.prisma }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  deleteAutomationRuleAction,
  deleteRecurringTicketAction,
  dispatchAutomationEventAction,
  listAutomationRulesAction,
  listDueAutomationsForCronAction,
  listRecurringTicketsAction,
  materializeRecurringTicketRunAction,
  saveAutomationRuleAction,
  saveRecurringTicketAction,
  setRecurringTicketEnabledAction,
} from "./automations";

const SECRET = "automations-test-secret";

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  resetRateLimits();
  process.env.CRON_SECRET = SECRET;
  db.prisma.workspaceMember.findUnique.mockResolvedValue({ role: "OWNER" });
  // B132: the project lookup is tenant-scoped in the query, so a project of
  // another workspace exists but is never returned.
  db.prisma.project.findFirst.mockImplementation(
    async (args: { where: { id: string; workspaceId: string } }) =>
      args.where.id === "project-own" && args.where.workspaceId === "ws-1"
        ? { id: "project-own" }
        : null,
  );
});

afterEach(() => {
  delete process.env.CRON_SECRET;
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

  it("stores a valid rule durably and lists it back", async () => {
    const saved = await saveAutomationRuleAction({
      workspaceId: "ws-auto-1",
      name: "Notify on done",
      trigger: { event: "ticket.status_changed" },
      actions: [{ kind: "notify", message: "Ticket moved" }],
    });
    if (!("ok" in saved)) throw new Error(saved.error);

    // It is a real row, not process state.
    expect(db.state.automations).toHaveLength(1);
    expect(db.state.automations[0]).toMatchObject({
      id: saved.id,
      workspaceId: "ws-auto-1",
      kind: "rule",
    });

    const list = await listAutomationRulesAction("ws-auto-1");
    if (!("ok" in list)) throw new Error(list.error);
    expect(list.rules.map((rule) => rule.id)).toContain(saved.id);

    await expect(deleteAutomationRuleAction("ws-auto-1", saved.id)).resolves.toEqual({
      ok: true,
    });
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

  it("exposes schedule rules to the cron route only behind CRON_SECRET", async () => {
    await saveAutomationRuleAction({
      workspaceId: "ws-cron",
      name: "Scheduled",
      trigger: { event: "schedule" },
      actions: [{ kind: "notify", message: "tick" }],
    });

    await expect(listDueAutomationsForCronAction("wrong")).resolves.toEqual({
      error: "Unauthorized",
    });
    const due = await listDueAutomationsForCronAction(SECRET);
    if (!("ok" in due)) throw new Error(due.error);
    expect(due.scheduled).toHaveLength(1);
    expect(due.scheduled[0].trigger.event).toBe("schedule");
  });
});

describe("recurring tickets — authorization", () => {
  it("fails closed for a guest on every recurring-ticket action", async () => {
    db.prisma.workspaceMember.findUnique.mockResolvedValue({ role: "GUEST" });

    const saved = await saveRecurringTicketAction({
      workspaceId: "ws-1",
      title: "Weekly report",
      rule: { freq: "weekly", interval: 1 },
    });
    expect(saved).toMatchObject({ error: expect.stringContaining("permission") });

    const list = await listRecurringTicketsAction("ws-1");
    expect(list).toMatchObject({ error: expect.stringContaining("permission") });

    const paused = await setRecurringTicketEnabledAction({
      workspaceId: "ws-1",
      id: "recurring-1",
      enabled: false,
    });
    expect(paused).toMatchObject({ error: expect.stringContaining("permission") });

    const deleted = await deleteRecurringTicketAction("ws-1", "recurring-1");
    expect(deleted).toMatchObject({ error: expect.stringContaining("permission") });

    // Nothing was read or written.
    expect(db.state.automations).toHaveLength(0);
  });

  it("refuses a project of another workspace (B132)", async () => {
    const result = await saveRecurringTicketAction({
      workspaceId: "ws-1",
      title: "Weekly report",
      projectId: "project-foreign",
      rule: { freq: "weekly", interval: 1 },
    });

    expect("error" in result ? result.error : "").toBe(
      "That project does not exist in this workspace.",
    );
    expect("error" in result ? result.error : "").not.toContain("project-foreign");
  });

  it("keeps a project of the caller's workspace", async () => {
    const result = await saveRecurringTicketAction({
      workspaceId: "ws-1",
      title: "Weekly report",
      projectId: "project-own",
      rule: { freq: "weekly", interval: 1 },
    });

    expect(result).toEqual({ ok: true, id: expect.any(String) });
  });

  it("refuses to edit or delete a schedule of another workspace", async () => {
    const saved = await saveRecurringTicketAction({
      workspaceId: "ws-1",
      title: "Weekly report",
      rule: { freq: "weekly", interval: 1 },
    });
    if (!("ok" in saved)) throw new Error(saved.error);

    const edited = await saveRecurringTicketAction({
      workspaceId: "ws-2",
      id: saved.id,
      title: "Hijack",
      rule: { freq: "daily", interval: 1 },
    });
    expect(edited).toMatchObject({ error: "Recurring ticket not found." });

    const deleted = await deleteRecurringTicketAction("ws-2", saved.id);
    expect(deleted).toMatchObject({ error: "Recurring ticket not found." });
    expect(db.state.automations).toHaveLength(1);
  });
});

describe("recurring tickets — validation and persistence", () => {
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

  it("creates, lists, pauses, resumes and deletes a durable schedule", async () => {
    const saved = await saveRecurringTicketAction({
      workspaceId: "ws-recur-life",
      title: "Weekly report",
      rule: { freq: "weekly", interval: 2, byWeekday: ["tue", "thu"] },
    });
    if (!("ok" in saved)) throw new Error(saved.error);

    // Durable row with the normalized rule and a baseline.
    expect(db.state.automations).toHaveLength(1);
    expect(db.state.automations[0]).toMatchObject({
      id: saved.id,
      workspaceId: "ws-recur-life",
      kind: "recurring_ticket",
      enabled: true,
    });
    expect(db.state.automations[0].lastRunAt).toBeInstanceOf(Date);

    const listed = await listRecurringTicketsAction("ws-recur-life");
    if (!("ok" in listed)) throw new Error(listed.error);
    expect(listed.tickets).toHaveLength(1);
    expect(listed.tickets[0]).toMatchObject({
      id: saved.id,
      title: "Weekly report",
      enabled: true,
      summary: "Every 2 weeks on Tue, Thu",
    });
    expect(listed.tickets[0].nextRunAt).toEqual(expect.any(String));

    const paused = await setRecurringTicketEnabledAction({
      workspaceId: "ws-recur-life",
      id: saved.id,
      enabled: false,
    });
    expect(paused).toEqual({ ok: true, enabled: false, nextRunAt: null });
    expect(db.state.automations[0].enabled).toBe(false);
    expect(db.state.automations[0].nextRunAt).toBeNull();

    const resumed = await setRecurringTicketEnabledAction({
      workspaceId: "ws-recur-life",
      id: saved.id,
      enabled: true,
    });
    expect(resumed).toMatchObject({ ok: true, enabled: true });
    expect(db.state.automations[0].enabled).toBe(true);

    await expect(
      deleteRecurringTicketAction("ws-recur-life", saved.id),
    ).resolves.toEqual({ ok: true });
    expect(db.state.automations).toHaveLength(0);

    const after = await listRecurringTicketsAction("ws-recur-life");
    if (!("ok" in after)) throw new Error(after.error);
    expect(after.tickets).toHaveLength(0);
  });
});

describe("recurring tickets — cron materialization", () => {
  const RULE = {
    freq: "daily",
    interval: 1,
    start: "2026-01-01T00:00:00.000Z",
  };

  const seedSchedule = async () => {
    const saved = await saveRecurringTicketAction({
      workspaceId: "ws-cron",
      title: "Daily standup",
      templateId: "tmpl",
      rule: RULE,
    });
    if (!("ok" in saved)) throw new Error(saved.error);
    const row = db.state.automations.find((candidate) => candidate.id === saved.id);
    if (!row) throw new Error("schedule row missing");
    // The baseline is explicit so the window is deterministic.
    row.lastRunAt = new Date("2026-01-01T12:00:00.000Z");
    return saved.id;
  };

  it("creates one ticket per due occurrence and writes durable claims", async () => {
    const id = await seedSchedule();
    const result = await materializeRecurringTicketRunAction({
      secret: SECRET,
      id,
      now: "2026-01-03T12:00:00.000Z",
    });
    if (!("ok" in result)) throw new Error(result.error);

    expect(result.created).toBe(2);
    expect(db.prisma.ticket.create).toHaveBeenCalledTimes(2);
    expect(db.state.runs.map((run) => run.occurrenceKey)).toEqual([
      "tmpl:2026-01-02T00:00:00.000Z",
      "tmpl:2026-01-03T00:00:00.000Z",
    ]);
    expect(db.state.automations[0].lastRunAt).toEqual(
      new Date("2026-01-03T12:00:00.000Z"),
    );
  });

  it("creates once when the same occurrence is ticked twice", async () => {
    const id = await seedSchedule();
    const first = await materializeRecurringTicketRunAction({
      secret: SECRET,
      id,
      now: "2026-01-03T12:00:00.000Z",
    });
    const second = await materializeRecurringTicketRunAction({
      secret: SECRET,
      id,
      now: "2026-01-03T12:00:00.000Z",
    });
    if (!("ok" in first) || !("ok" in second)) throw new Error("run failed");

    expect(first.created).toBe(2);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(true);
    expect(db.prisma.ticket.create).toHaveBeenCalledTimes(2);
    expect(db.state.runs).toHaveLength(2);
  });

  it("does not duplicate after a crash (claims kept, baseline rolled back)", async () => {
    const id = await seedSchedule();
    await materializeRecurringTicketRunAction({
      secret: SECRET,
      id,
      now: "2026-01-03T12:00:00.000Z",
    });

    // Simulate a crash after the tickets/claims were written but before the
    // baseline advanced: the durable claims still prevent a second create.
    db.state.automations[0].lastRunAt = new Date("2026-01-01T12:00:00.000Z");
    const retry = await materializeRecurringTicketRunAction({
      secret: SECRET,
      id,
      now: "2026-01-03T12:00:00.000Z",
    });
    if (!("ok" in retry)) throw new Error(retry.error);

    expect(retry.created).toBe(0);
    expect(db.prisma.ticket.create).toHaveBeenCalledTimes(2);
    expect(db.state.runs).toHaveLength(2);
  });

  it("does not spawn a paused schedule, and cron does not list it", async () => {
    const id = await seedSchedule();
    await setRecurringTicketEnabledAction({
      workspaceId: "ws-cron",
      id,
      enabled: false,
    });

    const due = await listDueAutomationsForCronAction(SECRET);
    if (!("ok" in due)) throw new Error(due.error);
    expect(due.recurring).toHaveLength(0);

    const result = await materializeRecurringTicketRunAction({
      secret: SECRET,
      id,
      now: "2026-01-03T12:00:00.000Z",
    });
    if (!("ok" in result)) throw new Error(result.error);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(true);
    expect(db.prisma.ticket.create).not.toHaveBeenCalled();
  });
});
