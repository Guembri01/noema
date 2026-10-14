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
  Compass,
  Copy,
  CornerDownLeft,
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

/* ---------------------------------------------------------------------------
   Slash menu
   --------------------------------------------------------------------------- */

type I18nKey = Parameters<typeof t>[1];

type SlashItem = {
  /** Stable English label — kept for keyword ranking and React keys. */
  label: string;
  labelKey: I18nKey;
  hint: string;
  hintKey: I18nKey;
  icon: React.ReactNode;
  keywords: string;
  run?: (chain: ReturnType<Editor["chain"]>) => void;
  action?: () => void;
};

const SLASH_ITEMS: SlashItem[] = [
  { label: "Text", labelKey: "blockText", hint: "Plain paragraph", hintKey: "paragraphHint", icon: <Pilcrow className="h-4 w-4" />, keywords: "text paragraph body", run: (c) => c.setParagraph().run() },
  { label: "Heading 1", labelKey: "blockHeading1", hint: "Large heading", hintKey: "heading1Hint", icon: <Heading1 className="h-4 w-4" />, keywords: "h1 title", run: (c) => c.toggleHeading({ level: 1 }).run() },
  { label: "Heading 2", labelKey: "blockHeading2", hint: "Medium heading", hintKey: "heading2Hint", icon: <Heading2 className="h-4 w-4" />, keywords: "h2 subtitle", run: (c) => c.toggleHeading({ level: 2 }).run() },
  { label: "Heading 3", labelKey: "blockHeading3", hint: "Small heading", hintKey: "heading3Hint", icon: <Heading3 className="h-4 w-4" />, keywords: "h3", run: (c) => c.toggleHeading({ level: 3 }).run() },
  { label: "Heading 4", labelKey: "blockHeading4", hint: "Extra small heading", hintKey: "heading4Hint", icon: <Heading4 className="h-4 w-4" />, keywords: "h4 small", run: (c) => c.toggleHeading({ level: 4 }).run() },
  { label: "Heading 5", labelKey: "blockHeading5", hint: "Tiny heading", hintKey: "heading5Hint", icon: <Heading5 className="h-4 w-4" />, keywords: "h5 tiny", run: (c) => c.toggleHeading({ level: 5 }).run() },
  { label: "Heading 6", labelKey: "blockHeading6", hint: "Smallest heading", hintKey: "heading6Hint", icon: <Heading6 className="h-4 w-4" />, keywords: "h6 smallest", run: (c) => c.toggleHeading({ level: 6 }).run() },
  { label: "Bulleted list", labelKey: "blockBulletedList", hint: "Unordered list", hintKey: "bulletedListHint", icon: <List className="h-4 w-4" />, keywords: "bullet ul list", run: (c) => c.toggleBulletList().run() },
  { label: "Numbered list", labelKey: "blockNumberedList", hint: "Ordered list", hintKey: "numberedListHint", icon: <ListOrdered className="h-4 w-4" />, keywords: "number ol list", run: (c) => c.toggleOrderedList().run() },
  { label: "To-do list", labelKey: "blockTodoList", hint: "Checklist", hintKey: "todoListHint", icon: <ListTodo className="h-4 w-4" />, keywords: "todo task checkbox", run: (c) => c.toggleTaskList().run() },
  { label: "Callout", labelKey: "blockCallout", hint: "Emphasised box", hintKey: "calloutHint", icon: <Lightbulb className="h-4 w-4" />, keywords: "callout note info", run: (c) => c.setCallout({ emoji: "💡" }).run() },
  { label: "Toggle", labelKey: "blockToggle", hint: "Collapsible block", hintKey: "toggleHint", icon: <ChevronRight className="h-4 w-4" />, keywords: "toggle collapse fold", run: (c) => c.setToggle({}).run() },
  { label: "Columns", labelKey: "blockColumns", hint: "Side-by-side layout", hintKey: "columnsHint", icon: <Columns2 className="h-4 w-4" />, keywords: "columns layout grid", run: (c) => c.setColumns(2).run() },
  { label: "Quote", labelKey: "blockQuote", hint: "Capture a quote", hintKey: "quoteHint", icon: <Quote className="h-4 w-4" />, keywords: "quote blockquote", run: (c) => c.toggleBlockquote().run() },
  { label: "Code", labelKey: "code", hint: "Code block", hintKey: "codeBlockHint", icon: <SquareCode className="h-4 w-4" />, keywords: "code snippet", run: (c) => c.toggleCodeBlock().run() },
  { label: "Table", labelKey: "blockTable", hint: "3×3 table", hintKey: "tableHint", icon: <TableIcon className="h-4 w-4" />, keywords: "table grid rows", run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { label: "Image", labelKey: "blockImage", hint: "Upload or embed", hintKey: "imageHint", icon: <ImagePlus className="h-4 w-4" />, keywords: "image picture photo upload file", action: () => {} },
  { label: "Bookmark", labelKey: "blockBookmark", hint: "Link preview card", hintKey: "bookmarkHint", icon: <BookmarkIcon className="h-4 w-4" />, keywords: "bookmark link card url", run: (c) => c.setBookmark().run() },
  { label: "Embed", labelKey: "blockEmbed", hint: "YouTube, Vimeo, Figma…", hintKey: "embedHint", icon: <Video className="h-4 w-4" />, keywords: "embed video iframe youtube vimeo", run: (c) => c.setEmbed().run() },
  { label: "Breadcrumb", labelKey: "blockBreadcrumb", hint: "Parent page trail", hintKey: "breadcrumbHint", icon: <Compass className="h-4 w-4" />, keywords: "breadcrumb path trail navigation", run: (c) => c.setBreadcrumb().run() },
  { label: "Synced view", labelKey: "blockSyncedView", hint: "Mirror another page", hintKey: "syncedViewHint", icon: <Layers className="h-4 w-4" />, keywords: "synced view transclusion mirror page", run: (c) => c.setPageEmbed().run() },
  { label: "Linked database", labelKey: "blockLinkedDatabase", hint: "Embed a database", hintKey: "linkedDatabaseHint", icon: <Layers className="h-4 w-4" />, keywords: "linked database embed view", run: (c) => c.setLinkedDatabase().run() },
  { label: "Template button", labelKey: "blockTemplateButton", hint: "Insert a template", hintKey: "templateButtonHint", icon: <Copy className="h-4 w-4" />, keywords: "template button snippet meeting tasks", run: (c) => c.setTemplateButton({ templateId: "meeting" }).run() },
  { label: "Ask AI", labelKey: "askAI", hint: "Prompt the assistant", hintKey: "askAiHint", icon: <Sparkles className="h-4 w-4" />, keywords: "ai ask assistant generate", run: (c) => c.setAskAi({}).run() },
  { label: "Equation", labelKey: "blockEquation", hint: "Block math", hintKey: "equationHint", icon: <Sigma className="h-4 w-4" />, keywords: "equation math latex katex", run: () => window.dispatchEvent(new CustomEvent(EQUATION_EVENT, { detail: { kind: "block" } })) },
  { label: "Table of contents", labelKey: "blockTableOfContents", hint: "Outline of headings", hintKey: "tocHint", icon: <ListTree className="h-4 w-4" />, keywords: "toc outline contents", run: (c) => c.setTableOfContents().run() },
  { label: "Divider", labelKey: "blockDivider", hint: "Visual separator", hintKey: "dividerHint", icon: <Minus className="h-4 w-4" />, keywords: "divider hr separator", run: (c) => c.setHorizontalRule().run() },
];

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

  const items = useMemo(() => {
    const q = query.toLowerCase().trim();
    const all = SLASH_ITEMS.map((item) =>
      item.label === "Image" ? { ...item, action: onPickImage } : item,
    );
    if (!q) return all;
    // Tiered ranking, Notion-style: exact label first, then label prefix,
    // then a keyword that starts the query, then any substring match.
    const rank = (label: string, keywords: string): number | null => {
      const l = label.toLowerCase();
      const k = keywords.toLowerCase();
      if (l === q) return 0;
      if (l.startsWith(q)) return 1;
      if (k.split(/\s+/).some((word) => word.startsWith(q))) return 2;
      if (l.includes(q) || k.includes(q)) return 3;
      return null;
    };
    return all
      .map((item) => ({ item, score: rank(item.label, item.keywords) }))
      .filter(
        (entry): entry is { item: (typeof all)[number]; score: number } =>
          entry.score !== null,
      )
      .sort((a, b) => a.score - b.score)
      .map((entry) => entry.item);
  }, [query, onPickImage]);

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
      <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted">
        {t(locale, "slashBasicBlocks")}
      </p>
      {items.map((item, index) => (
        <button
          key={item.label}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(index)}
          onClick={() => applySuggestion(item)}
          className={cn(
            "flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm",
            index === active ? "bg-surface-2" : "hover:bg-surface-2",
          )}
        >
          <span className="grid h-8 w-8 place-items-center rounded border border-border bg-bg text-muted">
            {item.icon}
          </span>
          <span className="flex-1">
            <span className="block font-medium">{t(locale, item.labelKey)}</span>
            <span className="block text-xs text-muted">{t(locale, item.hintKey)}</span>
          </span>
          {index === active && <CornerDownLeft className="h-3.5 w-3.5 text-muted" />}
        </button>
      ))}
    </div>
  );
}
