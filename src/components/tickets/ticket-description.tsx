"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import {
  Bold,
  Code2,
  Eraser,
  Highlighter,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Palette,
  Strikethrough,
  Underline,
} from "lucide-react";
import {
  SwatchButton,
  isActiveSwatch,
  normalizeLinkUrl,
  swatchChoices,
} from "@/components/editor/bubble-toolbar";
import { richTextExtensions } from "@/components/editor/rich-text-extensions";
import { Button } from "@/components/ui/button";
import { FloatingLayer } from "@/components/ui/floating-layer";
import { Input } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tooltip } from "@/components/ui/tooltip";
import { Z } from "@/lib/design-tokens";
import { descriptionEntryDoc } from "@/lib/description";
import { floatingStyle, placeFloating, type Placement } from "@/lib/floating";
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

/** One of the toolbar's two panels: a swatch grid, or the link editor. */
type DescriptionPanel = "color" | "link";

/** Panel bounds, needed by the placement maths before the panel first paints. */
const COLOR_PANEL_WIDTH = 152;
const COLOR_PANEL_HEIGHT = 72;
const LINK_PANEL_WIDTH = 288;
const LINK_PANEL_HEIGHT = 172;

/** Rendered for the one frame before the real measurement lands. */
const panelFallback = (width: number, height: number): Placement => ({
  top: 0,
  left: 0,
  side: "bottom",
  flipped: false,
  cramped: false,
  maxHeight: height,
});

/**
 * Where a toolbar panel should sit, in viewport coordinates.
 *
 * The panel is portalled (see `FloatingLayer`): the drawer is a sheet, and a
 * `position: fixed` box inside one would be re-rooted by an ancestor transform
 * and, at `Z.popover`, painted *under* the sheet itself. `placeFloating` puts it
 * under its button, flips it up when the drawer's edge is near, and keeps it
 * inside the viewport.
 */
function usePanelPlacement(
  open: boolean,
  anchor: React.RefObject<HTMLElement | null>,
  width: number,
  height: number,
): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null);

  useEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const resolve = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      setPlacement(
        placeFloating({
          anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          size: { width, height },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          preferred: "bottom",
          align: "start",
        }),
      );
    };
    resolve();
    window.addEventListener("resize", resolve);
    window.addEventListener("scroll", resolve, true);
    return () => {
      window.removeEventListener("resize", resolve);
      window.removeEventListener("scroll", resolve, true);
    };
  }, [open, anchor, width, height]);

  return placement;
}

/** One toolbar toggle: an icon button that reports and shows its own state. */
function ToolButton({
  label,
  active = false,
  popup,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  /**
   * Set when the button opens a panel instead of toggling a mark: the button is
   * then a dialog trigger (expanded/controls) rather than a pressed toggle.
   */
  popup?: { expanded: boolean; controls: string };
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
        aria-haspopup={popup ? "dialog" : undefined}
        aria-expanded={popup?.expanded}
        aria-controls={popup?.controls}
        aria-pressed={popup ? undefined : active}
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
  /**
   * Persist a freshly typed description doc, serialised as JSON text. Text
   * rather than the object: ProseMirror shares one `attrs` object between every
   * mark carrying the same attributes, and React's action encoder replaces a
   * shared object graph with a temporary reference the server cannot read.
   */
  onSave: (docJson: string) => void;
};

/**
 * The ticket description as a real rich-text field.
 *
 * It is the same editor a page body is (same extensions, same stored doc shape),
 * scaled to a side panel: a compact toolbar over the content, markdown shortcuts
 * for everything the toolbar does not show, and the drawer's own autosave
 * cadence (one save per quiet period, plus one on the way out).
 *
 * Two toolbar controls open a panel of their own (the colour swatches and the
 * link editor). Both are portalled through `FloatingLayer` and placed with
 * `placeFloating` rather than rendered in place: the drawer is a sheet at
 * `Z.modal`, so an in-flow popover would be clipped by its own container and an
 * un-portalled one painted underneath it.
 *
 * The component is keyed by ticket id at the call site, so switching tickets
 * builds a fresh editor instead of syncing one imperatively.
 */
export function TicketDescription({ doc, text, locale, onSave }: TicketDescriptionProps) {
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last payload handed to the server, serialised: a re-save of it is a no-op. */
  const saved = useRef(JSON.stringify(doc ?? null));
  /** Typed-but-unsaved document, serialised once so the flush has nothing to build. */
  const pending = useRef<string | null>(null);
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
    if (!next || next === saved.current) return;
    saved.current = next;
    save.current(next);
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
      // Serialised, not the object itself: ProseMirror shares one `attrs` object
      // between every mark with the same attributes, and React's action encoder
      // turns a shared object graph into a temporary reference (`"$T"`) that the
      // server cannot read — which silently dropped a text colour and a link's
      // href. The page editor sends its content the same way.
      pending.current = JSON.stringify(instance.getJSON());
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, DESCRIPTION_AUTOSAVE_MS);
    },
  });

  const choice = editor ? blockChoice(blockFlags(editor)) : "paragraph";
  const hasContent = editor ? !editor.isEmpty : text.trim().length > 0;

  const [panel, setPanel] = useState<DescriptionPanel | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const panelBase = useId();
  const colorPanelId = `${panelBase}-description-color`;
  const linkPanelId = `${panelBase}-description-link`;
  const colorAnchor = useRef<HTMLSpanElement | null>(null);
  const linkAnchor = useRef<HTMLSpanElement | null>(null);
  const colorPlacement = usePanelPlacement(
    panel === "color",
    colorAnchor,
    COLOR_PANEL_WIDTH,
    COLOR_PANEL_HEIGHT,
  );
  const linkPlacement = usePanelPlacement(
    panel === "link",
    linkAnchor,
    LINK_PANEL_WIDTH,
    LINK_PANEL_HEIGHT,
  );

  // Dismiss a panel on a click outside it and on Escape. The panel is portalled,
  // so the box no longer contains it in the DOM — check both trees, as `Select`
  // does. A press on the box itself is left to the buttons, which own the state.
  useEffect(() => {
    if (!panel) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[data-testid="ticket-description-panel"]')) return;
      if (target?.closest?.('[data-testid="ticket-description-box"]')) return;
      setPanel(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [panel]);

  // The colour the caret currently carries, and the link it sits in — the same
  // reads the page editor's bubble menu makes, and just as safe to do in render:
  // `useEditor` re-renders on every transaction that changes either.
  const activeColor =
    (editor?.getAttributes("textStyle") as { color?: string } | undefined)?.color ?? null;
  const activeHref = editor
    ? (editor.getAttributes("link") as { href?: string }).href ?? null
    : null;
  const colorSwatches = useMemo(() => swatchChoices("text"), []);

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

  /** Apply a swatch; `null` returns the text to the default ink. */
  const applyColor = (value: string | null) => {
    setPanel(null);
    if (!editor) return;
    if (value) editor.chain().focus().setColor(value).run();
    else editor.chain().focus().unsetColor().run();
  };

  /** Open the link panel primed with the link under the caret, if there is one. */
  const toggleLinkPanel = () => {
    if (panel === "link") {
      setPanel(null);
      return;
    }
    setLinkUrl(activeHref ?? "");
    setPanel("link");
  };

  /**
   * Apply the link panel. A blank URL removes the link, so emptying the field and
   * applying is the same gesture as "Remove link" — the field is the whole form,
   * and neither path leaves a link pointing at nothing.
   */
  const applyLink = () => {
    setPanel(null);
    if (!editor) return;
    const href = normalizeLinkUrl(linkUrl);
    const linked = editor.isActive("link");
    const chain = editor.chain().focus();
    // `extendMarkRange` refuses a range that does not already carry the mark —
    // returning `false`, which aborts the whole chain — so it may only be asked
    // when the selection really is inside a link (updating one in place).
    if (linked) chain.extendMarkRange("link");
    if (href) chain.setLink({ href }).run();
    else chain.unsetLink().run();
  };

  const removeLink = () => {
    setPanel(null);
    run((chain) => chain.extendMarkRange("link").unsetLink().run());
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
        <span ref={colorAnchor} className="inline-flex">
          <ToolButton
            label={t(locale, "textColor")}
            active={panel === "color"}
            popup={{ expanded: panel === "color", controls: colorPanelId }}
            onClick={() => setPanel(panel === "color" ? null : "color")}
          >
            <Palette className="h-4 w-4" aria-hidden />
          </ToolButton>
        </span>
        <span ref={linkAnchor} className="inline-flex">
          <ToolButton
            label={t(locale, "link")}
            active={editor?.isActive("link") === true || panel === "link"}
            popup={{ expanded: panel === "link", controls: linkPanelId }}
            onClick={toggleLinkPanel}
          >
            <Link2 className="h-4 w-4" aria-hidden />
          </ToolButton>
        </span>
        <ToolButton
          label={t(locale, "clearFormatting")}
          onClick={() => run((chain) => chain.clearNodes().unsetAllMarks().run())}
        >
          <Eraser className="h-4 w-4" aria-hidden />
        </ToolButton>
      </div>

      <EditorContent editor={editor} />

      {panel === "color" && (
        <FloatingLayer>
          <div
            id={colorPanelId}
            role="dialog"
            aria-label={t(locale, "textColor")}
            data-testid="ticket-description-panel"
            data-panel="color"
            style={{
              ...floatingStyle(
                colorPlacement ?? panelFallback(COLOR_PANEL_WIDTH, COLOR_PANEL_HEIGHT),
              ),
              zIndex: Z.popover,
              width: COLOR_PANEL_WIDTH,
            }}
            className="surface-raised rounded-lg p-2"
          >
            <div
              role="group"
              aria-label={t(locale, "textColor")}
              className="grid grid-cols-5 gap-1"
            >
              {colorSwatches.map((choice) => (
                <SwatchButton
                  key={choice.labelKey}
                  kind="text"
                  choice={choice}
                  locale={locale}
                  active={isActiveSwatch(activeColor, choice.value)}
                  onPick={applyColor}
                />
              ))}
            </div>
          </div>
        </FloatingLayer>
      )}

      {panel === "link" && (
        <FloatingLayer>
          <div
            id={linkPanelId}
            role="dialog"
            aria-label={t(locale, "link")}
            data-testid="ticket-description-panel"
            data-panel="link"
            style={{
              ...floatingStyle(
                linkPlacement ?? panelFallback(LINK_PANEL_WIDTH, LINK_PANEL_HEIGHT),
              ),
              zIndex: Z.popover,
              width: LINK_PANEL_WIDTH,
            }}
            className="surface-raised flex flex-col gap-2 rounded-lg p-3"
          >
            <label className="flex flex-col gap-1 text-xs text-muted">
              {t(locale, "linkUrl")}
              <Input
                type="url"
                inputMode="url"
                size="sm"
                autoFocus
                value={linkUrl}
                placeholder={t(locale, "linkPastePlaceholder")}
                onChange={(event) => setLinkUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyLink();
                  }
                }}
              />
            </label>
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={editor?.isActive("link") !== true}
                onClick={removeLink}
              >
                {t(locale, "removeLink")}
              </Button>
              <Button type="button" variant="primary" size="xs" onClick={applyLink}>
                {t(locale, "apply")}
              </Button>
            </div>
          </div>
        </FloatingLayer>
      )}
    </div>
  );
}
