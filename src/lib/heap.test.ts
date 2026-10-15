import { describe, expect, it } from "vitest";
import {
  createHeap,
  heapify,
  heapSize,
  heapToSorted,
  peek,
  pop,
  push,
  type Comparator,
} from "./heap";

/**
 * Binary heap — the pure, immutable priority queue behind min/max selection.
 *
 * Red-first: `src/lib/heap.ts` did not exist when this suite was written, so it
 * fails on the missing module until the helper lands. The heap is a value:
 * every operation returns a new heap and never mutates its input, so the whole
 * policy is provable with no timer, no DOM and no database.
 *
 * The min/max direction is *entirely* the comparator's job: `(a, b) => a - b`
 * yields a min-heap, `(a, b) => b - a` a max-heap.
 */

const asc: Comparator<number> = (a, b) => a - b;
const desc: Comparator<number> = (a, b) => b - a;

type Task = { id: string; priority: number };
const byPriority: Comparator<Task> = (a, b) => a.priority - b.priority;

describe("createHeap / heapSize / peek", () => {
  it("starts empty", () => {
    const heap = createHeap(asc);
    expect(heapSize(heap)).toBe(0);
    expect(heap.items).toEqual([]);
  });

  it("peeks undefined on an empty heap", () => {
    expect(peek(createHeap(asc))).toBeUndefined();
  });

  it("peeks the root without removing it", () => {
    const heap = heapify([5, 1, 3], asc);
    expect(peek(heap)).toBe(1);
    expect(heapSize(heap)).toBe(3);
  });
});

describe("push", () => {
  it("returns a new heap and leaves the original untouched (immutable)", () => {
    const empty = createHeap(asc);
    const one = push(empty, 4);
    expect(empty).not.toBe(one);
    expect(heapSize(empty)).toBe(0);
    expect(empty.items).toEqual([]);
    expect(heapSize(one)).toBe(1);
  });

  it("keeps the minimum at the root for an ascending comparator", () => {
    let heap = createHeap(asc);
    for (const value of [5, 2, 8, 1, 9, 3]) heap = push(heap, value);
    expect(peek(heap)).toBe(1);
    expect(heapSize(heap)).toBe(6);
  });

  it("keeps the maximum at the root for a descending comparator", () => {
    let heap = createHeap(desc);
    for (const value of [5, 2, 8, 1, 9, 3]) heap = push(heap, value);
    expect(peek(heap)).toBe(9);
  });
});

describe("heapify", () => {
  it("does not mutate the source array", () => {
    const input = [4, 1, 3, 2];
    const snapshot = [...input];
    heapify(input, asc);
    expect(input).toEqual(snapshot);
  });

  it("builds a valid heap from unordered input", () => {
    const heap = heapify([9, 4, 7, 1, 8, 2], asc);
    expect(peek(heap)).toBe(1);
    expect(heapSize(heap)).toBe(6);
    expect(heapToSorted(heap)).toEqual([1, 2, 4, 7, 8, 9]);
  });

  it("handles an empty list and a single item", () => {
    expect(heapSize(heapify([], asc))).toBe(0);
    expect(peek(heapify([42], asc))).toBe(42);
  });
});

describe("pop", () => {
  it("returns the root and a smaller heap, leaving the original intact", () => {
    const heap = heapify([5, 1, 3], asc);
    const first = pop(heap);
    expect(first.value).toBe(1);
    expect(heapSize(first.heap)).toBe(2);
    expect(peek(first.heap)).toBe(3);
    expect(peek(heap)).toBe(1);
    expect(heapSize(heap)).toBe(3);
  });

  it("drains a min-heap in ascending order", () => {
    let heap = heapify([7, 1, 9, 3, 5, 2, 8], asc);
    const drained: number[] = [];
    while (heapSize(heap) > 0) {
      const step = pop(heap);
      expect(step.value).toBeDefined();
      drained.push(step.value as number);
      heap = step.heap;
    }
    expect(drained).toEqual([1, 2, 3, 5, 7, 8, 9]);
  });

  it("drains a max-heap in descending order", () => {
    let heap = heapify([7, 1, 9, 3, 5, 2, 8], desc);
    const drained: number[] = [];
    while (heapSize(heap) > 0) {
      const step = pop(heap);
      drained.push(step.value as number);
      heap = step.heap;
    }
    expect(drained).toEqual([9, 8, 7, 5, 3, 2, 1]);
  });

  it("is a no-op on an empty heap", () => {
    const empty = createHeap(asc);
    const result = pop(empty);
    expect(result.value).toBeUndefined();
    expect(result.heap).toBe(empty);
  });
});

describe("heapToSorted", () => {
  it("returns all items in comparator order without mutating the heap", () => {
    const heap = heapify([3, 1, 2], asc);
    expect(heapToSorted(heap)).toEqual([1, 2, 3]);
    expect(heapToSorted(heap)).toEqual([1, 2, 3]);
    expect(heapSize(heap)).toBe(3);
  });

  it("returns an empty array for an empty heap", () => {
    expect(heapToSorted(createHeap(asc))).toEqual([]);
  });
});

describe("custom comparators", () => {
  it("orders objects by a field", () => {
    const tasks: Task[] = [
      { id: "c", priority: 3 },
      { id: "a", priority: 1 },
      { id: "b", priority: 2 },
    ];
    const heap = heapify(tasks, byPriority);
    expect(peek(heap)?.id).toBe("a");
    expect(heapToSorted(heap).map((task) => task.id)).toEqual(["a", "b", "c"]);
  });

  it("supports a composite comparator with an id tiebreak", () => {
    const stable: Comparator<Task> = (a, b) =>
      a.priority - b.priority || a.id.localeCompare(b.id);
    const heap = heapify(
      [
        { id: "b", priority: 1 },
        { id: "a", priority: 1 },
        { id: "c", priority: 0 },
      ],
      stable,
    );
    expect(heapToSorted(heap).map((task) => task.id)).toEqual(["c", "a", "b"]);
  });

  it("is deterministic across identical runs", () => {
    const build = (): number[] => {
      let heap = createHeap(asc);
      for (const value of [5, 3, 9, 1, 3, 7, 3]) heap = push(heap, value);
      return heapToSorted(heap);
    };
    expect(build()).toEqual(build());
  });
});
