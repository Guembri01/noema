"use client";

import { useCallback, useState, useTransition, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Link2,
  MessageSquare,
  Palette,
  Sigma,
  Sparkles,
  Trash2,
  Type,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { buildBlockDeepLink } from "@/lib/deep-links";
import { t } from "@/lib/i18n";

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

type TurnKind =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "bullet"
  | "ordered"
  | "task"
  | "toggle"
  | "quote"
  | "callout"
  | "code";

const TURN_ITEMS: { kind: TurnKind; labelKey: I18nKey }[] = [
  { kind: "paragraph", labelKey: "blockText" },
  { kind: "h1", labelKey: "blockHeading1" },
  { kind: "h2", labelKey: "blockHeading2" },
  { kind: "h3", labelKey: "blockHeading3" },
  { kind: "h4", labelKey: "blockHeading4" },
  { kind: "h5", labelKey: "blockHeading5" },
  { kind: "h6", labelKey: "blockHeading6" },
  { kind: "bullet", labelKey: "blockBulletedList" },
  { kind: "ordered", labelKey: "blockNumberedList" },
  { kind: "task", labelKey: "blockTodoList" },
  { kind: "toggle", labelKey: "blockToggleList" },
  { kind: "quote", labelKey: "blockQuote" },
  { kind: "callout", labelKey: "blockCallout" },
  { kind: "code", labelKey: "code" },
];

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

  const turnInto = (kind: TurnKind) => {
    if (pos === null) return;
    const chain = editor.chain().focus().setNodeSelection(pos);
    switch (kind) {
      case "paragraph":
        chain.setParagraph().run();
        break;
      case "h1":
        chain.setHeading({ level: 1 }).run();
        break;
      case "h2":
        chain.setHeading({ level: 2 }).run();
        break;
      case "h3":
        chain.setHeading({ level: 3 }).run();
        break;
      case "h4":
        chain.setHeading({ level: 4 }).run();
        break;
      case "h5":
        chain.setHeading({ level: 5 }).run();
        break;
      case "h6":
        chain.setHeading({ level: 6 }).run();
        break;
      case "bullet":
        chain.toggleBulletList().run();
        break;
      case "ordered":
        chain.toggleOrderedList().run();
        break;
      case "task":
        chain.toggleTaskList().run();
        break;
      case "toggle":
        chain.wrapIn("toggle").run();
        break;
      case "quote":
        chain.toggleBlockquote().run();
        break;
      case "callout":
        chain.wrapIn("callout").run();
        break;
      case "code":
        chain.setCodeBlock().run();
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
   * Copy a deep link to the block's page.
   *
   * `src/lib/deep-links.ts` is the canonical builder; the old handler pasted
   * `${origin}${pathname}#block-<pos>` with a *document offset* as the anchor.
   * The canonical route is `/w/<workspaceSlug>/<pageId>` and this menu is not
   * handed either id (`page-editor.tsx` is shared and out of scope for this
   * slice), but the editor only mounts on that route, so the live URL is the
   * authoritative source. TipTap nodes still carry no persisted block id, so the
   * `#<blockId>` fragment is deferred: we emit the page link now and pass the
   * block id as the builder's second argument once stable ids land.
   */
  const copyLink = () => {
    if (pos === null) return;
    const { origin, pathname } = window.location;
    const segments = pathname.split("/").filter(Boolean).map(decodeSegment);
    const onPageRoute = segments[0] === "w" && segments.length >= 3;
    const url = onPageRoute
      ? buildBlockDeepLink(segments[segments.length - 1], undefined, {
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
              {TURN_ITEMS.map((item) => (
                <DropdownMenuItem key={item.kind} onSelect={() => turnInto(item.kind)}>
                  {t(locale, item.labelKey)}
                </DropdownMenuItem>
              ))}
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
    </div>
  );
}
