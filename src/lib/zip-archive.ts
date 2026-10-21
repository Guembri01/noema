import { inflateRawSync } from "node:zlib";

/**
 * B22 — a ZIP reader with a budget.
 *
 * The Markdown archive import used to hand the whole file to JSZip and then
 * let it decompress whatever it found. A zip bomb — many entries, or one
 * entry that expands a thousandfold — is the same class of problem as the PDF
 * inflate bomb: the *work* is unbounded while the *input* stays small.
 *
 * JSZip cannot be used to bound that on its own: it has no public size API,
 * and the size it does know (the one the archive declares) is only compared
 * **after** the entry has been decompressed. An archive that declares 16 bytes
 * and stores 8 MiB is therefore fully expanded before JSZip complains.
 *
 * So the archive is read here instead: the central directory is parsed first
 * (entry names, declared sizes), the budget is checked against it, and every
 * entry is inflated with `maxOutputLength` — the same cap the PDF importer
 * uses — so the decompressed size is bounded no matter what the archive
 * claims.
 *
 * Formats this reader does not read — and says so, instead of claiming the
 * file is not an archive at all:
 *
 * | format | why it is refused |
 * |---|---|
 * | ZIP64 | the sizes do not fit into 32 bits, so they are above every budget here |
 * | split archive | it spans several disks; only the first one was uploaded |
 * | password-protected | the entries cannot be decrypted without the password |
 * | a compression method other than *store* / *deflate* | it would need an unbounded fallback |
 *
 * A self-extracting archive (a stub in front of the archive) *is* read: the
 * offsets in its central directory are relative to the start of the archive,
 * so the stub's length is added to them.
 */

/** One entry of a ZIP archive, as declared by its central directory. */
export interface ZipEntry {
  /** The entry name, decoded and with `.`/`..` segments resolved. */
  name: string;
  /** The compression method: 0 = stored, 8 = deflate. */
  method: number;
  /** The compressed size, as declared by the archive. */
  compressedSize: number;
  /** The uncompressed size, as declared by the archive. */
  uncompressedSize: number;
  /**
   * The offset of the entry's local file header **within the buffer**.
   *
   * The archive declares this offset relative to the start of the archive; a
   * self-extracting archive's stub is already added here, so the offset can be
   * used to seek in the buffer as it is.
   */
  localOffset: number;
  /** True for a directory entry (MS-DOS attribute or a trailing slash). */
  dir: boolean;
}

/** Why an archive could not be read at all. */
export type ZipArchiveRejection =
  /** No end-of-central-directory record: the bytes are not a ZIP archive. */
  | "not-an-archive"
  /** The record is there, but the central directory does not fit the bytes. */
  | "damaged"
  /** The archive spans several disks (a split archive). */
  | "split"
  /** The sizes do not fit into 32 bits, so the archive uses ZIP64. */
  | "zip64"
  /** At least one entry is password-protected. */
  | "encrypted";

/** The result of reading an archive's central directory. */
export type ZipDirectory =
  | { ok: true; entries: ZipEntry[] }
  | { ok: false; reason: ZipArchiveRejection };

/** Why an entry could not be read. */
export type ZipEntryFailure =
  /** The entry expands past the budget. */
  | "too-large"
  /** The entry's header or data is damaged or truncated. */
  | "unreadable"
  /** The entry uses a compression method this reader does not implement. */
  | "unsupported-method";

/** The result of reading one entry. */
export type ZipEntryRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: ZipEntryFailure };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The ZIP64 "value does not fit" marker (32-bit fields). */
const ZIP64_MARKER = 0xffffffff;
/** The ZIP64 "value does not fit" marker (16-bit fields). */
const ZIP64_MARKER16 = 0xffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** The bit that marks an encrypted entry. */
const FLAG_ENCRYPTED = 0x0001;

/**
 * Decode an entry name the way JSZip does (UTF-8, with the replacement
 * character for invalid sequences) and resolve its `.`/`..` segments, so an
 * archive cannot smuggle a path segment into the imported page tree.
 */
function decodeEntryName(bytes: Uint8Array): string {
  const decoded = new TextDecoder().decode(bytes);
  const parts = decoded.split("/");
  const resolved: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "." || (part === "" && index !== 0 && index !== parts.length - 1)) continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join("/");
}

/**
 * The offset of the "end of central directory" record, or -1 when the bytes
 * are not a ZIP archive. The record sits at the very end of the file, followed
 * by an optional comment of up to 64 KiB.
 */
function findEndOfCentralDirectory(view: DataView): number {
  const length = view.byteLength;
  if (length < 22) return -1;
  const lowest = Math.max(0, length - 22 - 0xffff);
  for (let offset = length - 22; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * Read the central directory of a ZIP archive.
 *
 * Returns the archive's entries, or the reason why the bytes could not be
 * read: no end-of-central-directory record (not an archive at all), a split
 * archive, a ZIP64 archive (its sizes do not fit into 32 bits, so they are far
 * above any budget worth having), a password-protected entry or a truncated
 * directory.
 *
 * A self-extracting archive — a stub (an executable) in front of the archive —
 * is read as well: the offsets in the central directory are relative to the
 * start of the archive, so the stub's length is added to them.
 */
export function readZipDirectory(bytes: Uint8Array): ZipDirectory {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) return { ok: false, reason: "not-an-archive" };

  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  // ZIP64 sizes do not fit into 32 bits — they are above every budget below.
  // The check comes first: a ZIP64 archive carries the marker in its entry
  // counts as well, and "ZIP64" is the more useful of the two answers.
  if (
    totalEntries === ZIP64_MARKER16 ||
    centralSize === ZIP64_MARKER ||
    centralOffset === ZIP64_MARKER
  ) {
    return { ok: false, reason: "zip64" };
  }
  // A split archive spans several disks; there is nothing to read here.
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    return { ok: false, reason: "split" };
  }

  // Self-extracting archives prepend a stub to the archive, so the central
  // directory offset is relative to the start of the archive, not the file.
  // The stub is the difference between where the directory should be and
  // where it is; the same difference applies to every local header offset.
  const prefix = eocd - (centralOffset + centralSize);
  const start = centralOffset + prefix;
  if (prefix < 0 || start < 0 || start + centralSize > bytes.length) {
    return { ok: false, reason: "damaged" };
  }

  const entries: ZipEntry[] = [];
  let cursor = start;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > bytes.length) return { ok: false, reason: "damaged" };
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      return { ok: false, reason: "damaged" };
    }

    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    // An encrypted entry cannot be read without the password.
    if (flags & FLAG_ENCRYPTED) return { ok: false, reason: "encrypted" };
    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localOffset === ZIP64_MARKER
    ) {
      return { ok: false, reason: "zip64" };
    }

    const nameStart = cursor + 46;
    if (nameStart + nameLength > bytes.length) return { ok: false, reason: "damaged" };
    const name = decodeEntryName(bytes.subarray(nameStart, nameStart + nameLength));
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      // The archive declares the offset relative to the start of the archive;
      // the stub of a self-extracting archive is added here.
      localOffset: localOffset + prefix,
      // The MS-DOS directory attribute, or a trailing slash — the same two
      // signals the reference reader uses.
      dir: (view.getUint32(cursor + 38, true) & 0x0010) !== 0 || name.endsWith("/"),
    });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return { ok: true, entries };
}

/**
 * Read one entry and decompress it, refusing anything that decodes to more
 * than `limit` bytes.
 *
 * The cap is enforced by the inflate itself (`maxOutputLength`), not by a
 * comparison afterwards: an archive that declares a tiny size but stores a
 * bomb is aborted while it expands, so the heap never holds the full entry.
 */
export function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  limit: number,
): ZipEntryRead {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localOffset;
  if (offset < 0 || offset + 30 > bytes.length) return { ok: false, reason: "unreadable" };
  if (view.getUint32(offset, true) !== LOCAL_SIGNATURE) {
    return { ok: false, reason: "unreadable" };
  }

  const method = view.getUint16(offset + 8, true);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) return { ok: false, reason: "unreadable" };

  const compressed = bytes.subarray(dataStart, dataEnd);

  if (method === METHOD_STORE) {
    // A stored entry is not compressed: its size is the size of the data.
    if (compressed.length > limit) return { ok: false, reason: "too-large" };
    return { ok: true, bytes: compressed.slice() };
  }
  if (method !== METHOD_DEFLATE) {
    // An unsupported method is not read with an unbounded fallback.
    return { ok: false, reason: "unsupported-method" };
  }

  try {
    const inflated = inflateRawSync(compressed, { maxOutputLength: limit });
    return { ok: true, bytes: new Uint8Array(inflated) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ERR_BUFFER_TOO_LARGE") return { ok: false, reason: "too-large" };
    return { ok: false, reason: "unreadable" };
  }
}
