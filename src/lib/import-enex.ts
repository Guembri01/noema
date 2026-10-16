/**
 * Pure Evernote `.enex` import parser (no XML library, no I/O, never throws).
 *
 * An `.enex` file is an `<en-export>` document holding `<note>` elements, each
 * with a `<title>`, an ENML `<content>` (usually CDATA-wrapped), `<created>` /
 * `<updated>` timestamps, repeated `<tag>` elements and zero or more
 * `<resource>` attachments (base64 `<data>` plus a `<mime>` and file metadata).
 *
 * Parsing is deliberately regex/string based so it survives the malformed,
 * partial and hand-edited exports a real importer meets: every entry point is
 * total (`unknown` in, never a `throw`), missing pieces degrade to `null`/`""`,
 * and a truncated file yields whatever notes could be recovered.
 *
 *   • `parseEnex(xml)`     — ENEX document → `EnexNote[]`
 *   • `enmlToText(enml)`   — ENML fragment → plain text
 *   • `enmlToBlocks(enml)` — ENML fragment → minimal block list (`EnexBlock`)
 *
 * The ENML→text/block conversion is intentionally small: block tags become
 * paragraphs/headings/list items, `<en-todo>` becomes a checked/unchecked todo,
 * `<en-media>` becomes a typed placeholder (text) or media block, `<br>` and
 * `<hr>` are honoured, and every other tag is unwrapped.
 */

/** One attachment inside a note's `<resource>` element. */
export type EnexResource = {
  /** Declared MIME type (`<mime>`), e.g. `"image/png"`. */
  mime: string | null;
  /** Original file name (`<resource-attributes><file-name>`). */
  filename: string | null;
  /** Base64 payload with all whitespace removed; `null` when absent/empty. */
  data: string | null;
  /** Pixel width (`<width>`) when it parses as an integer. */
  width: number | null;
  /** Pixel height (`<height>`) when it parses as an integer. */
  height: number | null;
  /** `hash` attribute carried on `<data>`, when present. */
  hash: string | null;
  /** Original web address (`<source-url>`), when present. */
  sourceUrl: string | null;
};

/** A single parsed note. */
export type EnexNote = {
  /** `<title>`, entity-decoded; falls back to `"Untitled"`. */
  title: string;
  /** ENML `<content>` converted to plain text (see `enmlToText`). */
  content: string;
  /** Raw `<created>` timestamp string (`YYYYMMDDTHHMMSSZ`), or `null`. */
  created: string | null;
  /** Raw `<updated>` timestamp string, or `null`. */
  updated: string | null;
  /** Non-empty `<tag>` values, entity-decoded, de-duplicated, in order. */
  tags: string[];
  /** Attachments in document order. */
  resources: EnexResource[];
};

/** Minimal block shapes `enmlToBlocks` can emit. */
export type EnexBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "listItem"; text: string; ordered: boolean }
  | { type: "todo"; text: string; checked: boolean }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "media"; mime: string | null; hash: string | null }
  | { type: "divider" };

/* ------------------------------------------------------------------ entities */

/** Common named entities seen in exported notes (numeric handled separately). */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  laquo: "\u00ab",
  raquo: "\u00bb",
  bull: "\u2022",
  middot: "\u00b7",
  deg: "\u00b0",
  times: "\u00d7",
  divide: "\u00f7",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
};

/** Decode named + numeric entities in one pass; unknown entities pass through. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strip a leading `<![CDATA[` / trailing `]]>` pair, tolerating a missing end. */
function unwrapCdata(value: string): string {
  const start = value.indexOf("<![CDATA[");
  if (start === -1) return value;
  const open = start + "<![CDATA[".length;
  const close = value.lastIndexOf("]]>");
  return close > open ? value.slice(open, close) : value.slice(open);
}

/* ------------------------------------------------------------- tag scanning */

/**
 * Collect the inner text of every `<tag …>…</tag>` in `xml`.
 *
 * Tolerant by design: an unclosed element runs to the next opening tag of the
 * same name (or end of input), and once an element is consumed scanning resumes
 * after its close so a nested/duplicated tag cannot be matched twice.
 */
function eachTagBody(xml: string, tag: string): string[] {
  const bodies: string[] = [];
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi");
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  const nextOpenRe = new RegExp(`<${tag}(?=\\s|>)`, "i");
  let open = openRe.exec(xml);
  let guard = 0;

  while (open && guard < 100000) {
    guard += 1;
    const start = open.index + open[0].length;
    closeRe.lastIndex = start;
    const close = closeRe.exec(xml);

    let end: number;
    if (close) {
      end = close.index;
      openRe.lastIndex = close.index + close[0].length;
    } else {
      const nextRelative = xml.slice(start).search(nextOpenRe);
      end = nextRelative >= 0 ? start + nextRelative : xml.length;
      openRe.lastIndex = end;
    }

    bodies.push(xml.slice(start, end));
    open = openRe.exec(xml);
  }
  return bodies;
}

/** First `<tag>` body, or `null` when the element is absent. */
function firstTag(xml: string, tag: string): string | null {
  const bodies = eachTagBody(xml, tag);
  return bodies.length > 0 ? bodies[0] : null;
}

/** First element's text: CDATA-unwrapped, entity-decoded, trimmed; `null` if blank. */
function textTag(xml: string, tag: string): string | null {
  const raw = firstTag(xml, tag);
  if (raw === null) return null;
  const value = decodeEntities(unwrapCdata(raw)).trim();
  return value === "" ? null : value;
}

/** Read one attribute value from a tag's attribute source. */
function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  );
  const match = re.exec(attrs);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/** First non-empty trimmed value, or `null`. */
function firstNonEmpty(...values: (string | null)[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** Parse an integer body, or `null` when it is absent / not a number. */
function toInt(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

/* --------------------------------------------------------------- ENML→text */

/** Tags that delimit a block in ENML/HTML as exported by Evernote. */
const BLOCK_TAGS = new Set([
  "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre",
  "table", "tr", "td", "th", "ul", "ol", "dl", "dt", "dd", "section", "article",
  "header", "footer", "figure", "figcaption", "center",
]);

/** Elements that never carry children in ENML. */
const VOID_TAGS = new Set(["br", "hr", "img", "en-media", "en-todo", "en-crypt"]);

const TAG_TOKEN = /<\/?([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;

/** Block kind inferred from the element a run of text belongs to. */
type BlockContext =
  | { type: "heading"; level: number }
  | { type: "listItem"; ordered: boolean }
  | { type: "quote" }
  | { type: "code" }
  | { type: "paragraph" };

/** Map a closing tag (+ open stack) to the block it terminates. */
function classify(tag: string, stack: readonly string[]): BlockContext {
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) return { type: "heading", level: Number(heading[1]) };
  if (tag === "li") {
    let ordered = false;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i] === "ol") {
        ordered = true;
        break;
      }
      if (stack[i] === "ul") break;
    }
    return { type: "listItem", ordered };
  }
  if (tag === "blockquote") return { type: "quote" };
  if (tag === "pre") return { type: "code" };
  return { type: "paragraph" };
}

/** Collapse runs of spaces, normalize newlines, drop blank lines; keep breaks. */
function cleanInline(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  const lines = normalized
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim());
  return lines.join("\n").replace(/\n{2,}/g, "\n").trim();
}

/** Recognize a leading `[x]` / `[ ]` checkbox marker. */
function matchTodo(text: string): { checked: boolean; text: string } | null {
  const match = /^\[( |x|X)\]\s*([\s\S]*)$/.exec(text);
  if (!match) return null;
  return { checked: match[1].toLowerCase() === "x", text: match[2].trim() };
}

/** Remove the ENML envelope (XML prolog, DTD, comments, CDATA markers). */
function stripEnmlEnvelope(source: string): string {
  return source
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<\/?en-note(?:\s[^>]*)?>/gi, "");
}

/**
 * Convert an ENML fragment to a minimal block list. Never throws; unknown tags
 * are unwrapped, malformed markup degrades to text.
 */
export function enmlToBlocks(enml: unknown): EnexBlock[] {
  if (typeof enml !== "string") return [];
  const source = stripEnmlEnvelope(enml);
  if (source.trim() === "") return [];

  const blocks: EnexBlock[] = [];
  const stack: string[] = [];
  let buffer = "";

  const currentTag = (): string => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (BLOCK_TAGS.has(stack[i])) return stack[i];
    }
    return "div";
  };

  const flush = (tag: string): void => {
    const text = cleanInline(buffer);
    buffer = "";
    if (text === "") return;
    const context = classify(tag, stack);
    switch (context.type) {
      case "heading":
        blocks.push({ type: "heading", level: context.level, text });
        break;
      case "listItem":
        blocks.push({ type: "listItem", text, ordered: context.ordered });
        break;
      case "quote":
        blocks.push({ type: "quote", text });
        break;
      case "code":
        blocks.push({ type: "code", text });
        break;
      default: {
        const todo = matchTodo(text);
        blocks.push(
          todo ? { type: "todo", text: todo.text, checked: todo.checked } : { type: "paragraph", text },
        );
      }
    }
  };

  TAG_TOKEN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_TOKEN.exec(source))) {
    const rawText = source.slice(cursor, match.index);
    if (rawText) buffer += decodeEntities(rawText);
    cursor = match.index + match[0].length;

    const tag = match[1].toLowerCase();
    const attrs = match[2] ?? "";
    const closing = match[0][1] === "/";
    const selfClosing = match[0].endsWith("/>") || VOID_TAGS.has(tag);

    if (closing) {
      if (BLOCK_TAGS.has(tag)) {
        flush(tag);
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i] === tag) {
            stack.length = i;
            break;
          }
        }
      }
      continue;
    }

    if (tag === "br") {
      buffer += "\n";
      continue;
    }
    if (tag === "en-todo") {
      buffer += attrValue(attrs, "checked") === "true" ? "[x] " : "[ ] ";
      continue;
    }
    if (tag === "en-media") {
      flush(currentTag());
      blocks.push({
        type: "media",
        mime: firstNonEmpty(attrValue(attrs, "type"), attrValue(attrs, "mime")),
        hash: firstNonEmpty(attrValue(attrs, "hash")),
      });
      continue;
    }
    if (tag === "hr") {
      flush(currentTag());
      blocks.push({ type: "divider" });
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      flush(currentTag());
      if (!selfClosing) stack.push(tag);
      continue;
    }
    // Inline or unknown tag: unwrap — its text still flows into the buffer.
  }

  const tail = source.slice(cursor);
  if (tail) buffer += decodeEntities(tail);
  flush(currentTag());

  return blocks;
}

/** Human label for a media block in plain text. */
function mediaLabel(block: Extract<EnexBlock, { type: "media" }>): string {
  const mime = block.mime ?? "";
  if (mime.startsWith("image/")) return "[image]";
  if (mime.startsWith("audio/")) return "[audio]";
  if (mime.startsWith("video/")) return "[video]";
  return "[file]";
}

/**
 * Convert an ENML fragment to plain text: one line per block, list/todo/media
 * rendered with simple markers. Never throws; non-strings yield `""`.
 */
export function enmlToText(enml: unknown): string {
  const lines: string[] = [];
  for (const block of enmlToBlocks(enml)) {
    switch (block.type) {
      case "heading":
      case "paragraph":
      case "quote":
      case "code":
        lines.push(block.text);
        break;
      case "listItem":
        lines.push(`${block.ordered ? "1. " : "- "}${block.text}`);
        break;
      case "todo":
        lines.push(`${block.checked ? "[x] " : "[ ] "}${block.text}`);
        break;
      case "media":
        lines.push(mediaLabel(block));
        break;
      case "divider":
        break;
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* -------------------------------------------------------------- ENEX→notes */

/** Extract a note's `<content>` as ENML, handling CDATA and escaped markup. */
function extractContent(body: string): string {
  const raw = firstTag(body, "content");
  if (raw === null) return "";
  // CDATA is the norm; a hand-edited export may instead entity-escape the ENML.
  if (!raw.includes("<![CDATA[") && raw.includes("&lt;")) return decodeEntities(raw);
  return unwrapCdata(raw);
}

/** Parse one `<note>` body (the text between `<note>` and `</note>`). */
function parseNote(body: string): EnexNote {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of eachTagBody(body, "tag")) {
    const tag = decodeEntities(unwrapCdata(raw)).trim();
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }

  const resources: EnexResource[] = eachTagBody(body, "resource").map((resource) => {
    const dataMatch = /<data([^>]*)>([\s\S]*?)<\/data\s*>/i.exec(resource);
    let data: string | null = null;
    let hash: string | null = null;
    if (dataMatch) {
      hash = firstNonEmpty(attrValue(dataMatch[1], "hash"));
      const encoding = attrValue(dataMatch[1], "encoding");
      const payload = dataMatch[2];
      if (encoding === null || encoding.toLowerCase() === "base64") {
        data = payload.replace(/\s+/g, "") || null;
      } else {
        data = firstNonEmpty(payload);
      }
    }
    return {
      mime: textTag(resource, "mime"),
      filename: textTag(resource, "file-name"),
      data,
      width: toInt(firstTag(resource, "width")),
      height: toInt(firstTag(resource, "height")),
      hash,
      sourceUrl: textTag(resource, "source-url"),
    };
  });

  return {
    title: textTag(body, "title") ?? "Untitled",
    content: enmlToText(extractContent(body)),
    created: textTag(body, "created"),
    updated: textTag(body, "updated"),
    tags,
    resources,
  };
}

/**
 * Parse an Evernote `.enex` document into notes.
 *
 * Total and fail-safe: a non-string/empty input, a document with no notes, or a
 * truncated file returns `[]` or the notes recovered so far — never a throw.
 * XML comments are ignored so a commented-out note cannot surface.
 */
export function parseEnex(xml: unknown): EnexNote[] {
  if (typeof xml !== "string" || xml.trim() === "") return [];
  const clean = xml.replace(/<!--[\s\S]*?-->/g, "");
  return eachTagBody(clean, "note").map(parseNote);
}
