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
  CornerDownLeft,
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
  Sigma,
  Sparkles,
  SquareCode,
  Table as TableIcon,
  Video
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EQUATION_EVENT } from "@/components/editor/equation-editor";
import { t } from "@/lib/i18n";
import { BLOCK_TYPES } from "@/lib/block-conversion";
import {
  filterCommands,
  groupCommands,
  rankCommands,
  type SlashCommand,
} from "@/lib/slash-commands";

/* ---------------------------------------------------------------------------
   Slash menu
   --------------------------------------------------------------------------- */

type I18nKey = Parameters<typeof t>[1];

type SlashItem = {
  /**
   * Stable English label — kept for keyword ranking and React keys. Also the
   * display fallback when {@link SlashItem.labelKey} is absent.
   */
  label: string;
  /**
   * Catalogue key for the visible label. The rich-block rows added for the
   * columns counts, the PDF preview and the map have no catalogue entry yet
   * (`src/lib/i18n.ts` is owned by the i18n slice), so they omit both keys and
   * the menu renders the raw English `label`/`hint` — the same English fallback
   * `t()` itself uses. They pick up `labelKey`/`hintKey` once the keys land.
   */
  labelKey?: I18nKey;
  /** Stable English hint — the display fallback when `hintKey` is absent. */
  hint: string;
  hintKey?: I18nKey;
  icon: React.ReactNode;
  keywords: string;
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
  paragraph: { label: "Text", labelKey: "blockText", hint: "Plain paragraph", hintKey: "paragraphHint", icon: <Pilcrow className="h-4 w-4" />, keywords: "text paragraph body", run: (c) => c.setParagraph().run() },
  h1: { label: "Heading 1", labelKey: "blockHeading1", hint: "Large heading", hintKey: "heading1Hint", icon: <Heading1 className="h-4 w-4" />, keywords: "h1 title", run: (c) => c.toggleHeading({ level: 1 }).run() },
  h2: { label: "Heading 2", labelKey: "blockHeading2", hint: "Medium heading", hintKey: "heading2Hint", icon: <Heading2 className="h-4 w-4" />, keywords: "h2 subtitle", run: (c) => c.toggleHeading({ level: 2 }).run() },
  h3: { label: "Heading 3", labelKey: "blockHeading3", hint: "Small heading", hintKey: "heading3Hint", icon: <Heading3 className="h-4 w-4" />, keywords: "h3", run: (c) => c.toggleHeading({ level: 3 }).run() },
  bulletedList: { label: "Bulleted list", labelKey: "blockBulletedList", hint: "Unordered list", hintKey: "bulletedListHint", icon: <List className="h-4 w-4" />, keywords: "bullet ul list", run: (c) => c.toggleBulletList().run() },
  numberedList: { label: "Numbered list", labelKey: "blockNumberedList", hint: "Ordered list", hintKey: "numberedListHint", icon: <ListOrdered className="h-4 w-4" />, keywords: "number ol list", run: (c) => c.toggleOrderedList().run() },
  todoList: { label: "To-do list", labelKey: "blockTodoList", hint: "Checklist", hintKey: "todoListHint", icon: <ListTodo className="h-4 w-4" />, keywords: "todo task checkbox", run: (c) => c.toggleTaskList().run() },
  toggle: { label: "Toggle", labelKey: "blockToggle", hint: "Collapsible block", hintKey: "toggleHint", icon: <ChevronRight className="h-4 w-4" />, keywords: "toggle collapse fold", run: (c) => c.setToggle({}).run() },
  quote: { label: "Quote", labelKey: "blockQuote", hint: "Capture a quote", hintKey: "quoteHint", icon: <Quote className="h-4 w-4" />, keywords: "quote blockquote", run: (c) => c.toggleBlockquote().run() },
  callout: { label: "Callout", labelKey: "blockCallout", hint: "Emphasised box", hintKey: "calloutHint", icon: <Lightbulb className="h-4 w-4" />, keywords: "callout note info", run: (c) => c.setCallout({ emoji: "💡" }).run() },
  code: { label: "Code", labelKey: "code", hint: "Code block", hintKey: "codeBlockHint", icon: <SquareCode className="h-4 w-4" />, keywords: "code snippet", run: (c) => c.toggleCodeBlock().run() },
};

/** Look an insertable graph type's command up by type. */
const blockItem = (type: SlashBlockType): SlashItem => BLOCK_TYPE_ITEMS[type];

/**
 * The menu, in shipped order. Block-type rows are sourced from the graph table
 * above ({@link blockItem}); the inline rows are blocks the conversion matrix
 * does not model (the h4–h6 levels and the embedded/atomic nodes), kept verbatim
 * so their commands and the catalog order the ranker sees are unchanged.
 */
const SLASH_ITEMS: SlashItem[] = [
  blockItem("paragraph"),
  blockItem("h1"),
  blockItem("h2"),
  blockItem("h3"),
  { label: "Heading 4", labelKey: "blockHeading4", hint: "Extra small heading", hintKey: "heading4Hint", icon: <Heading4 className="h-4 w-4" />, keywords: "h4 small", run: (c) => c.toggleHeading({ level: 4 }).run() },
  { label: "Heading 5", labelKey: "blockHeading5", hint: "Tiny heading", hintKey: "heading5Hint", icon: <Heading5 className="h-4 w-4" />, keywords: "h5 tiny", run: (c) => c.toggleHeading({ level: 5 }).run() },
  { label: "Heading 6", labelKey: "blockHeading6", hint: "Smallest heading", hintKey: "heading6Hint", icon: <Heading6 className="h-4 w-4" />, keywords: "h6 smallest", run: (c) => c.toggleHeading({ level: 6 }).run() },
  blockItem("bulletedList"),
  blockItem("numberedList"),
  blockItem("todoList"),
  blockItem("callout"),
  blockItem("toggle"),
  // Explicit column counts. 5 is intentionally absent: `setColumns` clamps to
  // `Math.max(2, Math.min(count, 4))` (custom-blocks.tsx, read-only), so a
  // "5" row would silently insert 4 — raising the cap is a separate decision
  // (docs/specs/editor-deep.md R84.1/O84.1).
  { label: "Columns · 2", hint: "Two side-by-side columns", icon: <Columns2 className="h-4 w-4" />, keywords: "columns layout grid two side by side", run: (c) => c.setColumns(2).run() },
  { label: "Columns · 3", hint: "Three side-by-side columns", icon: <Columns3 className="h-4 w-4" />, keywords: "columns layout grid three side by side", run: (c) => c.setColumns(3).run() },
  { label: "Columns · 4", hint: "Four side-by-side columns", icon: <Columns4 className="h-4 w-4" />, keywords: "columns layout grid four side by side", run: (c) => c.setColumns(4).run() },
  blockItem("quote"),
  blockItem("code"),
  { label: "Table", labelKey: "blockTable", hint: "3×3 table", hintKey: "tableHint", icon: <TableIcon className="h-4 w-4" />, keywords: "table grid rows", run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { label: "Image", labelKey: "blockImage", hint: "Upload or embed", hintKey: "imageHint", icon: <ImagePlus className="h-4 w-4" />, keywords: "image picture photo upload file", action: () => {} },
  { label: "Bookmark", labelKey: "blockBookmark", hint: "Link preview card", hintKey: "bookmarkHint", icon: <BookmarkIcon className="h-4 w-4" />, keywords: "bookmark link card url", run: (c) => c.setBookmark().run() },
  { label: "Embed", labelKey: "blockEmbed", hint: "YouTube, Vimeo, Figma…", hintKey: "embedHint", icon: <Video className="h-4 w-4" />, keywords: "embed video iframe youtube vimeo", run: (c) => c.setEmbed().run() },
  { label: "PDF preview", hint: "Embed an inline PDF viewer", icon: <FileText className="h-4 w-4" />, keywords: "pdf document file preview embed viewer attachment", run: (c) => c.setPdfPreview().run() },
  { label: "Map", hint: "Embed a map for a place", icon: <MapIcon className="h-4 w-4" />, keywords: "map location place geo coordinates address directions", run: (c) => c.setMapBlock().run() },
  { label: "Breadcrumb", labelKey: "blockBreadcrumb", hint: "Parent page trail", hintKey: "breadcrumbHint", icon: <Compass className="h-4 w-4" />, keywords: "breadcrumb path trail navigation", run: (c) => c.setBreadcrumb().run() },
  { label: "Synced view", labelKey: "blockSyncedView", hint: "Mirror another page", hintKey: "syncedViewHint", icon: <Layers className="h-4 w-4" />, keywords: "synced view transclusion mirror page", run: (c) => c.setPageEmbed().run() },
  { label: "Linked database", labelKey: "blockLinkedDatabase", hint: "Embed a database", hintKey: "linkedDatabaseHint", icon: <Layers className="h-4 w-4" />, keywords: "linked database embed view", run: (c) => c.setLinkedDatabase().run() },
  { label: "Template button", labelKey: "blockTemplateButton", hint: "Insert a template", hintKey: "templateButtonHint", icon: <Copy className="h-4 w-4" />, keywords: "template button snippet meeting tasks", run: (c) => c.setTemplateButton({ templateId: "meeting" }).run() },
  { label: "Ask AI", labelKey: "askAI", hint: "Prompt the assistant", hintKey: "askAiHint", icon: <Sparkles className="h-4 w-4" />, keywords: "ai ask assistant generate", run: (c) => c.setAskAi({}).run() },
  { label: "Equation", labelKey: "blockEquation", hint: "Block math", hintKey: "equationHint", icon: <Sigma className="h-4 w-4" />, keywords: "equation math latex katex", run: () => window.dispatchEvent(new CustomEvent(EQUATION_EVENT, { detail: { kind: "block" } })) },
  { label: "Table of contents", labelKey: "blockTableOfContents", hint: "Outline of headings", hintKey: "tocHint", icon: <ListTree className="h-4 w-4" />, keywords: "toc outline contents", run: (c) => c.setTableOfContents().run() },
  { label: "Divider", labelKey: "blockDivider", hint: "Visual separator", hintKey: "dividerHint", icon: <Minus className="h-4 w-4" />, keywords: "divider hr separator", run: (c) => c.setHorizontalRule().run() },
];

/* ---------------------------------------------------------------------------
   Ranking model
   ------------------------------------------------------------------------- */

/**
 * Catalogue consumed by `@/lib/slash-commands`. Ids reuse the stable English
 * `label` so ranking, the recency list and React keys all agree on one
 * identity. Every entry is currently a "basic block"; the `group` is carried
 * on the command so the model owns the section order, and a future category
 * only needs its heading added to `SLASH_GROUP_LABELS`.
 */
const SLASH_COMMANDS: SlashCommand[] = SLASH_ITEMS.map((item) => ({
  id: item.label,
  title: item.label,
  keywords: item.keywords.split(/\s+/).filter(Boolean),
  group: "basic",
}));

/** Localized section heading per group id; unknown ids fall back to Basic. */
const SLASH_GROUP_LABELS: Partial<Record<string, I18nKey>> = {
  basic: "slashBasicBlocks",
};

/** Flat rows fed to the list: a section heading, or an item with its index. */
type SlashRow =
  | { kind: "header"; group: string }
  | { kind: "item"; item: SlashItem; index: number };

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
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Recently picked command ids, most-recent-first: a soft tiebreak that lets
  // the shared ranker float a habitually chosen block above its peers.
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
  const groups = useMemo(
    () =>
      groupCommands(
        rankCommands(filterCommands(SLASH_COMMANDS), query, { recentIds }),
      ),
    [query, recentIds],
  );

  const rows = useMemo<SlashRow[]>(() => {
    const next: SlashRow[] = [];
    let index = 0;
    for (const group of groups) {
      next.push({ kind: "header", group: group.group });
      for (const command of group.items) {
        const item = itemById.get(command.id);
        if (item) {
          next.push({ kind: "item", item, index });
          index += 1;
        }
      }
    }
    return next;
  }, [groups, itemById]);

  // Flat pick order driving keyboard navigation and the active-row clamp.
  const items = useMemo(
    () => rows.flatMap((row) => (row.kind === "item" ? [row.item] : [])),
    [rows],
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
          setPos({ x: coords.left, y: coords.bottom + 6 });
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
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, items, active, applySuggestion]);

  if (!open || !pos || items.length === 0) return null;

  return (
    <div
      className="fixed z-50 max-h-80 w-72 overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-xl"
      style={{ left: pos.x, top: pos.y }}
    >
      {rows.map((row) =>
        row.kind === "header" ? (
          <p
            key={`group-${row.group}`}
            className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted"
          >
            {t(locale, SLASH_GROUP_LABELS[row.group] ?? "slashBasicBlocks")}
          </p>
        ) : (
          <button
            key={row.item.label}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(row.index)}
            onClick={() => applySuggestion(row.item)}
            className={cn(
              "flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm",
              row.index === active ? "bg-surface-2" : "hover:bg-surface-2",
            )}
          >
            <span className="grid h-8 w-8 place-items-center rounded border border-border bg-bg text-muted">
              {row.item.icon}
            </span>
            <span className="flex-1">
              <span className="block font-medium">
                {row.item.labelKey ? t(locale, row.item.labelKey) : row.item.label}
              </span>
              <span className="block text-xs text-muted">
                {row.item.hintKey ? t(locale, row.item.hintKey) : row.item.hint}
              </span>
            </span>
            {row.index === active && <CornerDownLeft className="h-3.5 w-3.5 text-muted" />}
          </button>
        ),
      )}
    </div>
  );
}
