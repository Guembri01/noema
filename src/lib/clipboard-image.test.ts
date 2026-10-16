import { describe, expect, it } from "vitest";
import {
  dedupeName,
  describePastePlan,
  extractDataUrl,
  inspectClipboardItem,
  isSvgSafe,
  planPaste,
  slugifyFilename,
} from "@/lib/clipboard-image";

/**
 * Red-first suite for the clipboard image paste engine (FEATURE_MATRIX §15
 * "Paste image from clipboard" — "works for many sources").
 *
 * The module owns the *pure* half of pasting an image: reading a clipboard item
 * (a raster `image/*` blob, or an `image/*` embedded as a `<img src="data:...">`
 * inside `text/html`), enforcing size/type/safety limits, minting a stable
 * `pasted-image-<date>-<time>.<ext>` name, de-duplicating it against the page's
 * existing attachment names, and planning the resulting uploads. No DOM, no
 * React, no I/O; every entry point is total (malformed input degrades to a
 * rejection or `null`, never a throw).
 */

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const NOW = new Date("2026-01-02T15:30:00Z");

describe("extractDataUrl", () => {
  it("extracts a double-quoted base64 png data url", () => {
    expect(extractDataUrl('<p>x</p><img alt="a" src="data:image/png;base64,QUJD">')).toEqual({
      mimeType: "image/png",
      base64: "QUJD",
      size: 3,
    });
  });

  it("extracts a single-quoted data url", () => {
    expect(extractDataUrl("<img src='data:image/webp;base64,QUJD'>")).toEqual({
      mimeType: "image/webp",
      base64: "QUJD",
      size: 3,
    });
  });

  it("extracts an unquoted attribute value", () => {
    expect(extractDataUrl("<img src=data:image/png;base64,QUJD>")?.mimeType).toBe("image/png");
  });

  it("skips remote images and picks the first data-url image", () => {
    const html =
      '<img src="https://example.test/a.png"><img src="data:image/gif;base64,R0lGOD">';
    expect(extractDataUrl(html)).toEqual({ mimeType: "image/gif", base64: "R0lGOD", size: 4 });
  });

  it("accepts a bare data url string", () => {
    expect(extractDataUrl("data:image/webp;base64,QUJD")).toEqual({
      mimeType: "image/webp",
      base64: "QUJD",
      size: 3,
    });
  });

  it("tolerates whitespace and newlines inside the base64 payload", () => {
    expect(extractDataUrl('<img src="data:image/png;base64,iVBO\nRw0K\nGgo=">')).toEqual({
      mimeType: "image/png",
      base64: "iVBORw0KGgo=",
      size: 8,
    });
  });

  it("decodes a percent-encoded (non-base64) svg data url", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const found = extractDataUrl(`data:image/svg+xml,${encodeURIComponent(svg)}`);
    expect(found?.mimeType).toBe("image/svg+xml");
    expect(found?.base64).toBe("");
    expect(found?.size).toBe(bytes(svg));
  });

  it("returns null for html with no image data url", () => {
    expect(extractDataUrl("<p>hello</p>")).toBeNull();
    expect(extractDataUrl("")).toBeNull();
    expect(extractDataUrl(null as unknown as string)).toBeNull();
  });

  it("ignores non-image data urls", () => {
    expect(extractDataUrl('<img src="data:text/html;base64,PGgxPng8L2gxPg==">')).toBeNull();
  });

  it("returns null for malformed or empty data urls", () => {
    expect(extractDataUrl('<img src="data:image/png;base64">')).toBeNull();
    expect(extractDataUrl('<img src="data:image/png;base64,@@@@">')).toBeNull();
  });
});

describe("isSvgSafe", () => {
  it("accepts a plain vector svg (xmlns is not an external reference)", () => {
    expect(
      isSvgSafe('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="#f00"/></svg>'),
    ).toBe(true);
  });

  it("accepts same-document fragment references", () => {
    expect(
      isSvgSafe('<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use xlink:href="#g"/></svg>'),
    ).toBe(true);
  });

  it("rejects script tags in any case", () => {
    expect(isSvgSafe("<svg><script>alert(1)</script></svg>")).toBe(false);
    expect(isSvgSafe("<svg><SCRIPT>alert(1)</SCRIPT></svg>")).toBe(false);
  });

  it("rejects inline event handlers", () => {
    expect(isSvgSafe('<svg onload="x()"></svg>')).toBe(false);
    expect(isSvgSafe('<svg><rect onmouseover="x()"/></svg>')).toBe(false);
  });

  it("rejects external references (href/src/url)", () => {
    expect(isSvgSafe('<svg><image href="https://evil.test/x.png"/></svg>')).toBe(false);
    expect(isSvgSafe('<svg><use xlink:href="//evil.test/x.svg"/></svg>')).toBe(false);
    expect(isSvgSafe('<svg><rect fill="url(https://evil.test/x)"/></svg>')).toBe(false);
  });

  it("rejects foreignObject, javascript: urls and entities", () => {
    expect(isSvgSafe("<svg><foreignObject><p>x</p></foreignObject></svg>")).toBe(false);
    expect(isSvgSafe('<svg><a href="javascript:alert(1)">x</a></svg>')).toBe(false);
    expect(isSvgSafe('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')).toBe(false);
  });

  it("treats empty or non-string input as unsafe", () => {
    expect(isSvgSafe("")).toBe(false);
    expect(isSvgSafe("   ")).toBe(false);
    expect(isSvgSafe(null as unknown as string)).toBe(false);
  });
});

describe("slugifyFilename", () => {
  it("builds pasted-image-<date>-<time>.png from an empty name", () => {
    expect(slugifyFilename("", { ext: "png", now: NOW })).toBe(
      "pasted-image-2026-01-02-1530.png",
    );
  });

  it("slugifies the original name and keeps its extension", () => {
    expect(slugifyFilename("My Screenshot 3.PNG", { now: NOW })).toBe(
      "pasted-my-screenshot-3-2026-01-02-1530.png",
    );
  });

  it("uses the basename of a full path", () => {
    expect(slugifyFilename("C:\\Users\\a\\Holiday Photo.jpeg", { now: NOW })).toBe(
      "pasted-holiday-photo-2026-01-02-1530.jpeg",
    );
  });

  it("falls back to the image slug and png for punctuation-only names", () => {
    expect(slugifyFilename("!!!", { now: NOW })).toBe("pasted-image-2026-01-02-1530.png");
  });

  it("drops diacritics and collapses separators", () => {
    expect(slugifyFilename("Café & Crème.png", { now: NOW })).toBe(
      "pasted-cafe-creme-2026-01-02-1530.png",
    );
  });

  it("formats UTC with zero padding and survives an invalid date", () => {
    expect(slugifyFilename("a", { ext: "gif", now: new Date("2026-03-04T05:06:00Z") })).toBe(
      "pasted-a-2026-03-04-0506.gif",
    );
    expect(slugifyFilename("a", { ext: "png", now: "not-a-date" })).toBe(
      "pasted-a-1970-01-01-0000.png",
    );
  });
});

describe("dedupeName", () => {
  it("returns the name unchanged when it is free", () => {
    expect(dedupeName("photo.png", [])).toBe("photo.png");
    expect(dedupeName("photo.png", ["other.png"])).toBe("photo.png");
  });

  it("appends (2) then (3) on collisions (Notion style)", () => {
    expect(dedupeName("photo.png", ["photo.png"])).toBe("photo (2).png");
    expect(dedupeName("photo.png", ["photo.png", "photo (2).png"])).toBe("photo (3).png");
  });

  it("skips to the first free suffix", () => {
    expect(dedupeName("a.png", ["a.png", "a (3).png"])).toBe("a (2).png");
  });

  it("compares case-insensitively but preserves the original casing", () => {
    expect(dedupeName("Photo.PNG", ["photo.png"])).toBe("Photo (2).PNG");
  });

  it("handles names without an extension and accepts a Set", () => {
    expect(dedupeName("notes", ["notes"])).toBe("notes (2)");
    expect(dedupeName("a.png", new Set(["a.png"]))).toBe("a (2).png");
  });
});

describe("inspectClipboardItem", () => {
  it("accepts a png within the size limit", () => {
    expect(inspectClipboardItem({ mimeType: "image/png", size: 1024 }, { maxBytes: 2048 })).toEqual({
      accept: true,
      mimeType: "image/png",
      size: 1024,
    });
  });

  it("accepts exactly maxBytes and rejects one byte over", () => {
    expect(
      inspectClipboardItem({ mimeType: "image/png", size: 2048 }, { maxBytes: 2048 }).accept,
    ).toBe(true);
    const over = inspectClipboardItem({ mimeType: "image/png", size: 2049 }, { maxBytes: 2048 });
    expect(over.accept).toBe(false);
    expect(over.reason).toBe("too-large");
  });

  it("computes the byte size from base64 data", () => {
    expect(inspectClipboardItem({ mimeType: "image/png", data: "QUJD" }, {})).toEqual({
      accept: true,
      mimeType: "image/png",
      size: 3,
    });
  });

  it("accepts the default raster image types", () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(inspectClipboardItem({ mimeType, data: "QUJD" }, {}).accept).toBe(true);
    }
  });

  it("accepts the `type` alias used by clipboard/File objects", () => {
    expect(inspectClipboardItem({ type: "image/png", size: 1 }, {}).accept).toBe(true);
  });

  it("rejects a non-image type", () => {
    const verdict = inspectClipboardItem({ mimeType: "application/pdf", size: 10 }, {});
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toBe("unsupported-type");
  });

  it("rejects an image type outside allowedTypes", () => {
    const verdict = inspectClipboardItem(
      { mimeType: "image/gif", data: "QUJD" },
      { allowedTypes: ["image/png"] },
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toBe("type-not-allowed");
  });

  it("supports wildcard allowedTypes", () => {
    expect(
      inspectClipboardItem({ mimeType: "image/webp", data: "QUJD" }, { allowedTypes: ["image/*"] })
        .accept,
    ).toBe(true);
  });

  it("extracts an image embedded in text/html", () => {
    expect(
      inspectClipboardItem(
        { mimeType: "text/html", data: '<img src="data:image/png;base64,QUJD">' },
        {},
      ),
    ).toEqual({ accept: true, mimeType: "image/png", size: 3 });
  });

  it("rejects text/html without an embedded image", () => {
    const verdict = inspectClipboardItem({ mimeType: "text/html", data: "<p>just text</p>" }, {});
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toBe("no-image");
  });

  it("accepts a safe svg and rejects an unsafe one", () => {
    const safe = inspectClipboardItem(
      { mimeType: "image/svg+xml", data: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>' },
      {},
    );
    expect(safe.accept).toBe(true);
    expect(safe.mimeType).toBe("image/svg+xml");

    const unsafe = inspectClipboardItem(
      { mimeType: "image/svg+xml", data: "<svg><script>x()</script></svg>" },
      {},
    );
    expect(unsafe.accept).toBe(false);
    expect(unsafe.reason).toBe("unsafe-svg");
  });

  it("validates a base64-encoded svg payload", () => {
    const safe = inspectClipboardItem(
      { mimeType: "image/svg+xml", data: b64("<svg></svg>") },
      {},
    );
    expect(safe.accept).toBe(true);
    expect(safe.size).toBe(bytes("<svg></svg>"));

    const unsafe = inspectClipboardItem(
      { mimeType: "image/svg+xml", data: b64('<svg onload="x()"/>') },
      {},
    );
    expect(unsafe.accept).toBe(false);
    expect(unsafe.reason).toBe("unsafe-svg");
  });

  it("rejects an item with no payload", () => {
    const verdict = inspectClipboardItem({ mimeType: "image/png" }, {});
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toBe("empty");
  });
});

describe("planPaste", () => {
  it("plans uploads and skips in one pass", () => {
    const plan = planPaste({
      items: [
        { mimeType: "image/png", data: "QUJD", name: "one.png" },
        { mimeType: "application/pdf", size: 5 },
        { mimeType: "text/html", data: '<img src="data:image/gif;base64,R0lGOD">' },
      ],
      existingNames: [],
      maxBytes: 1024,
      now: NOW,
    });
    expect(plan.uploads).toEqual([
      { name: "pasted-one-2026-01-02-1530.png", mimeType: "image/png", bytes: 3 },
      { name: "pasted-image-2026-01-02-1530.gif", mimeType: "image/gif", bytes: 4 },
    ]);
    expect(plan.skipped).toEqual([{ reason: "unsupported-type" }]);
  });

  it("dedupes names that collide within one plan", () => {
    const plan = planPaste({
      items: [
        { mimeType: "image/png", data: "QUJD" },
        { mimeType: "image/png", data: "QUJD" },
      ],
      now: NOW,
    });
    expect(plan.uploads.map((upload) => upload.name)).toEqual([
      "pasted-image-2026-01-02-1530.png",
      "pasted-image-2026-01-02-1530 (2).png",
    ]);
  });

  it("honours existingNames when naming", () => {
    const plan = planPaste({
      items: [{ mimeType: "image/png", data: "QUJD", name: "shot.png" }],
      existingNames: ["pasted-shot-2026-01-02-1530.png"],
      now: NOW,
    });
    expect(plan.uploads[0]?.name).toBe("pasted-shot-2026-01-02-1530 (2).png");
  });

  it("returns empty arrays for no items", () => {
    expect(planPaste({ items: [], now: NOW })).toEqual({ uploads: [], skipped: [] });
  });
});

describe("describePastePlan", () => {
  it("describes an empty plan", () => {
    expect(describePastePlan({ uploads: [], skipped: [] })).toBe("Nothing to paste");
  });

  it("summarises ready uploads and skips", () => {
    const plan = planPaste({
      items: [
        { mimeType: "image/png", data: "QUJD" },
        { mimeType: "image/png", data: "QUJD" },
        { mimeType: "application/pdf", size: 5 },
      ],
      now: NOW,
    });
    expect(describePastePlan(plan)).toBe("2 images ready; 1 skipped (unsupported-type)");
  });

  it("uses the singular for one upload", () => {
    const plan = planPaste({ items: [{ mimeType: "image/png", data: "QUJD" }], now: NOW });
    expect(describePastePlan(plan)).toBe("1 image ready");
  });

  it("lists unique skip reasons in first-seen order", () => {
    expect(
      describePastePlan({
        uploads: [],
        skipped: [{ reason: "too-large" }, { reason: "too-large" }, { reason: "unsafe-svg" }],
      }),
    ).toBe("3 skipped (too-large, unsafe-svg)");
  });
});
