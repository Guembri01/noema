import { describe, expect, it } from "vitest";
import { localTime, stableTime } from "./time";

describe("stableTime", () => {
  it("is byte-identical whatever the machine timezone is", () => {
    // Rendered on the server (Node TZ) and on the client (browser TZ) — hydration
    // only survives if the string depends on neither.
    expect(stableTime("2026-03-01T09:30:00.000Z")).toBe("1 Mar 2026, 09:30");
    expect(stableTime("2026-03-01T09:30:00.000Z", "date")).toBe("1 Mar 2026");
    expect(stableTime("2026-03-01T23:30:00.000Z", "time")).toBe("23:30");
  });

  it("never throws on junk input", () => {
    expect(stableTime("not a date")).toBe("");
    expect(localTime("not a date")).toBe("");
  });
});
