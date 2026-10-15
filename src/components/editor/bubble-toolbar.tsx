import {
  useEffect,
  useRef,
  useState,
  useTransition
} from "react";
import { createPortal } from "react-dom";
import { type Editor } from "@tiptap/react";
import {
  Bold,
  CaseLower,
  CaseUpper,
  Code,
  Eraser,
  Highlighter,
  Italic,
  Link2,
  MessageSquare,
  Palette,
  Sigma,
  Sparkles,
  Strikethrough,
  Underline as UnderlineIcon,
  Unlink
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { COMMENT_EVENT } from "@/components/comment-panel";
import { EQUATION_EVENT } from "@/components/editor/equation-editor";
import { AI_SKILLS, type AiSkillId } from "@/lib/ai-skills";
import { runAiSkill } from "@/lib/ai-client";
import { Tooltip } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import {
  TEXT_TRANSFORMS,
  applyTextTransform,
  type TextTransformKind
} from "@/lib/text-transform";

type I18nKey = Parameters<typeof t>[1];

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

const HIGHLIGHTS: { labelKey: I18nKey; value: string | null }[] = [
  { labelKey: "colorNone", value: null },
  { labelKey: "colorGray", value: "#e3e2e0" },
  { labelKey: "colorYellow", value: "#fdecc8" },
  { labelKey: "colorGreen", value: "#dbeddb" },
  { labelKey: "colorBlue", value: "#d3e5ef" },
  { labelKey: "colorPurple", value: "#e8deee" },
  { labelKey: "colorPink", value: "#f5e0e9" },
  { labelKey: "colorRed", value: "#ffe2dd" },
  { labelKey: "colorOrange", value: "#fadec9" },
];

/* Case transforms offered as toolbar actions. `none` is the default and needs
   no button, so it is filtered out; labels/descriptions come from the shared
   catalog so the menu stays in sync with the transform engine. */
const TRANSFORM_ACTIONS = TEXT_TRANSFORMS.filter(
  (transform) => transform.kind !== "none",
);

/* ---------------------------------------------------------------------------
   Bubble menu
   --------------------------------------------------------------------------- */

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
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [panel, setPanel] = useState<null | "color" | "highlight" | "ai">(null);
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  const closePanel = () => {
    setPanel(null);
    onPanelOpenChange(false);
  };

  // Measure the toolbar at click time and portal the panel to a fixed position.
  // Radix popups inside the bubble menu lost their trigger and landed in the
  // viewport corner, so this menu is positioned explicitly instead.
  const togglePanel = (name: "color" | "highlight" | "ai") => {
    const next = panel === name ? null : name;
    if (next && toolbarRef.current) {
      const rect = toolbarRef.current.getBoundingClientRect();
      const width = next === "ai" ? 240 : 260;
      setPanelPos({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 12)),
        top: rect.bottom + 6,
      });
    }
    setPanel(next);
    onPanelOpenChange(next !== null);
  };

  // Dismiss the panel when the pointer goes elsewhere or Escape is pressed.
  useEffect(() => {
    if (!panel) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-bubble-panel]")) return;
      if (target?.closest("[data-bubble-toolbar]")) return;
      closePanel();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  });

  const applyTextColor = (value: string | null) => {
    if (value) editor.chain().focus().setColor(value).run();
    else editor.chain().focus().unsetColor().run();
    closePanel();
  };

  const applyHighlight = (value: string | null) => {
    if (value) editor.chain().focus().setHighlight({ color: value }).run();
    else editor.chain().focus().unsetHighlight().run();
    closePanel();
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

  const setLink = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setUrl("");
    setLinkOpen(false);
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

  return (
    <div
      ref={toolbarRef}
      data-bubble-toolbar
      className="flex items-center gap-0.5 rounded-lg border border-border bg-bg p-1 shadow-lg"
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
      <BubbleButton
        label={t(locale, "clearFormatting")}
        onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
      >
        <Eraser className="h-4 w-4" />
      </BubbleButton>
      <BubbleButton
        label={t(locale, "inlineEquation")}
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent(EQUATION_EVENT, { detail: { kind: "inline" } }),
          )
        }
      >
        <Sigma className="h-4 w-4" />
      </BubbleButton>

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

      <span className="mx-0.5 h-5 w-px bg-border" />

      <BubbleButton
        label={t(locale, "textColor")}
        active={panel === "color"}
        onClick={() => togglePanel("color")}
      >
        <Palette className="h-4 w-4" />
      </BubbleButton>

      <BubbleButton
        label={t(locale, "highlight")}
        active={panel === "highlight"}
        onClick={() => togglePanel("highlight")}
      >
        <Highlighter className="h-4 w-4" />
      </BubbleButton>

      <BubbleButton
        label={t(locale, "link")}
        active={editor.isActive("link")}
        onClick={() => {
          setUrl(editor.getAttributes("link").href ?? "");
          setLinkOpen((v) => !v);
        }}
      >
        <Link2 className="h-4 w-4" />
      </BubbleButton>
      {editor.isActive("link") && (
        <BubbleButton label={t(locale, "removeLink")} onClick={() => editor.chain().focus().unsetLink().run()}>
          <Unlink className="h-4 w-4" />
        </BubbleButton>
      )}

      {linkOpen && (
        <input
          autoFocus
          aria-label={t(locale, "linkUrl")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setLink();
            }
            if (e.key === "Escape") setLinkOpen(false);
          }}
          placeholder={t(locale, "linkPastePlaceholder")}
          className="ml-1 h-7 w-44 rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
        />
      )}

      <span className="mx-0.5 h-5 w-px bg-border" />

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

      <BubbleButton
        label={t(locale, "askAI")}
        active={panel === "ai"}
        onClick={() => togglePanel("ai")}
      >
        <Sparkles className="h-4 w-4" />
      </BubbleButton>

      {panel &&
        panelPos &&
        createPortal(
          <div
            data-bubble-panel
            style={{ position: "fixed", left: panelPos.left, top: panelPos.top }}
            className="z-[60] rounded-lg border border-border bg-bg p-1 shadow-xl"
          >
            {panel === "ai" ? (
              <div className="flex w-60 flex-col">
                {AI_SKILLS.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    disabled={aiPending}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      closePanel();
                      applySkill(skill.id);
                    }}
                    className="flex flex-col rounded px-2 py-1 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
                  >
                    <span>{skill.label}</span>
                    <span className="text-xs text-muted">{skill.hint}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-1">
                {(panel === "color" ? TEXT_COLORS : HIGHLIGHTS).map((choice) => (
                  <button
                    key={choice.labelKey}
                    type="button"
                    title={t(locale, choice.labelKey)}
                    aria-label={t(locale, choice.labelKey)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() =>
                      panel === "color"
                        ? applyTextColor(choice.value)
                        : applyHighlight(choice.value)
                    }
                    className="h-6 w-6 rounded border border-border"
                    style={{ background: choice.value ?? "transparent" }}
                  />
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

function BubbleButton({
  label,
  active,
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
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2",
          active && "bg-surface-2 text-fg",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}
