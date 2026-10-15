/**
 * Binary heap — a pure, immutable priority queue over a caller-supplied
 * comparator. No DB, no DOM, no timers.
 *
 * The comparator decides the direction: `(a, b) => a - b` yields a **min-heap**
 * (the smallest item is at the root), `(a, b) => b - a` a **max-heap**. Ties
 * (comparator returns `0`) are left to the comparator; callers who need a
 * canonical order for equal items should add a tiebreak (e.g. an `id` compare)
 * so the result is fully stable.
 *
 * Every operation is a **value transform**: `createHeap`/`heapify` build a heap,
 * and `push`/`pop` return a *new* heap, never mutating the one passed in. The
 * backing array is exposed as `readonly T[]` for inspection/`heapSize` but must
 * be treated as frozen. This makes a heap cheap to snapshot and safe to share
 * across React state updates or replay.
 *
 * Complexity: `heapify` is O(n) (Floyd's build-heap); `push`/`pop` are O(log n);
 * `peek`/`heapSize` O(1); `heapToSorted` O(n log n). Deterministic — no
 * randomness, so identical inputs always produce identical output.
 */

/** Total order over `T`: negative if `a` precedes `b`, `0` if equal, positive otherwise. */
export type Comparator<T> = (a: T, b: T) => number;

/** An immutable binary heap: a copied array kept in heap order under `compare`. */
export type Heap<T> = {
  /** Heap-ordered items; the root (highest priority) is at index `0`. */
  readonly items: readonly T[];
  /** The comparator the heap was built with (drives every later operation). */
  readonly compare: Comparator<T>;
};

/** The result of {@link pop}: the removed root (if any) and the remaining heap. */
export type PopResult<T> = {
  /** The former root, or `undefined` when the heap was empty. */
  value: T | undefined;
  /** The heap without its root; the *same* reference when the heap was empty. */
  heap: Heap<T>;
};

/** An empty heap ordered by `compare`. */
export function createHeap<T>(compare: Comparator<T>): Heap<T> {
  return { items: [], compare };
}

/** The number of items currently in `heap`. */
export function heapSize<T>(heap: Heap<T>): number {
  return heap.items.length;
}

/** The root item (highest priority) without removing it, or `undefined` when empty. */
export function peek<T>(heap: Heap<T>): T | undefined {
  return heap.items[0];
}

/** Restore the heap property by floating `items[index]` toward the root. */
function siftUp<T>(items: T[], index: number, compare: Comparator<T>): void {
  let child = index;
  while (child > 0) {
    const parent = (child - 1) >> 1;
    if (compare(items[child], items[parent]) >= 0) break;
    [items[child], items[parent]] = [items[parent], items[child]];
    child = parent;
  }
}

/** Restore the heap property by sinking `items[index]` toward the leaves. */
function siftDown<T>(items: T[], index: number, compare: Comparator<T>): void {
  const size = items.length;
  let parent = index;
  for (;;) {
    const left = parent * 2 + 1;
    if (left >= size) break;
    const right = left + 1;
    let best = left;
    if (right < size && compare(items[right], items[left]) < 0) best = right;
    if (compare(items[best], items[parent]) >= 0) break;
    [items[best], items[parent]] = [items[parent], items[best]];
    parent = best;
  }
}

/** Remove and return the root; `items` must be non-empty and is mutated in place. */
function popRoot<T>(items: T[], compare: Comparator<T>): T {
  const root = items[0];
  const lastIndex = items.length - 1;
  items[0] = items[lastIndex];
  items.length = lastIndex;
  if (items.length > 0) siftDown(items, 0, compare);
  return root;
}

/**
 * A new heap with `item` added, replacing `heap`. The input heap is untouched.
 */
export function push<T>(heap: Heap<T>, item: T): Heap<T> {
  const items = [...heap.items, item];
  siftUp(items, items.length - 1, heap.compare);
  return { items, compare: heap.compare };
}

/**
 * Remove the root, returning its value and the remaining heap. On an empty heap
 * `value` is `undefined` and the *same* empty heap is returned. Pure: the input
 * heap is never mutated, so the old root stays readable on the original.
 */
export function pop<T>(heap: Heap<T>): PopResult<T> {
  if (heap.items.length === 0) return { value: undefined, heap };
  const items = [...heap.items];
  const value = popRoot(items, heap.compare);
  return { value, heap: { items, compare: heap.compare } };
}

/**
 * Build a heap from `items` in O(n) using Floyd's method: copy the array, then
 * sift down every internal node from the last parent to the root. The input is
 * not mutated, so a caller's array can be reused.
 */
export function heapify<T>(items: readonly T[], compare: Comparator<T>): Heap<T> {
  const heapItems = [...items];
  for (let index = (heapItems.length >> 1) - 1; index >= 0; index -= 1) {
    siftDown(heapItems, index, compare);
  }
  return { items: heapItems, compare };
}

/**
 * Every item in `heap`, ordered by the comparator (ascending for a min-heap,
 * descending for a max-heap) via an O(n log n) drain. The input heap is not
 * mutated, so it stays usable; equal items come out in a deterministic but
 * comparator-undefined order unless the comparator adds a tiebreak.
 */
export function heapToSorted<T>(heap: Heap<T>): T[] {
  const items = [...heap.items];
  const sorted: T[] = [];
  while (items.length > 0) sorted.push(popRoot(items, heap.compare));
  return sorted;
}
