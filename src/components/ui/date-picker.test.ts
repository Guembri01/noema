import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DATE_PRESETS,
  DatePicker,
  clampTime,
  formatTime,
  parseTimeInput,
  relativeToNow,
  resolvePreset,
  stepTime,
} from "./date-picker";

/**
 * Pure-logic + static-render proof for the date/time control.
 *
 * Every assertion runs against a fixed `now` (18 March 2026, a Wednesday) so
 * preset resolution, relative phrasing and time stepping are deterministic on
 * any machine and clock.
 */

const NOW = Date.UTC(2026, 2, 18);

describe("presets vs a fixed now", () => {
  it("resolves the day presets", () => {
    expect(resolvePreset("today", NOW)).toEqual({
      start: "2026-03-18",
      end: "2026-03-18",
    });
    expect(resolvePreset("yesterday", NOW)).toEqual({
      start: "2026-03-17",
      end: "2026-03-17",
    });
    expect(resolvePreset("tomorrow", NOW)).toEqual({
      start: "2026-03-19",
      end: "2026-03-19",
    });
  });

  it("resolves week presets honouring the week start", () => {
    expect(resolvePreset("thisWeek", NOW, 0)).toEqual({
      start: "2026-03-15",
      end: "2026-03-21",
    });
    expect(resolvePreset("thisWeek", NOW, 1)).toEqual({
      start: "2026-03-16",
      end: "2026-03-22",
    });
    expect(resolvePreset("nextWeek", NOW, 0)).toEqual({
      start: "2026-03-22",
      end: "2026-03-28",
    });
    expect(resolvePreset("nextWeek", NOW, 1)).toEqual({
      start: "2026-03-23",
      end: "2026-03-29",
    });
  });

  it("resolves the month preset inclusively", () => {
    expect(resolvePreset("thisMonth", NOW)).toEqual({
      start: "2026-03-01",
      end: "2026-03-31",
    });
    expect(resolvePreset("thisMonth", Date.UTC(2026, 1, 10))).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });

  it("clears and refuses an unusable now", () => {
    expect(resolvePreset("clear", NOW)).toBeNull();
    expect(resolvePreset("today", new Date(Number.NaN))).toBeNull();
  });

  it("exposes every preset in the UI order", () => {
    expect(DATE_PRESETS).toEqual([
      "today",
      "yesterday",
      "tomorrow",
      "thisWeek",
      "nextWeek",
      "thisMonth",
      "clear",
    ]);
  });
});

describe("time stepping + clamping", () => {
  it("formats and clamps parts", () => {
    expect(formatTime({ hours: 9, minutes: 5 })).toBe("09:05");
    expect(clampTime({ hours: 25, minutes: 70 })).toEqual({ hours: 23, minutes: 59 });
    expect(clampTime({ hours: -3, minutes: -1 })).toEqual({ hours: 0, minutes: 0 });
  });

  it("steps hours and wraps around midnight", () => {
    expect(stepTime({ hours: 23, minutes: 0 }, "hours", 1)).toEqual({ hours: 0, minutes: 0 });
    expect(stepTime({ hours: 0, minutes: 0 }, "hours", -1)).toEqual({ hours: 23, minutes: 0 });
    expect(stepTime({ hours: 9, minutes: 30 }, "hours", 2)).toEqual({ hours: 11, minutes: 30 });
  });

  it("steps minutes by the 5-minute grain and wraps", () => {
    expect(stepTime({ hours: 10, minutes: 0 }, "minutes", 1)).toEqual({ hours: 10, minutes: 5 });
    expect(stepTime({ hours: 10, minutes: 0 }, "minutes", -1)).toEqual({ hours: 9, minutes: 55 });
    expect(stepTime({ hours: 23, minutes: 55 }, "minutes", 1)).toEqual({ hours: 0, minutes: 0 });
    expect(stepTime({ hours: 0, minutes: 0 }, "minutes", -1)).toEqual({ hours: 23, minutes: 55 });
  });

  it("parses typed input and clamps out-of-range values", () => {
    expect(parseTimeInput("9:05")).toEqual({ hours: 9, minutes: 5 });
    expect(parseTimeInput("9:5")).toEqual({ hours: 9, minutes: 5 });
    expect(parseTimeInput("9")).toEqual({ hours: 9, minutes: 0 });
    expect(parseTimeInput("9h30")).toEqual({ hours: 9, minutes: 30 });
    expect(parseTimeInput("25:70")).toEqual({ hours: 23, minutes: 59 });
    expect(parseTimeInput("abc")).toBeNull();
    expect(parseTimeInput("")).toBeNull();
  });
});

describe("relative display", () => {
  it("phrases future and past dates against a fixed now", () => {
    expect(relativeToNow("2026-03-21", NOW)).toBe("in 3 days");
    expect(relativeToNow("2026-03-16", NOW)).toBe("2 days ago");
    expect(relativeToNow("2026-03-18", NOW)).toBe("now");
  });

  it("degrades to empty for blanks and junk", () => {
    expect(relativeToNow(null, NOW)).toBe("");
    expect(relativeToNow("not-a-date", NOW)).toBe("");
  });
});

describe("DatePicker trigger", () => {
  it("shows the formatted date, the relative phrase and the ISO title", () => {
    const html = renderToStaticMarkup(
      createElement(DatePicker, {
        mode: "date",
        locale: "en",
        now: NOW,
        relative: true,
        value: { date: "2026-03-21" },
      }),
    );
    expect(html).toContain('title="2026-03-21"');
    expect(html).toContain("Mar 21, 2026");
    expect(html).toContain("in 3 days");
  });

  it("titles a range with both ISO bounds", () => {
    const html = renderToStaticMarkup(
      createElement(DatePicker, {
        mode: "range",
        locale: "en",
        now: NOW,
        value: { date: "2026-03-16", end: "2026-03-20" },
      }),
    );
    expect(html).toContain('title="2026-03-16/2026-03-20"');
    expect(html).toContain("Mar 16 – Mar 20, 2026");
  });

  it("shows the placeholder when empty", () => {
    const html = renderToStaticMarkup(
      createElement(DatePicker, { mode: "date", locale: "en", now: NOW, value: {} }),
    );
    expect(html).toContain("Select a date…");
    // No ISO title while unset.
    expect(html).not.toContain("title=");
  });
});
