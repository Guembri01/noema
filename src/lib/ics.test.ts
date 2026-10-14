import { describe, expect, it } from "vitest";
import { isAllowedFeedUrl, normalizeFeedUrl, parseIcsDate, parseIcsEvents } from "./ics";

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
