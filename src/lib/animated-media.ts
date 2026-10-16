/**
 * Animated GIF playback + device-preview engine
 * (docs/FEATURE_MATRIX.md §15 "Animated GIF/devices": row :569).
 *
 * Two related preview concerns, both pure and decoder-free:
 *
 * 1. **"Is this GIF animated?"** An image block has to decide whether to render
 *    a moving picture, a static first frame, or a click-to-play poster. A GIF
 *    signals animation structurally: more than one *image descriptor* (`0x2C`)
 *    in the byte stream, optionally with a NETSCAPE/ANIMEXTS loop count.
 *    {@link isAnimatedGif} walks the block structure (header → logical screen
 *    descriptor → optional global color table → image/extension blocks →
 *    trailer) and *skips* compressed image data and generic sub-blocks, so a
 *    `0x2C` byte that is really a pixel value is never mistaken for a frame.
 *    No pixels are decoded — only the framing is read.
 * 2. **Device previews.** A "show on desktop/tablet/phone/watch" preview is just
 *    a named frame (`{ width, height, radius, notches? }`) plus fit math.
 *    {@link deviceFrames} is the registry, {@link frameFor} resolves/scales it,
 *    {@link fitDevice} reimplements `object-fit` geometry (with signed centering
 *    offsets), {@link clampScale} is the zoom guard rail, and
 *    {@link deviceOptionsFor} ranks frames by how well they match an image's
 *    natural aspect.
 *
 * Contract (same fail-safe rules as `image-dimensions.ts`):
 * - Every pixel result is an integer (`Math.round`); degenerate/non-finite
 *   geometry fails to a zero result rather than `NaN`.
 * - Motion is never forced: under `prefers-reduced-motion` an animated GIF is
 *   shown as a static frame with an explicit play control
 *   ({@link playbackPolicy}).
 * - Nothing mutates its inputs, and all registries are frozen.
 *
 * No DB, no DOM, no React, no decoder: a block component can wire these up and
 * nothing else.
 */

/** A width/height pair in whole device-independent pixels. */
export type MediaSize = { width: number; height: number };

const isPositive = (value: number): boolean => Number.isFinite(value) && value > 0;

const round = (value: number): number => Math.round(value);

/* -------------------------------------------------------------------------- */
/* Animated GIF detection                                                      */
/* -------------------------------------------------------------------------- */

/** The GIF MIME type, the only value {@link isAnimatedGif} treats as a frame. */
export const GIF_MIME = "image/gif";

/** A NETSCAPE/ANIMEXTS loop count of `0` means "loop forever". */
export const GIF_INFINITE_LOOP = 0;

/** The animation shape read from a GIF byte stream. */
export type GifAnimationInfo = {
  /** `true` when the stream declares more than one image descriptor. */
  animated: boolean;
  /** Image descriptors found (present whenever the header parsed). */
  frames?: number;
  /** Declared loop count: `0` loops forever ({@link GIF_INFINITE_LOOP}). */
  loops?: number;
};

/** Raw bytes or just the header to sniff. */
export type BytesLike = Uint8Array | ArrayBufferLike;

/** Options for {@link isAnimatedGif}. */
export type AnimatedGifOptions = {
  /** Declared MIME type; when it is set and is not `image/gif`, sniffing is skipped. */
  mimeType?: string;
};

/** GIF block introducers / terminators. */
const EXTENSION_INTRODUCER = 0x21;
const IMAGE_SEPARATOR = 0x2c;
const TRAILER = 0x3b;
const APPLICATION_EXTENSION = 0xff;

const asBytes = (input: BytesLike): Uint8Array =>
  input instanceof Uint8Array ? input : new Uint8Array(input);

/** True when `text` matches the ASCII bytes of `bytes` at `offset`. */
function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Walk a GIF's sub-block chain from `pos`, returning the index just past its
 * `0x00` terminator (or the end of the buffer when truncated). Compressed image
 * data and every extension body share this shape, which is why the frame
 * scanner can skip them without decoding.
 */
function skipSubBlocks(bytes: Uint8Array, pos: number): number {
  let cursor = pos;
  while (cursor < bytes.length) {
    const size = bytes[cursor];
    if (size === 0) return cursor + 1;
    cursor += 1 + size;
  }
  return cursor;
}

/** Read the NETSCAPE/ANIMEXTS loop count, if this is one; returns the end offset either way. */
function readApplicationExtension(
  bytes: Uint8Array,
  pos: number,
): { end: number; loop?: number } {
  if (pos >= bytes.length) return { end: pos };
  const blockSize = bytes[pos];
  if (blockSize < 11 || pos + 1 + blockSize > bytes.length) {
    return { end: skipSubBlocks(bytes, pos) };
  }

  const idStart = pos + 1;
  const isLoopExtension =
    matchesAscii(bytes, idStart, "NETSCAPE") || matchesAscii(bytes, idStart, "ANIMEXTS");
  let cursor = idStart + blockSize;
  if (!isLoopExtension) return { end: skipSubBlocks(bytes, cursor) };

  let loop: number | undefined;
  while (cursor < bytes.length) {
    const size = bytes[cursor];
    if (size === 0) {
      cursor += 1;
      break;
    }
    // The loop payload is a 3-byte sub-block: [0x01, lowByte, highByte].
    if (size >= 3 && bytes[cursor + 1] === 0x01) {
      loop = bytes[cursor + 2] | (bytes[cursor + 3] << 8);
    }
    cursor += 1 + size;
  }
  return loop === undefined ? { end: cursor } : { end: cursor, loop };
}

/**
 * Detect whether `bytesOrHeader` is an animated GIF by reading its block
 * structure — no pixel decoder. Returns `{ animated, frames }` for any valid
 * GIF header, plus `loops` when a NETSCAPE/ANIMEXTS loop extension is present.
 *
 * `animated` is true only when more than one image descriptor exists. Wrong
 * magic, a truncated header and a declared non-GIF `mimeType` all fail closed
 * to `{ animated: false }`.
 */
export function isAnimatedGif(
  bytesOrHeader: BytesLike,
  options: AnimatedGifOptions = {},
): GifAnimationInfo {
  const declared = options.mimeType?.split(";")[0]?.trim().toLowerCase();
  if (declared !== undefined && declared !== "" && declared !== GIF_MIME) {
    return { animated: false };
  }

  const bytes = asBytes(bytesOrHeader);
  // "GIF87a" / "GIF89a": G I F 8, then 7 or 9, then a.
  const validMagic =
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61;
  if (!validMagic) return { animated: false };
  // Need the full logical screen descriptor (header + 7 bytes) to seek to block 0.
  if (bytes.length < 13) return { animated: false };

  const screenPacked = bytes[10];
  const hasGlobalColorTable = (screenPacked & 0x80) !== 0;
  const globalColorTableSize = hasGlobalColorTable ? 3 * (1 << ((screenPacked & 0x07) + 1)) : 0;
  let pos = 13 + globalColorTableSize;

  let frames = 0;
  let loops: number | undefined;

  while (pos < bytes.length) {
    const marker = bytes[pos];
    if (marker === TRAILER) break;

    if (marker === IMAGE_SEPARATOR) {
      frames += 1;
      if (pos + 10 > bytes.length) break;
      const imagePacked = bytes[pos + 9];
      pos += 10;
      if ((imagePacked & 0x80) !== 0) {
        pos += 3 * (1 << ((imagePacked & 0x07) + 1));
      }
      if (pos >= bytes.length) break;
      pos += 1; // LZW minimum code size.
      pos = skipSubBlocks(bytes, pos);
      continue;
    }

    if (marker === EXTENSION_INTRODUCER) {
      if (pos + 2 > bytes.length) break;
      const label = bytes[pos + 1];
      pos += 2;
      if (label === APPLICATION_EXTENSION) {
        const app = readApplicationExtension(bytes, pos);
        if (app.loop !== undefined && loops === undefined) loops = app.loop;
        pos = app.end;
      } else {
        pos = skipSubBlocks(bytes, pos);
      }
      continue;
    }

    // Unknown marker: the stream is not a structure we can trust.
    break;
  }

  return loops === undefined
    ? { animated: frames > 1, frames }
    : { animated: frames > 1, frames, loops };
}

/* -------------------------------------------------------------------------- */
/* Playback policy                                                             */
/* -------------------------------------------------------------------------- */

/** The media query an animated-media block watches to honour reduced motion. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** What the player knows about its environment and the caller's wishes. */
export type PlaybackPolicyInput = {
  /** Whether the media is really animated. */
  animated: boolean;
  /** `prefers-reduced-motion: reduce` is active. */
  reducedMotion?: boolean;
  /** The caller asked for autoplay. */
  autoplay?: boolean;
};

/** How an animated-media block should render. */
export type PlaybackPolicy = {
  /** Play without a user gesture. */
  autoplay: boolean;
  /** Show play/pause affordance. */
  showPlayControl: boolean;
  /** Render the first frame instead of the animation by default. */
  staticFallback: boolean;
};

/**
 * Decide playback from the media + environment. Under `prefers-reduced-motion`
 * autoplay is always refused and the block renders its static first frame, but
 * a play control stays available so the user can explicitly opt in. A static
 * image needs no controls at all.
 */
export function playbackPolicy({
  animated,
  reducedMotion = false,
  autoplay = false,
}: PlaybackPolicyInput): PlaybackPolicy {
  if (!animated) {
    return { autoplay: false, showPlayControl: false, staticFallback: false };
  }
  if (reducedMotion) {
    return { autoplay: false, showPlayControl: true, staticFallback: true };
  }
  return { autoplay, showPlayControl: true, staticFallback: false };
}

/* -------------------------------------------------------------------------- */
/* Device frame registry                                                       */
/* -------------------------------------------------------------------------- */

/** The five preview targets: four standard devices plus a user-defined frame. */
export type DeviceId = "desktop" | "tablet" | "phone" | "watch" | "custom";

/** A cutout in the frame bezel (e.g. a phone camera notch). */
export type DeviceNotch = {
  side: "top" | "bottom";
  width: number;
  height: number;
};

/** One preview frame: a viewport plus bezel geometry. */
export type DeviceFrame = {
  id: DeviceId;
  label: string;
  width: number;
  height: number;
  /** Corner radius in whole pixels; `0` for square corners. */
  radius: number;
  notches?: DeviceNotch[];
};

/** Standard frames, in the order they are suggested when aspect is unknown. */
export const STANDARD_DEVICE_IDS = ["desktop", "tablet", "phone", "watch"] as const;

const desktopFrame: DeviceFrame = { id: "desktop", label: "Desktop", width: 1440, height: 900, radius: 12 };
const tabletFrame: DeviceFrame = { id: "tablet", label: "Tablet", width: 834, height: 1112, radius: 24 };
const phoneFrame: DeviceFrame = {
  id: "phone",
  label: "Phone",
  width: 390,
  height: 844,
  radius: 40,
  notches: [{ side: "top", width: 130, height: 30 }],
};
const watchFrame: DeviceFrame = { id: "watch", label: "Watch", width: 198, height: 242, radius: 44 };
const customFrame: DeviceFrame = { id: "custom", label: "Custom", width: 800, height: 600, radius: 8 };

/**
 * The frozen device-frame registry, keyed by {@link DeviceId}. The outer record
 * is frozen and {@link frameFor} always hands back a copy, so callers can never
 * mutate the shared definitions.
 */
export const deviceFrames: Readonly<Record<DeviceId, DeviceFrame>> = Object.freeze({
  desktop: desktopFrame,
  tablet: tabletFrame,
  phone: phoneFrame,
  watch: watchFrame,
  custom: customFrame,
});

/** Resolve a frame by id (unknown ids fall back to `custom`) or pass one through. */
function resolveFrame(device: DeviceId | DeviceFrame): DeviceFrame {
  if (typeof device === "string") return deviceFrames[device] ?? deviceFrames.custom;
  return device;
}

/**
 * Resolve a device frame and scale its geometry. `scale` multiplies width,
 * height, radius and every notch dimension (rounded to whole pixels); a missing,
 * zero, negative or non-finite scale is ignored (identity). Always returns a
 * fresh frame, so a caller can never mutate the registry. Clamping the scale to
 * a safe range is {@link clampScale}'s job, not this one's.
 */
export function frameFor(
  device: DeviceId | DeviceFrame,
  options: { scale?: number } = {},
): DeviceFrame {
  const base = resolveFrame(device);
  const requested = options.scale;
  const scale = typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? requested
    : 1;

  const scaled: DeviceFrame = {
    id: base.id,
    label: base.label,
    width: round(base.width * scale),
    height: round(base.height * scale),
    radius: round(base.radius * scale),
  };
  if (base.notches) {
    scaled.notches = base.notches.map((notch) => ({
      side: notch.side,
      width: round(notch.width * scale),
      height: round(notch.height * scale),
    }));
  }
  return scaled;
}

/* -------------------------------------------------------------------------- */
/* Fit geometry                                                                */
/* -------------------------------------------------------------------------- */

/** How a preview image fills its frame (CSS `object-fit` vocabulary). */
export type FitMode = "cover" | "contain" | "fill";

/** The resolved placement of an image inside a frame. */
export type FitResult = {
  /** Rendered width, in whole pixels. */
  width: number;
  /** Rendered height, in whole pixels. */
  height: number;
  /** Uniform scale applied for cover/contain; `1` for fill (no uniform scale). */
  scale: number;
  /** Centering offset; negative on an overflowing (cover) axis, `>= 0` otherwise. */
  offset: { x: number; y: number };
};

const ZERO_FIT: FitResult = { width: 0, height: 0, scale: 0, offset: { x: 0, y: 0 } };

/**
 * Place `image` inside `frame` using `object-fit` semantics:
 * - `contain` (default): scale so both axes fit, letterbox/pillarbox with a
 *   non-negative centering offset;
 * - `cover`: scale so both axes are filled, overflow cropped with a
 *   non-positive centering offset;
 * - `fill`: stretch to the frame exactly (aspect ratio ignored), `scale: 1`,
 *   zero offset.
 *
 * Degenerate (zero/non-finite) image or frame geometry fails to a zero result.
 */
export function fitDevice(
  image: MediaSize,
  frame: MediaSize,
  options: { mode?: FitMode } = {},
): FitResult {
  if (!isPositive(image.width) || !isPositive(image.height)) return { ...ZERO_FIT, offset: { x: 0, y: 0 } };
  if (!isPositive(frame.width) || !isPositive(frame.height)) return { ...ZERO_FIT, offset: { x: 0, y: 0 } };

  const mode = options.mode ?? "contain";
  if (mode === "fill") {
    return {
      width: round(frame.width),
      height: round(frame.height),
      scale: 1,
      offset: { x: 0, y: 0 },
    };
  }

  const ratios = [frame.width / image.width, frame.height / image.height];
  const scale = mode === "cover" ? Math.max(...ratios) : Math.min(...ratios);
  const width = round(image.width * scale);
  const height = round(image.height * scale);
  return {
    width,
    height,
    scale,
    offset: { x: round((frame.width - width) / 2), y: round((frame.height - height) / 2) },
  };
}

/* -------------------------------------------------------------------------- */
/* Scale clamp + suggestions + describe                                        */
/* -------------------------------------------------------------------------- */

/** Default lower zoom bound; a preview never shrinks past this. */
export const DEFAULT_SCALE_MIN = 0.25;
/** Default upper zoom bound; a preview never grows past this. */
export const DEFAULT_SCALE_MAX = 4;

/**
 * Clamp a preview scale into `[min, max]`. Missing or unusable bounds fall back
 * to {@link DEFAULT_SCALE_MIN}/{@link DEFAULT_SCALE_MAX}, an inverted range is
 * normalised (never `NaN`), and a non-finite scale fails to the (normalised)
 * minimum.
 */
export function clampScale(scale: number, bounds: { min?: number; max?: number } = {}): number {
  const requestedMin =
    typeof bounds.min === "number" && isPositive(bounds.min) ? bounds.min : DEFAULT_SCALE_MIN;
  const requestedMax =
    typeof bounds.max === "number" && isPositive(bounds.max) ? bounds.max : DEFAULT_SCALE_MAX;
  const lower = Math.min(requestedMin, requestedMax);
  const upper = Math.max(requestedMin, requestedMax);
  if (!Number.isFinite(scale)) return scale === Number.POSITIVE_INFINITY ? upper : lower;
  return Math.min(upper, Math.max(lower, scale));
}

/** Normalise the accepted `aspect` shapes (a ratio or an explicit size) to w/h. */
function aspectRatioOf(aspect: number | MediaSize): number {
  if (typeof aspect === "number") return aspect;
  if (isPositive(aspect.width) && isPositive(aspect.height)) return aspect.width / aspect.height;
  return Number.NaN;
}

/**
 * Rank the standard device frames by how closely their aspect ratio matches the
 * image's natural aspect (log-distance, so tall/wide are symmetric). An
 * unusable aspect returns the standard frames in their canonical order. The
 * `custom` template is always excluded — it has no fixed aspect to match.
 */
export function deviceOptionsFor(aspect: number | MediaSize): DeviceFrame[] {
  const target = aspectRatioOf(aspect);
  const frames = STANDARD_DEVICE_IDS.map((id) => deviceFrames[id]);
  if (!isPositive(target)) return frames;

  const distance = (frame: DeviceFrame): number =>
    Math.abs(Math.log(frame.width / frame.height) - Math.log(target));
  return [...frames].sort((a, b) => distance(a) - distance(b));
}

/**
 * One-line summary for menus/tooltips, e.g.
 * `"Phone (390x844, radius 40, notched)"`. The radius clause is omitted for
 * square frames and the notch clause for notch-less frames.
 */
export function describeDevice(frame: DeviceFrame): string {
  let summary = `${frame.label} (${frame.width}x${frame.height}`;
  if (frame.radius > 0) summary += `, radius ${frame.radius}`;
  if (frame.notches && frame.notches.length > 0) summary += ", notched";
  return `${summary})`;
}
