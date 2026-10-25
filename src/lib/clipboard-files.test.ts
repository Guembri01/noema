import { describe, expect, it } from "vitest";
import {
  extractClipboardImageFiles,
  isClipboardImageFile,
  resolveClipboardFileMime,
  type ClipboardDataLike,
  type ClipboardFileLike,
} from "@/lib/clipboard-files";

/**
 * Clipboard extraction is the browser-shape seam: Chromium exposes the bitmap
 * on `clipboardData.files`, some Safari/WebView shells only on `items`, and a
 * few expose both. These tests pin the pure extraction/dedupe contract, plus
 * the MIME fallback that rescues a file whose `type` is blank.
 */

const file = (
  name: string,
  type: string | null,
  size = 4,
  lastModified = 0,
): ClipboardFileLike & { marker: string } => ({
  name,
  type,
  size,
  lastModified,
  marker: name,
});

describe("resolveClipboardFileMime", () => {
  it("keeps a specific declared type", () => {
    expect(resolveClipboardFileMime({ name: "shot.png", type: "image/png" })).toBe("image/png");
  });

  it("maps the image/jpg alias to image/jpeg", () => {
    expect(resolveClipboardFileMime({ name: "shot.jpg", type: "image/jpg" })).toBe("image/jpeg");
  });

  it("falls back to the file-name extension when the type is blank", () => {
    expect(resolveClipboardFileMime({ name: "loop.gif", type: "" })).toBe("image/gif");
    expect(resolveClipboardFileMime({ name: "scan.PNG" })).toBe("image/png");
    expect(resolveClipboardFileMime({ name: "report.pdf", type: null })).toBe("application/pdf");
  });

  it("falls back to the extension for the generic octet-stream type", () => {
    expect(
      resolveClipboardFileMime({ name: "animation.webp", type: "application/octet-stream" }),
    ).toBe("image/webp");
  });

  it("does not override a specific non-image type with the extension", () => {
    expect(resolveClipboardFileMime({ name: "notes.png", type: "text/plain" })).toBe("text/plain");
  });

  it("returns the generic type when nothing can identify the file", () => {
    expect(resolveClipboardFileMime({ name: "clipboard", type: "" })).toBe(
      "application/octet-stream",
    );
  });

  it("isImageFile agrees with the resolved MIME", () => {
    expect(isClipboardImageFile({ name: "a.gif", type: "" })).toBe(true);
    expect(isClipboardImageFile({ name: "a.pdf", type: "" })).toBe(false);
  });
});

describe("extractClipboardImageFiles", () => {
  it("reads the Chromium `files` shape", () => {
    const png = file("shot.png", "image/png");
    expect(extractClipboardImageFiles({ files: [png] })).toEqual([png]);
  });

  it("reads the Safari/WebView `items` shape when `files` is empty", () => {
    const png = file("shot.png", "image/png");
    const data: ClipboardDataLike<typeof png> = {
      files: [],
      items: [
        { kind: "string", type: "text/html", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => png },
      ],
    };
    expect(extractClipboardImageFiles(data)).toEqual([png]);
  });

  it("dedupes the same bitmap exposed by `files` and `items`", () => {
    const bitmap = file("shot.png", "image/png", 1234);
    const data: ClipboardDataLike<typeof bitmap> = {
      files: [bitmap],
      items: [{ kind: "file", type: "image/png", getAsFile: () => ({ ...bitmap }) }],
    };
    expect(extractClipboardImageFiles(data)).toEqual([bitmap]);
  });

  it("dedupes both lists even when the browser hands back distinct File objects", () => {
    const fromFiles = file("shot.png", "image/png", 1234);
    const fromItems = file("shot.png", "image/png", 1234);
    expect(extractClipboardImageFiles({ files: [fromFiles], items: [{ getAsFile: () => fromItems }] })).toEqual([
      fromFiles,
    ]);
  });

  it("keeps two genuine images that share metadata when `files` has both", () => {
    const first = file("shot.png", "image/png", 1234);
    const second = file("shot.png", "image/png", 1234);
    const data: ClipboardDataLike<typeof first> = {
      files: [first, second],
      items: [
        { getAsFile: () => file("shot.png", "image/png", 1234) },
        { getAsFile: () => file("shot.png", "image/png", 1234) },
      ],
    };
    // Both `files` entries are real images; the two items merely match them.
    expect(extractClipboardImageFiles(data)).toEqual([first, second]);
  });

  it("keeps an item-only image even when a different file has the same metadata", () => {
    const fromFiles = file("shot.png", "image/png", 1234);
    const extraItem = file("shot.png", "image/png", 1234);
    const data: ClipboardDataLike<typeof fromFiles> = {
      files: [fromFiles],
      items: [
        { getAsFile: () => file("shot.png", "image/png", 1234) },
        { getAsFile: () => extraItem },
      ],
    };
    expect(extractClipboardImageFiles(data)).toEqual([fromFiles, extraItem]);
  });

  it("supports a file whose type is blank but whose name is an image", () => {
    const gif = file("animation.gif", "");
    expect(extractClipboardImageFiles({ files: [gif] })).toEqual([gif]);
  });

  it("drops non-image files and non-file items", () => {
    const pdf = file("doc.pdf", "application/pdf");
    const png = file("shot.png", "image/png");
    const data: ClipboardDataLike<typeof pdf | typeof png> = {
      files: [pdf],
      items: [
        { kind: "string", type: "text/html", getAsFile: () => png },
        { kind: "file", type: "image/png", getAsFile: () => png },
      ],
    };
    expect(extractClipboardImageFiles(data)).toEqual([png]);
  });

  it("skips items whose getAsFile is missing or throws", () => {
    const png = file("shot.png", "image/png");
    const data: ClipboardDataLike<typeof png> = {
      items: [
        { kind: "file", type: "image/png" },
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => {
            throw new Error("clipboard busy");
          },
        },
        { kind: "file", type: "image/png", getAsFile: () => png },
      ],
    };
    expect(extractClipboardImageFiles(data)).toEqual([png]);
  });

  it("is total for missing/empty data", () => {
    expect(extractClipboardImageFiles(null)).toEqual([]);
    expect(extractClipboardImageFiles(undefined)).toEqual([]);
    expect(extractClipboardImageFiles({})).toEqual([]);
    expect(extractClipboardImageFiles({ files: null, items: null })).toEqual([]);
  });
});
