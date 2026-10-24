"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { type Editor } from "@tiptap/react";
import {
  Bookmark as BookmarkIcon,
  ChevronRight,
  Columns2,
  Columns3,
  Columns4,
  Compass,
  Copy,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  ImagePlus,
  Layers,
  Lightbulb,
  List,
  ListOrdered,
  ListTodo,
  ListTree,
  Map as MapIcon,
  Minus,
  Pilcrow,
  Quote,
  SearchX,
  Sigma,
  Sparkles,
  SquareCode,
  Table as TableIcon,
  Video,
  Workflow
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/design-tokens";
import { placeFloating } from "@/lib/floating";
import { Kbd } from "@/components/ui/kbd";
import { EmptyState } from "@/components/ui/empty-state";
import { EQUATION_EVENT } from "@/lib/editor-events";
import { MERMAID_TEMPLATES } from "@/lib/diagrams/mermaid-policy";
import { starterUmlDiagram } from "@/lib/diagrams/uml";
import { PLANTUML_TEMPLATES } from "@/lib/diagrams/plantuml-policy";
import { t } from "@/lib/i18n";
import { BLOCK_TYPES } from "@/lib/block-conversion";
import {
  filterCommands,
  rankCommands,
  type SlashCommand,
} from "@/lib/slash-commands";

/* ---------------------------------------------------------------------------
   Slash menu
   ------------------------------------------------------------------------- */

type I18nKey = Parameters<typeof t>[1];

/** A section the menu can render. `recent` is a synthetic, recency-only slot. */
export type SlashGroupId =
  | "recent"
  | "basic"
  | "media"
  | "database"
  | "advanced";

/**
 * Section order, in display order. `recent` is always first when it has rows;
 * the rest is the canonical block taxonomy (Notion's Basic / Media / Database /
 * Advanced), so a searched list never reorders itself between keystrokes.
 */
export const SLASH_GROUP_ORDER: readonly SlashGroupId[] = [
  "recent",
  "basic",
  "media",
  "database",
  "advanced",
];

/**
 * Section headings. English literals awaiting catalogue keys: the i18n
 * catalogue (`src/lib/i18n.ts`) is owned by another slice, so the new section
 * names ship as literals — the same documented fallback the rich-block rows
 * use for their labels.
 */
export const SLASH_GROUP_LABELS: Record<SlashGroupId, string> = {
  recent: "Recently used",
  basic: "Basic",
  media: "Media",
  database: "Database",
  advanced: "Advanced",
};

/** Footer key-hint strings (also awaiting catalogue keys). */
export const SLASH_FOOTER_HINTS = {
  navigate: "Navigate",
  select: "Select",
  dismiss: "Dismiss",
} as const;

/** How many habitually-picked rows precede the full catalogue. */
export const SLASH_RECENT_LIMIT = 3;
/** Design bounds used to resolve the slash menu's collision-aware placement. */
export const SLASH_MENU_WIDTH = 352;
export const SLASH_MENU_MAX_HEIGHT = 320;

/** The presentation shape the surface renders (icons are opaque React nodes). */
export type SlashMenuItem = {  label: string;
  labelKey?: I18nKey;
  hint: string;
  hintKey?: I18nKey;
  icon: React.ReactNode;
  /** Shortcut hint rendered as a right-aligned `Kbd` when present. */
  shortcut?: string;
};

type SlashItem = SlashMenuItem & {
  keywords: string;
  group: Exclude<SlashGroupId, "recent">;
  run?: (chain: ReturnType<Editor["chain"]>) => void;
  action?: () => void;
};

/** Slash metadata for a graph type: a {@link SlashItem} minus the injected action. */
type BlockTypeItem = Omit<SlashItem, "action">;

/**
 * The conversion-graph block types the menu can insert. The graph is complete
 * (every block converts into every other, `allowedTargets` reaches all of
 * `BLOCK_TYPES`), so the only exclusions are graph types with no editor
 * adapter. `pullQuote` is the sole one: the editor models it as a `blockquote`
 * variant (`size: "large"`) with no insertion command and no i18n label, so an
 * entry would silently no-op — the same call `block-context-menu.tsx` makes for
 * its "turn into" submenu. It returns here once it gains a command and a label.
 *
 * Keying the table off `BLOCK_TYPES` is the sync guarantee: adding a type to
 * the conversion graph is a `tsc` error here until it is either given an entry
 * (and so reaches the menu through {@link blockItem}) or added to the `Exclude`.
 */
type SlashBlockType = Exclude<(typeof BLOCK_TYPES)[number], "pullQuote">;

/** Insertion command for each insertable graph block type, keyed by type. */
const BLOCK_TYPE_ITEMS: Record<SlashBlockType, BlockTypeItem> = {
  paragraph: { label: "Text", labelKey: "blockText", hint: "Plain paragraph", hintKey: "paragraphHint", icon: <Pilcrow className="h-4 w-4" />, keywords: "text paragraph body", group: "basic", run: (c) => c.setParagraph().run() },
  h1: { label: "Heading 1", labelKey: "blockHeading1", hint: "Large heading", hintKey: "heading1Hint", icon: <Heading1 className="h-4 w-4" />, keywords: "h1 title", group: "basic", shortcut: "⌘ ⌥ 1", run: (c) => c.toggleHeading({ level: 1 }).run() },
  h2: { label: "Heading 2", labelKey: "blockHeading2", hint: "Medium heading", hintKey: "heading2Hint", icon: <Heading2 className="h-4 w-4" />, keywords: "h2 subtitle", group: "basic", shortcut: "⌘ ⌥ 2", run: (c) => c.toggleHeading({ level: 2 }).run() },
  h3: { label: "Heading 3", labelKey: "blockHeading3", hint: "Small heading", hintKey: "heading3Hint", icon: <Heading3 className="h-4 w-4" />, keywords: "h3", group: "basic", shortcut: "⌘ ⌥ 3", run: (c) => c.toggleHeading({ level: 3 }).run() },
  bulletedList: { label: "Bulleted list", labelKey: "blockBulletedList", hint: "Unordered list", hintKey: "bulletedListHint", icon: <List className="h-4 w-4" />, keywords: "bullet ul list", group: "basic", shortcut: "⌘ ⇧ 8", run: (c) => c.toggleBulletList().run() },
  numberedList: { label: "Numbered list", labelKey: "blockNumberedList", hint: "Ordered list", hintKey: "numberedListHint", icon: <ListOrdered className="h-4 w-4" />, keywords: "number ol list", group: "basic", shortcut: "⌘ ⇧ 7", run: (c) => c.toggleOrderedList().run() },
  todoList: { label: "To-do list", labelKey: "blockTodoList", hint: "Checklist", hintKey: "todoListHint", icon: <ListTodo className="h-4 w-4" />, keywords: "todo task checkbox", group: "basic", shortcut: "⌘ ⇧ 9", run: (c) => c.toggleTaskList().run() },
  toggle: { label: "Toggle", labelKey: "blockToggle", hint: "Collapsible block", hintKey: "toggleHint", icon: <ChevronRight className="h-4 w-4" />, keywords: "toggle collapse fold", group: "basic", run: (c) => c.setToggle({}).run() },
  quote: { label: "Quote", labelKey: "blockQuote", hint: "Capture a quote", hintKey: "quoteHint", icon: <Quote className="h-4 w-4" />, keywords: "quote blockquote", group: "basic", run: (c) => c.toggleBlockquote().run() },
  callout: { label: "Callout", labelKey: "blockCallout", hint: "Emphasised box", hintKey: "calloutHint", icon: <Lightbulb className="h-4 w-4" />, keywords: "callout note info", group: "basic", run: (c) => c.setCallout({ emoji: "💡" }).run() },
  code: { label: "Code", labelKey: "code", hint: "Code block", hintKey: "codeBlockHint", icon: <SquareCode className="h-4 w-4" />, keywords: "code snippet", group: "basic", shortcut: "⌘ ⌥ C", run: (c) => c.toggleCodeBlock().run() },
};

/** Look an insertable graph type's command up by type. */
const blockItem = (type: SlashBlockType): SlashItem => BLOCK_TYPE_ITEMS[type];

/**
 * The menu, in shipped order. Block-type rows are sourced from the graph table
 * above ({@link blockItem}); the inline rows are blocks the conversion matrix
 * does not model (the h4–h6 levels and the embedded/atomic nodes), kept verbatim
 * so their commands and the catalog order the ranker sees are unchanged.
 *
 * `group` places a row in one of the four sections. The ranker still returns a
 * flat list; {@link buildSlashRows} is what buckets it.
 */
const SLASH_ITEMS: SlashItem[] = [
  blockItem("paragraph"),
  blockItem("h1"),
  blockItem("h2"),
  blockItem("h3"),
  { label: "Heading 4", labelKey: "blockHeading4", hint: "Extra small heading", hintKey: "heading4Hint", icon: <Heading4 className="h-4 w-4" />, keywords: "h4 small", group: "basic", run: (c) => c.toggleHeading({ level: 4 }).run() },
  { label: "Heading 5", labelKey: "blockHeading5", hint: "Tiny heading", hintKey: "heading5Hint", icon: <Heading5 className="h-4 w-4" />, keywords: "h5 tiny", group: "basic", run: (c) => c.toggleHeading({ level: 5 }).run() },
  { label: "Heading 6", labelKey: "blockHeading6", hint: "Smallest heading", hintKey: "heading6Hint", icon: <Heading6 className="h-4 w-4" />, keywords: "h6 smallest", group: "basic", run: (c) => c.toggleHeading({ level: 6 }).run() },
  blockItem("bulletedList"),
  blockItem("numberedList"),
  blockItem("todoList"),
  blockItem("callout"),
  blockItem("toggle"),
  // Explicit column counts. 5 is intentionally absent: `setColumns` clamps to
  // `Math.max(2, Math.min(count, 4))` (custom-blocks.tsx, read-only), so a
  // "5" row would silently insert 4 — raising the cap is a separate decision
  // (docs/specs/editor-deep.md R84.1/O84.1).
  { label: "Columns · 2", hint: "Two side-by-side columns", icon: <Columns2 className="h-4 w-4" />, keywords: "columns layout grid two side by side", group: "advanced", run: (c) => c.setColumns(2).run() },
  { label: "Columns · 3", hint: "Three side-by-side columns", icon: <Columns3 className="h-4 w-4" />, keywords: "columns layout grid three side by side", group: "advanced", run: (c) => c.setColumns(3).run() },
  { label: "Columns · 4", hint: "Four side-by-side columns", icon: <Columns4 className="h-4 w-4" />, keywords: "columns layout grid four side by side", group: "advanced", run: (c) => c.setColumns(4).run() },
  blockItem("quote"),
  blockItem("code"),
  ...MERMAID_TEMPLATES.map((template) => ({
    label: template.id === "class" || template.id === "sequence" || template.id === "state"
      ? `UML ${template.label}`
      : template.id === "flowchart"
        ? "Mermaid diagram"
        : `Mermaid ${template.label} diagram`,
    hint: template.description,
    icon: <Workflow className="h-4 w-4" />,
    keywords: `mermaid diagram uml ${template.id} ${template.label}`,
    group: "advanced" as const,
    run: (c: ReturnType<Editor["chain"]>) =>
      c
        .insertContent({
          type: "codeBlock",
          attrs: { language: "mermaid" },
          content: [{ type: "text", text: template.source }],
        })
        .run(),
  })),
  ...PLANTUML_TEMPLATES.map((template) => ({
    label: `PlantUML ${template.label}`,
    hint: "Server-free PlantUML",
    icon: <Workflow className="h-4 w-4" />,
    keywords: `plantuml puml uml ${template.id} ${template.label}`,
    group: "advanced" as const,
    run: (c: ReturnType<Editor["chain"]>) =>
      c.insertContent({
        type: "codeBlock",
        attrs: { language: "plantuml" },
        content: [{ type: "text", text: template.source }],
      }).run(),
  })),
  { label: "Visual UML canvas", hint: "Drag-and-drop class, actor and use-case diagrams", icon: <Workflow className="h-4 w-4" />, keywords: "uml visual diagram class actor usecase canvas drag drop figma", group: "advanced", run: (c) => c.insertContent({ type: "umlDiagram", attrs: { data: starterUmlDiagram() } }).run() },
  { label: "Table", labelKey: "blockTable", hint: "3×3 table", hintKey: "tableHint", icon: <TableIcon className="h-4 w-4" />, keywords: "table grid rows", group: "basic", run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { label: "Image", labelKey: "blockImage", hint: "Upload or embed", hintKey: "imageHint", icon: <ImagePlus className="h-4 w-4" />, keywords: "image picture photo upload file", group: "media", action: () => {} },
  { label: "Bookmark", labelKey: "blockBookmark", hint: "Link preview card", hintKey: "bookmarkHint", icon: <BookmarkIcon className="h-4 w-4" />, keywords: "bookmark link card url", group: "media", run: (c) => c.setBookmark().run() },
  { label: "Embed", labelKey: "blockEmbed", hint: "YouTube, Vimeo, Figma…", hintKey: "embedHint", icon: <Video className="h-4 w-4" />, keywords: "embed video iframe youtube vimeo", group: "media", run: (c) => c.setEmbed().run() },
  { label: "PDF preview", hint: "Embed an inline PDF viewer", icon: <FileText className="h-4 w-4" />, keywords: "pdf document file preview embed viewer attachment", group: "media", run: (c) => c.setPdfPreview().run() },
  { label: "Map", hint: "Embed a map for a place", icon: <MapIcon className="h-4 w-4" />, keywords: "map location place geo coordinates address directions", group: "media", run: (c) => c.setMapBlock().run() },
  { label: "Breadcrumb", labelKey: "blockBreadcrumb", hint: "Parent page trail", hintKey: "breadcrumbHint", icon: <Compass className="h-4 w-4" />, keywords: "breadcrumb path trail navigation", group: "advanced", run: (c) => c.setBreadcrumb().run() },
  { label: "Synced block", labelKey: "blockSyncedBlock", hint: "Mirror the block above", hintKey: "syncedBlockHint", icon: <Layers className="h-4 w-4" />, keywords: "synced block mirror reference transclusion duplicate", group: "advanced", run: (c) => c.insertSyncedBlock().run() },
  { label: "Synced view", labelKey: "blockSyncedView", hint: "Mirror another page", hintKey: "syncedViewHint", icon: <Layers className="h-4 w-4" />, keywords: "synced view transclusion mirror page", group: "database", run: (c) => c.setPageEmbed().run() },
  { label: "Linked database", labelKey: "blockLinkedDatabase", hint: "Embed a database", hintKey: "linkedDatabaseHint", icon: <Layers className="h-4 w-4" />, keywords: "linked database embed view", group: "database", run: (c) => c.setLinkedDatabase().run() },
  { label: "Template button", labelKey: "blockTemplateButton", hint: "Insert a template", hintKey: "templateButtonHint", icon: <Copy className="h-4 w-4" />, keywords: "template button snippet meeting tasks", group: "database", run: (c) => c.setTemplateButton({ templateId: "meeting" }).run() },
  { label: "Ask AI", labelKey: "askAI", hint: "Prompt the assistant", hintKey: "askAiHint", icon: <Sparkles className="h-4 w-4" />, keywords: "ai ask assistant generate", group: "advanced", run: (c) => c.setAskAi({}).run() },
  { label: "Equation", labelKey: "blockEquation", hint: "Block math", hintKey: "equationHint", icon: <Sigma className="h-4 w-4" />, keywords: "equation math latex katex", group: "advanced", run: () => window.dispatchEvent(new CustomEvent(EQUATION_EVENT, { detail: { kind: "block" } })) },
  { label: "Table of contents", labelKey: "blockTableOfContents", hint: "Outline of headings", hintKey: "tocHint", icon: <ListTree className="h-4 w-4" />, keywords: "toc outline contents", group: "basic", run: (c) => c.setTableOfContents().run() },
  { label: "Divider", labelKey: "blockDivider", hint: "Visual separator", hintKey: "dividerHint", icon: <Minus className="h-4 w-4" />, keywords: "divider hr separator", group: "basic", run: (c) => c.setHorizontalRule().run() },
];

/** Catalogue consumed by `@/lib/slash-commands`; ids reuse the stable English label. */
const SLASH_COMMANDS: SlashCommand[] = SLASH_ITEMS.map((item) => ({
  id: item.label,
  title: item.label,
  keywords: item.keywords.split(/\s+/).filter(Boolean),
  group: item.group,
}));

/* ---------------------------------------------------------------------------
   Pure model: grouping + fuzzy highlight
   ------------------------------------------------------------------------- */

/** One row fed to the surface: a sticky section heading, or an item by id. */
export type SlashRow =
  | { kind: "header"; group: SlashGroupId }
  | { kind: "item"; id: string; index: number };

/** Minimal shape {@link buildSlashRows} needs: an id and its section. */
export type SlashRowEntry = { id: string; group: string };

const GROUP_ORDER_SET = new Set<string>(SLASH_GROUP_ORDER);

function normalizedQuery(query: string): string {
  return query.trim().replace(/^\//, "");
}

/**
 * Bucket ranked commands into rows.
 *
 * With an empty query and a non-empty `recentIds`, the first
 * {@link SLASH_RECENT_LIMIT} remembered commands (in recency order, still
 * present in `entries`) form a `recent` section, and the remainder fall into
 * their canonical sections — no row is ever duplicated. While searching, the
 * recency section is dropped and only the match sections render.
 *
 * Item order inside a section follows `entries` (the ranker's order), and the
 * flat `index` counts every emitted item so keyboard navigation stays linear.
 */
export function buildSlashRows(
  entries: readonly SlashRowEntry[],
  {
    query = "",
    recentIds = [],
    recentLimit = SLASH_RECENT_LIMIT,
  }: { query?: string; recentIds?: readonly string[]; recentLimit?: number } = {},
): SlashRow[] {
  const rows: SlashRow[] = [];
  const seen = new Set<string>();
  let index = 0;
  const pushItem = (id: string) => {
    rows.push({ kind: "item", id, index });
    index += 1;
  };

  const searching = normalizedQuery(query).length > 0;
  if (!searching && recentLimit > 0 && recentIds.length > 0) {
    const pool = new Map(entries.map((entry) => [entry.id, entry]));
    const recent: SlashRowEntry[] = [];
    for (const id of recentIds) {
      const entry = pool.get(id);
      if (entry && !seen.has(id)) {
        recent.push(entry);
        seen.add(id);
      }
      if (recent.length >= recentLimit) break;
    }
    if (recent.length > 0) {
      rows.push({ kind: "header", group: "recent" });
      for (const entry of recent) pushItem(entry.id);
    }
  }

  const buckets = new Map<SlashGroupId, SlashRowEntry[]>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    const group: SlashGroupId = GROUP_ORDER_SET.has(entry.group)
      ? (entry.group as SlashGroupId)
      : "advanced";
    const bucket = buckets.get(group);
    if (bucket) bucket.push(entry);
    else buckets.set(group, [entry]);
  }

  for (const group of SLASH_GROUP_ORDER) {
    if (group === "recent") continue;
    const bucket = buckets.get(group);
    if (!bucket || bucket.length === 0) continue;
    rows.push({ kind: "header", group });
    for (const entry of bucket) pushItem(entry.id);
  }

  return rows;
}

/** One run of highlighted / plain text within a label. */
export type HighlightSegment = { text: string; match: boolean };

/**
 * Fuzzy highlight: walk the (case-insensitive) query as a subsequence of
 * `text`, flagging every matched character. A query that is not a subsequence
 * leaves the text unhighlighted, so a keyword-only match (which never appears
 * in the title) still renders cleanly.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const needle = normalizedQuery(query).toLowerCase();
  if (!text) return [];
  if (!needle) return [{ text, match: false }];

  const lower = text.toLowerCase();
  const flags = new Array<boolean>(text.length).fill(false);
  let cursor = 0;
  for (const char of needle) {
    const at = lower.indexOf(char, cursor);
    if (at === -1) return [{ text, match: false }];
    flags[at] = true;
    cursor = at + 1;
  }

  const segments: HighlightSegment[] = [];
  let start = 0;
  while (start < text.length) {
    const match = flags[start];
    let end = start + 1;
    while (end < text.length && flags[end] === match) end += 1;
    segments.push({ text: text.slice(start, end), match });
    start = end;
  }
  return segments;
}

/** Render a label with its fuzzy matches tinted. */
function HighlightedLabel({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightSegments(text, query).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded-xs bg-highlight px-0.5 font-semibold text-highlight-fg">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/* ---------------------------------------------------------------------------
   Presentational surface (statically renderable)
   ------------------------------------------------------------------------- */

export type SlashMenuSurfaceProps<T extends SlashMenuItem = SlashMenuItem> = {
  rows: readonly SlashRow[];
  itemById: ReadonlyMap<string, T>;
  active?: number;
  query?: string;
  locale?: string;
  style?: React.CSSProperties;
  onPick?: (item: T) => void;
  onHover?: (index: number) => void;
};

/**
 * The menu chrome: sticky section headings, fuzzy-highlighted labels,
 * right-aligned shortcut hints, an active row on `bg-surface-2`, a
 * `scrollbar-thin` list, footer key hints and a real empty state. Pure of the
 * editor, so the node tests render it at 0 and many results.
 */
export function SlashMenuSurface<T extends SlashMenuItem>({
  rows,
  itemById,
  active = 0,
  query = "",
  locale = "en",
  style,
  onPick,
  onHover,
}: SlashMenuSurfaceProps<T>) {
  const sections: { group: SlashGroupId; items: { item: T; index: number }[] }[] = [];
  for (const row of rows) {
    if (row.kind === "header") {
      sections.push({ group: row.group, items: [] });
      continue;
    }
    const item = itemById.get(row.id);
    const current = sections[sections.length - 1];
    if (item && current) current.items.push({ item, index: row.index });
  }
  const count = sections.reduce((total, section) => total + section.items.length, 0);

  return (
    <div
      data-testid="slash-menu"
      role="dialog"
      aria-label={t(locale, "insertBlock")}
      className="surface-raised animate-rise fixed flex max-h-80 w-[min(92vw,22rem)] flex-col overflow-hidden"
      style={{ zIndex: Z.popover, ...style }}
    >
      {count === 0 ? (
        <EmptyState
          variant="compact"
          icon={<SearchX aria-hidden className="h-4 w-4" />}
          title={t(locale, "noResults")}
          description={`No command matches “${query}”`}
        />
      ) : (
        <div
          role="listbox"
          aria-label={t(locale, "commands")}
          className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-1"
        >
          {sections.map((section) => (
            <div
              key={section.group}
              role="group"
              aria-label={SLASH_GROUP_LABELS[section.group]}
            >
              <p
                data-slash-group={section.group}
                style={{ zIndex: Z.sticky }}
                className="sticky top-0 bg-bg px-2 py-1 text-xs font-medium text-muted"
              >
                {SLASH_GROUP_LABELS[section.group]}
              </p>
              {section.items.map(({ item, index }) => {
                const isActive = index === active;
                return (
                  <button
                    key={item.label}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive ? "true" : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => onHover?.(index)}
                    onClick={() => onPick?.(item)}
                    className={cn(
                      "focus-ring u-colors flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left text-sm",
                      isActive
                        ? "bg-surface-2 text-fg"
                        : "text-fg hover:bg-surface-2",
                    )}
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-control border border-border bg-bg text-muted">
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        <HighlightedLabel
                          text={item.labelKey ? t(locale, item.labelKey) : item.label}
                          query={query}
                        />
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {item.hintKey ? t(locale, item.hintKey) : item.hint}
                      </span>
                    </span>
                    {item.shortcut ? (
                      <Kbd size="xs" className="shrink-0">
                        {item.shortcut}
                      </Kbd>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-x-3 border-t border-border px-2 py-1 text-xs text-muted">
        <span className="flex items-center gap-1">
          <Kbd size="xs">↑</Kbd>
          <Kbd size="xs">↓</Kbd>
          <span>{SLASH_FOOTER_HINTS.navigate}</span>
        </span>
        <span className="flex items-center gap-1">
          <Kbd size="xs">↵</Kbd>
          <span>{SLASH_FOOTER_HINTS.select}</span>
        </span>
        <span className="flex items-center gap-1">
          <Kbd size="xs">esc</Kbd>
          <span>{SLASH_FOOTER_HINTS.dismiss}</span>
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Editor adapter
   ------------------------------------------------------------------------- */

export function SlashMenu({
  editor,
  onPickImage,
  locale = "en",
}: {
  editor: Editor;
  onPickImage: () => void;
  locale?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ x: number; y: number; flipped?: boolean } | null>(null);
  // Recently picked command ids, most-recent-first: a soft tiebreak for the
  // ranker and the source of the "Recently used" section.
  const [recentIds, setRecentIds] = useState<string[]>([]);

  // Display metadata keyed by the stable English label, with the image picker
  // bound once. Kept separate from ranking so `onPickImage` identity changes
  // don't re-sort the list.
  const itemById = useMemo(
    () =>
      new Map<string, SlashItem>(
        SLASH_ITEMS.map((item): [string, SlashItem] =>
          item.label === "Image"
            ? [item.label, { ...item, action: onPickImage }]
            : [item.label, item],
        ),
      ),
    [onPickImage],
  );

  // The shared model replaces the old inline tiered match: filter (enable /
  // disable), rank (title → keyword → substring, recency tiebreak), then group
  // into sections. An empty query keeps the catalogue's original order.
  const ranked = useMemo(
    () => rankCommands(filterCommands(SLASH_COMMANDS), query, { recentIds }),
    [query, recentIds],
  );

  const rows = useMemo(
    () =>
      buildSlashRows(
        ranked.map((command) => ({ id: command.id, group: command.group })),
        { query, recentIds },
      ),
    [ranked, query, recentIds],
  );

  // Flat pick order driving keyboard navigation and the active-row clamp.
  const items = useMemo(
    () =>
      rows.flatMap((row) =>
        row.kind === "item" ? [itemById.get(row.id)].filter(Boolean) as SlashItem[] : [],
      ),
    [rows, itemById],
  );

  useEffect(() => {
    const handler = () => {
      const { $from } = editor.state.selection;
      const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
      // Notion's rule: the slash must start the block, and the query may
      // contain spaces ("/heading 4" keeps the menu open). A slash typed
      // mid-sentence is literal text, not a command.
      const match = /^\/([^\n]*)$/.exec(textBefore);
      if (match && $from.parent.type.name === "paragraph") {
        setQuery(match[1] ?? "");
        try {
          const coords = editor.view.coordsAtPos(editor.state.selection.from);
          // Clamp to the viewport and flip above the caret when there is no room
          // below, so the menu never hangs off the bottom or the right edge.
          const placed = placeFloating({
            anchor: { top: coords.top, left: coords.left, width: 2, height: coords.bottom - coords.top },
            size: { width: SLASH_MENU_WIDTH, height: SLASH_MENU_MAX_HEIGHT },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            preferred: "bottom",
            align: "start",
          });
          setPos({ x: placed.left, y: placed.top, flipped: placed.flipped });
        } catch {
          setPos(null);
        }
        setOpen(true);
        setActive(0);
      } else {
        setOpen(false);
      }
    };
    editor.on("update", handler);
    editor.on("selectionUpdate", handler);
    return () => {
      editor.off("update", handler);
      editor.off("selectionUpdate", handler);
    };
  }, [editor]);

  // Keep the active row inside the (possibly shrinking) list.
  useEffect(() => {
    setActive((previous) =>
      items.length === 0 ? 0 : Math.min(previous, items.length - 1),
    );
  }, [items.length]);

  const applySuggestion = useCallback(
    (item: SlashItem) => {
      const { from } = editor.state.selection;
      const start = from - query.length - 1;
      const chain = editor.chain().focus().deleteRange({ from: start, to: from });
      if (item.action) {
        chain.run();
        item.action();
      } else {
        item.run?.(chain);
      }
      // Remember the pick so the next search can float it (bounded, deduped).
      setRecentIds((previous) =>
        [item.label, ...previous.filter((id) => id !== item.label)].slice(0, 6),
      );
      setOpen(false);
    },
    [editor, query],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (items.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((a) => Math.min(a + 1, items.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (event.key === "Enter" || event.key === "Tab") {
        if (items[active]) {
          event.preventDefault();
          applySuggestion(items[active]);
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, items, active, applySuggestion]);

  if (!open) return null;

  return (
    <SlashMenuSurface
      rows={rows}
      itemById={itemById}
      active={active}
      query={query}
      locale={locale}
      style={{ left: pos?.x, top: pos?.y }}
      onHover={setActive}
      onPick={applySuggestion}
    />
  );
}
