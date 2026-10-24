"use client";

import { useEffect, useRef, useState } from "react";
import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Link2, RefreshCw, Trash2 } from "lucide-react";
import type { RichNode } from "@/lib/blocks";
import { DocRenderer } from "@/components/doc-renderer";
import { defaultBlockIdFactory } from "@/components/editor/extensions/block-ids";
import { guarded } from "@/lib/actions-client";
import { buildBlockDeepLink } from "@/lib/deep-links";
import { getPageContentAction as rawGetPageContentAction } from "@/server/actions/pages";
import {
  createSyncRef,
  createSyncedBlockState,
  detachInstance,
  findSource,
  isSource,
  propagateEdit,
  registerInstance,
  resolveSync,
  sourceMarker,
  type DetachResult,
  type PropagateResult,
  type SourceMarker,
  type SyncBlock,
  type SyncedBlockState,
  type SyncedRef,
} from "@/lib/synced-blocks";
import { t } from "@/lib/i18n";

const getPageContentAction = guarded(rawGetPageContentAction);

/**
 * Synced-block editor node. The pure brain lives in `src/lib/synced-blocks.ts`;
 * this file is the thin TipTap adapter that persists a `SyncedRef` on a node and
 * mirrors the canonical source content into it.
 *
 * The engine seam is deliberately pure and exported so it can be exercised
 * without a browser: {@link pmDocToSyncBlocks} lifts the live document into the
 * engine's generic `SyncBlock` tree, {@link resolveSyncedContent} resolves the
 * canonical content through `resolveSync`, {@link syncedMarkerProps} renders the
 * "synced from" marker via `sourceMarker`, and the `plan*` helpers wrap
 * `registerInstance` / `propagateEdit` / `detachInstance`.
 */

/** A live editor's synced-block world. */
type SyncedBlockStorage = { state: SyncedBlockState };

declare module "@tiptap/core" {
  interface Storage {
    syncedBlock: SyncedBlockStorage;
  }
  interface Commands<ReturnType> {
    syncedBlock: {
      insertSyncedBlock: (
        attrs?: Record<string, unknown>,
        placement?: { at?: number; replace?: boolean },
      ) => ReturnType;
      registerSyncedInstance: (
        attrs: Record<string, unknown>,
        placement: { blockId: string; pageId?: string },
      ) => ReturnType;
      propagateSyncedEdit: (edit: { refId: string; newContent: unknown }) => ReturnType;
      detachSyncedBlock: (target: {
        refId: string;
        instanceId: string;
        pos: number;
        snapshot?: SyncBlock | null;
      }) => ReturnType;
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStore(editor: Editor): SyncedBlockStorage {
  return editor.storage.syncedBlock as SyncedBlockStorage;
}

/** Read the durable ref the node carries, or `null` when the source is blank. */
export function syncedRefFromAttrs(attrs: Record<string, unknown>): SyncedRef | null {
  const sourceBlockId = typeof attrs.sourceBlockId === "string" ? attrs.sourceBlockId : "";
  const sourcePageId = typeof attrs.sourcePageId === "string" ? attrs.sourcePageId : "";
  if (sourceBlockId.trim() === "" || sourcePageId.trim() === "") return null;
  const refId = typeof attrs.refId === "string" ? attrs.refId : "";
  try {
    return createSyncRef({
      sourceBlockId,
      sourcePageId,
      ...(refId.trim() === "" ? {} : { refId }),
    });
  } catch {
    return null;
  }
}

/** Project a ref (plus an optional content snapshot) onto node attributes. */
export function syncedAttrsFromRef(
  ref: SyncedRef,
  content?: unknown,
  readOnly: boolean = false,
): Record<string, unknown> {
  return {
    refId: ref.refId,
    sourceBlockId: ref.sourceBlockId,
    sourcePageId: ref.sourcePageId,
    content: content === undefined ? "" : JSON.stringify(content),
    readOnly,
  };
}

/**
 * Lift one ProseMirror node into the engine's generic tree. Text nodes carry
 * their `text`; every other node carries its type, its persisted id and its
 * children. Unknown fields are the engine's problem, not this adapter's.
 */
export function pmNodeToSyncBlock(node: PMNode): SyncBlock {
  if (node.isText) {
    return { id: "", type: "text", text: node.text ?? "" };
  }
  const id = typeof node.attrs?.id === "string" ? node.attrs.id : "";
  const children: SyncBlock[] = [];
  node.forEach((child) => {
    children.push(pmNodeToSyncBlock(child));
  });
  const block: SyncBlock = { id, type: node.type.name };
  if (children.length > 0) block.children = children;
  return block;
}

/** Lift a whole ProseMirror document into the engine's `SyncBlock[]`. */
export function pmDocToSyncBlocks(doc: PMNode): SyncBlock[] {
  const blocks: SyncBlock[] = [];
  doc.forEach((node) => {
    blocks.push(pmNodeToSyncBlock(node));
  });
  return blocks;
}

/** Parse the node's stored content snapshot, or `null` when absent/malformed. */
export function syncedSnapshotFromAttrs(attrs: Record<string, unknown>): SyncBlock | null {
  const raw = attrs.content;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) && typeof parsed.type === "string" ? (parsed as SyncBlock) : null;
  } catch {
    return null;
  }
}

/**
 * The canonical content the node renders: the live document resolved through
 * `resolveSync` when a document is supplied, else the stored snapshot.
 */
export function resolveSyncedContent(
  attrs: Record<string, unknown>,
  doc?: readonly SyncBlock[],
): SyncBlock | null {
  const ref = syncedRefFromAttrs(attrs);
  if (ref && doc) {
    const found = resolveSync(ref, doc);
    if (found) return found;
  }
  return syncedSnapshotFromAttrs(attrs);
}

/** The "synced from" marker for a node, or `null` without a usable source. */
export function syncedMarkerProps(
  attrs: Record<string, unknown>,
  options: { readOnly?: boolean } = {},
): SourceMarker | null {
  const ref = syncedRefFromAttrs(attrs);
  if (!ref) return null;
  return sourceMarker(ref, { readOnly: options.readOnly ?? attrs.readOnly === true });
}

/** Whether a node's canonical source is `sourceBlockId` (via `isSource`). */
export function syncedNodeTargetsSource(
  attrs: Record<string, unknown>,
  sourceBlockId: string,
): boolean {
  const ref = syncedRefFromAttrs(attrs);
  return ref !== null && isSource(sourceBlockId, ref);
}

/** Register one node placement as an instance, returning the new state. */
export function planRegisterSyncedInstance(
  state: SyncedBlockState,
  attrs: Record<string, unknown>,
  placement: { blockId: string; pageId?: string },
): SyncedBlockState | null {
  const ref = syncedRefFromAttrs(attrs);
  if (!ref) return null;
  try {
    return registerInstance(state, ref, {
      blockId: placement.blockId,
      pageId: placement.pageId ?? ref.sourcePageId,
      attrs: {},
    });
  } catch {
    return null;
  }
}

/** Plan the per-instance updates for a canonical edit (`propagateEdit`). */
export function planSyncedPropagation(
  state: SyncedBlockState,
  refId: string,
  newContent: unknown,
): PropagateResult {
  return propagateEdit(state, { refId, newContent });
}

/** Plan the unlink of one instance, handing back the content snapshot. */
export function planSyncedDetach(
  state: SyncedBlockState,
  target: { refId: string; instanceId: string },
): DetachResult {
  return detachInstance(state, target);
}

/** The ref a node's instance currently mirrors (via `findSource`). */
export function syncedSourceOfInstance(
  state: SyncedBlockState,
  attrs: Record<string, unknown>,
): SyncedRef | null {
  const instanceId = typeof attrs.instanceId === "string" ? attrs.instanceId : "";
  if (instanceId === "") return null;
  return findSource(state, instanceId);
}

/** Total plain text of a `SyncBlock` subtree, for the read-only preview. */
export function syncBlockText(block: SyncBlock | null): string {
  if (!block) return "";
  const own = typeof block.text === "string" ? block.text : "";
  const children = Array.isArray(block.children) ? block.children : [];
  return [own, ...children.map(syncBlockText)].filter((part) => part !== "").join(" ");
}

/** Convert a `SyncBlock` snapshot back into TipTap/ProseMirror JSON. */
export function syncBlockToPmJson(block: SyncBlock): RichNode {
  if (block.type === "text") {
    return { type: "text", text: typeof block.text === "string" ? block.text : "" };
  }
  // A snapshot captured from a live editor is already ProseMirror JSON. Keep
  // its attrs/marks/content verbatim instead of flattening it into a bare node.
  const raw = block as unknown as {
    attrs?: unknown;
    content?: unknown;
    marks?: unknown;
  };
  if (
    raw.attrs !== undefined ||
    raw.marks !== undefined ||
    Array.isArray(raw.content)
  ) {
    return block as unknown as RichNode;
  }
  const json: RichNode = { type: block.type };
  if (typeof block.id === "string" && block.id !== "") json.attrs = { id: block.id };
  if (Array.isArray(block.children) && block.children.length > 0) {
    json.content = block.children.map(syncBlockToPmJson);
  } else if (typeof block.text === "string" && block.text !== "") {
    json.content = [{ type: "text", text: block.text }];
  }
  return json;
}

/** Wrap a snapshot into the root document `DocRenderer` expects. */
export function syncSnapshotDoc(block: SyncBlock | null): { type: "doc"; content: RichNode[] } | null {
  if (!block) return null;
  return { type: "doc", content: [syncBlockToPmJson(block)] };
}

/**
 * Deep-clone a detached snapshot with fresh block ids, so the unlinked copy
 * cannot collide with its former source (or with another mirror).
 */
export function detachedSnapshotJson(block: RichNode): RichNode {
  const clone = JSON.parse(JSON.stringify(block)) as RichNode;
  const walk = (node: unknown): void => {
    if (!isRecord(node)) return;
    const attrs = isRecord(node.attrs) ? node.attrs : null;
    if (attrs && typeof attrs.id === "string" && attrs.id !== "") {
      attrs.id = defaultBlockIdFactory();
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
  };
  walk(clone);
  return clone;
}

/** Find a node carrying `blockId` anywhere in the live document. */
export function findBlockNodeById(doc: PMNode, blockId: string): PMNode | null {
  const wanted = typeof blockId === "string" ? blockId.trim() : "";
  if (wanted === "") return null;
  let found: PMNode | null = null;
  doc.descendants((node) => {
    if (found) return false;
    if (typeof node.attrs?.id === "string" && node.attrs.id === wanted) {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}

/** Find a block by id in a stored ProseMirror JSON document (cross-page). */
export function findBlockJsonById(content: unknown, blockId: string): RichNode | null {
  const wanted = typeof blockId === "string" ? blockId.trim() : "";
  if (wanted === "") return null;
  const root = content as { content?: unknown } | null;
  if (!root || !Array.isArray(root.content)) return null;
  const walk = (node: unknown): RichNode | null => {
    if (!isRecord(node)) return null;
    const attrs = isRecord(node.attrs) ? node.attrs : null;
    if (attrs && attrs.id === wanted && typeof node.type === "string") {
      return node as RichNode;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        const found = walk(child);
        if (found) return found;
      }
    }
    return null;
  };
  for (const node of root.content) {
    const found = walk(node);
    if (found) return found;
  }
  return null;
}

/** One mirror whose stored snapshot no longer matches its same-page source. */
export type SyncedMirrorUpdate = {
  pos: number;
  sourceBlockId: string;
  content: string;
};

/**
 * Find every mirror in `doc` whose source exists in the same document and whose
 * stored snapshot is stale. Pure so the editor plugin and the node tests share
 * one propagation rule; the caller applies `content` with `setNodeMarkup`.
 *
 * A `syncedBlock` is never treated as a source (that would mirror a mirror and
 * can create a feedback loop).
 */
export function collectSyncedMirrorUpdates(doc: PMNode): SyncedMirrorUpdate[] {
  const sources = new Map<string, PMNode>();
  doc.descendants((node) => {
    if (node.type.name === "syncedBlock") return true;
    const id = typeof node.attrs?.id === "string" ? node.attrs.id.trim() : "";
    if (id !== "" && !sources.has(id)) sources.set(id, node);
    return true;
  });
  if (sources.size === 0) return [];

  const updates: SyncedMirrorUpdate[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "syncedBlock") return true;
    const sourceBlockId =
      typeof node.attrs?.sourceBlockId === "string" ? node.attrs.sourceBlockId.trim() : "";
    const source = sources.get(sourceBlockId);
    if (!source) return true;
    const content = JSON.stringify(source.toJSON());
    if (node.attrs?.content !== content) {
      updates.push({ pos, sourceBlockId, content });
    }
    return true;
  });
  return updates;
}

/** A block that mirrors the canonical content of another block. */
export const SyncedBlock = Node.create<{
  locale: string;
  pageId: string;
  workspaceSlug: string;
}>({
  name: "syncedBlock",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { locale: "en", pageId: "", workspaceSlug: "" };
  },

  addAttributes() {
    return {
      refId: { default: null },
      sourceBlockId: { default: null },
      sourcePageId: { default: null },
      sourcePageTitle: { default: null },
      // Persisted snapshot of the canonical content so an offline editor can
      // still render something before `resolveSync` has a live document.
      content: { default: "" },
      readOnly: { default: false },
      instanceId: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-synced-block]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-synced-block": "" })];
  },

  addStorage(): SyncedBlockStorage {
    return { state: createSyncedBlockState() };
  },

  addCommands() {
    return {
      insertSyncedBlock:
        (attrs = {}, placement = {}) =>
        ({ editor, commands }) => {
          let sourceAttrs = attrs;
          let snapshot: SyncBlock | null = null;
          let replaceRange: { from: number; to: number } | null = null;

          if (!syncedRefFromAttrs(sourceAttrs)) {
            // Slash-menu path: mirror the block immediately before the current
            // (now empty) paragraph. The menu deletes the `/query` text first.
            const { $from } = editor.state.selection;
            const depth = $from.depth;
            if (depth < 1) return false;
            const index = $from.index(depth - 1);
            if (index <= 0) return false;
            const previous = $from.node(depth - 1).child(index - 1);
            if (previous.type.name === "syncedBlock") {
              sourceAttrs = { ...previous.attrs };
              delete sourceAttrs.instanceId;
            } else {
              const sourceBlockId =
                typeof previous.attrs?.id === "string" ? previous.attrs.id : "";
              if (sourceBlockId === "") return false;
              snapshot = previous.toJSON() as unknown as SyncBlock;
              sourceAttrs = {
                sourceBlockId,
                sourcePageId: this.options.pageId,
                content: JSON.stringify(snapshot),
              };
            }
            replaceRange = { from: $from.before(depth), to: $from.after(depth) };
          }

          if (
            typeof sourceAttrs.sourcePageId !== "string" ||
            sourceAttrs.sourcePageId.trim() === ""
          ) {
            sourceAttrs = { ...sourceAttrs, sourcePageId: this.options.pageId };
          }
          const ref = syncedRefFromAttrs(sourceAttrs);
          if (!ref) return false;
          const instanceId =
            typeof sourceAttrs.instanceId === "string" && sourceAttrs.instanceId !== ""
              ? sourceAttrs.instanceId
              : defaultBlockIdFactory();
          const finalAttrs: Record<string, unknown> = {
            ...syncedAttrsFromRef(
              ref,
              snapshot ?? syncedSnapshotFromAttrs(sourceAttrs) ?? undefined,
              sourceAttrs.readOnly === true,
            ),
            sourcePageTitle:
              typeof sourceAttrs.sourcePageTitle === "string"
                ? sourceAttrs.sourcePageTitle
                : null,
            instanceId,
          };
          const store = getStore(editor);
          const next = planRegisterSyncedInstance(store.state, finalAttrs, {
            blockId: instanceId,
            pageId: this.options.pageId,
          });
          if (next) store.state = next;

          const nodeJson = { type: this.name, attrs: finalAttrs };
          if (placement.at !== undefined) {
            return commands.insertContentAt(placement.at, nodeJson);
          }
          if (placement.replace !== false && replaceRange) {
            return commands.insertContentAt(replaceRange, nodeJson);
          }
          return commands.insertContent(nodeJson);
        },

      registerSyncedInstance:
        (attrs, placement) =>
        ({ editor }) => {
          const next = planRegisterSyncedInstance(getStore(editor).state, attrs, placement);
          if (!next) return false;
          getStore(editor).state = next;
          return true;
        },

      propagateSyncedEdit:
        ({ refId, newContent }) =>
        ({ editor }) => {
          const result = planSyncedPropagation(getStore(editor).state, refId, newContent);
          getStore(editor).state = result.state;
          return result.count > 0;
        },

      detachSyncedBlock:
        (target) =>
        ({ editor, commands }) => {
          const result = planSyncedDetach(getStore(editor).state, {
            refId: target.refId,
            instanceId: target.instanceId,
          });
          getStore(editor).state = result.state;
          if (!result.detached) return false;
          const node = editor.state.doc.nodeAt(target.pos);
          if (!node) return false;
          const snapshot =
            (result.snapshot as SyncBlock | null) ?? target.snapshot ?? null;
          if (!snapshot) {
            return commands.deleteRange({ from: target.pos, to: target.pos + node.nodeSize });
          }
          return (
            commands.deleteRange({ from: target.pos, to: target.pos + node.nodeSize }) &&
            commands.insertContentAt(
              target.pos,
              detachedSnapshotJson(syncBlockToPmJson(snapshot)),
            )
          );
        },
    };
  },

  addProseMirrorPlugins() {
    const pageId = this.options.pageId;
    return [
      new Plugin({
        key: new PluginKey("syncedBlockMirrors"),
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const updates = collectSyncedMirrorUpdates(newState.doc);
          if (updates.length === 0) return null;
          const tr = newState.tr;
          for (const update of updates) {
            const node = newState.doc.nodeAt(update.pos);
            if (!node || node.type.name !== "syncedBlock") continue;
            if (
              typeof node.attrs.sourcePageId === "string" &&
              node.attrs.sourcePageId !== "" &&
              node.attrs.sourcePageId !== pageId
            ) {
              continue;
            }
            tr.setNodeMarkup(update.pos, undefined, {
              ...node.attrs,
              content: update.content,
            });
          }
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },

  addNodeView() {
    const options = this.options;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <SyncedBlockView {...props} options={options} />
    ));
  },
});

function SyncedBlockView({
  node,
  editor,
  getPos,
  updateAttributes,
  deleteNode,
  options,
}: NodeViewProps & {
  options: { locale: string; pageId: string; workspaceSlug: string };
}) {
  const { locale, pageId, workspaceSlug } = options;
  const attrs = node.attrs as Record<string, unknown>;
  const sourcePageId =
    typeof attrs.sourcePageId === "string" ? attrs.sourcePageId : "";
  const sourceBlockId =
    typeof attrs.sourceBlockId === "string" ? attrs.sourceBlockId : "";
  const samePage = sourcePageId !== "" && sourcePageId === pageId;
  const [remote, setRemote] = useState<{
    block: SyncBlock | null;
    title: string | null;
    error: string | null;
  }>({ block: null, title: null, error: null });
  const [loading, setLoading] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const updateAttributesRef = useRef(updateAttributes);
  updateAttributesRef.current = updateAttributes;

  useEffect(() => {
    if (samePage || sourcePageId === "" || sourceBlockId === "") return;
    let cancelled = false;
    setLoading(true);
    getPageContentAction(sourcePageId)
      .then((result) => {
        if (cancelled) return;
        if ("error" in result) {
          setRemote((previous) => ({ ...previous, error: result.error }));
          return;
        }
        const found = findBlockJsonById(result.content, sourceBlockId);
        setRemote({
          block: found ? (found as unknown as SyncBlock) : null,
          title: result.title,
          error: found ? null : t(locale, "syncedSourceMissing"),
        });
        if (found) {
          updateAttributesRef.current({
            content: JSON.stringify(found),
            sourcePageTitle: result.title,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locale, refreshToken, samePage, sourceBlockId, sourcePageId]);

  const live = samePage ? findBlockNodeById(editor.state.doc, sourceBlockId) : null;
  const snapshot =
    (live ? (live.toJSON() as unknown as SyncBlock) : null) ??
    remote.block ??
    syncedSnapshotFromAttrs(attrs);
  const doc = syncSnapshotDoc(snapshot);
  const marker = syncedMarkerProps(attrs);
  const sourceTitle =
    samePage
      ? null
      : remote.title ??
        (typeof attrs.sourcePageTitle === "string" ? attrs.sourcePageTitle : null);
  const label = samePage
    ? t(locale, "syncedFromThisPage")
    : sourceTitle
      ? `${t(locale, "syncedFrom")} ${sourceTitle}`
      : t(locale, "syncedFromAnotherPage");
  const href =
    sourcePageId !== ""
      ? buildBlockDeepLink(sourcePageId, sourceBlockId, { workspaceSlug })
      : marker?.href;
  const broken =
    (samePage && live === null && snapshot !== null) ||
    (!samePage && remote.error !== null);

  const detach = () => {
    const ref = syncedRefFromAttrs(attrs);
    const pos = getPos();
    const instanceId =
      typeof attrs.instanceId === "string" && attrs.instanceId !== "" ? attrs.instanceId : null;
    if (!ref || instanceId === null || typeof pos !== "number") {
      deleteNode();
      return;
    }
    editor.commands.detachSyncedBlock({
      refId: ref.refId,
      instanceId,
      pos,
      snapshot,
    });
  };

  return (
    <NodeViewWrapper
      className="my-2"
      data-synced-block=""
      data-source-broken={broken ? "true" : undefined}
    >
      <div
        className="overflow-hidden rounded-card border border-border bg-surface-2/40"
        contentEditable={false}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <Link2 className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
            {href ? (
              <a
                className="focus-ring min-w-0 truncate rounded-control text-xs text-muted hover:text-fg"
                data-source-block={sourceBlockId}
                data-read-only={marker?.readOnly ? "true" : "false"}
                href={href}
                title={`${label} · ${t(locale, "syncedOpenSource")}`}
              >
                {label}
              </a>
            ) : (
              <span className="min-w-0 truncate text-xs text-muted">{label}</span>
            )}
            <span className="shrink-0 rounded-chip bg-surface-2 px-1.5 py-0.5 text-3xs font-medium tracking-wide text-muted uppercase">
              {t(locale, "syncedBadge")}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!samePage && sourcePageId !== "" ? (
              <button
                type="button"
                aria-label={t(locale, "refreshSyncedBlock")}
                title={t(locale, "refreshSyncedBlock")}
                className="focus-ring u-interactive rounded-control p-1 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                disabled={loading}
                onClick={() => setRefreshToken((value) => value + 1)}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={t(locale, "detachSyncedBlock")}
              title={t(locale, "detachSyncedBlock")}
              className="focus-ring u-interactive rounded-control p-1 text-muted hover:bg-surface-2 hover:text-fg"
              onClick={detach}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="px-3 py-2 text-sm">
          {doc ? (
            <DocRenderer doc={doc} locale={locale} workspaceSlug={workspaceSlug} />
          ) : (
            <p className="text-sm text-muted">
              {loading ? t(locale, "loading") : t(locale, "syncedContentUnavailable")}
            </p>
          )}
          {broken ? (
            <p role="status" className="mt-2 text-3xs text-muted">
              {samePage ? t(locale, "syncedSourceMissing") : remote.error}
            </p>
          ) : null}
        </div>
      </div>
    </NodeViewWrapper>
  );
}
