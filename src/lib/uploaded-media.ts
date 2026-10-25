/**
 * Uploaded-media render decisions.
 *
 * The upload pipeline stores the bytes it receives unchanged (no thumbnailing,
 * no re-encode), so the only way a GIF loses its animation is if the document
 * points at a derived/lossy URL or renders it through a still-image path. This
 * module is the single decision seam between an upload result and the media
 * node:
 *
 *  - MIME resolution: the asset's declared type, else the stored URL's
 *    extension, else the original file name.
 *  - The media kind (`image`/`video`/`audio`/`file`) that the shared image
 *    block renders.
 *  - Whether the result is an animated GIF candidate (and therefore needs the
 *    byte-sniffed `animatedImage` node).
 *  - The source URL. For GIFs, transform query params (`w`, `h`, `fit`,
 *    `format`, `q`) are stripped: a CDN that honours them may return a single
 *    frame or a lossy WebP, and the document must keep pointing at the original
 *    animated bytes.
 *
 * Pure and DOM-free so the editor, the read-only renderer and the unit tests
 * agree on one rule.
 */

import { GIF_MIME } from "@/lib/animated-media";
import { fileNameExt, mimeForExt } from "@/lib/file-type";
import { stripTransform } from "@/lib/image-transform";

/** The elements the shared media node can render. */
export type MediaKind = "image" | "video" | "audio" | "file";

/** The fields of an upload response / stored asset this module reads. */
export type UploadedAssetLike = {
  url: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
};

/** MIME aliases the browser/asset store may report. */
const MIME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "image/jpg": "image/jpeg",
});

/** Types that carry no information, so the URL/filename extension decides. */
const GENERIC_MIME_TYPES: ReadonlySet<string> = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

const EXPLICIT_KINDS: ReadonlySet<string> = new Set(["image", "video", "audio", "file"]);

function normalizeMime(value: unknown): string {
  const lower = (typeof value === "string" ? value : "").split(";", 1)[0].trim().toLowerCase();
  return MIME_ALIASES[lower] ?? lower;
}

/** The lower-case path extension of a URL or file name, without query/hash. */
function extensionOf(nameOrUrl: string): string {
  return fileNameExt((nameOrUrl ?? "").split(/[?#]/)[0]);
}

/**
 * Resolve the MIME type of an uploaded asset. The asset's own type wins when it
 * is specific; the URL extension (the upload route always stores one) and then
 * the original file name fill the generic/blank case.
 */
export function resolveUploadedMime(asset: UploadedAssetLike): string {
  const declared = normalizeMime(asset?.mimeType);
  if (!GENERIC_MIME_TYPES.has(declared)) return declared;
  const fromUrl = mimeForExt(extensionOf(asset?.url ?? ""));
  if (fromUrl !== "application/octet-stream") return fromUrl;
  const fromName = mimeForExt(extensionOf(asset?.name ?? ""));
  return fromName !== "application/octet-stream" ? fromName : declared || "application/octet-stream";
}

/**
 * Render kind for a media source. An explicit `mediaType` on a stored node wins;
 * otherwise the MIME type (or URL extension) decides. Unknown sources render as
 * images, preserving the original upload/setImage behaviour.
 */
export function mediaKindOfSource(src: string, explicit?: unknown): MediaKind {
  if (typeof explicit === "string" && EXPLICIT_KINDS.has(explicit)) {
    return explicit as MediaKind;
  }
  return mediaKindForMime(resolveUploadedMime({ url: src }));
}

/** Map a MIME type to the element the media block renders. */
export function mediaKindForMime(mime: string): MediaKind {
  const normalized = normalizeMime(mime);
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  return "file";
}

/** Which node the editor should insert, and the source it must keep. */
export type UploadRenderPlan = {
  /** `animatedImage` for a GIF, `image` for a still picture, `media` otherwise. */
  type: "animatedImage" | "image" | "media";
  /** Original, animation-preserving source URL. */
  src: string;
  mimeType: string;
  mediaType: MediaKind;
  /** `true` for GIFs: the caller should sniff bytes before deciding playback. */
  animatedCandidate: boolean;
  /** The upload bytes are referenced directly; no rendition URL is built. */
  preserveOriginal: true;
};

/**
 * Decide how an uploaded asset is inserted. A GIF becomes an `animatedImage`
 * candidate whose `src` has every lossy transform parameter removed; a still
 * image keeps the stock image node; every other type uses the media variants.
 */
export function planUploadedAssetRender(asset: UploadedAssetLike): UploadRenderPlan {
  const mimeType = resolveUploadedMime(asset);
  const mediaType = mediaKindForMime(mimeType);
  const animatedCandidate = mediaType === "image" && mimeType === GIF_MIME;
  // Dropping `w`/`h`/`format`/`q` from a GIF URL is what stops a transform CDN
  // (or a future rendition builder) from flattening the animation.
  const src = animatedCandidate ? stripTransform(asset?.url ?? "") : asset?.url ?? "";
  return {
    type: animatedCandidate ? "animatedImage" : mediaType === "image" ? "image" : "media",
    src,
    mimeType,
    mediaType,
    animatedCandidate,
    preserveOriginal: true,
  };
}
