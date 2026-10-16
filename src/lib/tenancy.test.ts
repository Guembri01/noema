import { describe, expect, it } from "vitest";
import {
  TENANCY_VIOLATION,
  TenancyError,
  assertAllScoped,
  assertScoped,
  filterScoped,
  isScopedWhere,
  mergeScopes,
  scopeWhere,
} from "./tenancy";
import type { TenantScope } from "./tenancy";

/**
 * Multi-tenancy isolation engine (FEATURE_MATRIX row "Multi-tenancy" —
 * "Isolate workspaces.").
 *
 * Red-first: `src/lib/tenancy.ts` did not exist when this file was written, so
 * the suite fails on the missing module until the engine lands.
 *
 * Everything here is synchronous and side-effect-free — no DB, routes, React
 * or clock. The two rules under test are "fail closed" (an unknown or blank
 * workspace never yields another tenant's rows) and "never mutate the caller's
 * data" (every helper returns fresh values).
 */

type Row = { id: string; workspaceId?: unknown };
const row = (id: string, workspaceId: unknown): Row => ({ id, workspaceId });

describe("scopeWhere", () => {
  it("returns a Prisma-shaped where containing only the workspace id by default", () => {
    expect(scopeWhere({ workspaceId: "ws1" })).toEqual({ workspaceId: "ws1" });
    expect(Object.keys(scopeWhere({ workspaceId: "ws1" }))).toEqual(["workspaceId"]);
  });

  it("carries an optional user id into the where", () => {
    expect(scopeWhere({ workspaceId: "ws1", userId: "u1" })).toEqual({
      workspaceId: "ws1",
      userId: "u1",
    });
  });

  it("drops a blank user id instead of emitting an unscoped key", () => {
    expect(Object.keys(scopeWhere({ workspaceId: "ws1", userId: "   " }))).toEqual(["workspaceId"]);
  });

  it("throws a coded TenancyError for a blank or non-string workspace id", () => {
    for (const bad of ["", "   ", null, undefined, 7]) {
      const scope = { workspaceId: bad } as unknown as TenantScope;
      try {
        scopeWhere(scope);
        expect.unreachable("expected a throw");
      } catch (error) {
        expect(error).toBeInstanceOf(TenancyError);
        expect((error as TenancyError).code).toBe(TENANCY_VIOLATION);
      }
    }
  });
});

describe("assertScoped", () => {
  it("returns the very record it was handed when the workspace matches", () => {
    const record = row("a", "ws1");
    expect(assertScoped(record, { workspaceId: "ws1" })).toBe(record);
  });

  it("throws a coded TenancyError for a cross-workspace record", () => {
    try {
      assertScoped(row("a", "ws2"), { workspaceId: "ws1" });
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TenancyError);
      expect((error as TenancyError).code).toBe("TENANCY_VIOLATION");
    }
  });

  it("names the expected workspace without leaking the other tenant's id", () => {
    try {
      assertScoped(row("a", "ws2"), { workspaceId: "ws1" });
      expect.unreachable("expected a throw");
    } catch (error) {
      expect((error as TenancyError).workspaceId).toBe("ws1");
      expect((error as Error).message).not.toContain("ws2");
    }
  });

  it("fails closed for a missing record", () => {
    expect(() => assertScoped(null, { workspaceId: "ws1" })).toThrow(TenancyError);
    expect(() => assertScoped(undefined, { workspaceId: "ws1" })).toThrow(TenancyError);
  });

  it("fails closed for a record with no usable workspace id", () => {
    for (const bad of [{ id: "x" }, { id: "x", workspaceId: "" }, { id: "x", workspaceId: 3 }]) {
      expect(() => assertScoped(bad, { workspaceId: "ws1" })).toThrow(TenancyError);
    }
  });

  it("fails closed for a blank or non-string scope workspace id", () => {
    for (const bad of ["", null, undefined, 3]) {
      const scope = { workspaceId: bad } as unknown as TenantScope;
      expect(() => assertScoped(row("a", "ws1"), scope)).toThrow(TenancyError);
    }
  });

  it("scopes the top-level payload, not a nested relation", () => {
    const owned = { id: "a", workspaceId: "ws1", parent: { workspaceId: "ws2" } };
    expect(assertScoped(owned, { workspaceId: "ws1" })).toBe(owned);

    const foreign = { id: "a", workspaceId: "ws2", parent: { workspaceId: "ws1" } };
    expect(() => assertScoped(foreign, { workspaceId: "ws1" })).toThrow(TenancyError);
  });
});

describe("filterScoped", () => {
  it("keeps the requested workspace's rows, preserving input order", () => {
    const rows = [row("a", "ws1"), row("b", "ws2"), row("c", "ws1")];
    expect(filterScoped(rows, { workspaceId: "ws1" }).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("never returns a foreign workspace's rows, even when ids collide", () => {
    const rows = [row("shared", "ws1"), row("shared", "ws2")];
    const scoped = filterScoped(rows, { workspaceId: "ws2" });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].workspaceId).toBe("ws2");
  });

  it("fails closed to an empty list for a blank scope", () => {
    const rows = [row("a", "ws1")];
    for (const bad of ["", "   ", null, 42]) {
      const scope = { workspaceId: bad } as unknown as TenantScope;
      expect(filterScoped(rows, scope)).toEqual([]);
    }
  });

  it("skips malformed rows instead of trusting them", () => {
    const rows = [
      row("ok", "ws1"),
      null,
      undefined,
      { id: "noWorkspace" },
      { id: "numeric", workspaceId: 7 },
    ] as unknown as Row[];
    expect(filterScoped(rows, { workspaceId: "ws1" }).map((r) => r.id)).toEqual(["ok"]);
  });

  it("returns a fresh array that callers can mutate without touching the input", () => {
    const rows = [row("a", "ws1")];
    const scoped = filterScoped(rows, { workspaceId: "ws1" });
    scoped.push(row("b", "ws1"));
    expect(rows).toHaveLength(1);
  });
});

describe("mergeScopes", () => {
  it("merges two bare scopes that share a workspace", () => {
    expect(mergeScopes({ workspaceId: "ws1" }, { workspaceId: "ws1" })).toEqual({
      workspaceId: "ws1",
    });
  });

  it("keeps the one user id when only a single side pins a user", () => {
    expect(mergeScopes({ workspaceId: "ws1", userId: "u1" }, { workspaceId: "ws1" })).toEqual({
      workspaceId: "ws1",
      userId: "u1",
    });
  });

  it("keeps a user id that both sides agree on", () => {
    expect(
      mergeScopes({ workspaceId: "ws1", userId: "u1" }, { workspaceId: "ws1", userId: "u1" }),
    ).toEqual({ workspaceId: "ws1", userId: "u1" });
  });

  it("throws for disjoint workspaces", () => {
    expect(() => mergeScopes({ workspaceId: "ws1" }, { workspaceId: "ws2" })).toThrow(TenancyError);
  });

  it("throws when the two scopes pin different users in the same workspace", () => {
    try {
      mergeScopes({ workspaceId: "ws1", userId: "u1" }, { workspaceId: "ws1", userId: "u2" });
      expect.unreachable("expected a throw");
    } catch (error) {
      expect((error as TenancyError).code).toBe(TENANCY_VIOLATION);
    }
  });

  it("throws for a blank workspace on either side and never mutates its inputs", () => {
    expect(() => mergeScopes({ workspaceId: "" }, { workspaceId: "ws1" })).toThrow(TenancyError);

    const a: TenantScope = { workspaceId: "ws1", userId: "u1" };
    const b: TenantScope = { workspaceId: "ws1" };
    const merged = mergeScopes(a, b);
    expect(merged).not.toBe(a);
    expect(a).toEqual({ workspaceId: "ws1", userId: "u1" });
    expect(b).toEqual({ workspaceId: "ws1" });
  });
});

describe("isScopedWhere", () => {
  it("recognises a plain workspace-scoped where, extra keys included", () => {
    expect(isScopedWhere({ workspaceId: "ws1" })).toBe(true);
    expect(isScopedWhere({ workspaceId: "ws1", userId: "u1", archived: false })).toBe(true);
  });

  it("rejects blank and non-string workspace ids (no false positives)", () => {
    expect(isScopedWhere({ workspaceId: "" })).toBe(false);
    expect(isScopedWhere({ workspaceId: "   " })).toBe(false);
    expect(isScopedWhere({ workspaceId: 3 })).toBe(false);
    expect(isScopedWhere({ workspaceId: { not: null } })).toBe(false);
    expect(isScopedWhere({ workspaceId: null })).toBe(false);
  });

  it("rejects values that are not records", () => {
    for (const value of [null, undefined, "ws1", 42, []]) {
      expect(isScopedWhere(value)).toBe(false);
    }
    expect(isScopedWhere({})).toBe(false);
  });

  it("accepts an AND that constrains the workspace somewhere", () => {
    expect(isScopedWhere({ AND: [{ workspaceId: "ws1" }, { deletedAt: null }] })).toBe(true);
    expect(isScopedWhere({ AND: [{ AND: [{ workspaceId: "ws1" }] }] })).toBe(true);
  });

  it("rejects an empty or unscoped AND", () => {
    expect(isScopedWhere({ AND: [] })).toBe(false);
    expect(isScopedWhere({ AND: [{ deletedAt: null }] })).toBe(false);
  });

  it("accepts an OR only when every branch is scoped", () => {
    expect(isScopedWhere({ OR: [{ workspaceId: "ws1" }, { workspaceId: "ws2" }] })).toBe(true);
    expect(isScopedWhere({ OR: [{ workspaceId: "ws1" }, { archived: true }] })).toBe(false);
    expect(isScopedWhere({ OR: [] })).toBe(false);
  });

  it("does not treat a bare NOT as scoping", () => {
    expect(isScopedWhere({ NOT: { workspaceId: "ws1" } })).toBe(false);
  });
});

describe("assertAllScoped", () => {
  it("reports nothing when every record is scoped", () => {
    const rows = [row("a", "ws1"), row("b", "ws1")];
    expect(assertAllScoped(rows, { workspaceId: "ws1" })).toEqual([]);
  });

  it("reports a foreign-workspace record by index without leaking its id", () => {
    const rows = [row("a", "ws1"), row("b", "ws2")];
    const offenses = assertAllScoped(rows, { workspaceId: "ws1" });
    expect(offenses).toEqual([{ index: 1, reason: "foreign-workspace" }]);
    expect(JSON.stringify(offenses)).not.toContain("ws2");
  });

  it("reports missing and malformed workspaces in input order", () => {
    const rows = [
      row("a", "ws2"),
      row("b", "ws1"),
      { id: "c" },
      { id: "d", workspaceId: "" },
    ] as unknown as Row[];
    expect(assertAllScoped(rows, { workspaceId: "ws1" })).toEqual([
      { index: 0, reason: "foreign-workspace" },
      { index: 2, reason: "missing-workspace" },
      { index: 3, reason: "missing-workspace" },
    ]);
  });

  it("fails closed with a single invalid-scope offense for an unusable scope", () => {
    const rows = [row("a", "ws1")];
    for (const bad of ["", null, undefined, 9]) {
      const scope = { workspaceId: bad } as unknown as TenantScope;
      expect(assertAllScoped(rows, scope)).toEqual([{ index: -1, reason: "invalid-scope" }]);
    }
  });
});
