import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  DATABASE_EXPORT_FORMATS,
  PAGE_EXPORT_FORMATS,
  WORKSPACE_EXPORT_FORMATS,
  attachmentZipPath,
  buildWorkspaceZip,
  collectExportPageIds,
  parseExportFormat,
  parseIncludeSubpages,
  rewriteAttachments,
  uniqueZipPath,
} from "@/lib/export-format";

/**
 * B55 — R23.16 "explicit format contract": `?format=` on an export route is
 * validated against a per-route allowlist; an unknown value must be a 400,
 * never a silent fallback (page export used to fall through to Markdown).
 * B91 adds `json` to the database allowlist (R23.16: `?format=csv|json`).
 *
 * The export-zip slice adds: the `?includeSubpages=` toggle, the recursive
 * page-tree walk behind it, attachment path mapping, and the pure zip
 * assembler (`buildWorkspaceZip`) with its structure manifest.
 */

describe("parseExportFormat", () => {
  it("defaults to the route fallback when the parameter is absent", () => {
    expect(parseExportFormat(null, PAGE_EXPORT_FORMATS, "md")).toEqual({
      ok: true,
      format: "md",
    });
  });

  it("treats an empty ?format= as absent (back-compat with today's behaviour)", () => {
    expect(parseExportFormat("", PAGE_EXPORT_FORMATS, "md")).toEqual({
      ok: true,
      format: "md",
    });
  });

  it("accepts every format in the page allowlist", () => {
    for (const format of PAGE_EXPORT_FORMATS) {
      expect(parseExportFormat(format, PAGE_EXPORT_FORMATS, "md")).toEqual({
        ok: true,
        format,
      });
    }
  });

  it("rejects an unknown format and lists the valid ones", () => {
    const result = parseExportFormat("docx", PAGE_EXPORT_FORMATS, "md");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the unknown format to be rejected");
    expect(result.error).toContain("docx");
    expect(result.error).toContain("md, json, html, pdf");
    expect(result.valid).toEqual(["md", "json", "html", "pdf"]);
  });

  it("rejects a format that is only valid on another route", () => {
    expect(parseExportFormat("zip", PAGE_EXPORT_FORMATS, "md").ok).toBe(false);
    expect(parseExportFormat("md", WORKSPACE_EXPORT_FORMATS, "zip").ok).toBe(false);
    // B91: `json` is now valid on the database too — `html` is page-only.
    expect(parseExportFormat("html", DATABASE_EXPORT_FORMATS, "csv").ok).toBe(false);
  });

  it("matches exactly — no case folding", () => {
    expect(parseExportFormat("MD", PAGE_EXPORT_FORMATS, "md").ok).toBe(false);
  });

  it("B91/R23.16: the database export accepts json beside the csv default", () => {
    expect(parseExportFormat("json", DATABASE_EXPORT_FORMATS, "csv")).toEqual({
      ok: true,
      format: "json",
    });
  });

  it("pins the per-route allowlists (database csv+json, workspace zip-only)", () => {
    expect([...PAGE_EXPORT_FORMATS]).toEqual(["md", "json", "html", "pdf"]);
    expect([...DATABASE_EXPORT_FORMATS]).toEqual(["csv", "json"]);
    expect([...WORKSPACE_EXPORT_FORMATS]).toEqual(["zip"]);
    expect(parseExportFormat(null, DATABASE_EXPORT_FORMATS, "csv")).toEqual({
      ok: true,
      format: "csv",
    });
    expect(parseExportFormat(null, WORKSPACE_EXPORT_FORMATS, "zip")).toEqual({
      ok: true,
      format: "zip",
    });
  });

  it("each route's default is itself an allowed format", () => {
    expect(PAGE_EXPORT_FORMATS).toContain("md");
    expect(DATABASE_EXPORT_FORMATS).toContain("csv");
    expect(WORKSPACE_EXPORT_FORMATS).toContain("zip");
  });
});

// ---------------------------------------------------------------------------
// ?includeSubpages= toggle (MISSING_FEATURES §12: export with/without subpages)
// ---------------------------------------------------------------------------

describe("parseIncludeSubpages", () => {
  it("defaults to including subpages when the parameter is absent", () => {
    expect(parseIncludeSubpages(null)).toBe(true);
  });

  it("treats an empty ?includeSubpages= as absent (back-compat: everything exported)", () => {
    expect(parseIncludeSubpages("")).toBe(true);
  });

  it("excludes children only on the exact lowercase `false`", () => {
    expect(parseIncludeSubpages("false")).toBe(false);
    // Exact-match semantics, mirroring parseExportFormat: no case folding.
    expect(parseIncludeSubpages("False")).toBe(true);
    expect(parseIncludeSubpages("TRUE")).toBe(true);
    expect(parseIncludeSubpages("0")).toBe(true);
    expect(parseIncludeSubpages("no")).toBe(true);
  });
});

describe("collectExportPageIds", () => {
  //      a        e
  //    /   \
  //   b     c
  //   |
  //   d
  const pages = [
    { id: "a", parentId: null },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "a" },
    { id: "d", parentId: "b" },
    { id: "e", parentId: null },
  ];

  it("with subpages: walks the whole tree in depth-first pre-order", () => {
    expect(collectExportPageIds(pages, { includeSubpages: true })).toEqual([
      "a",
      "b",
      "d",
      "c",
      "e",
    ]);
  });

  it("without subpages: exports only the top-level pages", () => {
    expect(collectExportPageIds(pages, { includeSubpages: false })).toEqual(["a", "e"]);
  });

  it("honours an explicit root (single-page export): subtree or just the page", () => {
    expect(collectExportPageIds(pages, { includeSubpages: true, rootIds: ["b"] })).toEqual([
      "b",
      "d",
    ]);
    expect(collectExportPageIds(pages, { includeSubpages: false, rootIds: ["b"] })).toEqual(["b"]);
  });

  it("treats a page whose parent is outside the export set as top-level (trashed parent)", () => {
    const withOrphan = [...pages, { id: "f", parentId: "ghost" }];
    expect(collectExportPageIds(withOrphan, { includeSubpages: false })).toEqual(["a", "e", "f"]);
    expect(collectExportPageIds(withOrphan, { includeSubpages: true })).toEqual([
      "a",
      "b",
      "d",
      "c",
      "e",
      "f",
    ]);
  });

  it("terminates on a parent cycle instead of hanging", () => {
    const cyclic = [
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
    ];
    expect(collectExportPageIds(cyclic, { includeSubpages: true })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Zip path + attachment mapping
// ---------------------------------------------------------------------------

describe("uniqueZipPath", () => {
  it("keeps the first occurrence untouched", () => {
    const used = new Set<string>();
    expect(uniqueZipPath("Docs/Page.md", used)).toBe("Docs/Page.md");
    expect(used).toEqual(new Set(["Docs/Page.md"]));
  });

  it("appends an ordinal before the extension on collision", () => {
    const used = new Set<string>();
    expect(uniqueZipPath("Page.md", used)).toBe("Page.md");
    expect(uniqueZipPath("Page.md", used)).toBe("Page (1).md");
    expect(uniqueZipPath("Page.md", used)).toBe("Page (2).md");
  });

  it("never touches a dot inside a directory segment", () => {
    const used = new Set<string>();
    expect(uniqueZipPath("v1.2/Page", used)).toBe("v1.2/Page");
    expect(uniqueZipPath("v1.2/Page", used)).toBe("v1.2/Page (1)");
  });
});

describe("attachmentZipPath / rewriteAttachments", () => {
  it("maps an upload URL onto its folder inside the archive", () => {
    expect(attachmentZipPath("/api/files/ws_1/abc123.png")).toBe("attachments/abc123.png");
  });

  it("refuses anything that is not a well-formed upload URL", () => {
    expect(attachmentZipPath("https://cdn.example.com/abc.png")).toBeNull();
    expect(attachmentZipPath("/api/files/ws_1")).toBeNull();
    expect(attachmentZipPath("/api/files/ws_1/../evil.png")).toBeNull();
    expect(attachmentZipPath("/api/files/ws_1/sub/abc.png")).toBeNull();
  });

  it("rewrites upload URLs in exported markdown to the bundled relative path", () => {
    const md = '![shot](/api/files/ws_1/abc.png) and [doc](/api/files/ws_1/notes.pdf)';
    expect(rewriteAttachments(md)).toBe(
      "![shot](attachments/abc.png) and [doc](attachments/notes.pdf)",
    );
  });

  it("leaves data:, foreign and trailing-punctuation URLs alone", () => {
    const md =
      "![a](data:image/png;base64,xyz) ![b](https://example.com/x.png) see /api/files/ws_1/abc.png.";
    expect(rewriteAttachments(md)).toBe(
      "![a](data:image/png;base64,xyz) ![b](https://example.com/x.png) see attachments/abc.png.",
    );
  });
});

// ---------------------------------------------------------------------------
// Zip assembly (MISSING_FEATURES §12: export as zip + with attachments)
// ---------------------------------------------------------------------------

describe("buildWorkspaceZip", () => {
  const exportedAt = new Date("2026-01-02T03:04:05.000Z");

  it("bundles pages, databases and attachments into a loadable archive with README + manifest", async () => {
    const bytes = await buildWorkspaceZip({
      workspaceName: "Acme",
      includeSubpages: true,
      exportedAt,
      files: [
        { path: "Guide.md", kind: "page", pageId: "p1", content: "# Guide\n" },
        { path: "Tasks/Tasks.csv", kind: "database", pageId: "p2", content: "Title\n" },
        {
          path: "attachments/abc.png",
          kind: "attachment",
          mimeType: "image/png",
          content: new Uint8Array([1, 2, 3]),
        },
      ],
    });

    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file("Guide.md")?.async("string")).toBe("# Guide\n");
    expect(await zip.file("Tasks/Tasks.csv")?.async("string")).toBe("Title\n");
    expect(await zip.file("README.md")?.async("string")).toContain("# Acme");
    const attachment = zip.file("attachments/abc.png");
    expect(attachment).not.toBeNull();
    expect(await attachment!.async("uint8array")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("writes a structure manifest describing the export and every file", async () => {
    const bytes = await buildWorkspaceZip({
      workspaceName: "Acme",
      includeSubpages: false,
      exportedAt,
      files: [
        { path: "Guide.md", kind: "page", pageId: "p1", content: "# Guide\n" },
        { path: "Guide.csv", kind: "database", pageId: "p2", content: "Title\n" },
      ],
    });

    const zip = await JSZip.loadAsync(bytes);
    const manifestFile = zip.file("manifest.json");
    expect(manifestFile).not.toBeNull();
    const manifest = JSON.parse(await manifestFile!.async("string")) as {
      workspace: string;
      exportedAt: string;
      includeSubpages: boolean;
      files: Array<{ path: string; kind: string; pageId: string }>;
    };
    expect(manifest.workspace).toBe("Acme");
    expect(manifest.exportedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(manifest.includeSubpages).toBe(false);
    expect(manifest.files).toEqual([
      { path: "Guide.md", kind: "page", pageId: "p1" },
      { path: "Guide.csv", kind: "database", pageId: "p2" },
    ]);
  });

  it("deduplicates colliding file paths", async () => {
    const bytes = await buildWorkspaceZip({
      workspaceName: "Acme",
      includeSubpages: true,
      exportedAt,
      files: [
        { path: "Page.md", kind: "page", pageId: "p1", content: "one" },
        { path: "Page.md", kind: "page", pageId: "p2", content: "two" },
      ],
    });
    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file("Page.md")?.async("string")).toBe("one");
    expect(await zip.file("Page (1).md")?.async("string")).toBe("two");
  });

  it("a page called README cannot clobber the archive's own README", async () => {
    const bytes = await buildWorkspaceZip({
      workspaceName: "Acme",
      includeSubpages: true,
      exportedAt,
      files: [{ path: "README.md", kind: "page", pageId: "p1", content: "page body" }],
    });
    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file("README (1).md")?.async("string")).toBe("page body");
    expect(await zip.file("README.md")?.async("string")).toContain("# Acme");
  });
});
