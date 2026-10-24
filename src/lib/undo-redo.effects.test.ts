import { describe, expect, it } from "vitest";
import {
  createUndoStack,
  nextRedoCommand,
  nextUndoCommand,
  push,
  redo,
  undo,
} from "./undo-redo";

const command = (id: string) => ({
  id,
  label: id,
  apply: <S>(state: S) => state,
  invert: <S>(state: S) => state,
});

describe("undo/redo effect commands", () => {
  it("exposes the next undo and redo command", () => {
    const stack = push(
      push(createUndoStack<Record<string, unknown>>({ state: {} }), command("a")),
      command("b"),
    );
    expect(nextUndoCommand(stack)?.id).toBe("b");
    expect(nextRedoCommand(stack)).toBeNull();

    const undone = undo(stack);
    expect(nextUndoCommand(undone)?.id).toBe("a");
    expect(nextRedoCommand(undone)?.id).toBe("b");
    expect(nextRedoCommand(redo(undone))).toBeNull();
  });

  it("returns null on an empty history", () => {
    const stack = createUndoStack<Record<string, unknown>>({ state: {} });
    expect(nextUndoCommand(stack)).toBeNull();
    expect(nextRedoCommand(stack)).toBeNull();
  });

  it("chains effects when rapid edits coalesce", async () => {
    const calls: string[] = [];
    const effect = (name: string) => ({
      id: name,
      label: name,
      apply: <S>(state: S) => state,
      invert: <S>(state: S) => state,
      coalesceKey: "cell",
      at: 1,
      onUndo: () => {
        calls.push(`undo:${name}`);
      },
      onRedo: () => {
        calls.push(`redo:${name}`);
      },
    });
    const stack = push(
      push(createUndoStack<Record<string, unknown>>({ state: {} }), effect("a")),
      effect("b"),
    );
    const command = nextUndoCommand(stack);
    await command?.onUndo?.();
    await command?.onRedo?.();
    expect(calls).toEqual(["undo:b", "undo:a", "redo:a", "redo:b"]);
  });
});
