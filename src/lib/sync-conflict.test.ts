import { describe, expect, it, vi } from "vitest";
import {
  UNRESOLVED,
  autoResolve,
  detectConflicts,
  describeConflict,
  type FieldConflict,
} from "./sync-conflict";

/**
 * Sync conflict handling (S23) — pure, red-first.
 *
 * `src/lib/sync-conflict.ts` did not exist when this file was first written
 * (module-not-found -> suite red; scripts/LOOP_PLAYBOOK.md "Red-first").
 *
 * When two replicas edit the same record from a shared base, three-way merges
 * go wrong in exactly one place: fields both sides changed to *different*
 * values. This module names those conflicts (`detectConflicts`), resolves or
 * defers them by strategy (`autoResolve`), and renders one for a human
 * (`describeConflict`) — no Prisma, no React, no clock, no I/O.
 *
 * Contract pinned here:
 *  - a field is a conflict only when BOTH sides moved off `base` AND their
 *    resulting values are not deeply equal;
 *  - detection is shallow (top-level fields) and ASCII-ordered for determinism;
 *  - `local-wins` / `remote-wins` resolve every conflict, `manual` resolves none,
 *    and `merge` (the default) deep-merges objects / unions arrays, deferring
 *    only what it cannot reconcile;
 *  - inputs are never mutated and every helper is total (never throws).
 */

describe("detectConflicts", () => {
  it("returns no conflicts when both sides are unchanged", () => {
    expect(detectConflicts({ a: 1 }, { a: 1 }, { a: 1 })).toEqual([]);
  });

  it("ignores a field changed on only one side", () => {
    expect(detectConflicts({ a: 2 }, { a: 1 }, { a: 1 })).toEqual([]);
    expect(detectConflicts({ a: 1 }, { a: 2 }, { a: 1 })).toEqual([]);
  });

  it("ignores a field both sides changed to the same value", () => {
    expect(detectConflicts({ a: 2 }, { a: 2 }, { a: 1 })).toEqual([]);
  });

  it("reports a changed/changed conflict with base and both values", () => {
    expect(detectConflicts({ title: "B" }, { title: "C" }, { title: "A" })).toEqual([
      {
        field: "title",
        base: "A",
        local: "B",
        remote: "C",
        localOp: "changed",
        remoteOp: "changed",
      },
    ]);
  });

  it("reports an added/added conflict", () => {
    expect(detectConflicts({ x: 1 }, { x: 2 }, {})).toEqual([
      { field: "x", base: undefined, local: 1, remote: 2, localOp: "added", remoteOp: "added" },
    ]);
  });

  it("reports a removed/changed conflict", () => {
    expect(detectConflicts({}, { tags: ["b"] }, { tags: ["a"] })).toEqual([
      {
        field: "tags",
        base: ["a"],
        local: undefined,
        remote: ["b"],
        localOp: "removed",
        remoteOp: "changed",
      },
    ]);
  });

  it("reports a changed/removed conflict", () => {
    expect(detectConflicts({ tags: ["b"] }, {}, { tags: ["a"] })).toEqual([
      {
        field: "tags",
        base: ["a"],
        local: ["b"],
        remote: undefined,
        localOp: "changed",
        remoteOp: "removed",
      },
    ]);
  });

  it("does not report a field both sides removed", () => {
    expect(detectConflicts({}, {}, { tags: ["a"] })).toEqual([]);
  });

  it("compares nested values deeply, ignoring key order", () => {
    expect(detectConflicts({ cfg: { x: 1, y: 2 } }, { cfg: { y: 2, x: 1 } }, {})).toEqual([]);
  });

  it("treats array reordering as a conflict", () => {
    expect(detectConflicts({ list: [1, 2] }, { list: [2, 1] }, { list: [] })).toHaveLength(1);
  });

  it("treats explicit null as a value, not as absence", () => {
    expect(detectConflicts({ a: null }, {}, { a: 1 })).toEqual([
      {
        field: "a",
        base: 1,
        local: null,
        remote: undefined,
        localOp: "changed",
        remoteOp: "removed",
      },
    ]);
  });

  it("orders conflicts ASCII-ascending by field", () => {
    const conflicts = detectConflicts(
      { b: 2, a: 2, c: 2 },
      { b: 3, a: 3, c: 3 },
      { b: 1, a: 1, c: 1 },
    );
    expect(conflicts.map((conflict) => conflict.field)).toEqual(["a", "b", "c"]);
  });

  it("degrades non-record inputs to empty records", () => {
    expect(detectConflicts(42, "nope", null)).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const local = { a: { deep: 1 } };
    const remote = { a: { deep: 2 } };
    const base = { a: { deep: 0 } };
    detectConflicts(local, remote, base);
    expect(local).toEqual({ a: { deep: 1 } });
    expect(remote).toEqual({ a: { deep: 2 } });
    expect(base).toEqual({ a: { deep: 0 } });
  });
});

describe("autoResolve", () => {
  it("defaults to the merge strategy", () => {
    expect(autoResolve({}, {}, {}).strategy).toBe("merge");
  });

  it("applies a single-side change without reporting a conflict", () => {
    const result = autoResolve({ b: 2 }, { b: 1 }, { b: 1 });
    expect(result.record).toEqual({ b: 2 });
    expect(result.conflicts).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("keeps fields unchanged on both sides", () => {
    const result = autoResolve(
      { a: 1, b: 2 },
      { a: 1, b: 1 },
      { a: 1, b: 1 },
      { strategy: "local-wins" },
    );
    expect(result.record).toEqual({ a: 1, b: 2 });
  });

  it("local-wins takes the local value for every conflict", () => {
    const result = autoResolve(
      { title: "B", n: 5 },
      { title: "C", n: 6 },
      { title: "A", n: 0 },
      { strategy: "local-wins" },
    );
    expect(result.record).toEqual({ title: "B", n: 5 });
    expect(result.resolved).toEqual(["n", "title"]);
    expect(result.unresolved).toEqual([]);
  });

  it("remote-wins takes the remote value for every conflict", () => {
    const result = autoResolve({ title: "B" }, { title: "C" }, { title: "A" }, {
      strategy: "remote-wins",
    });
    expect(result.record).toEqual({ title: "C" });
    expect(result.resolved).toEqual(["title"]);
    expect(result.unresolved).toEqual([]);
  });

  it("manual resolves nothing and omits conflicts from the record", () => {
    const result = autoResolve(
      { title: "B", keep: 1 },
      { title: "C", keep: 1 },
      { title: "A", keep: 1 },
      { strategy: "manual" },
    );
    expect(result.record).toEqual({ keep: 1 });
    expect(result.resolved).toEqual([]);
    expect(result.unresolved.map((conflict) => conflict.field)).toEqual(["title"]);
  });

  it("merge applies clean changes while deferring a scalar conflict", () => {
    const result = autoResolve(
      { title: "B", added: 9 },
      { title: "C", added: 1 },
      { title: "A", added: 1 },
      { strategy: "merge" },
    );
    expect(result.record).toEqual({ added: 9 });
    expect(result.unresolved.map((conflict) => conflict.field)).toEqual(["title"]);
  });

  it("merge deep-merges conflicting plain objects", () => {
    const result = autoResolve(
      { cfg: { theme: "dark", size: 2 } },
      { cfg: { theme: "light", size: 2 } },
      { cfg: { theme: "light", size: 1 } },
      { strategy: "merge" },
    );
    expect(result.record).toEqual({ cfg: { size: 2, theme: "dark" } });
    expect(result.conflicts.map((conflict) => conflict.field)).toEqual(["cfg"]);
    expect(result.resolved).toEqual(["cfg"]);
    expect(result.unresolved).toEqual([]);
  });

  it("merge defers an object whose nested leaf diverges", () => {
    const result = autoResolve(
      { cfg: { theme: "dark" } },
      { cfg: { theme: "neon" } },
      { cfg: { theme: "light" } },
      { strategy: "merge" },
    );
    expect(result.record).toEqual({});
    expect(result.unresolved.map((conflict) => conflict.field)).toEqual(["cfg"]);
  });

  it("merge unions conflicting arrays in a stable order", () => {
    const result = autoResolve(
      { tags: ["a", "b"] },
      { tags: ["b", "c"] },
      { tags: ["a"] },
      { strategy: "merge" },
    );
    expect(result.record).toEqual({ tags: ["a", "b", "c"] });
    expect(result.unresolved).toEqual([]);
  });

  it("uses a custom merge function to resolve conflicts", () => {
    const result = autoResolve({ n: 1 }, { n: 2 }, { n: 0 }, {
      strategy: "merge",
      merge: (conflict) => (conflict.local as number) + (conflict.remote as number),
    });
    expect(result.record).toEqual({ n: 3 });
    expect(result.resolved).toEqual(["n"]);
    expect(result.unresolved).toEqual([]);
  });

  it("treats a custom UNRESOLVED result as unresolved", () => {
    const merge = vi.fn(() => UNRESOLVED);
    const result = autoResolve({ n: 1 }, { n: 2 }, { n: 0 }, { strategy: "merge", merge });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(result.unresolved.map((conflict) => conflict.field)).toEqual(["n"]);
  });

  it("removes a field when the winning side removed it", () => {
    const base = { tags: ["a"] };
    const remote = { tags: ["b"] };
    expect(autoResolve({}, remote, base, { strategy: "local-wins" }).record).toEqual({});
    expect(autoResolve({}, remote, base, { strategy: "remote-wins" }).record).toEqual({
      tags: ["b"],
    });
  });

  it("does not mutate inputs and returns a fresh record", () => {
    const local = { a: 1 };
    const remote = { a: 1 };
    const base = { a: 1 };
    const result = autoResolve(local, remote, base);
    expect(result.record).not.toBe(local);
    expect(local).toEqual({ a: 1 });
    expect(remote).toEqual({ a: 1 });
    expect(base).toEqual({ a: 1 });
  });
});

describe("describeConflict", () => {
  it("describes a changed/changed conflict", () => {
    const conflict: FieldConflict = {
      field: "title",
      base: "A",
      local: "B",
      remote: "C",
      localOp: "changed",
      remoteOp: "changed",
    };
    expect(describeConflict(conflict)).toBe(
      'title: local changed "B", remote changed "C"; base "A"',
    );
  });

  it("renders an absent value as none", () => {
    const conflict: FieldConflict = {
      field: "tags",
      base: ["a"],
      local: undefined,
      remote: ["b"],
      localOp: "removed",
      remoteOp: "changed",
    };
    expect(describeConflict(conflict)).toBe(
      'tags: local removed none, remote changed ["b"]; base ["a"]',
    );
  });

  it("serialises object values as JSON", () => {
    const conflict: FieldConflict = {
      field: "cfg",
      base: { a: 1 },
      local: { a: 2 },
      remote: { a: 3 },
      localOp: "changed",
      remoteOp: "changed",
    };
    expect(describeConflict(conflict)).toBe(
      'cfg: local changed {"a":2}, remote changed {"a":3}; base {"a":1}',
    );
  });
});
