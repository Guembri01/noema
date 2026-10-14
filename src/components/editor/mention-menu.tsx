import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { type Editor } from "@tiptap/react";
import { cn } from "@/lib/utils";
import { mentionSearchAction } from "@/server/actions/mentions";
import { dateMention } from "@/lib/mentions";

type MentionItem = {
  id: string;
  label: string;
  type: "page" | "user" | "date";
};

export function MentionMenu({
  editor,
  workspaceId,
}: {
  editor: Editor;
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [results, setResults] = useState<MentionItem[]>([]);
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

  const items = useMemo<MentionItem[]>(() => {
    const q = query.toLowerCase();
    const today = new Date();
    const dates: MentionItem[] = [
      dateMention(today, { style: "weekday" }),
      dateMention(new Date(today.getTime() + 86_400_000), { style: "weekday" }),
      dateMention(new Date(today.getTime() + 7 * 86_400_000), { style: "weekday" }),
    ]
      .filter((d) => !q || d.label.toLowerCase().includes(q) || d.id.includes(q))
      .map((d) => ({ id: d.id, label: d.label, type: "date" as const }));
    return [...results, ...dates].slice(0, 12);
  }, [results, query]);

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

  return (
    <div
      className="fixed z-50 max-h-72 w-72 overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-xl"
      style={{ left: pos.x, top: pos.y }}
    >
      <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted">
        Mention
      </p>
      {items.map((item, index) => (
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
          <span className="w-4 text-center">
            {item.type === "user" ? "👤" : item.type === "date" ? "🗓" : "📄"}
          </span>
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
