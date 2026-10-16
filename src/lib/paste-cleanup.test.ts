import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOWED_ATTRS,
  DEFAULT_ALLOWED_TAGS,
  PLAIN_ALLOWED_TAGS,
  detectSource,
  describePaste,
  linkifyText,
  normalizeNestedMarks,
  sanitizePaste,
  sourceCleanups,
  stripInlineStyles,
  toPlainText,
} from "./paste-cleanup";

/**
 * Paste sanitisation engine (FEATURE_MATRIX §2 "Paste with formatting",
 * "Paste without formatting").
 *
 * Red-first: the parser, the tag/attribute allowlists and the URL policy pinned
 * here are product decisions. The module is pure and editor-agnostic — it deals
 * only in HTML strings, never the DOM — so every expectation is byte-stable.
 */

describe("toPlainText", () => {
  it("keeps paragraphs as separate lines", () => {
    expect(toPlainText("<p>Hello world</p>")).toBe("Hello world");
    expect(toPlainText("<p>a</p><p>b</p>")).toBe("a\nb");
  });

  it("collapses runs of whitespace", () => {
    expect(toPlainText("<p>Hello   \n\t  world</p>")).toBe("Hello world");
  });

  it("renders headings and blockquotes as lines", () => {
    expect(toPlainText("<h1>Title</h1><p>Body</p>")).toBe("Title\nBody");
    expect(toPlainText("<blockquote><p>quote</p></blockquote>")).toBe("quote");
  });

  it("prefixes unordered and ordered list items", () => {
    expect(toPlainText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
    expect(toPlainText("<ol><li>one</li><li>two</li></ol>")).toBe("1. one\n2. two");
  });

  it("renders tables as pipe-separated lines", () => {
    const html =
      "<table><thead><tr><th>H1</th><th>H2</th></tr></thead>" +
      "<tbody><tr><td>a</td><td>b</td></tr></tbody></table>";
    expect(toPlainText(html)).toBe("H1 | H2\na | b");
  });

  it("decodes entities and drops dangerous content", () => {
    expect(toPlainText("<p>Tom &amp; Jerry</p>")).toBe("Tom & Jerry");
    expect(toPlainText("<p>ok</p><script>alert(1)</script>")).toBe("ok");
  });

  it("marks horizontal rules and ignores unknown inline wrappers", () => {
    expect(toPlainText("<p>a</p><hr><p>b</p>")).toBe("a\n---\nb");
    expect(toPlainText("<p>Hello <span>there</span></p>")).toBe("Hello there");
  });
});

describe("sanitizePaste — XSS vectors", () => {
  it("removes script and style elements with their content", () => {
    expect(sanitizePaste("<p>ok</p><script>alert(1)</script>")).toBe("<p>ok</p>");
    expect(sanitizePaste("<style>p{color:red}</style><p>ok</p>")).toBe("<p>ok</p>");
  });

  it("removes iframes, objects, svg and embeds", () => {
    expect(sanitizePaste('<iframe src="https://evil.test"></iframe>')).toBe("");
    expect(sanitizePaste('<svg><script>alert(1)</script></svg>')).toBe("");
    expect(sanitizePaste('<object data="evil.swf"></object>')).toBe("");
  });

  it("drops images and their event handlers", () => {
    expect(sanitizePaste('<img src="x" onerror="alert(1)">')).toBe("");
  });

  it("strips event-handler attributes", () => {
    expect(sanitizePaste('<p onclick="evil()">hi</p>')).toBe("<p>hi</p>");
    expect(sanitizePaste('<b onmouseover="x()">hi</b>')).toBe("<b>hi</b>");
  });

  it("rejects javascript: hrefs", () => {
    expect(sanitizePaste('<a href="javascript:alert(1)">click</a>')).toBe("<a>click</a>");
    expect(sanitizePaste('<a href="JaVaScRiPt:alert(1)">click</a>')).toBe("<a>click</a>");
  });

  it("rejects data: and other non-allowlisted schemes", () => {
    expect(sanitizePaste('<a href="data:text/html;base64,PHN2Zz4=">x</a>')).toBe("<a>x</a>");
    expect(sanitizePaste('<a href="file:///etc/passwd">x</a>')).toBe("<a>x</a>");
    expect(sanitizePaste('<a href="vbscript:msgbox(1)">x</a>')).toBe("<a>x</a>");
  });

  it("neutralises schemes split by control characters", () => {
    expect(sanitizePaste('<a href="java\nscript:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("keeps http, https and mailto hrefs", () => {
    expect(sanitizePaste('<a href="https://safe.test">ok</a>')).toBe(
      '<a href="https://safe.test">ok</a>',
    );
    expect(sanitizePaste('<a href="http://safe.test">ok</a>')).toBe(
      '<a href="http://safe.test">ok</a>',
    );
    expect(sanitizePaste('<a href="mailto:a@b.test">ok</a>')).toBe(
      '<a href="mailto:a@b.test">ok</a>',
    );
  });
});

describe("sanitizePaste — structure and marks", () => {
  it("preserves allowed marks", () => {
    const html = "<p><b>bold</b> <strong>s</strong> <i>i</i> <em>e</em> <u>u</u> <s>s</s> <code>c</code></p>";
    expect(sanitizePaste(html)).toBe(html);
  });

  it("preserves headings, lists, blockquotes, hr and pre/code", () => {
    expect(sanitizePaste("<h2>T</h2>")).toBe("<h2>T</h2>");
    expect(sanitizePaste("<ul><li>a</li></ul>")).toBe("<ul><li>a</li></ul>");
    expect(sanitizePaste("<blockquote><p>q</p></blockquote>")).toBe(
      "<blockquote><p>q</p></blockquote>",
    );
    expect(sanitizePaste("<hr>")).toBe("<hr>");
    expect(sanitizePaste("<pre><code>x=1</code></pre>")).toBe("<pre><code>x=1</code></pre>");
  });

  it("unwraps unknown wrappers but keeps their text", () => {
    expect(sanitizePaste("<div><p>hi</p></div>")).toBe("<p>hi</p>");
    expect(sanitizePaste('<font color="red">hi</font>')).toBe("hi");
    expect(sanitizePaste("<p><span>hi</span></p>")).toBe("<p>hi</p>");
  });

  it("removes comments and unlisted attributes", () => {
    expect(sanitizePaste("<p>a</p><!-- hidden --><p>b</p>")).toBe("<p>a</p><p>b</p>");
    expect(sanitizePaste('<p data-x="1">y</p>')).toBe("<p>y</p>");
  });

  it("keeps only the allowlisted attributes of an anchor", () => {
    expect(sanitizePaste('<a href="https://x.test" title="t" target="_blank">x</a>')).toBe(
      '<a href="https://x.test" title="t">x</a>',
    );
  });

  it("round-trips encoded entities", () => {
    expect(sanitizePaste("<p>a &amp; b</p>")).toBe("<p>a &amp; b</p>");
    expect(sanitizePaste('<a href="https://x.test/?a=1&amp;b=2">x</a>')).toBe(
      '<a href="https://x.test/?a=1&amp;b=2">x</a>',
    );
  });

  it("exposes the default allowlists", () => {
    expect(DEFAULT_ALLOWED_TAGS).toContain("strong");
    expect(DEFAULT_ALLOWED_TAGS).toContain("a");
    expect(DEFAULT_ALLOWED_ATTRS.a).toEqual(["href", "title"]);
  });
});

describe("sanitizePaste — options and plain mode", () => {
  it("honours a custom allowedTags list", () => {
    expect(sanitizePaste("<p><mark>x</mark></p>", { allowedTags: ["p", "mark"] })).toBe(
      "<p><mark>x</mark></p>",
    );
  });

  it("honours custom allowedAttrs", () => {
    expect(
      sanitizePaste('<p data-x="1">y</p>', { allowedTags: ["p"], allowedAttrs: { p: ["data-x"] } }),
    ).toBe('<p data-x="1">y</p>');
  });

  it("strips inline marks in plain mode", () => {
    expect(
      sanitizePaste('<p>Hi <b>there</b> <a href="https://x.test">link</a></p>', { mode: "plain" }),
    ).toBe("<p>Hi there link</p>");
  });

  it("keeps block structure in plain mode", () => {
    expect(PLAIN_ALLOWED_TAGS).toContain("h1");
    expect(sanitizePaste("<h1>T</h1><ul><li>a</li></ul>", { mode: "plain" })).toBe(
      "<h1>T</h1><ul><li>a</li></ul>",
    );
  });

  it("still removes dangerous content in plain mode", () => {
    expect(sanitizePaste("<p>ok</p><script>alert(1)</script>", { mode: "plain" })).toBe(
      "<p>ok</p>",
    );
  });
});

describe("stripInlineStyles", () => {
  it("removes style and class attributes", () => {
    expect(stripInlineStyles('<p style="color:red" class="x">Hi</p>')).toBe("<p>Hi</p>");
    expect(stripInlineStyles('<span class="a" style="b">x</span>')).toBe("<span>x</span>");
  });

  it("keeps unrelated attributes", () => {
    expect(stripInlineStyles('<a href="https://x.test" style="c">x</a>')).toBe(
      '<a href="https://x.test">x</a>',
    );
  });

  it("drops style elements", () => {
    expect(stripInlineStyles("<style>p{}</style><p>Hi</p>")).toBe("<p>Hi</p>");
  });

  it("recurses into nested nodes", () => {
    expect(stripInlineStyles('<ul><li class="i">a</li></ul>')).toBe("<ul><li>a</li></ul>");
  });
});

describe("normalizeNestedMarks", () => {
  it("collapses identical bold nesting", () => {
    expect(normalizeNestedMarks("<b><b>x</b></b>")).toBe("<b>x</b>");
    expect(normalizeNestedMarks("<strong><strong>x</strong></strong>")).toBe("<strong>x</strong>");
  });

  it("collapses equivalent marks within a group", () => {
    expect(normalizeNestedMarks("<em><i>x</i></em>")).toBe("<em>x</em>");
    expect(normalizeNestedMarks("<strong><b>x</b></strong>")).toBe("<strong>x</strong>");
  });

  it("collapses deep chains", () => {
    expect(normalizeNestedMarks("<b><b><b>x</b></b></b>")).toBe("<b>x</b>");
  });

  it("keeps distinct marks nested", () => {
    expect(normalizeNestedMarks("<b><i>x</i></b>")).toBe("<b><i>x</i></b>");
  });

  it("works inside a paragraph", () => {
    expect(normalizeNestedMarks("<p><b><b>hi</b></b></p>")).toBe("<p><b>hi</b></p>");
  });

  it("does not collapse mixed content", () => {
    expect(normalizeNestedMarks("<b><b>x</b>y</b>")).toBe("<b><b>x</b>y</b>");
  });
});

describe("detectSource", () => {
  it("detects Word pastes", () => {
    expect(
      detectSource('<p class="MsoNormal" style="mso-margin-top-alt:auto">Hi</p>'),
    ).toBe("word");
    expect(
      detectSource('<html xmlns:w="urn:schemas-microsoft-com:office:word"><body>x</body></html>'),
    ).toBe("word");
  });

  it("detects Google Docs pastes", () => {
    expect(
      detectSource('<b id="docs-internal-guid-123" style="font-weight:normal">Hi</b>'),
    ).toBe("google-docs");
  });

  it("detects Notion pastes", () => {
    expect(detectSource('<div class="notion-page-content" data-block-id="x">Hi</div>')).toBe(
      "notion",
    );
  });

  it("falls back to generic", () => {
    expect(detectSource("<p>Hi</p>")).toBe("generic");
    expect(detectSource("")).toBe("generic");
  });

  it("prefers the strongest signal when several match", () => {
    expect(detectSource('<p class="MsoNormal" id="docs-internal-guid-1">Hi</p>')).toBe("word");
  });
});

describe("sourceCleanups", () => {
  it("lists Word-specific steps", () => {
    const steps = sourceCleanups("word");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.id.startsWith("word:"))).toBe(true);
    expect(steps.map((s) => s.id)).toContain("word:mso-styles");
  });

  it("lists Google Docs-specific steps", () => {
    const steps = sourceCleanups("google-docs");
    expect(steps.every((s) => s.id.startsWith("gdocs:"))).toBe(true);
    expect(steps.map((s) => s.id)).toContain("gdocs:internal-ids");
  });

  it("lists Notion-specific steps", () => {
    const steps = sourceCleanups("notion");
    expect(steps.every((s) => s.id.startsWith("notion:"))).toBe(true);
  });

  it("returns nothing for generic pastes and unique ids", () => {
    expect(sourceCleanups("generic")).toEqual([]);
    const ids = sourceCleanups("word").map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sourceCleanups("word").every((s) => s.label.length > 0)).toBe(true);
  });
});

describe("linkifyText", () => {
  it("links bare URLs", () => {
    expect(linkifyText("See https://example.test/path?q=1#frag now")).toBe(
      'See <a href="https://example.test/path?q=1#frag">https://example.test/path?q=1#frag</a> now',
    );
  });

  it("moves trailing punctuation outside the link", () => {
    expect(linkifyText("end. https://example.test.")).toBe(
      'end. <a href="https://example.test">https://example.test</a>.',
    );
  });

  it("links email addresses with mailto", () => {
    expect(linkifyText("mail: a.b+c@example.test!")).toBe(
      'mail: <a href="mailto:a.b+c@example.test">a.b+c@example.test</a>!',
    );
  });

  it("links www hosts with an https href", () => {
    expect(linkifyText("www.example.test")).toBe(
      '<a href="https://www.example.test">www.example.test</a>',
    );
  });

  it("escapes HTML in plain text", () => {
    expect(linkifyText("<script>")).toBe("&lt;script&gt;");
    expect(linkifyText("a & b")).toBe("a &amp; b");
  });

  it("leaves link-free text unchanged", () => {
    expect(linkifyText("no links here")).toBe("no links here");
    expect(linkifyText("")).toBe("");
  });
});

describe("describePaste", () => {
  it("counts structural elements", () => {
    const summary = describePaste(
      '<h1>Hi</h1><p>Hello <a href="https://x.test">there</a></p>',
    );
    expect(summary.headings).toBe(1);
    expect(summary.links).toBe(1);
    expect(summary.lines).toBe(2);
    expect(summary.words).toBe(3);
  });

  it("counts lists, tables and images", () => {
    const summary = describePaste(
      "<ul><li>a</li><li>b</li></ul><table><tr><td>c</td></tr></table><img src=x>",
    );
    expect(summary.listItems).toBe(2);
    expect(summary.tables).toBe(1);
    expect(summary.images).toBe(1);
  });

  it("flags unsafe markup", () => {
    expect(describePaste("<p>ok</p>").hasUnsafeHtml).toBe(false);
    expect(describePaste('<p onclick="x()">ok</p>').hasUnsafeHtml).toBe(true);
    expect(describePaste("<script>alert(1)</script>").hasUnsafeHtml).toBe(true);
  });

  it("reports empty input cleanly", () => {
    const summary = describePaste("");
    expect(summary.characters).toBe(0);
    expect(summary.words).toBe(0);
    expect(summary.hasHtml).toBe(false);
  });
});
