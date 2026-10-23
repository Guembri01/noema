"use client";

import {
  useEffect,
  useReducer,
  useState,
  useTransition
} from "react";
import { type Editor } from "@tiptap/react";
import {
  Ban,
  Bold,
  CaseLower,
  CaseUpper,
  Code,
  Eraser,
  Highlighter,
  Italic,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Palette,
  Sigma,
  Sparkles,
  Strikethrough,
  Underline as UnderlineIcon
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { COMMENT_EVENT, EQUATION_EVENT } from "@/lib/editor-events";
import { AI_SKILLS, type AiSkillId } from "@/lib/ai-skills";
import { runAiSkill } from "@/lib/ai-client";
import { Tooltip } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { type TagHue } from "@/lib/design-tokens";
import { t } from "@/lib/i18n";
import {
  TEXT_TRANSFORMS,
  applyTextTransform,
  type TextTransformKind
} from "@/lib/text-transform";

type I18nKey = Parameters<typeof t>[1];

/* ---------------------------------------------------------------------------
   Colour + highlight swatches (token-driven)

   The editor's 9 Notion hues map one-to-one onto the design system tag palette,
   so a text colour is `var(--tag-<hue>-fg)` and a highlight is
   `var(--tag-<hue>-bg)`. No raw hex reaches the component, and both follow the
   light / dark / high-contrast tokens automatically.
   ------------------------------------------------------------------------- */

export type SwatchKind = "text" | "highlight";

/** The hues offered, in menu order (teal is reserved for tags). */
export const SWATCH_HUES: readonly TagHue[] = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];

const HUE_LABELS: Record<string, I18nKey> = {
  gray: "colorGray",
  brown: "colorBrown",
  orange: "colorOrange",
  yellow: "colorYellow",
  green: "colorGreen",
  blue: "colorBlue",
  purple: "colorPurple",
  pink: "colorPink",
  red: "colorRed",
};

/** One swatch: `value === null` clears the mark. */
export type SwatchChoice = { value: string | null; labelKey: I18nKey };

/** The CSS custom property a swatch applies for a hue. */
export function tagSwatchValue(kind: SwatchKind, hue: TagHue): string {
  return kind === "text" ? `var(--tag-${hue}-fg)` : `var(--tag-${hue}-bg)`;
}

/** The swatch grid for a kind: a "clear" cell then one per hue. */
export function swatchChoices(kind: SwatchKind): SwatchChoice[] {
  return [
    {
      value: null,
      labelKey: kind === "text" ? "colorDefault" : "colorNone",
    },
    ...SWATCH_HUES.map((hue) => ({
      value: tagSwatchValue(kind, hue),
      labelKey: HUE_LABELS[hue] ?? "colorGray",
    })),
  ];
}

/**
 * Active-swatch detection. Mark attrs can be normalised by an editor round-trip
 * (whitespace, casing), so compare case-insensitively and treat
 * `null`/`undefined`/empty as the same "unset" value.
 */
export function isActiveSwatch(
  active: string | null | undefined,
  value: string | null,
): boolean {
  return (active ?? "").trim().toLowerCase() === (value ?? "").trim().toLowerCase();
}

/** Swatch button chrome: token colours, `.focus-ring`, active = accent ring. */
export function swatchButtonClass(active: boolean): string {
  return cn(
    "u-interactive focus-ring inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-control border border-border",
    active && "border-fg",
  );
}

/* ---------------------------------------------------------------------------
   Link popover state machine (pure)
   ------------------------------------------------------------------------- */

export type LinkPopoverState = {
  /** The link's visible text. */
  title: string;
  /** The raw URL as typed. */
  url: string;
  /** Open the link in a new tab (`target="_blank"`). */
  newTab: boolean;
};

export const LINK_POPOVER_INITIAL: LinkPopoverState = {
  title: "",
  url: "",
  newTab: false,
};

export type LinkPopoverAction =
  | { type: "open"; title?: string; url?: string; newTab?: boolean }
  | { type: "close" }
  | { type: "setTitle"; value: string }
  | { type: "setUrl"; value: string }
  | { type: "setNewTab"; value: boolean }
  | { type: "reset" };

/** Pure reducer behind the link popover. Opening primes from the live mark. */
export function nextLinkPopover(
  state: LinkPopoverState,
  action: LinkPopoverAction,
): LinkPopoverState {
  switch (action.type) {
    case "open":
      return {
        title: action.title ?? "",
        url: action.url ?? "",
        newTab: action.newTab ?? false,
      };
    case "close":
    case "reset":
      return LINK_POPOVER_INITIAL;
    case "setTitle":
      return { ...state, title: action.value };
    case "setUrl":
      return { ...state, url: action.value };
    case "setNewTab":
      return { ...state, newTab: action.value };
    default:
      return state;
  }
}

/**
 * Normalise a typed URL: keep a real scheme, an in-page anchor or a relative
 * path, otherwise assume `https://` (the old behaviour that made "example.com"
 * usable).
 */
export function normalizeLinkUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (
    /^(https?:|mailto:|tel:)/i.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("#")
  ) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

/** What the popover applies, or `null` when the URL is empty (unlink). */
export function linkPopoverTarget(
  state: LinkPopoverState,
): { href: string; target: "_blank" | null } | null {
  const href = normalizeLinkUrl(state.url);
  if (!href) return null;
  return { href, target: state.newTab ? "_blank" : null };
}

/* ---------------------------------------------------------------------------
   Toolbar button chrome (pure)
   ------------------------------------------------------------------------- */

/** Token-only chrome for the square, icon-only toolbar buttons. */
export function bubbleButtonClass({ active = false }: { active?: boolean } = {}): string {
  return cn(
    "u-interactive focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control",
    "text-muted hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50",
    active ? "bg-surface-2 text-fg" : "bg-transparent",
  );
}

/* ---------------------------------------------------------------------------
   Bubble menu
   ------------------------------------------------------------------------- */

type PanelName = "color" | "highlight" | "link" | "ai";

/* Case transforms offered as toolbar actions. `none` is the default and needs
   no button, so it is filtered out; labels/descriptions come from the shared
   catalog so the menu stays in sync with the transform engine. */
const TRANSFORM_ACTIONS = TEXT_TRANSFORMS.filter(
  (transform) => transform.kind !== "none",
);

/** Overflow trigger label (English literal awaiting a catalogue key). */
const OVERFLOW_LABEL = "More";

export function BubbleToolbar({
  locale = "en",
  editor,
  workspaceId,
  onPanelOpenChange,
}: {
  editor: Editor;
  workspaceId?: string;
  onPanelOpenChange: (open: boolean) => void;
  locale?: string;
}) {
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [link, dispatchLink] = useReducer(nextLinkPopover, LINK_POPOVER_INITIAL);

  // Current mark attributes drive the swatch "selected" ring and the link
  // button's title. Reading them during render is safe: the bubble menu only
  // mounts while a selection exists and re-renders on selection/mark changes.
  const activeTextColor =
    (editor.getAttributes("textStyle") as { color?: string }).color ?? null;
  const activeHighlightColor =
    (editor.getAttributes("highlight") as { color?: string }).color ?? null;
  const activeHref = (editor.getAttributes("link") as { href?: string }).href;
  const activeTarget = (editor.getAttributes("link") as { target?: string }).target;

  const setPanelOpen = (name: PanelName, open: boolean) => {
    setPanel((previous) => (open ? name : previous === name ? null : previous));
  };

  // Keep the host (the bubble menu) open while any popover is showing.
  useEffect(() => {
    onPanelOpenChange(panel !== null);
  }, [panel, onPanelOpenChange]);

  // If the toolbar unmounts with a popover still "open", release the host.
  useEffect(() => () => onPanelOpenChange(false), [onPanelOpenChange]);

  const primeLink = () => {
    const { from, to } = editor.state.selection;
    const title =
      from === to ? "" : editor.state.doc.textBetween(from, to, " ");
    dispatchLink({
      type: "open",
      title,
      url: activeHref ?? "",
      newTab: activeTarget === "_blank",
    });
  };

  const applyTextColor = (value: string | null) => {
    if (value) editor.chain().focus().setColor(value).run();
    else editor.chain().focus().unsetColor().run();
    setPanel(null);
  };

  const applyHighlight = (value: string | null) => {
    if (value) editor.chain().focus().setHighlight({ color: value }).run();
    else editor.chain().focus().unsetHighlight().run();
    setPanel(null);
  };

  // Replace the selected range with its transformed casing. The engine is
  // pure, so the text keeps every character and only its display form changes.
  const applyTransform = (kind: TextTransformKind) => {
    const { from, to } = editor.state.selection;
    if (from === to) {
      toast.error(t(locale, "selectTextFirst"));
      return;
    }
    const text = editor.state.doc.textBetween(from, to, "\n");
    const transformed = applyTextTransform(kind, text);
    if (transformed === text) return;
    // Insert a text node rather than a raw string: tiptap parses strings as
    // HTML, which would mangle selections containing `<` or `&`.
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, { type: "text", text: transformed })
      .run();
  };

  // Apply the popover: replace the visible text and (re)bind the link mark in
  // one transaction; an empty URL removes the link.
  const applyLink = () => {
    const target = linkPopoverTarget(link);
    const { from, to } = editor.state.selection;
    const currentText = editor.state.doc.textBetween(from, to, " ");
    const text = link.title.trim() || currentText;
    if (!target) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else if (text) {
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from, to },
          {
            type: "text",
            text,
            marks: [
              {
                type: "link",
                attrs: { href: target.href, target: target.target },
              },
            ],
          },
        )
        .run();
    } else {
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: target.href, target: target.target })
        .run();
    }
    setPanel(null);
  };

  const [aiPending, startAi] = useTransition();

  const applySkill = (id: AiSkillId) => {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, "\n").trim();
    if (!text) {
      toast.error(t(locale, "selectTextFirst"));
      return;
    }
    const skill = AI_SKILLS.find((candidate) => candidate.id === id);
    if (!skill) return;
    startAi(async () => {
      const result = await runAiSkill(id, text, workspaceId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      if (result.replacesSelection) {
        editor.chain().focus().insertContentAt({ from, to }, result.text).run();
      } else {
        editor
          .chain()
          .focus()
          .insertContentAt(to, {
            type: "paragraph",
            content: [{ type: "text", text: result.text }],
          })
          .run();
      }
      toast.success(`${skill.label} applied`);
    });
  };

  // Inline math: hand the current selection to the shared equation editor so it
  // opens pre-filled, then the Mathematics extension inserts the confirmed
  // LaTeX in place. Reuses the extension's existing event contract.
  const openInlineMath = () => {
    const { from, to } = editor.state.selection;
    const latex =
      from === to ? "" : editor.state.doc.textBetween(from, to, " ");
    window.dispatchEvent(
      new CustomEvent(EQUATION_EVENT, { detail: { kind: "inline", latex } }),
    );
  };

  const colorSwatches = swatchChoices("text");
  const highlightSwatches = swatchChoices("highlight");

  return (
    <div
      data-bubble-toolbar
      className="surface-raised flex items-center gap-0.5 p-1"
    >
      <BubbleButton label={t(locale, "bold")} active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="h-4 w-4" />
      </BubbleButton>
      <BubbleButton label={t(locale, "italic")} active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="h-4 w-4" />
      </BubbleButton>
      <BubbleButton label={t(locale, "underline")} active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <UnderlineIcon className="h-4 w-4" />
      </BubbleButton>
      <BubbleButton label={t(locale, "strikethrough")} active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough className="h-4 w-4" />
      </BubbleButton>
      <BubbleButton label={t(locale, "code")} active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code className="h-4 w-4" />
      </BubbleButton>

      <Separator orientation="vertical" className="mx-1 h-5 self-center" />

      <Popover open={panel === "color"} onOpenChange={(open) => setPanelOpen("color", open)}>
        <Tooltip label={t(locale, "textColor")}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t(locale, "textColor")}
              aria-pressed={panel === "color"}
              onMouseDown={(event) => event.preventDefault()}
              className={bubbleButtonClass({ active: panel === "color" })}
            >
              <Palette className="h-4 w-4" />
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent align="center" className="w-auto p-2">
          <div
            role="group"
            aria-label={t(locale, "colorLabel")}
            className="grid grid-cols-5 gap-1"
          >
            {colorSwatches.map((choice) => (
              <SwatchButton
                key={choice.labelKey}
                kind="text"
                choice={choice}
                locale={locale}
                active={isActiveSwatch(activeTextColor, choice.value)}
                onPick={applyTextColor}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Popover open={panel === "highlight"} onOpenChange={(open) => setPanelOpen("highlight", open)}>
        <Tooltip label={t(locale, "highlight")}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t(locale, "highlight")}
              aria-pressed={panel === "highlight"}
              onMouseDown={(event) => event.preventDefault()}
              className={bubbleButtonClass({ active: panel === "highlight" })}
            >
              <Highlighter className="h-4 w-4" />
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent align="center" className="w-auto p-2">
          <div
            role="group"
            aria-label={t(locale, "highlight")}
            className="grid grid-cols-5 gap-1"
          >
            {highlightSwatches.map((choice) => (
              <SwatchButton
                key={choice.labelKey}
                kind="highlight"
                choice={choice}
                locale={locale}
                active={isActiveSwatch(activeHighlightColor, choice.value)}
                onPick={applyHighlight}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Popover
        open={panel === "link"}
        onOpenChange={(open) => {
          if (open) primeLink();
          setPanelOpen("link", open);
        }}
      >
        <Tooltip
          label={
            activeHref ? `${t(locale, "link")}: ${activeHref}` : t(locale, "link")
          }
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t(locale, "link")}
              aria-pressed={editor.isActive("link")}
              onMouseDown={(event) => event.preventDefault()}
              className={bubbleButtonClass({ active: editor.isActive("link") })}
            >
              <Link2 className="h-4 w-4" />
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent align="center" className="w-72">
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted">
              {t(locale, "link")}
              <input
                type="text"
                value={link.title}
                onChange={(event) =>
                  dispatchLink({ type: "setTitle", value: event.target.value })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyLink();
                  }
                }}
                className="focus-ring h-8 rounded-control border-control bg-bg px-2 text-sm text-fg"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              {t(locale, "linkUrl")}
              <input
                type="url"
                inputMode="url"
                value={link.url}
                placeholder={t(locale, "linkPastePlaceholder")}
                onChange={(event) =>
                  dispatchLink({ type: "setUrl", value: event.target.value })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyLink();
                  }
                }}
                className="focus-ring h-8 rounded-control border-control bg-bg px-2 text-sm text-fg"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={link.newTab}
                onChange={(event) =>
                  dispatchLink({ type: "setNewTab", value: event.target.checked })
                }
                className="focus-ring size-4 rounded-xs border border-border"
              />
              {t(locale, "openInNewTab")}
            </label>
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  editor.chain().focus().extendMarkRange("link").unsetLink().run();
                  setPanel(null);
                }}
                className="focus-ring u-colors h-8 rounded-control px-2 text-sm text-danger hover:bg-danger-soft"
              >
                {t(locale, "remove")}
              </button>
              <button
                type="button"
                aria-label={t(locale, "apply")}
                onClick={applyLink}
                className="focus-ring u-colors h-8 rounded-control bg-action px-3 text-sm font-medium text-action-fg hover:bg-action/90"
              >
                {t(locale, "apply")}
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Separator orientation="vertical" className="mx-1 h-5 self-center" />

      <BubbleButton
        label={t(locale, "comment")}
        onClick={() => {
          const { from, to } = editor.state.selection;
          const quote = editor.state.doc.textBetween(from, to, " ").trim().slice(0, 300);
          window.dispatchEvent(
            new CustomEvent(COMMENT_EVENT, { detail: { quote } }),
          );
        }}
      >
        <MessageSquare className="h-4 w-4" />
      </BubbleButton>

      <Popover open={panel === "ai"} onOpenChange={(open) => setPanelOpen("ai", open)}>
        <Tooltip label={t(locale, "askAI")}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t(locale, "askAI")}
              aria-pressed={panel === "ai"}
              onMouseDown={(event) => event.preventDefault()}
              className={bubbleButtonClass({ active: panel === "ai" })}
            >
              <Sparkles className="h-4 w-4" />
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent align="center" className="w-60 p-1">
          <div className="flex flex-col">
            {AI_SKILLS.map((skill) => (
              <button
                key={skill.id}
                type="button"
                disabled={aiPending}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setPanel(null);
                  applySkill(skill.id);
                }}
                className="focus-ring u-colors flex flex-col rounded-control px-2 py-1 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
              >
                <span>{skill.label}</span>
                <span className="text-xs text-muted">{skill.hint}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Rare marks collapse into an overflow menu at narrow widths. */}
      <div className="hidden items-center gap-0.5 sm:flex">
        <Separator orientation="vertical" className="mx-1 h-5 self-center" />
        {TRANSFORM_ACTIONS.map((transform) => (
          <BubbleButton
            key={transform.kind}
            label={transform.label}
            onClick={() => applyTransform(transform.kind)}
          >
            {transform.kind === "uppercase" ? (
              <CaseUpper className="h-4 w-4" />
            ) : (
              <CaseLower className="h-4 w-4" />
            )}
          </BubbleButton>
        ))}
        <BubbleButton
          label={t(locale, "clearFormatting")}
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
        >
          <Eraser className="h-4 w-4" />
        </BubbleButton>
        <BubbleButton label={t(locale, "inlineEquation")} onClick={openInlineMath}>
          <Sigma className="h-4 w-4" />
        </BubbleButton>
      </div>

      <DropdownMenu>
        <Tooltip label={OVERFLOW_LABEL}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={OVERFLOW_LABEL}
              onMouseDown={(event) => event.preventDefault()}
              className={cn(bubbleButtonClass(), "sm:hidden")}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>{OVERFLOW_LABEL}</DropdownMenuLabel>
          {TRANSFORM_ACTIONS.map((transform) => (
            <DropdownMenuItem
              key={transform.kind}
              onSelect={() => applyTransform(transform.kind)}
            >
              {transform.kind === "uppercase" ? (
                <CaseUpper className="h-4 w-4" />
              ) : (
                <CaseLower className="h-4 w-4" />
              )}
              {transform.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
          >
            <Eraser className="h-4 w-4" />
            {t(locale, "clearFormatting")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openInlineMath}>
            <Sigma className="h-4 w-4" />
            {t(locale, "inlineEquation")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * One swatch cell. Exported so the description toolbar's colour panel is the same
 * control as the page editor's, down to the clear cell and its label.
 */
export function SwatchButton({
  kind,
  choice,
  active,
  locale,
  onPick,
}: {
  kind: SwatchKind;
  choice: SwatchChoice;
  active: boolean;
  locale: string;
  onPick: (value: string | null) => void;
}) {
  const label = t(locale, choice.labelKey);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      data-active={active ? "true" : undefined}
      data-swatch={kind}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onPick(choice.value)}
      className={swatchButtonClass(active)}
      style={choice.value ? { background: choice.value } : undefined}
    >
      {choice.value ? null : (
        <Ban className="h-3.5 w-3.5 text-muted" aria-hidden />
      )}
    </button>
  );
}

function BubbleButton({
  label,
  tooltip,
  active,
  onClick,
  children,
}: {
  label: string;
  tooltip?: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={tooltip ?? label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        className={bubbleButtonClass({ active })}
      >
        {children}
      </button>
    </Tooltip>
  );
}
