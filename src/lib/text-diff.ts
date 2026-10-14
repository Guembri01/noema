/**
 * Character-level text diff (F7) — pure, editor-agnostic.
 *
 * This is the *string* sibling of the block-id diff in `version-history.ts`:
 * that one answers "which blocks changed", this one answers "which characters
 * changed" so a surface can render an inline red/green preview of a single
 * block. No Prisma, no React — the unit sandbox is the harness.
 *
 * ALGORITHM (deterministic "Myers-lite"):
 *  1. Strip the shared prefix/suffix (they are always `equal`) — this is both
 *     the common case and what keeps the expensive search small.
 *  2. Run Myers' greedy shortest-edit-script over the remaining middle,
 *     comparing Unicode *code points* so surrogate pairs move atomically.
 *  3. Re-assemble, merging adjacent same-op runs into maximal segments.
 *
 * CODE-UNIT SAFETY: `commonPrefix`/`commonSuffix` retreat one code unit when a
 * boundary would land between the halves of a surrogate pair, so no segment
 * ever contains a lone surrogate (an emoji is one indivisible unit). Working
 * on `Array.from(text)` in the middle preserves the same invariant.
 *
 * COUNTING NOTE: `diffStats` counts Unicode code points, not UTF-16 code
 * units, so an astral character (emoji) is one added/removed char.
 */

export type DiffOp = "equal" | "insert" | "delete";

/** One maximal run of same-op text. `delete` reads from `a`, `insert` from `b`. */
export type DiffSegment = { op: DiffOp; text: string };

/** A diff is an ordered list of segments; concatenating `equal`+`insert` = `b`. */
export type TextDiff = DiffSegment[];

export type DiffStats = {
  /** Code points present only in `b` (inserted). */
  added: number;
  /** Code points present only in `a` (deleted). */
  removed: number;
  /** Code points present in both (matched). */
  unchanged: number;
};

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True when position `p` would cut a surrogate pair in two (`0 < p < len`). */
function splitsSurrogateAt(text: string, position: number): boolean {
  if (position <= 0 || position >= text.length) return false;
  return isHighSurrogate(text.charCodeAt(position - 1)) && isLowSurrogate(text.charCodeAt(position));
}

/**
 * Length in UTF-16 code units of the shared leading run of `a` and `b`,
 * retreated so the boundary never splits a surrogate pair.
 */
export function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  if (splitsSurrogateAt(a, index) || splitsSurrogateAt(b, index)) index -= 1;
  return index;
}

/**
 * Length in UTF-16 code units of the shared trailing run of `a` and `b`,
 * retreated so the boundary never splits a surrogate pair. `reservedPrefix`
 * caps the run so a caller that already consumed a prefix cannot count the
 * same characters twice.
 */
export function commonSuffix(a: string, b: string, reservedPrefix = 0): number {
  const limit = Math.min(a.length, b.length) - Math.max(0, reservedPrefix);
  let count = 0;
  while (
    count < limit &&
    a.charCodeAt(a.length - 1 - count) === b.charCodeAt(b.length - 1 - count)
  ) {
    count += 1;
  }
  if (splitsSurrogateAt(a, a.length - count) || splitsSurrogateAt(b, b.length - count)) {
    count -= 1;
  }
  return count;
}

/** Merge adjacent same-op segments and drop empties — the canonical shape. */
function mergeSegments(segments: readonly DiffSegment[]): DiffSegment[] {
  const merged: DiffSegment[] = [];
  for (const segment of segments) {
    if (segment.text.length === 0) continue;
    const last = merged[merged.length - 1];
    if (last && last.op === segment.op) last.text += segment.text;
    else merged.push({ op: segment.op, text: segment.text });
  }
  return merged;
}

type DiffToken = { op: DiffOp; text: string };

/**
 * Myers' greedy shortest-edit-script over two code-point arrays (the "lite"
 * variant: no linear-space divide-and-conquer, the V snapshots are kept for
 * the backtrack pass). Deterministic tie-break: when both a down (insert) and
 * a right (delete) move are viable, the smaller `x` wins — i.e. insertions are
 * preferred over deletions. Returns already-merged segments.
 */
function myersDiff(a: string, b: string): DiffSegment[] {
  const left = Array.from(a);
  const right = Array.from(b);
  const n = left.length;
  const m = right.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ op: "insert", text: b }];
  if (m === 0) return [{ op: "delete", text: a }];

  const max = n + m;
  const offset = max;
  const v = new Array<number>(2 * max + 1).fill(0);
  const trace: number[][] = [];
  let reachedD = -1;

  outer: for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && left[x] === right[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        reachedD = d;
        break outer;
      }
    }
  }

  const tokens: DiffToken[] = [];
  let x = n;
  let y = m;
  for (let d = reachedD; d > 0; d -= 1) {
    const previous = trace[d];
    const k = x - y;
    let previousK: number;
    if (k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1])) {
      previousK = k + 1;
    } else {
      previousK = k - 1;
    }
    const previousX = previous[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      tokens.push({ op: "equal", text: left[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) tokens.push({ op: "insert", text: right[y - 1] });
    else tokens.push({ op: "delete", text: left[x - 1] });
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    tokens.push({ op: "equal", text: left[x - 1] });
    x -= 1;
    y -= 1;
  }
  tokens.reverse();

  return mergeSegments(tokens);
}

/**
 * Character-level diff of `a` -> `b`. Deterministic; identical input yields a
 * single `equal` segment (or `[]` when both are empty). Segments never split a
 * surrogate pair and adjacent same-op runs are merged.
 */
export function diffText(a: string, b: string): DiffSegment[] {
  if (a === b) return a.length === 0 ? [] : [{ op: "equal", text: a }];

  const prefix = commonPrefix(a, b);
  const suffix = commonSuffix(a, b, prefix);
  const aMiddle = a.slice(prefix, a.length - suffix);
  const bMiddle = b.slice(prefix, b.length - suffix);

  const segments: DiffSegment[] = [];
  if (prefix > 0) segments.push({ op: "equal", text: a.slice(0, prefix) });
  for (const segment of myersDiff(aMiddle, bMiddle)) segments.push(segment);
  if (suffix > 0) segments.push({ op: "equal", text: a.slice(a.length - suffix) });

  return mergeSegments(segments);
}

/**
 * Apply a diff to `a`, returning the reconstructed `b`. `equal`/`delete`
 * segments consume `a` in order; `insert` segments add text. Applying the diff
 * produced by `diffText(a, b)` always yields `b`; neither input is mutated.
 */
export function applyDiff(a: string, diff: readonly DiffSegment[]): string {
  let result = "";
  let cursor = 0;
  for (const segment of diff) {
    if (segment.op === "insert") {
      result += segment.text;
    } else if (segment.op === "equal") {
      result += a.slice(cursor, cursor + segment.text.length);
      cursor += segment.text.length;
    } else {
      cursor += segment.text.length;
    }
  }
  return result;
}

/**
 * Tally a diff in Unicode code points: inserted, removed, and matched chars.
 * An astral character counts once, not twice.
 */
export function diffStats(diff: readonly DiffSegment[]): DiffStats {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const segment of diff) {
    const length = Array.from(segment.text).length;
    if (segment.op === "insert") added += length;
    else if (segment.op === "delete") removed += length;
    else unchanged += length;
  }
  return { added, removed, unchanged };
}

/** True when the diff contains any inserted or removed text. */
export function hasChanges(diff: readonly DiffSegment[]): boolean {
  return diff.some((segment) => segment.op !== "equal" && segment.text.length > 0);
}
