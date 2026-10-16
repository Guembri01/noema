/**
 * Page snapshot + backup/restore engine (§17 "Page snapshots" / "Restore from
 * backup").
 *
 * This is the pure, framework-free core a snapshot/restore path needs, kept in
 * one place so the editor, the history surface and a future backup job can all
 * share it without touching Prisma, the DOM or the clock:
 *
 * - {@link contentHashOf} — a stable, dependency-free hash of any JSON payload
 *   (canonicalised: object keys sorted, `Date` → ISO string, `undefined` fields
 *   dropped), built on the repo's FNV-1a `checksum`;
 * - {@link createSnapshot} — freeze a page's content (title + blocks) into an
 *   immutable `{ id, pageId, takenAt, contentHash, blocks, meta }` record with
 *   an injectable `now`/`actorId`/`label`;
 * - {@link dedupeSnapshots} — collapse each *consecutive* run of equal hashes to
 *   its newest record, so a no-op autosave burst stores one row, not fifty;
 * - {@link snapshotDiff} — block-level added/removed/changed/moved summary;
 * - {@link restoreFromSnapshot} — the patch that writes a snapshot back,
 *   reusing the current block ids wherever the content did not change;
 * - {@link buildBackup} / {@link validateBackup} / {@link planRestore} — a
 *   workspace bundle, its integrity checker (schema, version, refs) and the
 *   create/update/remove plan to apply it.
 *
 * Determinism is the rule: every function is pure, none mutates its arguments,
 * malformed input degrades instead of throwing, and time is always injected.
 */

import { checksum } from "./backup-manifest";
import { diffVersions, type VersionBlock } from "./version-history";

/** Current backup-bundle format version. */
export const BACKUP_VERSION = 1;

/** Every backup version this build understands. */
export const SUPPORTED_BACKUP_VERSIONS: readonly number[] = [BACKUP_VERSION];

/** R30.10-style cap on a snapshot label. */
export const MAX_SNAPSHOT_LABEL_LENGTH = 100;

/** A block inside a page document; `id` is its stable identity. */
export type PageSnapshotBlock = {
  id: string;
  [key: string]: unknown;
};

/** The page a snapshot is taken from (extra fields are ignored). */
export type SnapshotPage = {
  id: string;
  /** `null`/absent = top level; otherwise the parent page id. */
  parentId?: string | null;
  title?: string;
  blocks?: readonly PageSnapshotBlock[];
  [key: string]: unknown;
};

/** Provenance carried on every snapshot. */
export type SnapshotMeta = {
  /** Who took the snapshot. */
  actorId: string;
  /** Trimmed, non-blank label; `null` for an ordinary auto snapshot. */
  label: string | null;
  /** Page title at capture time, or `null` when the page had none. */
  title: string | null;
} & Record<string, unknown>;

/** An immutable capture of a page's content. */
export type PageSnapshot = {
  id: string;
  pageId: string;
  /** ISO-8601 instant the snapshot was taken. */
  takenAt: string;
  /** {@link contentHashOf} of `{ title, blocks }`. */
  contentHash: string;
  blocks: PageSnapshotBlock[];
  meta: SnapshotMeta;
};

export type CreateSnapshotOptions = {
  /** Who is taking the snapshot. */
  actorId: string;
  /** Capture instant; defaults to the current time. */
  now?: Date | number | string;
  /** Optional name; trimmed, blank becomes `null`, over-long throws. */
  label?: string | null;
  /** Extra metadata copied onto `meta` (cannot override `actorId`/`label`/`title`). */
  meta?: Readonly<Record<string, unknown>>;
  /** Id allocator; defaults to a fresh random id. */
  idFactory?: () => string;
};

/** One bucket of a block-level diff. */
export type SnapshotDiff = {
  /** ids present only in `b` (inserted) — in `b` order. */
  added: string[];
  /** ids present only in `a` (deleted) — in `a` order. */
  removed: string[];
  /** ids in both whose content differs — in `b` order. */
  changed: string[];
  /** ids in both whose relative order changed — in `b` order. */
  moved: string[];
  /** The four buckets as counts, for a summary chip. */
  counts: { added: number; removed: number; changed: number; moved: number };
};

/** A snapshot or a bare block list can be diffed. */
export type SnapshotSource = PageSnapshot | readonly PageSnapshotBlock[];

export type RestoreOptions = {
  /** Restore instant; defaults to the current time. */
  now?: Date | number | string;
  /** The document as it stands now, so unchanged ids can be preserved. */
  current?: readonly PageSnapshotBlock[] | null;
};

/** The patch that writes a snapshot back onto a page. */
export type RestorePatch = {
  pageId: string;
  snapshotId: string;
  restoredAt: string;
  /** Title carried by the snapshot, if any. */
  title: string | null;
  /** Target blocks: snapshot order, with current ids reused where unchanged. */
  blocks: PageSnapshotBlock[];
  /** Result ids absent from the current document (to create). */
  added: string[];
  /** Current ids absent from the result (to delete). */
  removed: string[];
  /** Ids present in both but whose content differs (to overwrite). */
  changed: string[];
  /** Snapshot block id → reused current id, for unchanged content. */
  preserved: Map<string, string>;
};

/** The workspace a backup is built from. */
export type BackupWorkspace = {
  id: string;
  name?: string;
  pages?: readonly SnapshotPage[];
};

/** A page as recorded in a backup bundle. */
export type BackupPage = {
  id: string;
  parentId: string | null;
  title: string;
  blocks: PageSnapshotBlock[];
  contentHash: string;
};

/** Aggregate totals for a bundle. */
export type BackupCounts = {
  pages: number;
  blocks: number;
  /** Pages with no parent. */
  roots: number;
};

/** A self-describing workspace backup. */
export type BackupBundle = {
  version: number;
  createdAt: string;
  workspaceId: string;
  workspaceName: string | null;
  pages: BackupPage[];
  counts: BackupCounts;
};

export type BuildBackupOptions = {
  /** Bundle instant; defaults to the current time. */
  now?: Date | number | string;
  /** Format version to stamp; defaults to {@link BACKUP_VERSION}. */
  version?: number;
};

export type BackupIssueCode =
  | "not-an-object"
  | "unsupported-version"
  | "invalid-created-at"
  | "invalid-pages"
  | "invalid-page"
  | "invalid-page-id"
  | "duplicate-page-id"
  | "invalid-title"
  | "invalid-blocks"
  | "invalid-block-id"
  | "duplicate-block-id"
  | "invalid-content-hash"
  | "content-hash-mismatch"
  | "invalid-parent"
  | "self-parent"
  | "dangling-parent"
  | "parent-cycle"
  | "missing-counts"
  | "count-mismatch";

/** One integrity problem found by {@link validateBackup}. */
export type BackupIssue = {
  code: BackupIssueCode;
  message: string;
  /** The page the issue concerns, when applicable. */
  pageId?: string;
};

export type BackupValidation = {
  ok: boolean;
  issues: BackupIssue[];
};

/** A page as it currently exists in the restore target. */
export type BackupTargetPage = {
  id: string;
  parentId?: string | null;
  blocks?: readonly PageSnapshotBlock[];
};

/** The destination a backup is restored into. */
export type RestoreTarget = {
  workspaceId?: string;
  pages?: readonly BackupTargetPage[];
};

/** One page's slot in a restore plan. */
export type RestorePlanEntry = {
  pageId: string;
  action: "create" | "update";
  diff: SnapshotDiff;
};

/** What applying a bundle to a target would do. */
export type RestorePlan = {
  workspaceId: string;
  /** Bundle pages missing from the target. */
  create: string[];
  /** Bundle pages that already exist. */
  update: string[];
  /** Target pages absent from the bundle. */
  remove: string[];
  /** Per-page create/update entries, in bundle order. */
  entries: RestorePlanEntry[];
  /** Totals across every entry. */
  blocks: { added: number; removed: number; changed: number; moved: number };
  counts: { create: number; update: number; remove: number };
};

let defaultCounter = 0;

/** Fresh, collision-resistant snapshot id; deterministic callers pass their own. */
export function defaultSnapshotIdFactory(): string {
  defaultCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `snap_${defaultCounter.toString(36)}_${random}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Key-order-independent JSON with `Date` support, `undefined` fields dropped. */
function canonicalJson(value: unknown): string {
  if (value instanceof Date) {
    const time = value.getTime();
    return JSON.stringify(Number.isFinite(time) ? value.toISOString() : null);
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([leftKey], [rightKey]) => compareText(leftKey, rightKey))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Deterministic hash of any JSON-shaped payload. Object key order never
 * matters, `Date` is normalised to its ISO string, `undefined` fields are
 * dropped and non-finite numbers collapse to `null`, so the same logical
 * content always yields the same 8-character hex string on every platform.
 */
export function contentHashOf(payload: unknown): string {
  return checksum(canonicalJson(payload));
}

function isBlock(value: unknown): value is PageSnapshotBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return isNonEmptyString((value as { id?: unknown }).id);
}

/** Generic deep clone that preserves arrays, plain objects and `Date`s. */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    if (value instanceof Date) return value;
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) clone[key] = deepClone(item);
    return clone as T;
  }
  return value;
}

/** Deep-clone a block list, dropping entries that lack a stable id. */
function cloneBlocks(blocks: unknown): PageSnapshotBlock[] {
  if (!Array.isArray(blocks)) return [];
  const out: PageSnapshotBlock[] = [];
  for (const block of blocks) {
    if (!isBlock(block)) continue;
    out.push(deepClone(block));
  }
  return out;
}

/** Normalise a snapshot label: trim, blank → `null`, over-long → `RangeError`. */
function normalizeLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const trimmed = label.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_SNAPSHOT_LABEL_LENGTH) {
    throw new RangeError(`Snapshot label must be at most ${MAX_SNAPSHOT_LABEL_LENGTH} characters`);
  }
  return trimmed;
}

/** Resolve an injectable `now` to an ISO-8601 string. */
function toIso(now?: Date | number | string): string {
  if (now === undefined) return new Date().toISOString();
  const date = now instanceof Date ? now : new Date(now);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/** Epoch millis for a `takenAt` value; unparseable sorts oldest. */
function instantOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  }
  return Number.NEGATIVE_INFINITY;
}

/** Content-only hash of a block — its id is deliberately excluded. */
function blockContentHash(block: PageSnapshotBlock): string {
  const { id: _id, ...content } = block;
  return contentHashOf(content);
}

/**
 * Capture a page's content. The snapshot owns a deep copy of the blocks, so
 * later edits to the page cannot mutate it (and vice versa). A missing or
 * malformed page degrades to an empty document rather than throwing.
 */
export function createSnapshot(
  page: SnapshotPage | null | undefined,
  options: CreateSnapshotOptions,
): PageSnapshot {
  const pageId = isNonEmptyString(page?.id) ? page.id : "";
  const title = typeof page?.title === "string" ? page.title : null;
  const blocks = cloneBlocks(page?.blocks);
  const label = normalizeLabel(options.label);
  const takenAt = toIso(options.now);
  const id = options.idFactory ? options.idFactory() : defaultSnapshotIdFactory();

  const meta: SnapshotMeta = {
    ...(options.meta ?? {}),
    actorId: options.actorId,
    label,
    title,
  };

  return {
    id,
    pageId,
    takenAt,
    contentHash: contentHashOf({ title, blocks }),
    blocks,
    meta,
  };
}

/**
 * Collapse each *consecutive* run of equal `contentHash` to a single record,
 * keeping the newest of the run by `takenAt` (ties keep the later entry). Input
 * order is otherwise preserved; identical hashes that are not adjacent are all
 * kept. Neither the array nor its records are mutated.
 */
export function dedupeSnapshots(
  snaps: readonly PageSnapshot[] | null | undefined,
): PageSnapshot[] {
  if (!Array.isArray(snaps)) return [];
  const out: PageSnapshot[] = [];
  for (const snap of snaps) {
    if (typeof snap !== "object" || snap === null) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.contentHash === snap.contentHash) {
      if (instantOf(snap.takenAt) >= instantOf(last.takenAt)) out[out.length - 1] = snap;
      continue;
    }
    out.push(snap);
  }
  return out;
}

/** Extract the ordered block list from a snapshot or a bare block array. */
function blocksOf(source: SnapshotSource | null | undefined): PageSnapshotBlock[] {
  if (Array.isArray(source)) return (source as readonly PageSnapshotBlock[]).filter(isBlock);
  if (source !== null && source !== undefined && typeof source === "object") {
    const blocks = (source as PageSnapshot).blocks;
    if (Array.isArray(blocks)) return (blocks as readonly PageSnapshotBlock[]).filter(isBlock);
  }
  return [];
}

/**
 * Block-level diff of two snapshots (or bare block arrays): added/removed by
 * id, changed by canonical content and moved by an LCS reorder pass. Delegates
 * to `diffVersions` for the identity/ordering rules and adds the bucket counts.
 */
export function snapshotDiff(
  a: SnapshotSource | null | undefined,
  b: SnapshotSource | null | undefined,
): SnapshotDiff {
  const diff = diffVersions(blocksOf(a) as readonly VersionBlock[], blocksOf(b) as readonly VersionBlock[]);
  return {
    added: [...diff.added],
    removed: [...diff.removed],
    changed: [...diff.changed],
    moved: [...diff.moved],
    counts: {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
      moved: diff.moved.length,
    },
  };
}

/**
 * Build the patch that writes `snap` back. Blocks whose content already exists
 * in `current` reuse that current id (so a collab session sees no needless
 * delete/re-insert churn); every other block restores the snapshot's own id.
 * `preserved` records the snapshot id → current id remaps.
 */
export function restoreFromSnapshot(
  snap: PageSnapshot | null | undefined,
  options: RestoreOptions = {},
): RestorePatch {
  const snapshotBlocks = cloneBlocks(snap?.blocks);
  const currentBlocks = cloneBlocks(options.current);

  const currentById = new Map<string, PageSnapshotBlock>();
  const currentByContent = new Map<string, string[]>();
  for (const block of currentBlocks) {
    currentById.set(block.id, block);
    const hash = blockContentHash(block);
    const bucket = currentByContent.get(hash);
    if (bucket === undefined) currentByContent.set(hash, [block.id]);
    else bucket.push(block.id);
  }

  const usedCurrent = new Set<string>();
  const usedIds = new Set<string>();
  const preserved = new Map<string, string>();
  const blocks: PageSnapshotBlock[] = [];
  const added: string[] = [];
  const changed: string[] = [];

  for (const snapBlock of snapshotBlocks) {
    const candidates = currentByContent.get(blockContentHash(snapBlock)) ?? [];
    const reusable = candidates.find((id) => !usedCurrent.has(id));

    if (reusable !== undefined) {
      usedCurrent.add(reusable);
      const current = currentById.get(reusable);
      if (current !== undefined) blocks.push(deepClone(current));
      if (reusable !== snapBlock.id) preserved.set(snapBlock.id, reusable);
      usedIds.add(reusable);
      continue;
    }

    const finalId = snapBlock.id;
    if (!usedIds.has(finalId)) {
      usedIds.add(finalId);
      blocks.push(deepClone(snapBlock));
    }
    if (currentById.has(finalId)) changed.push(finalId);
    else added.push(finalId);
  }

  const removed = currentBlocks
    .filter((block) => !usedIds.has(block.id))
    .map((block) => block.id);

  return {
    pageId: isNonEmptyString(snap?.pageId) ? snap.pageId : "",
    snapshotId: isNonEmptyString(snap?.id) ? snap.id : "",
    restoredAt: toIso(options.now),
    title: typeof snap?.meta?.title === "string" ? snap.meta.title : null,
    blocks,
    added,
    removed,
    changed,
    preserved,
  };
}

/**
 * Describe a workspace as a backup bundle: one entry per page (id, parent,
 * title, deep-copied blocks, content hash) plus aggregate counts. Pages with no
 * id and duplicate ids are skipped. Dangling parent refs are kept so
 * {@link validateBackup} can report them.
 */
export function buildBackup(
  workspace: BackupWorkspace | null | undefined,
  options: BuildBackupOptions = {},
): BackupBundle {
  const source = Array.isArray(workspace?.pages) ? workspace.pages : [];
  const pages: BackupPage[] = [];
  const seen = new Set<string>();

  for (const page of source) {
    const id = isNonEmptyString(page?.id) ? page.id : null;
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const title = typeof page.title === "string" ? page.title : "";
    const blocks = cloneBlocks(page.blocks);
    pages.push({
      id,
      parentId: isNonEmptyString(page.parentId) ? page.parentId : null,
      title,
      blocks,
      contentHash: contentHashOf({ title, blocks }),
    });
  }

  return {
    version: options.version ?? BACKUP_VERSION,
    createdAt: toIso(options.now),
    workspaceId: isNonEmptyString(workspace?.id) ? workspace.id : "",
    workspaceName: typeof workspace?.name === "string" ? workspace.name : null,
    pages,
    counts: {
      pages: pages.length,
      blocks: pages.reduce((total, page) => total + page.blocks.length, 0),
      roots: pages.filter((page) => page.parentId === null).length,
    },
  };
}

/**
 * Check a bundle's schema, format version and referential integrity; returns
 * every issue found (empty exactly when `ok`). Covers a non-object root, an
 * unsupported version, malformed pages/blocks, duplicate ids, dangling or
 * cyclic parent refs, a stale `contentHash` and counts that no longer match.
 * Never throws — junk input is reported, not rejected.
 */
export function validateBackup(bundle: unknown): BackupValidation {
  const issues: BackupIssue[] = [];
  const push = (code: BackupIssueCode, message: string, pageId?: string): void => {
    issues.push(pageId === undefined ? { code, message } : { code, message, pageId });
  };

  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
    return { ok: false, issues: [{ code: "not-an-object", message: "Backup must be an object." }] };
  }
  const record = bundle as Record<string, unknown>;

  if (
    typeof record.version !== "number" ||
    !Number.isInteger(record.version) ||
    !SUPPORTED_BACKUP_VERSIONS.includes(record.version)
  ) {
    push("unsupported-version", `Unsupported backup version: ${JSON.stringify(record.version)}.`);
  }
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
    push("invalid-created-at", "`createdAt` must be an ISO-8601 string.");
  }
  if (!Array.isArray(record.pages)) {
    push("invalid-pages", "`pages` must be an array.");
  }
  const rawPages = Array.isArray(record.pages) ? record.pages : [];

  const ids = new Set<string>();
  const validPages: Record<string, unknown>[] = [];
  let blockTotal = 0;
  let rootCount = 0;

  for (let index = 0; index < rawPages.length; index += 1) {
    const raw = rawPages[index];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      push("invalid-page", `Page at index ${index} must be an object.`);
      continue;
    }
    const page = raw as Record<string, unknown>;
    const id = page.id;
    if (!isNonEmptyString(id)) {
      push("invalid-page-id", `Page at index ${index} has no id.`);
      continue;
    }
    if (ids.has(id)) {
      push("duplicate-page-id", `Duplicate page id: ${id}.`, id);
      continue;
    }
    ids.add(id);
    validPages.push(page);

    if (typeof page.title !== "string") push("invalid-title", `Page ${id}: title must be a string.`, id);

    let blocksValid = Array.isArray(page.blocks);
    const blockIds = new Set<string>();
    if (!Array.isArray(page.blocks)) {
      push("invalid-blocks", `Page ${id}: blocks must be an array.`, id);
    } else {
      blockTotal += page.blocks.length;
      for (const entry of page.blocks) {
        if (!isBlock(entry)) {
          push("invalid-block-id", `Page ${id}: every block needs a non-empty id.`, id);
          blocksValid = false;
          continue;
        }
        if (blockIds.has(entry.id)) {
          push("duplicate-block-id", `Page ${id}: duplicate block id ${entry.id}.`, id);
          blocksValid = false;
          continue;
        }
        blockIds.add(entry.id);
      }
    }

    if (typeof page.contentHash !== "string") {
      push("invalid-content-hash", `Page ${id}: contentHash must be a string.`, id);
    } else if (blocksValid) {
      const expected = contentHashOf({
        title: typeof page.title === "string" ? page.title : "",
        blocks: page.blocks,
      });
      if (expected !== page.contentHash) {
        push("content-hash-mismatch", `Page ${id}: contentHash does not match the content.`, id);
      }
    }

    if (page.parentId === null || page.parentId === undefined) {
      rootCount += 1;
    } else if (typeof page.parentId !== "string") {
      push("invalid-parent", `Page ${id}: parentId must be a string or null.`, id);
    } else if (page.parentId === id) {
      push("self-parent", `Page ${id}: parentId points at itself.`, id);
    }
  }

  // Referential integrity: every string parentId must name a page in the set.
  const parentOf = new Map<string, string>();
  for (const page of validPages) {
    const id = page.id as string;
    const parent = page.parentId;
    if (typeof parent !== "string" || parent === id) continue;
    if (!ids.has(parent)) {
      push("dangling-parent", `Page ${id}: parent ${parent} is not in the backup.`, id);
      continue;
    }
    parentOf.set(id, parent);
  }

  // Cycle detection over the resolved parent links (one issue per cycle).
  const done = new Set<string>();
  for (const page of validPages) {
    const start = page.id as string;
    if (done.has(start)) continue;
    const path: string[] = [];
    const inPath = new Set<string>();
    let cursor: string | null = start;
    while (cursor !== null && !done.has(cursor)) {
      if (inPath.has(cursor)) {
        push("parent-cycle", `Parent cycle detected at page ${cursor}.`, cursor);
        break;
      }
      inPath.add(cursor);
      path.push(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    for (const id of path) done.add(id);
  }

  const counts = record.counts;
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
    push("missing-counts", "`counts` must be an object.");
  } else {
    const countsRecord = counts as Record<string, unknown>;
    const actual = { pages: validPages.length, blocks: blockTotal, roots: rootCount };
    for (const key of ["pages", "blocks", "roots"] as const) {
      if (countsRecord[key] !== actual[key]) {
        push(
          "count-mismatch",
          `counts.${key} expected ${actual[key]}, got ${JSON.stringify(countsRecord[key])}.`,
        );
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Plan a restore of `bundle` onto `target`: pages the bundle adds, updates and
 * pages that exist only in the target (to remove), each update carrying its
 * block-level diff. Bundle order drives `create`/`update`/`entries`; target
 * order drives `remove`. A missing target means an empty workspace.
 */
export function planRestore(
  bundle: BackupBundle | null | undefined,
  target?: RestoreTarget | null,
): RestorePlan {
  const bundlePages = Array.isArray(bundle?.pages) ? bundle.pages : [];
  const targetPages = Array.isArray(target?.pages) ? target.pages : [];
  const targetById = new Map<string, BackupTargetPage>();
  for (const page of targetPages) {
    if (isNonEmptyString(page?.id)) targetById.set(page.id, page);
  }

  const create: string[] = [];
  const update: string[] = [];
  const entries: RestorePlanEntry[] = [];
  const bundleIds = new Set<string>();
  const totals = { added: 0, removed: 0, changed: 0, moved: 0 };

  for (const page of bundlePages) {
    if (!isNonEmptyString(page?.id)) continue;
    bundleIds.add(page.id);
    const existing = targetById.get(page.id);
    if (existing === undefined) {
      create.push(page.id);
      const diff = snapshotDiff([], page.blocks);
      entries.push({ pageId: page.id, action: "create", diff });
      totals.added += diff.counts.added;
    } else {
      update.push(page.id);
      const diff = snapshotDiff(existing.blocks, page.blocks);
      entries.push({ pageId: page.id, action: "update", diff });
      totals.added += diff.counts.added;
      totals.removed += diff.counts.removed;
      totals.changed += diff.counts.changed;
      totals.moved += diff.counts.moved;
    }
  }

  const remove = targetPages
    .filter((page) => isNonEmptyString(page?.id) && !bundleIds.has(page.id))
    .map((page) => page.id);

  return {
    workspaceId: isNonEmptyString(target?.workspaceId)
      ? target.workspaceId
      : isNonEmptyString(bundle?.workspaceId)
        ? bundle.workspaceId
        : "",
    create,
    update,
    remove,
    entries,
    blocks: totals,
    counts: { create: create.length, update: update.length, remove: remove.length },
  };
}
