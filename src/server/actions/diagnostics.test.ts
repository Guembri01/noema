import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDiagnosticsAction, reportClientErrorAction } from "./diagnostics";
import { resetTelemetry } from "@/lib/telemetry";

/*
   Wiring proof for the `diagnostics` server action: the client error boundary's
   payload is grouped by fingerprint (volatile ids collapse), the report payload
   is redacted by `error-reporting.ts`'s scrubber, and the feature-flag store is
   readable/listable server-side.
*/

const FLAG_ENV_VARS = [
  "FLAG_DIAGNOSTICS_ENDPOINT",
  "FLAG_ERROR_REPORTING",
  "FLAG_STRUCTURED_LOGGING",
  "FLAG_METRICS_PERCENTILES",
] as const;
const prevFlagEnv = FLAG_ENV_VARS.map((name) => [name, process.env[name]] as const);

beforeEach(() => {
  resetTelemetry();
  for (const name of FLAG_ENV_VARS) delete process.env[name];
});

afterEach(() => {
  for (const [name, value] of prevFlagEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("reportClientErrorAction", () => {
  it("groups two volatile-id recurrences under one fingerprint", async () => {
    const result = await reportClientErrorAction([
      {
        id: "event-a",
        error: {
          name: "Error",
          message: "failed for user 11111111-1111-1111-1111-111111111111",
        },
        route: "/w/demo",
        action: "save",
        timestamp: 1000,
      },
      {
        id: "event-b",
        error: {
          name: "Error",
          message: "failed for user 22222222-2222-2222-2222-222222222222",
        },
        route: "/w/demo",
        action: "save",
        timestamp: 2000,
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.received).toBe(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.count).toBe(2);
    expect(result.groups[0]?.sampleIds).toEqual(["event-a", "event-b"]);
    expect(result.groups[0]?.firstSeen).toBe(1000);
    expect(result.groups[0]?.lastSeen).toBe(2000);
  });

  it("routes different errors to different fingerprints", async () => {
    const result = await reportClientErrorAction([
      { id: "a", error: { name: "Error", message: "network offline" }, timestamp: 1 },
      { id: "b", error: { name: "TypeError", message: "cannot read x" }, timestamp: 2 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.groups.map((group) => group.fingerprint)).toHaveLength(2);
  });

  it("redacts credential-shaped text in the report title", async () => {
    const result = await reportClientErrorAction({
      id: "leaky",
      error: {
        name: "Error",
        message: "auth failed with Bearer abcdefghijklmnopqrstuvwxyz",
      },
      timestamp: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const title = result.groups[0]?.title ?? "";
    expect(title).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(title).toContain("[redacted]");
  });

  it("rejects an empty payload without throwing", async () => {
    await expect(reportClientErrorAction(null)).resolves.toEqual({
      ok: false,
      error: "No error event provided.",
    });
  });
});

describe("getDiagnosticsAction", () => {
  it("lists the effective flags read from the feature-flag store", async () => {
    const result = await getDiagnosticsAction();
    expect(result.ok).toBe(true);
    expect(result.flags.map((flag) => flag.key)).toContain("diagnostics_endpoint");
    expect(result.flags.every((flag) => flag.source === "flag")).toBe(true);
    expect(result.flagStore.flags.length).toBe(result.flags.length);
  });

  it("reflects a FLAG_ environment override in the listed flags", async () => {
    process.env.FLAG_ERROR_REPORTING = "off";
    try {
      const result = await getDiagnosticsAction();
      const flag = result.flags.find((entry) => entry.key === "error_reporting");
      expect(flag?.enabled).toBe(false);
      expect(flag?.source).toBe("env");
    } finally {
      delete process.env.FLAG_ERROR_REPORTING;
    }
  });
});
