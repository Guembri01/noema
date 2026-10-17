import { describe, expect, it } from "vitest";
import {
  describeVerdict,
  describeWindows,
  formatPolicyOffset,
  isAllowedDateKey,
  isAllowedInstant,
  parisStamp,
  policyOffsetMinutes,
  weekdayOfDateKey,
} from "./dates-policy";

// Fixed instants only: nothing here may depend on the host clock or timezone.
// All ten days below are October 2026, which is CEST (+02:00) throughout, so a
// UTC instant is exactly two hours behind the Paris wall clock.
const WED_1900 = "2026-10-14T17:00:00Z";
const WED_1859 = "2026-10-14T16:59:00Z";
const WED_0200 = "2026-10-14T00:00:00Z";
const THU_0559 = "2026-10-15T03:59:00Z";
const THU_0600 = "2026-10-15T04:00:00Z";
const THU_1200 = "2026-10-15T10:00:00Z";
const THU_1900 = "2026-10-15T17:00:00Z";
const THU_2359 = "2026-10-15T21:59:00Z";
const FRI_0300 = "2026-10-16T01:00:00Z";
const FRI_2100 = "2026-10-16T19:00:00Z";
const SAT_0559 = "2026-10-17T03:59:00Z";
const SAT_1900 = "2026-10-17T17:00:00Z";
const SUN_0559 = "2026-10-18T03:59:00Z";
const SUN_0600 = "2026-10-18T04:00:00Z";
const MON_1200 = "2026-10-12T10:00:00Z";
const TUE_2100 = "2026-10-13T19:00:00Z";

describe("parisStamp", () => {
  it("reads the Paris wall clock at a summer instant", () => {
    expect(parisStamp(WED_1900)).toEqual({
      dateKey: "2026-10-14",
      weekday: "Wed",
      hour: 19,
      minute: 0,
      second: 0,
      offsetMinutes: 120,
    });
  });

  it("normalises midnight to hour 0", () => {
    const stamp = parisStamp("2026-10-14T22:00:00Z");
    expect(stamp?.weekday).toBe("Thu");
    expect(stamp?.hour).toBe(0);
  });

  it("returns null for an instant Date cannot represent", () => {
    expect(parisStamp("not-a-date")).toBeNull();
    expect(parisStamp(new Date(Number.NaN))).toBeNull();
  });
});

describe("window membership", () => {
  it("opens Wednesday exactly at 19:00", () => {
    expect(isAllowedInstant(WED_1900)).toBe(true);
    expect(isAllowedInstant(WED_1859)).toBe(false);
    expect(isAllowedInstant(WED_0200)).toBe(false);
  });

  it("closes at 06:00 exclusive, so 05:59 is in and 06:00 is out", () => {
    expect(isAllowedInstant(THU_0559)).toBe(true);
    expect(isAllowedInstant(THU_0600)).toBe(false);
    expect(isAllowedInstant(SUN_0559)).toBe(true);
    expect(isAllowedInstant(SUN_0600)).toBe(false);
  });

  it("blocks the whole working day", () => {
    expect(isAllowedInstant(THU_1200)).toBe(false);
    expect(parisStamp(THU_1200)?.hour).toBe(12);
  });

  it("allows every evening opening hour", () => {
    for (const instant of [WED_1900, THU_1900, SAT_1900, FRI_2100, THU_2359]) {
      expect(isAllowedInstant(instant)).toBe(true);
    }
  });

  it("allows the small hours that follow a window", () => {
    for (const instant of [THU_0559, FRI_0300, SAT_0559, SUN_0559]) {
      expect(isAllowedInstant(instant)).toBe(true);
    }
  });

  it("has no window on Monday or Tuesday", () => {
    expect(parisStamp(MON_1200)?.weekday).toBe("Mon");
    expect(parisStamp(TUE_2100)?.weekday).toBe("Tue");
    expect(isAllowedInstant(MON_1200)).toBe(false);
    expect(isAllowedInstant(TUE_2100)).toBe(false);
  });

  it("rejects Sunday outside the small hours", () => {
    expect(isAllowedInstant("2026-03-29T19:00:00Z")).toBe(false); // Sun 21:00 CEST
  });

  it("pathological input is never allowed", () => {
    expect(isAllowedInstant("")).toBe(false);
    expect(isAllowedInstant("nope")).toBe(false);
  });
});

describe("timezone offset (never hardcoded)", () => {
  it("is two hours east of UTC in summer and one in winter", () => {
    expect(policyOffsetMinutes(WED_1900)).toBe(120);
    expect(policyOffsetMinutes("2026-01-15T12:00:00Z")).toBe(60);
    expect(formatPolicyOffset(WED_1900)).toBe("+02:00");
    expect(formatPolicyOffset("2026-01-15T12:00:00Z")).toBe("+01:00");
  });

  it("straddles the spring-forward transition (2026-03-29)", () => {
    expect(policyOffsetMinutes("2026-03-29T00:30:00Z")).toBe(60);
    expect(policyOffsetMinutes("2026-03-29T01:00:00Z")).toBe(120);
    expect(parisStamp("2026-03-29T01:00:00Z")?.hour).toBe(3); // 02:00 skipped
  });

  it("straddles the fall-back transition (2026-10-25)", () => {
    expect(policyOffsetMinutes("2026-10-25T00:30:00Z")).toBe(120);
    expect(policyOffsetMinutes("2026-10-25T01:00:00Z")).toBe(60);
    expect(parisStamp("2026-10-25T01:00:00Z")?.hour).toBe(2); // 02:00 repeats
  });

  it("both transitions sit inside a Saturday-night window", () => {
    const spring = parisStamp("2026-03-29T01:00:00Z");
    const autumn = parisStamp("2026-10-25T01:00:00Z");
    expect(spring?.weekday).toBe("Sun");
    expect(autumn?.weekday).toBe("Sun");
    expect(isAllowedInstant("2026-03-29T01:00:00Z")).toBe(true);
    expect(isAllowedInstant("2026-10-25T01:00:00Z")).toBe(true);
  });
});

describe("date-only keys", () => {
  it("accepts the four window-bearing days", () => {
    expect(weekdayOfDateKey("2026-10-14")).toBe("Wed");
    expect(weekdayOfDateKey("2026-10-15")).toBe("Thu");
    expect(weekdayOfDateKey("2026-10-16")).toBe("Fri");
    expect(weekdayOfDateKey("2026-10-17")).toBe("Sat");
    for (const key of ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]) {
      expect(isAllowedDateKey(key)).toBe(true);
    }
  });

  it("rejects Sunday, Monday and Tuesday", () => {
    expect(isAllowedDateKey("2026-10-18")).toBe(false);
    expect(isAllowedDateKey("2026-10-12")).toBe(false);
    expect(isAllowedDateKey("2026-10-13")).toBe(false);
  });

  it("rejects malformed keys rather than rolling them over", () => {
    expect(weekdayOfDateKey("2026-13-01")).toBeNull();
    expect(weekdayOfDateKey("2026-02-30")).toBeNull();
    expect(weekdayOfDateKey("20261014")).toBeNull();
    expect(isAllowedDateKey("2026-13-01")).toBe(false);
  });
});

describe("reporting helpers", () => {
  it("explains both verdicts", () => {
    expect(describeVerdict(WED_1900)).toContain("inside a window");
    expect(describeVerdict(THU_1200)).toContain("outside every window");
    expect(describeVerdict("nope")).toBe("invalid instant");
  });

  it("renders the four windows", () => {
    expect(describeWindows()).toEqual([
      "Wed 19:00 → Thu 06:00",
      "Thu 19:00 → Fri 06:00",
      "Fri 19:00 → Sat 06:00",
      "Sat 19:00 → Sun 06:00",
    ]);
  });
});
