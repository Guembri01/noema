import { describe, expect, it } from "vitest";
import {
  FLAG_ENV_PREFIX,
  FlagStoreError,
  applyFlagEnv,
  clearOverride,
  createFlagStore,
  defineFlag,
  envKeyFor,
  override,
  parseFlagEnv,
  resolveAll,
  snapshot,
  type FlagStore,
} from "@/lib/feature-flag-store";
import { type Flag, type FlagContext } from "@/lib/feature-flags";

/*
   A pure session store over the feature-flag engine (`feature-flags.ts`).

   The store adds three things the engine deliberately does not own:

   1. a REGISTRY — `defineFlag` validates a flag with `validateFlag` and keeps a
      canonical, isolated copy, so a definition can never be a malformed
      surprise at read time and the caller's object is never aliased;
   2. a RESOLVER — `resolveAll` returns one decision per registered key, in
      registry order, applying the store's override layers; and
   3. two OVERRIDE layers with a fixed precedence:
        session override  >  env override  >  the flag definition
      `override` sets/clears the session layer (a kill switch), `parseFlagEnv`
      and `applyFlagEnv` derive the env layer from `FLAG_*` variables.

   Everything is deterministic: no clock, no randomness, no I/O, no mutation of
   inputs. A bad *definition* is loud (`FlagStoreError`); a bad *input* to the
   resolver or the env parser is inert, matching the engine's fail-closed rule.
*/

const ctx = (userId: string, attributes?: FlagContext["attributes"]): FlagContext =>
  attributes === undefined ? { userId } : { userId, attributes };

const flag = (overrides: Partial<Flag> = {}): Flag => ({
  key: "beta",
  enabled: false,
  ...overrides,
});

/** Run `fn` expecting it to throw a `FlagStoreError`, and return it. */
function captureError(fn: () => unknown): FlagStoreError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FlagStoreError) return error;
    throw error;
  }
  throw new Error("expected flag() to throw a FlagStoreError");
}

describe("createFlagStore", () => {
  it("starts empty", () => {
    const store = createFlagStore();
    expect(store.flags).toEqual([]);
    expect(store.overrides).toEqual({});
    expect(store.env).toEqual({});
  });

  it("validates and canonicalises initial flags", () => {
    const store = createFlagStore({ flags: [flag({ key: "  a  ", enabled: true, extra: 1 } as unknown as Flag)] });
    expect(store.flags).toEqual([{ key: "a", enabled: true }]);
  });

  it("isolates itself from the caller's array and nested lists", () => {
    const allowlist = ["u1"];
    const flags: Flag[] = [flag({ key: "a", allowlist })];
    const store = createFlagStore({ flags });
    flags.push(flag({ key: "b" }));
    allowlist.push("u2");
    expect(store.flags.map((entry) => entry.key)).toEqual(["a"]);
    expect(store.flags[0].allowlist).toEqual(["u1"]);
  });

  it("keeps only boolean overrides from untrusted init records", () => {
    const store = createFlagStore({
      overrides: { beta: true, junk: "yes", "": false } as unknown,
      env: { beta: false, other: 1 } as unknown,
    });
    expect(store.overrides).toEqual({ beta: true });
    expect(store.env).toEqual({ beta: false });
  });
});

describe("defineFlag", () => {
  it("registers a flag and returns a new store (input untouched)", () => {
    const before = createFlagStore();
    const after = defineFlag(before, flag({ key: "a", enabled: true }));
    expect(after.flags).toEqual([{ key: "a", enabled: true }]);
    expect(before.flags).toEqual([]);
    expect(after).not.toBe(before);
  });

  it("replaces a flag with the same key in place, preserving order", () => {
    let store = defineFlag(createFlagStore(), flag({ key: "a" }));
    store = defineFlag(store, flag({ key: "b", enabled: true }));
    store = defineFlag(store, flag({ key: "a", enabled: true }));
    expect(store.flags.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(store.flags[0].enabled).toBe(true);
  });

  it("trims the key and drops unknown fields", () => {
    const store = defineFlag(createFlagStore(), { key: "  beta  ", enabled: true, extra: 1 } as unknown);
    expect(store.flags).toEqual([{ key: "beta", enabled: true }]);
  });

  it("copies targeting fields rather than aliasing them", () => {
    const denylist = ["u1"];
    const store = defineFlag(createFlagStore(), flag({ key: "a", denylist }));
    denylist.push("u2");
    expect(store.flags[0].denylist).toEqual(["u1"]);
  });

  it("throws a FlagStoreError (with issues) on a malformed flag", () => {
    const error = captureError(() => defineFlag(createFlagStore(), { key: "", enabled: true }));
    expect(error.issues.map((issue) => issue.code)).toContain("missing_key");
    expect(captureError(() => defineFlag(createFlagStore(), flag({ rollout: 101 }))).issues.map((i) => i.code)).toEqual([
      "invalid_rollout",
    ]);
    expect(captureError(() => defineFlag(createFlagStore(), null)).issues.map((i) => i.code)).toEqual(["invalid_flag"]);
  });
});

describe("override / clearOverride", () => {
  it("sets a session override and returns a new store", () => {
    const store = createFlagStore();
    const next = override(store, "beta", true);
    expect(next.overrides).toEqual({ beta: true });
    expect(store.overrides).toEqual({});
  });

  it("clears the override for a key with null", () => {
    let store = override(createFlagStore(), "beta", true);
    store = override(store, "beta", null);
    expect(store.overrides).toEqual({});
  });

  it("clearOverride is the named form of a null override", () => {
    let store = override(createFlagStore(), "beta", true);
    store = clearOverride(store, "beta");
    expect(store.overrides).toEqual({});
  });

  it("ignores an unusable key or value (no-op)", () => {
    const store = override(createFlagStore(), "beta", true);
    expect(override(store, "", false)).toBe(store);
    expect(override(store, 7, false)).toBe(store);
    expect(override(store, "beta", "yes")).toBe(store);
    expect(clearOverride(store, 7)).toBe(store);
  });
});

describe("parseFlagEnv", () => {
  it("parses the truthy and falsy token vocabularies", () => {
    expect(parseFlagEnv({ FLAG_A: "true", FLAG_B: "1", FLAG_C: "YES", FLAG_D: "on" })).toEqual({
      A: true,
      B: true,
      C: true,
      D: true,
    });
    expect(parseFlagEnv({ FLAG_A: "false", FLAG_B: "0", FLAG_C: "No", FLAG_D: "OFF" })).toEqual({
      A: false,
      B: false,
      C: false,
      D: false,
    });
  });

  it("normalises the variable name to an upper-case suffix", () => {
    expect(FLAG_ENV_PREFIX).toBe("FLAG_");
    expect(parseFlagEnv({ flag_lower: "true" })).toEqual({ LOWER: true });
  });

  it("ignores non-flag names, an empty suffix and unparseable values", () => {
    expect(parseFlagEnv({ SMTP_SECURE: "true", FLAG_: "true", FLAG_BAD: "maybe" })).toEqual({});
  });

  it("accepts booleans and tolerates junk input", () => {
    expect(parseFlagEnv({ FLAG_OK: true, FLAG_NO: false })).toEqual({ OK: true, NO: false });
    expect(parseFlagEnv(null)).toEqual({});
    expect(parseFlagEnv("FLAG_A=true")).toEqual({});
  });
});

describe("envKeyFor", () => {
  it("maps an env-safe flag key to its variable name", () => {
    expect(envKeyFor("beta")).toBe("FLAG_BETA");
    expect(envKeyFor("beta_ui")).toBe("FLAG_BETA_UI");
    expect(envKeyFor(" Beta ")).toBe("FLAG_BETA");
  });

  it("returns null for a key that cannot be env-gated", () => {
    expect(envKeyFor("")).toBeNull();
    expect(envKeyFor("beta-ui")).toBeNull();
    expect(envKeyFor("search.v2")).toBeNull();
    expect(envKeyFor(7)).toBeNull();
  });
});

describe("applyFlagEnv", () => {
  it("sets an env override for each registered flag the env names", () => {
    const store = applyFlagEnv(
      createFlagStore({ flags: [flag({ key: "beta" }), flag({ key: "dark" })] }),
      { FLAG_BETA: "true", FLAG_DARK: "false", FLAG_UNKNOWN: "true" },
    );
    expect(store.env).toEqual({ beta: true, dark: false });
  });

  it("replaces the env layer on re-apply (a removed variable clears)", () => {
    let store = applyFlagEnv(createFlagStore({ flags: [flag({ key: "beta" })] }), { FLAG_BETA: "true" });
    expect(store.env).toEqual({ beta: true });
    store = applyFlagEnv(store, {});
    expect(store.env).toEqual({});
  });
});

describe("resolveAll", () => {
  it("resolves every flag in registry order using the engine", () => {
    const flags = [flag({ key: "on", enabled: true }), flag({ key: "off" })];
    expect(resolveAll(flags, ctx("u1"))).toEqual([
      { key: "on", enabled: true, reason: "enabled", source: "flag" },
      { key: "off", enabled: false, reason: "disabled", source: "flag" },
    ]);
  });

  it("applies the engine's targeting (allowlist, rules, rollout)", () => {
    const flags = [
      flag({ key: "beta", allowlist: ["u1"] }),
      flag({ key: "roll", rollout: 100 }),
    ];
    expect(resolveAll(flags, ctx("u1"))).toEqual([
      { key: "beta", enabled: true, reason: "allowlist", source: "flag" },
      { key: "roll", enabled: true, reason: "rollout", source: "flag" },
    ]);
  });

  it("keeps the first flag for a duplicated key (bare list)", () => {
    const flags = [flag({ key: "dup", enabled: true }), flag({ key: "dup", enabled: false })];
    const resolved = resolveAll(flags, ctx("u1"));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].enabled).toBe(true);
  });

  it("survives junk entries in a bare list", () => {
    const junk = [null, undefined, 7, { key: 5 }, flag({ key: "ok", enabled: true })] as unknown as Flag[];
    expect(() => resolveAll(junk, ctx("u1"))).not.toThrow();
    expect(resolveAll(junk, ctx("u1")).map((entry) => entry.key)).toEqual(["ok"]);
  });

  it("answers an empty store with an empty list", () => {
    expect(resolveAll(createFlagStore(), ctx("u1"))).toEqual([]);
  });

  it("prefers a session override over an env override over the definition", () => {
    let store = applyFlagEnv(createFlagStore({ flags: [flag({ key: "beta" })] }), { FLAG_BETA: "true" });
    expect(resolveAll(store, ctx("u1"))[0]).toEqual({
      key: "beta",
      enabled: true,
      reason: "env",
      source: "env",
    });

    store = override(store, "beta", false);
    expect(resolveAll(store, ctx("u1"))[0]).toEqual({
      key: "beta",
      enabled: false,
      reason: "override",
      source: "override",
    });
  });

  it("lets a session override act as a kill switch on an otherwise-on flag", () => {
    const store = override(createFlagStore({ flags: [flag({ key: "on", enabled: true })] }), "on", false);
    expect(resolveAll(store, ctx("u1"))[0]).toEqual({
      key: "on",
      enabled: false,
      reason: "override",
      source: "override",
    });
  });
});

describe("snapshot", () => {
  it("returns the registry plus both override layers", () => {
    let store = createFlagStore({ flags: [flag({ key: "b" }), flag({ key: "a" })] });
    store = applyFlagEnv(store, { FLAG_A: "false" });
    store = override(store, "b", true);
    expect(snapshot(store)).toEqual({
      flags: [
        { key: "b", enabled: false },
        { key: "a", enabled: false },
      ],
      overrides: { b: true },
      env: { a: false },
    });
  });

  it("sorts override keys so the snapshot is stable", () => {
    let store = override(createFlagStore(), "b", true);
    store = override(store, "a", false);
    expect(Object.keys(snapshot(store).overrides)).toEqual(["a", "b"]);
    expect(snapshot(store)).toEqual(snapshot(store));
  });

  it("returns copies, so mutating a snapshot cannot reach the store", () => {
    const store = override(createFlagStore({ flags: [flag({ key: "a" })] }), "a", true);
    const snap = snapshot(store);
    (snap.overrides as Record<string, boolean>).a = false;
    (snap.flags as Flag[]).push(flag({ key: "b" }));
    expect(snapshot(store).overrides).toEqual({ a: true });
    expect(snapshot(store).flags.map((entry) => entry.key)).toEqual(["a"]);
  });

  it("is serialisable JSON", () => {
    const store: FlagStore = applyFlagEnv(createFlagStore({ flags: [flag({ key: "a" })] }), { FLAG_A: "true" });
    expect(JSON.parse(JSON.stringify(snapshot(store)))).toEqual({
      flags: [{ key: "a", enabled: false }],
      overrides: {},
      env: { a: true },
    });
  });
});
