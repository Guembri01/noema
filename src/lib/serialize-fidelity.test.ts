/**
 * B86 — export/serialize fidelity (HTML + Markdown), red-first.
 *
 * Pure unit pins over `src/lib/serialize.ts` (HTML: `blockHtml`/`inlineHtml`/
 * `docToHtml`/`pageToHtml`; Markdown: `pageToMarkdown`) and `docToMarkdown`
 * in `src/lib/blocks.ts` (the page Markdown export path), plus
 * `markdownToDoc` where it consumes what the exporters emit (round-trip).
 * Trace: B23 audit → `docs/specs/import-export.md` §2.1 (D23.6),
 * requirements R23.13 / R23.14. Explicit expect lists, no snapshots.
 *
 * Red-first evidence: the first revision of this file asserted the
 * SPEC-DESIRED behavior (plus deliberate control mismatches) and failed
 * 14/19 against the current tree. That red run
 * is what proves each assertion below bites.
 *
 * KNOWN-GAP policy: this change is TEST-ONLY, so where current behavior
 * deviates from the spec the assertion PINS current behavior with a
 * `KNOWN GAP (R23.x)` comment naming the desired output — flipping the pin
 * when M3a (T23.10) lands is the whole point of the comment. No skipped or
 * xfailed tests (tier rule).
 *
 * Off-limits honored: export routes + format allowlist (B91 — the
 * unknown-format→400 contract lives in `src/lib/export-format.ts` and
 * `api/export/*`, deliberately not asserted here) and importers
 * (B71 — `src/server/actions/import.ts`).
 */

import { describe, expect, it } from "vitest";
import { docToHtml, markdownToDoc, pageToHtml, pageToMarkdown } from "@/lib/serialize";
import { docToMarkdown, type BlockDoc, type RichNode } from "@/lib/blocks";

/* ---------------------------------- fixtures ---------------------------------- */

const text = (t: string): RichNode => ({ type: "text", text: t });
const para = (...content: RichNode[]): RichNode => ({ type: "paragraph", content });
const heading = (level: number | undefined, t: string): RichNode => ({
  type: "heading",
  ...(level === undefined ? {} : { attrs: { level } }),
  content: [text(t)],
});
const doc = (...content: RichNode[]): BlockDoc => ({ type: "doc", content });

const tableDoc = (): BlockDoc =>
  doc({
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          { type: "tableHeader", content: [para(text("Name"))] },
          { type: "tableHeader", content: [para(text("Qty"))] },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [para(text("Widget <big>"))] },
          { type: "tableCell", content: [para(text("3"))] },
        ],
      },
    ],
  });

const imageDoc = (): BlockDoc =>
  doc({
    type: "image",
    attrs: { src: "/api/files/1.png", alt: 'A <red> & "blue"', caption: "My caption" },
  });

/* ------------------------------- heading levels ------------------------------- */

describe("B86 heading levels", () => {
  it("HTML: renders h1-h6 verbatim with matching close tags", () => {
    const html = docToHtml(
      doc(
        heading(1, "One"),
        heading(2, "Two"),
        heading(3, "Three"),
        heading(4, "Four"),
        heading(5, "Five"),
        heading(6, "Six"),
      ),
    );
    for (const [level, label] of [[1, "One"], [2, "Two"], [3, "Three"], [4, "Four"], [5, "Five"], [6, "Six"]] as const) {
      expect(html).toContain(`<h${level}>${label}</h${level}>`);
    }
    expect(html).not.toContain("<h7>");
    expect(html.split("\n")).toHaveLength(6);
  });

  it("HTML: clamps out-of-range and missing levels into h1..h6", () => {
    const html = docToHtml(doc(heading(0, "Zero"), heading(9, "Nine"), heading(undefined, "NoLevel")));
    expect(html).toContain("<h1>Zero</h1>");
    expect(html).toContain("<h6>Nine</h6>");
    expect(html).toContain("<h1>NoLevel</h1>");
    expect(html).not.toContain("<h0>");
    expect(html).not.toContain("<h9>");
  });

  it("Markdown: emits #..###### with the same clamping", () => {
    const md = docToMarkdown(doc(heading(1, "One"), heading(6, "Six"), heading(0, "Zero"), heading(9, "Nine")));
    expect(md).toBe("# One\n\n###### Six\n\n# Zero\n\n###### Nine");
  });

  it("Markdown: pageToMarkdown titles the page as a single H1", () => {
    expect(pageToMarkdown("My page", doc(para(text("body"))))).toBe("# My page\n\nbody\n");
  });

  it("KNOWN GAP: markdown import clamps ###### / #### to level 3 (editor supports h1-h6)", () => {
    // serialize.ts markdownToDoc: attrs.level = Math.min(#.length, 3).
    // Desired: round-trip preserves levels 4-6 ("h4-h6 everywhere").
    // Red run asserted level 6 / level 4 here and failed (got 3 / 3).
    const back = markdownToDoc("###### Six\n\n#### Four");
    expect(back.content[0].type).toBe("heading");
    expect(back.content[0].attrs?.level).toBe(3);
    expect(back.content[0].content?.[0].text).toBe("Six");
    expect(back.content[1].attrs?.level).toBe(3);
    expect(back.content[1].content?.[0].text).toBe("Four");
  });
});

/* --------------------------------- lang / dir --------------------------------- */

describe("B86 pageToHtml lang/dir", () => {
  it("KNOWN GAP (R23.14): standalone shell pins lang=en and no dir attribute", () => {
    const html = pageToHtml("A < B & C", doc(para(text("x"))));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8"/>');
    expect(html).toContain("<title>A &lt; B &amp; C</title>");
    // Current: lang is hardcoded "en" (serialize.ts pageToHtml) and dir is
    // never emitted. Desired (R23.14): lang + dir="rtl" derived from the
    // exporting user's locale. Red run asserted /<html[^>]*\bdir="/ and failed.
    expect(html).toContain('<html lang="en">');
    expect(html).not.toMatch(/<html[^>]*\bdir=/);
  });
});

/* ------------------------------------ math ------------------------------------ */

describe("B86 math handling", () => {
  it("KNOWN GAP (R23.13): inline math renders as <code>, LaTeX escaped", () => {
    const html = docToHtml(
      doc(para(text("a "), { type: "inlineMath", attrs: { latex: "E=mc^2 & more < less" } }, text(" b"))),
    );
    // Current (serialize.ts inlineHtml): inlineMath → <code>latex</code>.
    // Desired (R23.13): <span class="math-literal">…</span> (+ optional
    // KaTeX reference). Red run asserted the span and failed.
    expect(html).toBe("<p>a <code>E=mc^2 &amp; more &lt; less</code> b</p>");
  });

  it("KNOWN GAP (R23.13): block math renders as <div class=\"math\">, LaTeX escaped", () => {
    const html = docToHtml(doc({ type: "blockMath", attrs: { latex: "\\frac{a}{b} < x" } }));
    // Current: <div class="math">. Desired (R23.13 names inline AND block
    // math): span.math-literal. Red run asserted the span and failed.
    expect(html).toBe('<div class="math">\\frac{a}{b} &lt; x</div>');
  });

  it("Markdown: math exports as $inline$ and $$block$$", () => {
    const md = docToMarkdown(
      doc(
        para(text("a "), { type: "inlineMath", attrs: { latex: "E=mc^2" } }, text(" b")),
        { type: "blockMath", attrs: { latex: "\\frac{a}{b}" } },
      ),
    );
    expect(md).toBe("a $E=mc^2$ b\n\n$$\n\\frac{a}{b}\n$$");
  });

  it("KNOWN GAP: exported $math$ re-imports as literal text, not an inlineMath node", () => {
    const md = docToMarkdown(doc(para({ type: "inlineMath", attrs: { latex: "E=mc^2" } })));
    expect(md).toBe("$E=mc^2$");
    // markdownToDoc's parseInline has no $…$ rule: the node degrades to a
    // text run that still contains the delimiters. Red run asserted an
    // inlineMath node and failed.
    const back = markdownToDoc(md);
    expect(back.content[0].type).toBe("paragraph");
    expect(back.content[0].content).toHaveLength(1);
    expect(back.content[0].content?.[0].type).toBe("text");
    expect(back.content[0].content?.[0].text).toBe("$E=mc^2$");
  });
});

/* -------------------------------- table fidelity ------------------------------ */

describe("B86 table fidelity", () => {
  it("HTML: nested table>tbody>tr>th/td structure with escaped cell text", () => {
    const html = docToHtml(tableDoc());
    expect(html).toBe(
      '<table><tbody><tr><th><p>Name</p></th><th><p>Qty</p></th></tr>' +
        '<tr><td><p>Widget &lt;big&gt;</p></td><td><p>3</p></td></tr></tbody></table>',
    );
    expect(html).not.toContain("&amp;lt;");
  });

  it("KNOWN GAP: markdown table rows are separated by blank lines (breaks GFM tables)", () => {
    const md = docToMarkdown(tableDoc());
    // Current: docToMarkdown joins every emitted line with "\n\n", so the
    // pipe rows come out blank-line separated — CommonMark/GFM then renders
    // them as three literal pipe paragraphs instead of one table.
    // Desired: contiguous rows + delimiter row. Red run asserted contiguous
    // rows ("| Name | Qty |\n| --- | …") and failed.
    expect(md.split("\n\n")).toEqual([
      "| Name | Qty |",
      "| --- | --- |",
      "| Widget <big> | 3 |",
    ]);
  });

  it("KNOWN GAP: exported table does not round-trip — import yields 3 paragraphs", () => {
    // markdownToDoc has no table syntax, so the exported pipe rows become
    // plain paragraphs. Red run asserted a table node and failed.
    const back = markdownToDoc(docToMarkdown(tableDoc()));
    expect(back.content.map((n) => n.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(back.content[0].content?.[0].text).toBe("| Name | Qty |");
    expect(back.content[1].content?.[0].text).toBe("| --- | --- |");
  });
});

/* ---------------------------- image alt / caption ----------------------------- */

describe("B86 image alt/caption round-trip", () => {
  it("HTML: emits <img src alt> with both attributes escaped", () => {
    const html = docToHtml(imageDoc());
    expect(html).toBe('<img src="/api/files/1.png" alt="A &lt;red&gt; &amp; &quot;blue&quot;"/>');
    expect(html).not.toContain("&amp;lt;");
  });

  it("KNOWN GAP: image caption is dropped from HTML export", () => {
    // FEATURE_MATRIX marks "Image captions ✅" (stored on the node as
    // attrs.caption, image-block.tsx), but blockHtml's image case ignores it.
    // Desired: caption preserved (text or data-caption attr) in the
    // downloaded file. Red run asserted "My caption" present and failed.
    const html = docToHtml(imageDoc());
    expect(html).not.toContain("My caption");
    expect(html).not.toContain("data-caption");
  });

  it("KNOWN GAP: image caption is dropped from Markdown export", () => {
    // Desired: caption exported alongside ![alt](src). Red run asserted it
    // present and failed.
    const md = docToMarkdown(imageDoc());
    expect(md).toBe('![A <red> & "blue"](/api/files/1.png)');
    expect(md).not.toContain("My caption");
  });

  it("KNOWN GAP: re-importing exported image markdown yields a link, not an image", () => {
    // markdownToDoc's parseInline matches [alt](src) but has no ![…] rule,
    // so the "!" stays as literal text and the image node is lost.
    // Red run asserted {type:"image"} and failed (got paragraph).
    const back = markdownToDoc(docToMarkdown(imageDoc()));
    const node = back.content[0];
    expect(node.type).toBe("paragraph");
    expect(node.content?.map((n) => n.type)).toEqual(["text", "text"]);
    expect(node.content?.[0].text).toBe("!");
    expect(node.content?.[1].text).toBe('A <red> & "blue"');
    expect(node.content?.[1].marks?.[0].type).toBe("link");
    expect(node.content?.[1].marks?.[0].attrs?.href).toBe("/api/files/1.png");
  });
});

/* ------------------------------ unknown-node fallback ------------------------- */

describe("B86 unknown-node fallback", () => {
  it("KNOWN GAP (R23.13 wording): unknown block renders children bare, no data-block-type", () => {
    // blockHtml's default: joins readable children with NO wrapper. R23.13's
    // parenthetical claims the default already emits
    // <div data-block-type="…"> — it does not (spec wording ahead of code).
    // Red run asserted the wrapper and failed.
    const html = docToHtml(doc({ type: "futureBlock", attrs: { foo: 1 }, content: [para(text("child"))] }));
    expect(html).toBe("<p>child</p>");
    expect(html).not.toContain("data-block-type");
  });

  it("empty/absent doc renders an empty fragment", () => {
    expect(docToHtml({ type: "doc" })).toBe("");
    expect(docToHtml(null)).toBe("");
  });
});
