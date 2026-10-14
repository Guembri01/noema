"use client";

/**
 * Custom Notion-parity blocks for the Noema editor.
 *
 * Each block is a TipTap node. Where the block needs interactive chrome
 * (emoji picker, collapse toggle, live heading outline) it uses a React node
 * view; purely structural blocks (columns) render with plain markup + CSS.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { emoji?: string; color?: string }) => ReturnType;
    };
    toggle: {
      setToggle: (attrs?: { summary?: string }) => ReturnType;
    };
    columns: {
      setColumns: (count?: number) => ReturnType;
    };
    tableOfContents: {
      setTableOfContents: () => ReturnType;
    };
  }
}

/* ------------------------------------------------------------------ callout */

const CALLOUT_COLORS: Record<string, string> = {
  gray: "var(--surface)",
  blue: "#e7f3f8",
  green: "#edf3ec",
  yellow: "#fbf3db",
  red: "#fdebec",
  purple: "#f6f3f9",
  orange: "#fbecdd",
  pink: "#faf1f5",
};

const CALLOUT_EMOJIS = [
  "💡", "📌", "❗", "✅", "🔥", "⚠️", "📝", "🎯", "📚", "🚀", "❤️", "🧠",
];

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      emoji: { default: "💡" },
      color: { default: "gray" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-callout": "" }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, attrs ?? {}),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});

function CalloutView({ node, updateAttributes }: NodeViewProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const color = CALLOUT_COLORS[String(node.attrs.color)] ?? CALLOUT_COLORS.gray;

  return (
    <NodeViewWrapper
      className="noema-callout"
      data-callout=""
      style={{ background: color }}
    >
      <div className="noema-callout-emoji" contentEditable={false}>
        <button
          type="button"
          aria-label="Change callout icon"
          onClick={() => setPickerOpen((v) => !v)}
        >
          {String(node.attrs.emoji)}
        </button>
        {pickerOpen && (
          <div className="noema-callout-picker">
            {CALLOUT_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  updateAttributes({ emoji });
                  setPickerOpen(false);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
      <NodeViewContent className="noema-callout-content" />
    </NodeViewWrapper>
  );
}

/* ------------------------------------------------------------------- toggle */

export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      summary: { default: "" },
      open: { default: true },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-toggle]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-toggle": "" }), 0];
  },

  addCommands() {
    return {
      setToggle:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { summary: "", open: true, ...(attrs ?? {}) },
            content: [{ type: "paragraph" }],
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleView);
  },
});

function ToggleView({ node, updateAttributes }: NodeViewProps) {
  const open = Boolean(node.attrs.open);
  return (
    <NodeViewWrapper className="noema-toggle" data-toggle="">
      <div className="noema-toggle-header" contentEditable={false}>
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          aria-expanded={open}
          onClick={() => updateAttributes({ open: !open })}
          className="noema-toggle-chevron"
        >
          <ChevronRight
            className="h-3.5 w-3.5"
            style={{ transform: open ? "rotate(90deg)" : "none" }}
          />
        </button>
        <input
          value={String(node.attrs.summary ?? "")}
          placeholder="Toggle"
          onChange={(e) => updateAttributes({ summary: e.target.value })}
          className="noema-toggle-summary"
        />
      </div>
      <div
        className="noema-toggle-body"
        style={{ display: open ? undefined : "none" }}
      >
        <NodeViewContent />
      </div>
    </NodeViewWrapper>
  );
}

/* ------------------------------------------------------------------ columns */

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column+",
  isolating: true,

  parseHTML() {
    return [{ tag: "div[data-columns]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-columns": "" }),
      0,
    ];
  },

  addCommands() {
    return {
      setColumns:
        (count = 2) =>
        ({ commands }) => {
          const column = {
            type: "column",
            content: [{ type: "paragraph" }],
          };
          return commands.insertContent({
            type: this.name,
            content: Array.from({ length: Math.max(2, Math.min(count, 4)) }, () => column),
          });
        },
    };
  },
});

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,

  parseHTML() {
    return [{ tag: "div[data-column]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-column": "" }), 0];
  },
});

/* -------------------------------------------------------- table of contents */

export const TableOfContents = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,

  parseHTML() {
    return [{ tag: "div[data-toc]" }];
  },

  renderHTML() {
    return ["div", { "data-toc": "" }];
  },

  addCommands() {
    return {
      setTableOfContents:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(TocView);
  },
});

function TocView({ editor }: NodeViewProps) {
  const [items, setItems] = useState<
    { level: number; text: string; pos: number }[]
  >([]);

  const collect = () => {
    const found: { level: number; text: string; pos: number }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        const text = node.textContent.trim();
        if (text) found.push({ level: Number(node.attrs.level) || 1, text, pos });
      }
      return true;
    });
    setItems(found);
  };

  useEffect(() => {
    collect();
    editor.on("update", collect);
    return () => {
      editor.off("update", collect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return (
    <NodeViewWrapper className="noema-toc" data-toc="" contentEditable={false}>
      <p className="noema-toc-title">Table of contents</p>
      {items.length === 0 ? (
        <p className="noema-toc-empty">Add headings to build an outline.</p>
      ) : (
        <ul>
          {items.map((item, index) => (
            <li key={`${item.pos}-${index}`} style={{ paddingLeft: (item.level - 1) * 16 }}>
              <button
                type="button"
                onClick={() =>
                  editor
                    .chain()
                    .focus()
                    .setTextSelection(item.pos + 1)
                    .scrollIntoView()
                    .run()
                }
              >
                {item.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </NodeViewWrapper>
  );
}
