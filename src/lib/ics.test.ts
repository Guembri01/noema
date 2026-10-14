import { describe, expect, it } from "vitest";
import {
  buildCalendar,
  escapeText,
  foldLine,
  isAllowedFeedUrl,
  normalizeFeedUrl,
  parseIcsDate,
  parseIcsEvents,
} from "./ics";

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Noema//Test//EN",
  "BEGIN:VEVENT",
  "UID:evt-1@noema",
  "SUMMARY:Weekly sync",
  "LOCATION:Room 1",
  "DTSTART:20260115T090000Z",
  "DTEND:20260115T093000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:evt-2@noema",
  "SUMMARY:All day\\, offsite",
  "DTSTART;VALUE=DATE:20260116",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:evt-3@noema",
  "SUMMARY:Long title that was folded in the ",
  " ics payload",
  "DTSTART;TZID=Europe/Paris:20260117T140000",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcsEvents", () => {
  it("extracts events in chronological order", () => {
    const events = parseIcsEvents(FEED);
    expect(events.map((event) => event.uid)).toEqual([
      "evt-1@noema",
      "evt-2@noema",
      "evt-3@noema",
    ]);
  });

  it("reads timestamps, all-day flags, locations and end times", () => {
    const [first, second] = parseIcsEvents(FEED);
    expect(first.title).toBe("Weekly sync");
    expect(first.start.toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(first.end?.toISOString()).toBe("2026-01-15T09:30:00.000Z");
    expect(first.allDay).toBe(false);
    expect(first.location).toBe("Room 1");
    expect(second.allDay).toBe(true);
    expect(second.end).toBeNull();
  });

  it("unescapes text and joins folded lines", () => {
    const [, , third] = parseIcsEvents(FEED);
    expect(third.title).toBe("Long title that was folded in the ics payload");
    expect(third.start.toISOString()).toBe("2026-01-17T14:00:00.000Z");
    expect(parseIcsEvents(FEED)[1].title).toBe("All day, offsite");
  });

  it("ignores events without a start or uid", () => {
    const events = parseIcsEvents(
      ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "SUMMARY:No start", "END:VEVENT", "END:VCALENDAR"].join("\n"),
    );
    expect(events).toHaveLength(0);
  });

  it("returns nothing for empty input", () => {
    expect(parseIcsEvents("")).toEqual([]);
  });
});

describe("parseIcsDate", () => {
  it("parses date values and utc date-times", () => {
    expect(parseIcsDate("20260116", {})).toEqual({
      date: new Date(Date.UTC(2026, 0, 16)),
      allDay: true,
    });
    expect(parseIcsDate("20260116", { VALUE: "DATE" })?.allDay).toBe(true);
    expect(parseIcsDate("20260115T090000Z", {})?.date.toISOString()).toBe(
      "2026-01-15T09:00:00.000Z",
    );
  });

  it("rejects unparseable values", () => {
    expect(parseIcsDate("not-a-date", {})).toBeNull();
    expect(parseIcsDate("", {})).toBeNull();
  });
});

describe("feed urls", () => {
  it("only allows http(s)", () => {
    expect(isAllowedFeedUrl("https://example.com/cal.ics")).toBe(true);
    expect(isAllowedFeedUrl("http://example.com/cal.ics")).toBe(true);
    expect(isAllowedFeedUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedFeedUrl("not a url")).toBe(false);
  });

  it("rewrites webcal to https", () => {
    expect(normalizeFeedUrl("webcal://example.com/cal.ics")).toBe(
      "https://example.com/cal.ics",
    );
    expect(normalizeFeedUrl(" https://example.com/cal.ics ")).toBe(
      "https://example.com/cal.ics",
    );
  });
});

/**
 * ICS export — the outbound half of calendar subscriptions (RFC 5545 §3.1,
 * §3.6.1). Written RED-first: `buildCalendar`, `foldLine` and `escapeText` did
 * not exist, so this block failed at compile time (TS2305) and at runtime
 * before the builder landed. The contract pinned here:
 *
 * - CRLF line endings, every line folded to at most 75 octets, a trailing CRLF;
 * - TEXT escaping for `\`, `;`, `,` and newlines (SUMMARY/DESCRIPTION/LOCATION);
 * - `VALUE=DATE` + `YYYYMMDD` for all-day events, `YYYYMMDDTHHMMSSZ` otherwise;
 * - a caller-supplied `now` becomes `DTSTAMP` — the builder never reads the
 *   clock, so identical input yields byte-identical output.
 */

/** Undo RFC 5545 folding (drop the CRLF + single leading space). */
const unfold = (value: string) => value.replace(/\r\n /g, "");

const utf8 = (value: string) => new TextEncoder().encode(value).length;

const NOW = "2026-01-15T12:00:00.000Z";
const PRODID = "-//Noema//Calendar//EN";
const opts = (extra: Partial<{ name: string; now: string }> = {}) => ({
  prodId: PRODID,
  now: NOW,
  ...extra,
});

describe("escapeText — RFC 5545 TEXT escaping", () => {
  it("escapes backslash, semicolon and comma", () => {
    expect(escapeText("a\\b")).toBe("a\\\\b");
    expect(escapeText("a;b")).toBe("a\\;b");
    expect(escapeText("a,b")).toBe("a\\,b");
  });

  it("normalises newlines to a literal \\n (LF, CR, CRLF alike)", () => {
    expect(escapeText("a\nb")).toBe("a\\nb");
    expect(escapeText("a\r\nb")).toBe("a\\nb");
    expect(escapeText("a\rb")).toBe("a\\nb");
  });

  it("escapes a mixture in one pass without double-escaping", () => {
    expect(escapeText("One; two,\nthree\\four")).toBe("One\\; two\\,\\nthree\\\\four");
  });

  it("leaves safe text untouched", () => {
    expect(escapeText("Weekly sync")).toBe("Weekly sync");
  });
});

describe("foldLine — 75-octet folding with CRLF", () => {
  it("leaves a line at or below 75 octets unchanged", () => {
    expect(foldLine("a".repeat(75))).toBe("a".repeat(75));
    expect(foldLine("short")).toBe("short");
  });

  it("folds a 76-octet ASCII line into two physical lines joined by CRLF", () => {
    const folded = foldLine("a".repeat(76));
    expect(folded).toBe(`${"a".repeat(75)}\r\n a`);
    expect(unfold(folded)).toBe("a".repeat(76));
  });

  it("never emits a physical line longer than 75 octets", () => {
    for (const line of foldLine("x".repeat(200)).split("\r\n")) {
      expect(utf8(line)).toBeLessThanOrEqual(75);
    }
  });

  it("is octet-aware: multi-byte characters fold without being split", () => {
    const original = "é".repeat(40); // 40 chars × 2 octets = 80 octets
    const folded = foldLine(original);
    expect(folded).toContain("\r\n");
    for (const line of folded.split("\r\n")) {
      expect(utf8(line)).toBeLessThanOrEqual(75);
    }
    expect(unfold(folded)).toBe(original);
  });
});

describe("buildCalendar — VCALENDAR envelope", () => {
  it("wraps the calendar with CRLF endings and a trailing CRLF", () => {
    const ics = buildCalendar([], opts({ name: "Team" }));
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0\r\n");
    expect(ics).toContain(`PRODID:${PRODID}\r\n`);
    expect(ics).toContain("CALSCALE:GREGORIAN\r\n");
    expect(ics).toContain("X-WR-CALNAME:Team\r\n");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("omits X-WR-CALNAME when no name is supplied", () => {
    expect(buildCalendar([], opts())).not.toContain("X-WR-CALNAME");
  });
});

describe("buildCalendar — VEVENT fields", () => {
  it("emits UID, DTSTAMP (from now), DTSTART/DTEND and SUMMARY for a timed event", () => {
    const ics = buildCalendar(
      [
        {
          uid: "evt-1@noema",
          start: "2026-01-15T09:00:00.000Z",
          end: "2026-01-15T09:30:00.000Z",
          summary: "Weekly sync",
        },
      ],
      opts(),
    );
    expect(ics).toContain("BEGIN:VEVENT\r\n");
    expect(ics).toContain("UID:evt-1@noema\r\n");
    expect(ics).toContain("DTSTAMP:20260115T120000Z\r\n");
    expect(ics).toContain("DTSTART:20260115T090000Z\r\n");
    expect(ics).toContain("DTEND:20260115T093000Z\r\n");
    expect(ics).toContain("SUMMARY:Weekly sync\r\n");
    expect(ics).toContain("END:VEVENT\r\n");
  });

  it("marks all-day events with VALUE=DATE and omits a missing end", () => {
    const ics = buildCalendar(
      [
        { uid: "a@noema", start: "2026-01-16", allDay: true, summary: "Offsite" },
        {
          uid: "b@noema",
          start: "2026-01-17",
          end: "2026-01-18",
          allDay: true,
          summary: "Conf",
        },
      ],
      opts(),
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20260116\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20260118\r\n");
    const firstEvent = ics.slice(ics.indexOf("UID:a@noema"), ics.indexOf("UID:b@noema"));
    expect(firstEvent).not.toContain("DTEND");
  });

  it("includes DESCRIPTION, LOCATION and URL only when provided", () => {
    const ics = buildCalendar(
      [
        {
          uid: "e@noema",
          start: "2026-01-15T09:00:00.000Z",
          summary: "Sync",
          description: "Agenda: one; two",
          location: "Room 1",
          url: "https://example.com/meet?a=1&b=2",
        },
      ],
      opts(),
    );
    expect(ics).toContain("DESCRIPTION:Agenda: one\\; two\r\n");
    expect(ics).toContain("LOCATION:Room 1\r\n");
    expect(ics).toContain("URL:https://example.com/meet?a=1&b=2\r\n");
  });

  it("escapes TEXT fields and leaves URI fields unescaped", () => {
    const ics = buildCalendar(
      [
        {
          uid: "e@noema",
          start: "2026-01-15T09:00:00.000Z",
          summary: "One; two,\nthree\\",
          location: "A,B",
          url: "https://example.com/a,b?c=1;d=2",
        },
      ],
      opts(),
    );
    expect(ics).toContain("SUMMARY:One\\; two\\,\\nthree\\\\\r\n");
    expect(ics).toContain("LOCATION:A\\,B\r\n");
    expect(ics).toContain("URL:https://example.com/a,b?c=1;d=2\r\n");
  });

  it("omits every optional line for a bare event", () => {
    const ics = buildCalendar(
      [{ uid: "e@noema", start: "2026-01-15T09:00:00.000Z", summary: "Bare" }],
      opts(),
    );
    expect(ics).not.toContain("DTEND");
    expect(ics).not.toContain("DESCRIPTION");
    expect(ics).not.toContain("LOCATION");
    expect(ics).not.toContain("URL");
  });

  it("folds long lines to 75 octets and round-trips the content", () => {
    const summary = `Meeting ${"x".repeat(120)}`;
    const ics = buildCalendar(
      [{ uid: "e@noema", start: "2026-01-15T09:00:00.000Z", summary }],
      opts(),
    );
    const physical = ics.split("\r\n");
    const summaryIndex = physical.findIndex((line) => line.startsWith("SUMMARY:"));
    expect(physical[summaryIndex + 1].startsWith(" ")).toBe(true);
    for (const line of physical) expect(utf8(line)).toBeLessThanOrEqual(75);
    expect(unfold(ics)).toContain(`SUMMARY:${summary}\r\n`);
  });

  it("preserves event order and is byte-identical across calls (no clock reads)", () => {
    const events = [
      { uid: "b@noema", start: "2026-01-16T09:00:00.000Z", summary: "Second" },
      { uid: "a@noema", start: "2026-01-15T09:00:00.000Z", summary: "First" },
    ];
    const first = buildCalendar(events, opts());
    expect(first.indexOf("UID:b@noema")).toBeLessThan(first.indexOf("UID:a@noema"));
    expect(buildCalendar(events, opts())).toBe(first);
    expect(first).toContain("DTSTAMP:20260115T120000Z\r\n");
  });
});
