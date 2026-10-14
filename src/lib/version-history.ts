/**
 * Pure version-history helpers shared by the restore action and BOTH history
 * surfaces (page panel + ...-menu timeline). No Prisma here - the sandbox is
 * the unit harness (scripts/LOOP_PLAYBOOK.md "Domain sandboxes").
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
