"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
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
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import { dropCursor } from "@tiptap/pm/dropcursor";
import type { EditorView } from "@tiptap/pm/view";
import { normalizePasteHtml, pastePlan } from "@/lib/paste";
import { analyzeBlockDrop, dropZone } from "@/lib/drag-indent";
import { useFlipList } from "@/lib/layout-shift";
import { dropVerdict } from "@/components/editor/drop-rejection";
import {
  DEFAULT_ALLOWED_TAGS,
  detectSource,
  normalizeNestedMarks,
  sanitizePaste,
  sourceCleanups,
  stripInlineStyles,
  type PasteCleanupStep,
  type PasteSource,
} from "@/lib/paste-cleanup";
import {
  extractDataUrl,
  inspectClipboardItem,
  planPaste,
  type ClipboardItem,
  type PasteSkip,
  type PasteUpload,
} from "@/lib/clipboard-image";
import {
  extendSelection,
  resolveRange,
  shiftSelect,
  deletePlan,
  type BlockRange as SelectionRange,
  type MaybeRange,
} from "@/lib/block-selection";
import { moveBlocks, type BlockPage } from "@/lib/block-move";
import { blankClickPlan } from "@/lib/blank-click";
import { restrictCommands } from "@/lib/math-render";
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
import { cn, initials } from "@/lib/utils";
import { FLOATING_CORNER } from "@/lib/floating-corner";
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
import { DUR, EASE, Z } from "@/lib/design-tokens";
import {
  Callout,
  Column,
  Columns,
  TableOfContents,
  Toggle,
  animateTaskTick,
} from "@/components/editor/extensions/custom-blocks";
import { Mention } from "@/components/editor/extensions/mention";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { Bookmark, Embed, MapBlock, PdfPreview } from "@/components/editor/extensions/bookmark";
import { Breadcrumb, type BreadcrumbCrumb } from "@/components/editor/extensions/breadcrumb";
import { PageEmbed } from "@/components/editor/extensions/page-embed";
import { TemplateButton, ButtonBlock } from "@/components/editor/extensions/template-button";
import { AskAi } from "@/components/editor/extensions/ask-ai";
import { SyncedBlock } from "@/components/editor/extensions/synced-block";
import {
  AnimatedImage,
  prefersReducedMotion,
  resolveAnimatedMediaAttrs,
  looksAnimatedByExtension,
} from "@/components/editor/extensions/animated-image";
import { LinkedDatabase } from "@/components/editor/extensions/linked-database";
import { GIF_MIME } from "@/lib/animated-media";
import {
  collectBlocks,
  copyReference,
  extractReferences,
  missingReferences,
  resolveSynced,
  type Block as ReferenceBlock,
} from "@/lib/block-refs";
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

/**
 * Does this mousedown land in the empty canvas *under* the last block, and if so
 * start a paragraph there? Returns true when it consumed the event.
 *
 * The canvas' breathing room lives inside `.ProseMirror` (`.noema-page-canvas`),
 * so a click below the content targets the editable element itself rather than a
 * child block. What to do about it is `blankClickPlan`'s call; this is the
 * geometry and the transaction: reuse the trailing empty paragraph or append a
 * new one, then put the caret in it. Treated as handled, so ProseMirror does not
 * then move the caret to the end of the *previous* block as well.
 */
function clickUnderContent(view: EditorView, event: MouseEvent): boolean {
  if (event.target !== view.dom) return false;
  const last = view.dom.lastElementChild;
  const contentBottom = last
    ? last.getBoundingClientRect().bottom
    : view.dom.getBoundingClientRect().top;
  if (event.clientY < contentBottom) return false;

  const tail = view.state.doc.lastChild;
  const plan = blankClickPlan({
    lastBlockType: tail?.type.name,
    lastBlockEmpty: tail !== null && tail.content.size === 0,
  });

  const { tr, schema } = view.state;
  if (plan.kind === "append") {
    tr.insert(tr.doc.content.size, schema.nodes.paragraph.create());
  }
  tr.setSelection(Selection.near(tr.doc.resolve(tr.doc.content.size), -1));
  view.dispatch(tr);
  view.focus();
  event.preventDefault();
  return true;
}

/**
 * The local user's collaboration-cursor colour, resolved from the `--accent`
 * token at runtime.
 *
 * The collaboration caret is protocol data, not theme styling: y-prosemirror
 * validates it with `/^#[0-9a-fA-F]{6}$/` and paints the accepted value
 * straight onto the caret border and name label, so a `var(--accent)` reference
 * would be rejected and the cursor would fall back to transparent. Reading the
 * token's computed value keeps the presence colour on the design system (and
 * correct across light / dark / high-contrast) while still handing the library
 * the concrete hex it demands. Outside a DOM (SSR) it returns `""`, which the
 * caret already treats as "no colour" — no caret renders there anyway.
 */
export function presenceCursorColor(): string {
  if (typeof window === "undefined" || typeof document === "undefined") return "";
  try {
    return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  } catch {
    return "";
  }
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

/* ----------------------------------------------------------- motion (§6/§19) */

/** The two block-lifecycle motions the editor animates. */
export type BlockMotion = "insert" | "remove";

/**
 * Height + opacity keyframes for a block entering (`insert`) or leaving
 * (`remove`). Animating the block's own height is what lets its neighbours
 * slide instead of jumping (DESIGN_SYSTEM §6, FRONTEND_PLAN 19.7); the opacity
 * ramp also hides the empty-block placeholder until the block has settled, so
 * it never flashes mid-insert.
 */
export function blockMotionFrames(action: BlockMotion, height: number): Keyframe[] {
  const measured = Number.isFinite(height) && height > 0 ? `${Math.round(height)}px` : "0px";
  const hidden: Keyframe = { height: "0px", opacity: 0, overflow: "hidden" };
  const shown: Keyframe = { height: measured, opacity: 1, overflow: "hidden" };
  return action === "insert" ? [hidden, shown] : [shown, hidden];
}

/** Duration + easing for a block lifecycle animation (base token, smooth). */
export function blockMotionOptions(): { duration: number; easing: string } {
  return { duration: DUR.base, easing: EASE.smooth };
}

/** Class marker applied while a block plays its enter/leave motion. */
export function blockMotionClass(action: BlockMotion): string {
  return action === "insert" ? "noema-block-insert" : "noema-block-remove";
}

/**
 * ProseMirror drop-cursor options: the drag destination is a 2px accent line
 * (FRONTEND_PLAN 19.8). Fed straight to `dropCursor`, so the indicator needs no
 * bespoke stylesheet and always uses the accent token.
 */
export function dropIndicatorOptions(): { color: string; width: number; class: string } {
  return { color: "var(--accent)", width: 2, class: "noema-drop-indicator" };
}

/**
 * Root class while a drag is live. Dragging must track the cursor 1:1, so the
 * whole editor drops its transitions (DESIGN_SYSTEM §6 "Dragging is 1:1").
 */
export function dragActiveClass(active: boolean): string {
  return active ? "u-no-transition noema-drag-active" : "";
}

/** Inline lift for the block under the cursor: shadow-2 + a slight scale. */
export function dropLiftStyle(): { boxShadow: string; transform: string } {
  return { boxShadow: "var(--shadow-2)", transform: "scale(1.01)" };
}

/** Spring-settle keyframes played when a drag ends (popovers/drag settle). */
export function dropSettleFrames(): Keyframe[] {
  return [
    { transform: "scale(1.01)", boxShadow: "var(--shadow-2)", offset: 0 },
    { transform: "scale(1)", boxShadow: "var(--shadow-1)", offset: 1 },
  ];
}

/** Duration + easing for the drag settle (base token, spring ease). */
export function dropSettleOptions(): { duration: number; easing: string } {
  return { duration: DUR.base, easing: EASE.spring };
}

/** Visibility inputs for a block's hover chrome (grip + add). */
export type RowChromeState = {
  hovered?: boolean;
  focused?: boolean;
  selected?: boolean;
};

/**
 * The drag handle + add-button fade in on row hover and stay put while the row
 * is focused or selected, so the keyboard path gets the same affordances as the
 * pointer (DESIGN_SYSTEM §8/§9). Colour-only motion via `.u-colors`.
 */
export function rowChromeClass(state: RowChromeState = {}): string {
  const visible = Boolean(state.hovered || state.focused || state.selected);
  return `noema-row-chrome u-colors ${visible ? "opacity-100" : "opacity-0"}`;
}

/**
 * Presentational block chrome: the ⋮⋮ drag affordance and the + affordance.
 * Pure (no hooks), so it renders identically on the server and in this slice's
 * `renderToStaticMarkup` proof. The grip is decorative — the surrounding
 * `DragHandle` owns the actual drag behaviour, and the + stays chrome-only so
 * this slice never introduces a new command.
 */
export function EditorRowChrome({ state = {} }: { state?: RowChromeState }) {
  const visible = Boolean(state.hovered || state.focused || state.selected);
  return (
    <span
      className={rowChromeClass(state)}
      data-row-chrome=""
      data-chrome-visible={visible ? "true" : "false"}
    >
      <span className="noema-drag-handle" aria-hidden="true">
        ⋮⋮
      </span>
      <span className="noema-row-add" aria-hidden="true">
        +
      </span>
    </span>
  );
}

/* --------------------------------------------------------------- paste engines */

/**
 * Attributes the Noema paste normaliser understands, mirroring the rich list
 * `paste.ts` feeds its own sanitizer. `sanitizePaste` (paste-cleanup) has no
 * per-tag wildcard, so the same list is attached to every structural tag; the
 * allowlist then keeps exactly what `normalizePasteHtml` reads while still
 * dropping `on*` handlers and unsafe URL schemes on top.
 */
const NOEMA_PASTE_ATTRS: readonly string[] = [
  "href", "src", "alt", "title", "colspan", "rowspan", "lang", "class",
  "style", "type", "checked", "open", "color", "emoji", "summary",
  "data-block-color", "data-pm-slice", "data-type", "data-checked",
  "data-language", "data-callout", "data-toggle", "data-columns",
  "data-column", "data-toc", "data-caption", "data-summary",
  "data-collapsed", "aria-expanded", "data-color",
];

/**
 * Structural tags the Noema paste normaliser maps to block nodes: the
 * sanitizer's defaults plus the wrappers/atoms `normalizePasteHtml` reads
 * (callout/toggle/columns `div`s, task-list `input`s, inline `span`/`mark`).
 */
const NOEMA_PASTE_TAGS: readonly string[] = [
  ...DEFAULT_ALLOWED_TAGS,
  "div", "span", "ins", "mark", "font", "sub", "sup", "img", "input",
];

const NOEMA_PASTE_ATTR_MAP: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    NOEMA_PASTE_TAGS.map((tag): [string, readonly string[]] => [tag, NOEMA_PASTE_ATTRS]),
  );

/** The sanitized clipboard HTML plus the source fingerprint behind it. */
export type CleanedClipboardHtml = {
  /** Allowlist-sanitised HTML, safe to hand to `normalizePasteHtml`. */
  html: string;
  /** The clipboard source `detectSource` recognised. */
  source: PasteSource;
  /** The extra cleanup steps that source declares (`sourceCleanups`). */
  cleanups: readonly PasteCleanupStep[];
};

/**
 * Route clipboard HTML through the paste-cleanup engine before it ever reaches
 * the document model: fingerprint the source (`detectSource`), read the
 * source-specific cleanup catalogue (`sourceCleanups`), collapse redundant mark
 * nesting, strip Word's `mso-*` inline noise, then harden everything through
 * `sanitizePaste`'s tag/attribute/URL allowlist.
 *
 * Only Word's clipboard triggers the inline-style strip: it is the one source
 * whose noise is both heavy and unambiguous. Noema's *own* copies carry
 * `data-block-id`, which `detectSource` fingerprints as Notion — stripping
 * every non-generic source would therefore erase real text colour on an
 * internal copy/paste, so GDocs/Notion keep their (now class/attr-limited)
 * markup.
 */
export function cleanClipboardHtml(html: string): CleanedClipboardHtml {
  const source = detectSource(html);
  const cleanups = sourceCleanups(source);
  const wantsStyleStrip = cleanups.some((step) => step.id === "word:mso-styles");
  const deNoised = wantsStyleStrip
    ? normalizeNestedMarks(stripInlineStyles(html))
    : normalizeNestedMarks(html);
  return {
    html: sanitizePaste(deNoised, {
      mode: "rich",
      allowedTags: NOEMA_PASTE_TAGS,
      allowedAttrs: NOEMA_PASTE_ATTR_MAP,
    }),
    source,
    cleanups,
  };
}

/** One clipboard file the editor can upload, described without the blob. */
export type ClipboardFileDescriptor = {
  name: string;
  mimeType: string;
  size: number;
};

/** A gated upload, tied back to the file or HTML data URL it came from. */
export type ClipboardImageUpload = PasteUpload & {
  /** Whether the bytes came from a real `File` or an HTML `data:` image. */
  source: "file" | "data-url";
  /** Index into the input `files` array (present for `source: "file"`). */
  fileIndex?: number;
  /** Base64 payload (present for `source: "data-url"`). */
  data?: string;
};

/** What the clipboard-image pipeline will upload, and what it refused. */
export type ClipboardImagePlan = {
  uploads: ClipboardImageUpload[];
  skipped: PasteSkip[];
};

/**
 * Run the clipboard-image engine over a paste: prefer real `File`s, otherwise
 * pull the first `data:image/*` out of the HTML flavour with `extractDataUrl`.
 * Every candidate is gated by `inspectClipboardItem` (allow-list, SVG safety,
 * size) and named/skipped by `planPaste` before any upload is attempted.
 * Pure: takes descriptors, returns a plan, never touches the network.
 */
export function planClipboardImages(options: {
  files: readonly ClipboardFileDescriptor[];
  html?: string;
  maxBytes?: number;
  existingNames?: Iterable<string>;
  now?: Date | number | string;
}): ClipboardImagePlan {
  type Candidate = ClipboardItem & { source: "file" | "data-url"; fileIndex?: number };
  const candidates: Candidate[] = options.files.map((file, fileIndex) => ({
    mimeType: file.mimeType,
    size: file.size,
    name: file.name,
    source: "file",
    fileIndex,
  }));

  if (candidates.length === 0) {
    const extracted = extractDataUrl(options.html ?? "");
    // A percent-encoded SVG carries no base64 payload, so its safety cannot be
    // re-checked here; skip it rather than reject it as `unsafe-svg`.
    if (extracted && !(extracted.mimeType === "image/svg+xml" && extracted.base64 === "")) {
      candidates.push({
        mimeType: extracted.mimeType,
        size: extracted.size,
        name: "",
        source: "data-url",
        ...(extracted.base64 !== "" ? { data: extracted.base64 } : {}),
      });
    }
  }

  const plan = planPaste({
    items: candidates,
    maxBytes: options.maxBytes,
    existingNames: options.existingNames,
    now: options.now,
  });

  // `planPaste` reports only counts, so re-run the same verdict per candidate to
  // line each accepted upload back up with the bytes it should upload.
  const uploads: ClipboardImageUpload[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    const verdict = inspectClipboardItem(candidate, { maxBytes: options.maxBytes });
    if (!verdict.accept) continue;
    const upload = plan.uploads[cursor];
    cursor += 1;
    if (!upload) break;
    uploads.push({
      ...upload,
      source: candidate.source,
      ...(candidate.fileIndex !== undefined ? { fileIndex: candidate.fileIndex } : {}),
      ...(candidate.data !== undefined ? { data: candidate.data } : {}),
    });
  }
  return { uploads, skipped: plan.skipped };
}

/* --------------------------------------------------------- block selection/move */

/** The top-level block ids of a document, in document order. */
export function topLevelBlockIds(doc: PMNode): string[] {
  const ids: string[] = [];
  doc.forEach((node) => {
    const id = node.attrs?.id;
    ids.push(typeof id === "string" ? id : "");
  });
  return ids;
}

/** The id of the top-level block containing `pos`, or `null`. */
function blockIdAt(doc: PMNode, pos: number): string | null {
  let found: string | null = null;
  doc.forEach((node, offset) => {
    if (found !== null) return;
    if (pos >= offset && pos <= offset + node.nodeSize) {
      const id = node.attrs?.id;
      found = typeof id === "string" && id !== "" ? id : null;
    }
  });
  return found;
}

/**
 * Every block id nested inside the top-level block `id`, depth-first. Used to
 * seed the invalid-drop decision: a block may never be dropped into its own
 * subtree, so the editor needs that set before the first `dragover`.
 */
function descendantBlockIds(doc: PMNode, id: string): string[] {
  const ids: string[] = [];
  const walk = (node: PMNode) => {
    node.forEach((child) => {
      const childId = child.attrs?.id;
      if (typeof childId === "string" && childId !== "") ids.push(childId);
      walk(child);
    });
  };
  doc.forEach((node) => {
    if (node.attrs?.id === id) walk(node);
  });
  return ids;
}

/* ------------------------------------------------- block references (refs) */

/**
 * Lift a ProseMirror node into the shared `Block` shape `src/lib/block-refs.ts`
 * reads, preserving a node's `refBlockId`/`refBlockIds` reference fields.
 */
function pmNodeToReferenceBlock(node: PMNode): ReferenceBlock {
  const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
  const block: ReferenceBlock = { id, type: node.type.name };
  const refBlockId = node.attrs?.refBlockId;
  if (typeof refBlockId === "string" && refBlockId !== "") block.refBlockId = refBlockId;
  const refBlockIds = node.attrs?.refBlockIds;
  if (Array.isArray(refBlockIds)) {
    const ids = refBlockIds.filter((value): value is string => typeof value === "string");
    if (ids.length > 0) block.refBlockIds = ids;
  }
  const children: ReferenceBlock[] = [];
  node.forEach((child) => {
    if (child.isText) return;
    children.push(pmNodeToReferenceBlock(child));
  });
  if (children.length > 0) block.children = children;
  return block;
}

/**
 * The document's block-reference view: the same tree `page-editor` uses for
 * block ids, projected into the `block-refs.ts` engine so its helpers own the
 * reference bookkeeping. Pure — the ProseMirror document is never mutated.
 */
export function pmDocToReferenceBlocks(doc: PMNode): ReferenceBlock[] {
  const blocks: ReferenceBlock[] = [];
  doc.forEach((node) => blocks.push(pmNodeToReferenceBlock(node)));
  return blocks;
}

/** The canonical id → block index for a document (`collectBlocks`). */
export function blockReferenceIndex(doc: PMNode): ReturnType<typeof collectBlocks> {
  return collectBlocks(pmDocToReferenceBlocks(doc));
}

/** Every block that references another block (`extractReferences`). */
export function blockReferenceEntries(doc: PMNode): ReturnType<typeof extractReferences> {
  return extractReferences(pmDocToReferenceBlocks(doc));
}

/** Referenced block ids the document does not contain (`missingReferences`). */
export function brokenBlockReferences(doc: PMNode): string[] {
  return missingReferences(pmDocToReferenceBlocks(doc));
}

/** Resolve a referenced block's subtree (`resolveSynced`). */
export function resolveBlockReference(doc: PMNode, blockId: string) {
  return resolveSynced(pmDocToReferenceBlocks(doc), blockId);
}

/** The paste pair for a synced block reference (`copyReference`). */
export function blockReferenceCopy(doc: PMNode, blockId: string) {
  return copyReference(pmDocToReferenceBlocks(doc), blockId);
}


/**
 * Plan a multi-block drag reorder with `moveBlocks`: given the flat block ids,
 * the selected range and the destination index, return the new id order, or
 * `null` when fewer than two whole blocks are selected (the single-block
 * indent path keeps handling that case).
 */
export function planBlockReorder(
  blockIds: readonly string[],
  range: MaybeRange,
  targetIndex: number,
): string[] | null {
  const selected = resolveRange(blockIds, range);
  if (selected.length < 2) return null;
  const indices = selected.map((id) => blockIds.indexOf(id)).filter((index) => index >= 0);
  if (indices.length < 2) return null;
  const page: BlockPage = {
    id: "page",
    blocks: blockIds.map((id) => ({ id, type: "block" })),
  };
  const result = moveBlocks({ from: page, to: page }, { indices, targetIndex });
  return result.toDoc.blocks.map((block) => block.id);
}

/** Reorder the document's top-level blocks to match `order` in one transaction. */
function reorderTopLevelBlocks(view: EditorView, order: readonly string[]): void {
  const doc = view.state.doc;
  const byId = new Map<string, PMNode>();
  doc.forEach((node) => {
    const id = node.attrs?.id;
    if (typeof id === "string") byId.set(id, node);
  });
  const nodes = order
    .map((id) => byId.get(id))
    .filter((node): node is PMNode => node !== undefined);
  if (nodes.length !== doc.childCount) return;
  view.dispatch(
    view.state.tr.replaceWith(0, doc.content.size, Fragment.fromArray(nodes)),
  );
}

/** Delete every top-level block whose id is in `ids` as one transaction. */
function deleteBlocksByIds(view: EditorView, ids: readonly string[]): void {
  const doc = view.state.doc;
  const targets = new Set(ids);
  let from = -1;
  let to = -1;
  doc.forEach((node, offset) => {
    const id = node.attrs?.id;
    if (typeof id === "string" && targets.has(id)) {
      if (from === -1) from = offset;
      to = offset + node.nodeSize;
    }
  });
  if (from === -1 || to === -1) return;
  const tr = view.state.tr;
  // A document is `block+`: replacing the whole body with one empty paragraph
  // keeps the schema valid when the range was the entire page.
  if (from === 0 && to === doc.content.size) {
    tr.replaceWith(0, doc.content.size, view.state.schema.nodes.paragraph.create());
  } else {
    tr.delete(from, to);
  }
  view.dispatch(tr.scrollIntoView());
}

/* ---------------------------------------------------------- block motion plugin */

/** Id/offset view of a document's top-level blocks (ids come from BlockIds). */
function topLevelBlocks(doc: PMNode): Array<{ id: string; pos: number }> {
  const blocks: Array<{ id: string; pos: number }> = [];
  doc.forEach((node, offset, index) => {
    const id =
      typeof node.attrs?.id === "string" && node.attrs.id !== ""
        ? node.attrs.id
        : `#${index}`;
    blocks.push({ id, pos: offset });
  });
  return blocks;
}

/**
 * Play the enter/leave motion for the blocks a transaction added or removed.
 * Presentation only: reads the two documents and the live DOM, never mutates
 * either. Inserted blocks grow from zero height so their neighbours slide
 * (DESIGN_SYSTEM §6, FRONTEND_PLAN 19.7); a removed block is already gone from
 * the DOM, so its gap is settled by fading the block that closed it instead of
 * snapping. Disabled wholesale under `prefers-reduced-motion`.
 */
function animateBlockMotion(view: EditorView, prevDoc: PMNode): void {
  if (prefersReducedMotion()) return;
  const before = topLevelBlocks(prevDoc);
  const after = topLevelBlocks(view.state.doc);
  const beforeIds = new Set(before.map((block) => block.id));
  const afterIds = new Set(after.map((block) => block.id));
  const options = blockMotionOptions();

  for (const block of after) {
    if (beforeIds.has(block.id)) continue;
    const el = view.nodeDOM(block.pos);
    if (!(el instanceof HTMLElement) || typeof el.animate !== "function") continue;
    const height = el.getBoundingClientRect().height;
    el.classList.add(blockMotionClass("insert"));
    const animation = el.animate(blockMotionFrames("insert", height), {
      ...options,
      fill: "both",
    });
    animation.addEventListener("finish", () => {
      el.classList.remove(blockMotionClass("insert"));
      animation.cancel();
    });
  }

  const removed = before.filter((block) => !afterIds.has(block.id));
  if (removed.length === 0) return;
  const survivor =
    after.find((block) => block.pos >= removed[0].pos) ?? after[after.length - 1];
  const el = survivor ? view.nodeDOM(survivor.pos) : null;
  if (!(el instanceof HTMLElement) || typeof el.animate !== "function") return;
  el.classList.add(blockMotionClass("remove"));
  const animation = el.animate([{ opacity: 0.35 }, { opacity: 1 }], options);
  animation.addEventListener("finish", () => {
    el.classList.remove(blockMotionClass("remove"));
    animation.cancel();
  });
}

/** Drop indicator: a 2px accent line at the drag destination. */
const DropIndicator = Extension.create({
  name: "dropIndicator",
  addProseMirrorPlugins() {
    const { color, width, class: className } = dropIndicatorOptions();
    return [dropCursor({ color, width, class: className })];
  },
});

/** Block enter/leave motion (height + opacity) driven by document diffs. */
const BlockMotion = Extension.create({
  name: "blockMotion",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("blockMotion"),
        view() {
          return {
            update(view, prevState) {
              if (prevState.doc.eq(view.state.doc)) return;
              animateBlockMotion(view, prevState.doc);
            },
          };
        },
      }),
    ];
  },
});

/**
 * The math engine's banned-command guard (`restrictCommands`): strips
 * `\input`/`\include`/`\write18` and their arguments, leaving every other
 * equation byte-for-byte intact. Idempotent, so it settles in one pass.
 */
export function restrictMathLatex(latex: string): string {
  return restrictCommands(latex);
}

/** Document guard: no equation node may retain a banned command. */
const MathSafety = Extension.create({
  name: "mathSafety",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const tr = newState.tr;
          let changed = false;
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== "inlineMath" && node.type.name !== "blockMath") return true;
            const latex = typeof node.attrs.latex === "string" ? node.attrs.latex : "";
            const next = restrictMathLatex(latex);
            if (next !== latex) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: next });
              changed = true;
            }
            return false;
          });
          return changed ? tr : null;
        },
      }),
    ];
  },
});

/** Build a browser `File` from a planned `data:` image upload. */
function dataUrlUploadFile(upload: ClipboardImageUpload): File | null {
  if (!upload.data) return null;
  try {
    const binary = atob(upload.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], upload.name, { type: upload.mimeType });
  } catch {
    return null;
  }
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
    <div
      // Bottom-right, in the stack above the undo/redo bar. It used to be pinned
      // to the bottom-*left* to stay out of the undo/redo bar's way, which put it
      // straight on top of the sidebar footer — picking a corner the contract does
      // not cover is not a way to avoid a collision, it just moves it. See
      // `src/lib/floating-corner.ts`.
      className={cn(
        "fixed flex flex-col items-end gap-1 text-xs",
        FLOATING_CORNER.suggest,
      )}
      style={{ zIndex: Z.sticky }}
    >
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
                className="rounded px-1 text-success hover:bg-surface"
              >
                ✓
              </button>
              <button
                type="button"
                aria-label={t(locale, "rejectSuggestion")}
                title={t(locale, "rejectSuggestion")}
                onClick={() => editor.chain().focus().rejectSuggestion(suggestion.id).run()}
                className="rounded px-1 text-danger hover:bg-surface"
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
            active ? "text-success" : "text-muted"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-success" : "bg-muted"}`} />
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
              className="rounded px-1.5 py-0.5 text-success hover:bg-surface-2"
            >
              {t(locale, "acceptAllSuggestions")}
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().rejectAll().run()}
              className="rounded px-1.5 py-0.5 text-danger hover:bg-surface-2"
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
  /** Row-chrome visibility (⋮⋮ + add) for the block the DragHandle targets. */
  const [chromeVisible, setChromeVisible] = useState(false);
  /** Whether the editor holds focus, so the chrome stays visible for keyboard. */
  const [editorFocused, setEditorFocused] = useState(false);
  /** Live HTML5 drag state; drives the 1:1 (no-transition) root class. */
  const [dragging, setDragging] = useState(false);
  /** Document position of the block the DragHandle currently targets. */
  const chromePosRef = useRef<number | null>(null);
  /** DOM element lifted during a drag, restored (with a spring settle) on drop. */
  const dragTargetRef = useRef<HTMLElement | null>(null);
  /** The dragged top-level block's id, plus its subtree (invalid-drop guard). */
  const draggingIdRef = useRef<string | null>(null);
  const draggingDescendantsRef = useRef<string[]>([]);
  /** Block-list root the FLIP hook measures, and the ordered ids it watches. */
  const listRef = useRef<HTMLDivElement | null>(null);
  const [flipOrder, setFlipOrder] = useState("");
  /** Viewport point for the danger-tinted invalid-drop indicator, or `null`. */
  const [dropRejection, setDropRejection] = useState<{ x: number; y: number } | null>(null);
  /** Signature of the rejected target, so re-renders happen per target not per px. */
  const dropRejectionKeyRef = useRef("");
  /**
   * The multi-block range selection (block-selection engine), authoritative in
   * a ref so the `editorProps` closures created once by `useEditor` never read
   * a stale value. Shift-click / Shift-Arrow extend it, Escape clears it, and
   * `handleDrop`/`handleKeyDown` act on it.
   */
  const blockRangeRef = useRef<SelectionRange | null>(null);
  /** How many top-level blocks the range currently covers (for the wrapper). */
  const [blockSelected, setBlockSelected] = useState(0);
  /** Referenced block ids whose target block no longer exists (`block-refs`). */
  const [brokenRefs, setBrokenRefs] = useState(0);
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
      color: presenceCursorColor(),
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
      const reducedMotion = prefersReducedMotion();
      for (const file of files) {
        try {
          const asset = await uploadFile(file, workspaceId);
          if (asset.mimeType.startsWith("image/")) {
            if (asset.mimeType === GIF_MIME || looksAnimatedByExtension(asset.url)) {
              // A GIF is sniffed for real frames (`isAnimatedGif`) and rendered
              // through the playback policy (`playbackPolicy`), which refuses to
              // autoplay under `prefers-reduced-motion`.
              let bytes: Uint8Array | undefined;
              try {
                bytes = new Uint8Array(await file.arrayBuffer());
              } catch {
                bytes = undefined;
              }
              const { attrs } = resolveAnimatedMediaAttrs({
                src: asset.url,
                alt: asset.name,
                mimeType: asset.mimeType,
                ...(bytes === undefined ? {} : { bytes }),
                reducedMotion,
                autoplay: true,
              });
              editor.chain().focus().insertContent({ type: "animatedImage", attrs }).run();
            } else {
              editor.chain().focus().setImage({ src: asset.url, alt: asset.name }).run();
            }
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

  /**
   * Upload the images a paste plan accepted (real files first, otherwise the
   * HTML data URL `extractDataUrl` recovered) through the normal attachment
   * pipeline, and report anything `inspectClipboardItem` refused.
   */
  const uploadClipboardImages = useCallback(
    async (plan: ClipboardImagePlan, files: File[]) => {
      for (const upload of plan.uploads) {
        const file =
          upload.source === "data-url"
            ? dataUrlUploadFile(upload)
            : files[upload.fileIndex ?? -1] ?? null;
        if (!file) continue;
        await insertFiles([file]);
      }
      if (plan.skipped.length > 0) {
        toast.error(`${plan.skipped.length} clipboard image(s) skipped`);
      }
    },
    [insertFiles],
  );

  /**
   * Paint (or clear) the active block range on the top-level DOM nodes and
   * mirror its size onto `blockSelected`. The ids come from the editor's global
   * `id` attribute (the `BlockIds` extension), rendered as `data-block-id`.
   */
  const paintBlockRange = useCallback((range: SelectionRange | null) => {
    blockRangeRef.current = range;
    const editor = editorRef.current;
    if (!editor || !editor.view) {
      setBlockSelected(range ? 1 : 0);
      return;
    }
    const root = editor.view.dom;
    root.querySelectorAll<HTMLElement>(".noema-block-selected").forEach((el) => {
      el.classList.remove("noema-block-selected");
      el.style.removeProperty("background-color");
    });
    if (!range) {
      setBlockSelected(0);
      return;
    }
    const ids = resolveRange(topLevelBlockIds(editor.state.doc), range);
    const selected = new Set(ids);
    root.querySelectorAll<HTMLElement>("[data-block-id]").forEach((el) => {
      const id = el.getAttribute("data-block-id");
      if (id && selected.has(id)) {
        el.classList.add("noema-block-selected");
        // Block selection tint comes from the `--selection` token; applied
        // inline so the shared stylesheet stays untouched (DESIGN_SYSTEM §2).
        el.style.setProperty("background-color", "var(--selection)");
      }
    });
    setBlockSelected(ids.length);
  }, []);

  /**
   * Raise or clear the body-level drag flag the FLIP hook reads. A live drag
   * owns the pointer 1:1, so layout shifts stand down for its whole duration.
   */
  const setDraggingFlag = useCallback((active: boolean) => {
    if (typeof document === "undefined") return;
    if (active) document.body.dataset.dragging = "1";
    else delete document.body.dataset.dragging;
  }, []);

  /**
   * Lift the block under the cursor while it is being dragged: shadow-2 + a
   * slight scale, and drop transitions so the drag tracks the pointer 1:1
   * (DESIGN_SYSTEM §6).
   */
  const beginBlockDrag = useCallback(() => {
    setDragging(true);
    setDraggingFlag(true);
    dropRejectionKeyRef.current = "";
    setDropRejection(null);
    const editor = editorRef.current;
    const pos = chromePosRef.current;
    if (!editor || pos === null) {
      draggingIdRef.current = null;
      draggingDescendantsRef.current = [];
      return;
    }
    const blockId = blockIdAt(editor.state.doc, pos);
    draggingIdRef.current = blockId;
    draggingDescendantsRef.current = blockId
      ? descendantBlockIds(editor.state.doc, blockId)
      : [];
    const el = editor.view.nodeDOM(pos);
    if (!(el instanceof HTMLElement)) return;
    dragTargetRef.current = el;
    el.classList.add("noema-block-dragging", "u-no-transition");
    const lift = dropLiftStyle();
    el.style.boxShadow = lift.boxShadow;
    el.style.transform = lift.transform;
  }, [setDraggingFlag]);

  /** Drop the lift and let the block spring back into place (spring ease). */
  const endBlockDrag = useCallback(() => {
    setDragging(false);
    setDraggingFlag(false);
    dropRejectionKeyRef.current = "";
    setDropRejection(null);
    draggingIdRef.current = null;
    draggingDescendantsRef.current = [];
    const el = dragTargetRef.current;
    dragTargetRef.current = null;
    if (!el) return;
    el.classList.remove("noema-block-dragging");
    el.style.removeProperty("box-shadow");
    el.style.removeProperty("transform");
    el.classList.remove("u-no-transition");
    if (prefersReducedMotion() || typeof el.animate !== "function") return;
    const settle = el.animate(dropSettleFrames(), dropSettleOptions());
    settle.addEventListener("finish", () => settle.cancel());
  }, [setDraggingFlag]);

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
        // The empty-block hint fades in instead of popping (DESIGN_SYSTEM §6):
        // `animate-fade` rides on the empty paragraph that owns the ::before.
        emptyEditorClass: "is-editor-empty animate-fade",
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
      Bookmark.configure({ locale }),
      Embed.configure({ locale }),
      PdfPreview.configure({ locale }),
      MapBlock.configure({ locale }),
      Breadcrumb.configure({ trail: breadcrumbTrail, workspaceSlug, locale }),
      PageEmbed.configure({ workspaceId, workspaceSlug, locale }),
      TemplateButton.configure({ locale }),
      ButtonBlock.configure({ locale }),
      AskAi.configure({ workspaceId, locale, pageId }),
      SyncedBlock.configure({ locale }),
      AnimatedImage.configure({ locale }),
      LinkedDatabase.configure({ workspaceId, workspaceSlug, locale }),
      // B18: `1)` lists, `| a | b |` + Enter tables, `:smile:` emoji.
      InputRules,
      // Math engine guard: strips banned TeX commands from every equation node.
      MathSafety,
      // Presentation: block enter/leave motion + a 2px accent drop indicator.
      BlockMotion,
      DropIndicator,
      ...(collab
        ? [
            Collaboration.configure({ document: collab.ydoc }),
            CollaborationCaret.configure({
              provider: collab.provider,
              user: { name: "You", color: presenceCursorColor() },
            }),
          ]
        : []),
    ],
    content: (initialContent as object) ?? {
      type: "doc",
      content: [{ type: "paragraph" }],
    },
    editorProps: {
      attributes: {
        class: "focus:outline-none",
        // Labels the editable block list for assistive tech (the element keeps
        // TipTap's default `role="textbox"`, so the description is announced).
        "aria-roledescription": t(locale, "editorRoleDescription"),
      },
      /**
       * Multi-block range selection (block-selection engine). Shift-click starts
       * or extends a whole-block range; a modifier-click on an active range
       * toggles an endpoint; a plain click clears it and falls through to the
       * stock text selection.
       */
      handleDOMEvents: {
        mousedown(view, event) {
          const mouse = event as MouseEvent;
          // The space under the content is still the page: a click there starts a
          // paragraph at the end instead of landing in the last block.
          if (clickUnderContent(view, mouse)) return true;
          const active = blockRangeRef.current;
          const toggling = active !== null && (mouse.metaKey || mouse.ctrlKey);
          if (!mouse.shiftKey && !toggling) {
            if (active) paintBlockRange(null);
            return false;
          }
          const found = view.posAtCoords({ left: mouse.clientX, top: mouse.clientY });
          const targetId = found ? blockIdAt(view.state.doc, found.pos) : null;
          if (targetId === null) return false;
          paintBlockRange(
            shiftSelect(active, {
              focusId: targetId,
              shift: mouse.shiftKey,
              meta: mouse.metaKey || mouse.ctrlKey,
            }),
          );
          mouse.preventDefault();
          return true;
        },
        // To-do tick: a task checkbox just changed — play the check draw and
        // the strikethrough fade (DESIGN_SYSTEM §6, FRONTEND_PLAN 19.9).
        // Presentation only; the document update itself is untouched.
        change(_view, event) {
          const target = event.target;
          if (target instanceof HTMLInputElement && target.type === "checkbox") {
            animateTaskTick(target);
          }
          return false;
        },
        // Invalid-drop rejection: while a handle drag is live, decide on every
        // dragover whether the block under the pointer may receive it. A refusal
        // paints the danger-tinted indicator; moving onto a valid target clears
        // it. Presentation only — the drop itself is untouched, so returning
        // false keeps ProseMirror's own drop handling intact.
        dragover(view, event) {
          const draggingId = draggingIdRef.current;
          const drag = view.dragging as { node?: { from: number } } | null;
          if (!draggingId || !drag) return false;
          const dragEvent = event as DragEvent;
          const found = view.posAtCoords({
            left: dragEvent.clientX,
            top: dragEvent.clientY,
          });
          const targetId = found ? blockIdAt(view.state.doc, found.pos) : null;
          const verdict = dropVerdict({
            draggingId,
            targetId,
            descendants: draggingDescendantsRef.current,
          });
          if (verdict.valid) {
            if (dropRejectionKeyRef.current !== "") {
              dropRejectionKeyRef.current = "";
              setDropRejection(null);
            }
            return false;
          }
          const key = `${verdict.reason}:${targetId ?? ""}`;
          if (dropRejectionKeyRef.current !== key) {
            dropRejectionKeyRef.current = key;
            setDropRejection({ x: dragEvent.clientX, y: dragEvent.clientY });
          }
          return false;
        },
      },
      /**
       * Keyboard path for the same range (R84.10 a11y): only once a range is
       * active, Shift-ArrowUp/Down moves its head block by block, Escape clears
       * it and Backspace/Delete removes every selected block in one transaction.
       * Without an active range every key falls through to normal editing.
       */
      handleKeyDown(view, event) {
        const range = blockRangeRef.current;
        if (!range) return false;
        if (event.key === "Escape") {
          paintBlockRange(null);
          return true;
        }
        if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          const ids = topLevelBlockIds(view.state.doc);
          if (ids.length === 0) return false;
          const headIndex = ids.indexOf(range.headId);
          const step = event.key === "ArrowDown" ? 1 : -1;
          const nextIndex = Math.max(
            0,
            Math.min(ids.length - 1, (headIndex < 0 ? 0 : headIndex) + step),
          );
          paintBlockRange(extendSelection(ids, range, { extendId: ids[nextIndex] }));
          event.preventDefault();
          return true;
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          const plan = deletePlan(range, topLevelBlockIds(view.state.doc));
          if (plan.removed.length > 1) {
            deleteBlocksByIds(view, plan.removed);
            paintBlockRange(null);
            event.preventDefault();
            return true;
          }
        }
        return false;
      },
      handlePaste(view, event) {
        const clipboard = event.clipboardData;
        if (!clipboard) return false;

        // Clipboard images: gate every real file and any `data:` image embedded
        // in the HTML flavour through the clipboard-image engine before upload.
        const files = Array.from(clipboard.files ?? []);
        const html = clipboard.getData("text/html");
        const imagePlan = planClipboardImages({
          files: files.map((file) => ({
            name: file.name,
            mimeType: file.type,
            size: file.size,
          })),
          html,
        });
        if (files.length > 0 || imagePlan.uploads.length > 0) {
          void uploadClipboardImages(imagePlan, files);
          return true;
        }

        if (!html) return false;
        // Route the HTML through the paste-cleanup engine (source fingerprint +
        // allowlist sanitiser) before the block normaliser sees it.
        const normalized = normalizePasteHtml(cleanClipboardHtml(html).html);
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
        const dragging = view.dragging as {
          slice: Slice;
          move: boolean;
          node?: { from: number };
        } | null;
        // A multi-block range (selected with shift-click) moves as a whole
        // through the block-move engine, before the single-block indent path.
        const range = blockRangeRef.current;
        const draggedId = dragging?.node ? blockIdAt(view.state.doc, dragging.node.from) : null;
        if (moved && range && draggedId !== null) {
          const ids = topLevelBlockIds(view.state.doc);
          const selected = resolveRange(ids, range);
          if (selected.includes(draggedId) && selected.length > 1) {
            const target = view.posAtCoords({ left: event.clientX, top: event.clientY });
            const targetId = target ? blockIdAt(view.state.doc, target.pos) : null;
            const targetIndex = targetId === null ? ids.length : ids.indexOf(targetId);
            const order = planBlockReorder(ids, range, targetIndex);
            if (order) {
              reorderTopLevelBlocks(view, order);
              paintBlockRange(null);
              event.preventDefault();
              return true;
            }
          }
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
      // Any content change invalidates the whole-block range (ids may be gone).
      if (blockRangeRef.current) paintBlockRange(null);
      // Block-reference integrity: a reference whose target block is gone is
      // surfaced so a broken transclusion is visible rather than silent.
      const broken = brokenBlockReferences(e.state.doc).length;
      setBrokenRefs((prev) => (prev === broken ? prev : broken));
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Mirror each top-level block's stable id onto `data-flip-id`, and feed the
  // ordered ids to the shared FLIP hook. The mirror runs synchronously in the
  // transaction handler — before React commits — so when the hook measures, the
  // elements already carry the marker. The hook's deps are the *structure* (the
  // ordered ids), never the content, so a keystroke cannot trigger motion under
  // a caret; only insert / delete / reorder / re-indent does (DESIGN_SYSTEM §6).
  useLayoutEffect(() => {
    if (!editor) return;
    const sync = () => {
      const root = editor.view.dom;
      for (const child of Array.from(root.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const blockId = child.getAttribute("data-block-id");
        if (blockId) child.setAttribute("data-flip-id", blockId);
        else child.removeAttribute("data-flip-id");
      }
      const order = topLevelBlockIds(editor.state.doc)
        .filter((id) => id !== "")
        .join("\u0000");
      setFlipOrder((prev) => (prev === order ? prev : order));
    };
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);

  // FLIP the block list whenever its ordered ids change: inserting, deleting,
  // reordering or re-indenting a block slides its neighbours into place instead
  // of letting them jump. The hook itself stands down under reduced motion and
  // while `document.body.dataset.dragging` is set.
  useFlipList(listRef, [flipOrder, editor ? 1 : 0]);

  // The drag flag is what makes the FLIP hook stand down while the pointer owns
  // the block. Clear it on drop *and* on every abort path (Escape, pointercancel,
  // a native dragend outside the handle) so an aborted drag can never leave
  // layout animations — or the rejection indicator — stuck on.
  useEffect(() => {
    const clear = () => {
      setDraggingFlag(false);
      dropRejectionKeyRef.current = "";
      setDropRejection(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    document.addEventListener("dragend", clear);
    document.addEventListener("drop", clear);
    document.addEventListener("pointercancel", clear);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("dragend", clear);
      document.removeEventListener("drop", clear);
      document.removeEventListener("pointercancel", clear);
      document.removeEventListener("keydown", onKeyDown);
      clear();
    };
  }, [setDraggingFlag]);

  // Keyboard parity for the row chrome: keep the ⋮⋮ / + affordances visible
  // while the editor holds focus, not only on pointer hover (DESIGN_SYSTEM §9).
  useEffect(() => {
    if (!editor) return;
    const onFocus = () => setEditorFocused(true);
    const onBlur = () => setEditorFocused(false);
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    return () => {
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
    };
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

  // The bottom breathing room (30vh) belongs to the editable area itself — see
  // `.noema-page-canvas .ProseMirror` in globals.css — so a click in it is a click
  // in the document and `clickUnderContent` can start the paragraph there. The
  // caret at the end of a long page can still be scrolled up to the middle of the
  // viewport instead of staying pinned to the bottom edge.
  return (
    <div
      ref={listRef}
      className={`noema-editor noema-page-canvas relative ${dragActiveClass(dragging)}`.trim()}
      data-undo-depth={snapshotDepth.undoable}
      data-redo-depth={snapshotDepth.redoable}
      data-block-selected={blockSelected}
      data-dragging={dragging ? "true" : undefined}
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
            onNodeChange={({ node, pos }) => {
              chromePosRef.current = node ? pos : null;
              setChromeVisible(node !== null);
            }}
            onElementDragStart={(event) => {
              dragStartXRef.current = event.clientX;
              beginBlockDrag();
            }}
            onElementDragEnd={() => {
              dragStartXRef.current = null;
              endBlockDrag();
            }}
          >
            <EditorRowChrome
              state={{ hovered: chromeVisible, focused: editorFocused }}
            />
          </DragHandle>

          <HistoryControls editor={editor} locale={locale} />
          <SuggestionsControls editor={editor} locale={locale} />
        </>
      )}

      <BlockContextMenu editor={editor} editable={editable} workspaceId={workspaceId} locale={locale}>
        <EditorContent editor={editor} />
      </BlockContextMenu>

      {dropRejection && (
        <div
          data-invalid="true"
          role="status"
          aria-invalid
          aria-label={t(locale, "invalidDropTarget")}
          className="pointer-events-none fixed flex items-center gap-1 rounded-sm border border-danger bg-danger-soft px-1.5 py-0.5 text-xs font-medium text-danger"
          style={{ left: dropRejection.x, top: dropRejection.y, zIndex: Z.drag }}
        >
          <span aria-hidden="true">⊘</span>
          {t(locale, "invalidDropTarget")}
        </div>
      )}

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
                  className="-ml-1.5 grid h-6 w-6 place-items-center rounded-full border-2 border-bg text-3xs font-medium text-white first:ml-0"
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
                collabStatus === "connected" ? "bg-success" : "bg-warning"
              }`}
            />
            {t(locale, "liveWord")} · {peers}
          </span>
        )}
        {brokenRefs > 0 && (
          <span
            className="pointer-events-auto flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-danger"
            data-broken-refs={brokenRefs}
            title={t(locale, "somethingWentWrongDot")}
          >
            {t(locale, "linkedReferences")} · {brokenRefs}
          </span>
        )}
        {saveState === "saving" && t(locale, "saving")}
        {saveState === "saved" && t(locale, "savedWord")}
        {saveState === "error" && (
          <span className="pointer-events-auto flex items-center gap-1 text-danger">
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
