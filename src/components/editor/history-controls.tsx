import { useEffect, useState } from "react";
import { type Editor } from "@tiptap/react";
import {
  Redo2,
  Undo2
} from "lucide-react";
import { t } from "@/lib/i18n";

/* ---------------------------------------------------------------------------
   Undo / redo
   --------------------------------------------------------------------------- */

export function HistoryControls({ editor, locale = "en" }: { editor: Editor; locale?: string }) {
  const [, force] = useState(0);

  useEffect(() => {
    const update = () => force((n) => n + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  return (
    <div className="fixed bottom-4 right-4 z-20 flex items-center gap-1 rounded-lg border border-border bg-bg p-1 shadow-lg">
      <button
        type="button"
        aria-label={t(locale, "undo")}
        title={t(locale, "undo")}
        disabled={!editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
        className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-40"
      >
        <Undo2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label={t(locale, "redo")}
        title={t(locale, "redo")}
        disabled={!editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
        className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-40"
      >
        <Redo2 className="h-4 w-4" />
      </button>
    </div>
  );
}
