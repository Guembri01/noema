/**
 * Chunked-upload planning — the pure reference model behind resumable,
 * large-file uploads.
 *
 * A file is split into contiguous, fixed-size parts addressed by `index`
 * (`0..n-1`). Each part carries a **half-open** byte range `[start, end)` — the
 * end is exclusive, so `size === end - start` — and the parts tile the whole
 * file with no gaps or overlaps. Nothing here touches the network, the
 * filesystem or the DB: `planChunks` describes the work, and a transport
 * (XHR/fetch) is expected to send each part and then report which indexes
 * landed via `resumeFrom` / `isComplete`.
 *
 * Every entry point is total: an invalid size, chunk size or plan degrades to
 * an empty plan / `false` rather than throwing, so untrusted numbers (a
 * `File.size`, a persisted resume map) can flow straight in.
 */

/** A single uploadable piece: the half-open byte range `[start, end)`. */
export type ChunkPart = {
  /** Zero-based position of this part in the plan. */
  index: number;
  /** First byte of the range (inclusive). */
  start: number;
  /** One past the last byte of the range (exclusive). */
  end: number;
  /** Byte count, always `end - start`. */
  size: number;
};

/**
 * Default part size (5 MiB) — the S3 multipart minimum and half the current
 * single-shot upload cap (`src/app/api/upload/route.ts`), so a chunked upload
 * of a large file stays comfortably within per-request body limits.
 */
export const CHUNK_SIZE_DEFAULT = 5 * 1024 * 1024;

/** A non-negative integer byte count is the only *valid* size or offset. */
function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A chunk size must be a positive integer; anything else uses the default. */
function resolveChunkSize(chunkSize: number | undefined): number {
  return typeof chunkSize === "number" && Number.isInteger(chunkSize) && chunkSize > 0
    ? chunkSize
    : CHUNK_SIZE_DEFAULT;
}

/** Collect only the *integer* indexes from an untrusted list (junk is dropped). */
function toIndexSet(indexes: readonly number[] | null | undefined): Set<number> {
  const set = new Set<number>();
  if (Array.isArray(indexes)) {
    for (const index of indexes) {
      if (Number.isInteger(index)) set.add(index);
    }
  }
  return set;
}

/**
 * Split `fileSize` bytes into contiguous parts of at most `chunkSize` bytes
 * (default `CHUNK_SIZE_DEFAULT`). Indexes run `0..n-1`, the first part starts
 * at `0`, every part starts where the previous one ended, and the final part
 * holds whatever remains (so it is the only one that may be shorter).
 *
 * Total on bad input: a zero byte count plans nothing (`[]`), and a negative,
 * fractional or non-finite `fileSize` also yields `[]`. A non-positive,
 * fractional or non-finite `chunkSize` silently falls back to the default.
 */
export function planChunks(
  fileSize: number,
  options: { chunkSize?: number } = {},
): ChunkPart[] {
  if (!isByteCount(fileSize) || fileSize === 0) return [];
  const chunkSize = resolveChunkSize(options.chunkSize);
  const parts: ChunkPart[] = [];
  for (let start = 0; start < fileSize; start += chunkSize) {
    const end = Math.min(start + chunkSize, fileSize);
    parts.push({ index: parts.length, start, end, size: end - start });
  }
  return parts;
}

/**
 * How many parts a file of `fileSize` bytes needs at `chunkSize` bytes each —
 * the ceiling division, and always `planChunks(fileSize, { chunkSize }).length`.
 * An empty or invalid `fileSize` needs none (`0`); an invalid `chunkSize`
 * falls back to the default.
 */
export function totalParts(
  fileSize: number,
  chunkSize: number = CHUNK_SIZE_DEFAULT,
): number {
  if (!isByteCount(fileSize)) return 0;
  return Math.ceil(fileSize / resolveChunkSize(chunkSize));
}

/**
 * Whether `plan` is a well-formed chunk plan.
 *
 * A valid plan is an array (possibly empty, for a zero-byte file) whose parts
 * tile `[0, fileSize)` in order: `index` counts `0..n-1`, the first part starts
 * at `0`, each part starts exactly where the previous ended, every `size`
 * equals `end - start` and is positive, all parts but the last share one size,
 * and the last is no larger than them. Anything else — a non-array, a gap, an
 * overlap, a fractional offset, a short middle part — is rejected. Typed
 * `unknown` so untrusted JSON can be checked without a cast.
 */
export function validateChunkPlan(plan: unknown): boolean {
  if (!Array.isArray(plan)) return false;
  let expectedSize: number | null = null;
  let previousEnd = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const part = plan[i] as Partial<ChunkPart> | null | undefined;
    if (typeof part !== "object" || part === null) return false;
    const { index, start, end, size } = part;
    if (index !== i || !isByteCount(start) || !isByteCount(end) || !isByteCount(size)) {
      return false;
    }
    if (start !== previousEnd || end <= start || size !== end - start) return false;
    if (i < plan.length - 1) {
      expectedSize ??= size;
      if (size !== expectedSize) return false;
    } else if (expectedSize !== null && size > expectedSize) {
      return false;
    }
    previousEnd = end;
  }
  return true;
}

/**
 * The parts still to upload: every part whose `index` is not in
 * `uploadedIndexes`, kept in plan order. Indexes are matched as integers;
 * unknown, out-of-range, fractional and non-finite entries are ignored (a
 * resume map restored from storage may carry extra keys). A malformed plan
 * yields `[]`; a missing index list resumes from the beginning.
 */
export function resumeFrom(
  plan: readonly ChunkPart[],
  uploadedIndexes: readonly number[],
): ChunkPart[] {
  if (!Array.isArray(plan)) return [];
  const uploaded = toIndexSet(uploadedIndexes);
  return plan.filter((part) => !uploaded.has(part.index));
}

/**
 * Whether every part in `plan` has been received. Duplicate or unknown indexes
 * in `receivedIndexes` are ignored, and order does not matter. An empty plan
 * (a zero-byte file) is complete by definition; a malformed (non-array) plan
 * is not.
 */
export function isComplete(
  plan: readonly ChunkPart[],
  receivedIndexes: readonly number[],
): boolean {
  if (!Array.isArray(plan)) return false;
  if (plan.length === 0) return true;
  const received = toIndexSet(receivedIndexes);
  return plan.every((part) => received.has(part.index));
}
