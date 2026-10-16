import { describe, expect, it } from "vitest";
import {
  DEFAULT_COALESCE_WINDOW_MS,
  DEFAULT_UNDO_LIMIT,
  canRedo,
  canUndo,
  clear,
  createUndoStack,
  group,
  historyView,
  mergeRemote,
  push,
  redo,
  type Command,
  type UndoStack,
  undo,
} from "./undo-redo";

/**
 * App-wide undo/redo engine (docs/FEATURE_MATRIX.md §16 "Undo/redo (global)",
 * MISSING_FEATURES gap #13).
 *
 * Red-first: this file was written BEFORE `src/lib/undo-redo.ts` existed, so it
 * pins the engine's product decisions rather than describing an implementation.
 * State is a plain number; `step` is an invertible command (+n / -n), which
 * makes every transition readable as arithmetic.
 */

/** An invertible numeric add: `apply` adds `delta`, `invert` removes it. */
function step(delta: number, extra: Partial<Command<number>> = {}): Command<number> {
  return {
    id: extra.id ?? `step:${delta}`,
    label: extra.label ?? (delta < 0 ? `${delta}` : `+${delta}`),
    apply: (state) => state + delta,
    invert: (state) => state - delta,
    ...extra,
  };
}

/** A stack over `number` starting from `state` with an optional limit. */
function stackOf(
  state = 0,
  config: { limit?: number; coalesceWindowMs?: number } = {},
): UndoStack<number> {
  return createUndoStack<number>({ limit: config.limit, coalesceWindowMs: config.coalesceWindowMs, state });
}

/** Fold the applied commands of a stack back over `base`, for invariant checks. */
function replay(stack: UndoStack<number>, base: number): number {
  return stack.entries
    .filter((entry) => !entry.undone)
    .reduce((state, entry) => entry.command.apply(state), base);
}

describe("createUndoStack / limits", () => {
  it("starts empty at the given state with no undo or redo", () => {
    const stack = stackOf(0);
    expect(stack.entries).toEqual([]);
    expect(stack.state).toBe(0);
    expect(canUndo(stack)).toBe(false);
    expect(canRedo(stack)).toBe(false);
  });

  it("applies the default undo limit when none is given", () => {
    expect(stackOf(0).limit).toBe(DEFAULT_UNDO_LIMIT);
  });

  it("normalizes a fractional limit down to an integer", () => {
    expect(stackOf(0, { limit: 2.9 }).limit).toBe(2);
  });

  it("floors a non-positive limit up to one", () => {
    expect(stackOf(0, { limit: 0 }).limit).toBe(1);
    expect(stackOf(0, { limit: -5 }).limit).toBe(1);
  });

  it("falls back to the default limit for a non-finite limit", () => {
    expect(stackOf(0, { limit: Number.NaN }).limit).toBe(DEFAULT_UNDO_LIMIT);
    expect(stackOf(0, { limit: Number.POSITIVE_INFINITY }).limit).toBe(DEFAULT_UNDO_LIMIT);
  });

  it("uses the default coalesce window when none is given", () => {
    expect(stackOf(0).coalesceWindowMs).toBe(DEFAULT_COALESCE_WINDOW_MS);
  });
});

describe("push / undo / redo", () => {
  it("applies a pushed command to the state", () => {
    const stack = push(stackOf(0), step(3));
    expect(stack.state).toBe(3);
  });

  it("records one entry with the command's label and id", () => {
    const stack = push(stackOf(0), step(3, { id: "a", label: "Add three" }));
    expect(stack.entries).toHaveLength(1);
    expect(stack.entries[0].command.id).toBe("a");
    expect(stack.entries[0].command.label).toBe("Add three");
  });

  it("becomes undoable after a push but not redoable", () => {
    const stack = push(stackOf(0), step(3));
    expect(canUndo(stack)).toBe(true);
    expect(canRedo(stack)).toBe(false);
  });

  it("inverts the command on undo and moves it to the redo side", () => {
    const stack = push(stackOf(0), step(3));
    const undone = undo(stack);
    expect(undone.state).toBe(0);
    expect(canUndo(undone)).toBe(false);
    expect(canRedo(undone)).toBe(true);
  });

  it("re-applies the command on redo", () => {
    const stack = undo(push(stackOf(0), step(3)));
    expect(redo(stack).state).toBe(3);
  });

  it("is a no-op undoing an empty history", () => {
    const stack = stackOf(5);
    const undone = undo(stack);
    expect(undone.state).toBe(5);
    expect(undone.entries).toEqual([]);
  });

  it("is a no-op redoing an empty redo trail", () => {
    const stack = push(stackOf(0), step(3));
    const redone = redo(stack);
    expect(redone.state).toBe(3);
    expect(redone.entries).toHaveLength(1);
  });

  it("walks a multi-command history back and forward in order", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1));
    stack = push(stack, step(10, { id: "b" }));
    stack = push(stack, step(100, { id: "c" }));
    expect(stack.state).toBe(111);

    stack = undo(stack);
    expect(stack.state).toBe(11);
    stack = undo(stack);
    expect(stack.state).toBe(1);
    stack = undo(stack);
    expect(stack.state).toBe(0);
    expect(canUndo(stack)).toBe(false);

    stack = redo(stack);
    expect(stack.state).toBe(1);
    stack = redo(stack);
    expect(stack.state).toBe(11);
    stack = redo(stack);
    expect(stack.state).toBe(111);
    expect(canRedo(stack)).toBe(false);
  });

  it("does not mutate the stack handed to push", () => {
    const stack = stackOf(0);
    const pushed = push(stack, step(3));
    expect(stack.entries).toHaveLength(0);
    expect(stack.state).toBe(0);
    expect(pushed).not.toBe(stack);
  });

  it("does not mutate the stack handed to undo", () => {
    const stack = push(stackOf(0), step(3));
    const undone = undo(stack);
    expect(stack.state).toBe(3);
    expect(stack.entries[0].undone).toBe(false);
    expect(undone).not.toBe(stack);
  });
});

describe("coalescing", () => {
  it("merges adjacent pushes with the same key inside the window", () => {
    let stack = stackOf(0, { coalesceWindowMs: 500 });
    stack = push(stack, step(1, { coalesceKey: "type", at: 100 }));
    stack = push(stack, step(1, { coalesceKey: "type", at: 200 }));
    expect(stack.entries).toHaveLength(1);
    expect(stack.state).toBe(2);
  });

  it("reverts a coalesced run in a single undo", () => {
    let stack = stackOf(0, { coalesceWindowMs: 500 });
    stack = push(stack, step(1, { coalesceKey: "type", at: 0 }));
    stack = push(stack, step(1, { coalesceKey: "type", at: 100 }));
    stack = push(stack, step(1, { coalesceKey: "type", at: 200 }));
    expect(stack.state).toBe(3);
    expect(undo(stack).state).toBe(0);
  });

  it("keeps the first command's label on the merged entry", () => {
    let stack = stackOf(0, { coalesceWindowMs: 500 });
    stack = push(stack, step(1, { id: "first", label: "Type", coalesceKey: "type", at: 0 }));
    stack = push(stack, step(1, { id: "second", label: "Type more", coalesceKey: "type", at: 10 }));
    expect(stack.entries[0].command.id).toBe("first");
    expect(stack.entries[0].command.label).toBe("Type");
  });

  it("merges exactly at the window boundary", () => {
    let stack = stackOf(0, { coalesceWindowMs: 500 });
    stack = push(stack, step(1, { coalesceKey: "type", at: 100 }));
    stack = push(stack, step(1, { coalesceKey: "type", at: 600 }));
    expect(stack.entries).toHaveLength(1);
  });

  it("does not merge past the window boundary", () => {
    let stack = stackOf(0, { coalesceWindowMs: 500 });
    stack = push(stack, step(1, { coalesceKey: "type", at: 100 }));
    stack = push(stack, step(1, { coalesceKey: "type", at: 601 }));
    expect(stack.entries).toHaveLength(2);
    expect(stack.state).toBe(2);
  });

  it("does not merge commands with different keys", () => {
    let stack = stackOf(0, { coalesceWindowMs: 500 });
    stack = push(stack, step(1, { coalesceKey: "type", at: 0 }));
    stack = push(stack, step(1, { coalesceKey: "move", at: 10 }));
    expect(stack.entries).toHaveLength(2);
  });

  it("never merges commands with an empty key", () => {
    let stack = stackOf(0, { coalesceWindowMs: 500 });
    stack = push(stack, step(1, { coalesceKey: "", at: 0 }));
    stack = push(stack, step(1, { coalesceKey: "", at: 10 }));
    expect(stack.entries).toHaveLength(2);
  });

  it("does not merge across a different command in between", () => {
    let stack = stackOf(0, { coalesceWindowMs: 500 });
    stack = push(stack, step(1, { coalesceKey: "type", at: 0 }));
    stack = push(stack, step(1, { at: 10 }));
    stack = push(stack, step(1, { coalesceKey: "type", at: 20 }));
    expect(stack.entries).toHaveLength(3);
  });

  it("does not merge an edit made after an undo", () => {
    let stack = stackOf(0, { coalesceWindowMs: 500 });
    stack = push(stack, step(1, { coalesceKey: "type", at: 0 }));
    stack = undo(stack);
    stack = push(stack, step(1, { coalesceKey: "type", at: 10 }));
    expect(stack.entries).toHaveLength(1);
    expect(stack.state).toBe(1);
  });

  it("merges a run with an explicit zero-width window only at the same instant", () => {
    let stack = stackOf(0, { coalesceWindowMs: 0 });
    stack = push(stack, step(1, { coalesceKey: "type", at: 5 }));
    stack = push(stack, step(1, { coalesceKey: "type", at: 5 }));
    stack = push(stack, step(1, { coalesceKey: "type", at: 6 }));
    expect(stack.entries).toHaveLength(2);
  });
});

describe("grouping", () => {
  it("applies every command in a group in order", () => {
    const stack = push(stackOf(0), group("Move", [step(1), step(10), step(100)]));
    expect(stack.state).toBe(111);
  });

  it("inverts a group in reverse order", () => {
    const grouped = group("Move", [step(1), step(10), step(100)]);
    expect(grouped.invert(grouped.apply(0))).toBe(0);
  });

  it("records a group as a single history entry with the group label", () => {
    const stack = push(stackOf(0), group("Move", [step(1), step(10)]));
    expect(stack.entries).toHaveLength(1);
    expect(stack.entries[0].command.label).toBe("Move");
  });

  it("undoes and redoes a whole group as one step", () => {
    const stack = push(stackOf(0), group("Move", [step(1), step(10), step(100)]));
    const undone = undo(stack);
    expect(undone.state).toBe(0);
    expect(canUndo(undone)).toBe(false);
    expect(redo(undone).state).toBe(111);
  });

  it("treats an empty group as the identity command", () => {
    const grouped = group("Nothing", []);
    expect(grouped.apply(7)).toBe(7);
    expect(grouped.invert(7)).toBe(7);
  });

  it("auto-groups adjacent pushes that share a group key", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1, { id: "g1", groupKey: "g" }));
    stack = push(stack, step(10, { id: "g2", groupKey: "g" }));
    expect(stack.entries).toHaveLength(1);
    expect(stack.state).toBe(11);
    expect(undo(stack).state).toBe(0);
  });

  it("does not auto-group pushes with different group keys", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1, { groupKey: "a" }));
    stack = push(stack, step(10, { groupKey: "b" }));
    expect(stack.entries).toHaveLength(2);
  });

  it("gives a group a deterministic id derived from its label", () => {
    const first = group("Move", [step(1)]);
    const second = group("Move", [step(1)]);
    expect(first.id).toBe(second.id);
    expect(group("Other", [step(1)]).id).not.toBe(first.id);
  });
});

describe("branch truncation", () => {
  it("drops the redo branch when a new command is pushed after an undo", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1, { id: "a" }));
    stack = push(stack, step(10, { id: "b" }));
    stack = undo(stack);
    stack = push(stack, step(100, { id: "c" }));
    expect(canRedo(stack)).toBe(false);
    expect(stack.entries.map((entry) => entry.command.id)).toEqual(["a", "c"]);
    expect(stack.state).toBe(101);
  });

  it("truncates a deep redo branch down to the cursor", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1, { id: "a" }));
    stack = push(stack, step(10, { id: "b" }));
    stack = push(stack, step(100, { id: "c" }));
    stack = undo(stack);
    stack = undo(stack);
    stack = push(stack, step(7, { id: "d" }));
    expect(stack.entries.map((entry) => entry.command.id)).toEqual(["a", "d"]);
    expect(stack.state).toBe(8);
  });

  it("keeps the deleted branch out of historyView", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1, { id: "a" }));
    stack = push(stack, step(10, { id: "b" }));
    stack = undo(stack);
    stack = push(stack, step(100, { id: "c" }));
    expect(historyView(stack).entries.map((entry) => entry.label)).toEqual(["+1", "+100"]);
  });
});

describe("limit trimming", () => {
  it("keeps at most `limit` entries, dropping the oldest", () => {
    let stack = stackOf(0, { limit: 2 });
    stack = push(stack, step(1, { id: "a" }));
    stack = push(stack, step(2, { id: "b" }));
    stack = push(stack, step(3, { id: "c" }));
    expect(stack.entries).toHaveLength(2);
    expect(stack.entries.map((entry) => entry.command.id)).toEqual(["b", "c"]);
  });

  it("keeps the present state intact when the oldest entry is trimmed", () => {
    let stack = stackOf(0, { limit: 1 });
    stack = push(stack, step(5, { id: "a" }));
    stack = push(stack, step(5, { id: "b" }));
    expect(stack.state).toBe(10);
  });

  it("stops undo at the trimmed floor", () => {
    let stack = stackOf(0, { limit: 2 });
    stack = push(stack, step(1, { id: "a" }));
    stack = push(stack, step(2, { id: "b" }));
    stack = push(stack, step(3, { id: "c" }));
    stack = undo(stack);
    expect(stack.state).toBe(3);
    stack = undo(stack);
    expect(stack.state).toBe(1); // the trimmed `+1` can no longer be undone
    expect(canUndo(stack)).toBe(false);
  });

  it("counts a coalesced run as a single entry against the limit", () => {
    let stack = stackOf(0, { limit: 1, coalesceWindowMs: 500 });
    stack = push(stack, step(1, { coalesceKey: "type", at: 0 }));
    stack = push(stack, step(1, { coalesceKey: "type", at: 10 }));
    stack = push(stack, step(1, { coalesceKey: "type", at: 20 }));
    expect(stack.entries).toHaveLength(1);
    expect(stack.state).toBe(3);
  });
});

describe("historyView", () => {
  it("returns no entries and a zero cursor for an empty stack", () => {
    const view = historyView(stackOf(0));
    expect(view.entries).toEqual([]);
    expect(view.cursor).toBe(0);
    expect(view.total).toBe(0);
  });

  it("lists entries oldest first with their labels", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1, { id: "a", label: "One" }));
    stack = push(stack, step(2, { id: "b", label: "Two" }));
    stack = push(stack, step(3, { id: "c", label: "Three" }));
    expect(historyView(stack).entries.map((entry) => entry.label)).toEqual(["One", "Two", "Three"]);
  });

  it("moves the cursor back as commands are undone", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1));
    stack = push(stack, step(2));
    stack = push(stack, step(3));
    expect(historyView(stack).cursor).toBe(3);
    stack = undo(stack);
    expect(historyView(stack).cursor).toBe(2);
    stack = undo(stack);
    expect(historyView(stack).cursor).toBe(1);
  });

  it("marks undone entries as not applied while keeping them listed", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1, { id: "a" }));
    stack = push(stack, step(2, { id: "b" }));
    stack = undo(stack);
    const view = historyView(stack);
    expect(view.entries.map((entry) => entry.applied)).toEqual([true, false]);
    expect(view.total).toBe(2);
  });

  it("exposes group and coalesce keys on entries", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1, { groupKey: "g" }));
    stack = push(stack, step(2, { coalesceKey: "type", at: 0 }));
    const [grouped, coalesced] = historyView(stack).entries;
    expect(grouped.groupKey).toBe("g");
    expect(coalesced.coalesceKey).toBe("type");
  });
});

describe("mergeRemote", () => {
  it("applies a remote command to the shared state", () => {
    const stack = mergeRemote(stackOf(0), step(10, { id: "remote" }));
    expect(stack.state).toBe(10);
  });

  it("records the remote command as a remote entry", () => {
    const stack = mergeRemote(stackOf(0), step(10, { id: "remote" }));
    expect(stack.entries).toHaveLength(1);
    const [entry] = historyView(stack).entries;
    expect(entry.remote).toBe(true);
    expect(entry.applied).toBe(true);
    expect(entry.skipped).toBe(false);
  });

  it("does not make a remote command locally undoable on its own", () => {
    const stack = mergeRemote(stackOf(0), step(10, { id: "remote" }));
    expect(canUndo(stack)).toBe(false);
    expect(undo(stack).state).toBe(10);
  });

  it("skips and marks a remote command when undoing a local one beneath it", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1, { id: "mine" }));
    stack = mergeRemote(stack, step(10, { id: "theirs" }));
    expect(stack.state).toBe(11);

    const undone = undo(stack);
    expect(undone.state).toBe(10);
    const [mine, theirs] = historyView(undone).entries;
    expect(mine.applied).toBe(false);
    expect(theirs.remote).toBe(true);
    expect(theirs.skipped).toBe(true);
  });

  it("re-applies the local command on redo while the remote stays applied", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1, { id: "mine" }));
    stack = mergeRemote(stack, step(10, { id: "theirs" }));
    stack = undo(stack);
    const redone = redo(stack);
    expect(redone.state).toBe(11);
  });

  it("truncates the redo branch when a remote command lands after an undo", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1, { id: "mine" }));
    stack = push(stack, step(2, { id: "mine2" }));
    stack = undo(stack);
    stack = mergeRemote(stack, step(10, { id: "theirs" }));
    expect(canRedo(stack)).toBe(false);
    expect(stack.entries.map((entry) => entry.command.id)).toEqual(["mine", "theirs"]);
    expect(stack.state).toBe(11);
  });

  it("never coalesces a remote command into the local run before it", () => {
    let stack = stackOf(0, { coalesceWindowMs: 1000 });
    stack = push(stack, step(1, { coalesceKey: "type", at: 0 }));
    stack = mergeRemote(stack, step(1, { coalesceKey: "type", at: 10 }));
    expect(stack.entries).toHaveLength(2);
  });

  it("honours the limit for remote entries too", () => {
    let stack = stackOf(0, { limit: 1 });
    stack = mergeRemote(stack, step(1, { id: "r1" }));
    stack = mergeRemote(stack, step(2, { id: "r2" }));
    expect(stack.entries).toHaveLength(1);
    expect(stack.state).toBe(3);
  });
});

describe("clear", () => {
  it("discards all history while keeping the present state", () => {
    let stack = stackOf(0);
    stack = push(stack, step(3));
    stack = push(stack, step(4));
    const cleared = clear(stack);
    expect(cleared.state).toBe(7);
    expect(cleared.entries).toEqual([]);
    expect(canUndo(cleared)).toBe(false);
    expect(canRedo(cleared)).toBe(false);
  });

  it("keeps the configured limit and coalesce window", () => {
    const stack = clear(stackOf(0, { limit: 3, coalesceWindowMs: 50 }));
    expect(stack.limit).toBe(3);
    expect(stack.coalesceWindowMs).toBe(50);
  });
});

describe("invariants", () => {
  it("keeps the state equal to a replay of the applied commands", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1));
    stack = push(stack, step(10));
    stack = push(stack, step(100));
    stack = undo(stack);
    stack = redo(stack);
    stack = undo(stack);
    expect(stack.state).toBe(replay(stack, 0));
  });

  it("keeps the history cursor equal to the number of applied entries", () => {
    let stack = stackOf(0);
    stack = push(stack, step(1));
    stack = push(stack, step(2));
    stack = push(stack, step(3));
    stack = undo(stack);
    const view = historyView(stack);
    expect(view.cursor).toBe(view.entries.filter((entry) => entry.applied).length);
  });

  it("round-trips any undo/redo sequence back to the replayed state", () => {
    const start = replay(
      (() => {
        let stack = stackOf(0);
        stack = push(stack, step(1));
        stack = undo(stack);
        stack = redo(stack);
        return stack;
      })(),
      0,
    );
    expect(start).toBe(1);
  });
});
