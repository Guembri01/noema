import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIME,
  extForMime,
  fileCategory,
  fileNameExt,
  iconForFile,
  isAllowedType,
  isImage,
  mimeForExt,
} from "./file-type";

/**
 * G1 file-type — File types (`feat/g1-file-type`).
 *
 * Written RED-first against a missing module, then implemented. Coverage pins:
 * - extension → MIME and MIME → extension both directions,
 * - case-insensitive and dot-tolerant inputs; unknown values are total
 *   (never throw) and fall back to `DEFAULT_MIME` / `""` / `"other"`,
 * - `fileNameExt` reads the basename only (dot folders, dotfiles, trailing dots),
 * - `fileCategory` accepts a MIME *or* a bare/dotted extension,
 * - `isImage` accepts a MIME, extension or file name,
 * - `iconForFile` keys the glyph off the file's category,
 * - `isAllowedType` matches exact MIME, wildcard (`image/*`), category name,
 *   extension rule, allow-all (`*`), and fails closed on an empty allow list.
 */

describe("mimeForExt", () => {
  it("maps common extensions to MIME types", () => {
    expect(mimeForExt("png")).toBe("image/png");
    expect(mimeForExt("jpg")).toBe("image/jpeg");
    expect(mimeForExt("pdf")).toBe("application/pdf");
    expect(mimeForExt("mp4")).toBe("video/mp4");
    expect(mimeForExt("mp3")).toBe("audio/mpeg");
  });

  it("is case-insensitive and dot-tolerant", () => {
    expect(mimeForExt("PNG")).toBe("image/png");
    expect(mimeForExt(".Gif")).toBe("image/gif");
    expect(mimeForExt("  Pdf ")).toBe("application/pdf");
  });

  it("falls back to the default for unknown/empty extensions", () => {
    expect(mimeForExt("nope")).toBe(DEFAULT_MIME);
    expect(mimeForExt("")).toBe(DEFAULT_MIME);
    expect(mimeForExt(".")).toBe(DEFAULT_MIME);
  });
});

describe("extForMime", () => {
  it("round-trips known MIME types to a canonical extension", () => {
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("application/pdf")).toBe("pdf");
  });

  it("ignores case and parameters", () => {
    expect(extForMime("IMAGE/PNG")).toBe("png");
    expect(extForMime("text/plain; charset=utf-8")).toBe("txt");
  });

  it("returns an empty string for unknown MIME types", () => {
    expect(extForMime("application/x-nonsense")).toBe("");
    expect(extForMime("")).toBe("");
  });
});

describe("fileNameExt", () => {
  it("returns the lower-cased extension without the dot", () => {
    expect(fileNameExt("Photo.PNG")).toBe("png");
    expect(fileNameExt("archive.tar.gz")).toBe("gz");
    expect(fileNameExt("report.final.pdf")).toBe("pdf");
  });

  it("returns an empty string when there is no extension", () => {
    expect(fileNameExt("README")).toBe("");
    expect(fileNameExt(".gitignore")).toBe("");
    expect(fileNameExt("trailing.")).toBe("");
  });

  it("uses the basename, not directory dots", () => {
    expect(fileNameExt("my.folder/notes")).toBe("");
    expect(fileNameExt("my.folder/notes.txt")).toBe("txt");
  });
});

describe("fileCategory", () => {
  it("accepts a MIME type", () => {
    expect(fileCategory("image/webp")).toBe("image");
    expect(fileCategory("video/quicktime")).toBe("video");
    expect(fileCategory("audio/ogg")).toBe("audio");
    expect(fileCategory("application/pdf")).toBe("pdf");
    expect(fileCategory("text/csv")).toBe("sheet");
    expect(fileCategory("application/zip")).toBe("archive");
    expect(fileCategory("application/json")).toBe("code");
    expect(fileCategory("application/msword")).toBe("doc");
  });

  it("accepts a bare or dotted extension, case-insensitively", () => {
    expect(fileCategory("PNG")).toBe("image");
    expect(fileCategory(".xlsx")).toBe("sheet");
    expect(fileCategory("docx")).toBe("doc");
    expect(fileCategory("mp4")).toBe("video");
  });

  it("falls back to 'other' for unknown input", () => {
    expect(fileCategory("nope")).toBe("other");
    expect(fileCategory("")).toBe("other");
    expect(fileCategory("application/x-nonsense")).toBe("other");
  });
});

describe("isImage / iconForFile", () => {
  it("recognises images from a MIME, an extension or a file name", () => {
    expect(isImage("image/png")).toBe(true);
    expect(isImage("jpeg")).toBe(true);
    expect(isImage("cover.webp")).toBe(true);
    expect(isImage("report.pdf")).toBe(false);
    expect(isImage("")).toBe(false);
  });

  it("picks an icon by category", () => {
    expect(iconForFile("photo.png")).toBe("🖼️");
    expect(iconForFile("clip.mp4")).toBe("🎬");
    expect(iconForFile("song.mp3")).toBe("🎵");
    expect(iconForFile("report.pdf")).toBe("📄");
    expect(iconForFile("notes.docx")).toBe("📝");
    expect(iconForFile("budget.xlsx")).toBe("📊");
    expect(iconForFile("bundle.zip")).toBe("🗜️");
    expect(iconForFile("main.ts")).toBe("💻");
    expect(iconForFile("LICENSE")).toBe("📎");
  });
});

describe("isAllowedType", () => {
  it("matches exact MIME types case-insensitively", () => {
    expect(isAllowedType("image/png", { allow: ["image/png"] })).toBe(true);
    expect(isAllowedType("IMAGE/PNG", { allow: ["image/png"] })).toBe(true);
    expect(isAllowedType("image/gif", { allow: ["image/png"] })).toBe(false);
  });

  it("matches MIME wildcards", () => {
    expect(isAllowedType("image/svg+xml", { allow: ["image/*"] })).toBe(true);
    expect(isAllowedType("application/pdf", { allow: ["image/*"] })).toBe(false);
  });

  it("matches category names and extension rules", () => {
    expect(isAllowedType("application/pdf", { allow: ["pdf"] })).toBe(true);
    expect(isAllowedType("audio/mpeg", { allow: ["media", "audio"] })).toBe(true);
    expect(isAllowedType("image/png", { allow: [".png"] })).toBe(true);
    expect(isAllowedType("image/png", { allow: ["pdf"] })).toBe(false);
  });

  it("supports an allow-all rule and fails closed on an empty list", () => {
    expect(isAllowedType("application/x-nonsense", { allow: ["*"] })).toBe(true);
    expect(isAllowedType("application/x-nonsense", { allow: ["*/*"] })).toBe(true);
    expect(isAllowedType("image/png", { allow: [] })).toBe(false);
  });
});
