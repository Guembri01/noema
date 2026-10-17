import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B59 / audit H4 - calendar feed SSRF guard, exercised through the REAL
 * action (auth/permissions/db mocked the B19 way; only the network edge is
 * stubbed). Red-first: before the guard the action fetches private targets
 * and leaks the upstream status in `Could not read that calendar (<status>)`.
 *
 * The guard itself lives in `src/lib/feed-guard.ts` and reuses the
 * link-preview pattern (`src/app/api/link-preview/route.ts:44-46`).
 */

const db = vi.hoisted(() => ({
  calendarFeedCreate: vi.fn(),
  calendarFeedFindMany: vi.fn(),
  calendarFeedDelete: vi.fn(),
  calendarEventUpsert: vi.fn(),
  calendarEventFindUnique: vi.fn(),
  calendarEventFindFirst: vi.fn(),
  pageCreate: vi.fn(),
  pageUpdate: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
}));
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    calendarFeed: {
      create: db.calendarFeedCreate,
      findMany: db.calendarFeedFindMany,
      delete: db.calendarFeedDelete,
    },
    calendarEvent: {
      upsert: db.calendarEventUpsert,
      findUnique: db.calendarEventFindUnique,
      findFirst: db.calendarEventFindFirst,
    },
    page: {
      create: db.pageCreate,
      update: db.pageUpdate,
      findFirst: db.pageFindFirst,
      findUnique: db.pageFindUnique,
    },
    workspace: { findUnique: db.workspaceFindUnique },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "user-1" })) }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: vi.fn(() => true),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

import {
  connectCalendarFeedAction,
  refreshCalendarFeedsAction,
} from "./calendar";

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Noema//Test//EN",
  "BEGIN:VEVENT",
  "UID:evt-1@noema",
  "SUMMARY:Weekly sync",
  "DTSTART:20260115T090000Z",
  "DTEND:20260115T093000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const PRIVATE_TARGETS = [
  "http://127.0.0.1:5432/cal.ics",
  "http://10.0.0.1/admin",
  "http://169.254.169.254/latest/meta-data/",
  "http://metadata.google.internal/latest/meta-data/",
  "http://[::1]/feed.ics",
  "http://localhost:8080/feed.ics",
];

type ConnectResult = Awaited<ReturnType<typeof connectCalendarFeedAction>>;
type RefreshResult = Awaited<ReturnType<typeof refreshCalendarFeedsAction>>;

const failureOf = (result: ConnectResult | RefreshResult): string =>
  "error" in result ? result.error : "";

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));
  vi.stubGlobal("fetch", fetchSpy);
  dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  db.calendarFeedCreate.mockResolvedValue({ id: "feed-1" });
  db.calendarFeedFindMany.mockResolvedValue([]);
  db.calendarEventUpsert.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectCalendarFeedAction - SSRF guard (H4)", () => {
  it("rejects loopback/private/link-local/metadata targets without a single fetch", async () => {
    for (const icsUrl of PRIVATE_TARGETS) {
      const result = await connectCalendarFeedAction({
        workspaceId: "ws-1",
        name: "Feed",
        icsUrl,
      });
      expect(failureOf(result), icsUrl).not.toBe("");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.calendarFeedCreate).not.toHaveBeenCalled();
  });

  it("answers blocked and failed fetches with one uniform error (no status oracle)", async () => {
    const failed = await connectCalendarFeedAction({
      workspaceId: "ws-1",
      name: "Feed",
      icsUrl: "http://93.184.216.34/feed.ics",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    const blocked = await connectCalendarFeedAction({
      workspaceId: "ws-1",
      name: "Feed",
      icsUrl: "http://169.254.169.254/latest/meta-data/",
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(failureOf(failed)).not.toBe("");
    expect(failureOf(blocked)).toBe(failureOf(failed));
    // No `(500)`/`(network error)` fragments - nothing about the target leaks.
    expect(failureOf(failed)).not.toMatch(/\d/);
  });

  it("still fetches and imports a public feed (example.com-style)", async () => {
    fetchSpy.mockResolvedValue(new Response(FEED, { status: 200 }));
    const result = await connectCalendarFeedAction({
      workspaceId: "ws-1",
      name: "Team",
      icsUrl: "https://example.com/feed.ics",
    });
    expect(result).toEqual({ ok: true, id: "feed-1", imported: 1 });
    expect(db.calendarFeedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ icsUrl: "https://example.com/feed.ics" }),
      }),
    );
    expect(dns.lookup).toHaveBeenCalledWith("example.com", expect.objectContaining({ all: true }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized response streams by byte count without creating a feed", async () => {
    // Two million UTF-16 code units but four million UTF-8 bytes.
    fetchSpy.mockResolvedValue(new Response("💩".repeat(1_000_000)));
    const result = await connectCalendarFeedAction({
      workspaceId: "ws-1", name: "Team", icsUrl: "https://example.com/feed.ics",
    });
    expect(failureOf(result)).toBe("That calendar feed is too large.");
    expect(db.calendarFeedCreate).not.toHaveBeenCalled();
    expect(db.calendarEventUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ["missing body", new Response(null)],
    ["read failure", new Response(new ReadableStream({
      start(controller) { controller.error(new Error("read failed")); },
    }))],
  ])("returns a controlled error for %s", async (_label, response) => {
    fetchSpy.mockResolvedValue(response);
    const result = await connectCalendarFeedAction({
      workspaceId: "ws-1", name: "Team", icsUrl: "https://example.com/feed.ics",
    });
    expect(failureOf(result)).toBe("Could not read that calendar feed.");
    expect(db.calendarFeedCreate).not.toHaveBeenCalled();
  });
});

describe("refreshCalendarFeedsAction - SSRF guard (H4)", () => {
  it("never re-fetches stored private-host feeds", async () => {
    db.calendarFeedFindMany.mockResolvedValue([
      { id: "f1", icsUrl: "http://169.254.169.254/latest/meta-data/" },
      { id: "f2", icsUrl: "http://10.0.0.1/cal.ics" },
      { id: "f3", icsUrl: "http://127.0.0.1:9200/_cat/indices" },
    ]);
    const result = await refreshCalendarFeedsAction("ws-1");
    expect(result).toEqual({ ok: true, refreshed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-fetches public feeds", async () => {
    db.calendarFeedFindMany.mockResolvedValue([
      { id: "f1", icsUrl: "http://93.184.216.34/cal.ics" },
    ]);
    fetchSpy.mockResolvedValue(new Response(FEED, { status: 200 }));
    const result = await refreshCalendarFeedsAction("ws-1");
    expect(result).toEqual({ ok: true, refreshed: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("skips oversized feeds without importing events", async () => {
    db.calendarFeedFindMany.mockResolvedValue([
      { id: "f1", icsUrl: "http://93.184.216.34/cal.ics" },
    ]);
    fetchSpy.mockResolvedValue(new Response("💩".repeat(1_000_000)));
    const result = await refreshCalendarFeedsAction("ws-1");
    expect(result).toEqual({ ok: true, refreshed: 0 });
    expect(db.calendarEventUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ["missing body", new Response(null)],
    ["read failure", new Response(new ReadableStream({
      start(controller) { controller.error(new Error("read failed")); },
    }))],
    ["cancel failure", new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2_000_001)); },
      cancel() { throw new Error("cancel failed"); },
    }))],
  ])("skips a feed with %s", async (_label, response) => {
    db.calendarFeedFindMany.mockResolvedValue([
      { id: "f1", icsUrl: "http://93.184.216.34/cal.ics" },
    ]);
    fetchSpy.mockResolvedValue(response);
    const result = await refreshCalendarFeedsAction("ws-1");
    expect(result).toEqual({ ok: true, refreshed: 0 });
    expect(db.calendarEventUpsert).not.toHaveBeenCalled();
  });
});
