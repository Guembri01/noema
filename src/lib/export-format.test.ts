import { describe, expect, it } from "vitest";
import {
  DATABASE_EXPORT_FORMATS,
  PAGE_EXPORT_FORMATS,
  WORKSPACE_EXPORT_FORMATS,
  parseExportFormat,
} from "@/lib/export-format";

/**
 * B55 — R23.16 "explicit format contract": `?format=` on an export route is
 * validated against a per-route allowlist; an unknown value must be a 400,
 * never a silent fallback (page export used to fall through to Markdown).
 * B91 adds `json` to the database allowlist (R23.16: `?format=csv|json`).
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
