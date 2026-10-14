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

const TEXT_COLORS = [
  { label: "Default", value: null },
  { label: "Gray", value: "#787774" },
  { label: "Brown", value: "#9f6b53" },
  { label: "Orange", value: "#d9730d" },
  { label: "Yellow", value: "#cb912f" },
  { label: "Green", value: "#448361" },
  { label: "Blue", value: "#337ea9" },
  { label: "Purple", value: "#9065b0" },
  { label: "Pink", value: "#c14c8a" },
  { label: "Red", value: "#d44c47" },
];

const BLOCK_SELECTOR =
  "p, h1, h2, h3, h4, h5, h6, pre, blockquote, li, [data-callout], .noema-toggle";

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

const TURN_ITEMS: { kind: TurnKind; label: string }[] = [
  { kind: "paragraph", label: "Text" },
  { kind: "h1", label: "Heading 1" },
  { kind: "h2", label: "Heading 2" },
  { kind: "h3", label: "Heading 3" },
  { kind: "h4", label: "Heading 4" },
  { kind: "h5", label: "Heading 5" },
  { kind: "h6", label: "Heading 6" },
  { kind: "bullet", label: "Bulleted list" },
  { kind: "ordered", label: "Numbered list" },
  { kind: "task", label: "To-do list" },
  { kind: "toggle", label: "Toggle list" },
  { kind: "quote", label: "Quote" },
  { kind: "callout", label: "Callout" },
  { kind: "code", label: "Code" },
];

/**
 * Notion-style block menu: right-click anywhere in the editor to act on the
 * block under the pointer (turn into, duplicate, move, colour, comment, AI).
 */
export function BlockContextMenu({
  editor,
  editable,
  workspaceId,
  children,
}: {
  editor: Editor;
  editable: boolean;
  workspaceId?: string;
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
    toast.success("Block duplicated");
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
    toast.success("Block deleted", {
      duration: 8000,
      action: { label: "Undo", onClick: () => undoDeletion(deletion) },
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

  const copyLink = () => {
    if (pos === null) return;
    const url = `${window.location.origin}${window.location.pathname}#block-${pos}`;
    void navigator.clipboard?.writeText(url);
    toast.success("Link copied");
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
      toast.error("Nothing to work with in that block.");
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
              <Type className="h-4 w-4 text-muted" /> Turn into
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {TURN_ITEMS.map((item) => (
                <DropdownMenuItem key={item.kind} onSelect={() => turnInto(item.kind)}>
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Palette className="h-4 w-4 text-muted" /> Color
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {TEXT_COLORS.map((color) => (
                <DropdownMenuItem
                  key={color.label}
                  onSelect={() => paint(color.value, "text")}
                >
                  <span
                    className="h-4 w-4 rounded border border-border"
                    style={{ background: color.value ?? "transparent" }}
                  />
                  {color.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted">
                Background
              </p>
              {BLOCK_COLORS.map((color) => (
                <DropdownMenuItem
                  key={color.label}
                  aria-label={`${color.label} background`}
                  onSelect={() => paint(color.value, "background")}
                >
                  <span
                    className="h-4 w-4 rounded border border-border"
                    style={{ background: color.tint }}
                  />
                  {color.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => paint(null, "highlight")}>
                Clear highlight
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Sparkles className="h-4 w-4 text-muted" /> Ask AI
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
              <Sigma className="h-4 w-4 text-muted" /> Edit equation
            </DropdownMenuItem>
          )}

          <DropdownMenuItem onSelect={() => move(-1)}>
            <ArrowUp className="h-4 w-4 text-muted" /> Move up
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => move(1)}>
            <ArrowDown className="h-4 w-4 text-muted" /> Move down
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={duplicate}>
            <Copy className="h-4 w-4 text-muted" /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={comment}>
            <MessageSquare className="h-4 w-4 text-muted" /> Comment
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={copyLink}>
            <Link2 className="h-4 w-4 text-muted" /> Copy link to block
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={remove}>
            <Trash2 className="h-4 w-4 text-muted" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
