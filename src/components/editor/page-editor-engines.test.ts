import { describe, it, expect, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";

// `page-editor.tsx` pulls in the browser-only KaTeX stylesheet and a server
// action; stub both so the pure engine helpers can be imported under vitest's
// node environment.
vi.mock("katex/dist/katex.min.css", () => ({}));
vi.mock("@/server/actions/pages", () => ({
  updatePageAction: vi.fn(),
  getPageContentAction: vi.fn(),
}));

import {
  cleanClipboardHtml,
  planBlockReorder,
  planClipboardImages,
  restrictMathLatex,
  topLevelBlockIds,
} from "@/components/editor/page-editor";

/**
 * These tests exercise the *pure* handler logic the editor now delegates to the
 * previously-unwired engines: the paste-cleanup sanitiser, the clipboard-image
 * planner, the block-selection/block-move range logic and the math guard. The
 * React/TipTap plumbing around them is deliberately out of scope here.
 */

describe("cleanClipboardHtml (paste-cleanup engine)", () => {
  it("drops scripts, event handlers and javascript: URLs", () => {
    const cleaned = cleanClipboardHtml(
      '<p onclick="evil()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>',
    );
    expect(cleaned.html).not.toContain("script");
    expect(cleaned.html).not.toContain("onclick");
    expect(cleaned.html).not.toContain("javascript:");
    expect(cleaned.html).toContain("hi");
    expect(cleaned.html).toContain("<a>x</a>");
  });

  it("keeps Noema block structure, colours and task state on a notion-fingerprinted copy", () => {
    // The editor's own BlockIds extension renders `data-block-id`, which
    // `detectSource` fingerprints as Notion — the style strip must NOT fire, or
    // an internal copy/paste would lose real text colour.
    const source =
      '<h1 data-block-id="b1" data-block-color="gray">T</h1>' +
      '<p style="color: #ff0000" data-block-color="gray">x</p>' +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">y</li></ul>';
    const cleaned = cleanClipboardHtml(source);
    expect(cleaned.source).toBe("notion");
    expect(cleaned.html).toContain('data-block-color="gray"');
    expect(cleaned.html).toContain('data-type="taskList"');
    expect(cleaned.html).toContain('data-checked="true"');
    expect(cleaned.html).toContain("color: #ff0000");
    // The internal id is not part of the paste contract; new blocks mint theirs.
    expect(cleaned.html).not.toContain("data-block-id");
  });

  it("strips Word mso-* noise and reports the source cleanup catalogue", () => {
    const cleaned = cleanClipboardHtml(
      '<p class="MsoNormal" style="mso-spacerun:yes">Hello</p>',
    );
    expect(cleaned.source).toBe("word");
    expect(cleaned.cleanups.some((step) => step.id === "word:mso-styles")).toBe(true);
    expect(cleaned.html).not.toContain("mso-");
    expect(cleaned.html).not.toContain("MsoNormal");
    expect(cleaned.html).toContain("Hello");
  });

  it("reports a generic source with no extra cleanups and drops embedded data URLs", () => {
    const cleaned = cleanClipboardHtml('<p>x</p><img src="data:image/png;base64,QUJD">');
    expect(cleaned.source).toBe("generic");
    expect(cleaned.cleanups).toEqual([]);
    expect(cleaned.html).not.toContain("data:image");
    expect(cleaned.html).toContain("x");
  });
});

describe("planClipboardImages (clipboard-image engine)", () => {
  it("accepts and names an allowed image file", () => {
    const plan = planClipboardImages({
      files: [{ name: "shot.png", mimeType: "image/png", size: 2048 }],
      now: new Date("2026-01-02T15:30:00Z"),
    });
    expect(plan.skipped).toEqual([]);
    expect(plan.uploads).toHaveLength(1);
    expect(plan.uploads[0]).toMatchObject({
      source: "file",
      fileIndex: 0,
      mimeType: "image/png",
      name: "pasted-shot-2026-01-02-1530.png",
    });
  });

  it("refuses a non-image file", () => {
    const plan = planClipboardImages({
      files: [{ name: "doc.pdf", mimeType: "application/pdf", size: 10 }],
    });
    expect(plan.uploads).toEqual([]);
    expect(plan.skipped.map((skip) => skip.reason)).toContain("unsupported-type");
  });

  it("resolves a blank/generic MIME from the file-name extension", () => {
    const gif = planClipboardImages({
      files: [{ name: "animation.gif", mimeType: "", size: 2048 }],
      now: new Date("2026-01-02T15:30:00Z"),
    });
    expect(gif.skipped).toEqual([]);
    expect(gif.uploads[0]).toMatchObject({
      source: "file",
      fileIndex: 0,
      mimeType: "image/gif",
      name: "pasted-animation-2026-01-02-1530.gif",
    });

    const generic = planClipboardImages({
      files: [{ name: "shot.png", mimeType: "application/octet-stream", size: 1 }],
    });
    expect(generic.uploads[0]).toMatchObject({ mimeType: "image/png", fileIndex: 0 });
  });

  it("extracts an embedded data: image from the HTML flavour", () => {
    const plan = planClipboardImages({
      files: [],
      html: '<p>x</p><img alt="a" src="data:image/png;base64,QUJD">',
      now: new Date("2026-01-02T15:30:00Z"),
    });
    expect(plan.uploads).toHaveLength(1);
    expect(plan.uploads[0]).toMatchObject({
      source: "data-url",
      mimeType: "image/png",
      data: "QUJD",
      name: "pasted-image-2026-01-02-1530.png",
    });
  });

  it("enforces the per-item size cap", () => {
    const plan = planClipboardImages({
      files: [{ name: "big.png", mimeType: "image/png", size: 5000 }],
      maxBytes: 1000,
    });
    expect(plan.uploads).toEqual([]);
    expect(plan.skipped.map((skip) => skip.reason)).toContain("too-large");
  });

  it("rejects an unsafe SVG (script / event handler)", () => {
    const svg = Buffer.from('<svg onload="x()"></svg>').toString("base64");
    const plan = planClipboardImages({
      files: [],
      html: `<img src="data:image/svg+xml;base64,${svg}">`,
    });
    expect(plan.uploads).toEqual([]);
    expect(plan.skipped.map((skip) => skip.reason)).toContain("unsafe-svg");
  });
});

describe("planBlockReorder (block-selection + block-move engines)", () => {
  const ids = ["a", "b", "c", "d"];

  it("returns null without a multi-block range", () => {
    expect(planBlockReorder(ids, null, 0)).toBeNull();
    expect(planBlockReorder(ids, { anchorId: "a", headId: "a" }, 3)).toBeNull();
  });

  it("reorders a contiguous range after a later block", () => {
    expect(planBlockReorder(ids, { anchorId: "a", headId: "b" }, 3)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("reorders a range to the top of the document", () => {
    expect(planBlockReorder(ids, { anchorId: "b", headId: "c" }, 0)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });
});

describe("topLevelBlockIds", () => {
  it("reads the id attribute of every top-level block in order", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*", attrs: { id: { default: null } } },
        text: { group: "inline" },
      },
    });
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "A" }] },
        { type: "paragraph", attrs: { id: "b" } },
      ],
    });
    expect(topLevelBlockIds(doc)).toEqual(["a", "b"]);
  });
});

describe("restrictMathLatex (math-render engine)", () => {
  it("leaves ordinary latex untouched", () => {
    expect(restrictMathLatex("\\frac{a}{b} + x^2")).toBe("\\frac{a}{b} + x^2");
  });

  it("strips banned commands and their arguments", () => {
    expect(restrictMathLatex("\\input{secret} x")).toBe(" x");
    expect(restrictMathLatex("a\\write18{rm -rf} b")).toBe("a b");
  });
});
