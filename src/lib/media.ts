/**
 * Pure media helpers — drag-drop upload progress, image resize-handle maths,
 * media alignment, the per-workspace upload size cap and the garbage-collection
 * (orphan detection) maths. Dependency-free so vitest owns the behaviour and
 * the node views only do DOM wiring (new logic starts as a pure lib).
 */

export type MediaAlign = "left" | "center" | "right";

/** The image block never shrinks below this fraction of the content width. */
export const MIN_IMAGE_WIDTH_PERCENT = 15;

/**
 * Upload progress as a whole percent, clamped to 0..100.
 * A missing/unknown length (`total <= 0`, the XHR `lengthComputable: false`
 * case) reports 0 — renderers treat that as an indeterminate indicator.
 */
export function uploadPercent(loaded: number, total: number): number {
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return 0;
  if (loaded <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
}

/**
 * Turn a handle drag into a width percent for the image block.
 * `deltaX` is the pointer travel in px, `containerWidth` the measured block
 * width; an unmeasurable container keeps the starting size instead of
 * collapsing the image.
 */
export function resizeWidthPercent(input: {
  startPercent: number;
  deltaX: number;
  containerWidth: number;
}): number {
  const clamp = (value: number): number =>
    Math.min(100, Math.max(MIN_IMAGE_WIDTH_PERCENT, Math.round(value)));
  const start = clamp(Number.isFinite(input.startPercent) ? input.startPercent : 100);
  if (!Number.isFinite(input.containerWidth) || input.containerWidth <= 0) return start;
  return clamp(start + (input.deltaX / input.containerWidth) * 100);
}

/** Trust nothing stored in a document: unknown alignment falls back to left. */
export function alignOf(value: unknown): MediaAlign {
  return value === "center" || value === "right" ? value : "left";
}

/** Auto margins that push a block-level picture to its aligned edge. */
export function alignStyle(align: MediaAlign): { marginLeft: string; marginRight: string } {
  if (align === "center") return { marginLeft: "auto", marginRight: "auto" };
  if (align === "right") return { marginLeft: "auto", marginRight: "0" };
  return { marginLeft: "0", marginRight: "auto" };
}

/**
 * §15 file size limits — one cap per workspace (the Asset row carries only a
 * mimeType, so there is no per-kind model to hang image/video caps off yet).
 * The cap lives in workspace config as a human string ("5MB") or raw bytes;
 * these helpers normalise it and enforce it before an upload starts.
 */

/** Sane default (~Notion's free plan) used when config is absent or nonsense. */
export const DEFAULT_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;

/** Binary multiples; bare "K"/"M"/"G" and the IEC spellings are accepted. */
const SIZE_UNIT_BYTES: Record<string, number> = {
  "": 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

const SIZE_LIMIT_PATTERN = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i;

/**
 * Normalise a stored limit ("5MB", "2gb", "1.5 MB", raw bytes) to bytes.
 * Trust nothing from config: invalid, zero and negative values fall back to
 * {@link DEFAULT_UPLOAD_LIMIT_BYTES} rather than blocking every upload.
 */
export function parseSizeLimit(limit: string | number): number {
  if (typeof limit === "number") {
    return Number.isFinite(limit) && limit > 0 ? Math.round(limit) : DEFAULT_UPLOAD_LIMIT_BYTES;
  }
  const match = SIZE_LIMIT_PATTERN.exec(limit.trim());
  if (!match) return DEFAULT_UPLOAD_LIMIT_BYTES;
  const unit = SIZE_UNIT_BYTES[match[2].toLowerCase()];
  const bytes = Number(match[1]) * (unit ?? Number.NaN);
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_UPLOAD_LIMIT_BYTES;
  return Math.round(bytes);
}

/** Human-readable size for user-facing messages ("1.5 KB", "5 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${String(rounded)} ${units[unitIndex]}`;
}

/** Result of a pre-upload size check; `reason` is safe to show verbatim. */
export interface FileSizeCheck {
  ok: boolean;
  bytes: number;
  limitBytes: number;
  /** How far over the cap the file is (0 when within it). */
  overByBytes: number;
  reason: string | null;
}

/**
 * Check a file against the workspace cap. The cap is inclusive (exactly at the
 * limit passes); an unreadable size (`NaN`/`Infinity`/negative) fails closed
 * with a reason rather than sneaking past.
 */
export function checkFileSize(bytes: number, limit: string | number): FileSizeCheck {
  const limitBytes = parseSizeLimit(limit);
  const base = { bytes, limitBytes, overByBytes: 0 };
  if (!Number.isFinite(bytes) || bytes < 0) {
    return { ...base, ok: false, reason: "Could not read the file size — please retry the upload." };
  }
  if (bytes <= limitBytes) return { ...base, ok: true, reason: null };
  const overByBytes = bytes - limitBytes;
  return {
    ...base,
    ok: false,
    overByBytes,
    reason: `File is ${formatBytes(bytes)} which is ${formatBytes(overByBytes)} over the ${formatBytes(limitBytes)} limit.`,
  };
}

/**
 * §15 media garbage collection — pure orphan maths. A stored asset stays
 * alive while any page content or cover still references its key; everything
 * else is a deletion candidate. Deleting the storage objects is the caller's
 * job (needs DB + bucket access, so it lives outside this lib).
 */

/** A stored media object as the GC sweep sees it (matches the Asset row). */
export interface StoredAsset {
  /** Storage key/URL that page content or a cover references to keep it alive. */
  key: string;
  /** Recorded size in bytes; unknown sizes count as 0. */
  bytes?: number;
}

/**
 * Assets whose key appears in no page content/cover, in input order.
 * Duplicate keys collapse to the first row (they are one storage object), and
 * a referenced key is never returned — even when several rows share it.
 */
export function findOrphanedAssets(
  assets: readonly StoredAsset[],
  referencedKeys: Iterable<string>,
): StoredAsset[] {
  const referenced = new Set(referencedKeys);
  const seen = new Set<string>();
  const orphans: StoredAsset[] = [];
  for (const asset of assets) {
    if (referenced.has(asset.key) || seen.has(asset.key)) continue;
    seen.add(asset.key);
    orphans.push(asset);
  }
  return orphans;
}

/** GC sweep result: what was scanned, what can go, and how many bytes that frees. */
export interface GcSummary {
  totalAssets: number;
  orphanedCount: number;
  reclaimableBytes: number;
}

/** Counts + reclaimable bytes for a sweep, using the same dedupe rules as findOrphanedAssets. */
export function summarizeGc(
  assets: readonly StoredAsset[],
  referencedKeys: Iterable<string>,
): GcSummary {
  const orphans = findOrphanedAssets(assets, referencedKeys);
  let reclaimableBytes = 0;
  for (const orphan of orphans) {
    const bytes = orphan.bytes;
    if (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0) {
      reclaimableBytes += bytes;
    }
  }
  return { totalAssets: assets.length, orphanedCount: orphans.length, reclaimableBytes };
}
