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

/*
 * `PageEditor` keeps a bounded shadow snapshot stack beside TipTap's own
 * history and mirrors its depth onto the editor wrapper as
 * `data-undo-depth` / `data-redo-depth`. Those numbers follow the
 * `src/lib/undo-stack.ts` semantics — undoable is `entries.length - 1` and
 * redoable is `future.length` — so a `0` means the shadow trail is empty.
 *
 * TipTap stays authoritative for the buttons below: this control only *reads*
 * the wrapper attributes to surface the extra shadow levels, and never
 * dispatches to the shadow stack, so the built-in undo/redo is untouched.
 */

/** Editor-wrapper attribute carrying the shadow stack's undoable depth. */
const UNDO_DEPTH_ATTRIBUTE = "data-undo-depth";
/** Editor-wrapper attribute carrying the shadow stack's redoable depth. */
const REDO_DEPTH_ATTRIBUTE = "data-redo-depth";

/** Shadow-history depths mirrored from the editor wrapper. */
type ShadowDepth = {
  /** Extra undoable levels recorded in the shadow stack. */
  undo: number;
  /** Extra redoable levels recorded in the shadow stack. */
  redo: number;
};

/** No recorded shadow history. */
const NO_DEPTH: ShadowDepth = { undo: 0, redo: 0 };

/** A depth attribute as a non-negative integer; malformed values read as 0. */
function readDepth(value: string | null): number {
  const depth = Number(value);
  return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/** Read the shadow depths from the wrapper enclosing `node`, when present. */
function readShadowDepth(node: Element | null): ShadowDepth {
  const wrapper = node?.closest(`[${UNDO_DEPTH_ATTRIBUTE}]`);
  if (!wrapper) return NO_DEPTH;
  return {
    undo: readDepth(wrapper.getAttribute(UNDO_DEPTH_ATTRIBUTE)),
    redo: readDepth(wrapper.getAttribute(REDO_DEPTH_ATTRIBUTE)),
  };
}

/** A small, decorative count pinned to a history button when non-zero. */
function DepthBadge({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <span
      aria-hidden
      data-depth={depth}
      className="pointer-events-none absolute -right-1 -top-1 min-w-3.5 rounded-full bg-accent px-0.5 py-0.5 text-center text-[9px] font-medium leading-none text-accent-fg"
    >
      {depth}
    </span>
  );
}

export function HistoryControls({ editor, locale = "en" }: { editor: Editor; locale?: string }) {
  const [, force] = useState(0);
  const [depth, setDepth] = useState<ShadowDepth>(NO_DEPTH);

  useEffect(() => {
    const update = () => force((n) => n + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  // Track the shadow depth mirrored onto the editor wrapper. A MutationObserver
  // picks up `PageEditor`'s attribute updates, which may be committed after the
  // transaction that produced them.
  useEffect(() => {
    const wrapper = editor.view.dom.closest(`[${UNDO_DEPTH_ATTRIBUTE}]`);
    if (!wrapper) return;
    const sync = () => {
      const next = readShadowDepth(wrapper);
      setDepth((prev) =>
        prev.undo === next.undo && prev.redo === next.redo ? prev : next,
      );
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(wrapper, {
      attributes: true,
      attributeFilter: [UNDO_DEPTH_ATTRIBUTE, REDO_DEPTH_ATTRIBUTE],
    });
    return () => observer.disconnect();
  }, [editor]);

  /** Action label with the shadow's extra depth appended, when any. */
  const label = (action: string, extra: number) =>
    extra > 0 ? `${action} · +${extra}` : action;

  return (
    <div className="fixed bottom-4 right-4 z-20 flex items-center gap-1 rounded-lg border border-border bg-bg p-1 shadow-lg">
      <button
        type="button"
        aria-label={label(t(locale, "undo"), depth.undo)}
        title={label(t(locale, "undo"), depth.undo)}
        disabled={!editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
        className="relative flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-40"
      >
        <Undo2 className="h-4 w-4" />
        <DepthBadge depth={depth.undo} />
      </button>
      <button
        type="button"
        aria-label={label(t(locale, "redo"), depth.redo)}
        title={label(t(locale, "redo"), depth.redo)}
        disabled={!editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
        className="relative flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-40"
      >
        <Redo2 className="h-4 w-4" />
        <DepthBadge depth={depth.redo} />
      </button>
    </div>
  );
}
