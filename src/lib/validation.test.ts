import { describe, expect, it } from "vitest";
import * as validation from "./validation";
import { validatePassword } from "./password-policy";

/**
 * B59 / audit H2 - stored XSS gate (red-first).
 *
 * `sanitizeHref` is the http|https|mailto|tel scheme allowlist. It must reject
 * `javascript:`/`data:`/`vbscript:` and every encoding trick a browser would
 * still resolve (uppercase schemes, leading whitespace/C0 controls, control
 * characters smuggled inside the scheme, encoded colons, HTML-entity prefixes,
 * protocol-relative URLs). `parsePageContent` applies it deeply to every
 * href-shaped attribute (`attrs.href` on link marks, `attrs.url` on
 * bookmark/embed nodes) on the write path; the doc renderer applies it again
 * on the read path.
 */

const { parsePageContent } = validation;
const sanitize = (value: unknown): string | null => validation.sanitizeHref(value);

describe("sanitizeHref - scheme allowlist (H2)", () => {
  it("keeps allowlisted schemes and safe relative targets", () => {
    expect(sanitize("https://example.com/x")).toBe("https://example.com/x");
    expect(sanitize("http://example.com")).toBe("http://example.com");
    expect(sanitize("HTTPS://example.com/x")).toBe("HTTPS://example.com/x");
    expect(sanitize("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(sanitize("tel:+33123456789")).toBe("tel:+33123456789");
    expect(sanitize("/w/demo/page")).toBe("/w/demo/page");
    expect(sanitize("#section")).toBe("#section");
    expect(sanitize("?tab=2")).toBe("?tab=2");
    expect(sanitize("example.com/x")).toBe("example.com/x");
    expect(sanitize("page.html")).toBe("page.html");
  });

  it("rejects script-bearing schemes", () => {
    const rejected = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(document.cookie)",
      "data:text/html;base64,PHN2Zz4=",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/0000",
      "about:blank",
    ];
    for (const href of rejected) expect(sanitize(href), href).toBeNull();
  });

  it("rejects whitespace/control-character obfuscations", () => {
    const bypasses = [
      " javascript:alert(1)",
      "\tjavascript:alert(1)",
      "\u0000javascript:alert(1)",
      "\u0001javascript:alert(1)",
      "java\nscript:alert(1)", // URL parsers strip LF from inside the scheme
      "java\tscript:alert(1)",
      "java\rscript:alert(1)",
      "jav\u0000ascript:alert(1)",
      "javascript\u0000:alert(1)",
      "\t JaVaScRiPt:alert(1)",
      "java script:alert(1)",
      "  \u0001JAVASCRIPT:alert(1)",
    ];
    for (const href of bypasses) expect(sanitize(href), JSON.stringify(href)).toBeNull();
  });

  it("rejects encoded-colon and protocol-relative tricks", () => {
    const bypasses = [
      "javascript%3Aalert(1)",
      "java%3Ascript:alert(1)",
      "JAVA%3Ascript:alert(1)",
      "&#106;avascript:alert(1)",
      "//evil.example/x",
      "\t//evil.example/x",
      "\\\\evil.example/x",
      "//169.254.169.254/latest/meta-data/",
    ];
    for (const href of bypasses) expect(sanitize(href), JSON.stringify(href)).toBeNull();
  });

  it("normalises control characters out of otherwise safe hrefs", () => {
    expect(sanitize("\u0001https://example.com/a")).toBe("https://example.com/a");
    expect(sanitize("https://example.com/a\n")).toBe("https://example.com/a");
  });

  it("rejects non-string values", () => {
    expect(sanitize(undefined)).toBeNull();
    expect(sanitize(null)).toBeNull();
    expect(sanitize(123)).toBeNull();
    expect(sanitize({ href: "https://x" })).toBeNull();
    expect(sanitize(["https://x"])).toBeNull();
  });
});

describe("parsePageContent - deep href validation (H2)", () => {
  it("drops dangerous link-mark hrefs and keeps safe siblings", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "bad",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
            {
              type: "text",
              text: "good",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    };
    const result = parsePageContent(JSON.stringify(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result.doc);
    expect(json).not.toContain("javascript:");
    expect(json).toContain("https://example.com");
    const paragraph = (
      result.doc as {
        content: Array<{ content: Array<{ marks?: Array<{ attrs?: Record<string, unknown> }> }> }>;
      }
    ).content[0];
    expect(paragraph.content[0].marks?.[0]?.attrs?.href).toBeUndefined();
    expect(paragraph.content[1].marks?.[0]?.attrs?.href).toBe("https://example.com");
  });

  it("drops data: and vbscript: bookmark/embed urls", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "bookmark", attrs: { url: "data:text/html;base64,PHN2Zz4=", host: "evil.test" } },
        { type: "embed", attrs: { url: "vbscript:msgbox(1)" } },
      ],
    };
    const result = parsePageContent(JSON.stringify(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result.doc);
    expect(json).not.toContain("data:");
    expect(json).not.toContain("vbscript:");
    const [bookmark, embed] = (
      result.doc as { content: Array<{ attrs?: Record<string, unknown> }> }
    ).content;
    expect(bookmark.attrs?.url).toBeUndefined();
    expect(embed.attrs?.url).toBeUndefined();
    expect(bookmark.attrs?.host).toBe("evil.test"); // sibling metadata untouched
  });

  it("sanitises deeply nested nodes", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "x",
                      marks: [{ type: "link", attrs: { href: "\tjavascript:alert(1)" } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = parsePageContent(JSON.stringify(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.doc)).not.toContain("javascript:");
  });

  it("keeps safe documents byte-identical (image data: srcs stay untouched)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "see " },
            { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://example.com/x" } }] },
            { type: "text", text: " or ", marks: [{ type: "link", attrs: { href: "mailto:a@b.co" } }] },
            { type: "text", text: "call", marks: [{ type: "link", attrs: { href: "tel:+33123456789" } }] },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "rel", marks: [{ type: "link", attrs: { href: "/w/demo/page" } }] },
          ],
        },
        {
          type: "bookmark",
          attrs: { url: "https://example.com/card", host: "example.com", title: "Card" },
        },
        { type: "image", attrs: { src: "data:image/png;base64,AAAA", alt: "shot" } },
      ],
    };
    const result = parsePageContent(JSON.stringify(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc).toEqual(doc);
  });

  it("still enforces the shape contract", () => {
    expect(parsePageContent("not json").ok).toBe(false);
    expect(parsePageContent(JSON.stringify({ type: "doc" })).ok).toBe(false);
    expect(parsePageContent(undefined)).toEqual({ ok: true, doc: undefined });
  });
});

/**
 * K02 - `signupSchema.password` delegates to the shared `validatePassword`
 * policy (`src/lib/password-policy.ts`) via a zod refine. These tests pin that
 * delegation and the length messages the schema keeps for itself.
 */
describe("signupSchema - password policy delegation", () => {
  const identity = { name: "Ada Lovelace", email: "ada@example.com" };

  it("accepts a password the shared policy accepts", () => {
    expect(validatePassword("Tr0ub4dor&3").ok).toBe(true);
    const result = validation.signupSchema.safeParse({
      ...identity,
      password: "Tr0ub4dor&3",
    });
    expect(result.success).toBe(true);
  });

  it("keeps the existing minimum-length message", () => {
    const result = validation.signupSchema.safeParse({ ...identity, password: "Ab1" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe("Use at least 8 characters");
  });

  it("caps password length", () => {
    const result = validation.signupSchema.safeParse({
      ...identity,
      password: `Aa1${"x".repeat(200)}`,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe("Password must be at most 200 characters");
  });

  it("rejects exactly what validatePassword rejects", () => {
    const weak = [
      "alllowercase1", // missing upper
      "ALLUPPERCASE1", // missing lower
      "NoDigitsHere", // missing digit
      "Password1", // denylisted despite satisfying composition
      "abcabcabc", // missing upper + digit
    ];
    for (const password of weak) {
      expect(validatePassword(password).ok, password).toBe(false);
      const result = validation.signupSchema.safeParse({ ...identity, password });
      expect(result.success, password).toBe(false);
    }
  });
});
