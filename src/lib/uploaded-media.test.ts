import { describe, expect, it } from "vitest";
import {
  mediaKindForMime,
  mediaKindOfSource,
  planUploadedAssetRender,
  resolveUploadedMime,
} from "@/lib/uploaded-media";

/**
 * The upload→node decision. The upload route stores bytes unchanged, so this
 * pure seam is where the app promises two things: a GIF keeps its original
 * (untransformed) source and is routed to the animated-image node, and every
 * other upload maps to the correct media element from MIME or extension.
 */

describe("resolveUploadedMime", () => {
  it("keeps the declared MIME type", () => {
    expect(resolveUploadedMime({ url: "/api/files/ws/a.bin", mimeType: "image/gif" })).toBe(
      "image/gif",
    );
  });

  it("infers the type from the stored URL extension", () => {
    expect(resolveUploadedMime({ url: "/api/files/ws/token.gif" })).toBe("image/gif");
    expect(resolveUploadedMime({ url: "/api/files/ws/token.webp?x=1" })).toBe("image/webp");
    expect(resolveUploadedMime({ url: "/api/files/ws/token.mp4" })).toBe("video/mp4");
  });

  it("falls back to the original file name for a generic/blank type", () => {
    expect(
      resolveUploadedMime({
        url: "/api/files/ws/token",
        name: "loop.GIF",
        mimeType: "application/octet-stream",
      }),
    ).toBe("image/gif");
  });
});

describe("mediaKindForMime / mediaKindOfSource", () => {
  it("maps MIME families to media elements", () => {
    expect(mediaKindForMime("image/png")).toBe("image");
    expect(mediaKindForMime("video/mp4")).toBe("video");
    expect(mediaKindForMime("audio/mpeg")).toBe("audio");
    expect(mediaKindForMime("application/pdf")).toBe("file");
  });

  it("lets an explicit stored kind win", () => {
    expect(mediaKindOfSource("/api/files/ws/token.bin", "video")).toBe("video");
    expect(mediaKindOfSource("/api/files/ws/token.bin", "not-a-kind")).toBe("file");
  });

  it("infers from the source when no kind is stored", () => {
    expect(mediaKindOfSource("/api/files/ws/token.gif")).toBe("image");
    expect(mediaKindOfSource("/api/files/ws/token.mp4")).toBe("video");
  });
});

describe("planUploadedAssetRender — GIFs keep their animation source", () => {
  it("routes a GIF to the animated node and strips lossy transform params", () => {
    const plan = planUploadedAssetRender({
      url: "/api/files/ws/token.gif?w=320&format=webp&q=40&v=2",
      name: "loop.gif",
      mimeType: "image/gif",
    });
    expect(plan).toMatchObject({
      type: "animatedImage",
      src: "/api/files/ws/token.gif?v=2",
      mimeType: "image/gif",
      mediaType: "image",
      animatedCandidate: true,
      preserveOriginal: true,
    });
  });

  it("recognises a GIF from the URL when the MIME type is generic", () => {
    const plan = planUploadedAssetRender({
      url: "/api/files/ws/token.gif",
      mimeType: "application/octet-stream",
    });
    expect(plan.type).toBe("animatedImage");
    expect(plan.animatedCandidate).toBe(true);
    expect(plan.src).toBe("/api/files/ws/token.gif");
  });

  it("does not strip unrelated query params from a GIF", () => {
    const plan = planUploadedAssetRender({
      url: "/api/files/ws/token.gif?token=a&format=webp",
      mimeType: "image/gif",
    });
    expect(plan.src).toBe("/api/files/ws/token.gif?token=a");
  });

  it("leaves a still image on the stock image node", () => {
    const plan = planUploadedAssetRender({
      url: "/api/files/ws/token.png?w=320",
      mimeType: "image/png",
    });
    expect(plan).toMatchObject({
      type: "image",
      mediaType: "image",
      animatedCandidate: false,
      src: "/api/files/ws/token.png?w=320",
    });
  });

  it("routes non-images through the media variants", () => {
    expect(
      planUploadedAssetRender({ url: "/api/files/ws/token.mp4", mimeType: "video/mp4" }),
    ).toMatchObject({ type: "media", mediaType: "video", animatedCandidate: false });
    expect(
      planUploadedAssetRender({ url: "/api/files/ws/token.pdf", mimeType: "application/pdf" }),
    ).toMatchObject({ type: "media", mediaType: "file" });
  });
});
