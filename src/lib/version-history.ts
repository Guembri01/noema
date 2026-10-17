/**
 * Pure version-history helpers shared by the restore action and BOTH history
 * surfaces (page panel + ...-menu timeline). No Prisma here - the sandbox is
 * the unit harness.
 *
 * B67 - M1 slice of docs/specs/version-history-v2.md (R30.5, R30.11-lite),
 * grown by the M2 slice (R30.8-lite `diffVersions`, R30.10-lite named
 * versions) - see the section headers below.
 */

/**
 * Summary written onto the pre-restore snapshot row (R30.5): it must cite the
 * RESTORED VERSION's own timestamp - the old code did
 * `new Date(version.id ? Date.now() : 0)`, which always rendered *today*.
 */
export function restoreVersionSummary(createdAt: Date): string {
  return `Restored the version from ${createdAt.toLocaleDateString()}`;
}

export type VersionAuthor = { id: string; name: string; email: string };

/**
 * Resolve a version's author from `User` rows (R30.11): by `createdById` alone
 * - current workspace membership is irrelevant, so a departed member still
 * resolves to their User row. Only a missing/deleted user yields `null`; the
 * surface then renders its own label. One resolver keeps the page panel and
 * the ...-menu timeline from drifting apart (spec audit: `page.tsx:198`
 * members-only vs `page-menu.ts:155-172` User lookup).
 */
export function pickVersionAuthor(
  createdById: string | null | undefined,
  users: readonly VersionAuthor[],
): VersionAuthor | null {
  if (!createdById) return null;
  return users.find((user) => user.id === createdById) ?? null;
}

// ---------------------------------------------------------------------------
// M2 - named versions + block-level diff (docs/MISSING_FEATURES.md §10,
// spec R30.8/R30.10-lite). Still no Prisma here: the persistent
// `PageVersion.label` column is a reported schema follow-up, so the helpers
// below take the label as optional pure input.
// ---------------------------------------------------------------------------

/**
 * One snapshot block: a stable `id` plus arbitrary (TipTap-ish) content.
 * `id` is the diff's identity key, so content may be anything JSON-shaped.
 */
export type VersionBlock = { id: string } & Record<string, unknown>;

/** A snapshot, either already decoded or as the raw JSON string. */
export type VersionSnapshot = readonly VersionBlock[] | string;

export type VersionDiff = {
  /** ids present only in `b` (inserted since `a`) - in `b` order. */
  added: string[];
  /** ids present only in `a` (deleted since `a`) - in `a` order. */
  removed: string[];
  /** ids in both whose content differs - in `b` order. */
  changed: string[];
  /** ids in both whose relative order changed - in `b` order. */
  moved: string[];
};

/**
 * Decode a snapshot defensively: malformed or legacy JSON (unparseable string,
 * non-array payload, blocks without a stable id) yields `null` so the diff can
 * degrade instead of throwing (R30.8 no-throw rule).
 */
function parseSnapshot(snapshot: VersionSnapshot): VersionBlock[] | null {
  let decoded: unknown = snapshot;
  if (typeof snapshot === "string") {
    try {
      decoded = JSON.parse(snapshot);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(decoded)) return null;
  const blocks: VersionBlock[] = [];
  for (const item of decoded) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) return null;
    blocks.push(item as VersionBlock);
  }
  return blocks;
}

/** Key-order-independent JSON - so re-serialised equal content compares equal. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Keep-mask of a longest strictly-increasing subsequence (O(n log n) patience
 * pass). Because the ids common to both orders form the *same set*, the LCS of
 * (common ids in `a` order, common ids in `b` order) is exactly the LIS of
 * "where does each `b`-ordered id sit in `a`" - i.e. this is the reordering
 * LCS pass without the O(n·m) DP table. `true` = the block stays on the spine;
 * anything off it is reported `moved`.
 */
function longestIncreasingMask(positions: readonly number[]): boolean[] {
  const tailSlots: number[] = []; // positions[tailSlots[i]] closes a run of length i + 1
  const previous: number[] = new Array<number>(positions.length).fill(-1);
  for (let index = 0; index < positions.length; index += 1) {
    let low = 0;
    let high = tailSlots.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (positions[tailSlots[middle]] < positions[index]) low = middle + 1;
      else high = middle;
    }
    previous[index] = low > 0 ? tailSlots[low - 1] : -1;
    tailSlots[low] = index;
  }
  const mask = new Array<boolean>(positions.length).fill(false);
  let cursor = tailSlots.length > 0 ? tailSlots[tailSlots.length - 1] : -1;
  while (cursor !== -1) {
    mask[cursor] = true;
    cursor = previous[cursor];
  }
  return mask;
}

/**
 * Block-level diff between two page snapshots (🧭 "Version diff"): id-based
 * comparison for added/removed/changed plus an LCS pass for reordering.
 *
 * Deterministic for equal inputs; `added`/`changed`/`moved` follow `b` order,
 * `removed` follows `a` order. A `changed` block may also appear in `moved`
 * (edited *and* relocated). Malformed input on either side degrades to an
 * empty snapshot rather than throwing - the readable side still diffs.
 */
export function diffVersions(a: VersionSnapshot, b: VersionSnapshot): VersionDiff {
  const left = parseSnapshot(a) ?? [];
  const right = parseSnapshot(b) ?? [];

  const leftById = new Map<string, VersionBlock>();
  const leftPosition = new Map<string, number>();
  left.forEach((block, index) => {
    if (leftById.has(block.id)) return;
    leftById.set(block.id, block);
    leftPosition.set(block.id, index);
  });

  const rightIds = new Set<string>();
  const added: string[] = [];
  const changed: string[] = [];
  const commonIdsInB: string[] = [];
  const commonPositions: number[] = [];
  for (const block of right) {
    if (rightIds.has(block.id)) continue; // stable ids are unique; dedupe defensively
    rightIds.add(block.id);
    const before = leftById.get(block.id);
    if (!before) {
      added.push(block.id);
      continue;
    }
    if (canonicalJson(before) !== canonicalJson(block)) changed.push(block.id);
    const position = leftPosition.get(block.id);
    if (position !== undefined) {
      commonIdsInB.push(block.id);
      commonPositions.push(position);
    }
  }

  const removed: string[] = [];
  for (const id of leftById.keys()) {
    if (!rightIds.has(id)) removed.push(id);
  }

  const onSpine = longestIncreasingMask(commonPositions);
  const moved = commonIdsInB.filter((_, index) => !onSpine[index]);

  return { added, removed, changed, moved };
}

/** R30.10: a version label is at most 100 trimmed characters. */
export const MAX_VERSION_LABEL_LENGTH = 100;

export type VersionLabel = string | null | undefined;

/**
 * Trim a label; blank input becomes `null` (an ordinary auto snapshot), and
 * labels over the R30.10 cap are rejected with `RangeError` so the action
 * layer can surface its own validation message.
 */
export function normalizeVersionLabel(label: VersionLabel): string | null {
  if (label === null || label === undefined) return null;
  const trimmed = label.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_VERSION_LABEL_LENGTH) {
    throw new RangeError(`Version label must be at most ${MAX_VERSION_LABEL_LENGTH} characters`);
  }
  return trimmed;
}

export type VersionRecordInput = {
  id: string;
  createdAt: Date;
  /** Optional name for this saved point (R30.10); blank = auto snapshot. */
  label?: VersionLabel;
  /** R30.11: raw `PageVersion.createdById`, resolved against `users` when given. */
  createdById?: string | null;
  /** R30.11: candidate `User` rows for author resolution. */
  users?: readonly VersionAuthor[];
};

export type VersionRecord = {
  id: string;
  createdAt: Date;
  /** Trimmed label, or `null` when the snapshot is unnamed. */
  label: string | null;
  /** True only for snapshots carrying a real label - drives pinning/badges. */
  isNamed: boolean;
  /** Row summary: cites the label (when named) and the version's own date. */
  summary: string;
  /** R30.11 authorship: raw id + resolved author + stable display label. */
  authorship: VersionAuthorship;
};

/**
 * Build the display record for a saved snapshot, accepting an optional label
 * (named versions, 🧭). Pure - persisting `label` needs the reported
 * `PageVersion.label` schema follow-up, so callers pass it in.
 */
export function buildVersionRecord(input: VersionRecordInput): VersionRecord {
  const label = normalizeVersionLabel(input.label);
  return {
    id: input.id,
    createdAt: input.createdAt,
    label,
    isNamed: label !== null,
    summary:
      label !== null
        ? `Named "${label}" on ${input.createdAt.toLocaleDateString()}`
        : `Version from ${input.createdAt.toLocaleDateString()}`,
    authorship: resolveVersionAuthorship(input.createdById, input.users ?? []),
  };
}

/**
 * Latest *named* version (🧭): newest `createdAt` among labelled snapshots -
 * newer unnamed auto-snapshots never win. Accepts raw rows (blank label =
 * unnamed) or already-built records; `createdAt` ties break by input order.
 */
export function pickLatestNamedVersion(
  records: readonly VersionRecordInput[],
): VersionRecord | null {
  let latest: VersionRecord | null = null;
  for (const record of records) {
    const candidate = buildVersionRecord(record);
    if (!candidate.isNamed) continue;
    if (latest === null || candidate.createdAt.getTime() > latest.createdAt.getTime()) {
      latest = candidate;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// M3-lite - the remaining section-10 behaviours, still pure (no Prisma):
// cadence (R30.3/D2), retention (R30.7/D3), authorship fields (R30.11) and
// block-level attribution (R30.16 stage 1). The action/cron layers pass rows
// in; these functions only decide what to write and what to keep, so the
// collab writer (B09 R9.13) and the cron backstop (R30.13) can share them.
// ---------------------------------------------------------------------------

/** R30.3/D2 default cadence: at most one auto snapshot per 5 minutes per page. */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

/** The newest snapshot's clock, or the absence of one. */
export type SnapshotClock = { createdAt: Date };

export type ShouldSnapshotOptions = {
  /** Cadence window in ms (env `VERSION_SNAPSHOT_INTERVAL_S` × 1000). */
  minIntervalMs?: number;
  /**
   * R30.3 change detection: `false` = the candidate content hash equals the
   * newest row's hash, so a write would be a no-op. Omit for the pure clock
   * gate (assume the content changed).
   */
  changed?: boolean;
};

/**
 * Should an *auto* snapshot be written? The first row always snapshots; after
 * that the cadence window must have elapsed since `prev`. `changed: false`
 * suppresses the write entirely (R30.3 dedupe). Named versions and restore
 * points bypass this helper by construction - they are not auto writes.
 */
export function shouldSnapshot(
  prev: SnapshotClock | null | undefined,
  now: Date,
  options: ShouldSnapshotOptions = {},
): boolean {
  if (options.changed === false) return false;
  if (!prev) return true;
  const interval = options.minIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval <= 0) return true;
  return now.getTime() - prev.createdAt.getTime() >= interval;
}

export const DEFAULT_RETENTION = {
  /** Rows younger than this are kept in full (env `VERSION_RETENTION_FULL_D`). */
  fullFidelityDays: 30,
  /** Upper bound of the daily tier; older rows thin to one per 7-day bucket. */
  dailyWindowDays: 90,
  /** Hard cap on *unlabelled* kept rows (env `VERSION_RETENTION_MAX_ROWS`). */
  maxRows: 500,
} as const;

export type RetentionRow = {
  id: string;
  createdAt: Date;
  /** Non-blank labels are pinned: never pruned and exempt from the cap (D7/R30.10). */
  label?: string | null;
};

export type RetentionConfig = {
  fullFidelityDays?: number;
  dailyWindowDays?: number;
  maxRows?: number;
};

export type RetentionDecision<T extends RetentionRow = RetentionRow> = {
  /** Rows to keep, in input order. */
  keep: T[];
  /** Rows to prune, in input order. */
  prune: T[];
  /** Ids to prune - convenience for a batched `deleteMany`. */
  prunedIds: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function isPinnedLabel(label: string | null | undefined): boolean {
  return typeof label === "string" && label.trim().length > 0;
}

/**
 * Pure retention policy (R30.7/D3): full fidelity inside `fullFidelityDays`,
 * one row per UTC day up to `dailyWindowDays`, one per fixed 7-day bucket
 * beyond that, then a hard `maxRows` cap on unlabelled rows. Two invariants
 * always hold - the newest row and every labelled row are never pruned.
 * Returns the partition in input order; the caller deletes `prunedIds`.
 */
export function pruneVersions<T extends RetentionRow>(
  rows: readonly T[],
  now: Date,
  config: RetentionConfig = {},
): RetentionDecision<T> {
  const fullFidelityMs = (config.fullFidelityDays ?? DEFAULT_RETENTION.fullFidelityDays) * DAY_MS;
  const dailyWindowMs = (config.dailyWindowDays ?? DEFAULT_RETENTION.dailyWindowDays) * DAY_MS;
  const maxRows = config.maxRows ?? DEFAULT_RETENTION.maxRows;

  // Newest first; `createdAt` ties keep input order so the result is stable.
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const delta = right.row.createdAt.getTime() - left.row.createdAt.getTime();
      return delta !== 0 ? delta : left.index - right.index;
    });

  const pruneIds = new Set<string>();
  const keptUnlabelledRanks: number[] = [];
  const seenDays = new Set<number>();
  const seenWeeks = new Set<number>();

  ordered.forEach(({ row }, rank) => {
    if (isPinnedLabel(row.label)) return; // labelled: always kept, exempt from the cap
    const age = now.getTime() - row.createdAt.getTime();
    if (age < fullFidelityMs) {
      keptUnlabelledRanks.push(rank); // full-fidelity window
      return;
    }
    if (age < dailyWindowMs) {
      const day = Math.floor(row.createdAt.getTime() / DAY_MS);
      if (seenDays.has(day)) {
        pruneIds.add(row.id);
        return;
      }
      seenDays.add(day);
      keptUnlabelledRanks.push(rank);
      return;
    }
    const week = Math.floor(row.createdAt.getTime() / WEEK_MS);
    if (seenWeeks.has(week)) {
      pruneIds.add(row.id);
      return;
    }
    seenWeeks.add(week);
    keptUnlabelledRanks.push(rank);
  });

  // Hard cap on unlabelled rows, oldest first. The floor of 1 keeps the newest
  // row (rank 0 is always in the list) no matter how small the cap is.
  const cap = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : 1;
  for (const rank of keptUnlabelledRanks.slice(cap)) {
    pruneIds.add(ordered[rank].row.id);
  }

  const keep: T[] = [];
  const prune: T[] = [];
  for (const row of rows) {
    if (pruneIds.has(row.id)) prune.push(row);
    else keep.push(row);
  }
  return { keep, prune, prunedIds: prune.map((row) => row.id) };
}

/**
 * R30.11 stable fallback: an author id that no longer resolves to a `User`
 * still renders the same label on both history surfaces.
 */
export const FORMER_MEMBER_LABEL = "Former member";

export type VersionAuthorship = {
  /** Raw `PageVersion.createdById`; `null` when the row carried none. */
  createdById: string | null;
  /** Resolved `User` row, present only while the user still exists. */
  author: VersionAuthor | null;
  /** Display name, `FORMER_MEMBER_LABEL` for a departed author, or `null`. */
  label: string | null;
  /** True when the row carried an id that no longer resolves to a `User`. */
  isFormerMember: boolean;
};

/**
 * Resolve authorship independently of current workspace membership (R30.11):
 * an id that still has a `User` row wins even if the member left the
 * workspace; an id with no row is a stable "Former member"; a row with no id
 * carries no label, letting the surface render its own.
 */
export function resolveVersionAuthorship(
  createdById: string | null | undefined,
  users: readonly VersionAuthor[],
): VersionAuthorship {
  if (!createdById) {
    return { createdById: null, author: null, label: null, isFormerMember: false };
  }
  const author = pickVersionAuthor(createdById, users);
  if (!author) {
    return { createdById, author: null, label: FORMER_MEMBER_LABEL, isFormerMember: true };
  }
  return { createdById, author, label: author.name, isFormerMember: false };
}

export type BlockAttributionKind = "added" | "removed" | "changed" | "moved" | "unchanged";

export type BlockAttribution = {
  id: string;
  /** Primary classification: added > removed > changed > moved > unchanged. */
  kind: BlockAttributionKind;
  /** Index in `a`, or `null` when the block was added since `a`. */
  aIndex: number | null;
  /** Index in `b`, or `null` when the block was removed since `a`. */
  bIndex: number | null;
  /** Content differs between the two snapshots (present in both only). */
  changed: boolean;
  /** Relative order changed (present in both only). */
  moved: boolean;
  before: VersionBlock | null;
  after: VersionBlock | null;
};

type AlignedBlock = {
  id: string;
  aIndex: number | null;
  bIndex: number;
  before: VersionBlock | null;
  after: VersionBlock;
  changed: boolean;
};

/**
 * Block-level attribution (R30.16 stage 1): extends `diffVersions` with a
 * per-block record - kind, both indices, both payloads plus the changed/moved
 * flags - for a "which block changed" renderer. Order: every block present in
 * `b` (in `b` order), then blocks removed since `a` (in `a` order). Malformed
 * input degrades to an empty side instead of throwing, like `diffVersions`.
 */
export function attributeBlocks(a: VersionSnapshot, b: VersionSnapshot): BlockAttribution[] {
  const left = parseSnapshot(a) ?? [];
  const right = parseSnapshot(b) ?? [];

  const leftIndex = new Map<string, number>();
  left.forEach((block, index) => {
    if (!leftIndex.has(block.id)) leftIndex.set(block.id, index);
  });

  const rightIds = new Set<string>();
  const aligned: AlignedBlock[] = [];
  const commonIdsInB: string[] = [];
  const commonPositions: number[] = [];

  right.forEach((block, bIndex) => {
    if (rightIds.has(block.id)) return; // stable ids are unique; dedupe defensively
    rightIds.add(block.id);
    const aIndex = leftIndex.get(block.id);
    if (aIndex === undefined) {
      aligned.push({ id: block.id, aIndex: null, bIndex, before: null, after: block, changed: false });
      return;
    }
    const before = left[aIndex];
    aligned.push({
      id: block.id,
      aIndex,
      bIndex,
      before,
      after: block,
      changed: canonicalJson(before) !== canonicalJson(block),
    });
    commonIdsInB.push(block.id);
    commonPositions.push(aIndex);
  });

  const onSpine = longestIncreasingMask(commonPositions);
  const movedById = new Map<string, boolean>();
  commonIdsInB.forEach((id, index) => movedById.set(id, !onSpine[index]));

  const attributed: BlockAttribution[] = aligned.map((entry) => {
    const moved = movedById.get(entry.id) ?? false;
    let kind: BlockAttributionKind;
    if (entry.aIndex === null) kind = "added";
    else if (entry.changed) kind = "changed";
    else if (moved) kind = "moved";
    else kind = "unchanged";
    return {
      id: entry.id,
      kind,
      aIndex: entry.aIndex,
      bIndex: entry.bIndex,
      changed: entry.changed,
      moved,
      before: entry.before,
      after: entry.after,
    };
  });

  const removed: BlockAttribution[] = [];
  const removedIds = new Set<string>();
  left.forEach((block, aIndex) => {
    if (rightIds.has(block.id) || removedIds.has(block.id)) return;
    removedIds.add(block.id);
    removed.push({
      id: block.id,
      kind: "removed",
      aIndex,
      bIndex: null,
      changed: false,
      moved: false,
      before: block,
      after: null,
    });
  });

  return [...attributed, ...removed];
}
