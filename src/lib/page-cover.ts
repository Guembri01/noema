/**
 * Page cover model — the banner at the top of a page
 * (docs/MISSING_FEATURES.md §1 "Editor & blocks", row "Page cover":
 * "Banner image on a page.").
 *
 * A stored `coverUrl` string cannot say whether it holds an uploaded image, a
 * gradient preset or an Unsplash photo, so this module makes the cover a small
 * tagged value:
 *
 * ```
 * { type: "image",    url }          — an uploaded/external raster image
 * { type: "gradient", gradientId }   — one of the {@link GRADIENTS} presets
 * { type: "unsplash", url }          — an Unsplash photo (allow-listed host)
 * ```
 *
 * Everything here is pure and dependency-free. Parsing/validation never throws:
 * garbage fails closed with a reason, and CSS emission returns `""` rather than
 * ever interpolating an unvalidated string (no CSS injection). Callers keep
 * their own objects — no helper mutates its input.
 */

/** The three ways a page can be covered. */
export const COVER_TYPES = ["image", "gradient", "unsplash"] as const;

export type CoverType = (typeof COVER_TYPES)[number];

/**
 * Gradient preset catalog: stable id → CSS `background-image` value. The ids are
 * the persisted token (CSS is derived, never stored), so re-styling a preset
 * restyles every page that picked it.
 */
export const GRADIENTS = {
  ocean: "linear-gradient(120deg, #89f7fe 0%, #66a6ff 100%)",
  sunset: "linear-gradient(120deg, #f6d365 0%, #fda085 100%)",
  sky: "linear-gradient(120deg, #a1c4fd 0%, #c2e9fb 100%)",
  lime: "linear-gradient(120deg, #d4fc79 0%, #96e6a1 100%)",
  candy: "linear-gradient(120deg, #fbc2eb 0%, #a6c1ee 100%)",
  blush: "linear-gradient(120deg, #fda4af 0%, #fecdd3 100%)",
  mint: "linear-gradient(120deg, #c1dfc4 0%, #deecdd 100%)",
  lavender: "linear-gradient(120deg, #e0c3fc 0%, #8ec5fc 100%)",
} as const;

export type GradientId = keyof typeof GRADIENTS;

/** Preset used when a cover is switched to `gradient` without naming one. */
export const DEFAULT_COVER_GRADIENT_ID: GradientId = "ocean";

/** Unsplash image CDNs the `unsplash` type is allowed to point at. */
export const ALLOWED_UNSPLASH_HOSTS: readonly string[] = ["images.unsplash.com", "plus.unsplash.com"];

/** A page cover as persisted/held in state. Only `type` is mandatory; the
 * relevant payload field (`url` for image/unsplash, `gradientId` for gradient)
 * is required by {@link validateCover}. */
export interface CoverValue {
  type: CoverType;
  url?: string;
  gradientId?: string;
}

/** Outcome of {@link validateCover}; `errors` are stable machine tokens. */
export interface CoverValidation {
  valid: boolean;
  errors: string[];
}

/** A cover that validates produces a background-image; a bad one is `""`. */
function isGradientId(value: unknown): value is GradientId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GRADIENTS, value);
}

/**
 * Normalise a candidate URL to a safe `http(s)` href, or `null`. Uses the URL
 * parser so a hostile value is percent-encoded rather than reaching CSS; a
 * non-http(s) scheme (`javascript:`, `data:`, …) and relative paths are
 * rejected.
 */
function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

/** Hostname of a candidate URL, or `null` when it cannot be parsed. */
function hostnameOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    return new URL(raw.trim()).hostname;
  } catch {
    return null;
  }
}

/**
 * Validate an untrusted cover value, failing closed with reasons. Rules:
 * - `image` requires an `http(s)` URL,
 * - `gradient` requires a {@link GRADIENTS} id,
 * - `unsplash` requires an `http(s)` URL on an {@link ALLOWED_UNSPLASH_HOSTS}
 *   host.
 *
 * Never throws; `null`, non-objects and unknown types are all invalid.
 */
export function validateCover(value: unknown): CoverValidation {
  if (value === null || typeof value !== "object") {
    return { valid: false, errors: ["missing-cover"] };
  }
  const type = (value as { type?: unknown }).type;
  if (type !== "image" && type !== "gradient" && type !== "unsplash") {
    return { valid: false, errors: ["unknown-type"] };
  }

  if (type === "gradient") {
    const gradientId = (value as { gradientId?: unknown }).gradientId;
    if (gradientId === undefined || gradientId === null || gradientId === "") {
      return { valid: false, errors: ["missing-gradient"] };
    }
    if (!isGradientId(gradientId)) {
      return { valid: false, errors: ["unknown-gradient"] };
    }
    return { valid: true, errors: [] };
  }

  const rawUrl = (value as { url?: unknown }).url;
  if (rawUrl === undefined || rawUrl === null || rawUrl === "") {
    return { valid: false, errors: ["missing-url"] };
  }
  if (safeHttpUrl(rawUrl) === null) {
    return { valid: false, errors: ["invalid-url"] };
  }
  if (type === "unsplash") {
    const host = hostnameOf(rawUrl);
    if (host === null || !ALLOWED_UNSPLASH_HOSTS.includes(host)) {
      return { valid: false, errors: ["host-not-allowed"] };
    }
  }
  return { valid: true, errors: [] };
}

/**
 * CSS `background-image` value for a cover — a gradient preset or a
 * `url("…")` for an image. Invalid/empty covers emit `""` so a bad stored value
 * can never inject CSS or paint a broken banner. Position/size are separate
 * (`cover-position.ts` supplies the focal point).
 */
export function coverCss(value: CoverValue | null | undefined): string {
  const result = validateCover(value);
  if (!result.valid) return "";
  const cover = value as CoverValue;
  if (cover.type === "gradient") {
    return GRADIENTS[cover.gradientId as GradientId];
  }
  const href = safeHttpUrl(cover.url);
  return href === null ? "" : `url("${href}")`;
}

/**
 * A renderable URL for a cover, or `null` when there is none (gradients and
 * empty covers). `image` passes through unchanged; an `unsplash` URL gains the
 * CDN transform params (`w`, `q`, `auto=format`, `fit=crop`) so the banner
 * downloads at display size. A non-finite/non-positive `width` is ignored
 * rather than emitted as a broken query.
 */
export function resolveCoverUrl(
  value: CoverValue | null | undefined,
  options: { width?: number } = {},
): string | null {
  const result = validateCover(value);
  if (!result.valid) return null;
  const cover = value as CoverValue;
  const href = safeHttpUrl(cover.url);
  if (href === null) return null;
  if (cover.type !== "unsplash") return href;

  const width = options.width;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return href;

  const url = new URL(href);
  url.searchParams.set("w", String(Math.round(width)));
  url.searchParams.set("q", "80");
  url.searchParams.set("auto", "format");
  url.searchParams.set("fit", "crop");
  return url.href;
}

/**
 * True when a cover would render nothing — absent, unknown, or missing its
 * payload. The editor uses this to decide between "Add cover" and "Remove
 * cover".
 */
export function isCoverEmpty(value: CoverValue | null | undefined): boolean {
  return coverCss(value) === "";
}
