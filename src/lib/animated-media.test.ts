import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCALE_MAX,
  DEFAULT_SCALE_MIN,
  GIF_INFINITE_LOOP,
  GIF_MIME,
  REDUCED_MOTION_QUERY,
  STANDARD_DEVICE_IDS,
  clampScale,
  describeDevice,
  deviceFrames,
  deviceOptionsFor,
  devicePreviewPlan,
  fitDevice,
  frameFor,
  isAnimatedGif,
  playbackPolicy,
  resolveDeviceId,
  type DeviceFrame,
  type DeviceId,
  type MediaSize,
} from "./animated-media";

/**
 * Animated GIF playback + device-preview engine
 * (FEATURE_MATRIX §15 "Animated GIF/devices": row :569).
 *
 * Written RED-first against a missing module, then implemented. Coverage pins:
 * - multi-frame detection from raw GIF bytes without a decoder (block walker
 *   that skips image data / sub-blocks, so a `0x2C` inside compressed pixels is
 *   never mistaken for an image descriptor),
 * - Netscape/ANIMEXTS loop-count handling (0 = infinite) and the `image/gif`
 *   MIME gate,
 * - `prefers-reduced-motion` playback policy (never autoplay under reduce),
 * - the `deviceFrames` registry + scaling, `clampScale` guard rails,
 * - `fitDevice` cover/contain/fill math with signed centering offsets,
 * - aspect-driven `deviceOptionsFor` suggestions and `describeDevice` labels.
 */

type GifSpec = {
  version?: "87a" | "89a";
  frames?: number;
  loop?: number;
  /** Per-frame data sub-block payload; defaults to a tiny valid block. */
  frameData?: number[][];
};

/** Build a structurally valid GIF byte stream for the header scanner. */
function buildGif(spec: GifSpec = {}): Uint8Array {
  const { version = "89a", frames = 1, loop, frameData } = spec;
  const bytes: number[] = [];
  const pushAscii = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) bytes.push(text.charCodeAt(i));
  };
  const pushU16 = (value: number): void => {
    bytes.push(value & 0xff, (value >> 8) & 0xff);
  };

  pushAscii(version === "87a" ? "GIF87a" : "GIF89a");
  // Logical Screen Descriptor: 1x1, no global color table.
  pushU16(1);
  pushU16(1);
  bytes.push(0x00, 0x00, 0x00);

  if (loop !== undefined) {
    bytes.push(0x21, 0xff, 0x0b);
    pushAscii("NETSCAPE2.0");
    bytes.push(0x03, 0x01, loop & 0xff, (loop >> 8) & 0xff, 0x00);
  }

  for (let frame = 0; frame < frames; frame += 1) {
    bytes.push(0x2c); // Image Descriptor introducer.
    pushU16(0);
    pushU16(0);
    pushU16(1);
    pushU16(1);
    bytes.push(0x00); // No local color table.
    bytes.push(0x02); // LZW minimum code size.
    const data = frameData?.[frame] ?? [0x00, 0x01];
    bytes.push(data.length & 0xff);
    for (const byte of data) bytes.push(byte);
    bytes.push(0x00); // Sub-block terminator.
  }
  bytes.push(0x3b); // Trailer.
  return Uint8Array.from(bytes);
}

describe("isAnimatedGif — multi-frame detection from raw bytes", () => {
  it("reports a single-frame GIF as static with one frame", () => {
    expect(isAnimatedGif(buildGif({ frames: 1 }))).toEqual({ animated: false, frames: 1 });
  });

  it("detects an animated GIF by counting image descriptors", () => {
    expect(isAnimatedGif(buildGif({ frames: 3 }))).toEqual({ animated: true, frames: 3 });
  });

  it("recognises the older GIF87a header", () => {
    expect(isAnimatedGif(buildGif({ version: "87a", frames: 2 }))).toEqual({
      animated: true,
      frames: 2,
    });
  });

  it("reads a finite loop count from the NETSCAPE2.0 extension", () => {
    expect(isAnimatedGif(buildGif({ frames: 4, loop: 5 }))).toEqual({
      animated: true,
      frames: 4,
      loops: 5,
    });
  });

  it("treats a zero loop count as the infinite sentinel", () => {
    expect(GIF_INFINITE_LOOP).toBe(0);
    expect(isAnimatedGif(buildGif({ frames: 2, loop: GIF_INFINITE_LOOP }))).toEqual({
      animated: true,
      frames: 2,
      loops: 0,
    });
  });

  it("reads a large 16-bit loop count", () => {
    expect(isAnimatedGif(buildGif({ frames: 2, loop: 65535 }))).toEqual({
      animated: true,
      frames: 2,
      loops: 65535,
    });
  });

  it("omits the loops field when no loop extension is present", () => {
    expect("loops" in isAnimatedGif(buildGif({ frames: 2 }))).toBe(false);
  });

  it("never miscounts a 0x2C byte that lives inside image data", () => {
    const bytes = buildGif({ frames: 1, frameData: [[0x2c, 0x2c, 0x2c, 0x2c]] });
    expect(isAnimatedGif(bytes)).toEqual({ animated: false, frames: 1 });
  });

  it("skips extension/trailer bytes embedded in a data sub-block", () => {
    const bytes = buildGif({ frames: 1, frameData: [[0x21, 0x3b, 0x00, 0x2c]] });
    expect(isAnimatedGif(bytes)).toEqual({ animated: false, frames: 1 });
  });

  it("accepts an ArrayBuffer as well as a Uint8Array", () => {
    const gif = buildGif({ frames: 2 });
    expect(isAnimatedGif(gif.buffer)).toEqual({ animated: true, frames: 2 });
  });

  it("gates on a declared image/gif MIME type", () => {
    expect(GIF_MIME).toBe("image/gif");
    const bytes = buildGif({ frames: 2 });
    expect(isAnimatedGif(bytes, { mimeType: "image/gif" })).toEqual({ animated: true, frames: 2 });
    expect(isAnimatedGif(bytes, { mimeType: "image/gif; charset=binary" })).toEqual({
      animated: true,
      frames: 2,
    });
  });

  it("refuses to look at a non-GIF declared MIME type", () => {
    expect(isAnimatedGif(buildGif({ frames: 2 }), { mimeType: "image/png" })).toEqual({
      animated: false,
    });
  });

  it("fails closed on a wrong magic number", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isAnimatedGif(png)).toEqual({ animated: false });
  });

  it("fails closed on an empty or truncated header", () => {
    expect(isAnimatedGif(new Uint8Array(0))).toEqual({ animated: false });
    expect(isAnimatedGif(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toEqual({
      animated: false,
    });
  });

  it("does not mutate the bytes it inspects", () => {
    const bytes = buildGif({ frames: 2 });
    const before = Array.from(bytes);
    isAnimatedGif(bytes);
    expect(Array.from(bytes)).toEqual(before);
  });
});

describe("playbackPolicy — prefers-reduced-motion aware", () => {
  it("exposes the reduced-motion media query", () => {
    expect(REDUCED_MOTION_QUERY).toBe("(prefers-reduced-motion: reduce)");
  });

  it("is inert for a static image", () => {
    expect(playbackPolicy({ animated: false })).toEqual({
      autoplay: false,
      showPlayControl: false,
      staticFallback: false,
    });
  });

  it("stays inert for a static image even with autoplay + reduce", () => {
    expect(playbackPolicy({ animated: false, autoplay: true, reducedMotion: true })).toEqual({
      autoplay: false,
      showPlayControl: false,
      staticFallback: false,
    });
  });

  it("defaults an animated GIF to click-to-play", () => {
    expect(playbackPolicy({ animated: true })).toEqual({
      autoplay: false,
      showPlayControl: true,
      staticFallback: false,
    });
  });

  it("autoplays only when both requested and motion is allowed", () => {
    expect(playbackPolicy({ animated: true, autoplay: true })).toEqual({
      autoplay: true,
      showPlayControl: true,
      staticFallback: false,
    });
  });

  it("never autoplays under prefers-reduced-motion and falls back to a static frame", () => {
    expect(playbackPolicy({ animated: true, autoplay: true, reducedMotion: true })).toEqual({
      autoplay: false,
      showPlayControl: true,
      staticFallback: true,
    });
    expect(playbackPolicy({ animated: true, reducedMotion: true })).toEqual({
      autoplay: false,
      showPlayControl: true,
      staticFallback: true,
    });
  });
});

describe("deviceFrames — the preview registry", () => {
  it("registers all five device ids", () => {
    expect(Object.keys(deviceFrames).sort()).toEqual(
      ["custom", "desktop", "phone", "tablet", "watch"].sort(),
    );
  });

  it("keeps custom out of the standard suggestion order", () => {
    expect(STANDARD_DEVICE_IDS).toEqual(["desktop", "tablet", "phone", "watch"]);
  });

  it("gives every frame a label, positive dimensions and a non-negative radius", () => {
    for (const id of Object.keys(deviceFrames) as DeviceId[]) {
      const frame = deviceFrames[id];
      expect(frame.id).toBe(id);
      expect(frame.label.length).toBeGreaterThan(0);
      expect(frame.width).toBeGreaterThan(0);
      expect(frame.height).toBeGreaterThan(0);
      expect(frame.radius).toBeGreaterThanOrEqual(0);
    }
  });

  it("models the phone with a top notch", () => {
    expect(deviceFrames.phone).toEqual({
      id: "phone",
      label: "Phone",
      width: 390,
      height: 844,
      radius: 40,
      notches: [{ side: "top", width: 130, height: 30 }],
    });
  });

  it("gives the custom frame neutral defaults without a notch", () => {
    expect(deviceFrames.custom).toEqual({
      id: "custom",
      label: "Custom",
      width: 800,
      height: 600,
      radius: 8,
    });
  });
});

describe("frameFor — resolve + scale a device frame", () => {
  it("resolves a frame by id (deep equal, not the same reference)", () => {
    expect(frameFor("phone")).toEqual(deviceFrames.phone);
    expect(frameFor("phone")).not.toBe(deviceFrames.phone);
  });

  it("scales width, height, radius and notch geometry", () => {
    expect(frameFor("desktop", { scale: 2 })).toEqual({
      id: "desktop",
      label: "Desktop",
      width: 2880,
      height: 1800,
      radius: 24,
    });
    expect(frameFor("phone", { scale: 0.5 })).toEqual({
      id: "phone",
      label: "Phone",
      width: 195,
      height: 422,
      radius: 20,
      notches: [{ side: "top", width: 65, height: 15 }],
    });
  });

  it("rounds fractional scaled pixels", () => {
    expect(frameFor("tablet", { scale: 1.25 }).width).toBe(1043);
  });

  it("treats a missing, zero, negative or non-finite scale as identity", () => {
    expect(frameFor("watch")).toEqual(deviceFrames.watch);
    expect(frameFor("watch", { scale: 0 })).toEqual(deviceFrames.watch);
    expect(frameFor("watch", { scale: -2 })).toEqual(deviceFrames.watch);
    expect(frameFor("watch", { scale: Number.NaN })).toEqual(deviceFrames.watch);
  });

  it("falls back to the custom frame for an unknown id", () => {
    expect(frameFor("tv" as DeviceId)).toEqual(deviceFrames.custom);
  });

  it("accepts an explicit frame object and does not mutate it", () => {
    const custom: DeviceFrame = {
      id: "custom",
      label: "Laptop",
      width: 1280,
      height: 720,
      radius: 10,
    };
    const frozen = Object.freeze(custom);
    expect(frameFor(frozen, { scale: 2 })).toEqual({
      id: "custom",
      label: "Laptop",
      width: 2560,
      height: 1440,
      radius: 20,
    });
    expect(custom.width).toBe(1280);
  });
});

describe("fitDevice — cover / contain / fill geometry", () => {
  const wide: MediaSize = { width: 1200, height: 800 };
  const tall: MediaSize = { width: 800, height: 1200 };
  const square: MediaSize = { width: 400, height: 400 };

  it("letterboxes a wide image under contain", () => {
    expect(fitDevice(wide, square, { mode: "contain" })).toEqual({
      width: 400,
      height: 267,
      scale: 400 / 1200,
      offset: { x: 0, y: 67 },
    });
  });

  it("pillarboxes a tall image under contain", () => {
    expect(fitDevice(tall, square, { mode: "contain" })).toEqual({
      width: 267,
      height: 400,
      scale: 400 / 1200,
      offset: { x: 67, y: 0 },
    });
  });

  it("overflows and crops a wide image under cover", () => {
    expect(fitDevice(wide, square, { mode: "cover" })).toEqual({
      width: 600,
      height: 400,
      scale: 0.5,
      offset: { x: -100, y: 0 },
    });
  });

  it("overflows and crops a tall image under cover", () => {
    expect(fitDevice(tall, square, { mode: "cover" })).toEqual({
      width: 400,
      height: 600,
      scale: 0.5,
      offset: { x: 0, y: -100 },
    });
  });

  it("stretches to the frame exactly under fill (no uniform scale)", () => {
    expect(fitDevice(wide, { width: 300, height: 500 }, { mode: "fill" })).toEqual({
      width: 300,
      height: 500,
      scale: 1,
      offset: { x: 0, y: 0 },
    });
  });

  it("defaults to contain when no mode is given", () => {
    expect(fitDevice(wide, square)).toEqual(fitDevice(wide, square, { mode: "contain" }));
  });

  it("fails to a zero result on degenerate image or frame geometry", () => {
    const zero = { width: 0, height: 0, scale: 0, offset: { x: 0, y: 0 } };
    expect(fitDevice({ width: 0, height: 100 }, square, { mode: "cover" })).toEqual(zero);
    expect(fitDevice(wide, { width: 400, height: 0 }, { mode: "cover" })).toEqual(zero);
    expect(fitDevice({ width: Number.NaN, height: 100 }, square, { mode: "fill" })).toEqual(zero);
  });
});

describe("clampScale — guard rails for a preview zoom", () => {
  it("leaves a scale already in range untouched", () => {
    expect(clampScale(1.5, { min: 1, max: 2 })).toBe(1.5);
  });

  it("raises a scale below the minimum and lowers one above the maximum", () => {
    expect(clampScale(0.1, { min: 0.5, max: 2 })).toBe(0.5);
    expect(clampScale(5, { min: 0.5, max: 2 })).toBe(2);
  });

  it("falls back to the default range when bounds are missing or unusable", () => {
    expect(DEFAULT_SCALE_MIN).toBeLessThan(DEFAULT_SCALE_MAX);
    expect(clampScale(0.0001)).toBe(DEFAULT_SCALE_MIN);
    expect(clampScale(1000)).toBe(DEFAULT_SCALE_MAX);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(1, { min: Number.NaN, max: -3 })).toBe(1);
  });

  it("fails a non-finite scale to the (normalised) minimum", () => {
    expect(clampScale(Number.NaN, { min: 0.5, max: 3 })).toBe(0.5);
    expect(clampScale(Number.POSITIVE_INFINITY, { min: 0.5, max: 3 })).toBe(3);
  });

  it("normalises an inverted range instead of returning NaN", () => {
    expect(clampScale(1, { min: 5, max: 2 })).toBe(2);
    expect(clampScale(9, { min: 5, max: 2 })).toBe(5);
  });
});

describe("deviceOptionsFor — suggest frames by natural aspect", () => {
  it("suggests the phone first for a tall image aspect", () => {
    expect(deviceOptionsFor(390 / 844)[0]?.id).toBe("phone");
  });

  it("suggests the desktop first for a landscape image aspect", () => {
    expect(deviceOptionsFor(1440 / 900)[0]?.id).toBe("desktop");
  });

  it("ranks every standard frame and excludes the custom template", () => {
    const ids = deviceOptionsFor(1).map((frame) => frame.id);
    expect([...ids].sort()).toEqual([...STANDARD_DEVICE_IDS].sort());
    expect(ids).not.toContain("custom");
  });

  it("accepts an explicit { width, height } size as well as a ratio", () => {
    expect(deviceOptionsFor({ width: 390, height: 844 })[0]?.id).toBe("phone");
    expect(deviceOptionsFor({ width: 1440, height: 900 })[0]?.id).toBe("desktop");
  });

  it("returns the canonical order for an unusable aspect", () => {
    expect(deviceOptionsFor(Number.NaN).map((frame) => frame.id)).toEqual([...STANDARD_DEVICE_IDS]);
    expect(deviceOptionsFor(-1).map((frame) => frame.id)).toEqual([...STANDARD_DEVICE_IDS]);
    expect(deviceOptionsFor({ width: 0, height: 100 }).map((frame) => frame.id)).toEqual([
      ...STANDARD_DEVICE_IDS,
    ]);
  });
});

describe("describeDevice — one-line frame summary", () => {
  it("describes the phone with its radius and notch", () => {
    expect(describeDevice(deviceFrames.phone)).toBe("Phone (390x844, radius 40, notched)");
  });

  it("describes a plain frame without radius or notch noise", () => {
    expect(
      describeDevice({ id: "custom", label: "Bare", width: 100, height: 200, radius: 0 }),
    ).toBe("Bare (100x200)");
  });

  it("describes the desktop and watch frames", () => {
    expect(describeDevice(deviceFrames.desktop)).toBe("Desktop (1440x900, radius 12)");
    expect(describeDevice(deviceFrames.watch)).toBe("Watch (198x242, radius 44)");
  });
});

describe("resolveDeviceId / devicePreviewPlan — render-time guard rails", () => {
  it("accepts known ids case-insensitively and rejects malformed ones", () => {
    expect(resolveDeviceId(" phone ")).toBe("phone");
    expect(resolveDeviceId("WATCH")).toBe("watch");
    expect(resolveDeviceId("toaster")).toBeNull();
    expect(resolveDeviceId(42)).toBeNull();
    expect(resolveDeviceId(null)).toBeNull();
  });

  it("builds a capped frame with a fit result", () => {
    const plan = devicePreviewPlan({
      device: "phone",
      image: { width: 390, height: 844 },
      fit: "contain",
    });
    expect(plan).not.toBeNull();
    expect(plan?.frame).toMatchObject({ id: "phone", width: 390, height: 844 });
    expect(plan?.fit).toMatchObject({ width: 390, height: 844, scale: 1 });
    expect(plan?.style).toEqual({
      maxWidth: "390px",
      aspectRatio: "390 / 844",
      borderRadius: "40px",
    });
  });

  it("caps a wide frame to the reading column but keeps its aspect", () => {
    const plan = devicePreviewPlan({ device: "desktop" });
    expect(plan?.style.maxWidth).toBe("720px");
    expect(plan?.style.aspectRatio).toBe("1440 / 900");
  });

  it("clamps zoom and ignores non-positive/invalid scales", () => {
    expect(devicePreviewPlan({ device: "phone", scale: 0.01 })?.frame.width).toBe(98);
    expect(devicePreviewPlan({ device: "phone", scale: 10 })?.frame.width).toBe(1560);
    expect(devicePreviewPlan({ device: "phone", scale: 0 })?.frame.width).toBe(390);
    expect(devicePreviewPlan({ device: "phone", scale: Number.NaN })?.frame.width).toBe(390);
  });

  it("returns null for an unknown device so callers can unwrap their content", () => {
    expect(devicePreviewPlan({ device: "toaster" })).toBeNull();
    expect(devicePreviewPlan({ device: null })).toBeNull();
  });
});
