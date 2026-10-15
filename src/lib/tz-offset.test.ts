import { describe, expect, it } from "vitest";
import {
  COMMON_TIMEZONES,
  formatOffset,
  isDaylightSaving,
  offsetMinutes,
  sameOffset,
} from "./tz-offset";

// Two fixed instants, well clear of any transition: a northern winter and a
// northern summer. Nothing here depends on the machine timezone.
const WINTER = "2026-01-15T12:00:00.000Z";
const SUMMER = "2026-07-15T12:00:00.000Z";

describe("offsetMinutes", () => {
  it("is zero for UTC", () => {
    expect(offsetMinutes("UTC", WINTER)).toBe(0);
  });

  it("reads fixed offsets for zones without DST", () => {
    expect(offsetMinutes("Asia/Kolkata", WINTER)).toBe(330); // +05:30
  });

  it("follows the DST transition of a northern zone", () => {
    expect(offsetMinutes("America/New_York", WINTER)).toBe(-300); // EST
    expect(offsetMinutes("America/New_York", SUMMER)).toBe(-240); // EDT
    expect(offsetMinutes("Europe/London", SUMMER)).toBe(60); // BST
  });

  it("follows the DST transition of a southern zone", () => {
    // WINTER/SUMMER are northern labels: January is the southern *summer*.
    expect(offsetMinutes("Australia/Adelaide", WINTER)).toBe(630); // ACDT
    expect(offsetMinutes("Australia/Adelaide", SUMMER)).toBe(570); // ACST
  });

  it("accepts a Date or an epoch-millisecond number", () => {
    const at = "2026-06-01T00:00:00.000Z";
    expect(offsetMinutes("Asia/Tokyo", Date.parse(at))).toBe(540);
  });

  it("returns NaN for an unknown zone or an invalid instant", () => {
    expect(offsetMinutes("Mars/Olympus", WINTER)).toBeNaN();
    expect(offsetMinutes("UTC", "not a date")).toBeNaN();
  });
});

describe("formatOffset", () => {
  it("renders sign, hours and minutes", () => {
    expect(formatOffset(120)).toBe("+02:00");
    expect(formatOffset(-330)).toBe("-05:30");
    expect(formatOffset(345)).toBe("+05:45");
  });

  it("normalises zero and negative zero to +00:00", () => {
    expect(formatOffset(0)).toBe("+00:00");
    expect(formatOffset(-0)).toBe("+00:00");
  });

  it("supports half-hour offsets in both directions", () => {
    expect(formatOffset(-450)).toBe("-07:30");
  });

  it("returns an empty string for non-finite input", () => {
    expect(formatOffset(Number.NaN)).toBe("");
    expect(formatOffset(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("isDaylightSaving", () => {
  it("detects summer time in the northern hemisphere", () => {
    expect(isDaylightSaving("America/New_York", SUMMER)).toBe(true);
    expect(isDaylightSaving("America/New_York", WINTER)).toBe(false);
  });

  it("detects summer time in the southern hemisphere", () => {
    expect(isDaylightSaving("Australia/Sydney", WINTER)).toBe(true);
    expect(isDaylightSaving("Australia/Sydney", SUMMER)).toBe(false);
  });

  it("is false for zones that never shift their offset", () => {
    expect(isDaylightSaving("UTC", SUMMER)).toBe(false);
  });

  it("is false for an unknown zone", () => {
    expect(isDaylightSaving("Mars/Olympus", SUMMER)).toBe(false);
  });
});

describe("sameOffset", () => {
  it("is false when two zones differ by an hour", () => {
    expect(sameOffset("America/New_York", "America/Chicago", WINTER)).toBe(false);
  });

  it("is true when two zones align", () => {
    expect(sameOffset("Europe/London", "UTC", WINTER)).toBe(true);
  });

  it("is false for an unknown zone", () => {
    expect(sameOffset("UTC", "Mars/Olympus", WINTER)).toBe(false);
  });
});

describe("COMMON_TIMEZONES", () => {
  it("lists recognisable zones", () => {
    expect(COMMON_TIMEZONES).toContain("UTC");
    expect(COMMON_TIMEZONES).toContain("Asia/Kolkata");
  });

  it("contains only zones Intl can resolve", () => {
    for (const zone of COMMON_TIMEZONES) {
      expect(Number.isFinite(offsetMinutes(zone, SUMMER))).toBe(true);
    }
  });
});
