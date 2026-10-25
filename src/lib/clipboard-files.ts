/**
 * Clipboard file extraction (FEATURE_MATRIX §15 "Paste image from clipboard").
 *
 * A paste event exposes the same image in more than one browser shape:
 *
 *  - Chromium/Edge/Firefox usually put it on `clipboardData.files`;
 *  - Safari (and some Electron/WebView shells) may only expose it through
 *    `clipboardData.items` as a `kind: "file"` item whose `getAsFile()`
 *    returns the bitmap;
 *  - apps that paste rich HTML (Figma, Google Docs, many web editors) put no
 *    file on the clipboard at all — the image is a `data:` URL inside the HTML
 *    flavour (that path lives in `clipboard-image.ts`).
 *
 * This module owns the DOM-free half of the first two shapes: normalise the
 * MIME type (a `File.type` is blank on many systems, so fall back to the file
 * name's extension), keep only images, and coalesce the two lists so an event
 * that carries the same bitmap in both `files` and `items` is uploaded once.
 *
 * Everything is pure and total: a missing/throwing item is skipped, unknown
 * MIME types degrade to `application/octet-stream`, and no input is mutated.
 */

import { DEFAULT_MIME, fileNameExt, mimeForExt } from "@/lib/file-type";

/** The fields the browser gives us for a clipboard file (`File`-shaped). */
export type ClipboardFileLike = {
  name?: string | null;
  type?: string | null;
  size?: number | null;
  lastModified?: number | null;
};

/** One `clipboardData.items` entry (`DataTransferItem`-shaped). */
export type ClipboardItemLike<T extends ClipboardFileLike = ClipboardFileLike> = {
  kind?: string | null;
  type?: string | null;
  /** Returns the wrapped bitmap, or `null` for text/HTML items. */
  getAsFile?: (() => T | null) | null;
};

/** The slice of a `ClipboardEvent.clipboardData` / `DataTransfer` we read. */
export type ClipboardDataLike<T extends ClipboardFileLike = ClipboardFileLike> = {
  files?: ArrayLike<T> | null;
  items?: ArrayLike<ClipboardItemLike<T>> | null;
};

/** MIME aliases browsers report but the rest of the app does not use. */
const MIME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "image/jpg": "image/jpeg",
});

/** Types that carry no information, so the extension should decide. */
const GENERIC_MIME_TYPES: ReadonlySet<string> = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

/** Lower-case a MIME and drop any `; charset=…` parameters. */
function normalizeMime(value: string | null | undefined): string {
  const lower = (value ?? "").split(";", 1)[0].trim().toLowerCase();
  return MIME_ALIASES[lower] ?? lower;
}

/** The extension of a URL or file name, without query/hash and the dot. */
function extensionOf(nameOrUrl: string): string {
  const path = (nameOrUrl ?? "").split(/[?#]/)[0];
  return fileNameExt(path);
}

/**
 * Resolve the MIME type a clipboard file should upload as.
 *
 * The declared `type` wins when it is specific. When it is blank or the generic
 * `application/octet-stream`, the name/URL extension fills the gap — which is
 * what makes a screenshot from a shell that reports no type (or a pasted
 * `image.gif`) upload as the right image instead of being rejected.
 */
export function resolveClipboardFileMime(file: ClipboardFileLike): string {
  const declared = normalizeMime(file?.type);
  if (!GENERIC_MIME_TYPES.has(declared)) return declared;
  const fromName = mimeForExt(extensionOf(file?.name ?? ""));
  return fromName !== DEFAULT_MIME ? fromName : declared || DEFAULT_MIME;
}

/** True when the clipboard file is an image after MIME/extension resolution. */
export function isClipboardImageFile(file: ClipboardFileLike): boolean {
  return resolveClipboardFileMime(file).startsWith("image/");
}

/**
 * A metadata fingerprint for one file. Used only to coalesce a bitmap that the
 * browser exposes in both `files` and `items`: identical metadata is treated as
 * the same paste, while two genuine images with different metadata stay two.
 */
function signatureOf(file: ClipboardFileLike, mime: string): string {
  return [
    mime,
    Number.isFinite(file?.size) ? String(file?.size) : "0",
    (file?.name ?? "").trim().toLowerCase(),
  ].join("|");
}

/**
 * Collect the image files a clipboard event carries, from `files` *and*
 * `items`, in paste order and without duplicates.
 *
 * The `files` list is read first (its order is what the user copied). Each
 * `items` entry whose `getAsFile()` succeeds is then matched against an
 * unconsumed `files` entry with the same MIME/size/name; a match is the same
 * bitmap and is skipped, while an item with no matching file is appended. A
 * second genuine image that happens to share metadata with a `files` entry is
 * still kept when the list holds more than one such entry (counts, not a set,
 * so the two are not collapsed).
 *
 * Non-image files, `kind: "string"` items, `getAsFile()` misses and throwing
 * items are ignored. Never throws.
 */
export function extractClipboardImageFiles<T extends ClipboardFileLike>(
  data: ClipboardDataLike<T> | null | undefined,
): T[] {
  if (!data) return [];

  const out: T[] = [];
  const seen = new Set<T>();
  /** How many still-unmatched `files` entries carry each fingerprint. */
  const fileSignatures = new Map<string, number>();

  const add = (file: T | null | undefined, fromItems: boolean): void => {
    if (!file || typeof file !== "object" || seen.has(file)) return;
    const mime = resolveClipboardFileMime(file);
    if (!mime.startsWith("image/")) return;

    const signature = signatureOf(file, mime);
    if (fromItems) {
      const remaining = fileSignatures.get(signature) ?? 0;
      if (remaining > 0) {
        // Same bitmap as a `files` entry: consume that entry and do not
        // enqueue it twice (the classic duplicate insertion).
        fileSignatures.set(signature, remaining - 1);
        seen.add(file);
        return;
      }
    }

    seen.add(file);
    out.push(file);
    if (!fromItems) {
      fileSignatures.set(signature, (fileSignatures.get(signature) ?? 0) + 1);
    }
  };

  for (const file of Array.from(data.files ?? [])) add(file, false);

  for (const item of Array.from(data.items ?? [])) {
    if (!item) continue;
    const kind = typeof item.kind === "string" ? item.kind.trim().toLowerCase() : "";
    // `kind` is absent in some WebViews; only a declared string item is
    // definitely not a file, so try anything else.
    if (kind !== "" && kind !== "file") continue;

    let file: T | null = null;
    try {
      file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
    } catch {
      file = null;
    }
    add(file, true);
  }

  return out;
}
