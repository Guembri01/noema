"use client";

/**
 * Topbar Actions (⋯) menu — B11 parity with Notion's page-actions dialog.
 *
 * - role="dialog" + aria-modal, 256px wide (Notion's Actions dialog)
 * - "Search actions…" combobox filtering a listbox live, arrow-key navigation
 * - canonical Notion item order comes from src/lib/actions-menu.ts (pure)
 * - one submenu level (Move to, Use with AI, Translate, Export, Notify me,
 *   Connections, workspace/teamspace moves) + in-dialog Customize/Updates views
 * - footer: word count, reading time, "Last edited by …", local timestamp
 *
 * Strings are plain English on purpose: page-title/topbar stays un-translated
 * until the B13 i18n tranche converts it.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { ArrowLeft, Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { LOCALES } from "@/lib/i18n";
import { localTime } from "@/lib/time";
import {
  filterMenuItems,
  formatFooterTime,
  formatShortcut,
  groupMenuItems,
  visibleMenuItems,
  type MenuItem,
} from "@/lib/actions-menu";
import {
  parseAppearance,
  type PageAppearance,
  type PageFont,
  type PageLineSpacing,
} from "@/lib/page-appearance";
import {
  DEFAULT_COVER_POSITION,
  formatObjectPosition,
  parseCoverPosition,
  type CoverPosition,
} from "@/lib/cover-position";
import {
  GRADIENTS,
  coverCss,
  validateCover,
  type CoverValue,
  type GradientId,
} from "@/lib/page-cover";
import { PAGE_ICON_EMOJI, isEmoji, isImageIcon } from "@/lib/page-icon";
import { computeStats, type TextBlock } from "@/lib/text-stats";
import type { PageMenuData } from "@/server/actions/page-menu";

/**
 * Icon and cover catalogs are owned by `page-icon.ts` / `page-cover.ts`; the
 * menu only re-exports the legacy names so existing callers (page-title) keep
 * working. The extra legacy emoji are additive — no picker option is dropped.
 */
const LEGACY_EMOJIS: readonly string[] = [
  "📄", "📝", "📌", "📚", "🗂️", "✅", "💡", "🚀", "🎯", "🔥", "⭐", "🧠",
  "🗓️", "🎨", "📊", "🔖", "🧩", "🛠️", "🌱", "☕", "🎧", "🏷️", "🔬", "🧪",
];

export const EMOJIS: readonly string[] = Object.freeze(
  Array.from(new Set<string>([...LEGACY_EMOJIS, ...PAGE_ICON_EMOJI])),
);

/** Gradient presets as CSS values, straight from the persisted catalog. */
export const COVERS: readonly string[] = Object.freeze(Object.values(GRADIENTS));

/** Stable preset ids, in catalog order. */
const GRADIENT_IDS = Object.keys(GRADIENTS) as GradientId[];

/** Reverse lookup: a persisted gradient CSS value → its preset id. */
const GRADIENT_ID_BY_CSS: ReadonlyMap<string, GradientId> = new Map(
  GRADIENT_IDS.map((id) => [GRADIENTS[id], id] as const),
);

/** A persisted cover decoded through the page-cover engine. */
type ResolvedCover = { value: CoverValue; position: CoverPosition };

/**
 * Split a stored cover string into its CSS value and the focal point the menu
 * encodes after it (`"<css> <x>% <y>%"`). A cover without a position decodes to
 * the centred default.
 */
function splitCoverCss(raw: string): { css: string; position: CoverPosition } {
  const match = raw.match(/^(.*\S)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!match) return { css: raw, position: { ...DEFAULT_COVER_POSITION } };
  return {
    css: match[1],
    position: parseCoverPosition(`${match[2]}% ${match[3]}%`),
  };
}

/**
 * Decode a persisted cover string into a tagged {@link CoverValue} plus its
 * focal point, or `null` when it is absent or unrecognised. Gradients are
 * matched by catalog value and images must pass {@link isImageIcon}, so a
 * hostile string never reaches the renderer as a cover.
 */
function readCover(raw: string | null): ResolvedCover | null {
  if (!raw) return null;
  const { css, position } = splitCoverCss(raw);
  const gradientId = GRADIENT_ID_BY_CSS.get(css);
  if (gradientId) return { value: { type: "gradient", gradientId }, position };
  if (isImageIcon(css)) return { value: { type: "image", url: css }, position };
  return null;
}

/**
 * Encode a validated cover + focal point back into the single `coverUrl`
 * string the existing save path persists. The default focal point is omitted
 * so a plain preset round-trips byte-for-byte.
 */
function writeCover(value: CoverValue, position: CoverPosition): string {
  const css = coverCss(value);
  if (css === "") return "";
  const focal = formatObjectPosition(position);
  return focal === formatObjectPosition(DEFAULT_COVER_POSITION)
    ? css
    : `${css} ${focal}`;
}

/** Preset focal points offered by the position grid. */
const POSITION_PRESETS: readonly { label: string; position: CoverPosition }[] = [
  { label: "Top left", position: { x: 0, y: 0 } },
  { label: "Top", position: { x: 50, y: 0 } },
  { label: "Top right", position: { x: 100, y: 0 } },
  { label: "Left", position: { x: 0, y: 50 } },
  { label: "Center", position: { x: 50, y: 50 } },
  { label: "Right", position: { x: 100, y: 50 } },
  { label: "Bottom left", position: { x: 0, y: 100 } },
  { label: "Bottom", position: { x: 50, y: 100 } },
  { label: "Bottom right", position: { x: 100, y: 100 } },
];

const FONT_OPTIONS: { id: PageFont; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Mono" },
];

const LINE_SPACING_OPTIONS: { id: PageLineSpacing; label: string }[] = [
  { id: "tight", label: "Tight" },
  { id: "normal", label: "Normal" },
  { id: "loose", label: "Loose" },
];

const EXPORTS = [
  { format: "md", label: "Markdown (.md)" },
  { format: "json", label: "JSON (.json)" },
  { format: "html", label: "HTML (.html)" },
  { format: "pdf", label: "PDF (.pdf)" },
];

const LIST_ID = "actions-menu-list";

export type NotifyLevel = "all" | "mentions" | "none";
export type ActionsMenuToggleKey = "smallText" | "fullWidth" | "locked";

type SubEntry = {
  key: string;
  label: string;
  detail?: string | null;
  checked?: boolean;
  disabled?: boolean;
  href?: string;
  onSelect?: () => void;
};

type SubSection = { label?: string; entries: SubEntry[] };
type SubmenuSpec = { label: string; sections: SubSection[] };

type ActionsMenuProps = {
  pageId: string;
  title: string;
  editable: boolean;
  font: string;
  fullWidth: boolean;
  smallText: boolean;
  locked: boolean;
  cover: string | null;
  data: PageMenuData | null;
  notifyLevel: NotifyLevel;
  /** Resolved page appearance; falls back to the legacy font/smallText props. */
  appearance?: PageAppearance;
  /** Document block tree for the text-stats footer, when available. */
  content?: TextBlock[];
  workspaces: { id: string; name: string; slug: string }[];
  teamspaces: { id: string; name: string; icon: string | null }[];
  onOpening: () => void;
  onToggle: (key: ActionsMenuToggleKey) => void;
  onStyle: (font: string) => void;
  /** Preferred appearance handler (partial patch); onStyle is the fallback. */
  onAppearance?: (patch: Partial<PageAppearance>) => void;
  onCopyLink: () => void;
  onCopyContents: () => void;
  onDuplicate: () => void;
  onMoveTo: (targetId: string | null) => void;
  onTrash: () => void;
  onUndo: () => void;
  onImport: () => void;
  onVersionHistory: () => void;
  onNotify: (level: NotifyLevel) => void;
  onWorkspaceMove: (workspaceId: string) => void;
  onMoveTeamspace: (teamspaceId: string | null) => void;
  onShareAccess: () => void;
  onChatPrompt: (prompt: string) => void;
  onPickIcon: (emoji: string) => void;
  onPickCover: (cover: string | null) => void;
};

export function ActionsMenu(props: ActionsMenuProps) {
  const {
    pageId,
    title,
    editable,
    font,
    smallText,
    fullWidth,
    locked,
    cover,
    data,
    notifyLevel,
    appearance,
    content,
    workspaces,
    teamspaces,
    onOpening,
    onToggle,
    onStyle,
    onAppearance,
    onCopyLink,
    onCopyContents,
    onDuplicate,
    onMoveTo,
    onTrash,
    onUndo,
    onImport,
    onVersionHistory,
    onNotify,
    onWorkspaceMove,
    onMoveTeamspace,
    onShareAccess,
    onChatPrompt,
    onPickIcon,
    onPickCover,
  } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [view, setView] = useState<"main" | "customize" | "updates">("main");
  const [submenu, setSubmenu] = useState<{
    id: string;
    top: number;
    focus: boolean;
  } | null>(null);
  const [subIndex, setSubIndex] = useState(0);
  // The persisted cover string is re-read through the page-cover engine: the
  // tagged value says which swatch is active and how the banner paints, while
  // the focal point is the cover position carried after the CSS value.
  const storedCover = useMemo(() => readCover(cover), [cover]);
  const [coverPosition, setCoverPosition] = useState<CoverPosition>(
    () => readCover(cover)?.position ?? { ...DEFAULT_COVER_POSITION },
  );
  const { setTheme, theme } = useTheme();

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const liRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const subRefs = useRef<Record<string, HTMLElement | null>>({});
  const specRef = useRef<SubmenuSpec | null>(null);

  // ---- data model ---------------------------------------------------------
  const baseItems = useMemo(
    () =>
      visibleMenuItems({ editable, locked }).filter((item) => {
        if (item.id === "workspace-move") return workspaces.length > 0;
        if (item.id === "teamspace-move") return teamspaces.length > 0;
        return true;
      }),
    [editable, locked, workspaces.length, teamspaces.length],
  );
  const groups = useMemo(
    () => groupMenuItems(filterMenuItems(query, baseItems)),
    [query, baseItems],
  );
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const indexOf = useMemo(
    () => new Map(flat.map((item, index) => [item.id, index])),
    [flat],
  );
  const active = activeIndex >= 0 && activeIndex < flat.length ? activeIndex : -1;
  const activeItem = active >= 0 ? flat[active] : null;

  // One resolved appearance drives every style control. When the caller wires
  // the page-appearance engine it wins; otherwise the legacy font/smallText
  // props are parsed through the same sanitizer so both paths behave alike.
  const resolvedAppearance = useMemo<PageAppearance>(
    () =>
      appearance ??
      parseAppearance({
        fontSize: smallText ? "small" : "default",
        font,
        lineSpacing: "normal",
      }),
    [appearance, smallText, font],
  );

  // text-stats is the preferred tally; the server's formatWordStats number is
  // only a fallback while (or when) the document is unavailable.
  const pageStats = useMemo(
    () => (content ? computeStats(content) : null),
    [content],
  );
  const statWords = pageStats?.words ?? data?.stats.words ?? 0;
  const statReading = pageStats
    ? pageStats.readingTimeLabel
    : (data?.stats.reading ?? "less than a minute");

  const toggleState: Record<string, boolean> = {
    "small-text": resolvedAppearance.fontSize === "small",
    "full-width": fullWidth,
    lock: locked,
  };

  // ---- submenu spec -------------------------------------------------------
  const closeAll = () => {
    setSubmenu(null);
    setOpen(false);
  };

  const buildSubmenu = (id: string): SubmenuSpec | null => {
    switch (id) {
      case "move-to":
        return {
          label: "Move to",
          sections: [
            {
              entries: [
                {
                  key: "root",
                  label: "Top level",
                  onSelect: () => {
                    onMoveTo(null);
                    closeAll();
                  },
                },
                ...(data?.moveTargets ?? []).map((target) => ({
                  key: target.id,
                  label: target.icon ? `${target.icon} ${target.title}` : target.title,
                  onSelect: () => {
                    onMoveTo(target.id);
                    closeAll();
                  },
                })),
              ],
            },
          ],
        };
      case "use-ai":
        return {
          label: "Use with AI",
          sections: [
            {
              entries: [
                {
                  key: "ask",
                  label: "Ask about this page",
                  onSelect: () => {
                    onChatPrompt(
                      `I'm looking at the page "${title}". What is this page about? Give me the key context and takeaways.`,
                    );
                    closeAll();
                  },
                },
                {
                  key: "summarize",
                  label: "Summarize",
                  onSelect: () => {
                    onChatPrompt(
                      `Summarize the page "${title}" in 3–6 short bullet points.`,
                    );
                    closeAll();
                  },
                },
                {
                  key: "translate-selection",
                  label: "Translate selection",
                  onSelect: () => {
                    onChatPrompt(
                      `Translate my current selection from the page "${title}". If nothing is selected, translate the whole page. Return only the translation.`,
                    );
                    closeAll();
                  },
                },
              ],
            },
          ],
        };
      case "translate":
        return {
          label: "Translate",
          sections: [
            {
              entries: LOCALES.map((locale) => ({
                key: locale.code,
                label: locale.label,
                onSelect: () => {
                  onChatPrompt(
                    `Translate the page "${title}" into ${locale.label}. Keep the headings and lists; return only the translation.`,
                  );
                  closeAll();
                },
              })),
            },
          ],
        };
      case "export":
        return {
          label: "Export",
          sections: [
            {
              entries: EXPORTS.map((option) => ({
                key: option.format,
                label: option.label,
                href: `/api/export/page/${pageId}?format=${option.format}`,
                onSelect: () => {
                  const anchor = document.createElement("a");
                  anchor.href = `/api/export/page/${pageId}?format=${option.format}`;
                  anchor.download = "";
                  anchor.click();
                  closeAll();
                },
              })),
            },
          ],
        };
      case "notify":
        return {
          label: "Notify me",
          sections: [
            {
              label: "Comments",
              entries: [
                {
                  key: "all",
                  label: "All",
                  checked: notifyLevel === "all",
                  onSelect: () => onNotify("all"),
                },
                {
                  key: "mentions",
                  label: "Mentions",
                  checked: notifyLevel === "mentions",
                  onSelect: () => onNotify("mentions"),
                },
                {
                  key: "none",
                  label: "None",
                  checked: notifyLevel === "none",
                  onSelect: () => onNotify("none"),
                },
              ],
            },
          ],
        };
      case "connections": {
        const connections = data?.connections ?? [];
        return {
          label: "Connections",
          sections: [
            {
              entries:
                connections.length > 0
                  ? connections.map((connection) => ({
                      key: connection.id,
                      label: connection.label,
                      detail: connection.detail,
                      disabled: true,
                    }))
                  : [{ key: "none", label: "None", disabled: true }],
            },
          ],
        };
      }
      case "workspace-move":
        return {
          label: "Move to workspace",
          sections: [
            {
              entries: workspaces.map((workspace) => ({
                key: workspace.id,
                label: workspace.name,
                onSelect: () => {
                  onWorkspaceMove(workspace.id);
                  closeAll();
                },
              })),
            },
          ],
        };
      case "teamspace-move":
        return {
          label: "Move to teamspace",
          sections: [
            {
              entries: [
                ...teamspaces.map((teamspace) => ({
                  key: teamspace.id,
                  label: teamspace.icon
                    ? `${teamspace.icon} ${teamspace.name}`
                    : teamspace.name,
                  onSelect: () => {
                    onMoveTeamspace(teamspace.id);
                    closeAll();
                  },
                })),
                {
                  key: "none",
                  label: "None",
                  onSelect: () => {
                    onMoveTeamspace(null);
                    closeAll();
                  },
                },
              ],
            },
          ],
        };
      default:
        return null;
    }
  };

  const subSpec = submenu ? buildSubmenu(submenu.id) : null;
  specRef.current = subSpec;

  // ---- open / close -------------------------------------------------------
  const openMenu = () => {
    setQuery("");
    setActiveIndex(-1);
    setView("main");
    setSubmenu(null);
    setSubIndex(0);
    onOpening();
    setOpen(true);
  };

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Re-seed the focal point whenever the persisted cover changes (a pick here
  // or a parent refresh), so the position grid reflects stored state.
  useEffect(() => {
    setCoverPosition(storedCover?.position ?? { ...DEFAULT_COVER_POSITION });
  }, [storedCover]);

  // Close when clicking outside the trigger + dialog wrapper.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && wrapperRef.current && !wrapperRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // Escape: submenu → back to list; customize/updates → main view; else close.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (submenu) setSubmenu(null);
      else if (view !== "main") setView("main");
      else setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, submenu, view]);

  const openSubmenuFor = (item: MenuItem, focus: boolean) => {
    const top = liRefs.current[item.id]?.offsetTop ?? 0;
    setSubIndex(0);
    setSubmenu({ id: item.id, top, focus });
  };

  // Keyboard focus into the submenu (only when opened via the keyboard).
  useEffect(() => {
    if (!submenu?.focus) return;
    const entries = specRef.current?.sections.flatMap((section) => section.entries) ?? [];
    const target = entries[Math.min(subIndex, Math.max(entries.length - 1, 0))];
    if (!target) return;
    subRefs.current[`${submenu.id}:${target.key}`]?.focus();
  }, [submenu, subIndex]);

  const activateItem = (item: MenuItem) => {
    if (item.kind === "disabled") return;
    if (item.kind === "submenu") {
      openSubmenuFor(item, true);
      return;
    }
    if (item.kind === "toggle") {
      if (item.id === "small-text") {
        if (onAppearance) {
          onAppearance({
            fontSize:
              resolvedAppearance.fontSize === "small" ? "default" : "small",
          });
        } else {
          onToggle("smallText");
        }
      } else if (item.id === "full-width") onToggle("fullWidth");
      else if (item.id === "lock") onToggle("locked");
      return;
    }
    switch (item.id) {
      case "copy-link":
        onCopyLink();
        closeAll();
        break;
      case "copy-contents":
        onCopyContents();
        closeAll();
        break;
      case "duplicate":
        onDuplicate();
        closeAll();
        break;
      case "trash":
        onTrash();
        closeAll();
        break;
      case "customize":
        setSubmenu(null);
        setView("customize");
        break;
      case "suggest":
        onChatPrompt(
          `Review the page "${title}" and suggest concrete edits: clarity, structure, grammar, and anything missing. List each suggestion as a separate item.`,
        );
        closeAll();
        break;
      case "undo":
        onUndo();
        closeAll();
        break;
      case "import":
        onImport();
        closeAll();
        break;
      case "updates":
        setSubmenu(null);
        setView("updates");
        break;
      case "history":
        onVersionHistory();
        closeAll();
        break;
      case "share-access":
        onShareAccess();
        closeAll();
        break;
      default:
        closeAll();
    }
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) =>
        flat.length === 0
          ? -1
          : index < flat.length - 1
            ? index + 1
            : 0,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) =>
        flat.length === 0 ? -1 : index <= 0 ? flat.length - 1 : index - 1,
      );
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(flat.length > 0 ? 0 : -1);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(flat.length > 0 ? flat.length - 1 : -1);
    } else if (event.key === "Enter") {
      if (active >= 0) {
        event.preventDefault();
        activateItem(flat[active]);
      }
    } else if (event.key === "ArrowRight") {
      if (activeItem?.kind === "submenu") {
        event.preventDefault();
        openSubmenuFor(activeItem, true);
      }
    } else if (event.key === "ArrowLeft") {
      if (submenu) {
        event.preventDefault();
        setSubmenu(null);
        inputRef.current?.focus();
      }
    }
  };

  const onSubmenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const entries =
      specRef.current?.sections.flatMap((section) => section.entries) ?? [];
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSubIndex((index) => (entries.length === 0 ? 0 : (index + 1) % entries.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSubIndex((index) =>
        entries.length === 0
          ? 0
          : (index - 1 + entries.length) % entries.length,
      );
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSubmenu(null);
      inputRef.current?.focus();
    } else if (event.key === "Enter") {
      const entry = entries[subIndex];
      if (entry && !entry.disabled) {
        event.preventDefault();
        entry.onSelect?.();
      }
    }
  };

  // ---- views --------------------------------------------------------------
  const backToMain = () => {
    setView("main");
    inputRef.current?.focus();
  };

  // Persist through the existing onPickCover path: a null clears the cover,
  // otherwise the tagged value is validated and re-encoded as a CSS string so
  // page-title's `background` render and the server column are unchanged.
  const pickCoverValue = (value: CoverValue | null) => {
    if (value === null || !validateCover(value).valid) {
      onPickCover(null);
      return;
    }
    onPickCover(writeCover(value, coverPosition));
  };

  const pickCoverPosition = (position: CoverPosition) => {
    setCoverPosition(position);
    if (storedCover) onPickCover(writeCover(storedCover.value, position));
  };

  // Only a glyph or an absolute http(s) image URL may become a page icon, so a
  // stray stored value can never be round-tripped back through the picker.
  const pickIcon = (candidate: string) => {
    if (isEmoji(candidate) || isImageIcon(candidate)) onPickIcon(candidate);
  };

  if (!open) {
    return (
      <div ref={wrapperRef} className="relative">
        <TriggerButton open={false} onToggleOpen={openMenu} />
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className="relative">
      <TriggerButton open onToggleOpen={() => setOpen(false)} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Page actions"
        className="absolute end-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-bg shadow-2xl"
      >
        {view === "main" ? (
          <>
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls={LIST_ID}
              aria-autocomplete="list"
              aria-label="Search actions…"
              aria-activedescendant={
                activeItem ? `${LIST_ID}-opt-${activeItem.id}` : undefined
              }
              placeholder="Search actions…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(-1);
                setSubmenu(null);
              }}
              onKeyDown={onInputKeyDown}
              className="w-full border-b border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted"
            />
            {query.trim() === "" && (
              <div
                role="radiogroup"
                aria-label="Font style"
                className="flex gap-1 border-b border-border px-2 py-1.5"
              >
                {FONT_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={resolvedAppearance.font === option.id}
                    onClick={() => {
                      if (onAppearance) onAppearance({ font: option.id });
                      else onStyle(option.id);
                    }}
                    className={cn(
                      "flex-1 rounded px-1 py-1 text-xs text-muted hover:bg-surface-2",
                      resolvedAppearance.font === option.id && "bg-surface-2 text-fg",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            {query.trim() === "" && onAppearance && (
              <div
                role="radiogroup"
                aria-label="Line spacing"
                className="flex gap-1 border-b border-border px-2 py-1.5"
              >
                {LINE_SPACING_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={resolvedAppearance.lineSpacing === option.id}
                    onClick={() => onAppearance({ lineSpacing: option.id })}
                    className={cn(
                      "flex-1 rounded px-1 py-1 text-xs text-muted hover:bg-surface-2",
                      resolvedAppearance.lineSpacing === option.id &&
                        "bg-surface-2 text-fg",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            <ul
              id={LIST_ID}
              role="listbox"
              aria-label="Actions"
              className="max-h-72 overflow-y-auto py-1"
            >
              {groups.map((group, groupIndex) =>
                group.items.map((item) => {
                  const index = indexOf.get(item.id) ?? -1;
                  const checked = toggleState[item.id];
                  const isActive = active === index;
                  return (
                    <li
                      key={item.id}
                      id={`${LIST_ID}-opt-${item.id}`}
                      ref={(element) => {
                        liRefs.current[item.id] = element;
                      }}
                      role="option"
                      aria-selected={isActive}
                      aria-disabled={item.kind === "disabled" || undefined}
                      aria-haspopup={item.kind === "submenu" || undefined}
                      aria-expanded={
                        item.kind === "submenu"
                          ? submenu?.id === item.id
                          : undefined
                      }
                      title={item.kind === "disabled" ? item.hint : undefined}
                      onMouseEnter={() => {
                        setActiveIndex(index);
                        if (item.kind === "submenu") openSubmenuFor(item, false);
                        else if (submenu) setSubmenu(null);
                      }}
                      onClick={() => activateItem(item)}
                      className={cn(
                        "mx-1 flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm text-fg",
                        groupIndex > 0 &&
                          indexOf.get(group.items[0].id) === index &&
                          "mt-1 border-t border-border pt-2.5",
                        isActive && "bg-surface-2",
                        item.kind === "disabled" && "opacity-50",
                      )}
                    >
                      <span className="flex-1 truncate">
                        {item.label}
                        {item.kind === "toggle" && (
                          <span className="sr-only">{checked ? " (on)" : " (off)"}</span>
                        )}
                        {item.kind === "disabled" && item.hint && (
                          <span className="sr-only"> — {item.hint}</span>
                        )}
                      </span>
                      {item.kind === "toggle" && checked && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                      )}
                      {item.kind === "submenu" && (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                      )}
                      {item.shortcut && (
                        <span aria-hidden className="shrink-0 text-xs text-muted">
                          {formatShortcut(item.shortcut)}
                        </span>
                      )}
                    </li>
                  );
                }),
              )}
            </ul>
            {flat.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted">No matching actions</p>
            )}
            {submenu && subSpec && (
              <div
                role="menu"
                aria-label={subSpec.label}
                tabIndex={-1}
                onKeyDown={onSubmenuKeyDown}
                style={{ top: submenu.top }}
                className="absolute start-full z-50 min-w-48 max-w-64 overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-2xl outline-none"
              >
                {(() => {
                  let cursor = 0;
                  return subSpec.sections.map((section, sectionIndex) => {
                    const indexed = section.entries.map((entry) => ({
                      entry,
                      index: cursor++,
                    }));
                    const body = indexed.map(({ entry, index }) => (
                      <div
                        key={entry.key}
                        ref={(element) => {
                          subRefs.current[`${submenu.id}:${entry.key}`] = element;
                        }}
                        role={
                          entry.checked !== undefined ? "menuitemradio" : "menuitem"
                        }
                        aria-checked={entry.checked}
                        aria-disabled={entry.disabled || undefined}
                        tabIndex={-1}
                        onMouseEnter={() => setSubIndex(index)}
                        onClick={() => {
                          if (entry.disabled) return;
                          entry.onSelect?.();
                        }}
                        className={cn(
                          "mx-1 flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm",
                          index === subIndex && "bg-surface-2",
                          entry.disabled && "opacity-60",
                        )}
                      >
                        <span className="flex-1 truncate" title={entry.label}>
                          {entry.label}
                        </span>
                        {entry.detail && (
                          <span className="max-w-24 truncate text-xs text-muted">
                            {entry.detail}
                          </span>
                        )}
                        {entry.checked && (
                          <Check className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                        )}
                      </div>
                    ));
                    if (section.label) {
                      return (
                        <Fragment key={sectionIndex}>
                          <div role="group" aria-label={section.label} className="py-1">
                            <p className="px-3 pb-1 text-xs font-medium text-muted">
                              {section.label}
                            </p>
                            {body}
                          </div>
                        </Fragment>
                      );
                    }
                    return <Fragment key={sectionIndex}>{body}</Fragment>;
                  });
                })()}
              </div>
            )}
            <footer className="border-t border-border px-3 py-2 text-xs text-muted">
              {data ? (
                <>
                  <p>
                    {statWords} words · {statReading}
                  </p>
                  {data.lastEditedBy && <p>Last edited by {data.lastEditedBy}</p>}
                  <p>{formatFooterTime(data.updatedAt, new Date())}</p>
                </>
              ) : (
                <p>Loading…</p>
              )}
            </footer>
          </>
        ) : view === "customize" ? (
          <>
            <PanelHeader title="Customize page" onBack={backToMain} />
            <div className="max-h-80 overflow-y-auto p-2">
              <p className="mb-1 text-xs font-medium text-muted">Icon</p>
              <div className="grid grid-cols-8 gap-1">
                {EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`Set icon ${emoji}`}
                    onClick={() => pickIcon(emoji)}
                    className="grid h-7 w-7 place-items-center rounded text-lg hover:bg-surface-2"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <p className="mb-1 mt-3 text-xs font-medium text-muted">Cover</p>
              <div className="grid grid-cols-4 gap-1">
                {GRADIENT_IDS.map((id) => {
                  const selected =
                    storedCover?.value.type === "gradient" &&
                    storedCover.value.gradientId === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-label={`Set cover ${id}`}
                      aria-pressed={selected}
                      onClick={() =>
                        pickCoverValue({ type: "gradient", gradientId: id })
                      }
                      className={cn(
                        "h-10 rounded bg-cover bg-center",
                        selected && "ring-2 ring-accent",
                      )}
                      style={{
                        backgroundImage: coverCss({
                          type: "gradient",
                          gradientId: id,
                        }),
                        backgroundPosition: formatObjectPosition(coverPosition),
                      }}
                    />
                  );
                })}
              </div>
              {storedCover && (
                <>
                  <p className="mb-1 mt-3 text-xs font-medium text-muted">
                    Position
                  </p>
                  <div
                    role="group"
                    aria-label="Cover position"
                    className="grid w-24 grid-cols-3 gap-1"
                  >
                    {POSITION_PRESETS.map((preset) => {
                      const selected =
                        formatObjectPosition(coverPosition) ===
                        formatObjectPosition(preset.position);
                      return (
                        <button
                          key={preset.label}
                          type="button"
                          aria-label={`Cover position ${preset.label}`}
                          aria-pressed={selected}
                          onClick={() => pickCoverPosition(preset.position)}
                          className={cn(
                            "h-7 w-7 rounded border border-border",
                            selected && "bg-surface-2 ring-1 ring-accent",
                          )}
                        />
                      );
                    })}
                  </div>
                </>
              )}
              {storedCover && (
                <button
                  type="button"
                  onClick={() => pickCoverValue(null)}
                  className="mt-2 rounded px-1 py-0.5 text-xs text-muted hover:bg-surface-2"
                >
                  Remove cover
                </button>
              )}
              <p className="mb-1 mt-3 text-xs font-medium text-muted">Theme</p>
              <div role="radiogroup" aria-label="Theme" className="flex gap-1">
                {["light", "dark", "system"].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={theme === mode}
                    onClick={() => setTheme(mode)}
                    className={cn(
                      "flex-1 rounded px-2 py-1 text-xs capitalize text-muted hover:bg-surface-2",
                      theme === mode && "bg-surface-2 text-fg",
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <PanelHeader title="Updates & analytics" onBack={backToMain} />
            <div className="max-h-80 overflow-y-auto p-2 text-sm">
              {data ? (
                <>
                  <p>
                    {statWords} words · {statReading}
                  </p>
                  <p className="text-muted">
                    {data.lastEditedBy
                      ? `Last edited by ${data.lastEditedBy}`
                      : "No editor recorded"}
                  </p>
                  <p className="text-muted">{formatFooterTime(data.updatedAt, new Date())}</p>
                  <ul className="mt-2 space-y-2 border-t border-border pt-2">
                    {data.versions.length === 0 && (
                      <li className="text-xs text-muted">No edits recorded yet.</li>
                    )}
                    {data.versions.map((version) => (
                      <li key={version.id} className="text-xs text-muted">
                        <p className="text-fg">{version.summary ?? "Edited content"}</p>
                        <p>
                          {version.authorName ?? "Unknown"} · {localTime(version.createdAt)}
                          {version.charDelta !== null &&
                            ` · ${version.charDelta >= 0 ? "+" : ""}${version.charDelta}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-muted">Loading…</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TriggerButton({
  open,
  onToggleOpen,
}: {
  open: boolean;
  onToggleOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="Actions"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onToggleOpen}
      className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
    >
      <span aria-hidden className="text-lg leading-none">
        ⋯
      </span>
    </button>
  );
}

function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <button
        type="button"
        aria-label="Back to actions"
        onClick={onBack}
        className="rounded p-1 text-muted hover:bg-surface-2"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
      </button>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}
