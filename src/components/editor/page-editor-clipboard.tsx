"use client";

/**
 * Clipboard sanitising and image-upload planning for the editor.
 *
 * Extracted from ./page-editor; the public import path stays stable through
 * that module's re-export. Pure: descriptors in, sanitized HTML / upload plan
 * out; the caller owns the editor transaction and the network upload.
 */
import {
  DEFAULT_ALLOWED_TAGS,
  detectSource,
  normalizeNestedMarks,
  sanitizePaste,
  sourceCleanups,
  stripInlineStyles,
  type PasteCleanupStep,
  type PasteSource,
} from "@/lib/paste-cleanup";
import {
  extractDataUrl,
  inspectClipboardItem,
  planPaste,
  type ClipboardItem,
  type PasteSkip,
  type PasteUpload,
} from "@/lib/clipboard-image";
import { resolveClipboardFileMime } from "@/lib/clipboard-files";

/* --------------------------------------------------------------- paste engines */

/**
 * Attributes the Noema paste normaliser understands, mirroring the rich list
 * `paste.ts` feeds its own sanitizer. `sanitizePaste` (paste-cleanup) has no
 * per-tag wildcard, so the same list is attached to every structural tag; the
 * allowlist then keeps exactly what `normalizePasteHtml` reads while still
 * dropping `on*` handlers and unsafe URL schemes on top.
 */
const NOEMA_PASTE_ATTRS: readonly string[] = [
  "href", "src", "alt", "title", "colspan", "rowspan", "lang", "class",
  "style", "type", "checked", "open", "color", "emoji", "summary",
  "data-block-color", "data-pm-slice", "data-type", "data-checked",
  "data-language", "data-callout", "data-toggle", "data-columns",
  "data-column", "data-toc", "data-caption", "data-summary",
  "data-collapsed", "aria-expanded", "data-color",
];

/**
 * Structural tags the Noema paste normaliser maps to block nodes: the
 * sanitizer's defaults plus the wrappers/atoms `normalizePasteHtml` reads
 * (callout/toggle/columns `div`s, task-list `input`s, inline `span`/`mark`).
 */
const NOEMA_PASTE_TAGS: readonly string[] = [
  ...DEFAULT_ALLOWED_TAGS,
  "div", "span", "ins", "mark", "font", "sub", "sup", "img", "input",
];

const NOEMA_PASTE_ATTR_MAP: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    NOEMA_PASTE_TAGS.map((tag): [string, readonly string[]] => [tag, NOEMA_PASTE_ATTRS]),
  );

/** The sanitized clipboard HTML plus the source fingerprint behind it. */
export type CleanedClipboardHtml = {
  /** Allowlist-sanitised HTML, safe to hand to `normalizePasteHtml`. */
  html: string;
  /** The clipboard source `detectSource` recognised. */
  source: PasteSource;
  /** The extra cleanup steps that source declares (`sourceCleanups`). */
  cleanups: readonly PasteCleanupStep[];
};

/**
 * Route clipboard HTML through the paste-cleanup engine before it ever reaches
 * the document model: fingerprint the source (`detectSource`), read the
 * source-specific cleanup catalogue (`sourceCleanups`), collapse redundant mark
 * nesting, strip Word's `mso-*` inline noise, then harden everything through
 * `sanitizePaste`'s tag/attribute/URL allowlist.
 *
 * Only Word's clipboard triggers the inline-style strip: it is the one source
 * whose noise is both heavy and unambiguous. Noema's *own* copies carry
 * `data-block-id`, which `detectSource` fingerprints as Notion — stripping
 * every non-generic source would therefore erase real text colour on an
 * internal copy/paste, so GDocs/Notion keep their (now class/attr-limited)
 * markup.
 */
export function cleanClipboardHtml(html: string): CleanedClipboardHtml {
  const source = detectSource(html);
  const cleanups = sourceCleanups(source);
  const wantsStyleStrip = cleanups.some((step) => step.id === "word:mso-styles");
  const deNoised = wantsStyleStrip
    ? normalizeNestedMarks(stripInlineStyles(html))
    : normalizeNestedMarks(html);
  return {
    html: sanitizePaste(deNoised, {
      mode: "rich",
      allowedTags: NOEMA_PASTE_TAGS,
      allowedAttrs: NOEMA_PASTE_ATTR_MAP,
    }),
    source,
    cleanups,
  };
}

/** One clipboard file the editor can upload, described without the blob. */
export type ClipboardFileDescriptor = {
  name: string;
  /** Declared `File.type`; blank/generic values fall back to the name's extension. */
  mimeType?: string;
  size: number;
};

/** A gated upload, tied back to the file or HTML data URL it came from. */
export type ClipboardImageUpload = PasteUpload & {
  /** Whether the bytes came from a real `File` or an HTML `data:` image. */
  source: "file" | "data-url";
  /** Index into the input `files` array (present for `source: "file"`). */
  fileIndex?: number;
  /** Base64 payload (present for `source: "data-url"`). */
  data?: string;
};

/** What the clipboard-image pipeline will upload, and what it refused. */
export type ClipboardImagePlan = {
  uploads: ClipboardImageUpload[];
  skipped: PasteSkip[];
};

/**
 * Run the clipboard-image engine over a paste: prefer real `File`s, otherwise
 * pull the first `data:image/*` out of the HTML flavour with `extractDataUrl`.
 * Every candidate is gated by `inspectClipboardItem` (allow-list, SVG safety,
 * size) and named/skipped by `planPaste` before any upload is attempted.
 * Pure: takes descriptors, returns a plan, never touches the network.
 */
export function planClipboardImages(options: {
  files: readonly ClipboardFileDescriptor[];
  html?: string;
  maxBytes?: number;
  existingNames?: Iterable<string>;
  now?: Date | number | string;
}): ClipboardImagePlan {
  type Candidate = ClipboardItem & { source: "file" | "data-url"; fileIndex?: number };
  const candidates: Candidate[] = options.files.map((file, fileIndex) => ({
    // A blank `File.type` is common (clipboard shells, some Linux desktops);
    // `resolveClipboardFileMime` fills it from the name so a `.gif`/`.png`
    // paste is not rejected as an unknown type.
    mimeType: resolveClipboardFileMime({ name: file.name, type: file.mimeType }),
    size: file.size,
    name: file.name,
    source: "file",
    fileIndex,
  }));

  if (candidates.length === 0) {
    const extracted = extractDataUrl(options.html ?? "");
    // A percent-encoded SVG carries no base64 payload, so its safety cannot be
    // re-checked here; skip it rather than reject it as `unsafe-svg`.
    if (extracted && !(extracted.mimeType === "image/svg+xml" && extracted.base64 === "")) {
      candidates.push({
        mimeType: extracted.mimeType,
        size: extracted.size,
        name: "",
        source: "data-url",
        ...(extracted.base64 !== "" ? { data: extracted.base64 } : {}),
      });
    }
  }

  const plan = planPaste({
    items: candidates,
    maxBytes: options.maxBytes,
    existingNames: options.existingNames,
    now: options.now,
  });

  // `planPaste` reports only counts, so re-run the same verdict per candidate to
  // line each accepted upload back up with the bytes it should upload.
  const uploads: ClipboardImageUpload[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    const verdict = inspectClipboardItem(candidate, { maxBytes: options.maxBytes });
    if (!verdict.accept) continue;
    const upload = plan.uploads[cursor];
    cursor += 1;
    if (!upload) break;
    uploads.push({
      ...upload,
      source: candidate.source,
      ...(candidate.fileIndex !== undefined ? { fileIndex: candidate.fileIndex } : {}),
      ...(candidate.data !== undefined ? { data: candidate.data } : {}),
    });
  }
  return { uploads, skipped: plan.skipped };
}

/** Build a browser `File` from a planned `data:` image upload. */
export function dataUrlUploadFile(upload: ClipboardImageUpload): File | null {
  if (!upload.data) return null;
  try {
    const binary = atob(upload.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], upload.name, { type: upload.mimeType });
  } catch {
    return null;
  }
}
