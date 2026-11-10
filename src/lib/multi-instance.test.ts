import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MULTI_INSTANCE_ENV, parseInstanceCount } from "./multi-instance";

/**
 * P1-T04 — the `NOEMA_INSTANCES` deployment signal drives the one-line
 * startup caveat that the multi-instance state (session registry, rate-limit
 * buckets, share-unlock lockouts) is per instance. The parse is pure; the
 * warning is process-wide and fires at most once, so its tests import the
 * module fresh (`vi.resetModules`) with the env stubbed first.
 */

beforeEach(() => {
  // Never let a developer's environment leak the decl into the suite.
  vi.stubEnv(MULTI_INSTANCE_ENV, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseInstanceCount", () => {
  it("treats unset, blank and whitespace-only as not declared", () => {
    expect(parseInstanceCount(undefined)).toBeNull();
    expect(parseInstanceCount("")).toBeNull();
    expect(parseInstanceCount("   ")).toBeNull();
  });

  it("treats a non-integer or negative value as not declared", () => {
    expect(parseInstanceCount("abc")).toBeNull();
    expect(parseInstanceCount("1.5")).toBeNull();
    expect(parseInstanceCount("-3")).toBeNull();
  });

  it("returns the declared integer, including the single-instance default", () => {
    expect(parseInstanceCount("1")).toBe(1);
    expect(parseInstanceCount("3")).toBe(3);
    expect(parseInstanceCount("  2 ")).toBe(2);
    expect(parseInstanceCount("0")).toBe(0);
  });
});

describe("warnIfMultiInstance", () => {
  /** Import the module fresh so the once-per-process flag starts at false. */
  const fresh = async () => {
    vi.resetModules();
    return import("./multi-instance");
  };

  it("warns once when more than one instance is declared", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.stubEnv(MULTI_INSTANCE_ENV, "3");
      const { warnIfMultiInstance } = await fresh();
      warnIfMultiInstance();
      warnIfMultiInstance(); // twice → the once-per-process flag must hold
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(MULTI_INSTANCE_ENV);
      expect(warn.mock.calls[0]?.[0]).toContain("session registry");
      expect(warn.mock.calls[0]?.[0]).toContain("docs/OPERATIONS.md");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when unset or a single instance", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { warnIfMultiInstance } = await fresh();
      warnIfMultiInstance();
      expect(warn).not.toHaveBeenCalled();

      vi.stubEnv(MULTI_INSTANCE_ENV, "1");
      const fresh2 = await fresh();
      fresh2.warnIfMultiInstance();
      expect(warn).not.toHaveBeenCalled();

      vi.stubEnv(MULTI_INSTANCE_ENV, "garbage");
      const fresh3 = await fresh();
      fresh3.warnIfMultiInstance();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
