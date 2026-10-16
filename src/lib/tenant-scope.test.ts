import { describe, expect, it } from "vitest";
import {
  WorkspaceScopeError,
  assertWorkspaceMatch,
  isLive,
  isSoftDeleted,
  restoreSoftDeleted,
  scopeByWorkspace,
  softDelete,
  validateTransaction,
  withTransaction,
} from "./tenant-scope";
import type { ScopedWrite, SoftDeletable, WorkspaceScoped } from "./tenant-scope";

/**
 * Pure multi-tenancy + soft-delete helpers (matrix rows "Multi-tenancy",
 * "Soft delete", "Transactions / atomic writes").
 *
 * Red-first: `src/lib/tenant-scope.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the helpers land.
 *
 * Everything here is synchronous and side-effect-free — no DB, routes, React
 * or clock. The two safety rules under test are "fail closed" (an unknown or
 * blank workspace never yields another tenant's rows) and "never mutate the
 * caller's data" (every helper returns fresh copies).
 */

type Row = WorkspaceScoped & { id: string };
const row = (id: string, workspaceId: string): Row => ({ id, workspaceId });

describe("scopeByWorkspace", () => {
  it("keeps only the requested workspace's rows, preserving input order", () => {
    const rows = [row("a", "ws1"), row("b", "ws2"), row("c", "ws1"), row("d", "ws3")];
    expect(scopeByWorkspace(rows, "ws1").map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("keeps duplicate rows for the workspace (filter, not dedupe)", () => {
    const rows = [row("a", "ws1"), row("a", "ws1")];
    expect(scopeByWorkspace(rows, "ws1")).toHaveLength(2);
  });

  it("never returns a foreign workspace's rows, even when ids collide", () => {
    const rows = [row("shared", "ws1"), row("shared", "ws2")];
    expect(scopeByWorkspace(rows, "ws2").every((r) => r.workspaceId === "ws2")).toBe(true);
    expect(scopeByWorkspace(rows, "ws2")).toHaveLength(1);
  });

  it("fails closed to an empty list for a blank or non-string workspace id", () => {
    const rows = [row("a", "ws1")];
    for (const bad of ["", "   ", null, undefined, 42]) {
      expect(scopeByWorkspace(rows, bad as unknown as string)).toEqual([]);
    }
  });

  it("skips malformed rows instead of trusting them", () => {
    const rows = [
      row("ok", "ws1"),
      null,
      undefined,
      { id: "noWorkspace" },
      { id: "blank", workspaceId: "" },
      { id: "numeric", workspaceId: 7 },
    ] as unknown as WorkspaceScoped[];
    expect(scopeByWorkspace(rows, "ws1").map((r) => (r as Row).id)).toEqual(["ok"]);
  });

  it("fails closed when handed something that is not an array", () => {
    expect(scopeByWorkspace("nope" as unknown as Row[], "ws1")).toEqual([]);
  });

  it("returns a fresh array callers can mutate without touching the input", () => {
    const rows = [row("a", "ws1")];
    const scoped = scopeByWorkspace(rows, "ws1");
    scoped.push(row("b", "ws1"));
    expect(rows).toHaveLength(1);
  });
});

describe("assertWorkspaceMatch", () => {
  it("returns the row when it belongs to the workspace", () => {
    const r = row("a", "ws1");
    expect(assertWorkspaceMatch(r, "ws1")).toBe(r);
  });

  it("throws WorkspaceScopeError for a foreign row", () => {
    expect(() => assertWorkspaceMatch(row("a", "ws2"), "ws1")).toThrow(WorkspaceScopeError);
  });

  it("throws for a missing row", () => {
    expect(() => assertWorkspaceMatch(null, "ws1")).toThrow(WorkspaceScopeError);
    expect(() => assertWorkspaceMatch(undefined, "ws1")).toThrow(WorkspaceScopeError);
  });

  it("throws for a row with no usable workspace id", () => {
    for (const bad of [{ id: "x" }, { id: "x", workspaceId: "" }, { id: "x", workspaceId: 3 }]) {
      expect(() => assertWorkspaceMatch(bad as unknown as WorkspaceScoped, "ws1")).toThrow(
        WorkspaceScopeError,
      );
    }
  });

  it("throws for a blank or non-string expected workspace id", () => {
    for (const bad of ["", null, undefined, 3]) {
      expect(() =>
        assertWorkspaceMatch(row("a", "ws1"), bad as unknown as string),
      ).toThrow(WorkspaceScopeError);
    }
  });

  it("exposes the workspace and is an Error, without leaking the other tenant", () => {
    try {
      assertWorkspaceMatch(row("a", "ws2"), "ws1");
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as WorkspaceScopeError).workspaceId).toBe("ws1");
      expect(String((error as Error).message)).not.toContain("ws2");
    }
  });
});

describe("soft-delete predicates", () => {
  it("treats only a valid Date as deleted", () => {
    expect(isSoftDeleted({ deletedAt: new Date() })).toBe(true);
    expect(isSoftDeleted({ deletedAt: null })).toBe(false);
    expect(isSoftDeleted({ deletedAt: undefined })).toBe(false);
    expect(isSoftDeleted({})).toBe(false);
    expect(isSoftDeleted({ deletedAt: "2020-01-01" })).toBe(false);
    expect(isSoftDeleted({ deletedAt: new Date("nope") })).toBe(false);
    expect(isSoftDeleted(null)).toBe(false);
  });

  it("isLive is exactly the negation of isSoftDeleted", () => {
    expect(isLive({ deletedAt: null })).toBe(true);
    expect(isLive({ deletedAt: new Date() })).toBe(false);
    expect(isLive(null)).toBe(true);
  });

  it("softDelete stamps a copy and never mutates the input", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const before: SoftDeletable & { id: string } = { id: "a", deletedAt: null };
    const after = softDelete(before, now);
    expect(after).not.toBe(before);
    expect(after.deletedAt).toBe(now);
    expect(before.deletedAt).toBeNull();
    expect(after.id).toBe("a");
  });

  it("softDelete is idempotent: re-deleting keeps the original timestamp", () => {
    const first = new Date("2026-01-01T00:00:00Z");
    const second = new Date("2026-02-01T00:00:00Z");
    const after = softDelete(softDelete({ deletedAt: null }, first), second);
    expect(after.deletedAt).toBe(first);
  });

  it("softDelete refuses an invalid clock", () => {
    expect(() => softDelete({ deletedAt: null }, new Date("nope"))).toThrow(TypeError);
  });
});

describe("restoreSoftDeleted", () => {
  it("clears deletedAt on a copy without mutating the input", () => {
    const before = { id: "a", deletedAt: new Date("2026-01-01T00:00:00Z") };
    const after = restoreSoftDeleted(before);
    expect(after.deletedAt).toBeNull();
    expect(before.deletedAt).not.toBeNull();
    expect(after.id).toBe("a");
  });

  it("is idempotent on an already-live row", () => {
    const after = restoreSoftDeleted({ deletedAt: null });
    expect(after.deletedAt).toBeNull();
  });
});

describe("withTransaction", () => {
  const op = (model: string, operation: ScopedWrite["operation"], workspaceId: string): ScopedWrite => ({
    model,
    operation,
    workspaceId,
  });

  it("builds a plan for fully-scoped operations, preserving order", () => {
    const ops = [op("page", "create", "ws1"), op("propertyValue", "createMany", "ws1")];
    const plan = withTransaction(ops, "ws1");
    expect(plan.workspaceId).toBe("ws1");
    expect(plan.count).toBe(2);
    expect(plan.operations.map((o) => o.model)).toEqual(["page", "propertyValue"]);
  });

  it("copies the operations so callers cannot mutate the descriptor's source", () => {
    const ops = [op("page", "create", "ws1")];
    const plan = withTransaction(ops, "ws1");
    expect(plan.operations[0]).not.toBe(ops[0]);
    expect(plan.operations[0]).toEqual(ops[0]);
  });

  it("throws when any operation belongs to another workspace", () => {
    const ops = [op("page", "create", "ws1"), op("page", "update", "ws2")];
    expect(() => withTransaction(ops, "ws1")).toThrow(WorkspaceScopeError);
  });

  it("throws when an operation is missing or blank-scoped", () => {
    expect(() => withTransaction([{ model: "page", operation: "create" } as ScopedWrite], "ws1")).toThrow(
      WorkspaceScopeError,
    );
    expect(() => withTransaction([op("page", "create", "")], "ws1")).toThrow(WorkspaceScopeError);
  });

  it("throws on a malformed operation or unknown verb", () => {
    const malformed = [
      [{ operation: "create", workspaceId: "ws1" }],
      [{ model: "page", workspaceId: "ws1" }],
      [{ model: "page", operation: "truncate", workspaceId: "ws1" }],
      [null],
    ] as unknown as ScopedWrite[][];
    for (const ops of malformed) expect(() => withTransaction(ops, "ws1")).toThrow(WorkspaceScopeError);
  });

  it("throws when the target workspace id is blank", () => {
    expect(() => withTransaction([op("page", "create", "ws1")], "" as unknown as string)).toThrow(
      WorkspaceScopeError,
    );
  });
});

describe("validateTransaction", () => {
  const op = (model: string, operation: string, workspaceId: unknown): ScopedWrite =>
    ({ model, operation, workspaceId }) as unknown as ScopedWrite;

  it("returns no issues for a clean, fully-scoped list", () => {
    expect(validateTransaction([op("page", "create", "ws1")], "ws1")).toEqual([]);
  });

  it("flags a foreign-workspace operation with its index", () => {
    const issues = validateTransaction([op("page", "create", "ws1"), op("page", "update", "ws2")], "ws1");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ index: 1, reason: "foreign-workspace" });
  });

  it("flags a missing-workspace operation", () => {
    const issues = validateTransaction([op("page", "create", undefined)], "ws1");
    expect(issues[0]).toMatchObject({ index: 0, reason: "missing-workspace" });
  });

  it("flags malformed operations and unknown verbs", () => {
    const issues = validateTransaction(
      [null, op("page", "truncate", "ws1"), op("", "create", "ws1")] as unknown as ScopedWrite[],
      "ws1",
    );
    expect(issues.map((i) => i.reason)).toEqual([
      "malformed-operation",
      "malformed-operation",
      "malformed-operation",
    ]);
  });

  it("flags a blank target workspace once, index -1", () => {
    const issues = validateTransaction([op("page", "create", "ws1")], "" as unknown as string);
    expect(issues).toEqual([
      expect.objectContaining({ index: -1, reason: "invalid-workspace" }),
    ]);
  });

  it("aggregates every issue in input order", () => {
    const issues = validateTransaction(
      [op("page", "update", "ws2"), op("page", "create", "ws1"), op("page", "create", undefined)],
      "ws1",
    );
    expect(issues.map((i) => i.index)).toEqual([0, 2]);
  });
});
