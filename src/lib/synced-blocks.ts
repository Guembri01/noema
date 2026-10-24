/**
 * Synced block reference engine — the pure brain behind "Synced block" and the
 * "Synced block source marker" (docs/MISSING_FEATURES.md §1).
 *
 * A synced block mirrors one canonical block in many places. The canonical
 * block is the **source** (`sourceBlockId` on `sourcePageId`); every place that
 * displays it holds an **instance**. A `SyncedRef` is the durable description
 * of one source↔instances relationship — its `refId` is deterministic from the
 * source coordinates so two callers that sync the same block agree on identity.
 *
 * Everything here is pure: no DB, no React, no clock. A `SyncedBlockState` is
 * the whole world a caller can see (refs, the latest canonical `content`
 * snapshot per ref, the registered instances, and a source→instances index).
 * Every mutation returns a **new** state and never touches its input.
 *
 * Content is treated as an opaque, generic value and always deep-cloned on the
 * way in and out, so callers may use the minimal tree shape below or any richer
 * object without the engine ever sharing a reference. Instance-local attributes
 * (`attrs`, e.g. `width`) belong to the instance, not the source, and survive
 * propagation untouched.
 *
 * Deterministic ordering: the index keeps registration order; functions that
 * report a set (`propagateEdit`, `brokenRefs`) sort by instance id, and
 * `describeSync` clamps its count, so identical input always yields identical
 * output.
 */

/** Minimal block tree node; any extra fields are carried through verbatim. */
export type SyncBlock = {
  id: string;
  type: string;
  children?: SyncBlock[];
  [key: string]: unknown;
};

/** The durable description of one synced-block relationship. */
export type SyncedRef = {
  refId: string;
  sourceBlockId: string;
  sourcePageId: string;
  createdAt: number;
};

/** One place a source is mirrored. `attrs` are instance-local (e.g. `width`). */
export type SyncInstance = {
  blockId: string;
  pageId: string;
  refId: string;
  attrs: Record<string, unknown>;
};

/** The complete synced-block world a mutation or report reads from. */
export type SyncedBlockState = {
  /** refId → ref. */
  refs: Record<string, SyncedRef>;
  /** refId → the latest canonical content snapshot. */
  content: Record<string, unknown>;
  /** instance blockId → instance. */
  instances: Record<string, SyncInstance>;
  /** sourceBlockId → ordered instance blockIds (the source→instances index). */
  instancesBySource: Record<string, string[]>;
};

/** Optional seed for `createSyncedBlockState`. */
export type SyncStateInput = {
  refs?: readonly SyncedRef[];
  instances?: readonly SyncInstance[];
};

/** One instance's update the caller applies after a source edit. */
export type InstanceUpdate = {
  refId: string;
  instanceId: string;
  pageId: string;
  /** The mirrored content, a fresh deep copy per instance. */
  content: unknown;
  /** The instance's own attributes, preserved across propagation. */
  attrs: Record<string, unknown>;
};

/** The result of `propagateEdit`: the new state plus the per-instance plans. */
export type PropagateResult = {
  state: SyncedBlockState;
  refId: string;
  count: number;
  plans: InstanceUpdate[];
};

/** The result of `detachInstance`: the new state plus the detached content. */
export type DetachResult = {
  state: SyncedBlockState;
  refId: string;
  instanceId: string;
  /** `true` when an instance was actually unlinked. */
  detached: boolean;
  /** A deep copy of the ref's canonical content, or `null` when unknown. */
  snapshot: unknown;
};

/** Rendering data for the "synced from" marker above a mirrored block. */
export type SourceMarker = {
  refId: string;
  sourceBlockId: string;
  sourcePageId: string;
  label: string;
  readOnly: boolean;
  href: string;
};

/** Why an instance is considered broken. */
export type BrokenRefReason = "MISSING_INSTANCE" | "MISSING_SOURCE";

/** One orphaned instance. */
export type BrokenRef = {
  refId: string;
  instanceId: string;
  pageId: string;
  sourceBlockId: string;
  sourcePageId: string;
  reason: BrokenRefReason;
};

/** Non-empty, trimmed id, or `""`. */
function toId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Generic deep clone that keeps every own field, including arrays. */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) clone[key] = cloneValue(item);
    return clone as T;
  }
  return value;
}

/**
 * Describe a source as a synced ref. `refId` defaults deterministically to
 * `sync_<sourcePageId>__<sourceBlockId>` so repeated calls agree, and
 * `createdAt` defaults to `0` (the engine never reads a clock). Throws when a
 * source coordinate is blank.
 */
export function createSyncRef(input: {
  sourceBlockId: string;
  sourcePageId: string;
  refId?: string;
  createdAt?: number;
}): SyncedRef {
  const sourceBlockId = toId(input.sourceBlockId);
  const sourcePageId = toId(input.sourcePageId);
  if (sourceBlockId === "" || sourcePageId === "") {
    throw new Error("A synced block needs a source block id and a source page id.");
  }
  const refId = toId(input.refId) || `sync_${sourcePageId}__${sourceBlockId}`;
  const createdAt =
    typeof input.createdAt === "number" && Number.isFinite(input.createdAt) ? input.createdAt : 0;
  return { refId, sourceBlockId, sourcePageId, createdAt };
}

/**
 * Build an empty (or seeded) state, rebuilding the source→instances index from
 * the instances' refs. Refs register first-seen-wins; an instance whose ref is
 * unknown is kept but not indexed. Attribute maps are deep-cloned.
 */
export function createSyncedBlockState(input: SyncStateInput = {}): SyncedBlockState {
  const refs: Record<string, SyncedRef> = {};
  for (const ref of input.refs ?? []) {
    if (ref && typeof ref.refId === "string" && ref.refId !== "" && !refs[ref.refId]) {
      refs[ref.refId] = { ...ref };
    }
  }

  const instances: Record<string, SyncInstance> = {};
  const instancesBySource: Record<string, string[]> = {};
  for (const instance of input.instances ?? []) {
    if (!instance || typeof instance.blockId !== "string" || instance.blockId === "") continue;
    const stored: SyncInstance = {
      blockId: instance.blockId,
      pageId: instance.pageId,
      refId: instance.refId,
      attrs: cloneValue(instance.attrs ?? {}),
    };
    instances[stored.blockId] = stored;
    const sourceBlockId = refs[stored.refId]?.sourceBlockId;
    if (!sourceBlockId) continue;
    const list = instancesBySource[sourceBlockId] ?? (instancesBySource[sourceBlockId] = []);
    if (!list.includes(stored.blockId)) list.push(stored.blockId);
  }

  return { refs, content: {}, instances, instancesBySource };
}

/**
 * Register (or update) one instance of `ref` and add it to the source index.
 * The ref is registered too when it is new. Re-registering the same instance
 * updates its attrs in place; re-registering it under a different source moves
 * it off the old source's index. Returns a new state; the input is untouched.
 */
export function registerInstance(
  state: SyncedBlockState,
  ref: SyncedRef,
  placement: { pageId: string; blockId: string; attrs?: Record<string, unknown> },
): SyncedBlockState {
  const blockId = toId(placement.blockId);
  if (blockId === "") throw new Error("A synced instance needs a block id.");
  const pageId = toId(placement.pageId);
  const refId = toId(ref.refId);

  const refs = { ...state.refs };
  if (refId !== "" && !refs[refId]) refs[refId] = { ...ref };

  const instances: Record<string, SyncInstance> = { ...state.instances };
  instances[blockId] = { blockId, pageId, refId, attrs: cloneValue(placement.attrs ?? {}) };

  // Rebuild the index without this instance, then re-add it under its source.
  const instancesBySource: Record<string, string[]> = {};
  for (const [source, ids] of Object.entries(state.instancesBySource)) {
    const kept = ids.filter((id) => id !== blockId);
    if (kept.length > 0) instancesBySource[source] = kept;
  }
  const sourceBlockId = refs[refId]?.sourceBlockId ?? ref.sourceBlockId;
  if (sourceBlockId) {
    const list = instancesBySource[sourceBlockId] ?? (instancesBySource[sourceBlockId] = []);
    if (!list.includes(blockId)) list.push(blockId);
  }

  return { ...state, refs, instances, instancesBySource };
}

/**
 * Pull the canonical content for `ref` out of a document, as a deep clone.
 * Returns `null` when the source block is not present (a broken ref).
 */
export function resolveSync(ref: SyncedRef, doc: readonly SyncBlock[]): SyncBlock | null {
  const sourceBlockId = toId(ref.sourceBlockId);
  if (sourceBlockId === "") return null;
  const found = doc.find((block) => block.id === sourceBlockId);
  return found ? cloneValue(found) : null;
}

/**
 * Turn a source edit into one update plan per instance of `ref`: the new
 * content mirrored into each (a fresh deep copy), with that instance's own
 * attrs preserved. Also records the new content as the ref's snapshot on the
 * returned state. An unknown ref yields no plans and the same state object.
 * Plans are sorted by instance id for determinism.
 */
export function propagateEdit(
  state: SyncedBlockState,
  edit: { refId: string; newContent: unknown },
): PropagateResult {
  const refId = toId(edit.refId);
  const ref = state.refs[refId];
  if (!ref) return { state, refId, count: 0, plans: [] };

  const instanceIds = [
    ...new Set(
      (state.instancesBySource[ref.sourceBlockId] ?? []).filter(
        (id) => state.instances[id]?.refId === refId,
      ),
    ),
  ].sort();

  const plans: InstanceUpdate[] = instanceIds.map((instanceId) => {
    const instance = state.instances[instanceId];
    return {
      refId,
      instanceId,
      pageId: instance.pageId,
      content: cloneValue(edit.newContent),
      attrs: cloneValue(instance.attrs),
    };
  });

  const content = { ...state.content, [refId]: cloneValue(edit.newContent) };
  return { state: { ...state, content }, refId, count: plans.length, plans };
}

/**
 * Detach one instance from `ref`: remove the link (the instance and its index
 * entry) and hand back a snapshot of the ref's canonical content so the caller
 * can inline it. The ref and its content snapshot survive, as do the other
 * instances. An unknown instance, or a refId that does not match the instance,
 * is a no-op that returns the same state (`detached: false`, `snapshot: null`).
 */
export function detachInstance(
  state: SyncedBlockState,
  target: { refId: string; instanceId: string },
): DetachResult {
  const refId = toId(target.refId);
  const instanceId = toId(target.instanceId);
  const instance = state.instances[instanceId];
  if (!instance || instance.refId !== refId) {
    return { state, refId, instanceId, detached: false, snapshot: null };
  }

  const snapshot = cloneValue(state.content[refId] ?? null);
  const instances = { ...state.instances };
  delete instances[instanceId];

  const instancesBySource: Record<string, string[]> = {};
  for (const [source, ids] of Object.entries(state.instancesBySource)) {
    const kept = ids.filter((id) => id !== instanceId);
    if (kept.length > 0) instancesBySource[source] = kept;
  }

  return {
    state: { ...state, instances, instancesBySource },
    refId,
    instanceId,
    detached: true,
    snapshot,
  };
}

/** The ref an instance mirrors, or `null` when the instance is unknown. */
export function findSource(state: SyncedBlockState, instanceId: string): SyncedRef | null {
  const instance = state.instances[toId(instanceId)];
  if (!instance) return null;
  return state.refs[instance.refId] ?? null;
}

/** Does `ref` name `sourceBlockId` as its source? Blank ids never match. */
export function isSource(sourceBlockId: string, ref: SyncedRef): boolean {
  const candidate = toId(sourceBlockId);
  return candidate !== "" && candidate === toId(ref.sourceBlockId);
}

/**
 * Rendering data for the "synced from" marker: its label, a deep link to the
 * source block, and whether the mirror is read-only. `readOnly` defaults to
 * `false`; ids are URI-encoded in the href.
 */
export function sourceMarker(ref: SyncedRef, options: { readOnly?: boolean } = {}): SourceMarker {
  return {
    refId: ref.refId,
    sourceBlockId: ref.sourceBlockId,
    sourcePageId: ref.sourcePageId,
    label: `Synced from ${ref.sourcePageId}`,
    readOnly: options.readOnly === true,
    href: `/w/${encodeURIComponent(ref.sourcePageId)}#${encodeURIComponent(ref.sourceBlockId)}`,
  };
}

/**
 * Orphaned instances against the block ids that still exist: an instance whose
 * own block is gone is `MISSING_INSTANCE` (checked first, so a doubly-broken
 * ref is reported as a missing instance), otherwise a missing source block is
 * `MISSING_SOURCE`. Sorted by instance id.
 */
export function brokenRefs(
  state: SyncedBlockState,
  input: { existingBlockIds: Iterable<string> },
): BrokenRef[] {
  const existing = new Set<string>();
  for (const id of input.existingBlockIds) {
    const clean = toId(id);
    if (clean !== "") existing.add(clean);
  }

  const broken: BrokenRef[] = [];
  for (const instanceId of Object.keys(state.instances).sort()) {
    const instance = state.instances[instanceId];
    const ref = state.refs[instance.refId];
    const sourceBlockId = ref?.sourceBlockId ?? "";
    const sourcePageId = ref?.sourcePageId ?? "";
    const reason: BrokenRefReason | null = !existing.has(instance.blockId)
      ? "MISSING_INSTANCE"
      : !existing.has(sourceBlockId)
        ? "MISSING_SOURCE"
        : null;
    if (reason) {
      broken.push({
        refId: instance.refId,
        instanceId,
        pageId: instance.pageId,
        sourceBlockId,
        sourcePageId,
        reason,
      });
    }
  }
  return broken;
}

/**
 * A one-line, human-readable summary of a ref and how widely it is mirrored,
 * e.g. `"Synced from p1#s1 mirrored at 3 instances"`. A non-finite or negative
 * count is normalised to `0`; the singular/plural is chosen accordingly.
 */
export function describeSync(ref: SyncedRef, options: { count: number }): string {
  const raw = options.count;
  const count = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  const base = `Synced from ${ref.sourcePageId}#${ref.sourceBlockId}`;
  if (count === 0) return `${base} with no instances`;
  if (count === 1) return `${base} mirrored at 1 instance`;
  return `${base} mirrored at ${count} instances`;
}
