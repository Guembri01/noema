import { describe, expect, it } from "vitest";
import { LONG_DOC_WORD_THRESHOLD, auditDocument, isCleanReport, summarizeAudit } from "./a11y-audit";
import type { A11yBlock, AuditIssue } from "./a11y-audit";

/* ------------------------------------------------------------------ helpers */

const paragraph = (id: string, text: string): A11yBlock => ({ id, type: "paragraph", text });

const heading = (id: string, level: number, text = ""): A11yBlock => ({
  id,
  type: "heading",
  text,
  attrs: { level },
});

const image = (id: string, alt?: string): A11yBlock => ({
  id,
  type: "image",
  attrs: alt === undefined ? {} : { alt },
});

const callout = (id: string, text: string): A11yBlock => ({ id, type: "callout", text });

const inline = (id: string, text: string, marks: A11yBlock["marks"]): A11yBlock => ({
  id,
  type: "text",
  text,
  marks,
});

const cell = (id: string, type = "tableCell"): A11yBlock => ({ id, type, text: "x" });

const row = (id: string, cells: A11yBlock[]): A11yBlock => ({ id, type: "tableRow", children: cells });

const table = (
  id: string,
  children: A11yBlock[],
  attrs: Record<string, unknown> = {},
): A11yBlock => ({ id, type: "table", children, attrs });

const codesOf = (issues: AuditIssue[]): string[] => issues.map((issue) => issue.code);

/** A body long enough to trip the "no heading in a long document" rule. */
const longBody = Array.from({ length: LONG_DOC_WORD_THRESHOLD + 20 }, (_, i) => `word${i}`).join(" ");

/* ------------------------------------------------------------------- tests */

describe("auditDocument", () => {
  it("reports nothing for a short, well-formed document", () => {
    expect(auditDocument([heading("h1", 1, "Title"), paragraph("p1", "Hello world")])).toEqual([]);
  });

  it("flags an image with no alt text", () => {
    const issues = auditDocument([image("img1")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ blockId: "img1", code: "image-alt", severity: "error" });
  });

  it("accepts an image whose alt text is present", () => {
    expect(auditDocument([image("img1", "A cat sleeping")])).toEqual([]);
  });

  it("treats a whitespace-only alt as missing", () => {
    expect(codesOf(auditDocument([image("img1", "   ")]))).toEqual(["image-alt"]);
  });

  it("flags a heading that skips a level", () => {
    const issues = auditDocument([heading("h1", 1), heading("h3", 3)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ blockId: "h3", code: "heading-skip", severity: "warning" });
  });

  it("allows consecutive heading levels", () => {
    expect(auditDocument([heading("h1", 1), heading("h2", 2), heading("h3", 3)])).toEqual([]);
  });

  it("does not flag the first heading whatever its level", () => {
    expect(auditDocument([heading("h3", 3)])).toEqual([]);
  });

  it("flags only the downward skip, not a heading that steps back up", () => {
    expect(codesOf(auditDocument([heading("h1", 1), heading("h3", 3), heading("h2", 2)]))).toEqual([
      "heading-skip",
    ]);
  });

  it("flags a link mark with no text", () => {
    const issues = auditDocument([inline("l1", "", [{ type: "link", attrs: { href: "/x" } }])]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ blockId: "l1", code: "empty-link", severity: "error" });
  });

  it("accepts a link that has text", () => {
    expect(auditDocument([inline("l1", "Docs", [{ type: "link", attrs: { href: "/x" } }])])).toEqual([]);
  });

  it("flags a link whose text is only whitespace", () => {
    expect(codesOf(auditDocument([inline("l1", "   ", [{ type: "link" }])]))).toEqual(["empty-link"]);
  });

  it("flags emphasis carried by colour alone", () => {
    const issues = auditDocument([
      inline("c1", "Warning", [{ type: "textStyle", attrs: { color: "#ff0000" } }]),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ blockId: "c1", code: "color-only", severity: "warning" });
  });

  it("accepts coloured text that also has a semantic mark", () => {
    const blocks = [
      inline("c2", "Warning", [
        { type: "bold" },
        { type: "textStyle", attrs: { color: "#ff0000" } },
      ]),
    ];
    expect(auditDocument(blocks)).toEqual([]);
  });

  it("accepts a coloured link (link is semantic)", () => {
    const blocks = [
      inline("c3", "Read", [
        { type: "link", attrs: { href: "/x" } },
        { type: "textStyle", attrs: { color: "#0000ff" } },
      ]),
    ];
    expect(auditDocument(blocks)).toEqual([]);
  });

  it("ignores unmarked text and non-colour styling", () => {
    expect(auditDocument([inline("c4", "Plain", [])])).toEqual([]);
    expect(auditDocument([inline("c5", "Big", [{ type: "textStyle", attrs: { fontSize: "2em" } }])])).toEqual(
      [],
    );
  });

  it("flags a table without a header row", () => {
    const issues = auditDocument([table("t1", [row("r1", [cell("c1"), cell("c2")])])]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ blockId: "t1", code: "table-no-header", severity: "warning" });
  });

  it("accepts a table whose first row holds header cells", () => {
    const blocks = [table("t1", [row("r1", [cell("c1", "tableHeader"), cell("c2")])])];
    expect(auditDocument(blocks)).toEqual([]);
  });

  it("accepts a table that declares a header row in its attrs", () => {
    expect(auditDocument([table("t1", [row("r1", [cell("c1")])], { hasHeaderRow: true })])).toEqual([]);
  });

  it("flags an empty callout", () => {
    const issues = auditDocument([callout("co1", "")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ blockId: "co1", code: "empty-callout", severity: "info" });
  });

  it("accepts a callout with content", () => {
    expect(auditDocument([callout("co1", "Note")])).toEqual([]);
  });

  it("flags a long document that never uses a heading", () => {
    const issues = auditDocument([paragraph("p1", longBody)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ blockId: "p1", code: "no-heading", severity: "info" });
  });

  it("accepts a long document once it has a heading", () => {
    expect(auditDocument([heading("h1", 1, "Title"), paragraph("p1", longBody)])).toEqual([]);
  });

  it("does not flag a short document without headings", () => {
    expect(auditDocument([paragraph("p1", "just a short note")])).toEqual([]);
  });

  it("returns issues in document order", () => {
    const issues = auditDocument([heading("h1", 1), image("img1"), heading("h3", 3)]);
    expect(codesOf(issues)).toEqual(["image-alt", "heading-skip"]);
  });

  it("never throws on malformed blocks", () => {
    const garbage = [
      null as unknown as A11yBlock,
      undefined as unknown as A11yBlock,
      42 as unknown as A11yBlock,
      { id: 1, type: 2 } as unknown as A11yBlock,
      { id: "b", type: "paragraph", children: [null, 7] as unknown as A11yBlock[] },
    ];
    expect(() => auditDocument(garbage)).not.toThrow();
    expect(auditDocument(garbage)).toEqual([]);
  });

  it("survives a cyclic block tree", () => {
    const a: A11yBlock = { id: "a", type: "paragraph", text: "hi" };
    const b: A11yBlock = { id: "b", type: "paragraph", children: [a] };
    (a as { children?: A11yBlock[] }).children = [b];
    expect(() => auditDocument([a])).not.toThrow();
    expect(auditDocument([a])).toEqual([]);
  });

  it("returns [] for a non-array argument", () => {
    expect(auditDocument(null as unknown as A11yBlock[])).toEqual([]);
  });
});

describe("summarizeAudit", () => {
  it("summarises an empty report", () => {
    expect(summarizeAudit([])).toEqual({
      total: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      byCode: {},
    });
  });

  it("counts issues by severity and by code", () => {
    const issues: AuditIssue[] = [
      { blockId: "a", code: "image-alt", severity: "error", message: "x" },
      { blockId: "b", code: "empty-link", severity: "error", message: "x" },
      { blockId: "c", code: "heading-skip", severity: "warning", message: "x" },
      { blockId: "d", code: "no-heading", severity: "info", message: "x" },
    ];
    expect(summarizeAudit(issues)).toEqual({
      total: 4,
      errors: 2,
      warnings: 1,
      infos: 1,
      byCode: { "image-alt": 1, "empty-link": 1, "heading-skip": 1, "no-heading": 1 },
    });
  });

  it("counts repeated codes", () => {
    const issues = auditDocument([image("i1"), image("i2")]);
    expect(summarizeAudit(issues)).toMatchObject({ total: 2, errors: 2, byCode: { "image-alt": 2 } });
  });
});

describe("isCleanReport", () => {
  it("is true for an empty report", () => {
    expect(isCleanReport([])).toBe(true);
  });

  it("is false when an error is present", () => {
    expect(
      isCleanReport([{ blockId: "a", code: "image-alt", severity: "error", message: "x" }]),
    ).toBe(false);
  });

  it("is false when a warning is present", () => {
    expect(
      isCleanReport([{ blockId: "a", code: "heading-skip", severity: "warning", message: "x" }]),
    ).toBe(false);
  });

  it("is true when only advisories are present", () => {
    expect(
      isCleanReport([{ blockId: "a", code: "no-heading", severity: "info", message: "x" }]),
    ).toBe(true);
  });
});
