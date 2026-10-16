import { describe, expect, it } from "vitest";
import {
  looksAnimatedByExtension,
  prefersReducedMotion,
  resolveAnimatedMediaAttrs,
} from "./animated-image";

/*
 * The engine→renderer seam for the animated-media block: raw upload bytes →
 * `animated-media.ts` (`isAnimatedGif` / `playbackPolicy`) → the node's persisted
 * playback attributes. `prefers-reduced-motion` must always refuse autoplay and
 * fall back to the static frame with an explicit play control.
 */

/** A minimal, structurally valid GIF89a with `frames` image descriptors. */
function gifBytes(frames: number): Uint8Array {
  const bytes: number[] = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // logical screen descriptor
  ];
  for (let i = 0; i < frames; i += 1) {
    bytes.push(0x2c, 0, 0, 0, 0, 0, 1, 0, 1, 0x00, 0x02, 0x00);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("resolveAnimatedMediaAttrs (isAnimatedGif + playbackPolicy)", () => {
  it("detects an animated GIF and autoplays when motion is allowed", () => {
    const { attrs, animated, policy } = resolveAnimatedMediaAttrs({
      src: "https://cdn.test/loop.gif",
      alt: "loop",
      mimeType: "image/gif",
      bytes: gifBytes(3),
      autoplay: true,
      reducedMotion: false,
    });
    expect(animated).toBe(true);
    expect(policy).toEqual({ autoplay: true, showPlayControl: true, staticFallback: false });
    expect(attrs).toMatchObject({
      src: "https://cdn.test/loop.gif",
      alt: "loop",
      mediaType: "image",
      animated: true,
      autoplay: true,
      showPlayControl: true,
      staticFallback: false,
    });
  });

  it("honours prefers-reduced-motion: no autoplay, static fallback, play control stays", () => {
    const { attrs, policy } = resolveAnimatedMediaAttrs({
      src: "https://cdn.test/loop.gif",
      mimeType: "image/gif",
      bytes: gifBytes(2),
      autoplay: true,
      reducedMotion: true,
    });
    expect(policy).toEqual({ autoplay: false, showPlayControl: true, staticFallback: true });
    expect(attrs).toMatchObject({ animated: true, autoplay: false, staticFallback: true });
  });

  it("treats a single-frame GIF as static (no controls)", () => {
    const { attrs, policy } = resolveAnimatedMediaAttrs({
      src: "https://cdn.test/still.gif",
      mimeType: "image/gif",
      bytes: gifBytes(1),
    });
    expect(policy).toEqual({ autoplay: false, showPlayControl: false, staticFallback: false });
    expect(attrs.animated).toBe(false);
  });

  it("fails closed on non-GIF bytes", () => {
    const { animated } = resolveAnimatedMediaAttrs({
      src: "https://cdn.test/pic.png",
      mimeType: "image/png",
      bytes: PNG,
    });
    expect(animated).toBe(false);
  });

  it("falls back to the MIME/extension signal before bytes are available", () => {
    expect(resolveAnimatedMediaAttrs({ src: "https://cdn.test/a.gif", mimeType: "image/gif" }).animated).toBe(
      true,
    );
    expect(resolveAnimatedMediaAttrs({ src: "https://cdn.test/a.gif?v=2" }).animated).toBe(true);
    expect(resolveAnimatedMediaAttrs({ src: "https://cdn.test/a.png" }).animated).toBe(false);
  });

  it("classifies a non-image media type for the shared renderer", () => {
    const { attrs } = resolveAnimatedMediaAttrs({ src: "https://cdn.test/doc.pdf" });
    expect(attrs.mediaType).toBe("file");
  });
});

describe("looksAnimatedByExtension / prefersReducedMotion", () => {
  it("recognises a .gif source, with or without a query string", () => {
    expect(looksAnimatedByExtension("a.gif")).toBe(true);
    expect(looksAnimatedByExtension("a.GIF?x=1")).toBe(true);
    expect(looksAnimatedByExtension("a.png")).toBe(false);
  });

  it("reports no reduced-motion preference without a DOM", () => {
    expect(prefersReducedMotion()).toBe(false);
  });
});
