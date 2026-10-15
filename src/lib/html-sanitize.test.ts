import { describe, expect, it } from "vitest";
import { escapeHtml, sanitizeHtml, stripTags } from "./html-sanitize";

/**
 * HTML sanitizer for pasted/imported HTML (F8).
 *
 * Red-first: this file was written BEFORE `src/lib/html-sanitize.ts` existed,
 * so every import resolved to module-not-found and the suite failed to
 * collect. It pins the pure `string in -> string out` contract: a tolerant,
 * DOM-free tokenizer, a default allowlist of tags/attributes/schemes, and the
 * structural stripping that every XSS vector below depends on.
 *
 * The vectors are the point: `<script>`/`<style>`/`<iframe>` removed with
 * their content, `on*` handlers never survive, `javascript:`/unsafe `data:`
 * URLs dropped, unknown tags unwrapped, comments gone — and malformed input
 * never throws.
 */

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml('A & B <tag> "q" \'s\'')).toBe(
      "A &amp; B &lt;tag&gt; &quot;q&quot; &#39;s&#39;",
    );
  });

  it("leaves plain text and the empty string alone", () => {
    expect(escapeHtml("plain text")).toBe("plain text");
    expect(escapeHtml("")).toBe("");
  });
});

describe("stripTags", () => {
  it("removes markup and keeps the text content", () => {
    expect(stripTags("<p>Hello <b>world</b></p>")).toBe("Hello world");
    expect(stripTags("<div><span>hi</span></div>")).toBe("hi");
  });

  it("drops script/style content and comments entirely", () => {
    expect(stripTags("<script>alert(1)</script>ok")).toBe("ok");
    expect(stripTags("<style>body{}</style>safe")).toBe("safe");
    expect(stripTags("<!-- c -->visible")).toBe("visible");
  });

  it("decodes entities and turns <br> into a newline", () => {
    expect(stripTags("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
    expect(stripTags("a<br>b")).toBe("a\nb");
  });

  it("returns an empty string for empty input", () => {
    expect(stripTags("")).toBe("");
  });
});

describe("sanitizeHtml — safe formatting survives", () => {
  it("keeps allowed tags and escapes text", () => {
    expect(sanitizeHtml("<p>Hello <strong>bold</strong> <em>em</em></p>")).toBe(
      "<p>Hello <strong>bold</strong> <em>em</em></p>",
    );
  });

  it("escapes raw text but normalises existing entities", () => {
    expect(sanitizeHtml("<p>a & b</p>")).toBe("<p>a &amp; b</p>");
    expect(sanitizeHtml("<p>A &amp; B</p>")).toBe("<p>A &amp; B</p>");
    expect(sanitizeHtml("<p>a < b</p>")).toBe("<p>a &lt; b</p>");
  });

  it("lowercases tag names and emits void tags without a slash", () => {
    expect(sanitizeHtml("<P>hi</P><BR>")).toBe("<p>hi</p><br>");
  });

  it("escapes attribute values", () => {
    expect(sanitizeHtml('<a href="https://x.com/?a=1&b=2" title=\'He said "hi"\'>y</a>')).toBe(
      '<a href="https://x.com/?a=1&amp;b=2" title="He said &quot;hi&quot;">y</a>',
    );
  });

  it("keeps relative, absolute-path, fragment and mailto links", () => {
    expect(sanitizeHtml('<a href="/docs/start">d</a>')).toBe('<a href="/docs/start">d</a>');
    expect(sanitizeHtml('<a href="#top">t</a>')).toBe('<a href="#top">t</a>');
    expect(sanitizeHtml('<a href="mailto:a@b.com">m</a>')).toBe('<a href="mailto:a@b.com">m</a>');
  });

  it("keeps data-* and aria-* attributes by default, strips style", () => {
    expect(sanitizeHtml('<p data-id="1" aria-hidden="true" style="color:red">x</p>')).toBe(
      '<p data-id="1" aria-hidden="true">x</p>',
    );
  });

  it("keeps a safe image data URI", () => {
    expect(sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe(
      '<img src="data:image/png;base64,iVBORw0KGgo=">',
    );
  });
});

describe("sanitizeHtml — XSS vectors", () => {
  it("removes script, style and iframe with their content", () => {
    expect(sanitizeHtml("<script>alert(1)</script>")).toBe("");
    expect(sanitizeHtml("<style>@import 'evil'</style>")).toBe("");
    expect(sanitizeHtml('<iframe src="https://evil.com"></iframe>')).toBe("");
    expect(sanitizeHtml("<SCRIPT>alert(1)</SCRIPT>")).toBe("");
  });

  it("keeps the element but drops javascript: hrefs (case/entity/whitespace obfuscated)", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="JaVaScRiPt:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="javascript&#58;alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="javascript&#x3a;alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="javascript%3Aalert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')).toBe("<a>x</a>");
  });

  it("drops unsafe data: URLs but keeps safe ones", () => {
    expect(sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).toBe("<img>");
  });

  it("strips every on* event handler, even unquoted or slash-prefixed", () => {
    expect(sanitizeHtml('<img src="x" onerror="alert(1)">')).toBe('<img src="x">');
    expect(sanitizeHtml("<img src=x onerror=alert(1)>")).toBe('<img src="x">');
    expect(sanitizeHtml('<b onmouseover="alert(1)">x</b>')).toBe("<b>x</b>");
    expect(sanitizeHtml('<img src="x"/onerror=alert(1)>')).toBe('<img src="x">');
  });

  it("removes comments", () => {
    expect(sanitizeHtml("a<!-- <script>alert(1)</script> -->b")).toBe("ab");
  });

  it("drops protocol-relative URLs", () => {
    expect(sanitizeHtml('<a href="//evil.com/x">x</a>')).toBe("<a>x</a>");
  });

  it("drops svg, math, object, noscript and template content", () => {
    expect(sanitizeHtml('<svg onload="alert(1)"></svg>')).toBe("");
    expect(sanitizeHtml("<math><mtext>x</mtext></math>")).toBe("");
    expect(sanitizeHtml("<object data=\"x\"></object>")).toBe("");
    expect(sanitizeHtml("<noscript><p>x</p></noscript>")).toBe("");
    expect(sanitizeHtml("<template><p>x</p></template>")).toBe("");
  });

  it("unwraps unknown tags while keeping their text", () => {
    expect(sanitizeHtml("<blink>hi</blink>")).toBe("hi");
    expect(sanitizeHtml("<marquee><p>keep</p></marquee>")).toBe("<p>keep</p>");
  });
});

describe("sanitizeHtml — options", () => {
  it("replaces the tag allowlist when allowedTags is given", () => {
    expect(sanitizeHtml("<p><b>x</b></p>", { allowedTags: ["b"] })).toBe("<b>x</b>");
    expect(sanitizeHtml("<p><b>x</b></p>", { allowedTags: [] })).toBe("x");
  });

  it("restricts attributes to an explicit allowedAttrs list", () => {
    expect(sanitizeHtml('<a href="https://x" class="c" title="t">y</a>', { allowedAttrs: ["href"] })).toBe(
      '<a href="https://x">y</a>',
    );
  });

  it("never allows an on* handler even if it is named in allowedAttrs", () => {
    expect(sanitizeHtml('<b onclick="x">y</b>', { allowedAttrs: ["onclick"] })).toBe("<b>y</b>");
  });

  it("restricts URL schemes to an explicit allowedSchemes list", () => {
    expect(sanitizeHtml('<a href="http://x">y</a>', { allowedSchemes: ["https"] })).toBe("<a>y</a>");
    expect(sanitizeHtml('<a href="https://x">y</a>', { allowedSchemes: ["https"] })).toBe(
      '<a href="https://x">y</a>',
    );
  });

  it("keeps a style attribute only when it is explicitly allowed", () => {
    expect(sanitizeHtml('<p style="color:red">x</p>', { allowedAttrs: ["style"] })).toBe(
      '<p style="color:red">x</p>',
    );
  });
});

describe("sanitizeHtml — robustness", () => {
  it("never throws on malformed or unbalanced markup", () => {
    const inputs = [
      '<a href="',
      "<p><b>unclosed",
      "</p></div>",
      "<script>alert(1)",
      "<img src=x onerror=alert(1)",
      "<p title='unterminated>text</p>",
      "plain text with < and > signs",
      "\u0000\u001b[31m<p>x</p>",
    ];
    for (const input of inputs) {
      expect(() => sanitizeHtml(input)).not.toThrow();
      expect(typeof sanitizeHtml(input)).toBe("string");
    }
  });

  it("returns the empty string for empty input", () => {
    expect(sanitizeHtml("")).toBe("");
  });

  it("does not mutate and is deterministic across repeated calls", () => {
    const input = '<p class="a" onclick="x">hi</p>';
    expect(sanitizeHtml(input)).toBe(sanitizeHtml(input));
    expect(input).toBe('<p class="a" onclick="x">hi</p>');
  });
});
