import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * B53 (nach-verify) — the **export** half of the calendar feature.
 *
 * The parser (`src/lib/ics.ts`) drops a non-allowlisted `URL:` property before
 * it is stored and the meetings sidebar re-checks the value before it becomes
 * an `href`, but `GET /api/calendar?format=ics` re-emitted the *stored* value
 * verbatim. A row written before the parser was fixed therefore left the
 * server again as `URL:javascript:…` in the downloaded feed, and a CRLF in a
 * stored value injected arbitrary ICS properties into the exported document.
 * The JSON response handed the same stored value to every client.
 *
 * Both now run the stored value through the same `sanitizeHref` allowlist the
 * parser uses, so what leaves the server is exactly what the parser would
 * have stored — import and export agree on the stored form.
 *
 * Only the transport edges (auth, permissions, queries, db, server actions)
 * are mocked; the rate limiter, the row → ICS mapping and the ICS builder run
 * for real.
 */

const edge = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  getUpcomingEvents: vi.fn(),
  getCalendarFeeds: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: edge.getCurrentUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: edge.getWorkspaceAccess,
  canEditContent: () => true,
}));
vi.mock("@/server/queries", () => ({
  getUpcomingEvents: edge.getUpcomingEvents,
  getCalendarFeeds: edge.getCalendarFeeds,
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/server/actions/calendar", () => ({
  connectCalendarFeedAction: vi.fn(),
  createMeetingNoteAction: vi.fn(),
  disconnectCalendarFeedAction: vi.fn(),
  refreshCalendarFeedsAction: vi.fn(),
}));

import { GET } from "./route";
import { parseIcsEvents } from "@/lib/ics";

/** One stored `CalendarEvent` row, as `getUpcomingEvents` returns it. */
const row = (over: Record<string, unknown> = {}) => ({
  id: "ev-1",
  title: "Quarterly review",
  start: new Date("2026-01-15T09:00:00.000Z"),
  end: new Date("2026-01-15T09:30:00.000Z"),
  allDay: false,
  location: "Room 1",
  url: null as string | null,
  notesPageId: null,
  feed: { name: "Team", color: "#3b82f6" },
  ...over,
});

const exportIcs = async (rows: unknown[]): Promise<string> => {
  edge.getUpcomingEvents.mockResolvedValue(rows);
  const res = await GET(
    new Request("http://localhost/api/calendar?workspaceId=ws-1&format=ics", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/calendar");
  return res.text();
};

/** The `URL:` property lines of an exported feed. */
const urlLines = (ics: string): string[] =>
  ics.split("\r\n").filter((line) => line.startsWith("URL:"));

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
  edge.getWorkspaceAccess.mockResolvedValue({ role: "owner" });
  edge.getCalendarFeeds.mockResolvedValue([]);
  edge.getUpcomingEvents.mockResolvedValue([]);
});

describe("GET /api/calendar?format=ics — the exported URL", () => {
  it("exports a stored https URL", async () => {
    const ics = await exportIcs([row({ url: "https://example.com/meet" })]);
    expect(urlLines(ics)).toEqual(["URL:https://example.com/meet"]);
  });

  it("never exports a stored javascript: URL", async () => {
    const ics = await exportIcs([row({ url: "javascript:alert(1)" })]);
    expect(ics).not.toContain("javascript:");
    expect(urlLines(ics)).toEqual([]);
  });

  it("never exports an obfuscated javascript: URL", async () => {
    const ics = await exportIcs([row({ url: "java\tscript:alert(1)" })]);
    expect(ics).not.toContain("script:alert(1)");
    expect(urlLines(ics)).toEqual([]);
  });

  it("never exports any other scheme", async () => {
    for (const url of [
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "ftp://example.com/meet",
      "//evil.tld/meet",
    ]) {
      const ics = await exportIcs([row({ url })]);
      expect(urlLines(ics)).toEqual([]);
      expect(ics).not.toContain(url);
    }
  });

  it("does not let a stored CRLF inject an ICS property", async () => {
    const ics = await exportIcs([
      row({ url: "https://example.com/x\r\nX-INJECTED:yes" }),
    ]);
    expect(ics.split("\r\n").some((line) => line.startsWith("X-INJECTED:"))).toBe(
      false,
    );
    expect(urlLines(ics)).toHaveLength(1);
  });

  it("keeps the allowlisted schemes and relative targets", async () => {
    const ics = await exportIcs([
      row({ id: "a", url: "mailto:team@example.com" }),
      row({ id: "b", url: "tel:+33123456789" }),
      row({ id: "c", url: "/w/acme/page" }),
    ]);
    expect(urlLines(ics)).toEqual([
      "URL:mailto:team@example.com",
      "URL:tel:+33123456789",
      "URL:/w/acme/page",
    ]);
  });

  it("exports exactly the value the parser stored", async () => {
    const feed = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:evt-1@noema",
      "SUMMARY:Quarterly review",
      "URL:https://example.com/a\u0001b",
      "DTSTART:20260115T090000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const [parsed] = parseIcsEvents(feed);
    // The parser normalises the value (the control character is stripped); the
    // export must emit that stored form unchanged, not normalise it again.
    expect(parsed.url).toBe("https://example.com/ab");
    const ics = await exportIcs([row({ url: parsed.url })]);
    expect(urlLines(ics)).toEqual([`URL:${parsed.url}`]);
    expect(urlLines(ics)[0]).toBe("URL:https://example.com/ab");
  });
});

describe("GET /api/calendar — the JSON url field", () => {
  const exportJson = async (rows: unknown[]) => {
    edge.getUpcomingEvents.mockResolvedValue(rows);
    const res = await GET(
      new Request("http://localhost/api/calendar?workspaceId=ws-1", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { events: { url: string | null }[] };
  };

  it("keeps an allowlisted url", async () => {
    const body = await exportJson([row({ url: "https://example.com/meet" })]);
    expect(body.events[0].url).toBe("https://example.com/meet");
  });

  it("never hands a stored javascript: URL to a client", async () => {
    const body = await exportJson([row({ url: "javascript:alert(1)" })]);
    expect(body.events[0].url).toBeNull();
  });

  it("never hands a stored CRLF to a client", async () => {
    const body = await exportJson([
      row({ url: "https://example.com/x\r\nX-INJECTED:yes" }),
    ]);
    expect(body.events[0].url).toBe("https://example.com/xX-INJECTED:yes");
  });
});
