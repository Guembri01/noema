import { useEffect, useState } from "react";
import { type Editor } from "@tiptap/react";
import {
  Layers,
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
 *
 * A "redo to depth" menu would need to restore a snapshot, but the shadow
 * stack lives inside `PageEditor`'s closure: it exposes only its *depths* on
 * the wrapper, not the snapshots, and registers no editor command to restore
 * one. Until such a command exists this control therefore stays an
 * informational affordance — the depths are surfaced through `title` /
 * `aria-label` chrome and a read-only level chip, never through a dispatch.
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
      className="pointer-events-none absolute -right-1 -top-1 min-w-3.5 rounded-full bg-accent px-0.5 py-0.5 text-center text-3xs font-medium leading-none text-accent-fg"
    >
      {depth}
    </span>
  );
}

/**
 * A localised, read-only summary of the shadow trail's depth, drawn from the
 * existing `undo` / `redo` labels plus the numeric counts. This is the whole
 * informational payload of the "redo to depth" affordance: because no editor
 * command can restore a shadow snapshot, the depth is only ever *stated*, never
 * acted on.
 */
function shadowDepthSummary(locale: string, depth: ShadowDepth): string {
  const undo = `${t(locale, "undo")} +${depth.undo}`;
  if (depth.redo <= 0) return undo;
  return `${undo} · ${t(locale, "redo")} +${depth.redo}`;
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

  // The shadow trail's informational payload: a localised summary plus the
  // total number of extra levels, exposed for tooltip/`title` chrome only.
  const hasShadow = depth.undo > 0 || depth.redo > 0;
  const shadowLevels = depth.undo + depth.redo;
  const shadowSummary = shadowDepthSummary(locale, depth);

  return (
    <div
      className="fixed bottom-4 right-4 z-20 flex items-center gap-1 rounded-lg border border-border bg-bg p-1 shadow-lg"
      data-shadow-levels={hasShadow ? shadowLevels : undefined}
      title={hasShadow ? shadowSummary : undefined}
    >
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
      {hasShadow && (
        // Read-only shadow-level chip. It is deliberately not a `<button>`:
        // with no restore command there is nothing to activate, so it carries
        // the depth as `title`-only information rather than a dead control.
        <span
          aria-hidden
          data-shadow-undo={depth.undo}
          data-shadow-redo={depth.redo}
          title={shadowSummary}
          className="flex select-none items-center gap-0.5 pl-0.5 pr-1 text-3xs text-muted"
        >
          <Layers className="h-3 w-3" />
          {shadowLevels}
        </span>
      )}
    </div>
  );
}
