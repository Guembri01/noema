/**
 * Document builders for the demo seed.
 *
 * The editor persists TipTap/ProseMirror JSON, so every seeded page has to be
 * authored in that shape. Writing it by hand is unreadable and easy to get
 * wrong, so the seed uses these small builders instead: a page reads as a list
 * of `doc(...)` blocks, and the node names/attributes mirror
 * `src/components/editor/extensions/*` exactly (`callout`, `toggle`, `columns`,
 * `table`, `image`, `bookmark`, `mention`, …).
 *
 * Nothing here is imported by the app — it is seed-only tooling.
 */

export type Mark = { type: string; attrs?: Record<string, unknown> };

export type Inline =
  | { type: "text"; text: string; marks?: Mark[] }
  | { type: "mention"; attrs: { id: string; label: string; type: string } };

export type Block = Record<string, unknown>;

export type Doc = { type: "doc"; content: Block[] };

/** Builders accept a bare string for the common case; it becomes a text node. */
export type InlineInput = string | Inline;

const inline = (value: InlineInput): Inline => (typeof value === "string" ? text(value) : value);

/* ----------------------------------------------------------------- inline */

export const text = (value: string, marks?: Mark[]): Inline => ({
  type: "text",
  text: value,
  ...(marks && marks.length > 0 ? { marks } : {}),
});

export const bold = (value: string): Inline => text(value, [{ type: "bold" }]);
export const italic = (value: string): Inline => text(value, [{ type: "italic" }]);
export const strike = (value: string): Inline => text(value, [{ type: "strike" }]);
export const code = (value: string): Inline => text(value, [{ type: "code" }]);
export const highlight = (value: string, color = "yellow"): Inline =>
  text(value, [{ type: "highlight", attrs: { color } }]);
export const link = (value: string, href: string): Inline =>
  text(value, [
    { type: "link", attrs: { href, target: "_blank", rel: "noopener noreferrer nofollow" } },
  ]);

/** Inline @-mention chip. `type` is "user", "page", "block" or "date". */
export const mention = (
  label: string,
  id: string,
  type: "user" | "page" | "block" | "date" = "user",
): Inline => ({ type: "mention", attrs: { id, label, type } });

/* ------------------------------------------------------------------ blocks */

export const p = (...content: InlineInput[]): Block => ({
  type: "paragraph",
  ...(content.length > 0 ? { content: content.map(inline) } : {}),
});

const heading =
  (level: number) =>
  (...content: InlineInput[]): Block => ({
    type: "heading",
    attrs: { level },
    content: content.map(inline),
  });

export const h1 = heading(1);
export const h2 = heading(2);
export const h3 = heading(3);

export const bulletList = (...items: InlineInput[][]): Block => ({
  type: "bulletList",
  content: items.map((item) => ({
    type: "listItem",
    content: [p(...item)],
  })),
});

export const orderedList = (...items: InlineInput[][]): Block => ({
  type: "orderedList",
  content: items.map((item) => ({
    type: "listItem",
    content: [p(...item)],
  })),
});

export const todoList = (...items: [string | InlineInput[], boolean][]): Block => ({
  type: "taskList",
  content: items.map(([label, checked]) => ({
    type: "taskItem",
    attrs: { checked },
    content: [p(...(Array.isArray(label) ? label : [label]))],
  })),
});

export const quote = (...content: InlineInput[]): Block => ({
  type: "blockquote",
  content: [p(...content)],
});

/** Oversized editorial pull quote (`PullQuote` sets `data-size`). */
export const pullQuote = (...content: InlineInput[]): Block => ({
  type: "blockquote",
  attrs: { size: "large" },
  content: [p(...content)],
});

export const callout = (emoji: string, color: string, ...content: Block[]): Block => ({
  type: "callout",
  attrs: { emoji, color },
  content,
});

export const toggle = (summary: string, ...content: Block[]): Block => ({
  type: "toggle",
  attrs: { summary, open: true },
  content,
});

export const codeBlock = (language: string, source: string): Block => ({
  type: "codeBlock",
  attrs: { language, lineNumbers: true },
  content: [{ type: "text", text: source }],
});

export const divider = (): Block => ({ type: "horizontalRule" });

export const image = (src: string, alt: string, caption = ""): Block => ({
  type: "image",
  attrs: { src, alt, title: null, caption },
});

export const bookmark = (
  url: string,
  title: string,
  description: string,
  host: string,
  icon: string | null = null,
): Block => ({
  type: "bookmark",
  attrs: { url, title, description, host, icon, image: null, embed: null },
});

/**
 * A table: the first row is a header row, every later row is body cells.
 * `colspan`/`colwidth` are omitted on purpose — the table extension defaults
 * them and the editor recomputes widths on load.
 */
export const table = (header: InlineInput[][], rows: InlineInput[][][]): Block => ({
  type: "table",
  content: [
    {
      type: "tableRow",
      content: header.map((cell) => ({
        type: "tableHeader",
        content: [p(...cell)],
      })),
    },
    ...rows.map((row) => ({
      type: "tableRow",
      content: row.map((cell) => ({
        type: "tableCell",
        content: [p(...cell)],
      })),
    })),
  ],
});

/** Side-by-side columns; each column is its own list of blocks. */
export const columns = (...cols: Block[][]): Block => ({
  type: "columns",
  content: cols.map((content) => ({ type: "column", content })),
});

export const doc = (...content: Block[]): Doc => ({ type: "doc", content });
