import { describe, expect, it, vi } from "vitest";
import {
  bulkEffectCommand,
  bulkPatchCommand,
  isEmptyBulkPlan,
  planBulkChanges,
  sameBulkPatch,
} from "./undo-bulk";
import { createUndoStack, historyView, push, redo, undo } from "./undo-redo";

type Patch = Record<string, unknown>;

const change = (rowId: string, before: Patch, after: Patch) => ({
  rowId,
  before,
  after,
});

describe("planBulkChanges", () => {
  it("drops rows that would not change", () => {
    const plan = planBulkChanges("Set status", [
      change("a", { status: "todo" }, { status: "done" }),
      change("b", { status: "done" }, { status: "done" }),
    ]);
    expect(plan.changes.map((entry) => entry.rowId)).toEqual(["a"]);
    expect(isEmptyBulkPlan(plan)).toBe(false);
  });

  it("orders undo in reverse and redo in input order", () => {
    const plan = planBulkChanges("Set status", [
      change("a", { status: "todo" }, { status: "done" }),
      change("b", { status: "todo" }, { status: "done" }),
      change("c", { status: "todo" }, { status: "done" }),
    ]);
    expect(plan.redo.map((entry) => entry.rowId)).toEqual(["a", "b", "c"]);
    expect(plan.undo.map((entry) => entry.rowId)).toEqual(["c", "b", "a"]);
  });

  it("treats equal key order as a no-op, not a change", () => {
    expect(sameBulkPatch({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameBulkPatch({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("is empty for an empty selection", () => {
    expect(isEmptyBulkPlan(planBulkChanges("Nothing", []))).toBe(true);
  });
});

describe("bulkPatchCommand", () => {
  it("is null when nothing changed (nothing to advertise)", () => {
    const apply = vi.fn();
    const plan = planBulkChanges("Set status", [
      change("a", { status: "done" }, { status: "done" }),
    ]);
    expect(bulkPatchCommand(plan, apply)).toBeNull();
  });

  it("applies every before-patch in reverse on undo and after in order on redo", async () => {
    const calls: string[] = [];
    const apply = vi.fn(async (rowId: string, patch: Patch) => {
      calls.push(`${rowId}:${JSON.stringify(patch)}`);
    });
    const plan = planBulkChanges("Set status", [
      change("a", { status: "todo" }, { status: "done" }),
      change("b", { status: "in_progress" }, { status: "done" }),
    ]);
    const command = bulkPatchCommand(plan, apply, { at: 42 });
    expect(command).not.toBeNull();
    await command?.onUndo?.();
    await command?.onRedo?.();
    expect(calls).toEqual([
      'b:{"status":"in_progress"}',
      'a:{"status":"todo"}',
      'a:{"status":"done"}',
      'b:{"status":"done"}',
    ]);
    expect(command?.at).toBe(42);
  });

  it("records one history entry for a multi-row bulk edit", () => {
    const plan = planBulkChanges("Set status", [
      change("a", { status: "todo" }, { status: "done" }),
      change("b", { status: "todo" }, { status: "done" }),
    ]);
    const command = bulkPatchCommand<Record<string, unknown>, Patch>(plan, () => {});
    const stack = push(createUndoStack<Record<string, unknown>>({ state: {} }), command!);
    expect(stack.entries).toHaveLength(1);
    expect(undo(stack).state).toEqual({});
    expect(historyView(stack).entries[0].label).toBe("Set status");
    expect(redo(undo(stack)).entries).toHaveLength(1);
  });
});

describe("bulkEffectCommand", () => {
  it("runs one effect with a frozen copy of the selected ids", async () => {
    const undone: string[][] = [];
    const redone: string[][] = [];
    const ids = ["a", "b"];
    const command = bulkEffectCommand({
      label: "Archive 2 tickets",
      rowIds: ids,
      at: 7,
      undo: (rowIds) => {
        undone.push([...rowIds]);
      },
      redo: (rowIds) => {
        redone.push([...rowIds]);
      },
    });
    ids.push("c"); // later mutation must not change what history can undo
    await command.onUndo?.();
    await command.onRedo?.();
    expect(undone).toEqual([["a", "b"]]);
    expect(redone).toEqual([["a", "b"]]);
    expect(command.at).toBe(7);
    expect(command.label).toBe("Archive 2 tickets");
  });
});
