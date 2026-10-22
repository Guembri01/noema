/**
 * The SVG safety policy — the *single* rule every path that accepts an SVG
 * runs before the bytes are stored.
 *
 * B56: the rule used to live inside the clipboard paste engine and was applied
 * there only, so `POST /api/upload` stored and served an SVG that the clipboard
 * path would have refused. The upload route and the clipboard path now run
 * this one function, so a file cannot be safe on one path and unsafe on the
 * other.
 *
 * The policy is a closed list of the constructs that can execute script or
 * pull in an external resource:
 *
 *  - scripting: `<script>`, `on*` event handlers, `javascript:`/`vbscript:`
 *    URLs, `data:text/html`;
 *  - foreign content: `<foreignObject>`, `<iframe>`, `<object>`, `<embed>`;
 *  - XML entity and stylesheet processing instructions;
 *  - every external reference — an `href`/`src`/`xlink:href` that is not a
 *    same-document `#fragment`, a `url()` that points off-document, a
 *    `<style>@import` of a remote stylesheet;
 *  - SMIL animation (`<animate>`, `<set>`, …) that smuggles a script URL
 *    through `values`/`to`/`from` or that animates an event handler.
 *
 * The patterns are matched against a *canonical* form of the document, not
 * against the bytes as they arrived: XML character references are decoded,
 * CSS escapes are resolved and control characters are dropped first. Without
 * that step the obvious evasions slip through — `&#106;avascript:`,
 * `java&#9;script:`, `url(&#104;ttps://…)`, `<style>@import "https://…"` and
 * `<animate attributeName="href" values="&#106;avascript:…">`.
 *
 * Everything here is pure and total: no DOM, no I/O, no throwing. An empty or
 * non-string input is unsafe.
 */

/** Elements that never appear in an accepted SVG (compared without a prefix). */
const FORBIDDEN_ELEMENTS: ReadonlySet<string> = Object.freeze(
  new Set([
    "script",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "applet",
    "handler",
    "listener",
  ]),
);

/**
 * Attributes whose value may only point at a same-document fragment. Anything
 * else is an external reference and is refused.
 */
const FRAGMENT_ONLY_ATTRIBUTES: ReadonlySet<string> = Object.freeze(
  new Set([
    "href",
    "src",
    "xlink:href",
    "data",
    "action",
    "formaction",
    "poster",
    "background",
    "longdesc",
    "usemap",
    "profile",
    "manifest",
    "codebase",
    "cite",
    "classid",
    "archive",
  ]),
);

/** SMIL animation elements — their `attributeName` may not be a handler. */
const ANIMATION_ELEMENTS: ReadonlySet<string> = Object.freeze(
  new Set(["animate", "set", "animatetransform", "animatemotion", "animatecolor"]),
);

/**
 * Patterns that are matched against the document as it arrived. They catch the
 * plain spellings; the canonical patterns below catch the spelled-around ones.
 */
const SOURCE_FORBIDDEN: readonly RegExp[] = Object.freeze([
  /<script\b/i,
  /<foreignobject\b/i,
  /<iframe\b/i,
  /<\?xml-stylesheet\b/i,
  /<!entity\b/i,
  /\son[a-z]+\s*=/i,
  /(?:javascript|vbscript)\s*:/i,
  /data:text\/html/i,
  /url\(\s*["']?\s*(?:https?:|\/\/|data:|file:)/i,
]);

/**
 * The same idea, matched against the canonical form: character references
 * decoded, CSS escapes resolved, control characters removed. A scheme that was
 * hidden behind `&#106;` or a tab still reads as `javascript:` here.
 */
const CANONICAL_FORBIDDEN: readonly RegExp[] = Object.freeze([
  /(?:javascript|vbscript)\s*:/i,
  /data\s*:\s*text\/html/i,
  /url\(\s*["']?\s*(?:https?:|\/\/|data:|file:)/i,
  /@import\b/i,
]);

/**
 * Character references the policy resolves. The XML five plus the ones that
 * turn a spelled-out scheme back into a scheme (`&colon;`, `&tab;`,
 * `&newline;`).
 */
const NAMED_REFERENCES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  tab: "\t",
  newline: "\n",
  nbsp: " ",
});

/** `&amp;`, `&#106;`, `&#x6a;` — the semicolon is optional, as in HTML. */
const REFERENCE_RE = /&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]*));?/gi;

/** A CSS escape: `\6a`, `\6a `, `\#`. */
const CSS_ESCAPE_RE = /\\(?:([0-9a-f]{1,6})[ \t\r\n\f]?|([\s\S]))/gi;

/** One attribute of a start tag, lower-cased. */
type SvgAttribute = {
  name: string;
  value: string;
};

/** One start tag of the document. */
type SvgTag = {
  name: string;
  attributes: SvgAttribute[];
};

/** Resolve the character references of a document. */
function decodeReferences(text: string): string {
  return text.replace(
    REFERENCE_RE,
    (
      match: string,
      hex: string | undefined,
      decimal: string | undefined,
      name: string | undefined,
    ): string => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      if (decimal !== undefined) {
        const code = Number.parseInt(decimal, 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      const named = NAMED_REFERENCES[(name ?? "").toLowerCase()];
      return named ?? match;
    },
  );
}

/** Resolve the CSS escapes of a document (`\6a` → `j`). */
function decodeCssEscapes(text: string): string {
  return text.replace(
    CSS_ESCAPE_RE,
    (_match: string, hex: string | undefined, literal: string | undefined): string => {
      if (hex === undefined) return literal ?? "";
      const code = Number.parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    },
  );
}

/** Control characters — a browser drops them before it resolves a scheme. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/** Remove the control characters of a document. */
function stripControls(text: string): string {
  return text.replace(CONTROL_RE, "");
}

/**
 * The canonical form of a document: character references decoded, CSS escapes
 * resolved and control characters removed — the shape a browser acts on when
 * it resolves a URL scheme. Two documents that differ only in how they spell
 * a scheme share one canonical form, which is what makes the block-list
 * below hard to spell around.
 */
function canonicalize(text: string): string {
  // The common case — a document without a character reference and without a
  // CSS escape — only needs the control characters removed.
  const hasReference = text.includes("&");
  const hasEscape = text.includes("\\");
  if (!hasReference && !hasEscape) return stripControls(text);
  const decoded = decodeReferences(text);
  const withEscapes = hasEscape ? decodeCssEscapes(decoded) : decoded;
  return stripControls(withEscapes.includes("&") ? decodeReferences(withEscapes) : withEscapes);
}

/** The element name without its namespace prefix (`svg:script` → `script`). */
function localName(name: string): string {
  const index = name.lastIndexOf(":");
  return index >= 0 ? name.slice(index + 1) : name;
}

/** Whether a character is XML whitespace. */
function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/** Whether a character may start an element or attribute name. */
function isNameStart(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    code === 95 // _
  );
}

/** Whether a character may continue an element or attribute name. */
function isNameChar(code: number): boolean {
  return (
    isNameStart(code) ||
    (code >= 48 && code <= 57) || // 0-9
    code === 45 || // -
    code === 46 || // .
    code === 58 // :
  );
}

/**
 * Every start tag of the document with its attributes.
 *
 * A hand-written scan, not a regular expression: a regex over the attribute
 * section backtracks quadratically on a document that never closes its tags
 * (an attacker-supplied 10 MB file would hang the request), and this scan
 * touches every character a constant number of times.
 */
function tagsOf(source: string): SvgTag[] {
  const tags: SvgTag[] = [];
  const length = source.length;
  let index = 0;
  while (index < length) {
    const start = source.indexOf("<", index);
    if (start < 0) break;
    // A comment, a processing instruction, a doctype or a closing tag: it is
    // not a start tag, so the scan continues after the "<".
    if (!isNameStart(source.charCodeAt(start + 1))) {
      index = start + 1;
      continue;
    }
    let cursor = start + 1;
    while (cursor < length && isNameChar(source.charCodeAt(cursor))) cursor += 1;
    const name = source.slice(start + 1, cursor).toLowerCase();
    const attributes: SvgAttribute[] = [];

    // The attribute section, honouring quoted values.
    while (cursor < length) {
      while (cursor < length && isSpace(source.charCodeAt(cursor))) cursor += 1;
      if (cursor >= length) break;
      const char = source.charCodeAt(cursor);
      if (char === 62) {
        cursor += 1; // ">"
        break;
      }
      if (char === 47 && source.charCodeAt(cursor + 1) === 62) {
        cursor += 2; // "/>"
        break;
      }
      const nameStart = cursor;
      while (
        cursor < length &&
        !isSpace(source.charCodeAt(cursor)) &&
        source.charCodeAt(cursor) !== 61 && // "="
        source.charCodeAt(cursor) !== 62 && // ">"
        source.charCodeAt(cursor) !== 47 // "/"
      ) {
        cursor += 1;
      }
      const attributeName = source.slice(nameStart, cursor);
      while (cursor < length && isSpace(source.charCodeAt(cursor))) cursor += 1;
      if (source.charCodeAt(cursor) !== 61) {
        // A valueless attribute (`<svg hidden>`). A stray `/` that is not the
        // `/>` close consumes no name; advance so the scanner cannot spin.
        if (cursor === nameStart) cursor += 1;
        else if (attributeName !== "") {
          attributes.push({ name: attributeName.toLowerCase(), value: "" });
        }
        continue;
      }
      cursor += 1; // "="
      while (cursor < length && isSpace(source.charCodeAt(cursor))) cursor += 1;
      const quote = source.charCodeAt(cursor);
      let value = "";
      if (quote === 34 || quote === 39) {
        // A quoted value: it may contain ">" and "<".
        const end = source.indexOf(quote === 34 ? '"' : "'", cursor + 1);
        if (end < 0) {
          value = source.slice(cursor + 1);
          cursor = length;
        } else {
          value = source.slice(cursor + 1, end);
          cursor = end + 1;
        }
      } else {
        const valueStart = cursor;
        while (
          cursor < length &&
          !isSpace(source.charCodeAt(cursor)) &&
          source.charCodeAt(cursor) !== 62
        ) {
          cursor += 1;
        }
        value = source.slice(valueStart, cursor);
      }
      if (attributeName !== "") {
        attributes.push({ name: attributeName.toLowerCase(), value });
      }
    }

    tags.push({ name, attributes });
    index = cursor > start ? cursor : start + 1;
  }
  return tags;
}

/**
 * Whether an SVG document is safe to upload and render.
 *
 * Rejects scripting (`<script>`, `on*` handlers, `javascript:`/`vbscript:`
 * URLs, `data:text/html`), foreign content (`<foreignObject>`, `<iframe>`,
 * `<object>`, `<embed>`), XML entity/stylesheet processing instructions,
 * every external reference (an `href`/`src`/`xlink:href` that is not a
 * same-document `#fragment`, an off-document `url()`, a `<style>@import`), and
 * the SMIL animations that carry a script URL in `values`/`to`/`from` or
 * animate an event handler. The root `xmlns` (an `http(s)://` URL) is not a
 * reference and stays allowed.
 *
 * Empty or non-string input is unsafe. The function never throws.
 */
export function isSvgSafe(svg: string): boolean {
  if (typeof svg !== "string") return false;
  const source = svg.trim();
  if (source === "") return false;
  // XML forbids U+0000 in a document, so a document that carries one is
  // either binary or written in an encoding this scanner does not read: a
  // UTF-16 document interleaves a NUL after every ASCII character, and a
  // browser would decode it as UTF-16 and find the very markup the scanner
  // did not see. Such a document is refused — the rule is "no script", and a
  // document the scanner cannot read is not one it can clear.
  if (source.includes("\u0000")) return false;
  if (SOURCE_FORBIDDEN.some((re) => re.test(source))) return false;
  const canonical = canonicalize(source);
  if (CANONICAL_FORBIDDEN.some((re) => re.test(canonical))) return false;

  for (const tag of tagsOf(source)) {
    const name = localName(tag.name);
    if (FORBIDDEN_ELEMENTS.has(name)) return false;
    for (const attribute of tag.attributes) {
      // An event handler, however it was spelled (`onload=`, `onload =`).
      if (attribute.name.startsWith("on")) return false;
      // A reference may only point inside the document.
      if (FRAGMENT_ONLY_ATTRIBUTES.has(attribute.name)) {
        const value = canonicalize(attribute.value).trim();
        if (!value.startsWith("#")) return false;
      }
    }
    if (ANIMATION_ELEMENTS.has(name)) {
      // `<set attributeName="onmouseover" to="alert(1)"/>` installs a handler.
      const target = tag.attributes.find((attribute) => attribute.name === "attributename");
      if (target && /^on[a-z]/i.test(canonicalize(target.value).trim())) return false;
    }
  }
  return true;
}
