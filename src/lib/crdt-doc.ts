/**
 * CRDT data model — the pure, deterministic core of local-first multiplayer
 * block editing (docs/specs/realtime-collab.md §10; matrix rows 352-353).
 *
 * A collaborative document is modelled as a **map of blocks** plus a
 * **version vector**. Edits travel as {@link BlockOp}s: each op is tagged with
 * the authoring `clientId` and a per-client logical `clock`. Two ops that touch
 * the same block are ordered by `(clock, clientId)` — a last-writer-wins
 * register — with a final deterministic tiebreak on the op `id`, so every
 * replica that sees the same set of ops converges on the same block value no
 * matter the arrival order, duplicates, or concurrency.
 *
 * Deletes are kept as **tombstones** (a `deleted` block that retains the
 * winning op's `(clock, clientId, opId)`). A tombstone blocks a stale,
 * lower-clock set from resurrecting the block; a strictly higher clock may.
 *
 * Nothing here touches the network, React, the DB or a clock source: callers
 * own the logical clocks and the transport. Every function is **immutable** —
 * arguments are never mutated and fresh objects are returned — and
 * {@link serializeDoc} is **canonical**, so equal documents serialise to
 * byte-identical JSON regardless of insertion order.
 *
 * This is deliberately a *model*, not a Yjs/Automerge binding: it implements
 * the merge semantics with built-in APIs only and no dependencies, so the
 * convergence rules are unit-testable in isolation.
 */

/** A component-wise version vector: `clientId → highest logical clock seen`. */
export type VersionVector = Readonly<Record<string, number>>;

/** The partial order of two version vectors. */
export type VectorOrder = "equal" | "less" | "greater" | "concurrent";

/** A block op is either a value write or a delete (tombstone). */
export type BlockOpKind = "set" | "delete";

/** One block-level operation, stamped with its author and logical clock. */
export type BlockOp = {
  /** Stable op id; also the final deterministic tiebreak. */
  id: string;
  /** The block this op targets. */
  blockId: string;
  /** The client that authored the op. */
  clientId: string;
  /** Author-assigned logical clock (per client, monotonic). */
  clock: number;
  /** `set` writes `value`; `delete` tombstones the block. */
  kind: BlockOpKind;
  /** Block content for `kind === "set"`; ignored for `delete`. */
  value?: unknown;
};

/** The winning state of one block after merge. */
export type BlockState = {
  /** Block id. */
  id: string;
  /** `true` once the winning op was a delete (tombstone). */
  deleted: boolean;
  /** Block content; present only while `deleted` is `false`. */
  value?: unknown;
  /** Winning op's logical clock. */
  clock: number;
  /** Winning op's authoring client. */
  clientId: string;
  /** Winning op's id (the final tiebreak). */
  opId: string;
};

/** The replicated document: blocks by id plus the aggregated version vector. */
export type CrdtDoc = {
  blocks: Readonly<Record<string, BlockState>>;
  vector: VersionVector;
};

/** The three fields that totally order competing writes to one block. */
type ClockKey = { clock: number; clientId: string; opId: string };

/** A plain (non-array) object, for defensive shape checks. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a clock into a non-negative integer, or `null` when unusable. */
function normalizeClock(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

/** Normalize an arbitrary version vector, dropping non-positive/junk entries. */
function normalizeVector(raw: unknown): VersionVector {
  const out: Record<string, number> = {};
  if (!isRecord(raw)) return out;
  for (const [clientId, value] of Object.entries(raw)) {
    if (clientId.length === 0) continue;
    const clock = normalizeClock(value);
    if (clock !== null && clock > 0) out[clientId] = clock;
  }
  return out;
}

/**
 * Defensively rebuild a block state from untrusted input (a decoded snapshot
 * or an arbitrary doc-like value). A block without a usable id, client or
 * clock is dropped (`null`) rather than trusted.
 */
function normalizeBlockState(key: string, raw: unknown): BlockState | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : key;
  if (id.length === 0) return null;
  const clientId = typeof raw.clientId === "string" ? raw.clientId : "";
  if (clientId.length === 0) return null;
  const clock = normalizeClock(raw.clock);
  if (clock === null) return null;
  const deleted = raw.deleted === true;
  const state: BlockState = {
    id,
    deleted,
    clock,
    clientId,
    opId: typeof raw.opId === "string" && raw.opId.length > 0 ? raw.opId : id,
  };
  if (!deleted) state.value = raw.value ?? null;
  return state;
}

/** Defensively rebuild a whole document from untrusted input. */
function normalizeDoc(doc: CrdtDoc): CrdtDoc {
  if (!isRecord(doc)) return { blocks: {}, vector: {} };
  const blocks: Record<string, BlockState> = {};
  if (isRecord(doc.blocks)) {
    for (const [key, raw] of Object.entries(doc.blocks)) {
      const state = normalizeBlockState(key, raw);
      if (state !== null) blocks[state.id] = state;
    }
  }
  return { blocks, vector: normalizeVector(doc.vector) };
}

/** An empty document. */
export function createDoc(): CrdtDoc {
  return { blocks: {}, vector: {} };
}

/**
 * Total order on competing writes to a block: logical clock first, then
 * `clientId`, then op id — all ascending. The **greater** op wins, so a higher
 * clock beats a lower one, an equal clock is decided deterministically by
 * author, and a full tie by op id. Never returns a non-finite value.
 */
function compareClock(a: ClockKey, b: ClockKey): number {
  if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1;
  if (a.clientId !== b.clientId) return a.clientId < b.clientId ? -1 : 1;
  if (a.opId === b.opId) return 0;
  return a.opId < b.opId ? -1 : 1;
}

/**
 * Deterministic ordering of two block ops by `(clock, clientId, id)` ascending.
 * Negative means `a` loses to `b`, positive means `a` wins, zero means the two
 * ops are identical in the fields that matter to convergence.
 */
export function compareOps(a: BlockOp, b: BlockOp): number {
  return compareClock(
    { clock: a.clock, clientId: a.clientId, opId: a.id },
    { clock: b.clock, clientId: b.clientId, opId: b.id },
  );
}

/** Component-wise maximum of two version vectors (union of positive entries). */
export function mergeVectors(a: VersionVector, b: VersionVector): VersionVector {
  const out: Record<string, number> = { ...normalizeVector(a) };
  for (const [clientId, clock] of Object.entries(normalizeVector(b))) {
    if (clock > (out[clientId] ?? 0)) out[clientId] = clock;
  }
  return out;
}

/**
 * Partial order of two version vectors, treating a missing component as `0`:
 *
 * - `"equal"` — every component matches;
 * - `"less"` / `"greater"` — one vector dominates the other;
 * - `"concurrent"` — each holds a component the other does not, so neither is
 *   causally ahead of the other.
 */
export function compareVectors(a: VersionVector, b: VersionVector): VectorOrder {
  const left = normalizeVector(a);
  const right = normalizeVector(b);
  let leftAhead = false;
  let rightAhead = false;
  const clientIds = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const clientId of clientIds) {
    const aClock = left[clientId] ?? 0;
    const bClock = right[clientId] ?? 0;
    if (aClock > bClock) leftAhead = true;
    else if (bClock > aClock) rightAhead = true;
  }
  if (leftAhead && rightAhead) return "concurrent";
  if (leftAhead) return "greater";
  if (rightAhead) return "less";
  return "equal";
}

/**
 * Normalize one op, returning `null` for input that cannot be ordered (a blank
 * id / block / client or an unusable clock). A `set` op's missing value becomes
 * `null` so snapshots always round-trip.
 */
function normalizeOp(raw: BlockOp): BlockOp | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const blockId = typeof raw.blockId === "string" ? raw.blockId : "";
  const clientId = typeof raw.clientId === "string" ? raw.clientId : "";
  if (id.length === 0 || blockId.length === 0 || clientId.length === 0) return null;
  const clock = normalizeClock(raw.clock);
  if (clock === null) return null;
  const op: BlockOp = {
    id,
    blockId,
    clientId,
    clock,
    kind: raw.kind === "delete" ? "delete" : "set",
  };
  if (op.kind === "set") op.value = raw.value ?? null;
  return op;
}

/** Project a normalized op onto the merged block state it would install. */
function toBlockState(op: BlockOp): BlockState {
  const state: BlockState = {
    id: op.blockId,
    deleted: op.kind === "delete",
    clock: op.clock,
    clientId: op.clientId,
    opId: op.id,
  };
  if (op.kind === "set") state.value = op.value ?? null;
  return state;
}

/**
 * Apply a batch of ops to a document, returning a fresh document.
 *
 * For each block only the op with the greatest `(clock, clientId, id)` survives
 * (last-writer-wins), and the version vector advances to the highest clock seen
 * per client — **including losing ops**, since observing an op is itself a
 * causal fact. Because each block's winner is a maximum of a total order and
 * the vector is a component-wise maximum, the result is independent of op
 * order and duplicates: the batch is **commutative and idempotent**.
 *
 * Malformed ops (blank id/block/client, non-finite clock) are skipped, so a
 * corrupt frame can never throw or poison the document. The input doc, its
 * blocks and the op array are never mutated.
 */
export function applyOps(doc: CrdtDoc, ops: readonly BlockOp[]): CrdtDoc {
  const base = normalizeDoc(doc);
  const blocks: Record<string, BlockState> = { ...base.blocks };
  const vector: Record<string, number> = { ...base.vector };

  const list = Array.isArray(ops) ? ops : [];
  for (const raw of list) {
    const op = normalizeOp(raw);
    if (op === null) continue;
    if (op.clock > (vector[op.clientId] ?? 0)) vector[op.clientId] = op.clock;
    const existing = blocks[op.blockId];
    const winner: ClockKey = { clock: op.clock, clientId: op.clientId, opId: op.id };
    if (existing === undefined || compareClock(winner, existing) > 0) {
      blocks[op.blockId] = toBlockState(op);
    }
  }
  return { blocks, vector };
}

/**
 * Merge two documents (state-based join): pick the winning block state per
 * block with the same `(clock, clientId, opId)` order {@link applyOps} uses,
 * and join the version vectors. Commutative, associative and idempotent, so
 * any replica that folds the same writes converges on the same document.
 */
export function mergeDocs(a: CrdtDoc, b: CrdtDoc): CrdtDoc {
  const left = normalizeDoc(a);
  const right = normalizeDoc(b);
  const blocks: Record<string, BlockState> = { ...left.blocks };
  for (const [id, block] of Object.entries(right.blocks)) {
    const existing = blocks[id];
    if (existing === undefined || compareClock(block, existing) > 0) blocks[id] = block;
  }
  return { blocks, vector: mergeVectors(left.vector, right.vector) };
}

/**
 * The live (non-tombstone) blocks, sorted by id ascending. Deterministic, so a
 * renderer sees a stable order; a fresh array of shallow-copied states.
 */
export function liveBlocks(doc: CrdtDoc): BlockState[] {
  const { blocks } = normalizeDoc(doc);
  return Object.values(blocks)
    .filter((block) => !block.deleted)
    .map((block) => ({ ...block }))
    .sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
}

/** True when the block is known and tombstoned. */
export function isTombstone(doc: CrdtDoc, blockId: string): boolean {
  return doc.blocks[blockId]?.deleted === true;
}

/**
 * Canonical JSON: object keys sorted at every level, `undefined` properties
 * omitted, arrays kept in order. Equal values always stringify identically.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Serialize a document to canonical JSON. The result is deterministic: two
 * documents with the same blocks and vector produce byte-identical text,
 * whatever order they were built in, so it is safe to hash, compare or store.
 */
export function serializeDoc(doc: CrdtDoc): string {
  const { blocks, vector } = normalizeDoc(doc);
  return stableStringify({ blocks, vector });
}

/**
 * Parse a document from {@link serializeDoc} output (or any JSON of the same
 * shape). Defensive: malformed JSON, a non-object payload or individual
 * corrupt block entries degrade to an empty document / dropped blocks rather
 * than throwing, so a bad snapshot can never crash a sync.
 */
export function deserializeDoc(text: string | null | undefined): CrdtDoc {
  if (typeof text !== "string" || text.trim().length === 0) return createDoc();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return createDoc();
  }
  if (!isRecord(parsed)) return createDoc();
  const blocks: Record<string, BlockState> = {};
  if (isRecord(parsed.blocks)) {
    for (const [key, raw] of Object.entries(parsed.blocks)) {
      const state = normalizeBlockState(key, raw);
      if (state !== null) blocks[state.id] = state;
    }
  }
  return { blocks, vector: normalizeVector(parsed.vector) };
}
