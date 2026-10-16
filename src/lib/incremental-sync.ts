/**
 * Incremental sync engine / op-log (§17 "Incremental syncing",
 * docs/FEATURE_MATRIX.md "Sync only changed blocks") — pure, deterministic,
 * immutable, no Prisma, no clock, no I/O.
 *
 * A collaborator that re-sends a whole document tree on every tick wastes
 * bandwidth; the roadmap's op-log approach needs a diff at its core. This
 * module is that core: {@link buildOps} reconciles two entity arrays **by
 * `id`** into the minimal set of create/update/delete ops, {@link applyOps}
 * folds that log back onto a document, and {@link compactOps} collapses
 * redundant chains a log tends to accumulate.
 *
 * It is the *operation* sibling of `sync-delta.ts` (snapshot buckets),
 * `sync-conflict.ts` (three-way field merge) and `version-history.ts` (block
 * diff): same no-Prisma, unit-sandbox discipline.
 *
 * DESIGN NOTES
 *  - IDENTITY IS `id`: an entity without a stable, non-empty string `id` is
 *    skipped, so one malformed row can never poison a log. Duplicate ids keep
 *    the FIRST occurrence.
 *  - CHANGE = CANONICAL CONTENT: a shared id produces an `update` only when
 *    its canonical JSON differs. Object key order never matters; arrays
 *    compare by content and position, so a reorder is a change.
 *  - MINIMAL & DETERMINISTIC: exactly one op per changed id, assigned `seq`
 *    from `ctx.seqStart` in ASCII-ascending `id` order, so equal input always
 *    yields a byte-identical log. {@link hashDoc} ignores entity order (a
 *    delta has no "moved"), so `apply(prev, build(prev, next))` is
 *    content-exact modulo ordering.
 *  - PURE & IDEMPOTENT: {@link applyOps} applies ops in ascending `seq`, never
 *    mutates its arguments, and re-applying an already-applied log is a no-op.
 *  - TOTAL: malformed input degrades to empty / no-op; nothing here throws.
 *
 * Unit-pinned red-first by `src/lib/incremental-sync.test.ts`.
 */

/** The kind of entity an op targets. */
export type OpEntity = "block" | "row" | "page";

/** What an op does to its entity. */
export type OpKind = "create" | "update" | "delete";

/** A syncable entity: a stable `id` plus arbitrary JSON-shaped content. */
export type DocEntity = {
  readonly id: string;
  readonly [field: string]: unknown;
};

/** A document as accepted by the engine (a malformed side degrades to empty). */
export type DocInput = readonly DocEntity[] | null | undefined;

/** Positional path to an entity inside a document tree (here: `[index]`). */
export type OpPath = readonly (string | number)[];

/**
 * One entry of the op-log: a single change to a single entity. `before`/`after`
 * are present only where meaningful (`create` has no `before`, `delete` has no
 * `after`); `at` is an epoch-ms stamp supplied by the caller's clock.
 */
export type Op = {
  /** Stable op identifier (unique within a log). */
  readonly id: string;
  /** Monotonic sequence number; ops apply in ascending `seq`. */
  readonly seq: number;
  /** Kind of entity the op targets. */
  readonly entity: OpEntity;
  /** The targeted entity's stable id. */
  readonly entityId: string;
  /** The change itself. */
  readonly kind: OpKind;
  /** Where the entity sat (carrying side only). */
  readonly path?: OpPath;
  /** Content before the change (update/delete). */
  readonly before?: unknown;
  /** Content after the change (create/update). */
  readonly after?: unknown;
  /** Epoch-ms stamp of the change. */
  readonly at: number;
  /** Who made the change. */
  readonly actorId: string;
};

/** A log as accepted by the engine (a malformed side degrades to empty). */
export type OpList = readonly Op[] | null | undefined;

/** Everything {@link buildOps} needs beyond the two document snapshots. */
export type BuildContext = {
  /** Entity kind for every op in the log; defaults to `"block"`. */
  readonly entity?: OpEntity;
  /** Author recorded on every op; defaults to `""`. */
  readonly actorId?: string;
  /** Epoch-ms clock recorded on every op; defaults to `0` (caller owns time). */
  readonly at?: number;
  /** First `seq` emitted; defaults to `1`. */
  readonly seqStart?: number;
  /** Overrides the default op-id minting (`entity:entityId:seq`). */
  readonly idFactory?: (op: {
    readonly entity: OpEntity;
    readonly entityId: string;
    readonly seq: number;
  }) => string;
};

/** What structural problem {@link validateOpLog} found. */
export type OpLogIssueKind =
  | "invalid-seq"
  | "duplicate-seq"
  | "duplicate-id"
  | "non-monotonic"
  | "gap";

/** A single structural problem in a log. */
export type OpLogIssue = {
  readonly kind: OpLogIssueKind;
  /** Index of the offending entry in the input array. */
  readonly index: number;
  /** The op's `seq`, when it had a usable one. */
  readonly seq?: number;
  /** The op's `id`, for `duplicate-id`. */
  readonly id?: string;
  /** Missing `seq` values, for `gap`. */
  readonly missing?: readonly number[];
  /** Human-readable summary. */
  readonly message: string;
};

/** The verdict of {@link validateOpLog}. */
export type OpLogValidation = {
  readonly valid: boolean;
  readonly issues: readonly OpLogIssue[];
  /** Number of entries inspected (raw, including malformed ones). */
  readonly count: number;
  /** Highest `seq` seen (the log's cursor), or `0` when empty. */
  readonly cursor: number;
  /** Lowest usable `seq`, or `0` when empty. */
  readonly minSeq: number;
  /** Highest usable `seq`, or `0` when empty. */
  readonly maxSeq: number;
};

/** A plain object (not `null`, not an array, Object/`null` prototype). */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** ASCII-ascending comparator for ids — a total, locale-independent order. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** True for a member of {@link OpEntity}. */
function isEntityKind(value: unknown): value is OpEntity {
  return value === "block" || value === "row" || value === "page";
}

/** True for a member of {@link OpKind}. */
function isOpKind(value: unknown): value is OpKind {
  return value === "create" || value === "update" || value === "delete";
}

/** True for a record carrying a non-empty string `id` (a syncable entity). */
function isEntity(value: unknown): value is DocEntity {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0;
}

/** True for a structurally usable {@link Op}. */
function isOp(value: unknown): value is Op {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.seq === "number" &&
    Number.isFinite(value.seq) &&
    isEntityKind(value.entity) &&
    typeof value.entityId === "string" &&
    value.entityId.length > 0 &&
    isOpKind(value.kind) &&
    typeof value.at === "number" &&
    typeof value.actorId === "string"
  );
}

/**
 * Key-order-independent JSON with `Date` support, so re-serialised equal
 * content compares equal. Cycles are out of scope: docs are JSON-shaped.
 */
function canonicalJson(value: unknown): string {
  if (value instanceof Date) {
    const time = value.getTime();
    return JSON.stringify(Number.isFinite(time) ? value.toISOString() : null);
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([leftKey], [rightKey]) => compareIds(leftKey, rightKey))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(",")}}`;
}

/** FNV-1a (32-bit) over a string, hex-padded — a cheap, stable digest. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Index a document by `id`, skipping malformed entries and keeping the first
 * occurrence of a duplicate. A non-array degrades to an empty map.
 */
function indexEntities(doc: DocInput): Map<string, DocEntity> {
  const index = new Map<string, DocEntity>();
  if (!Array.isArray(doc)) return index;
  for (const entry of doc) {
    if (!isEntity(entry) || index.has(entry.id)) continue;
    index.set(entry.id, entry);
  }
  return index;
}

/** Position of the first entity carrying `id`, or `-1` when absent. */
function positionOf(doc: DocInput, id: string): number {
  if (!Array.isArray(doc)) return -1;
  return doc.findIndex((entry) => isEntity(entry) && entry.id === id);
}

/** `[index]` path for `id` in `doc`, or `undefined` when it cannot be located. */
function pathFor(doc: DocInput, id: string): OpPath | undefined {
  const index = positionOf(doc, id);
  return index >= 0 ? [index] : undefined;
}

/** Ascending `seq` order, breaking ties by `id` for determinism. */
function compareBySeq(left: Op, right: Op): number {
  if (left.seq !== right.seq) return left.seq - right.seq;
  return compareIds(left.id, right.id);
}

/** Default op id: stable across {@link buildOps} and {@link compactOps}. */
function defaultOpId(entity: OpEntity, entityId: string, seq: number): string {
  return `${entity}:${entityId}:${seq}`;
}

/** Assemble a built op, omitting the `before`/`after` slot that has no value. */
function makeBuiltOp(
  entity: OpEntity,
  actorId: string,
  at: number,
  entityId: string,
  kind: OpKind,
  seq: number,
  ctx: BuildContext,
  path: OpPath | undefined,
  before: unknown,
  after: unknown,
): Op {
  const identity = { entity, entityId, seq };
  const op: Op = {
    id: ctx.idFactory ? ctx.idFactory(identity) : defaultOpId(entity, entityId, seq),
    seq,
    entity,
    entityId,
    kind,
    at,
    actorId,
  };
  return {
    ...op,
    ...(path !== undefined ? { path } : {}),
    ...(kind !== "create" ? { before } : {}),
    ...(kind !== "delete" ? { after } : {}),
  };
}

/**
 * Diff two documents by `id` into the minimal `seq`-ordered op-log: one
 * `create` per added id, one `delete` per removed id, and one `update` per
 * shared id whose canonical content differs. Unchanged ids emit nothing.
 * `seq` runs from `ctx.seqStart` (default `1`) in ASCII-ascending `id` order;
 * neither input is mutated and malformed input degrades to empty.
 */
export function buildOps(prev: DocInput, next: DocInput, ctx: BuildContext = {}): Op[] {
  const before = indexEntities(prev);
  const after = indexEntities(next);
  const entity = ctx.entity ?? "block";
  const actorId = ctx.actorId ?? "";
  const at = ctx.at ?? 0;
  const seqStart =
    typeof ctx.seqStart === "number" && Number.isFinite(ctx.seqStart) ? ctx.seqStart : 1;

  const ids = [...new Set([...before.keys(), ...after.keys()])].sort(compareIds);
  const ops: Op[] = [];
  let seq = seqStart;

  for (const id of ids) {
    const previous = before.get(id);
    const current = after.get(id);
    if (previous === undefined && current !== undefined) {
      ops.push(makeBuiltOp(entity, actorId, at, id, "create", seq, ctx, pathFor(next, id), undefined, current));
      seq += 1;
    } else if (previous !== undefined && current === undefined) {
      ops.push(makeBuiltOp(entity, actorId, at, id, "delete", seq, ctx, pathFor(prev, id), previous, undefined));
      seq += 1;
    } else if (
      previous !== undefined &&
      current !== undefined &&
      canonicalJson(previous) !== canonicalJson(current)
    ) {
      ops.push(makeBuiltOp(entity, actorId, at, id, "update", seq, ctx, pathFor(next, id), previous, current));
      seq += 1;
    }
  }

  return ops;
}

/**
 * Fold a log onto a document, returning an `id`-ordered, fresh array. Ops are
 * applied in ascending `seq` (so a create-then-delete cancels); `create` and
 * `update` upsert the carried `after` content, `delete` removes the id. Pure
 * and idempotent: replaying an already-applied log changes nothing, and
 * null/malformed input degrades to an id-ordered copy / no-op.
 */
export function applyOps(doc: DocInput, ops: OpList): DocEntity[] {
  const index = indexEntities(doc);
  const ordered = Array.isArray(ops) ? ops.filter(isOp).slice().sort(compareBySeq) : [];

  for (const op of ordered) {
    if (op.kind === "delete") {
      index.delete(op.entityId);
      continue;
    }
    const payload = isRecord(op.after) ? op.after : {};
    index.set(op.entityId, { ...payload, id: op.entityId });
  }

  return [...index.values()].sort((left, right) => compareIds(left.id, right.id));
}

/** Build a single merged op for a chain, keeping the chain's first `seq`. */
function makeMergedOp(first: Op, last: Op, kind: OpKind, before: unknown, after: unknown): Op {
  const op: Op = {
    id: defaultOpId(first.entity, first.entityId, first.seq),
    seq: first.seq,
    entity: first.entity,
    entityId: first.entityId,
    kind,
    at: last.at,
    actorId: last.actorId,
  };
  return {
    ...op,
    ...(last.path !== undefined ? { path: last.path } : {}),
    ...(kind !== "create" ? { before } : {}),
    ...(kind !== "delete" ? { after } : {}),
  };
}

/**
 * Collapse one entity's ordered ops into its net effect: create+update →
 * create(final), update* → update(first before, last after), create+delete →
 * nothing, update+delete → delete(original before), delete+create →
 * update(before, after). A single op is returned unchanged.
 */
function mergeChain(chain: readonly Op[]): Op | null {
  const first = chain[0];
  if (chain.length === 1) return { ...first };

  const createdAtStart = first.kind === "create";
  const startBefore = createdAtStart ? undefined : first.before;
  let exists = first.kind !== "delete";
  let after = first.kind === "delete" ? undefined : first.after;
  let last = first;

  for (let position = 1; position < chain.length; position += 1) {
    const op = chain[position];
    last = op;
    if (op.kind === "delete") {
      exists = false;
      after = undefined;
    } else {
      exists = true;
      after = op.after;
    }
  }

  if (createdAtStart) {
    return exists ? makeMergedOp(first, last, "create", undefined, after) : null;
  }
  if (exists) return makeMergedOp(first, last, "update", startBefore, after);
  return makeMergedOp(first, last, "delete", startBefore, undefined);
}

/**
 * Collapse redundant op chains so a log stays minimal. Ops are grouped by
 * entity (`entity` + `entityId`) in ascending `seq`, each chain folded to its
 * net effect, and the survivors re-sorted by `seq` — the net effect of the log
 * is preserved (`apply(compact(x)) === apply(x)`). Pure, idempotent, and safe
 * on null/malformed input.
 */
export function compactOps(ops: OpList): Op[] {
  if (!Array.isArray(ops)) return [];
  const ordered = ops.filter(isOp).slice().sort(compareBySeq);

  const chains = new Map<string, Op[]>();
  for (const op of ordered) {
    const key = `${op.entity}\u0000${op.entityId}`;
    const chain = chains.get(key);
    if (chain) chain.push(op);
    else chains.set(key, [op]);
  }

  const compacted: Op[] = [];
  for (const chain of chains.values()) {
    const merged = mergeChain(chain);
    if (merged !== null) compacted.push(merged);
  }
  return compacted.sort(compareBySeq);
}

/**
 * Ops strictly after `cursor` (i.e. `seq > cursor`), ascending. A non-finite
 * or missing cursor reads as "from the start"; pairs with {@link cursorOf} to
 * implement "give me everything I have not seen". Non-mutating and total.
 */
export function opsSince(ops: OpList, cursor?: number | null): Op[] {
  const threshold =
    typeof cursor === "number" && Number.isFinite(cursor) ? cursor : Number.NEGATIVE_INFINITY;
  if (!Array.isArray(ops)) return [];
  return ops
    .filter(isOp)
    .filter((op) => op.seq > threshold)
    .sort(compareBySeq);
}

/**
 * The log's cursor: the highest `seq` present, or `0` for an empty/malformed
 * log. Feed the result to {@link opsSince} to resume an incremental pull.
 */
export function cursorOf(ops: OpList): number {
  if (!Array.isArray(ops)) return 0;
  let cursor = 0;
  for (const op of ops) {
    if (isOp(op) && op.seq > cursor) cursor = op.seq;
  }
  return cursor;
}

/**
 * Cheap, stable digest of a document: malformed entries are skipped,
 * duplicates keep the first, and entities are canonicalised `id`-ascending, so
 * the hash depends only on the set of content (order/key order independent).
 * Two docs with equal hashes are content-equal; different hashes differ.
 */
export function hashDoc(doc: DocInput): string {
  const index = indexEntities(doc);
  const ordered = [...index.values()].sort((left, right) => compareIds(left.id, right.id));
  return fnv1a(ordered.map((entry) => canonicalJson(entry)).join("\n"));
}

/**
 * Audit a log's structure: `invalid-seq` (missing/non-integer), `duplicate-seq`,
 * `duplicate-id`, `non-monotonic` (a `seq` below its predecessor) and `gap`
 * (missing numbers inside the observed range). The log is valid when no issue
 * is found. Total: a non-array degrades to a valid empty log, and malformed
 * entries are reported rather than thrown.
 */
export function validateOpLog(ops: OpList): OpLogValidation {
  if (!Array.isArray(ops)) {
    return { valid: true, issues: [], count: 0, cursor: 0, minSeq: 0, maxSeq: 0 };
  }

  const issues: OpLogIssue[] = [];
  const seenIds = new Set<string>();
  const seenSeqs = new Set<number>();
  const usableSeqs: number[] = [];
  let previousSeq: number | null = null;
  let minSeq = 0;
  let maxSeq = 0;

  ops.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.seq !== "number" || !Number.isInteger(entry.seq)) {
      issues.push({ kind: "invalid-seq", index, message: `Op at index ${index} has no integer seq` });
      return;
    }
    const seq = entry.seq;

    if (seenSeqs.has(seq)) {
      issues.push({ kind: "duplicate-seq", index, seq, message: `Duplicate seq ${seq}` });
    } else {
      seenSeqs.add(seq);
    }
    if (previousSeq !== null && seq < previousSeq) {
      issues.push({ kind: "non-monotonic", index, seq, message: `Seq ${seq} follows ${previousSeq}` });
    }
    previousSeq = seq;

    if (typeof entry.id === "string") {
      if (seenIds.has(entry.id)) {
        issues.push({ kind: "duplicate-id", index, seq, id: entry.id, message: `Duplicate op id ${entry.id}` });
      } else {
        seenIds.add(entry.id);
      }
    }

    usableSeqs.push(seq);
    if (usableSeqs.length === 1 || seq < minSeq) minSeq = seq;
    if (seq > maxSeq) maxSeq = seq;
  });

  const unique = [...new Set(usableSeqs)].sort((left, right) => left - right);
  for (let position = 1; position < unique.length; position += 1) {
    const from = unique[position - 1];
    const to = unique[position];
    if (to - from <= 1) continue;
    const missing: number[] = [];
    for (let seq = from + 1; seq < to; seq += 1) missing.push(seq);
    issues.push({
      kind: "gap",
      index: 0,
      seq: from,
      missing,
      message: `Missing seq ${missing.join(", ")}`,
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    count: ops.length,
    cursor: maxSeq,
    minSeq,
    maxSeq,
  };
}
