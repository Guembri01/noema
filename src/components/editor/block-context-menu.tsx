"use client";

import { Fragment, useCallback, useState, useTransition, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Link2,
  ListOrdered,
  MessageSquare,
  Palette,
  Sigma,
  Sparkles,
  Trash2,
  Type,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PromptDialog } from "@/components/prompt-dialog";
import { AI_SKILLS, type AiSkillId } from "@/lib/ai-skills";
import { runAiSkill } from "@/lib/ai-client";
import { COMMENT_EVENT } from "@/components/comment-panel";
import { EQUATION_EVENT } from "@/components/editor/equation-editor";
import {
  BLOCK_COLORS,
  BLOCK_COLOR_TYPES,
} from "@/components/editor/extensions/block-colors";
import {
  canUndoViaHistory,
  restoreBlockDeletion,
  snapshotBlockDeletion,
  type BlockDeletion,
  type BlockDoc,
} from "@/lib/blocks";
import { formatCaption, validateCaption } from "@/lib/code-block";
import { buildBlockDeepLink } from "@/lib/deep-links";
import { t } from "@/lib/i18n";
import {
  CONVERSION_GROUPS,
  allowedTargets,
  convertBlock,
  type BlockAttrs,
  type BlockType,
  type ConvertibleBlock,
} from "@/lib/block-conversion";

type I18nKey = Parameters<typeof t>[1];

/** Maps the shared palette labels in `extensions/block-colors.ts` to keys. */
const COLOR_KEYS: Record<string, I18nKey> = {
  Default: "colorDefault",
  Gray: "colorGray",
  Brown: "colorBrown",
  Orange: "colorOrange",
  Yellow: "colorYellow",
  Green: "colorGreen",
  Blue: "colorBlue",
  Purple: "colorPurple",
  Pink: "colorPink",
  Red: "colorRed",
};

const TEXT_COLORS: { labelKey: I18nKey; value: string | null }[] = [
  { labelKey: "colorDefault", value: null },
  { labelKey: "colorGray", value: "#787774" },
  { labelKey: "colorBrown", value: "#9f6b53" },
  { labelKey: "colorOrange", value: "#d9730d" },
  { labelKey: "colorYellow", value: "#cb912f" },
  { labelKey: "colorGreen", value: "#448361" },
  { labelKey: "colorBlue", value: "#337ea9" },
  { labelKey: "colorPurple", value: "#9065b0" },
  { labelKey: "colorPink", value: "#c14c8a" },
  { labelKey: "colorRed", value: "#d44c47" },
];

const BLOCK_SELECTOR =
  "p, h1, h2, h3, h4, h5, h6, pre, blockquote, li, [data-callout], .noema-toggle";

/**
 * Percent-decode a URL path segment, falling back to the raw text when the
 * escape is malformed (`"100%"`) — mirrors `deep-links.ts`'s decoder so the
 * builder re-encodes a clean value instead of double-encoding `window.location`.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The `#<blockId>` anchor `buildBlockDeepLink` should use for the block at
 * `at`. `BlockIds` stamps an id on top-level blocks only (`block-ids.ts`), so
 * the node under the pointer is id-less for a nested node (a list item, a
 * callout paragraph); climb to the nearest top-level ancestor instead and
 * return `undefined` when none carries one, leaving the page-link fallback to
 * the caller.
 */
function blockAnchorId(doc: Editor["state"]["doc"], at: number): string | undefined {
  const readId = (node: { attrs?: { id?: unknown } } | null | undefined): string | undefined => {
    const id = node?.attrs?.id;
    return typeof id === "string" && id.trim() !== "" ? id : undefined;
  };
  const $pos = doc.resolve(at);
  // A top-level block's start resolves at doc level (depth 0) — `nodeAt` reads
  // it there; a nested block resolves inside its ancestor, and `node(1)` is the
  // top-level node that wraps it.
  const node = $pos.depth >= 1 ? $pos.node(1) : doc.nodeAt(at);
  return readId(node);
}

/**
 * "Turn into" targets. The pure graph in `@/lib/block-conversion` owns the
 * canonical block list, the menu sections (`CONVERSION_GROUPS`) and the
 * target-attribute mapping (`convertBlock`); this file only adapts a
 * ProseMirror node to that model and routes the result to editor commands.
 */

/** Graph type ⇄ editor node name. Headings carry a `level` instead of a name. */
function blockTypeOfNode(name: string, attrs: Record<string, unknown>): BlockType | null {
  switch (name) {
    case "paragraph":
      return "paragraph";
    case "heading": {
      const level = Number(attrs.level);
      return level === 1 ? "h1" : level === 2 ? "h2" : level === 3 ? "h3" : null;
    }
    case "bulletList":
      return "bulletedList";
    case "orderedList":
      return "numberedList";
    case "taskList":
      return "todoList";
    case "toggle":
      return "toggle";
    case "blockquote":
      return "quote";
    case "callout":
      return "callout";
    case "codeBlock":
      return "code";
    default:
      return null;
  }
}

/** Project a node's type + attrs into the shape {@link convertBlock} reads. */
function toConvertible(name: string, attrs: Record<string, unknown>): ConvertibleBlock {
  const blockAttrs: BlockAttrs = {};
  const level = Number(attrs.level);
  if (Number.isInteger(level) && level > 0) blockAttrs.level = level;
  if (typeof attrs.checked === "boolean") blockAttrs.checked = attrs.checked;
  if (typeof attrs.language === "string") blockAttrs.language = attrs.language;
  if (typeof attrs.emoji === "string") blockAttrs.emoji = attrs.emoji;
  if (typeof attrs.open === "boolean") blockAttrs.open = attrs.open;
  // Only the *target* decides which attributes survive, and the editor command
  // preserves the inline content, so a source the graph does not name (h4–h6)
  // safely falls back to `paragraph` without changing the outcome.
  return { type: blockTypeOfNode(name, attrs) ?? "paragraph", attrs: blockAttrs };
}

/**
 * i18n label for each convertible target. `pullQuote` is deliberately unmapped:
 * the editor has no pull-quote node yet (`@/lib/pull-quote` is only a data
 * model), so offering it would silently no-op. It returns to the menu once the
 * node and its label land.
 */
const TURN_TARGET_LABELS: Partial<Record<BlockType, I18nKey>> = {
  paragraph: "blockText",
  h1: "blockHeading1",
  h2: "blockHeading2",
  h3: "blockHeading3",
  bulletedList: "blockBulletedList",
  numberedList: "blockNumberedList",
  todoList: "blockTodoList",
  toggle: "blockToggleList",
  quote: "blockQuote",
  callout: "blockCallout",
  code: "code",
};

/** Every graph type in canonical menu order (the union of `CONVERSION_GROUPS`). */
const ALL_TARGET_TYPES: readonly BlockType[] = CONVERSION_GROUPS.flatMap((group) => group.types);

/**
 * Notion-style block menu: right-click anywhere in the editor to act on the
 * block under the pointer (turn into, duplicate, move, colour, comment, AI).
 */
export function BlockContextMenu({
  editor,
  editable,
  workspaceId,
  locale = "en",
  children,
}: {
  editor: Editor;
  editable: boolean;
  workspaceId?: string;
  locale?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const [pos, setPos] = useState<number | null>(null);
  const [captionOpen, setCaptionOpen] = useState(false);
  const [, startTransition] = useTransition();

  const resolveBlock = useCallback(
    (target: HTMLElement | null): number | null => {
      const dom = target?.closest(BLOCK_SELECTOR) as HTMLElement | null;
      if (!dom) return null;
      try {
        const at = editor.view.posAtDOM(dom, 0);
        const $pos = editor.state.doc.resolve(at);
        const depth = Math.max(1, $pos.depth);
        return $pos.before(depth);
      } catch {
        return null;
      }
    },
    [editor],
  );

  const onContextMenu = (event: React.MouseEvent) => {
    if (!editable) return;
    const next = resolveBlock(event.target as HTMLElement);
    if (next === null) return;
    event.preventDefault();
    setPoint({ x: event.clientX, y: event.clientY });
    setPos(next);
    editor.chain().setNodeSelection(next).run();
    setOpen(true);
  };

  const innerRange = (at: number) => {
    const node = editor.state.doc.nodeAt(at);
    if (!node) return null;
    return { from: at + 1, to: at + node.nodeSize - 1 };
  };

  /**
   * Turn the block under the menu into `target`. `convertBlock` derives the
   * target's attributes (heading level, to-do `checked`, toggle `open`, callout
   * `emoji`, code `language`); this only routes that result to the matching
   * TipTap command, keeping the node selection taken on right-click so the
   * inline content survives.
   */
  const turnInto = (target: BlockType) => {
    if (pos === null) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    const converted = convertBlock(toConvertible(node.type.name, node.attrs), target);
    if (!converted) return;
    const chain = editor.chain().focus().setNodeSelection(pos);
    switch (converted.type) {
      case "paragraph":
        chain.setParagraph().run();
        break;
      case "h1":
      case "h2":
      case "h3": {
        const level = converted.attrs?.level;
        chain.setHeading({ level: level === 2 ? 2 : level === 3 ? 3 : 1 }).run();
        break;
      }
      case "bulletedList":
        chain.toggleBulletList().run();
        break;
      case "numberedList":
        chain.toggleOrderedList().run();
        break;
      case "todoList":
        chain.toggleTaskList().run();
        break;
      case "toggle":
        chain.wrapIn("toggle", { open: converted.attrs?.open ?? true }).run();
        break;
      case "quote":
        chain.toggleBlockquote().run();
        break;
      case "callout":
        chain.wrapIn("callout", { emoji: converted.attrs?.emoji }).run();
        break;
      case "code":
        chain.setCodeBlock({ language: converted.attrs?.language ?? "" }).run();
        break;
      default:
        // `pullQuote` has no editor node yet; the menu never offers it.
        break;
    }
  };

  const duplicate = () => {
    if (pos === null) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    editor
      .chain()
      .focus()
      .insertContentAt(pos + node.nodeSize, node.toJSON())
      .run();
    toast.success(t(locale, "blockDuplicated"));
  };

  /**
   * Delete the block under the menu and offer a Notion-style Undo affordance.
   * Undo goes through the history extension when it is registered; with
   * history disabled (collaborative sessions) it re-inserts the captured
   * block at its original path from the doc-level snapshot instead.
   */
  const remove = () => {
    if (pos === null) return;
    const deletion = snapshotBlockDeletion(editor.state.doc, pos);
    editor.chain().focus().setNodeSelection(pos).deleteSelection().run();
    if (!deletion) return;
    toast.success(t(locale, "blockDeleted"), {
      duration: 8000,
      action: { label: t(locale, "undo"), onClick: () => undoDeletion(deletion) },
    });
  };

  const undoDeletion = (deletion: BlockDeletion) => {
    const names = editor.extensionManager.extensions.map((extension) => extension.name);
    if (canUndoViaHistory(names) && editor.can().undo()) {
      editor.chain().focus().undo().run();
      return;
    }
    // History is disabled (collaboration): restore from the doc-level
    // snapshot, re-inserting the block at its original (clamped) path.
    const restored = restoreBlockDeletion(editor.getJSON() as unknown as BlockDoc, deletion);
    editor.chain().focus().setContent(restored, { emitUpdate: true }).run();
  };

  /**
   * Copy a deep link to the block's page (and the block itself when it has a
   * stable id).
   *
   * `src/lib/deep-links.ts` is the canonical builder; the old handler pasted
   * `${origin}${pathname}#block-<pos>` with a *document offset* as the anchor.
   * The canonical route is `/w/<workspaceSlug>/<pageId>` and this menu is not
   * handed either id (`page-editor.tsx` is shared and out of scope for this
   * slice), but the editor only mounts on that route, so the live URL is the
   * authoritative source. The `BlockIds` extension (registered via
   * `input-rules.ts`) now stamps a persistent `id` on every top-level block, so
   * we climb from the block under the menu to its top-level ancestor and anchor
   * to that id; when no ancestor carries one (or the block is not yet minted)
   * we fall back to the page link (`blockId` undefined).
   */
  const copyLink = () => {
    if (pos === null) return;
    const { origin, pathname } = window.location;
    const segments = pathname.split("/").filter(Boolean).map(decodeSegment);
    const onPageRoute = segments[0] === "w" && segments.length >= 3;
    const blockId = blockAnchorId(editor.state.doc, pos);
    const url = onPageRoute
      ? buildBlockDeepLink(segments[segments.length - 1], blockId, {
          origin,
          workspaceSlug: segments[1],
        })
      : `${origin}${pathname}`;
    void navigator.clipboard?.writeText(url);
    toast.success(t(locale, "copied"));
  };

  const paint = (value: string | null, kind: "text" | "highlight" | "background") => {
    if (pos === null) return;
    if (kind === "background") {
      // Block-level tint: set the attribute on the block the menu opened on.
      // `pos` already points at that block's start (resolveBlock rounds there).
      const node = editor.state.doc.nodeAt(pos);
      if (!node || !(BLOCK_COLOR_TYPES as readonly string[]).includes(node.type.name)) {
        return;
      }
      const at = pos;
      const attrs = { ...node.attrs, blockColor: value };
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(at, undefined, attrs);
          return true;
        })
        .run();
      return;
    }
    const range = innerRange(pos);
    if (!range) return;
    const chain = editor.chain().focus().setTextSelection(range);
    if (kind === "text") {
      if (value) chain.setColor(value).run();
      else chain.unsetColor().run();
    } else if (value) {
      chain.setHighlight({ color: value }).run();
    } else {
      chain.unsetHighlight().run();
    }
  };

  /**
   * Merge `patch` into the code block under the menu, preserving every other
   * attribute. Mirrors the block-background path in {@link paint}: a node
   * markup transaction keeps the node selection and the inline content, and it
   * writes exactly the attributes the code-block node view reads
   * (`lineNumbers`, `caption`). No-op unless the block is still a `codeBlock`.
   */
  const setCodeBlockAttr = (patch: Record<string, unknown>) => {
    if (pos === null) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "codeBlock") return;
    const at = pos;
    const attrs = { ...node.attrs, ...patch };
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setNodeMarkup(at, undefined, attrs);
        return true;
      })
      .run();
  };

  /** Flip the gutter attribute the node view renders as `data-line-numbers`. */
  const toggleLineNumbers = () => {
    if (pos === null) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "codeBlock") return;
    setCodeBlockAttr({ lineNumbers: !node.attrs.lineNumbers });
  };

  /**
   * Store a caption via the shared `code-block.ts` helpers: `validateCaption`
   * rejects over-long text with a safe message, `formatCaption` collapses
   * whitespace so the stored attribute is always the normalised form.
   */
  const applyCodeCaption = (text: string) => {
    const result = validateCaption(text);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setCodeBlockAttr({ caption: formatCaption(text) });
  };

  /**
   * Toggle the caption: an existing caption clears to `""`, otherwise prompt
   * for the text (the node view's inline input covers later edits).
   */
  const toggleCaption = () => {
    if (pos === null) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "codeBlock") return;
    const current = formatCaption(String(node.attrs.caption ?? ""));
    if (current !== "") {
      setCodeBlockAttr({ caption: "" });
      return;
    }
    setCaptionOpen(true);
  };

  const move = (direction: -1 | 1) => {
    if (pos === null) return;
    const { state } = editor;
    const doc = state.doc;

    // Walk the top-level blocks ourselves: `resolve()`/`index()` based maths
    // was fragile and bailed out silently. Offsets here are exact.
    const offsets: number[] = [];
    let cursor = 0;
    for (let i = 0; i < doc.childCount; i += 1) {
      offsets.push(cursor);
      cursor += doc.child(i).nodeSize;
    }
    // Half-open ranges: a block boundary position belongs to the *later* block,
    // otherwise every move resolved to the previous sibling (and no-op'd).
    const index = offsets.findIndex(
      (start, i) => pos >= start && pos < start + doc.child(i).nodeSize,
    );
    if (index === -1) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= doc.childCount) return;

    const node = doc.child(index);
    const size = node.nodeSize;
    const currentStart = offsets[index];
    const siblingStart = offsets[targetIndex];
    const insertAt =
      direction < 0 ? siblingStart : siblingStart + doc.child(targetIndex).nodeSize - size;

    const tr = state.tr.delete(currentStart, currentStart + size).insert(insertAt, node);
    editor.view.dispatch(tr);
    editor.chain().setNodeSelection(insertAt).run();
  };
  const aiSkill = (id: AiSkillId) => {
    if (pos === null) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    const text = node.textContent.trim();
    if (!text) {
      toast.error(t(locale, "nothingToWorkWith"));
      return;
    }
    const skill = AI_SKILLS.find((candidate) => candidate.id === id);
    if (!skill) return;
    startTransition(async () => {
      const result = await runAiSkill(id, text, workspaceId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      const range = innerRange(pos);
      if (!range) return;
      if (result.replacesSelection) {
        editor.chain().focus().setTextSelection(range).insertContent(result.text).run();
      } else {
        editor
          .chain()
          .focus()
          .insertContentAt(pos + node.nodeSize, {
            type: "paragraph",
            content: [{ type: "text", text: result.text }],
          })
          .run();
      }
      toast.success(`${skill.label} applied`);
    });
  };

  const comment = () => {
    const node = pos === null ? null : editor.state.doc.nodeAt(pos);
    const quote = (node?.textContent ?? "").trim().slice(0, 300);
    window.dispatchEvent(new CustomEvent(COMMENT_EVENT, { detail: { quote } }));
  };

  const selectedNode = pos === null ? null : editor.state.doc.nodeAt(pos);
  const isEquation =
    selectedNode?.type.name === "inlineMath" || selectedNode?.type.name === "blockMath";

  // The code-block toggles only apply to `codeBlock` nodes and reflect the two
  // optional attributes the node view consumes (`lineNumbers`, `caption`).
  const isCodeBlock = selectedNode?.type.name === "codeBlock";
  const showCodeLineNumbers = isCodeBlock ? Boolean(selectedNode?.attrs?.lineNumbers) : false;
  const codeCaption = isCodeBlock
    ? formatCaption(String(selectedNode?.attrs?.caption ?? ""))
    : "";

  // `allowedTargets` drops the source type from the menu. When the source is not
  // named by the graph (h4–h6, a nested paragraph…) show every target rather
  // than hiding the whole submenu.
  const currentType = selectedNode
    ? blockTypeOfNode(selectedNode.type.name, selectedNode.attrs)
    : null;
  const allowed = new Set<BlockType>(
    currentType ? allowedTargets(currentType) : ALL_TARGET_TYPES,
  );

  return (
    <div onContextMenuCapture={onContextMenu} className="relative">
      {children}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            style={{
              position: "fixed",
              left: point.x,
              top: point.y,
              width: 0,
              height: 0,
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Type className="h-4 w-4 text-muted" /> {t(locale, "turnInto")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {CONVERSION_GROUPS.map((group, index) => {
                const types = group.types.filter(
                  (type) => allowed.has(type) && TURN_TARGET_LABELS[type] !== undefined,
                );
                if (types.length === 0) return null;
                return (
                  <Fragment key={group.id}>
                    {index > 0 && <DropdownMenuSeparator />}
                    {types.map((type) => {
                      const label = TURN_TARGET_LABELS[type];
                      if (!label) return null;
                      return (
                        <DropdownMenuItem key={type} onSelect={() => turnInto(type)}>
                          {t(locale, label)}
                        </DropdownMenuItem>
                      );
                    })}
                  </Fragment>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Palette className="h-4 w-4 text-muted" /> {t(locale, "colorLabel")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {TEXT_COLORS.map((color) => (
                <DropdownMenuItem
                  key={color.labelKey}
                  onSelect={() => paint(color.value, "text")}
                >
                  <span
                    className="h-4 w-4 rounded border border-border"
                    style={{ background: color.value ?? "transparent" }}
                  />
                  {t(locale, color.labelKey)}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted">
                {t(locale, "backgroundLabel")}
              </p>
              {BLOCK_COLORS.map((color) => (
                <DropdownMenuItem
                  key={color.label}
                  aria-label={`${t(locale, COLOR_KEYS[color.label])} ${t(locale, "backgroundLabel")}`}
                  onSelect={() => paint(color.value, "background")}
                >
                  <span
                    className="h-4 w-4 rounded border border-border"
                    style={{ background: color.tint }}
                  />
                  {t(locale, COLOR_KEYS[color.label])}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => paint(null, "highlight")}>
                {t(locale, "clearHighlight")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/*
           * Code-block toggles. `lineNumbers`/`caption` are the attrs the node
           * view reads; the labels reuse the closest shipped node-view keys
           * (dedicated code-line / code-caption keys are out of this slice).
           */}
          {isCodeBlock && pos !== null && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={showCodeLineNumbers}
                onSelect={toggleLineNumbers}
              >
                <ListOrdered className="h-4 w-4 text-muted" /> {t(locale, "numberWord")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={codeCaption !== ""}
                onSelect={toggleCaption}
              >
                <Type className="h-4 w-4 text-muted" /> {t(locale, "imageCaptionAria")}
              </DropdownMenuCheckboxItem>
            </>
          )}

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Sparkles className="h-4 w-4 text-muted" /> {t(locale, "askAI")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {AI_SKILLS.map((skill) => (
                <DropdownMenuItem key={skill.id} onSelect={() => aiSkill(skill.id)}>
                  {skill.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {isEquation && pos !== null && (
            <DropdownMenuItem
              onSelect={() => {
                const node = editor.state.doc.nodeAt(pos);
                window.dispatchEvent(
                  new CustomEvent(EQUATION_EVENT, {
                    detail: {
                      kind: node?.type.name === "blockMath" ? "block" : "inline",
                      latex: String(node?.attrs?.latex ?? ""),
                      pos,
                    },
                  }),
                );
              }}
            >
              <Sigma className="h-4 w-4 text-muted" /> {t(locale, "editEquation")}
            </DropdownMenuItem>
          )}

          <DropdownMenuItem onSelect={() => move(-1)}>
            <ArrowUp className="h-4 w-4 text-muted" /> {t(locale, "moveUp")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => move(1)}>
            <ArrowDown className="h-4 w-4 text-muted" /> {t(locale, "moveDown")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={duplicate}>
            <Copy className="h-4 w-4 text-muted" /> {t(locale, "duplicate")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={comment}>
            <MessageSquare className="h-4 w-4 text-muted" /> {t(locale, "comment")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={copyLink}>
            <Link2 className="h-4 w-4 text-muted" /> {t(locale, "copyLinkToBlock")}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={remove}>
            <Trash2 className="h-4 w-4 text-muted" /> {t(locale, "delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
       * Caption prompt for the code-block "Caption" toggle. `PromptDialog` is
       * the app-wide replacement for `window.prompt`; the entered text is
       * validated/formatted by `applyCodeCaption` before it is stored.
       */}
      <PromptDialog
        open={captionOpen}
        locale={locale}
        title={t(locale, "imageCaptionAria")}
        fields={[
          {
            name: "caption",
            label: t(locale, "imageCaptionAria"),
            defaultValue: codeCaption,
            placeholder: t(locale, "imageCaptionPlaceholder"),
            required: false,
          },
        ]}
        onSubmit={(values) => applyCodeCaption(values.caption ?? "")}
        onClose={() => setCaptionOpen(false)}
      />
    </div>
  );
}
