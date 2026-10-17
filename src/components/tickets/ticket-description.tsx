"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import {
  Bold,
  Code2,
  Eraser,
  Highlighter,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Strikethrough,
  Underline,
} from "lucide-react";
import { richTextExtensions } from "@/components/editor/rich-text-extensions";
import { Button } from "@/components/ui/button";
import { Select, type SelectOption } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tooltip } from "@/components/ui/tooltip";
import { descriptionEntryDoc } from "@/lib/description";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Quiet period after which a typed description is saved. */
export const DESCRIPTION_AUTOSAVE_MS = 800;

/**
 * The blocks the "turn into" picker offers. Lists, code and the divider are
 * buttons instead: their commands toggle, which reads as a button and not as a
 * picker entry that would silently un-toggle the block you already have.
 */
export type BlockChoice = "paragraph" | "h1" | "h2" | "h3" | "quote";

/** The block flags the picker reads off the caret's position. */
export type BlockFlags = {
  /** Heading level at the caret, if any. */
  heading?: number;
  blockquote?: boolean;
};

/** Which picker entry describes a caret with these flags. */
export function blockChoice(flags: BlockFlags): BlockChoice {
  if (flags.heading === 1) return "h1";
  if (flags.heading === 2) return "h2";
  if (flags.heading === 3) return "h3";
  if (flags.blockquote) return "quote";
  return "paragraph";
}

/** Read the caret's block flags out of a live editor. */
function blockFlags(editor: Editor): BlockFlags {
  const heading = [1, 2, 3].find((level) => editor.isActive("heading", { level }));
  return {
    heading,
    blockquote: editor.isActive("blockquote"),
  };
}

/** One toolbar toggle: an icon button that reports and shows its own state. */
function ToolButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cn(active && "bg-surface-2 text-fg")}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

export type TicketDescriptionProps = {
  /** The stored `Ticket.description` doc (rich, plain, or absent). */
  doc: unknown;
  /** The same description as plain text — the fallback and the "has content" test. */
  text: string;
  locale: string;
  /** Persist a freshly typed description doc. */
  onSave: (doc: unknown) => void;
};

/**
 * The ticket description as a real rich-text field.
 *
 * It is the same editor a page body is (same extensions, same stored doc shape),
 * scaled to a side panel: a compact toolbar over the content, markdown shortcuts
 * for everything the toolbar does not show, and the drawer's own autosave
 * cadence (one save per quiet period, plus one on the way out).
 *
 * The component is keyed by ticket id at the call site, so switching tickets
 * builds a fresh editor instead of syncing one imperatively.
 */
export function TicketDescription({ doc, text, locale, onSave }: TicketDescriptionProps) {
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last payload handed to the server, serialised: a re-save of it is a no-op. */
  const saved = useRef(JSON.stringify(doc ?? null));
  /** Typed-but-unsaved document, kept as both shapes to avoid a re-parse later. */
  const pending = useRef<{ json: string; doc: unknown } | null>(null);
  /** The latest callback, so the unmount flush never captures a stale one. */
  const save = useRef(onSave);
  save.current = onSave;

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    pending.current = null;
    if (!next || next.json === saved.current) return;
    saved.current = next.json;
    save.current(next.doc);
  }, []);

  // Unmounting mid-pause (closing the drawer, switching tickets) must not drop
  // the last edit — the debounce is a network courtesy, not a data-loss window.
  useEffect(() => flush, [flush]);

  const extensions = useMemo(
    () => richTextExtensions({ locale, placeholder: t(locale, "addDescription") }),
    [locale],
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    // The stored value is untrusted JSON (`unknown`); TipTap's schema parses it
    // and drops anything it does not know, which is the same contract the page
    // editor has with `Page.content`.
    content: descriptionEntryDoc(doc, text) as JSONContent,
    editorProps: {
      // The contenteditable keeps TipTap's `role="textbox"`, so the description
      // is announced (and reachable by label) exactly as the textarea was.
      attributes: {
        class: "focus:outline-none",
        "aria-label": t(locale, "ticketDescriptionAria"),
      },
    },
    onUpdate: ({ editor: instance }) => {
      const json = JSON.stringify(instance.getJSON());
      pending.current = { json, doc: instance.getJSON() };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, DESCRIPTION_AUTOSAVE_MS);
    },
  });

  const choice = editor ? blockChoice(blockFlags(editor)) : "paragraph";
  const hasContent = editor ? !editor.isEmpty : text.trim().length > 0;

  const blockOptions: SelectOption[] = [
    { value: "paragraph", label: t(locale, "blockText") },
    { value: "h1", label: t(locale, "blockHeading1") },
    { value: "h2", label: t(locale, "blockHeading2") },
    { value: "h3", label: t(locale, "blockHeading3") },
    { value: "quote", label: t(locale, "blockQuote") },
  ];

  /** Turn the caret's block into `next`; picking the current block is a no-op. */
  const applyBlock = (next: string) => {
    if (!editor) return;
    if (next === choice) return;
    const chain = editor.chain().focus();
    if (next === "h1") chain.setHeading({ level: 1 }).run();
    else if (next === "h2") chain.setHeading({ level: 2 }).run();
    else if (next === "h3") chain.setHeading({ level: 3 }).run();
    else if (next === "quote") chain.setParagraph().toggleBlockquote().run();
    else chain.setParagraph().run();
  };

  const run = (command: (chain: ReturnType<Editor["chain"]>) => void) => {
    if (editor) command(editor.chain().focus());
  };

  return (
    <div
      data-testid="ticket-description-box"
      className={cn(
        // `noema-editor` borrows the page body's typography (headings, lists,
        // code, tables); the wrapper below adds the panel's own frame.
        "noema-editor noema-description-editor rounded-md border px-3 py-2 u-colors",
        hasContent || focused
          ? "border-border bg-bg"
          : "border-dashed border-border bg-transparent",
      )}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        // Moving focus inside the field (onto a toolbar button) is not a blur.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setFocused(false);
        flush();
      }}
    >
      <div
        role="toolbar"
        aria-label={t(locale, "description")}
        className="mb-2 flex flex-wrap items-center gap-0.5"
      >
        <Select
          aria-label={t(locale, "turnInto")}
          className="w-32"
          value={choice}
          options={blockOptions}
          allowClear={false}
          searchable={false}
          onChange={applyBlock}
        />
        <Separator orientation="vertical" className="mx-1 h-5" />

        <ToolButton
          label={t(locale, "blockBulletedList")}
          active={editor?.isActive("bulletList")}
          onClick={() => run((chain) => chain.toggleBulletList().run())}
        >
          <List className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t(locale, "blockNumberedList")}
          active={editor?.isActive("orderedList")}
          onClick={() => run((chain) => chain.toggleOrderedList().run())}
        >
          <ListOrdered className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t(locale, "blockTodoList")}
          active={editor?.isActive("taskList")}
          onClick={() => run((chain) => chain.toggleTaskList().run())}
        >
          <ListTodo className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t(locale, "codeBlockHint")}
          active={editor?.isActive("codeBlock")}
          onClick={() => run((chain) => chain.toggleCodeBlock().run())}
        >
          <Code2 className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t(locale, "blockDivider")}
          onClick={() => run((chain) => chain.setHorizontalRule().run())}
        >
          <Minus className="h-4 w-4" aria-hidden />
        </ToolButton>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <ToolButton
          label={t(locale, "bold")}
          active={editor?.isActive("bold")}
          onClick={() => run((chain) => chain.toggleBold().run())}
        >
          <Bold className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t(locale, "italic")}
          active={editor?.isActive("italic")}
          onClick={() => run((chain) => chain.toggleItalic().run())}
        >
          <Italic className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t(locale, "underline")}
          active={editor?.isActive("underline")}
          onClick={() => run((chain) => chain.toggleUnderline().run())}
        >
          <Underline className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t(locale, "strikethrough")}
          active={editor?.isActive("strike")}
          onClick={() => run((chain) => chain.toggleStrike().run())}
        >
          <Strikethrough className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t(locale, "code")}
          active={editor?.isActive("code")}
          onClick={() => run((chain) => chain.toggleCode().run())}
        >
          <Code2 className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t(locale, "highlight")}
          active={editor?.isActive("highlight")}
          onClick={() => run((chain) => chain.toggleHighlight().run())}
        >
          <Highlighter className="h-4 w-4" aria-hidden />
        </ToolButton>
        <ToolButton
          label={t(locale, "clearFormatting")}
          onClick={() => run((chain) => chain.clearNodes().unsetAllMarks().run())}
        >
          <Eraser className="h-4 w-4" aria-hidden />
        </ToolButton>
      </div>

      <EditorContent editor={editor} />
    </div>
  );
}
