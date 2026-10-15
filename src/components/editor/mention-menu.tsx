import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { type Editor } from "@tiptap/react";
import { cn } from "@/lib/utils";
import { mentionSearchAction, type MentionSuggestion } from "@/server/actions/mentions";
import { dateMention } from "@/lib/mentions";
import {
  filterCandidates,
  highlightRanges,
  rankCandidates,
  splitByKind,
  type Candidate,
} from "@/lib/mention-candidates";
import { t } from "@/lib/i18n";

type MentionItem = {
  id: string;
  label: string;
  type: "page" | "user" | "date";
};

/** Rows the picker keeps before appending the fixed date suggestions. */
const MENTION_LIMIT = 12;

/** Glyph shown ahead of a row, keyed by the mention kind. */
function glyphFor(type: MentionItem["type"]): string {
  if (type === "user") return "👤";
  if (type === "date") return "🗓";
  return "📄";
}

/**
 * Split a label into plain/matched runs using the pure `highlightRanges`
 * helper, so the row renderer can paint the query matches without slicing
 * the original title itself.
 */
function labelSegments(text: string, query: string): Array<{ text: string; match: boolean }> {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return [{ text, match: false }];
  const segments: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), match: false });
    segments.push({ text: text.slice(range.start, range.end), match: true });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

/** A mention row label with the matching query runs underlined in the accent colour. */
function MentionLabel({ text, query }: { text: string; query: string }) {
  return (
    <span className="truncate">
      {labelSegments(text, query).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="bg-transparent font-medium text-accent">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

/** Small pages/members section header inside the popover. */
function SectionHeading({ label }: { label: string }) {
  return (
    <p className="px-2 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
      {label}
    </p>
  );
}

/**
 * Ids the picker must not offer: every target the document already links to (a
 * `mention` atom's `id`) plus the page itself when the host supplies its id.
 * Reads the live document, so the caller passes the current editor. Purely a
 * read — the document and the candidate rows are never mutated.
 */
function excludedIds(editor: Editor, pageId?: string): Set<string> {
  const ids = new Set<string>();
  if (pageId) ids.add(pageId);
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "mention") return true;
    const id: unknown = node.attrs.id;
    if (typeof id === "string" && id.length > 0) ids.add(id);
    return true;
  });
  return ids;
}

export function MentionMenu({
  editor,
  workspaceId,
  pageId,
  locale = "en",
}: {
  editor: Editor;
  workspaceId: string;
  /** Current page id, when the host exposes it, so the page never mentions itself. */
  pageId?: string;
  locale?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [results, setResults] = useState<MentionSuggestion[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const handler = () => {
      const { $from } = editor.state.selection;
      const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
      const match = /(?:^|\s)@([^\s@]*)$/.exec(textBefore);
      if (match) {
        setQuery(match[1] ?? "");
        try {
          const coords = editor.view.coordsAtPos(editor.state.selection.from);
          setPos({ x: coords.left, y: coords.bottom + 6 });
        } catch {
          setPos(null);
        }
        setOpen(true);
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

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(async () => {
      const found = await mentionSearchAction(workspaceId, query);
      setResults(found);
      setActive(0);
    }, 150);
    return () => clearTimeout(timer);
  }, [open, query, workspaceId]);

  // The server rows are plain `{ id, label, type }`; project them onto the
  // picker row shape so the pure helpers can shape them.
  const candidates = useMemo<Candidate[]>(
    () => results.map((row) => ({ id: row.id, title: row.label, kind: row.type })),
    [results],
  );

  // Rank first (best match floats up, recency/input order break ties), then
  // filter (drop non-matches, targets already linked in the doc, the page
  // itself, then cap) and split into the pages/people sections. The exclusion
  // only narrows what the menu offers — insertion is unaffected.
  const sections = useMemo(() => {
    const ranked = rankCandidates(candidates, query);
    const visible = filterCandidates(ranked, query, {
      excludeIds: excludedIds(editor, pageId),
      limit: MENTION_LIMIT,
    });
    const grouped = splitByKind(visible);
    return {
      pages: grouped.pages.map((row): MentionItem => ({ id: row.id, label: row.title, type: "page" })),
      users: grouped.users.map((row): MentionItem => ({ id: row.id, label: row.title, type: "user" })),
    };
  }, [candidates, query, editor, pageId]);

  const dates = useMemo<MentionItem[]>(() => {
    const q = query.trim().toLowerCase();
    const today = new Date();
    return [
      dateMention(today, { style: "weekday" }),
      dateMention(new Date(today.getTime() + 86_400_000), { style: "weekday" }),
      dateMention(new Date(today.getTime() + 7 * 86_400_000), { style: "weekday" }),
    ]
      .filter((d) => !q || d.label.toLowerCase().includes(q) || d.id.includes(q))
      .map((d) => ({ id: d.id, label: d.label, type: "date" as const }));
  }, [query]);

  // Flattened in render order (pages → people → dates) so arrow keys walk the
  // same sequence the eye reads.
  const items = useMemo<MentionItem[]>(
    () => [...sections.pages, ...sections.users, ...dates],
    [sections, dates],
  );

  useEffect(() => {
    setActive((current) => (current < items.length ? current : 0));
  }, [items.length]);

  const insert = useCallback(
    (item: MentionItem) => {
      const { from } = editor.state.selection;
      const start = from - query.length - 1;
      editor
        .chain()
        .focus()
        .deleteRange({ from: start, to: from })
        .insertContent([
          { type: "mention", attrs: { id: item.id, label: item.label, type: item.type } },
          { type: "text", text: " " },
        ])
        .run();
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
          insert(items[active]);
        }
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, items, active, insert]);

  if (!open || !pos || items.length === 0) return null;

  const renderItem = (item: MentionItem, index: number) => (
    <button
      key={`${item.type}-${item.id}`}
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setActive(index)}
      onClick={() => insert(item)}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
        index === active ? "bg-surface-2" : "hover:bg-surface-2",
      )}
    >
      <span className="w-4 text-center">{glyphFor(item.type)}</span>
      <MentionLabel text={item.label} query={query} />
    </button>
  );

  const userOffset = sections.pages.length;

  return (
    <div
      className="fixed z-50 max-h-72 w-72 overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-xl"
      style={{ left: pos.x, top: pos.y }}
    >
      <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted">
        {t(locale, "mentionHeading")}
      </p>
      {sections.pages.length > 0 && <SectionHeading label={t(locale, "pages")} />}
      {sections.pages.map((item, index) => renderItem(item, index))}
      {sections.users.length > 0 && <SectionHeading label={t(locale, "members")} />}
      {sections.users.map((item, index) => renderItem(item, userOffset + index))}
      {dates.map((item, index) => renderItem(item, userOffset + sections.users.length + index))}
    </div>
  );
}
