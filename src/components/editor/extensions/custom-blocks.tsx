"use client";

/**
 * Custom Notion-parity blocks for the Noema editor.
 *
 * Each block is a TipTap node. Where the block needs interactive chrome
 * (emoji picker, collapse toggle, live heading outline) it uses a React node
 * view; purely structural blocks (columns) render with plain markup + CSS.
 * The toggle-heading chevron is the exception: headings come from StarterKit,
 * so it is added as a decoration-only plugin (see `ToggleHeading`) rather than
 * a node view, and — since this slice — it remembers the collapsed state per
 * page in `localStorage` instead of only in the live editor view.
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
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties as ReactCSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
import {
  blocksToQuote,
  formatPullQuote,
  parsePullQuote,
  validatePullQuote,
  type PullQuoteBlock,
} from "@/lib/pull-quote";
import { t } from "@/lib/i18n";
import { DUR, EASE, Z } from "@/lib/design-tokens";
import { prefersReducedMotion } from "@/components/editor/extensions/animated-image";

/* ------------------------------------------------------------- motion (§6/§19) */

/**
 * Toggle / callout expand motion (DESIGN_SYSTEM §6, FRONTEND_PLAN 19.10): the
 * body animates height + opacity over the base duration while the chevron
 * rotates a quarter turn. Pure mapping so the view and its test agree.
 */
export type ExpandMotion = {
  className: string;
  duration: number;
  easing: string;
  chevronTransform: string;
};

export function toggleExpandMotion(open: boolean): ExpandMotion {
  return {
    className: open ? "noema-toggle-open" : "noema-toggle-closed",
    duration: DUR.base,
    easing: EASE.smooth,
    chevronTransform: open ? "rotate(90deg)" : "rotate(0deg)",
  };
}

/**
 * To-do tick motion (DESIGN_SYSTEM §6, FRONTEND_PLAN 19.9): a short check draw
 * followed by a slightly longer strikethrough fade on the text. Specified
 * 160 ms / 200 ms land on the shared duration tokens — the design system allows
 * no ad-hoc millisecond values — while keeping the draw shorter than the fade.
 */
export type CheckboxTickMotion = {
  className: string;
  draw: number;
  strike: number;
  easing: string;
};

export function checkboxTickMotion(checked: boolean): CheckboxTickMotion {
  return {
    className: checked ? "noema-task-checked" : "noema-task-unchecked",
    draw: DUR.fast,
    strike: DUR.base,
    easing: EASE.smooth,
  };
}

/**
 * Play the to-do tick for a checkbox the user just toggled: a short scale/opacity
 * pop on the check, then the strikethrough colour fading in on the sibling text.
 * Pure presentation — reads the rendered DOM only, never the document, and
 * no-ops under reduced motion. `input.checked` already holds the new value when
 * the DOM `change` event reaches the editor.
 */
export function animateTaskTick(input: HTMLInputElement): void {
  if (prefersReducedMotion()) return;
  const item = input.closest("li[data-checked]");
  if (!(item instanceof HTMLElement)) return;
  const motion = checkboxTickMotion(input.checked);
  item.classList.add(motion.className);
  window.setTimeout(() => item.classList.remove(motion.className), motion.strike + 40);
  if (typeof input.animate === "function") {
    const animation = input.animate(
      input.checked
        ? [
            { transform: "scale(0.6)", opacity: 0.4 },
            { transform: "scale(1)", opacity: 1 },
          ]
        : [
            { transform: "scale(1.15)", opacity: 1 },
            { transform: "scale(1)", opacity: 1 },
          ],
      { duration: motion.draw, easing: motion.easing },
    );
    animation.addEventListener("finish", () => animation.cancel());
  }
  const text = item.querySelector("p");
  if (text instanceof HTMLElement && typeof text.animate === "function") {
    const fade = text.animate(
      [
        { textDecorationColor: input.checked ? "transparent" : "currentColor" },
        { textDecorationColor: input.checked ? "currentColor" : "transparent" },
      ],
      { duration: motion.strike, easing: motion.easing },
    );
    fade.addEventListener("finish", () => fade.cancel());
  }
}

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

/**
 * Callout background per colour name. The serialised `color` attribute stores
 * the hue *name* ("blue", "red", …), never a colour value, so this is pure
 * presentation and reads the shared tag palette (`--tag-<hue>-bg`) instead of
 * hard-coding Notion's pastels — every hue then follows light / dark /
 * high-contrast automatically. `gray` (also the fallback) is the neutral
 * surface.
 */
const CALLOUT_COLORS: Record<string, string> = {
  gray: "var(--surface)",
  blue: "var(--tag-blue-bg)",
  green: "var(--tag-green-bg)",
  yellow: "var(--tag-yellow-bg)",
  red: "var(--tag-red-bg)",
  purple: "var(--tag-purple-bg)",
  orange: "var(--tag-orange-bg)",
  pink: "var(--tag-pink-bg)",
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
      className="noema-callout animate-fade"
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

  // Anchors the toggle-heading chevron and the pull-quote blockquote variant to
  // the editor without touching the shared `page-editor.tsx` (the same
  // `addExtensions` pattern the input-rules slice uses). Drop this hook once
  // both are mounted directly.
  addExtensions() {
    return [
      ToggleHeading.configure({ locale: this.options.locale }),
      PullQuote,
    ];
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
  const motion = toggleExpandMotion(open);
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
            style={{
              transform: motion.chevronTransform,
              transition: "transform var(--dur-2) var(--ease-smooth)",
            }}
          />
        </button>
        <input
          value={String(node.attrs.summary ?? "")}
          placeholder={t(locale, "blockToggle")}
          onChange={(e) => updateAttributes({ summary: e.target.value })}
          className="noema-toggle-summary"
        />
      </div>
      {/*
       * Height animates with the `grid-template-rows: 0fr → 1fr` technique, so
       * the change is measured-free and never jumps (DESIGN_SYSTEM §6,
       * FRONTEND_PLAN 19.10); `inert` keeps collapsed content out of the tab
       * order and hidden from assistive tech, matching the old `display: none`.
       */}
      <div
        className="noema-toggle-body"
        aria-hidden={open ? undefined : true}
        inert={open ? undefined : true}
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          transition:
            "grid-template-rows var(--dur-2) var(--ease-smooth), opacity var(--dur-2) var(--ease-smooth)",
        }}
      >
        <NodeViewContent style={{ overflow: "hidden", minHeight: 0 }} />
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
 * PERSISTED STATE: the collapsed ids live in the ProseMirror plugin state and
 * are mirrored to `localStorage`, keyed by the page's route, so a reload
 * restores the same collapse without writing anything into the document.
 * Collapsing is therefore presentation only — not collaborative and not
 * undoable — but it now survives a refresh. `headingSubtrees` decides which
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
  svg.style.transition = "transform var(--dur-1) var(--ease-smooth)";
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
 * `localStorage` namespace for a page's collapsed toggle-heading ids. The
 * suffix is the page identity (its editor route), so each page keeps its own
 * collapse state instead of sharing one editor-wide set.
 */
const TOGGLE_HEADING_STORAGE_PREFIX = "noema:toggle-heading:";

/**
 * Identity of the page an editor is mounted on, used to scope the persisted
 * collapse set. The workspace route is `/w/<slug>/<pageId>`, so the pathname is
 * a stable per-page key. Outside a browser (SSR, the node test env) there is no
 * location and it degrades to `""`, which makes persistence a no-op.
 */
function currentToggleHeadingPageId(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.location?.pathname ?? "";
  } catch {
    return "";
  }
}

/** The `localStorage` key for one page's collapsed set (`""` when unkeyed). */
function toggleHeadingStorageKey(pageId: string): string {
  return pageId === "" ? "" : `${TOGGLE_HEADING_STORAGE_PREFIX}${pageId}`;
}

/**
 * Read the persisted collapsed ids for `key`. Absent, unparseable, non-array or
 * non-string entries are dropped rather than thrown, so a corrupted entry can
 * never break editor start-up; the result is always a fresh `Set`.
 */
function readToggleHeadingCollapsed(key: string): Set<string> {
  if (key === "" || typeof window === "undefined") return new Set<string>();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set<string>();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    const ids = new Set<string>();
    for (const value of parsed) {
      if (typeof value === "string" && value !== "") ids.add(value);
    }
    return ids;
  } catch {
    return new Set<string>();
  }
}

/**
 * Persist the collapsed ids for `key`. An empty set clears the entry rather than
 * storing `[]`, and every failure (quota, disabled storage, SSR) is swallowed:
 * persistence is best-effort and the in-memory set stays authoritative, so
 * toggling a heading can never throw because of storage.
 */
function writeToggleHeadingCollapsed(
  key: string,
  collapsed: ReadonlySet<string>,
): void {
  if (key === "" || typeof window === "undefined") return;
  try {
    if (collapsed.size === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify([...collapsed]));
  } catch {
    // Best-effort: the plugin state already holds the new set.
  }
}

/**
 * The extension itself: a plugin owning the collapsed set (seeded from
 * `localStorage` and written back on every toggle) and the chevron/hide
 * decorations. Non-heading blocks are never decorated unless a collapsed
 * heading owns them, and with nothing collapsed the decoration set is empty, so
 * rendering is byte-for-byte unchanged.
 *
 * `pageId` names the persistence scope; when omitted the page's route is used
 * (see {@link currentToggleHeadingPageId}), so `Toggle.addExtensions()` can keep
 * configuring only `locale`.
 */
export const ToggleHeading = Extension.create<{ locale: string; pageId: string }>({
  name: "toggleHeading",

  addOptions() {
    return { locale: "en", pageId: "" };
  },

  addProseMirrorPlugins() {
    const locale = this.options.locale;
    const pageId =
      this.options.pageId.trim() !== ""
        ? this.options.pageId
        : currentToggleHeadingPageId();
    const storageKey = toggleHeadingStorageKey(pageId);
    return [
      new Plugin<ToggleHeadingState>({
        key: toggleHeadingPluginKey,
        state: {
          init: () => ({ collapsed: readToggleHeadingCollapsed(storageKey) }),
          apply: (transaction, value) => {
            const meta = transaction.getMeta(toggleHeadingPluginKey) as
              | ToggleHeadingMeta
              | undefined;
            if (!meta?.toggle) return value;
            const collapsed = toggleCollapse(value.collapsed, meta.toggle);
            writeToggleHeadingCollapsed(storageKey, collapsed);
            return { collapsed };
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

/* --------------------------------------------------------------- pull quote */

/**
 * Pull-quote / large-quote variant for blockquotes (docs/MISSING_FEATURES §1,
 * "display-scale quotation styling" — planned as a quote variant).
 *
 * A pull quote is not a new node: it is an ordinary `blockquote` that carries
 * `size: 'large'` and, optionally, an attribution in the paragraph that
 * follows it — exactly the two-block shape `src/lib/pull-quote.ts` models.
 *
 * The `size` attribute is added globally (the same `addGlobalAttributes`
 * pattern `BlockColors` uses) so the variant round-trips through JSON and HTML
 * as `data-size="large"`. The display scale and the attribution emphasis are
 * view-local node decorations, so a normal blockquote (no `size`, or
 * `"default"`) renders byte-for-byte as it did before.
 *
 * Anchored through `Toggle.addExtensions()` — this file's established hook —
 * because `page-editor.tsx` owns the shared extension list. Drop the
 * hook once `PullQuote` is mounted there directly.
 */

/** Inline scale for the quoted words of a display-size blockquote. */
const PULL_QUOTE_STYLE = "font-size: 1.5em; font-weight: 600; line-height: 1.45;";

/** Inline de-emphasis for the attribution line under the quote. */
const PULL_QUOTE_ATTRIBUTION_STYLE = "font-size: 0.9em; opacity: 0.75; text-align: right;";

/** Project a ProseMirror block into the lib's minimal block shape. */
function pullQuoteBlock(node: PMNode): PullQuoteBlock {
  const text = node.textContent.trim();
  const block: PullQuoteBlock = {
    type: node.type.name === "blockquote" ? "blockquote" : "paragraph",
    content: text ? [{ type: "text", text }] : [],
  };
  if (node.type.name === "blockquote" && node.attrs.size === "large") {
    block.attrs = { size: "large" };
  }
  return block;
}

/** Identifies the pull-quote plugin (its decoration provider). */
export const pullQuotePluginKey = new PluginKey("pullQuote");

/**
 * Decorations for every top-level pull quote in `doc`: the blockquote gets the
 * display scale and (when present) the attribution paragraph that follows it
 * is emphasised. Pure — reads the document, returns decorations, never mutates.
 *
 * The quote/attribution split is delegated to `src/lib/pull-quote.ts`:
 * `blocksToQuote` reads the pair, `parsePullQuote` normalises it and
 * `validatePullQuote` gates the variant, so a malformed `size: 'large'` node
 * (empty or invalid) falls back to an ordinary blockquote. An ordinary
 * following paragraph — one that carried no attribution dash, and so survived
 * the lib's strip unchanged — is left as a plain paragraph.
 */
export function pullQuoteDecorations(doc: PMNode): DecorationSet {
  const blocks: PMNode[] = [];
  const offsets: number[] = [];
  doc.forEach((node, offset) => {
    blocks.push(node);
    offsets.push(offset);
  });

  const decorations: Decoration[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const node = blocks[index];
    if (node.type.name !== "blockquote" || node.attrs.size !== "large") continue;
    if (node.textContent.trim() === "") continue;

    const next = blocks[index + 1];
    const pair: PullQuoteBlock[] = [pullQuoteBlock(node)];
    if (next && next.type.name === "paragraph") pair.push(pullQuoteBlock(next));

    const quote = blocksToQuote(pair);
    const parsed = parsePullQuote(quote);
    if (!parsed.ok) continue;
    if (!validatePullQuote(parsed.value).ok) continue;

    const start = offsets[index];
    decorations.push(
      Decoration.node(start, start + node.nodeSize, {
        class: "noema-pull-quote",
        "data-pull-quote": "",
        style: PULL_QUOTE_STYLE,
        title: formatPullQuote(parsed.value),
      }),
    );

    // Only a paragraph the lib actually read as an attribution is emphasised.
    // When `blocksToQuote` found an attribution different from the raw text,
    // the lib stripped a leading dash — i.e. this really is an attribution.
    const rawNext = next?.textContent.trim() ?? "";
    const isAttribution =
      next?.type.name === "paragraph" &&
      quote.attribution !== undefined &&
      quote.attribution !== rawNext;
    if (isAttribution && next) {
      const attrStart = offsets[index + 1];
      decorations.push(
        Decoration.node(attrStart, attrStart + next.nodeSize, {
          class: "noema-pull-quote-attribution",
          style: PULL_QUOTE_ATTRIBUTION_STYLE,
        }),
      );
    }
  }

  return DecorationSet.create(doc, decorations);
}

/**
 * The pull-quote variant: a global `size` attribute on `blockquote` plus a
 * decoration-only plugin. No new node type and no document mutation, so normal
 * blockquotes are unchanged.
 */
export const PullQuote = Extension.create({
  name: "pullQuote",

  addGlobalAttributes() {
    return [
      {
        types: ["blockquote"],
        attributes: {
          size: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-size"),
            renderHTML: (attributes) =>
              attributes.size === "large" ? { "data-size": "large" } : {},
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pullQuotePluginKey,
        props: {
          decorations(state: EditorState) {
            return pullQuoteDecorations(state.doc);
          },
        },
      }),
    ];
  },
});

/* ------------------------------------------------------------------ columns */

/**
 * Columns container (docs/MISSING_FEATURES §1 "Columns (2/3/4/5)" + "Column
 * resize"; spec docs/specs/editor-deep.md R84.1-R84.3).
 *
 * The block is a plain structural node whose HTML contract (`div[data-columns]`
 * → `div[data-column]`) is unchanged, so paste, the read-only renderer
 * (`doc-renderer.tsx`) and the export serialiser (`serialize.ts`) keep working.
 * What this slice adds is editor-only chrome: the count is now allowed to run
 * 2–5 (was capped at 4), a hover toolbar grows/shrinks the container between
 * those bounds, and the divider between two adjacent columns is draggable (a
 * `separator`) to trade flex weight between them.
 *
 * Widths live on the `column` node's optional `width` attribute, so a resized
 * layout round-trips through save/load like any other block attribute; an
 * untouched column has `width: null` and renders exactly as before.
 */

/** Columns a container may hold (Notion's 2–5 range). */
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 5;

/** A divider drag never narrows a column past this many pixels. */
const COLUMN_MIN_WIDTH_PX = 64;

/** How far one Arrow keypress moves a focused divider. */
const COLUMN_NUDGE_PX = 16;

/**
 * Style for the container's add/remove toolbar buttons: the accent token marks
 * the controls as actions, with the disabled state falling back to muted
 * (DESIGN_SYSTEM §2/§8, FRONTEND_PLAN 19.15).
 */
export function columnControlStyle(disabled: boolean): ReactCSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    height: "20px",
    padding: "0",
    fontSize: "14px",
    lineHeight: "1",
    color: disabled ? "var(--muted)" : "var(--accent)",
    background: disabled ? "var(--surface-2)" : "var(--accent-soft)",
    border: `1px solid ${disabled ? "var(--border)" : "var(--accent)"}`,
    borderRadius: "4px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

/**
 * The columns toolbar fades in on container hover (and while a control inside
 * it holds focus, for keyboard parity), mirroring the block row chrome.
 */
export function columnsToolbarClass(): string {
  return [
    "noema-columns-toolbar",
    "u-colors",
    "pointer-events-none opacity-0",
    "group-hover:pointer-events-auto group-hover:opacity-100",
    "focus-within:pointer-events-auto focus-within:opacity-100",
  ].join(" ");
}

/** A column's stored weight when it is a usable positive number, else `null`. */
function columnWidthAttr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** A column's positive flex weight, falling back to 1 (an equal share). */
function normalizeColumnWeight(value: unknown): number {
  return columnWidthAttr(value) ?? 1;
}

/** Clamp `value` into `[min, max]`, tolerating a reversed pair of bounds. */
function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, Math.min(min, max)), Math.max(min, max));
}

/** Round a flex weight to three decimals so stored values stay compact. */
function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Smallest flex weight that still leaves the sibling at least as wide. */
function minColumnWeight(total: number, available: number): number {
  if (!(available > 0)) return 0;
  return Math.min((COLUMN_MIN_WIDTH_PX * total) / available, total / 2);
}

/** Geometry of the columns row a `column` node belongs to. */
interface ColumnsGeometry {
  /** Document position of the enclosing `columns` node. */
  columnsPos: number;
  /** Index of the inspected column within its container. */
  index: number;
  /** Number of columns in the container. */
  count: number;
  /** Per-column flex weights, left to right. */
  weights: number[];
  /** Measured content width available to the columns, in pixels. */
  available: number;
}

/** Sum the rendered widths of a columns container's column elements. */
function measureColumnsWidth(
  editor: NodeViewProps["editor"],
  columnPos: number,
): number {
  try {
    const dom = editor.view.nodeDOM(columnPos);
    if (!(dom instanceof HTMLElement)) return 0;
    const row = dom.parentElement;
    if (!row) return 0;
    let total = 0;
    for (const element of Array.from(row.children)) {
      if (element instanceof HTMLElement && element.hasAttribute("data-column")) {
        total += element.getBoundingClientRect().width;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Read the columns row that owns `columnPos`: sibling weights, this column's
 * index and the measured available width. Pure with respect to the document —
 * it only resolves positions and reads layout — and returns `null` for a stale
 * position or a node that is not a `column`.
 */
function readColumnsGeometry(
  editor: NodeViewProps["editor"],
  columnPos: number | undefined,
): ColumnsGeometry | null {
  if (typeof columnPos !== "number") return null;
  let resolved;
  try {
    resolved = editor.state.doc.resolve(columnPos);
  } catch {
    return null;
  }
  const parent = resolved.parent;
  if (parent.type.name !== "columns") return null;

  const weights: number[] = [];
  let index = -1;
  parent.forEach((child, offset, childIndex) => {
    if (offset === resolved.parentOffset) index = childIndex;
    weights.push(normalizeColumnWeight(child.attrs.width));
  });
  if (index < 0) return null;

  return {
    columnsPos: resolved.before(),
    index,
    count: weights.length,
    weights,
    available: measureColumnsWidth(editor, columnPos),
  };
}

/**
 * Set the `width` of two adjacent columns in one collab-safe transaction. The
 * offsets are derived from the container's own children, so a stale `columnsPos`
 * degrades to a no-op (the `columns` type check) rather than corrupting a
 * neighbour.
 */
function applyColumnWeights(
  editor: NodeViewProps["editor"],
  columnsPos: number,
  leftIndex: number,
  leftWeight: number,
  rightWeight: number,
): void {
  const columnsNode = editor.state.doc.nodeAt(columnsPos);
  if (!columnsNode || columnsNode.type.name !== "columns") return;
  const tr = editor.state.tr;
  let offset = columnsPos + 1;
  for (let i = 0; i < columnsNode.childCount; i += 1) {
    const child = columnsNode.child(i);
    if (i === leftIndex) {
      tr.setNodeMarkup(offset, undefined, {
        ...child.attrs,
        width: roundWeight(leftWeight),
      });
    } else if (i === leftIndex + 1) {
      tr.setNodeMarkup(offset, undefined, {
        ...child.attrs,
        width: roundWeight(rightWeight),
      });
    }
    offset += child.nodeSize;
  }
  editor.view.dispatch(tr);
}

/** Append an empty column to the container at `pos` (no-op at `MAX_COLUMNS`). */
function appendColumn(editor: NodeViewProps["editor"], pos: number): void {
  const columnsNode = editor.state.doc.nodeAt(pos);
  if (!columnsNode || columnsNode.type.name !== "columns") return;
  if (columnsNode.childCount >= MAX_COLUMNS) return;
  const columnType = editor.state.schema.nodes.column;
  const paragraphType = editor.state.schema.nodes.paragraph;
  if (!columnType || !paragraphType) return;
  const column = columnType.create(null, paragraphType.create());
  editor.view.dispatch(editor.state.tr.insert(pos + 1 + columnsNode.content.size, column));
}

/**
 * Remove the container's last column (no-op at `MIN_COLUMNS`). The container is
 * never unwrapped here because it can never fall below two columns while
 * wrapped; reaching a single column by unwrapping is a follow-up.
 */
function removeLastColumn(editor: NodeViewProps["editor"], pos: number): void {
  const columnsNode = editor.state.doc.nodeAt(pos);
  if (!columnsNode || columnsNode.type.name !== "columns") return;
  if (columnsNode.childCount <= MIN_COLUMNS) return;
  const last = columnsNode.child(columnsNode.childCount - 1);
  const end = pos + 1 + columnsNode.content.size;
  editor.view.dispatch(editor.state.tr.delete(end - last.nodeSize, end));
}

/** Hover toolbar: add a column (≤5) or remove the last one (≥2). */
function ColumnsView({ node, editor, getPos, locale }: NodeViewProps & { locale: string }) {
  const editable = editor.isEditable;
  const count = node.childCount;
  const canAdd = count < MAX_COLUMNS;
  const canRemove = count > MIN_COLUMNS;

  const append = () => {
    const pos = getPos();
    if (typeof pos === "number") appendColumn(editor, pos);
  };
  const removeLast = () => {
    const pos = getPos();
    if (typeof pos === "number") removeLastColumn(editor, pos);
  };

  return (
    <NodeViewWrapper className="noema-columns group" style={{ position: "relative" }}>
      {/* The content element doubles as the flex row the CSS targets. */}
      <NodeViewContent className="noema-columns-content" data-columns="" />
      {editable && (
        <div
          className={columnsToolbarClass()}
          contentEditable={false}
          style={{
            position: "absolute",
            top: "2px",
            right: "2px",
            display: "flex",
            gap: "2px",
            zIndex: Z.sticky,
          }}
        >
          <button
            type="button"
            aria-label={t(locale, "add")}
            title={t(locale, "add")}
            disabled={!canAdd}
            onClick={append}
            style={columnControlStyle(!canAdd)}
          >
            +
          </button>
          <button
            type="button"
            aria-label={t(locale, "remove")}
            title={t(locale, "remove")}
            disabled={!canRemove}
            onClick={removeLast}
            style={columnControlStyle(!canRemove)}
          >
            −
          </button>
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const Columns = Node.create<{ locale: string }>({
  name: "columns",
  group: "block",
  content: "column+",
  isolating: true,

  addOptions() {
    return { locale: "en" };
  },

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
        (count = MIN_COLUMNS) =>
        ({ commands }) => {
          const column = {
            type: "column",
            content: [{ type: "paragraph" }],
          };
          return commands.insertContent({
            type: this.name,
            content: Array.from(
              { length: Math.max(MIN_COLUMNS, Math.min(count, MAX_COLUMNS)) },
              () => column,
            ),
          });
        },
    };
  },

  addNodeView() {
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <ColumnsView {...props} locale={locale} />
    ));
  },
});

/**
 * One column: the same `<div data-column>` as the plain renderer, plus a
 * draggable divider on its trailing edge (every column but the last). Dragging —
 * or focusing the divider and pressing ArrowLeft/ArrowRight — transfers flex
 * weight to/from the right neighbour, stored as the node's `width` attribute.
 */
function ColumnView({ node, editor, getPos, locale }: NodeViewProps & { locale: string }) {
  const editable = editor.isEditable;
  const storedWidth = columnWidthAttr(node.attrs.width);
  const geometry = readColumnsGeometry(editor, getPos());
  const isLast = geometry === null || geometry.index >= geometry.count - 1;

  const resize = (leftStart: number, total: number, deltaPixels: number, available: number, index: number, columnsPos: number) => {
    const minWeight = minColumnWeight(total, available);
    const left = clampNumber(leftStart + (deltaPixels * total) / available, minWeight, total - minWeight);
    applyColumnWeights(editor, columnsPos, index, left, total - left);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const pos = getPos();
    const current = readColumnsGeometry(editor, pos);
    if (!current || !(current.available > 0)) return;
    const index = current.index;
    if (index + 1 >= current.count) return;
    event.preventDefault();

    const startX = event.clientX;
    const total = current.weights[index] + current.weights[index + 1];
    const leftStart = current.weights[index];
    const { available, columnsPos } = current;

    const onMove = (move: PointerEvent) => {
      resize(leftStart, total, move.clientX - startX, available, index, columnsPos);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const nudge = (direction: -1 | 1) => {
    const pos = getPos();
    const current = readColumnsGeometry(editor, pos);
    if (!current || !(current.available > 0)) return;
    const index = current.index;
    if (index + 1 >= current.count) return;
    const total = current.weights[index] + current.weights[index + 1];
    resize(current.weights[index], total, direction * COLUMN_NUDGE_PX, current.available, index, current.columnsPos);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      nudge(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      nudge(1);
    }
  };

  return (
    <NodeViewWrapper
      className="noema-column"
      data-column=""
      style={{
        position: "relative",
        ...(storedWidth === null ? {} : { flexGrow: storedWidth }),
      }}
    >
      {/* `display: contents` keeps the block children as the wrapper's flow
          children, so `[data-column] > * + *` and the flex sizing still apply. */}
      <NodeViewContent style={{ display: "contents" }} />
      {editable && !isLast && (
        <span
          className="noema-column-resize u-no-transition"
          role="separator"
          aria-orientation="vertical"
          aria-label={t(locale, "blockColumns")}
          contentEditable={false}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
          style={{
            position: "absolute",
            top: "0",
            bottom: "0",
            right: "-14px",
            width: "2px",
            padding: "0 5px",
            boxSizing: "content-box",
            background: "var(--border)",
            backgroundClip: "content-box",
            cursor: "col-resize",
            zIndex: Z.sticky,
          }}
        />
      )}
    </NodeViewWrapper>
  );
}

export const Column = Node.create<{ locale: string }>({
  name: "column",
  content: "block+",
  isolating: true,

  addOptions() {
    return { locale: "en" };
  },

  addAttributes() {
    return {
      /**
       * Relative flex weight for a divider-resized column. `null` (the default)
       * means an equal share and renders exactly as before; a drag stores a
       * positive number that round-trips as `data-width`.
       */
      width: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-width");
          if (raw === null) return null;
          const parsed = Number.parseFloat(raw);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        },
        renderHTML: (attributes) => {
          const weight = columnWidthAttr(attributes.width);
          return weight === null ? {} : { "data-width": String(weight) };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-column]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-column": "" }), 0];
  },

  addNodeView() {
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <ColumnView {...props} locale={locale} />
    ));
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
