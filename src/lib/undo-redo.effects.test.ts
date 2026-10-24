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
});
