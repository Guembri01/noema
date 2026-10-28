import { describe, expect, it } from "vitest";
import {
  addCalendarEvent,
  currentMonth,
  eventsForDay,
  isDateKey,
  isMonthKey,
  monthGrid,
  moveMonth,
  newCalendarEvent,
  parseCalendarEvents,
  removeCalendarEvent,
  todayKey,
} from "./calendar-block";

describe("calendar keys", () => {
  it("formats UTC month and day keys", () => {
    const date = new Date(Date.UTC(2026, 9, 26, 23, 30));
    expect(currentMonth(date)).toBe("2026-10");
    expect(todayKey(date)).toBe("2026-10-26");
  });

  it("validates real dates and rejects impossible ones", () => {
    expect(isDateKey("2026-10-26")).toBe(true);
    expect(isDateKey("2026-02-29")).toBe(false);
    expect(isDateKey("2024-02-29")).toBe(true);
    expect(isDateKey("2026-13-01")).toBe(false);
    expect(isMonthKey("2026-10")).toBe(true);
    expect(isMonthKey("2026-00")).toBe(false);
  });

  it("moves months across year boundaries", () => {
    expect(moveMonth("2026-01", -1)).toBe("2025-12");
    expect(moveMonth("2026-12", 1)).toBe("2027-01");
    expect(moveMonth("bad", 1)).toBe(moveMonth(currentMonth(), 1));
  });
});

describe("monthGrid", () => {
  it("returns six Monday-first weeks containing the month", () => {
    const cells = monthGrid("2026-10", { weekStartsOn: 1 });
    expect(cells).toHaveLength(42);
    expect(cells[0].date).toBe("2026-09-28");
    expect(cells[41].date).toBe("2026-11-08");
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(31);
    expect(cells.find((cell) => cell.date === "2026-10-01")?.inMonth).toBe(true);
  });

  it("marks today without changing the grid shape", () => {
    const today = new Date(Date.UTC(2026, 9, 26));
    const cells = monthGrid("2026-10", { today });
    expect(cells.find((cell) => cell.date === "2026-10-26")?.isToday).toBe(true);
    expect(cells.filter((cell) => cell.isToday)).toHaveLength(1);
  });
});

describe("calendar events", () => {
  it("parses only valid entries from JSON", () => {
    const events = parseCalendarEvents(
      JSON.stringify([
        { id: "a", date: "2026-10-26", title: "Ship" },
        { id: "b", date: "not-a-date", title: "Ignore" },
        { id: "c", date: "2026-10-27" },
      ]),
    );
    expect(events).toEqual([{ id: "a", date: "2026-10-26", title: "Ship" }]);
  });

  it("fails closed on malformed JSON or non-array input", () => {
    expect(parseCalendarEvents("{")).toEqual([]);
    expect(parseCalendarEvents("null")).toEqual([]);
    expect(parseCalendarEvents(undefined)).toEqual([]);
  });

  it("adds, sorts, filters and removes events", () => {
    const first = newCalendarEvent("2026-10-27", "Review");
    const second = newCalendarEvent("2026-10-26", "Ship");
    const events = addCalendarEvent(addCalendarEvent([], first), second);
    expect(events.map((event) => event.title)).toEqual(["Ship", "Review"]);
    expect(eventsForDay(events, "2026-10-27").map((event) => event.title)).toEqual(["Review"]);
    expect(removeCalendarEvent(events, first.id)).toHaveLength(1);
  });

  it("replaces an event with the same id", () => {
    const event = newCalendarEvent("2026-10-26", "Draft");
    const replaced = addCalendarEvent([event], { ...event, title: "Final" });
    expect(replaced).toHaveLength(1);
    expect(replaced[0].title).toBe("Final");
  });
});
