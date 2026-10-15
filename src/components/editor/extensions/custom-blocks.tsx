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
import { useEffect, useRef, useState } from "react";
import {
  activeHeadingIndex,
  buildTocItems,
  scrollBehavior,
  tocAnchorId,
  type TocHeading,
  type TocItem,
} from "@/lib/toc";
import {
  CALLOUT_ICONS,
  DEFAULT_CALLOUT_ICON,
  normalizeCalloutIcon,
  searchIcons,
} from "@/lib/callout-icons";
import { t } from "@/lib/i18n";

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

export const Callout = Node.create<{ locale: string }>({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addOptions() {
    return { locale: "en" };
  },

  addAttributes() {
    return {
      emoji: { default: DEFAULT_CALLOUT_ICON },
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
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <CalloutView {...props} locale={locale} />
    ));
  },
});

function CalloutView({ node, updateAttributes, locale }: NodeViewProps & { locale: string }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const color = CALLOUT_COLORS[String(node.attrs.color)] ?? CALLOUT_COLORS.gray;
  const emoji = normalizeCalloutIcon(node.attrs.emoji);
  // Empty query surfaces the curated catalog in picker order; a query routes
  // through the shared emoji search (keywords + category prefixes).
  const icons = query.trim() === "" ? CALLOUT_ICONS : searchIcons(query);

  const chooseIcon = (icon: string) => {
    updateAttributes({ emoji: normalizeCalloutIcon(icon) });
    setQuery("");
    setPickerOpen(false);
  };

  return (
    <NodeViewWrapper
      className="noema-callout"
      data-callout=""
      style={{ background: color }}
    >
      <div className="noema-callout-emoji" contentEditable={false}>
        <button
          type="button"
          aria-label={t(locale, "calloutChangeIcon")}
          onClick={() => setPickerOpen((v) => !v)}
        >
          {emoji}
        </button>
        {pickerOpen && (
          <div className="noema-callout-picker">
            <input
              type="search"
              value={query}
              placeholder={t(locale, "search")}
              aria-label={t(locale, "search")}
              onChange={(e) => setQuery(e.target.value)}
              style={{ gridColumn: "1 / -1" }}
            />
            {icons.length === 0 ? (
              <span style={{ gridColumn: "1 / -1" }}>
                {t(locale, "noResults")}
              </span>
            ) : (
              icons.map((icon) => (
                <button
                  key={icon.shortcode}
                  type="button"
                  aria-label={icon.shortcode}
                  onClick={() => chooseIcon(icon.emoji)}
                >
                  {icon.emoji}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <NodeViewContent className="noema-callout-content" />
    </NodeViewWrapper>
  );
}

/* ------------------------------------------------------------------- toggle */

export const Toggle = Node.create<{ locale: string }>({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,

  addOptions() {
    return { locale: "en" };
  },

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
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <ToggleView {...props} locale={locale} />
    ));
  },
});

function ToggleView({ node, updateAttributes, locale }: NodeViewProps & { locale: string }) {
  const open = Boolean(node.attrs.open);
  return (
    <NodeViewWrapper className="noema-toggle" data-toggle="">
      <div className="noema-toggle-header" contentEditable={false}>
        <button
          type="button"
          aria-label={t(locale, open ? "toggleCollapse" : "toggleExpand")}
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
          placeholder={t(locale, "blockToggle")}
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

export const TableOfContents = Node.create<{ locale: string }>({
  name: "tableOfContents",
  group: "block",
  atom: true,

  addOptions() {
    return { locale: "en" };
  },

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
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <TocView {...props} locale={locale} />
    ));
  },
});

/**
 * The rendered element for the heading node at `pos`. Resolution is by
 * document position (never by id), so a stale position after an edit just
 * returns null and the next `collect()` refreshes it.
 */
function headingElementAt(
  editor: NodeViewProps["editor"],
  pos: number,
): HTMLElement | null {
  try {
    const dom = editor.view.nodeDOM(pos);
    return dom instanceof HTMLElement ? dom : null;
  } catch {
    return null;
  }
}

/** Nearest scrollable ancestor, falling back to the root scroller. */
function scrollContainerFor(start: Element): Element {
  let node: Element | null = start;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

function TocView({ editor, locale }: NodeViewProps & { locale: string }) {
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const itemsRef = useRef<TocItem[]>([]);

  /**
   * Recompute every heading's offset from the scroll container's top edge and
   * publish the active outline index. Hidden or unrendered headings measure
   * `Infinity` so they can never claim the active slot.
   */
  const measure = (list: readonly TocItem[]) => {
    if (list.length === 0) {
      setActiveIndex(-1);
      return;
    }
    const container = scrollContainerFor(editor.view.dom);
    const rootScroller =
      container === document.scrollingElement ||
      container === document.documentElement;
    const baseTop = rootScroller ? 0 : container.getBoundingClientRect().top;
    const tops = list.map((item) => {
      const el = headingElementAt(editor, item.pos);
      if (!el || el.offsetHeight === 0) return Number.POSITIVE_INFINITY;
      return el.getBoundingClientRect().top - baseTop;
    });
    setActiveIndex((prev) => {
      const next = activeHeadingIndex(tops);
      return prev === next ? prev : next;
    });
  };

  const collect = () => {
    const headings: TocHeading[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        const text = node.textContent.trim();
        if (text) headings.push({ level: Number(node.attrs.level) || 1, text, pos });
      }
      return true;
    });
    const built = buildTocItems(headings);
    itemsRef.current = built;
    // ANCHOR STRATEGY: slugify+dedupe runs here, at render, and the id is
    // stamped onto the rendered heading element only — the document model
    // stays id-free by design (see src/lib/toc.ts).
    for (const item of built) {
      const el = headingElementAt(editor, item.pos);
      if (el) el.id = tocAnchorId(item.slug);
    }
    setItems(built);
    measure(built);
  };

  const remeasure = () => measure(itemsRef.current);

  useEffect(() => {
    collect();
    editor.on("update", collect);
    // `scroll` does not bubble, so one capture-phase listener on window sees
    // the workspace scroller (#main), the root scroller, and nested ones.
    window.addEventListener("scroll", remeasure, { capture: true, passive: true });
    window.addEventListener("resize", remeasure);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(remeasure);
    observer?.observe(editor.view.dom);
    return () => {
      editor.off("update", collect);
      window.removeEventListener("scroll", remeasure, true);
      window.removeEventListener("resize", remeasure);
      observer?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const goToHeading = (item: TocItem) => {
    // Keep the caret parity with the old behaviour, but suppress TipTap's own
    // post-focus scroll — it lands a frame later and would cancel ours.
    editor
      .chain()
      .focus(null, { scrollIntoView: false })
      .setTextSelection(item.pos + 1)
      .run();
    const el =
      headingElementAt(editor, item.pos) ??
      document.getElementById(tocAnchorId(item.slug));
    if (!el) return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // One frame out: TipTap's delayedFocus() runs view.focus() inside a rAF,
    // and any native focus scroll must happen before the smooth animation.
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: scrollBehavior(reduced), block: "start" });
    });
  };

  return (
    <NodeViewWrapper className="noema-toc" data-toc="" contentEditable={false}>
      <p className="noema-toc-title">{t(locale, "blockTableOfContents")}</p>
      {items.length === 0 ? (
        <p className="noema-toc-empty">{t(locale, "tocEmpty")}</p>
      ) : (
        <ul>
          {items.map((item, index) => (
            <li key={item.slug} style={{ paddingLeft: (item.level - 1) * 16 }}>
              <button
                type="button"
                aria-current={index === activeIndex ? "true" : undefined}
                onClick={() => goToHeading(item)}
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
