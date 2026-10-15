import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNDO_LIMIT,
  canRedo,
  canUndo,
  clear,
  createStack,
  peek,
  push,
  redo,
  undo,
  type UndoStack,
} from "./undo-stack";

/**
 * Bounded undo/redo stack (F8) — the pure, immutable history behind an editor's
 * undo/redo commands.
 *
 * Red-first: this file was written BEFORE `src/lib/undo-stack.ts` existed, so
 * every import resolved to module-not-found and the suite failed to collect. It
 * pins the model an editor leans on:
 *
 *  - `createStack` — an empty stack with a normalized history `limit`;
 *  - `push` — records a new present state, clears the redo trail, and merges
 *    consecutive edits that share a `coalesceKey` inside `coalesceWindowMs`;
 *  - `undo`/`redo` — walk the recorded states back and forward, no-ops at the
 *    ends, and reset coalescing so a post-undo edit never joins the old run;
 *  - `canUndo`/`canRedo`/`peek`/`clear` — read state and reset the stack;
 *  - the stack is capped at `limit`, dropping the oldest state;
 *  - every operation is pure: it returns a fresh stack and never mutates or
 *    aliases the arrays of the stack it was given, and no clock is read.
 */

const filled = (limit: number, ...states: number[]): UndoStack<number> =>
  states.reduce<UndoStack<number>>((stack, state) => push(stack, state), createStack<number>({ limit }));

describe("createStack", () => {
  it("starts empty with the requested limit", () => {
    const stack = createStack<number>({ limit: 5 });

    expect(stack.limit).toBe(5);
    expect(peek(stack)).toBeUndefined();
    expect(canUndo(stack)).toBe(false);
    expect(canRedo(stack)).toBe(false);
  });

  it("defaults and normalizes the limit", () => {
    expect(createStack<number>().limit).toBe(DEFAULT_UNDO_LIMIT);
    expect(createStack<number>({ limit: 3.9 }).limit).toBe(3);
    expect(createStack<number>({ limit: 0 }).limit).toBe(1);
    expect(createStack<number>({ limit: -5 }).limit).toBe(1);
    expect(createStack<number>({ limit: Number.NaN }).limit).toBe(DEFAULT_UNDO_LIMIT);
  });
});

describe("push + peek", () => {
  it("records the present state and gates undo on the first two pushes", () => {
    let stack = createStack<string>({ limit: 10 });

    stack = push(stack, "a");
    expect(peek(stack)).toBe("a");
    expect(canUndo(stack)).toBe(false);

    stack = push(stack, "b");
    expect(peek(stack)).toBe("b");
    expect(canUndo(stack)).toBe(true);
  });

  it("returns a fresh stack and never mutates the one it was given", () => {
    const base = push(createStack<number>({ limit: 4 }), 1);
    const snapshot = structuredClone(base);

    const next = push(base, 2);

    expect(base).toEqual(snapshot);
    expect(next).not.toBe(base);
    expect(peek(next)).toBe(2);
  });

  it("drops the redo trail when a new edit arrives", () => {
    let stack = filled(10, 1, 2);
    stack = undo(stack);
    expect(canRedo(stack)).toBe(true);

    stack = push(stack, 3);

    expect(canRedo(stack)).toBe(false);
    expect(peek(stack)).toBe(3);
  });
});

describe("undo + redo", () => {
  it("walks back and forward through edits", () => {
    let stack = filled(10, 1, 2, 3);

    stack = undo(stack);
    expect(peek(stack)).toBe(2);
    expect(canRedo(stack)).toBe(true);

    stack = undo(stack);
    expect(peek(stack)).toBe(1);
    expect(canUndo(stack)).toBe(false);

    stack = redo(stack);
    expect(peek(stack)).toBe(2);

    stack = redo(stack);
    expect(peek(stack)).toBe(3);
    expect(canRedo(stack)).toBe(false);
  });

  it("is a no-op at both ends", () => {
    const only = push(createStack<number>({ limit: 5 }), 1);
    expect(peek(undo(only))).toBe(1);
    expect(canRedo(undo(only))).toBe(false);

    const bottom = filled(5, 1, 2);
    expect(peek(undo(undo(bottom)))).toBe(1);
    expect(canUndo(undo(undo(bottom)))).toBe(false);
    expect(peek(redo(createStack<number>({ limit: 5 })))).toBeUndefined();
  });
});

describe("coalescing", () => {
  it("merges consecutive pushes that share a key inside the window", () => {
    let stack = createStack<string>({ limit: 10 });

    stack = push(stack, "a");
    stack = push(stack, "ab", { coalesceKey: "type", at: 1000, coalesceWindowMs: 500 });
    stack = push(stack, "abc", { coalesceKey: "type", at: 1200, coalesceWindowMs: 500 });

    expect(peek(stack)).toBe("abc");
    stack = undo(stack);
    expect(peek(stack)).toBe("a");
  });

  it("breaks the run on a different key", () => {
    let stack = createStack<string>({ limit: 10 });

    stack = push(stack, "a");
    stack = push(stack, "b", { coalesceKey: "type", at: 0, coalesceWindowMs: 500 });
    stack = push(stack, "c", { coalesceKey: "move", at: 100, coalesceWindowMs: 500 });
    stack = undo(stack);

    expect(peek(stack)).toBe("b");
  });

  it("breaks the run once the window has elapsed", () => {
    let stack = createStack<string>({ limit: 10 });

    stack = push(stack, "a");
    stack = push(stack, "b", { coalesceKey: "type", at: 0, coalesceWindowMs: 500 });
    stack = push(stack, "c", { coalesceKey: "type", at: 900, coalesceWindowMs: 500 });
    stack = undo(stack);

    expect(peek(stack)).toBe("b");
  });

  it("coalesces on the key alone when no window is given", () => {
    let stack = createStack<string>({ limit: 10 });

    stack = push(stack, "a");
    stack = push(stack, "b", { coalesceKey: "type" });
    stack = push(stack, "c", { coalesceKey: "type" });

    expect(canUndo(stack)).toBe(true);
    stack = undo(stack);
    expect(peek(stack)).toBe("a");
  });

  it("treats a blank key as no key at all", () => {
    let stack = createStack<string>({ limit: 10 });

    stack = push(stack, "a");
    stack = push(stack, "b", { coalesceKey: "" });
    stack = push(stack, "c", { coalesceKey: "" });
    stack = undo(stack);

    expect(peek(stack)).toBe("b");
  });

  it("keeps a whole merged run as a single undo step", () => {
    let stack = createStack<number>({ limit: 10 });

    stack = push(stack, 0);
    for (let i = 1; i <= 5; i += 1) {
      stack = push(stack, i, { coalesceKey: "t", at: i * 10, coalesceWindowMs: 100 });
    }

    expect(peek(stack)).toBe(5);
    stack = undo(stack);
    expect(peek(stack)).toBe(0);
  });

  it("resets coalescing after an undo", () => {
    let stack = createStack<string>({ limit: 10 });

    stack = push(stack, "a");
    stack = push(stack, "b", { coalesceKey: "type", at: 0, coalesceWindowMs: 1000 });
    stack = undo(stack);
    stack = push(stack, "c", { coalesceKey: "type", at: 100, coalesceWindowMs: 1000 });
    stack = undo(stack);

    expect(peek(stack)).toBe("a");
    expect(canUndo(stack)).toBe(false);
  });
});

describe("limit", () => {
  it("caps retained history, dropping the oldest state", () => {
    let stack = filled(3, 1, 2, 3, 4, 5);

    expect(peek(stack)).toBe(5);
    expect(canUndo(stack)).toBe(true);

    stack = undo(stack);
    expect(peek(stack)).toBe(4);
    stack = undo(stack);
    expect(peek(stack)).toBe(3);
    expect(canUndo(stack)).toBe(false);
  });

  it("keeps only the present when the limit is 1", () => {
    const stack = filled(1, 1, 2);

    expect(peek(stack)).toBe(2);
    expect(canUndo(stack)).toBe(false);
  });
});

describe("clear", () => {
  it("empties the stack but keeps the limit", () => {
    const wiped = clear(filled(7, 1, 2));

    expect(wiped.limit).toBe(7);
    expect(peek(wiped)).toBeUndefined();
    expect(canUndo(wiped)).toBe(false);
    expect(canRedo(wiped)).toBe(false);
  });

  it("returns a fresh stack and leaves the cleared stack intact", () => {
    const stack = filled(7, 1, 2);
    const snapshot = structuredClone(stack);

    const wiped = clear(stack);

    expect(stack).toEqual(snapshot);
    expect(wiped).not.toBe(stack);
    expect(peek(stack)).toBe(2);
  });
});

describe("immutability", () => {
  it("returns fresh arrays so later edits never alias earlier stacks", () => {
    const s1 = push(createStack<number>({ limit: 5 }), 1);
    const s2 = push(s1, 2);
    const s3 = push(s2, 3);

    expect(s1.entries).toEqual([1]);
    expect(s2.entries).toEqual([1, 2]);
    expect(s3.entries).toEqual([1, 2, 3]);
    expect(s2.entries).not.toBe(s1.entries);
    expect(s2.entries).not.toBe(s3.entries);
  });
});
