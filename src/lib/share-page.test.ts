import { describe, expect, it } from "vitest";
import { GRADIENTS } from "@/lib/page-cover";
import {
  GENERIC_SHARED_TITLE,
  PROSE_MEASURE,
  WIDE_MEASURE,
  coverBannerStyle,
  documentHasDatabase,
  isSharePath,
  isSharedPageUnavailable,
  readingMeasure,
  shareIcon,
  sharedPageTitle,
  usesWideMeasure,
} from "./share-page";

/**
 * The public share-page model.
 *
 * It is tested here, away from the dialog, because the *module boundary* is the
 * point: these helpers must be importable by the `src/app/s/[token]/page.tsx`
 * server component. They lived in the `"use client"` share dialog, which made
 * every one of them a client reference — the server component imported them
 * happily, then threw "Attempted to call … from the server" and the public page
 * 500'd. The functions were always correct; where they were defined was the bug.
 */

const NOW = new Date("2026-10-15T12:00:00.000Z");

describe("isSharedPageUnavailable", () => {
  it("is true for a missing link or page", () => {
    expect(isSharedPageUnavailable(null, { deletedAt: null }, NOW)).toBe(true);
    expect(isSharedPageUnavailable({ expiresAt: null }, null, NOW)).toBe(true);
  });

  it("is true for a soft-deleted page", () => {
    expect(isSharedPageUnavailable({ expiresAt: null }, { deletedAt: NOW }, NOW)).toBe(true);
  });

  it("treats a past expiry (and the boundary instant) as expired", () => {
    expect(
      isSharedPageUnavailable({ expiresAt: "2026-10-15T11:59:59.000Z" }, { deletedAt: null }, NOW),
    ).toBe(true);
    expect(isSharedPageUnavailable({ expiresAt: NOW }, { deletedAt: null }, NOW)).toBe(true);
  });

  it("keeps a page with a future or absent expiry available", () => {
    expect(
      isSharedPageUnavailable({ expiresAt: "2027-01-01T00:00:00.000Z" }, { deletedAt: null }, NOW),
    ).toBe(false);
    expect(isSharedPageUnavailable({ expiresAt: null }, { deletedAt: null }, NOW)).toBe(false);
  });

  it("never hides a live page on an unparseable expiry", () => {
    expect(isSharedPageUnavailable({ expiresAt: "not-a-date" }, { deletedAt: null }, NOW)).toBe(
      false,
    );
  });
});

describe("sharedPageTitle", () => {
  it("names an open page", () => {
    expect(
      sharedPageTitle({ passwordHash: null, expiresAt: null }, { title: "Open page" }),
    ).toBe("Open page");
  });

  it("withholds the title of a password-protected page until it is unlocked", () => {
    const link = { passwordHash: "$2a$12$hash", expiresAt: null };
    const page = { title: "Locked page" };

    expect(sharedPageTitle(link, page)).toBe(GENERIC_SHARED_TITLE);
    expect(sharedPageTitle(link, page, { unlocked: false })).toBe(GENERIC_SHARED_TITLE);
    expect(sharedPageTitle(link, page, { unlocked: true })).toBe("Locked page");
  });

  it("withholds the title of an expired or deleted page", () => {
    expect(
      sharedPageTitle({ passwordHash: null, expiresAt: "2026-10-15T11:59:59.000Z" }, { title: "Gone" }),
    ).toBe(GENERIC_SHARED_TITLE);
    expect(
      sharedPageTitle({ passwordHash: null, expiresAt: null }, { title: "Gone", deletedAt: NOW }),
    ).toBe(GENERIC_SHARED_TITLE);
  });

  it("stays generic for a missing link or page", () => {
    expect(sharedPageTitle(null, { title: "Gone" })).toBe(GENERIC_SHARED_TITLE);
    expect(sharedPageTitle({ passwordHash: null, expiresAt: null }, null)).toBe(GENERIC_SHARED_TITLE);
  });

  it("falls back to the generic title for an untitled page", () => {
    expect(sharedPageTitle({ passwordHash: null, expiresAt: null }, { title: "" })).toBe(
      GENERIC_SHARED_TITLE,
    );
  });
});

describe("documentHasDatabase / usesWideMeasure", () => {
  const doc = (nodes: unknown[]) => ({ type: "doc", content: nodes });

  it("detects a database block nested in the document", () => {
    const content = doc([
      { type: "paragraph", content: [{ type: "text", text: "hi" }] },
      { type: "columns", content: [{ type: "column", content: [{ type: "linkedDatabase" }] }] },
    ]);
    expect(documentHasDatabase(content)).toBe(true);
  });

  it("ignores prose-only and malformed content", () => {
    expect(documentHasDatabase(doc([{ type: "paragraph" }]))).toBe(false);
    expect(documentHasDatabase(null)).toBe(false);
    expect(documentHasDatabase("nope")).toBe(false);
  });

  it("survives a cyclic document instead of hanging", () => {
    const node: { type: string; content: unknown[] } = { type: "columns", content: [] };
    node.content.push(node);
    expect(documentHasDatabase({ type: "doc", content: [node] })).toBe(false);
  });

  it("widens the measure for a DATABASE page or an embedded database", () => {
    expect(usesWideMeasure({ type: "DATABASE", content: null })).toBe(true);
    expect(usesWideMeasure({ type: "PAGE", content: doc([{ type: "inlineDatabase" }]) })).toBe(true);
    expect(usesWideMeasure({ type: "PAGE", content: doc([{ type: "paragraph" }]) })).toBe(false);
  });

  it("returns the matching measure class", () => {
    expect(readingMeasure(true)).toBe(WIDE_MEASURE);
    expect(readingMeasure(false)).toBe(PROSE_MEASURE);
    expect(WIDE_MEASURE).toBe("max-w-[1100px]");
    expect(PROSE_MEASURE).toBe("max-w-[720px]");
  });
});

describe("coverBannerStyle", () => {
  it("decodes a gradient preset", () => {
    expect(coverBannerStyle(GRADIENTS.ocean)).toEqual({
      backgroundImage: GRADIENTS.ocean,
      backgroundPosition: "50% 50%",
    });
  });

  it("decodes an image cover and its stored focal point", () => {
    // B69: the cover is a picture like any other - on this public surface it
    // is fetched by the server's proxy, so the host never sees the visitor.
    expect(coverBannerStyle('url("https://images.test/cover.png") 30% 70%')).toEqual({
      backgroundImage:
        'url("/api/external-image?url=https%3A%2F%2Fimages.test%2Fcover.png")',
      backgroundPosition: "30% 70%",
    });
  });

  it("accepts a bare image URL without a focal point", () => {
    expect(coverBannerStyle("https://images.test/cover.png")).toEqual({
      backgroundImage:
        'url("/api/external-image?url=https%3A%2F%2Fimages.test%2Fcover.png")',
      backgroundPosition: "50% 50%",
    });
  });

  it("rejects absent, unsafe and unrecognised covers", () => {
    expect(coverBannerStyle(null)).toBeNull();
    expect(coverBannerStyle("   ")).toBeNull();
    expect(coverBannerStyle("javascript:alert(1)")).toBeNull();
  });
});

describe("isSharePath", () => {
  it("is true for the public share surface only", () => {
    expect(isSharePath("/s/abc123")).toBe(true);
    expect(isSharePath("/s/abc123/unlock")).toBe(true);
    expect(isSharePath("/s")).toBe(true);
    expect(isSharePath("/login")).toBe(false);
    expect(isSharePath("/w/demo/page")).toBe(false);
    expect(isSharePath("/settings")).toBe(false);
  });
});

describe("shareIcon", () => {
  it("keeps an emoji icon", () => {
    expect(shareIcon("📄")).toEqual({ kind: "emoji", value: "📄" });
  });

  it("points an image icon at the server's proxy", () => {
    expect(shareIcon("https://images.test/icon.png")).toEqual({
      kind: "image",
      value: "/api/external-image?url=https%3A%2F%2Fimages.test%2Ficon.png",
    });
  });

  it("reads an unusable icon as none", () => {
    expect(shareIcon(null)).toEqual({ kind: "none", value: "" });
    expect(shareIcon("javascript:alert(1)")).toEqual({ kind: "none", value: "" });
  });
});
