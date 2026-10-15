"use client";

/**
 * Custom Notion-parity blocks for the Noema editor.
 *
 * Each block is a TipTap node. Where the block needs interactive chrome
 * (emoji picker, collapse toggle, live heading outline) it uses a React node
 * view; purely structural blocks (columns) render with plain markup + CSS.
 * The toggle-heading chevron is the exception: headings come from StarterKit,
 * so it is added as a decoration-only, view-local plugin (see `ToggleHeading`)
 * rather than a node view.
 */

import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
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
  blockId,
  canToggle,
  headingSubtrees,
  toggleCollapse,
  visibleBlocks,
  type ToggleBlock,
} from "@/lib/toggle-heading";
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

  // Anchors the toggle-heading chevron to the editor without touching the
  // shared `page-editor.tsx` (the same `addExtensions` pattern the input-rules
  // slice uses). Drop this hook once `ToggleHeading` is mounted directly.
  addExtensions() {
    return [ToggleHeading.configure({ locale: this.options.locale })];
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

/* ----------------------------------------------------------- toggle heading */

/**
 * Collapsible toggle-heading affordance: a chevron on every level 1–3 heading
 * that owns a following run of blocks. Because the document is a FLAT list, the
 * heading's body is its following siblings up to the next heading of level <= L
 * — exactly the ownership `src/lib/toggle-heading.ts` computes — so this
 * extension decorates the owned run away with node decorations instead of
 * wrapping it in a tree node.
 *
 * VIEW-LOCAL STATE: the collapsed ids live only in the ProseMirror plugin
 * state, never in the document. Collapsing is therefore presentation only — not
 * collaborative, not saved, and not undoable. `headingSubtrees` decides which
 * headings own a body (and so get a chevron), `visibleBlocks` resolves the ids
 * to hide, and `toggleCollapse` flips one id immutably.
 *
 * Registered through `Toggle.addExtensions()` (see above) so the shared
 * `page-editor.tsx` stays untouched, mirroring the input-rules slice. Deleting
 * the hook once this extension is mounted directly is safe: the name
 * `toggleHeading` is unique.
 */

/** Plugin state: the ids of headings whose owned run is currently hidden. */
interface ToggleHeadingState {
  collapsed: Set<string>;
}

/** Transaction meta: flip one heading id in the collapsed set. */
interface ToggleHeadingMeta {
  toggle: string;
}

/** Identifies the toggle-heading plugin (state + meta channel). */
export const toggleHeadingPluginKey = new PluginKey<ToggleHeadingState>("toggleHeading");

/** The document's top-level blocks in the shared lib's minimal shape. */
function toggleHeadingBlocks(doc: PMNode): ToggleBlock[] {
  const blocks: ToggleBlock[] = [];
  doc.forEach((node) => {
    const id = node.attrs.id;
    blocks.push({
      id: typeof id === "string" && id !== "" ? id : undefined,
      type: node.type.name,
      level: node.type.name === "heading" ? Number(node.attrs.level) : undefined,
    });
  });
  return blocks;
}

/** Lucide `ChevronRight`, built imperatively so a widget needs no React root. */
function chevronGlyph(collapsed: boolean): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  // Collapsed points right (closed); expanded rotates to point down (open).
  svg.style.transform = collapsed ? "none" : "rotate(90deg)";
  svg.style.transition = "transform 120ms ease";
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "m9 18 6-6-6-6");
  svg.appendChild(path);
  return svg;
}

/** The clickable chevron widget that collapses/expands one heading. */
function toggleHeadingWidget(
  view: EditorView,
  headingId: string,
  collapsed: boolean,
  locale: string,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "noema-toggle-heading-chevron";
  button.dataset.toggleHeading = headingId;
  button.setAttribute("contenteditable", "false");
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", t(locale, collapsed ? "toggleExpand" : "toggleCollapse"));
  button.draggable = false;
  button.style.display = "inline-flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.marginRight = "0.25em";
  button.style.padding = "0";
  button.style.border = "none";
  button.style.background = "none";
  button.style.color = "inherit";
  button.style.cursor = "pointer";
  button.style.verticalAlign = "middle";
  button.appendChild(chevronGlyph(collapsed));
  // Suppress the caret move on mousedown so the click toggles in place.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    view.dispatch(view.state.tr.setMeta(toggleHeadingPluginKey, { toggle: headingId }));
  });
  return button;
}

/**
 * The decoration set for the current document and collapsed set: a chevron
 * before each toggle-capable heading that owns a body, plus a `display: none`
 * node decoration over every block hidden below a collapsed heading. Pure —
 * reads the document and returns decorations, never mutating either.
 */
export function toggleHeadingDecorations(
  doc: PMNode,
  collapsed: ReadonlySet<string>,
  locale: string,
): DecorationSet {
  const blocks = toggleHeadingBlocks(doc);
  if (blocks.length === 0) return DecorationSet.empty;

  const visible = new Set(visibleBlocks(blocks, collapsed));
  const ownedCount = new Map<string, number>();
  for (const { headingId, childIds } of headingSubtrees(blocks)) {
    ownedCount.set(headingId, childIds.length);
  }

  const decorations: Decoration[] = [];
  doc.forEach((node, offset, index) => {
    const block = blocks[index];
    const id = blockId(block, index);

    // A chevron only makes sense where there is something to collapse.
    if (canToggle(block) && (ownedCount.get(id) ?? 0) > 0) {
      const isCollapsed = collapsed.has(id);
      decorations.push(
        Decoration.widget(
          offset + 1,
          (view) => toggleHeadingWidget(view, id, isCollapsed, locale),
          {
            side: -1,
            key: `toggle-heading-${id}-${isCollapsed ? "collapsed" : "expanded"}`,
          },
        ),
      );
    }

    if (!visible.has(block)) {
      decorations.push(
        Decoration.node(offset, offset + node.nodeSize, { style: "display: none" }),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * The extension itself: a plugin owning the view-local collapsed set and the
 * chevron/hide decorations. Non-heading blocks are never decorated unless a
 * collapsed heading owns them, and with nothing collapsed the decoration set is
 * empty, so rendering is byte-for-byte unchanged.
 */
export const ToggleHeading = Extension.create<{ locale: string }>({
  name: "toggleHeading",

  addOptions() {
    return { locale: "en" };
  },

  addProseMirrorPlugins() {
    const locale = this.options.locale;
    return [
      new Plugin<ToggleHeadingState>({
        key: toggleHeadingPluginKey,
        state: {
          init: () => ({ collapsed: new Set<string>() }),
          apply: (transaction, value) => {
            const meta = transaction.getMeta(toggleHeadingPluginKey) as
              | ToggleHeadingMeta
              | undefined;
            if (!meta?.toggle) return value;
            return { collapsed: toggleCollapse(value.collapsed, meta.toggle) };
          },
        },
        props: {
          decorations(state: EditorState) {
            const pluginState = toggleHeadingPluginKey.getState(state);
            if (!pluginState) return DecorationSet.empty;
            return toggleHeadingDecorations(state.doc, pluginState.collapsed, locale);
          },
        },
      }),
    ];
  },
});

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
