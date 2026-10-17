/**
 * Clipboard image paste engine (FEATURE_MATRIX §15 "Paste image from clipboard"
 * — "works for many sources").
 *
 * Copying an image puts it on the clipboard in more than one shape: a raster
 * `image/*` blob (Chrome/Safari/Firefox), an SVG document, or — from apps that
 * only round-trip HTML (Figma, Google Docs, many web editors) — a `text/html`
 * flavour whose only real payload is an `<img src="data:image/…">`. This module
 * is the pure, DOM-free gate between those flavours and the upload pipeline:
 *
 *  - {@link extractDataUrl} pulls the first `data:` image out of an HTML string
 *    (or accepts a bare data URL), decoding the base64 or percent-encoded
 *    payload just far enough to know its MIME type, payload and byte size.
 *  - {@link inspectClipboardItem} decides whether one clipboard item may be
 *    pasted: it normalises the MIME type, resolves the byte size, enforces the
 *    allow-list and the `maxBytes` limit, and screens SVG for script / event
 *    handlers / external references via `isSvgSafe` (`@/lib/svg-safety` — the
 *    one SVG rule the upload route runs as well).
 *  - {@link slugifyFilename} / {@link dedupeName} mint the deterministic,
 *    collision-free attachment name (`pasted-image-2026-01-02-1530.png`,
 *    `… (2).png`).
 *  - {@link planPaste} runs the whole pipeline over every clipboard item and
 *    returns the uploads to send plus the items it skipped and why.
 *  - {@link describePastePlan} renders that plan as one line of copy.
 *
 * Everything is pure and total: no clock is read unless the caller omits `now`,
 * inputs are never mutated, malformed input degrades to a rejection or `null`
 * rather than throwing, and no `any` is used anywhere.
 */

import { extForMime } from "@/lib/file-type";
import { isSvgSafe } from "@/lib/svg-safety";
// The rule moved to `@/lib/svg-safety`, but the name stays exported from
// here: the upload route and the clipboard path both import it from this
// module, and the public name of the module must not change.
export { isSvgSafe };

/** One clipboard item, normalised from a `ClipboardItem`/`File`/DataTransfer. */
export type ClipboardItem = {
  /** MIME type as reported by the source, e.g. `"image/png"` / `"text/html"`. */
  mimeType?: string;
  /** Alias for {@link ClipboardItem.mimeType} (the `File`/`ClipboardItem` field). */
  type?: string;
  /** Byte size when the source already knows it (e.g. a `File`). */
  size?: number;
  /** Raw payload: base64 (or a data URL) for images, HTML markup for `text/html`. */
  data?: string;
  /** Original file name, when the source provides one. */
  name?: string;
};

/** The MIME types a paste accepts unless the caller overrides them. */
export const DEFAULT_ALLOWED_TYPES: readonly string[] = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/** Rejection reasons returned in {@link ClipboardVerdict.reason}. */
export const REJECT_UNSUPPORTED_TYPE = "unsupported-type";
export const REJECT_TYPE_NOT_ALLOWED = "type-not-allowed";
export const REJECT_NO_IMAGE = "no-image";
export const REJECT_TOO_LARGE = "too-large";
export const REJECT_UNSAFE_SVG = "unsafe-svg";
export const REJECT_EMPTY = "empty";

/** Options for {@link inspectClipboardItem} / {@link planPaste}. */
export type InspectOptions = {
  /** Largest accepted byte size (inclusive). Omitted means "no limit". */
  maxBytes?: number;
  /** Accepted MIME rules (`image/png`, `image/*`, `png`, `*`). Defaults to
   *  {@link DEFAULT_ALLOWED_TYPES}. */
  allowedTypes?: readonly string[];
};

/** The verdict for one clipboard item. `reason` is set only when rejected. */
export type ClipboardVerdict = {
  accept: boolean;
  reason?: string;
  mimeType: string;
  size: number;
};

/* ---------------------------------------------------------------- helpers */

/** Common MIME aliases the clipboard reports but the allow-list does not use. */
const MIME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "image/jpg": "image/jpeg",
});

/** Lower-case a MIME and drop any `; charset=…` parameters. */
function normalizeMime(value: string | undefined): string {
  const lower = (value ?? "").split(";", 1)[0].trim().toLowerCase();
  return MIME_ALIASES[lower] ?? lower;
}

/** Whether a MIME type is an image of any kind. */
function isImageMime(mime: string): boolean {
  return /^image\//.test(mime);
}

/** UTF-8 byte length, via the platform `TextEncoder` (no Node-only Buffer). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Decoded byte length of a base64 payload, without allocating the bytes. */
function base64ByteLength(value: string): number {
  const clean = value.replace(/[^A-Za-z0-9+/=]/g, "");
  if (clean.length === 0) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/** Decode a base64 string to UTF-8 text, or `null` when it is not decodable. */
function decodeBase64ToText(base64: string): string | null {
  try {
    const binary = atob(base64);
    const raw = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) raw[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(raw);
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------- data: URLs */

type ParsedDataUrl = {
  mimeType: string;
  /** Base64 payload, or `""` for a percent-encoded (non-base64) data URL. */
  base64: string;
  size: number;
  /** Decoded text for a non-base64 data URL; `null` for base64. */
  text: string | null;
};

const DATA_URL_RE = /^data:([^;,]+)((?:;[^;,]*)*),([\s\S]*)$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Parse one data URL into MIME type, payload and decoded size. */
function parseDataUrl(value: string): ParsedDataUrl | null {
  const compact = value.replace(/\s+/g, "");
  const match = DATA_URL_RE.exec(compact);
  if (!match) return null;
  const mimeType = normalizeMime(match[1]);
  if (!isImageMime(mimeType)) return null;
  const params = match[2] ?? "";
  let payload = match[3] ?? "";
  if (payload === "") return null;
  const isBase64 = /(?:^|;)base64(?:;|$)/i.test(params);
  if (isBase64) {
    if (payload.includes("%")) {
      try {
        payload = decodeURIComponent(payload);
      } catch {
        return null;
      }
    }
    if (!BASE64_RE.test(payload)) return null;
    return { mimeType, base64: payload, size: base64ByteLength(payload), text: null };
  }
  let text = payload;
  if (payload.includes("%")) {
    try {
      text = decodeURIComponent(payload);
    } catch {
      return null;
    }
  }
  return { mimeType, base64: "", size: byteLength(text), text };
}

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const SRC_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Find the first data-URL image inside an HTML string (or a bare data URL). */
function firstDataUrl(html: string): ParsedDataUrl | null {
  if (typeof html !== "string" || html.trim() === "") return null;
  if (html.trim().toLowerCase().startsWith("data:")) return parseDataUrl(html.trim());
  IMG_TAG_RE.lastIndex = 0;
  let tag = IMG_TAG_RE.exec(html);
  while (tag !== null) {
    const srcMatch = SRC_RE.exec(tag[0]);
    if (srcMatch) {
      const src = (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? "").trim();
      if (src.toLowerCase().startsWith("data:")) {
        const parsed = parseDataUrl(src);
        if (parsed) return parsed;
      }
    }
    tag = IMG_TAG_RE.exec(html);
  }
  return null;
}

/** An image data URL extracted from a clipboard payload. */
export type ExtractedDataUrl = {
  mimeType: string;
  /** Base64 payload, or `""` for a percent-encoded (non-base64) data URL. */
  base64: string;
  /** Decoded byte size of the image payload. */
  size: number;
};

/**
 * Extract the first `data:image/*` URL from `html` — the `src` of the first
 * `<img>` that carries one — or, when `html` is itself a data URL, that URL.
 * Returns `null` when there is no image data URL, when the URL targets a
 * non-image MIME type, or when it is malformed. Never throws.
 */
export function extractDataUrl(html: string): ExtractedDataUrl | null {
  const parsed = firstDataUrl(html);
  return parsed
    ? { mimeType: parsed.mimeType, base64: parsed.base64, size: parsed.size }
    : null;
}

/* ----------------------------------------------------------- SVG safety */

/*
 * The SVG rule itself lives in `@/lib/svg-safety`: the upload route runs the
 * same function, so a file cannot be safe on the clipboard path and unsafe on
 * the upload path. It is imported here — not re-implemented — so both paths
 * share one policy.
 */

/* --------------------------------------------------------- inspect item */

/** Decoded SVG source for a parsed payload, when the payload is an SVG. */
function svgTextOf(parsed: ParsedDataUrl): string | null {
  if (parsed.mimeType !== "image/svg+xml") return null;
  if (parsed.text !== null) return parsed.text;
  if (parsed.base64 !== "") return decodeBase64ToText(parsed.base64);
  return null;
}

/** Whether `mime` matches any rule in the allow-list (or the default list). */
function typeAllowed(mime: string, allowed: readonly string[] | undefined): boolean {
  const rules = allowed ?? DEFAULT_ALLOWED_TYPES;
  const target = normalizeMime(mime);
  if (target === "") return false;
  const subtype = target.slice(target.indexOf("/") + 1).replace(/\+.*$/, "");
  for (const raw of rules) {
    const rule = (raw ?? "").trim().toLowerCase();
    if (rule === "") continue;
    if (rule === "*" || rule === "*/*") return true;
    if (rule.endsWith("/*")) {
      if (target.startsWith(rule.slice(0, -1))) return true;
      continue;
    }
    if (rule.includes("/")) {
      if (rule === target) return true;
      continue;
    }
    const ext = extForMime(target);
    if (rule.replace(/^\.+/, "") === ext || rule === subtype) return true;
  }
  return false;
}

/**
 * Decide whether a single clipboard item may be pasted.
 *
 * Handles a raster `image/*` item (size from `data` — a base64 payload or a
 * data URL — or from `size`) and a `text/html` item whose first `data:image/*`
 * `<img>` becomes the payload. Rejects with a stable reason: a non-image MIME
 * (`unsupported-type`), a MIME outside `allowedTypes` (`type-not-allowed`),
 * `text/html` with no embedded image (`no-image`), an unsafe SVG
 * (`unsafe-svg`), an empty payload (`empty`), or a payload over `maxBytes`
 * (`too-large`; the limit is inclusive). Never throws.
 */
export function inspectClipboardItem(
  item: ClipboardItem,
  options: InspectOptions = {},
): ClipboardVerdict {
  const maxBytes =
    typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes)
      ? options.maxBytes
      : Number.POSITIVE_INFINITY;
  const declared = normalizeMime(item?.mimeType ?? item?.type);
  const declaredSize =
    typeof item?.size === "number" && Number.isFinite(item.size) ? item.size : undefined;
  const rawData = typeof item?.data === "string" ? item.data : "";

  let mimeType = declared;
  let size = declaredSize ?? 0;
  let svgSource: string | null = null;

  if (declared === "text/html") {
    const parsed = firstDataUrl(rawData);
    if (!parsed) return { accept: false, reason: REJECT_NO_IMAGE, mimeType: "text/html", size: 0 };
    mimeType = parsed.mimeType;
    size = parsed.size;
    svgSource = svgTextOf(parsed);
  } else if (isImageMime(declared)) {
    if (rawData.trim().startsWith("data:")) {
      const parsed = parseDataUrl(rawData);
      if (parsed) {
        mimeType = parsed.mimeType;
        size = parsed.size;
        svgSource = svgTextOf(parsed);
      }
    } else if (rawData.trim().startsWith("<")) {
      size = byteLength(rawData);
      if (declared === "image/svg+xml") svgSource = rawData;
    } else if (rawData !== "") {
      size = base64ByteLength(rawData);
      if (declared === "image/svg+xml") svgSource = decodeBase64ToText(rawData);
    }
  } else {
    return {
      accept: false,
      reason: REJECT_UNSUPPORTED_TYPE,
      mimeType: declared || "unknown",
      size: 0,
    };
  }

  if (!typeAllowed(mimeType, options.allowedTypes)) {
    return { accept: false, reason: REJECT_TYPE_NOT_ALLOWED, mimeType, size };
  }
  if (mimeType === "image/svg+xml" && !isSvgSafe(svgSource ?? "")) {
    return { accept: false, reason: REJECT_UNSAFE_SVG, mimeType, size };
  }
  if (size <= 0) {
    return { accept: false, reason: REJECT_EMPTY, mimeType, size };
  }
  if (size > maxBytes) {
    return { accept: false, reason: REJECT_TOO_LARGE, mimeType, size };
  }
  return { accept: true, mimeType, size };
}

/* ---------------------------------------------------------- naming */

/** Options for {@link slugifyFilename}. */
export type SlugifyFilenameOptions = {
  /** Extension to use (no dot); defaults to the name's extension, then `png`. */
  ext?: string;
  /** Timestamp source; defaults to the current time. Accepts a `Date`/number/string. */
  now?: Date | number | string;
  /** Prefix before the slug; defaults to `pasted`. */
  prefix?: string;
};

const MAX_SLUG = 48;

/** URL-safe slug; `""` when nothing survives (no fallback). */
function slugifyRaw(value: string): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
}

/** Split a name/path into its base and (undotted) extension. */
function splitName(name: string): { base: string; ext: string } {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return { base, ext: "" };
  return { base: base.slice(0, dot), ext: base.slice(dot + 1) };
}

/** Normalise an extension: lower-case, alphanumeric, no leading dot. */
function normalizeExt(ext: string | undefined): string {
  const clean = (ext ?? "").trim().toLowerCase().replace(/^\.+/, "");
  return /^[a-z0-9]+$/.test(clean) ? clean : "";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD-HHmm` in UTC; an invalid/missing date falls back to the epoch. */
function formatStamp(now: Date | number | string | undefined): string {
  const date = now instanceof Date ? now : now === undefined ? new Date() : new Date(now);
  const resolved = Number.isNaN(date.getTime()) ? new Date(0) : date;
  return (
    `${resolved.getUTCFullYear()}-${pad2(resolved.getUTCMonth() + 1)}-${pad2(resolved.getUTCDate())}` +
    `-${pad2(resolved.getUTCHours())}${pad2(resolved.getUTCMinutes())}`
  );
}

/**
 * Build a deterministic attachment name from an original name and a timestamp:
 * `pasted-<slug>-<YYYY-MM-DD-HHmm>.<ext>`, e.g. the default
 * `pasted-image-2026-01-02-1530.png`. The slug comes from the name's basename
 * (diacritics stripped, punctuation collapsed); an empty/unusable name becomes
 * `image`. The extension is `options.ext`, else the name's, else `png`. The
 * timestamp is formatted in UTC so a given `now` always yields the same name.
 */
export function slugifyFilename(name: string, options: SlugifyFilenameOptions = {}): string {
  const { base, ext: nameExt } = splitName(name);
  const slug = slugifyRaw(base) || "image";
  const ext = normalizeExt(options.ext) || normalizeExt(nameExt) || "png";
  const prefix = slugifyRaw(options.prefix ?? "pasted") || "pasted";
  return `${prefix}-${slug}-${formatStamp(options.now)}.${ext}`;
}

/**
 * Return `name` if it is free, otherwise append ` (2)`, ` (3)`, … before the
 * extension until a free candidate is found (Notion style). Comparison against
 * `existing` is case-insensitive; the returned name keeps its original casing.
 * Accepts any iterable of names and never mutates the input.
 */
export function dedupeName(name: string, existing: Iterable<string> = []): string {
  const target = typeof name === "string" ? name : "";
  if (target === "") return target;
  const used = new Set<string>();
  for (const entry of existing) {
    if (typeof entry === "string") used.add(entry.trim().toLowerCase());
  }
  const { base, ext } = splitName(target);
  const suffix = ext ? `.${ext}` : "";
  const stem = suffix ? base : target;
  let candidate = target;
  let index = 1;
  while (used.has(candidate.trim().toLowerCase())) {
    index += 1;
    candidate = `${stem} (${index})${suffix}`;
  }
  return candidate;
}

/* ------------------------------------------------------------ planning */

/** One upload to send: a de-duplicated name, its MIME type and byte size. */
export type PasteUpload = {
  name: string;
  mimeType: string;
  bytes: number;
};

/** One item that will not be uploaded, and why. */
export type PasteSkip = {
  reason: string;
};

/** The result of {@link planPaste}: what to upload and what was skipped. */
export type PastePlan = {
  uploads: PasteUpload[];
  skipped: PasteSkip[];
};

/** Options for {@link planPaste}. */
export type PlanPasteOptions = {
  items: readonly ClipboardItem[];
  /** Names already used on the page; new names are de-duplicated against them. */
  existingNames?: Iterable<string>;
  /** Largest accepted byte size per item (inclusive). */
  maxBytes?: number;
  /** Timestamp used for every generated name; defaults to the current time. */
  now?: Date | number | string;
  /** Accepted MIME rules; defaults to {@link DEFAULT_ALLOWED_TYPES}. */
  allowedTypes?: readonly string[];
};

/**
 * Turn a batch of clipboard items into an upload plan. Every accepted item is
 * named from its `name` (or `image`) and the plan's timestamp, de-duplicated
 * against `existingNames` and against the other items in the same batch; every
 * rejected item contributes its reason to `skipped`. Order is preserved within
 * each array, and no input is mutated.
 */
export function planPaste(options: PlanPasteOptions): PastePlan {
  const items = Array.isArray(options?.items) ? options.items : [];
  const used = new Set<string>();
  if (options?.existingNames !== undefined) {
    for (const name of options.existingNames) {
      if (typeof name === "string") used.add(name.trim().toLowerCase());
    }
  }

  const uploads: PasteUpload[] = [];
  const skipped: PasteSkip[] = [];
  for (const item of items) {
    const verdict = inspectClipboardItem(item ?? {}, {
      maxBytes: options?.maxBytes,
      allowedTypes: options?.allowedTypes,
    });
    if (!verdict.accept) {
      skipped.push({ reason: verdict.reason ?? "rejected" });
      continue;
    }
    const ext = extForMime(verdict.mimeType) || "png";
    const desired = slugifyFilename(item?.name ?? "", { ext, now: options?.now });
    const name = dedupeName(desired, used);
    used.add(name.trim().toLowerCase());
    uploads.push({ name, mimeType: verdict.mimeType, bytes: verdict.size });
  }
  return { uploads, skipped };
}

/**
 * Render a paste plan as one line of copy: `"2 images ready"`,
 * `"1 image ready; 1 skipped (too-large)"`, or `"Nothing to paste"` for an empty
 * plan. Skip reasons are de-duplicated and kept in first-seen order.
 */
export function describePastePlan(plan: PastePlan): string {
  const uploads = plan?.uploads ?? [];
  const skipped = plan?.skipped ?? [];
  if (uploads.length === 0 && skipped.length === 0) return "Nothing to paste";

  const parts: string[] = [];
  if (uploads.length > 0) {
    parts.push(`${uploads.length} ${uploads.length === 1 ? "image" : "images"} ready`);
  }
  if (skipped.length > 0) {
    const reasons: string[] = [];
    for (const entry of skipped) {
      const reason = entry?.reason ?? "rejected";
      if (!reasons.includes(reason)) reasons.push(reason);
    }
    parts.push(`${skipped.length} skipped (${reasons.join(", ")})`);
  }
  return parts.join("; ");
}
