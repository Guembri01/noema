import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * `POST /api/cron/tickets` — recurring-ticket materialization + idempotency.
 *
 * The recurrence maths runs for real (`@/lib/recurring-tickets`); only the rule
 * store (`@/server/actions/automations`) and the database edge (`@/lib/db`) are
 * mocked. Pins: the fail-closed secret guard (503/401), one draft per due
 * occurrence, and that a retried tick after a crash — baseline rolled back but
 * keys already persisted — never double-creates.
 */

type RecurringRow = {
  id: string;
  workspaceId: string;
  templateId: string;
  title: string;
  projectId: string | null;
  priority: string | null;
  labels: string[];
  rule: unknown;
  createdById: string;
  lastSpawnedAt: number | null;
  materializedKeys: string[];
};

const store = vi.hoisted(() => ({
  records: [] as RecurringRow[],
  commits: [] as { id: string; keys: string[]; spawnedAt: string }[],
}));

vi.mock("@/server/actions/automations", () => ({
  listDueAutomationsForCronAction: vi.fn(async () => ({
    ok: true,
    scheduled: [],
    recurring: store.records,
  })),
  commitRecurringRunAction: vi.fn(
    async (input: { id: string; keys: string[]; spawnedAt: string }) => {
      store.commits.push(input);
      const record = store.records.find((row) => row.id === input.id);
      if (record) {
        record.materializedKeys = [...new Set([...record.materializedKeys, ...input.keys])];
        record.lastSpawnedAt = new Date(input.spawnedAt).getTime();
      }
      return { ok: true };
    },
  ),
}));

const db = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  workspaceUpdate: vi.fn(),
  ticketCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: db.workspaceFindUnique, update: db.workspaceUpdate },
    ticket: { create: db.ticketCreate },
  },
}));

import { POST } from "./route";

const SECRET = "cron-test-secret";
const NOW = "2026-01-03T12:00:00.000Z";
const RULE = { freq: "daily", interval: 1, start: "2026-01-01T00:00:00.000Z" };

let counter = 0;

function seed(lastSpawnedAt: string | null, materializedKeys: string[] = []) {
  store.records.push({
    id: "r1",
    workspaceId: "ws-1",
    templateId: "tmpl-1",
    title: "Daily standup",
    projectId: "p1",
    priority: "high",
    labels: [],
    rule: RULE,
    createdById: "user-1",
    lastSpawnedAt: lastSpawnedAt ? Date.parse(lastSpawnedAt) : null,
    materializedKeys,
  });
}

const call = (headers: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost/api/cron/tickets", {
      method: "POST",
      headers: {
        "x-cron-secret": SECRET,
        "x-forwarded-for": "10.57.0.1",
        ...headers,
      },
    }),
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.CRON_SECRET = SECRET;
  store.records = [];
  store.commits = [];
  counter = 0;
  vi.clearAllMocks();
  resetRateLimits();
  db.workspaceFindUnique.mockResolvedValue({ name: "Demo" });
  db.workspaceUpdate.mockImplementation(async () => ({ ticketCounter: (counter += 1) }));
  db.ticketCreate.mockResolvedValue({ id: "t" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/cron/tickets — guards", () => {
  it("fails closed when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const response = await call();
    expect(response.status).toBe(503);
  });

  it("rejects a wrong secret", async () => {
    const response = await call({ "x-cron-secret": "nope" });
    expect(response.status).toBe(401);
  });
});

describe("POST /api/cron/tickets — materialization", () => {
  it("creates one ticket per due occurrence and records the idempotency keys", async () => {
    seed("2026-01-01T12:00:00.000Z");
    const response = await call();
    const body = await response.json();

    expect(body.recurring.created).toBe(2);
    const starts = db.ticketCreate.mock.calls.map((call) =>
      (call[0] as { data: { startDate: Date } }).data.startDate.toISOString(),
    );
    expect(starts).toEqual(["2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]);
    expect(store.commits[0].keys).toEqual([
      "tmpl-1:2026-01-02T00:00:00.000Z",
      "tmpl-1:2026-01-03T00:00:00.000Z",
    ]);
    expect(store.records[0].lastSpawnedAt).toBe(Date.parse(NOW));
  });

  it("does not duplicate a ticket after a crash (keys kept, baseline rolled back)", async () => {
    seed("2026-01-01T12:00:00.000Z");
    await call();
    const created = db.ticketCreate.mock.calls.length;

    // Simulate a crash *after* the tickets were written but before the commit:
    // the store still has the keys, but the baseline never advanced.
    store.records[0].lastSpawnedAt = Date.parse("2026-01-01T12:00:00.000Z");
    const response = await call();
    const body = await response.json();

    expect(body.recurring.created).toBe(0);
    expect(body.recurring.skipped).toBe(1);
    expect(db.ticketCreate.mock.calls.length).toBe(created);
  });
});
