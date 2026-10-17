import { describe, expect, it } from "vitest";
import { isSvgSafe } from "@/lib/svg-safety";

/**
 * The SVG safety policy — the one rule the clipboard path and the upload
 * route both run before an SVG is stored.
 *
 * The contract under test:
 *
 *  - a plain vector SVG is accepted, and the root `xmlns` (an `http(s)://`
 *    URL) is not an external reference;
 *  - scripting is refused: `<script>`, `on*` handlers, `javascript:` and
 *    `vbscript:` URLs, `data:text/html`;
 *  - foreign content is refused: `<foreignObject>`, `<iframe>`;
 *  - XML entity and stylesheet processing instructions are refused;
 *  - every external reference is refused: an `href`/`src`/`xlink:href` that
 *    is not a same-document `#fragment`, an off-document `url()`, a
 *    `<style>@import` of a remote stylesheet;
 *  - the SMIL routes are refused, too: an animation that smuggles a script
 *    URL through `values`/`to`/`from`, and an animation that installs an
 *    event handler through `attributeName`;
 *  - the scheme is matched on the *canonical* form of the document, so
 *    `&#106;avascript:`, `java&#9;script:` and a CSS escape are caught;
 *  - empty or non-string input is unsafe.
 */

describe("isSvgSafe", () => {
  it("accepts a plain vector svg (xmlns is not an external reference)", () => {
    expect(
      isSvgSafe('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="#f00"/></svg>'),
    ).toBe(true);
  });

  it("accepts same-document fragment references", () => {
    expect(
      isSvgSafe('<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use xlink:href="#g"/></svg>'),
    ).toBe(true);
  });

  it("rejects script tags in any case", () => {
    expect(isSvgSafe("<svg><script>alert(1)</script></svg>")).toBe(false);
    expect(isSvgSafe("<svg><SCRIPT>alert(1)</SCRIPT></svg>")).toBe(false);
    expect(
      isSvgSafe('<svg><svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script></svg>'),
    ).toBe(false);
  });

  it("rejects inline event handlers", () => {
    expect(isSvgSafe('<svg onload="x()"></svg>')).toBe(false);
    expect(isSvgSafe('<svg><rect onmouseover="x()"/></svg>')).toBe(false);
  });

  it("rejects external references (href/src/url)", () => {
    expect(isSvgSafe('<svg><image href="https://evil.test/x.png"/></svg>')).toBe(false);
    expect(isSvgSafe('<svg><use xlink:href="//evil.test/x.svg"/></svg>')).toBe(false);
    expect(isSvgSafe('<svg><rect fill="url(https://evil.test/x)"/></svg>')).toBe(false);
  });

  it("rejects foreignObject, javascript: urls and entities", () => {
    expect(isSvgSafe("<svg><foreignObject><p>x</p></foreignObject></svg>")).toBe(false);
    expect(isSvgSafe('<svg><a href="javascript:alert(1)">x</a></svg>')).toBe(false);
    expect(isSvgSafe('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')).toBe(false);
  });

  it("treats empty or non-string input as unsafe", () => {
    expect(isSvgSafe("")).toBe(false);
    expect(isSvgSafe("   ")).toBe(false);
    expect(isSvgSafe(null as unknown as string)).toBe(false);
  });

  /* --------------------------------------------------- the gaps of B56 */

  it("rejects the SMIL animation route (the payload from the issue)", () => {
    // The animation writes a script URL into `href` of the enclosing link.
    // The URL is spelled with a character reference, so the literal scheme
    // is nowhere in the bytes.
    expect(
      isSvgSafe(
        '<svg xmlns="http://www.w3.org/2000/svg"><a>' +
          '<animate attributeName="href" values="&#106;avascript:alert(1)"/>' +
          "<text>go</text></a></svg>",
      ),
    ).toBe(false);
  });

  it("rejects a script URL smuggled through `to`/`from`/`by`", () => {
    expect(isSvgSafe('<svg><set attributeName="href" to="javascript:alert(1)"/></svg>')).toBe(false);
    expect(isSvgSafe('<svg><animate attributeName="href" from="javascript:alert(1)"/></svg>')).toBe(false);
    expect(
      isSvgSafe('<svg><animate attributeName="href" by="&#106;avascript:alert(1)"/></svg>'),
    ).toBe(false);
  });

  it("rejects an animation that installs an event handler", () => {
    expect(isSvgSafe('<svg><set attributeName="onmouseover" to="alert(1)"/></svg>')).toBe(false);
    expect(isSvgSafe('<svg><animate attributeName="onload" values="alert(1)"/></svg>')).toBe(false);
  });

  it("accepts a benign SMIL animation", () => {
    expect(
      isSvgSafe('<svg><rect><animate attributeName="fill" values="#f00;#0f0" dur="2s"/></rect></svg>'),
    ).toBe(true);
  });

  it("rejects a stylesheet that imports a remote document", () => {
    expect(
      isSvgSafe('<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://evil.test/x.css";</style></svg>'),
    ).toBe(false);
    expect(
      isSvgSafe('<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(//evil.test/x.css);</style></svg>'),
    ).toBe(false);
  });

  it("accepts a stylesheet that imports nothing", () => {
    expect(
      isSvgSafe('<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:#f00}</style></svg>'),
    ).toBe(true);
  });

  it("matches the scheme on the canonical form of the document", () => {
    // A character reference, a tab and a CSS escape all hide the scheme.
    expect(isSvgSafe('<svg><a href="&#106;avascript:alert(1)">x</a></svg>')).toBe(false);
    expect(isSvgSafe('<svg><a href="java&#9;script:alert(1)">x</a></svg>')).toBe(false);
    expect(isSvgSafe('<svg><a href="java&#x0A;script:alert(1)">x</a></svg>')).toBe(false);
    expect(isSvgSafe('<svg><a href="&#106;avascript&colon;alert(1)">x</a></svg>')).toBe(false);
    expect(isSvgSafe('<svg><a href="\\6a avascript:alert(1)">x</a></svg>')).toBe(false);
    expect(isSvgSafe('<svg><rect fill="url(\\68 ttps://evil.test/x)"/></svg>')).toBe(false);
    // And the same for a remote reference that is spelled around.
    expect(isSvgSafe('<svg><image href="&#104;ttps://evil.test/x.png"/></svg>')).toBe(false);
  });

  it("rejects a scheme that hides behind a control character (B112)", () => {
    // A browser drops the control characters from a URL *before* it parses the
    // scheme, so `java\nscript:` is `javascript:` for it. The gate has to
    // read the canonical form for the scheme (the raw source stays in the
    // test for the markup patterns, which anchor on the whitespace in front
    // of an `on*` handler).
    expect(isSvgSafe('<svg><rect fill="url(java\nscript:alert(1))"/></svg>')).toBe(false);
    expect(isSvgSafe('<svg><rect fill="url(java\tscript:alert(1))"/></svg>')).toBe(false);
    expect(
      isSvgSafe('<svg><animate attributeName="href" values="java\nscript:alert(1)"/></svg>'),
    ).toBe(false);
  });

  it("still rejects an event handler a line break hides behind (B112)", () => {
    // The counterpart: dropping the control characters must not swallow the
    // whitespace the markup patterns anchor on — `<svg\nonload="…">` is an
    // event handler in an XML document, and the raw source is what sees it.
    expect(isSvgSafe('<svg\nonload="alert(1)"></svg>')).toBe(false);
    expect(isSvgSafe('<svg><rect\nonmouseover="alert(1)"/></svg>')).toBe(false);
  });

  it("rejects an event handler that is not separated by a space", () => {
    expect(isSvgSafe('<svg><rect width="1"onload="x()"/></svg>')).toBe(false);
  });

  it("stays linear on a document that never closes its tags", () => {
    // A scan that backtracks over the attribute section would hang on this
    // input — the default test timeout is the guard.
    expect(isSvgSafe("<a".repeat(200_000))).toBe(true);
  });

  /* -------------------------------- the three gaps of the diff review */

  it("does not stand still on a stray slash in the attribute section", () => {
    // The "/" cannot start an attribute name. A scan that reads it twice
    // stands still and the request hangs — the default test timeout is the
    // guard.
    expect(isSvgSafe("<svg/onload=alert(1)>")).toBe(false);
    expect(isSvgSafe("<svg/onload=alert(1)/>")).toBe(false);
    expect(isSvgSafe("<svg /onload=alert(1)>")).toBe(false);
  });

  it("refuses a document that carries a NUL character", () => {
    // XML forbids U+0000, and a UTF-16 document interleaves a NUL after
    // every ASCII character. A browser would decode such a file and find the
    // markup the scanner did not see, so the file is refused.
    expect(isSvgSafe("<svg\0 onload=alert(1)>")).toBe(false);
    expect(isSvgSafe("<svg><script>alert(1)</script>\0</svg>")).toBe(false);
  });
});
