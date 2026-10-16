"use client";

import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Link2, Trash2 } from "lucide-react";
import type { RichNode } from "@/lib/blocks";
import { defaultBlockIdFactory } from "@/components/editor/extensions/block-ids";
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
      insertSyncedBlock: (attrs?: Record<string, unknown>) => ReturnType;
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
  const json: RichNode = { type: block.type };
  if (typeof block.id === "string" && block.id !== "") json.attrs = { id: block.id };
  if (Array.isArray(block.children) && block.children.length > 0) {
    json.content = block.children.map(syncBlockToPmJson);
  }
  return json;
}

/** A block that mirrors the canonical content of another block. */
export const SyncedBlock = Node.create<{ locale: string }>({
  name: "syncedBlock",
  group: "block",
  atom: true,
  draggable: true,

  addOptions() {
    return { locale: "en" };
  },

  addAttributes() {
    return {
      refId: { default: null },
      sourceBlockId: { default: null },
      sourcePageId: { default: null },
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
        (attrs = {}) =>
        ({ editor, commands }) => {
          const ref = syncedRefFromAttrs(attrs);
          if (!ref) return false;
          const instanceId =
            typeof attrs.instanceId === "string" && attrs.instanceId !== ""
              ? attrs.instanceId
              : defaultBlockIdFactory();
          const store = getStore(editor);
          const next = planRegisterSyncedInstance(store.state, attrs, { blockId: instanceId });
          if (next) store.state = next;
          const snapshot = syncedSnapshotFromAttrs(attrs);
          return commands.insertContent({
            type: this.name,
            attrs: {
              ...syncedAttrsFromRef(ref, snapshot ?? undefined, attrs.readOnly === true),
              instanceId,
            },
          });
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
            commands.insertContentAt(target.pos, syncBlockToPmJson(snapshot))
          );
        },
    };
  },

  addNodeView() {
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <SyncedBlockView {...props} locale={locale} />
    ));
  },
});

function SyncedBlockView({
  node,
  editor,
  getPos,
  deleteNode,
  locale,
}: NodeViewProps & { locale: string }) {
  const attrs = node.attrs as Record<string, unknown>;
  const marker = syncedMarkerProps(attrs);
  const content = resolveSyncedContent(attrs, pmDocToSyncBlocks(editor.state.doc));
  const preview = syncBlockText(content);

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
      snapshot: syncedSnapshotFromAttrs(attrs),
    });
  };

  return (
    <NodeViewWrapper className="noema-synced-block" data-synced-block="">
      <div className="noema-synced-card" contentEditable={false}>
        {marker && (
          <a
            className="noema-synced-marker"
            data-source-block={marker.sourceBlockId}
            data-read-only={marker.readOnly ? "true" : "false"}
            href={marker.href}
          >
            <Link2 className="h-3.5 w-3.5" /> {marker.label}
          </a>
        )}
        <div className="noema-synced-body">
          {preview !== "" ? preview : t(locale, "nothingToWorkWith")}
        </div>
        <button
          type="button"
          aria-label={t(locale, "remove")}
          className="noema-synced-detach"
          onClick={detach}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </NodeViewWrapper>
  );
}
