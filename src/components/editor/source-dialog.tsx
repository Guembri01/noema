"use client";

import { useEffect, useState } from "react";
import { type Editor } from "@tiptap/react";
import { docToMarkdown } from "@/lib/blocks";
import { markdownToDoc } from "@/lib/serialize";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";

/**
 * Obsidian-style Markdown source mode for the page body.
 *
 * The editor stays the source of truth while the dialog is closed. Opening the
 * panel serialises the live document; Apply parses the text back through the
 * same Markdown importer the app already trusts. Unsupported rich nodes are
 * simplified by the serialiser, so the panel says so before the user applies.
 */
export function PageSourceDialog({
  editor,
  open,
  onOpenChange,
}: {
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(docToMarkdown(editor.getJSON()));
    setCopied(false);
  }, [editor, open]);

  const apply = () => {
    const doc = markdownToDoc(draft);
    editor.commands.setContent(doc as object);
    editor.commands.focus("start");
    onOpenChange(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0" aria-describedby="page-source-help">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Page source</h2>
            <p id="page-source-help" className="mt-0.5 text-xs text-muted">
              Markdown view of the page body. Apply replaces the body with the
              parsed source; complex blocks may be simplified.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void copy()}
            className="focus-ring rounded-control border border-border px-2 py-1 text-xs hover:bg-surface-2"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          aria-label="Page Markdown source"
          data-testid="page-source-input"
          className="focus-ring max-h-[65vh] min-h-[45vh] w-full resize-y overflow-auto border-0 bg-bg p-4 font-mono text-xs leading-relaxed outline-none"
        />
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={apply} data-testid="page-source-apply">
            Apply
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
