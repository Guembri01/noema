"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import DragHandle from "@tiptap/extension-drag-handle-react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  ImageBlock,
  mediaKindOf,
  type MediaKind,
} from "@/components/editor/extensions/image-block";
import { BlockColors } from "@/components/editor/extensions/block-colors";
import { CodeBlock } from "@/components/editor/extensions/code-block";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { TableKit } from "@tiptap/extension-table/kit";
import { Mathematics } from "@tiptap/extension-mathematics";
import "katex/dist/katex.min.css";
import { toast } from "sonner";
import { BlockContextMenu } from "@/components/editor/block-context-menu";
import { EquationEditor, EQUATION_EVENT } from "@/components/editor/equation-editor";
import { MathAutoDetect } from "@/components/editor/extensions/math-input";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import { normalizePasteHtml, pastePlan } from "@/lib/paste";
import { analyzeBlockDrop, dropZone } from "@/lib/drag-indent";
import { createStack, push as pushSnapshot, type UndoStack } from "@/lib/undo-stack";
import {
  assignColor,
  cursorLabel,
  upsertParticipant,
  visibleParticipants,
  type Participant,
} from "@/lib/presence";
import {
  coalesce,
  enqueue,
  markDone,
  markFailed,
  nextBatch,
  type QueuedMutation,
} from "@/lib/offline-queue";
import { initials } from "@/lib/utils";
import { OPTION_COLORS } from "@/components/database/database-types";

/** Clicking an equation anywhere in the document reopens the LaTeX editor. */
const editEquation = (node: { type: { name: string }; attrs: { latex?: string } }, pos: number) => {
  window.dispatchEvent(
    new CustomEvent(EQUATION_EVENT, {
      detail: {
        kind: node.type.name === "blockMath" ? "block" : "inline",
        latex: node.attrs.latex ?? "",
        pos,
      },
    }),
  );
};
import { actionError, safeAction } from "@/lib/actions-client";
import { updatePageAction } from "@/server/actions/pages";
import { uploadFile } from "@/lib/upload-client";
import {
  Callout,
  Column,
  Columns,
  TableOfContents,
  Toggle
} from "@/components/editor/extensions/custom-blocks";
import { Mention } from "@/components/editor/extensions/mention";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { Bookmark, Embed, MapBlock, PdfPreview } from "@/components/editor/extensions/bookmark";
import { Breadcrumb, type BreadcrumbCrumb } from "@/components/editor/extensions/breadcrumb";
import { PageEmbed } from "@/components/editor/extensions/page-embed";
import { TemplateButton } from "@/components/editor/extensions/template-button";
import { AskAi } from "@/components/editor/extensions/ask-ai";
import { LinkedDatabase } from "@/components/editor/extensions/linked-database";
// B18: markdown shortcut long tail + emoji shortcodes (one-line registration).
import { InputRules } from "@/components/editor/extensions/input-rules";
import { BubbleToolbar } from "@/components/editor/bubble-toolbar";
import { SlashMenu } from "@/components/editor/slash-menu";
import { HistoryControls } from "@/components/editor/history-controls";
import { MentionMenu } from "@/components/editor/mention-menu";
import { t } from "@/lib/i18n";
// Suggestions (track-changes) chrome: the extension owns the review session,
// this file only reads its selectors and dispatches its commands.
import {
  isSuggesting,
  pendingSuggestions,
} from "@/components/editor/extensions/suggestions";
import type { Suggestion } from "@/lib/suggestions";

type SaveState = "idle" | "saving" | "saved" | "error";

/** How many document snapshots the shadow history retains (F8). */
const SNAPSHOT_HISTORY_LIMIT = 50;
/** Rapid edits inside this window merge into one snapshot step. */
const SNAPSHOT_COALESCE_MS = 500;

/**
 * The collaboration awareness protocol drops a silent peer after its 30s
 * timeout; hold a little longer before the avatar stack drops someone, so a
 * slow heartbeat never blinks a collaborator out of the room.
 */
const PRESENCE_TTL_MS = 45_000;

/** Buffered offline writes are dropped after this many failed replays. */
const OFFLINE_MAX_ATTEMPTS = 5;

/** The three transport states surfaced by the y-websocket provider. */
type CollabStatus = "connecting" | "connected" | "disconnected";

/** True when the browser reports no network — writes must be buffered. */
function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Pick the media variant an uploaded asset should render as in the image
 * block. The asset's own MIME type wins (uploads always report one); an
 * untyped asset falls back to the URL-extension inference of `mediaKindOf`,
 * and anything still unrecognised becomes a downloadable file block rather
 * than a broken picture. Images never reach here (the caller keeps the plain
 * `setImage` path).
 */
function uploadedMediaKind(asset: { url: string; mimeType: string }): MediaKind {
  if (asset.mimeType.startsWith("video/")) return "video";
  if (asset.mimeType.startsWith("audio/")) return "audio";
  const inferred = mediaKindOf(asset.url);
  return inferred === "image" ? "file" : inferred;
}

/** Resolve a presence palette name (`assignColor`) to its avatar CSS colour. */
function presenceColor(name: string | undefined): string {
  if (typeof name === "string") {
    const hex = OPTION_COLORS[name];
    if (hex) return hex;
  }
  return OPTION_COLORS.gray;
}

/** Human label for one pending suggestion (kind + the affected text). */
function suggestionLabel(suggestion: Suggestion, locale: string): string {
  const before = suggestion.before?.text?.trim();
  const after = suggestion.after?.text?.trim();
  if (suggestion.kind === "insert") {
    return `${t(locale, "suggestionInserted")}: ${after ?? "…"}`;
  }
  if (suggestion.kind === "delete") {
    return `${t(locale, "deletedPrefix")}: ${before ?? "…"}`;
  }
  return `${t(locale, "suggestionReplaced")}: ${before ?? "…"} → ${after ?? "…"}`;
}

/**
 * Compact review chrome for Suggestions (track-changes) mode: a "Suggesting"
 * on/off toggle, a live pending count and per-item / bulk accept-reject.
 *
 * The `SmartSuggestions` plugin (registered through `InputRules.addExtensions`)
 * owns the base snapshot and the diff; this component is a pure view over it.
 * It re-renders on the editor's `transaction` event — the same hook
 * `HistoryControls` uses — so the count tracks the document even on changes
 * that do not originate from this control.
 */
function SuggestionsControls({ editor, locale }: { editor: Editor; locale: string }) {
  const [, force] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const update = () => force((n) => n + 1);
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  const active = isSuggesting(editor.state);
  const pending = pendingSuggestions(editor.state);

  return (
    <div className="fixed bottom-4 left-4 z-20 flex flex-col items-start gap-1 text-xs">
      {open && pending.length > 0 && (
        <ul
          aria-label={t(locale, "suggestionsWord")}
          className="max-h-64 w-72 overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-lg"
        >
          {pending.map((suggestion) => (
            <li
              key={suggestion.id}
              className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-2"
            >
              <span
                className="min-w-0 flex-1 truncate text-fg"
                title={suggestionLabel(suggestion, locale)}
              >
                {suggestionLabel(suggestion, locale)}
              </span>
              <button
                type="button"
                aria-label={t(locale, "acceptSuggestion")}
                title={t(locale, "acceptSuggestion")}
                onClick={() => editor.chain().focus().acceptSuggestion(suggestion.id).run()}
                className="rounded px-1 text-emerald-600 hover:bg-surface"
              >
                ✓
              </button>
              <button
                type="button"
                aria-label={t(locale, "rejectSuggestion")}
                title={t(locale, "rejectSuggestion")}
                onClick={() => editor.chain().focus().rejectSuggestion(suggestion.id).run()}
                className="rounded px-1 text-red-500 hover:bg-surface"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-1 rounded-lg border border-border bg-bg p-1 shadow-lg">
        <button
          type="button"
          aria-pressed={active}
          aria-label={t(locale, "suggestingWord")}
          title={t(locale, "suggestingWord")}
          onClick={() => {
            editor.chain().focus().setSuggesting(!active).run();
            if (active) setOpen(false);
          }}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-2 ${
            active ? "text-emerald-600" : "text-muted"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-muted"}`} />
          {t(locale, "suggestingWord")}
        </button>

        {pending.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={open}
              aria-label={t(locale, "reviewSuggestions")}
              title={t(locale, "reviewSuggestions")}
              onClick={() => setOpen((value) => !value)}
              className="rounded bg-surface px-1.5 py-0.5 text-fg hover:bg-surface-2"
            >
              {pending.length} {t(locale, "pendingWord")}
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().acceptAll().run()}
              className="rounded px-1.5 py-0.5 text-emerald-600 hover:bg-surface-2"
            >
              {t(locale, "acceptAllSuggestions")}
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().rejectAll().run()}
              className="rounded px-1.5 py-0.5 text-red-500 hover:bg-surface-2"
            >
              {t(locale, "rejectAllSuggestions")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function PageEditor({
  locale = "en",
  editorPlaceholder,
  pageId,
  workspaceId,
  workspaceSlug,
  breadcrumbTrail = [],
  /** Localised empty-paragraph hint. */
  initialContent,
  editable = true,
}: {
  pageId: string;
  workspaceId: string;
  workspaceSlug: string;
  breadcrumbTrail?: BreadcrumbCrumb[];
  initialContent: unknown;
  editorPlaceholder?: string;
  locale?: string;
  editable?: boolean;
}) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [bubblePanelOpen, setBubblePanelOpen] = useState(false);
  const [snapshotDepth, setSnapshotDepth] = useState({ undoable: 0, redoable: 0 });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  /**
   * Shadow document-snapshot history (F8). TipTap owns the live undo/redo —
   * its `undoRedo` plugin, or the collaboration extension in a shared session —
   * so this bounded `UndoStack` never dispatches editor commands (that would
   * fork history against the editor). It records a JSON snapshot of the
   * document on every change and exposes its depth on the wrapper, giving the
   * history chrome a bounded, collision-free seam to grow extra levels from.
   */
  const snapshotsRef = useRef<UndoStack<string>>(
    createStack<string>({ limit: SNAPSHOT_HISTORY_LIMIT }),
  );
  /** Editor instance whose initial state was already seeded into the stack. */
  const seededEditorRef = useRef<Editor | null>(null);
  /** Pointer X where the drag handle drag started, for indent-by-offset. */
  const dragStartXRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastSavedRef = useRef<string>("");
  /** Latest document payload not yet acknowledged by the server. */
  const pendingPayloadRef = useRef<string | null>(null);
  /** Local buffer of writes made while offline; replayed once back online. */
  const offlineRef = useRef<QueuedMutation[]>([]);
  /** Monotonic counter so each buffered write gets a unique queue id. */
  const offlineSeqRef = useRef(0);

  const collabUrl = process.env.NEXT_PUBLIC_COLLAB_URL ?? "";
  const collab = useMemo(() => {
    if (!collabUrl) return null;
    const ydoc = new Y.Doc();
    // `connect: false` keeps the socket closed while the component renders
    // (and under React StrictMode's double-invoke, which would otherwise leak a
    // second connection). The mount effect below opens it; the unmount effect
    // tears it down.
    const provider = new WebsocketProvider(collabUrl, pageId, ydoc, { connect: false });
    provider.awareness.setLocalStateField("user", {
      name: "You",
      color: "#2383e2",
    });
    return { ydoc, provider };
  }, [collabUrl, pageId]);

  /**
   * Admit a document snapshot to the local offline buffer. Every entry is a
   * full snapshot, so `coalesce` collapses a burst of offline keystrokes into
   * one write that is replayed when connectivity returns.
   */
  const bufferSave = useCallback(
    (payload: string) => {
      offlineSeqRef.current += 1;
      offlineRef.current = coalesce(
        enqueue(offlineRef.current, {
          id: `${pageId}:${offlineSeqRef.current}`,
          kind: "update",
          targetId: pageId,
          payload: { content: payload },
          createdAt: Date.now(),
        }),
      );
    },
    [pageId],
  );

  /**
   * Replay the buffered offline writes. Only the newest snapshot needs to reach
   * the server (the queue coalesces to it); on failure the write is kept for a
   * later retry and dropped once it has failed too many times.
   */
  const flushOffline = useCallback(async () => {
    const batch = nextBatch(offlineRef.current, { max: Number.POSITIVE_INFINITY });
    if (batch.length === 0) return;
    const latest = batch[batch.length - 1];
    const content = latest.payload.content;
    if (typeof content !== "string") {
      offlineRef.current = markDone(
        offlineRef.current,
        batch.map((mutation) => mutation.id),
      );
      return;
    }
    const outcome = await safeAction(() => updatePageAction(pageId, { content }));
    const failure = outcome.ok ? actionError(outcome.value) : outcome.error;
    if (!outcome.ok || failure) {
      offlineRef.current = markFailed(offlineRef.current, latest.id, {
        maxAttempts: OFFLINE_MAX_ATTEMPTS,
      });
      return;
    }
    offlineRef.current = markDone(
      offlineRef.current,
      batch.map((mutation) => mutation.id),
    );
    lastSavedRef.current = content;
    pendingPayloadRef.current = null;
    setSaveState("saved");
  }, [pageId]);

  const runSave = useCallback(async () => {
    const editor = editorRef.current;
    // Prefer the payload captured at edit time: by the time a deferred save
    // fires (or teardown flushes), the editor may already be torn down.
    let payload = pendingPayloadRef.current;
    if (payload === null && editor) {
      try {
        payload = JSON.stringify(editor.getJSON());
      } catch {
        payload = null; // editor already destroyed — nothing left to write
      }
    }
    if (payload === null) return;
    if (payload === lastSavedRef.current) {
      pendingPayloadRef.current = null;
      setSaveState("saved");
      return;
    }
    // With no network, a collaborative page buffers the snapshot locally
    // instead of failing the write; it is replayed once back online. A
    // single-user page keeps its original attempt-and-report behaviour.
    if (collab && isOffline()) {
      bufferSave(payload);
      return;
    }
    // Send the document as JSON text: ProseMirror shares one `attrs` object
    // across nodes, and React's action encoder converts a shared object graph
    // into a temporary reference the server cannot persist.
    const outcome = await safeAction(() => updatePageAction(pageId, { content: payload }));
    if (!outcome.ok) {
      setSaveState("error");
      toast.error(outcome.error);
      return;
    }
    const failure = actionError(outcome.value);
    if (failure) {
      setSaveState("error");
      toast.error(failure);
      return;
    }
    lastSavedRef.current = payload;
    pendingPayloadRef.current = null;
    setSaveState("saved");
  }, [pageId, bufferSave, collab]);

  const persist = useCallback(
    (payload: string) => {
      pendingPayloadRef.current = payload;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaveState("saving");
      saveTimer.current = setTimeout(() => {
        void runSave();
      }, 600);
    },
    [runSave],
  );

  /**
   * Record the current document into the shadow snapshot history, coalescing a
   * run of rapid edits (typing) into a single bounded step. `at` is supplied
   * here because `undo-stack` is deliberately clock-free. Only the derived
   * depth reaches React state, and only when it actually moves.
   */
  const recordSnapshot = useCallback((json: string) => {
    const next = pushSnapshot(snapshotsRef.current, json, {
      coalesceKey: "edit",
      coalesceWindowMs: SNAPSHOT_COALESCE_MS,
      at: Date.now(),
    });
    snapshotsRef.current = next;
    const undoable = Math.max(0, next.entries.length - 1);
    const redoable = next.future.length;
    setSnapshotDepth((prev) =>
      prev.undoable === undoable && prev.redoable === redoable ? prev : { undoable, redoable },
    );
  }, []);

  const insertFiles = useCallback(    async (files: File[]) => {
      const editor = editorRef.current;
      if (!editor) return;
      for (const file of files) {
        try {
          const asset = await uploadFile(file, workspaceId);
          if (asset.mimeType.startsWith("image/")) {
            editor.chain().focus().setImage({ src: asset.url, alt: asset.name }).run();
          } else {
            // Non-image uploads render through the image block's media
            // variants (video/audio/file); the explicit `mediaType` keeps the
            // element from being inferred wrong off the stored URL.
            editor
              .chain()
              .focus()
              .insertContent({
                type: "image",
                attrs: {
                  src: asset.url,
                  alt: asset.name,
                  mediaType: uploadedMediaKind(asset),
                },
              })
              .run();
          }
          toast.success(`${t(locale, "uploadedPrefix")} ${asset.name}`);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t(locale, "uploadFailed"));
        }
      }
    },
    [workspaceId, locale],
  );

  const [peers, setPeers] = useState(1);
  /** Transport status, surfaced so a dropped link is visible in the chrome. */
  const [collabStatus, setCollabStatus] = useState<CollabStatus>("connecting");
  /**
   * Live collaborators for the avatar stack, projected from the collab
   * provider's awareness states. The peer count above is kept as-is; the roster
   * is derived alongside it so the presence module (`src/lib/presence.ts`) owns
   * identity colour, recency ordering and idle eviction.
   */
  const [participants, setParticipants] = useState<Participant[]>([]);

  useEffect(() => {
    if (!collab) return;
    const awareness = collab.provider.awareness;
    const update = () => {
      const states = awareness.getStates();
      const now = Date.now();
      let roster: Participant[] = [];
      states.forEach((state, clientId) => {
        const id = String(clientId);
        const user = state["user"] as { name?: unknown } | undefined;
        const seen = awareness.meta.get(clientId)?.lastUpdated;
        roster = upsertParticipant(roster, {
          id,
          name: typeof user?.name === "string" ? user.name : "",
          color: assignColor(id),
          lastSeen: typeof seen === "number" ? seen : now,
        });
      });
      setPeers(states.size);
      setParticipants(visibleParticipants(roster, { now, ttlMs: PRESENCE_TTL_MS }));
    };
    update();
    awareness.on("change", update);
    return () => {
      awareness.off("change", update);
    };
  }, [collab]);

  // Transport lifecycle: open the socket on mount, replay any writes buffered
  // while the link was down, and tear everything down on unmount (or when the
  // room changes). `destroy` releases the awareness heartbeat, the update
  // handler and the broadcast channel, so nothing outlives the editor.
  useEffect(() => {
    if (!collab) return;
    const { provider, ydoc } = collab;
    const onStatus = (event: { status: CollabStatus }) => setCollabStatus(event.status);
    const onSync = (state: boolean) => {
      if (state) void flushOffline();
    };
    const onOnline = () => void flushOffline();
    provider.on("status", onStatus);
    provider.on("sync", onSync);
    window.addEventListener("online", onOnline);
    provider.connect();
    return () => {
      window.removeEventListener("online", onOnline);
      provider.off("status", onStatus);
      provider.off("sync", onSync);
      provider.disconnect();
      provider.destroy();
      ydoc.destroy();
    };
  }, [collab, flushOffline]);

  const editor = useEditor({
    editable,
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: { openOnClick: false, autolink: true },
        // The lowlight-backed code block below replaces the stock one.
        codeBlock: false,
        // TipTap v3 renamed the StarterKit option: `history` was a no-op, so
        // collab sessions kept the local undo-redo plugin registered (and the
        // Collaboration extension warns about it). `undoRedo: false` actually
        // disables it — the delete-undo toast then falls back to its
        // doc-level snapshot restore (canUndoViaHistory) in collaborative mode.
        ...(collab ? { undoRedo: false } : {}),
      }),
      CodeBlock.configure({ locale }),
      Placeholder.configure({
        placeholder: editorPlaceholder ?? t(locale, "editorPlaceholder"),
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      ImageBlock.configure({ inline: false, allowBase64: true, locale }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      BlockColors,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TableKit.configure({ table: { resizable: true } }),
      MathAutoDetect,
      Mathematics.configure({
        katexOptions: { throwOnError: false },
        inlineOptions: { onClick: editEquation },
        blockOptions: { onClick: editEquation },
      }),
      Callout.configure({ locale }),
      Toggle.configure({ locale }),
      Columns,
      Column,
      TableOfContents.configure({ locale }),
      Mention,
      Bookmark,
      Embed,
      PdfPreview,
      MapBlock,
      Breadcrumb.configure({ trail: breadcrumbTrail, workspaceSlug, locale }),
      PageEmbed.configure({ workspaceId, workspaceSlug }),
      TemplateButton.configure({ locale }),
      AskAi.configure({ workspaceId, locale }),
      LinkedDatabase.configure({ workspaceId, workspaceSlug, locale }),
      // B18: `1)` lists, `| a | b |` + Enter tables, `:smile:` emoji.
      InputRules,
      ...(collab
        ? [
            Collaboration.configure({ document: collab.ydoc }),
            CollaborationCaret.configure({
              provider: collab.provider,
              user: { name: "You", color: "#2383e2" },
            }),
          ]
        : []),
    ],
    content: (initialContent as object) ?? {
      type: "doc",
      content: [{ type: "paragraph" }],
    },
    editorProps: {
      attributes: { class: "focus:outline-none" },
      handlePaste(view, event) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length > 0) {
          void insertFiles(files);
          return true;
        }
        // HTML paste: normalise through the pure helper and insert a closed
        // block slice, so blocks copied from another page keep their type.
        // ProseMirror's stock path applies the copy's open depths
        // (`data-pm-slice`) and flattens the first block on partial copies.
        const html = event.clipboardData?.getData("text/html");
        if (!html) return false;
        const normalized = normalizePasteHtml(html);
        if (normalized.blocks.length === 0) return false;
        const { state } = view;
        const $from = state.selection.$from;
        const targetEmpty =
          state.selection.empty &&
          $from.parent.type.name === "paragraph" &&
          $from.parent.content.size === 0;
        const mode = pastePlan(normalized, { empty: targetEmpty });
        const json = mode === "blocks" ? normalized.blocks : normalized.inline;
        let nodes;
        try {
          nodes = json.map((node) => state.schema.nodeFromJSON(node));
        } catch {
          return false; // unparseable structure: fall back to the stock path
        }
        if (nodes.length === 0) return false;
        const { from, to } = state.selection;
        const slice =
          mode === "blocks"
            ? new Slice(Fragment.fromArray(nodes), 0, 0)
            : new Slice(
                Fragment.fromArray([state.schema.nodes.paragraph.create(null, nodes)]),
                1,
                1,
              );
        view.dispatch(
          view.state.tr
            .replaceRange(from, to, slice)
            .scrollIntoView()
            .setMeta("paste", true),
        );
        return true;
      },
      handleDrop(view, event, slice, moved) {
        const dragEvent = event as DragEvent;
        const files = Array.from(dragEvent.dataTransfer?.files ?? []);
        if (files.length > 0) {
          event.preventDefault();
          void insertFiles(files);
          return true;
        }
        // Horizontal drag from the handle nests/unnests; a purely vertical
        // drag keeps ProseMirror's stock reorder.
        const startX = dragStartXRef.current;
        if (moved && slice && slice.size > 0 && startX !== null) {
          const found = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          const zone = found ? dropZone(event.clientX, startX) : "align";
          const dragging = view.dragging as {
            slice: Slice;
            move: boolean;
            node?: { from: number };
          } | null;
          const plan =
            found && zone !== "align"
              ? analyzeBlockDrop(view.state, {
                  slice,
                  moved,
                  dropPos: found.pos,
                  zone,
                  sourcePos: dragging?.node ? dragging.node.from : null,
                })
              : null;
          if (plan) {
            const chain = editorRef.current
              ?.chain()
              .command(({ tr }) => {
                tr.delete(plan.source.from, plan.source.to);
                const pos = tr.mapping.map(plan.insertPos);
                tr.replaceRange(pos, pos, new Slice(Fragment.fromArray([plan.node]), 0, 0));
                // Cursor into the moved item (forward from the gap), not the
                // listItem boundary — TextSelection.create(pos+1) there would
                // resolve to a non-inline parent and warn.
                tr.setSelection(Selection.near(tr.doc.resolve(pos)));
                return true;
              })
              .focus()
              .scrollIntoView();
            if (chain) {
              const nested = plan.nest
                ? chain.sinkListItem(plan.nest.itemType)
                : chain;
              if (nested.run()) return true;
            }
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      // Serialise once per change and share it with both consumers: the save
      // path (which needs the exact payload at edit time) and the shadow
      // snapshot history.
      const json = JSON.stringify(e.getJSON());
      persist(json);
      recordSnapshot(json);
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Seed the shadow history with the document's initial state, once per editor
  // instance, so the first user edit yields exactly one undoable step.
  useEffect(() => {
    if (!editor || seededEditorRef.current === editor) return;
    seededEditorRef.current = editor;
    snapshotsRef.current = pushSnapshot(
      createStack<string>({ limit: SNAPSHOT_HISTORY_LIMIT }),
      JSON.stringify(editor.getJSON()),
    );
  }, [editor]);

  // Test hook: Playwright opts in with an init script (`window.__NOEMA_E2E`),
  // so the editor is only reachable from an automation session.
  useEffect(() => {
    if (!editor || typeof window === "undefined") return;
    const w = window as unknown as { __NOEMA_E2E?: boolean; __noemaEditor?: Editor };
    if (!w.__NOEMA_E2E) return;
    w.__noemaEditor = editor;
    return () => {
      if (w.__noemaEditor === editor) delete w.__noemaEditor;
    };
  }, [editor]);

  // Seed a fresh collaborative document from the stored content, once.
  useEffect(() => {
    if (!editor || !collab) return;
    const seed = () => {
      if (collab.ydoc.getXmlFragment("default").length > 0) return;
      editor.commands.setContent(
        (initialContent as object) ?? {
          type: "doc",
          content: [{ type: "paragraph" }],
        },
      );
    };
    if (collab.provider.synced) seed();
    else collab.provider.once("sync", seed);
  }, [editor, collab, initialContent]);

  // Persist the last edit when the editor unmounts: cancel the debounce and
  // flush both the in-flight snapshot and anything buffered offline. Without
  // this the pending write dies with the timer.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      void flushOffline();
      void runSave();
    },
    [flushOffline, runSave],
  );

  if (!editor) {
    return <div className="h-40 animate-pulse rounded bg-surface" />;
  }

  return (
    <div
      className="noema-editor relative"
      data-undo-depth={snapshotDepth.undoable}
      data-redo-depth={snapshotDepth.redoable}
    >
      {editable && (
        <>
          <BubbleMenu
            editor={editor}
            options={{ placement: "top" }}
            shouldShow={({ editor: e }) =>
              e.isEditable && (bubblePanelOpen || !e.state.selection.empty)
            }
          >
            <BubbleToolbar
              editor={editor}
              workspaceId={workspaceId}
              locale={locale}
              onPanelOpenChange={setBubblePanelOpen}
            />
          </BubbleMenu>

          <DragHandle
            editor={editor}
            nested
            onElementDragStart={(event) => {
              dragStartXRef.current = event.clientX;
            }}
            onElementDragEnd={() => {
              dragStartXRef.current = null;
            }}
          >
            <span className="noema-drag-handle" aria-hidden>
              ⠿
            </span>
          </DragHandle>

          <HistoryControls editor={editor} locale={locale} />
          <SuggestionsControls editor={editor} locale={locale} />
        </>
      )}

      <BlockContextMenu editor={editor} editable={editable} workspaceId={workspaceId} locale={locale}>
        <EditorContent editor={editor} />
      </BlockContextMenu>

      {editable && (
        <>
          <EquationEditor editor={editor} locale={locale} />
          <SlashMenu
            editor={editor}
            locale={locale}
            onPickImage={() => fileInputRef.current?.click()}
          />
          <MentionMenu editor={editor} workspaceId={workspaceId} pageId={pageId} locale={locale} />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf,.txt,.md,.json,.zip"
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length > 0) void insertFiles(files);
            }}
          />
        </>
      )}

      <div className="pointer-events-none absolute right-0 top-0 flex items-center gap-2 text-xs text-muted">
        {collab && participants.length > 0 && (
          <div
            className="pointer-events-auto flex items-center"
            aria-label={t(locale, "liveWord")}
          >
            {participants.map((participant) => {
              const label = cursorLabel(participant);
              return (
                <span
                  key={participant.id}
                  role="img"
                  aria-label={label}
                  title={label}
                  className="-ml-1.5 grid h-6 w-6 place-items-center rounded-full border-2 border-bg text-[10px] font-medium text-white first:ml-0"
                  style={{ backgroundColor: presenceColor(participant.color) }}
                >
                  {initials(label)}
                </span>
              );
            })}
          </div>
        )}
        {collab && (
          <span
            className="flex items-center gap-1 rounded bg-surface px-1.5 py-0.5"
            data-collab-status={collabStatus}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                collabStatus === "connected" ? "bg-emerald-500" : "bg-amber-500"
              }`}
            />
            {t(locale, "liveWord")} · {peers}
          </span>
        )}
        {saveState === "saving" && t(locale, "saving")}
        {saveState === "saved" && t(locale, "savedWord")}
        {saveState === "error" && (
          <span className="pointer-events-auto flex items-center gap-1 text-red-500">
            {t(locale, "saveFailed")}
            <button
              type="button"
              onClick={() => void runSave()}
              className="rounded border border-border px-1 text-xs text-fg hover:bg-surface-2"
            >
              {t(locale, "retry")}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
