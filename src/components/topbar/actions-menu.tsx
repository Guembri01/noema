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
import { ArrowLeft, Check, ChevronRight, Lock, LockOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/design-tokens";
import { Switch } from "@/components/ui/switch";
import { Radio, RadioGroup } from "@/components/ui/radio";
import { Select, type SelectOption } from "@/components/ui/select";
import { Section } from "@/components/ui/section";
import { Separator } from "@/components/ui/separator";
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
  PAGE_FONTS,
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
import {
  AUDIT_RULES,
  auditDocument,
  summarizeAudit,
  type A11yBlock,
  type AuditCode,
} from "@/lib/a11y-audit";
import type { PageMenuData } from "@/server/actions/page-menu";
import {
  focusableSelector,
  resolveReturnTarget,
  trapPlan,
  type Focusable,
  type FocusPlan,
} from "@/lib/focus-trap";
import {
  HIGH_CONTRAST_TOKENS,
  contrastRatio,
  type ContrastTheme,
} from "@/lib/high-contrast";

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

/**
 * Presentation-only gradient previews built from the tag token palette
 * (`--tag-<hue>-*`), so the swatches emit token vars instead of the catalog's
 * raw hex. The *persisted* value still comes from `coverCss`/{@link writeCover}
 * (so it round-trips with `page-title.tsx`); only this menu's preview is
 * re-coloured, and each hue is the closest tag token to the preset it replaces.
 */
export const COVER_GRADIENT_TOKENS: Record<GradientId, string> = {
  ocean:
    "linear-gradient(120deg, var(--tag-blue-bg) 0%, var(--tag-teal-bd) 100%)",
  sunset:
    "linear-gradient(120deg, var(--tag-yellow-bg) 0%, var(--tag-orange-bd) 100%)",
  sky: "linear-gradient(120deg, var(--tag-blue-bg) 0%, var(--tag-teal-bg) 100%)",
  lime: "linear-gradient(120deg, var(--tag-green-bg) 0%, var(--tag-teal-bd) 100%)",
  candy:
    "linear-gradient(120deg, var(--tag-pink-bg) 0%, var(--tag-purple-bd) 100%)",
  blush:
    "linear-gradient(120deg, var(--tag-red-bg) 0%, var(--tag-pink-bd) 100%)",
  mint: "linear-gradient(120deg, var(--tag-green-bg) 0%, var(--tag-teal-bg) 100%)",
  lavender:
    "linear-gradient(120deg, var(--tag-purple-bg) 0%, var(--tag-blue-bd) 100%)",
};

/** Token-only preview for a gradient preset (see {@link COVER_GRADIENT_TOKENS}). */
export function coverPreviewCss(gradientId: GradientId): string {
  return COVER_GRADIENT_TOKENS[gradientId];
}

/** A persisted cover decoded through the page-cover engine. */
export type ResolvedCover = { value: CoverValue; position: CoverPosition };

/**
 * Split a stored cover string into its CSS value and the focal point the menu
 * encodes after it (`"<css> <x>% <y>%"`). A cover without a position decodes to
 * the centred default.
 */
export function splitCoverCss(raw: string): {
  css: string;
  position: CoverPosition;
} {
  const match = raw.match(/^(.*\S)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!match) return { css: raw, position: { ...DEFAULT_COVER_POSITION } };
  return {
    css: match[1],
    position: parseCoverPosition(`${match[2]}% ${match[3]}%`),
  };
}

/**
 * `url("…")` / `url(…)` wrapper emitted by `coverCss` for an image cover. Kept
 * byte-identical to the matcher in `page-title.tsx` so the two codecs agree.
 */
const COVER_URL_CSS = /^url\(\s*["']?([^"')]+)["']?\s*\)$/i;

/**
 * Decode a persisted cover string into a tagged {@link CoverValue} plus its
 * focal point, or `null` when it is absent or unrecognised. Gradients are
 * matched by catalog value and images must pass {@link isImageIcon}, so a
 * hostile string never reaches the renderer as a cover.
 *
 * An image cover is stored as the `url("…")` form `coverCss` (and therefore
 * `page-title.tsx`) writes, so that wrapper is unwrapped before the URL is
 * validated: without it every image cover written by the page header failed to
 * decode here (the codec bug this fixes).
 */
export function readCover(raw: string | null): ResolvedCover | null {
  if (!raw) return null;
  const { css, position } = splitCoverCss(raw);
  const gradientId = GRADIENT_ID_BY_CSS.get(css);
  if (gradientId) return { value: { type: "gradient", gradientId }, position };
  const imageMatch = COVER_URL_CSS.exec(css);
  const href = imageMatch ? imageMatch[1] : css;
  if (isImageIcon(href)) return { value: { type: "image", url: href }, position };
  return null;
}

/**
 * Encode a validated cover + focal point back into the single `coverUrl`
 * string the existing save path persists. The default focal point is omitted
 * so a plain preset round-trips byte-for-byte. Mirrors `page-title.tsx`'s
 * `encodeCover`, so a cover written here decodes there and vice-versa.
 */
export function writeCover(value: CoverValue, position: CoverPosition): string {
  const css = coverCss(value);
  if (css === "") return "";
  const focal = formatObjectPosition(position);
  return focal === formatObjectPosition(DEFAULT_COVER_POSITION)
    ? css
    : `${css} ${focal}`;
}

/** Preset focal points offered by the position grid. */
export const POSITION_PRESETS: readonly {
  label: string;
  position: CoverPosition;
}[] = [
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

/**
 * Human labels for every `PAGE_FONTS` preset. Kept next to the picker rather
 * than in the engine: the catalog is the single source of truth for *which*
 * presets exist (and their order), while display copy stays a presentation
 * concern. The picker is derived from `PAGE_FONTS`, so a preset added to the
 * engine surfaces here without editing this component.
 */
export const FONT_LABELS: Record<PageFont, string> = {
  default: "Default",
  serif: "Serif",
  sans: "Sans",
  mono: "Mono",
  literata: "Literata",
  newsreader: "Newsreader",
};

export const FONT_OPTIONS: { id: PageFont; label: string }[] = PAGE_FONTS.map(
  (id) => ({
    id,
    label: FONT_LABELS[id],
  }),
);

/** `<Select>` rows for the font picker, derived from {@link FONT_OPTIONS}. */
export const FONT_SELECT_OPTIONS: SelectOption[] = FONT_OPTIONS.map((option) => ({
  value: option.id,
  label: option.label,
}));

export const LINE_SPACING_OPTIONS: { id: PageLineSpacing; label: string }[] = [
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

/**
 * "Accessibility check" is owned by this component rather than
 * `lib/actions-menu.ts`: the canonical item list is an engine other surfaces
 * depend on, so the extra entry is appended additively here instead of editing
 * it. It sits in the `insights` group so it renders beside "Updates &
 * analytics" / "Version history" and still matches the live search box.
 */
const A11Y_CHECK_ITEM: MenuItem = {
  id: "a11y-check",
  label: "Accessibility check",
  group: "insights",
  kind: "action",
  keywords: ["a11y", "accessibility", "audit", "screen reader", "wcag"],
};

/** Flatten a `RichText` value to plain text; marks/attrs are not retained. */
function auditText(value: TextBlock["text"]): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map(auditText)
      .filter((part): part is string => typeof part === "string" && part !== "");
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.content)) {
      const parts = value.content
        .map(auditText)
        .filter((part): part is string => typeof part === "string" && part !== "");
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
  }
  return undefined;
}

/**
 * Project the text-stats block tree into the audit's `A11yBlock` shape. The
 * projection is structural only — `TextBlock` deliberately drops `attrs`,
 * `marks` and heading levels — so ids are synthesised from the node path and
 * `image` nodes are omitted: their `alt` is unknowable here, and flagging every
 * image as missing alt text would be a false positive (see report follow-ups).
 */
function toAuditBlocks(
  blocks: readonly TextBlock[],
  path = "0",
): A11yBlock[] {
  const result: A11yBlock[] = [];
  blocks.forEach((block, index) => {
    if (!block || typeof block.type !== "string") return;
    if (block.type === "image") return;
    const id = `${path}-${index}`;
    const children = block.children ? toAuditBlocks(block.children, id) : [];
    const text = auditText(block.text);
    result.push({
      id,
      type: block.type,
      ...(text !== undefined ? { text } : {}),
      ...(children.length > 0 ? { children } : {}),
    });
  });
  return result;
}

const LIST_ID = "actions-menu-list";

/**
 * localStorage key for the persisted high-contrast preference. The value is
 * `"1"` (on) / `"0"` (off); the class it toggles on the document root, and the
 * token set that class activates, are the ones mirrored by
 * `src/lib/high-contrast.ts` (`HIGH_CONTRAST_TOKENS`).
 */
export const HIGH_CONTRAST_KEY = "noema:high-contrast";

/* ------------------------------------------------------------------------- *
 * Focus management (shared kernel: @/lib/focus-trap)
 *
 * The Actions dialog is hand-rolled — it bypasses `ui/dialog` — so it owns its
 * own Tab trap: every browser-tabbable control inside the dialog is mapped to a
 * `Focusable` descriptor, `trapPlan` decides the next stop (wrapping at the
 * ends), and `resolveReturnTarget` restores focus to the invoking control when
 * the dialog closes. Escape keeps its existing handling (see the keydown
 * effect below).
 * ------------------------------------------------------------------------- */

/**
 * Tab / Shift+Tab plan for the Actions dialog, delegated to the shared
 * `@/lib/focus-trap` kernel. `activeId` is the id of the currently focused
 * stop (`null` when focus is outside the ring, which enters at the first stop —
 * the last on Shift+Tab). A `null` result means "nothing to trap"; the browser
 * keeps the default Tab move.
 */
export function planActionsMenuTab(
  stops: readonly Focusable[],
  { activeId = null, shift = false }: { activeId?: string | null; shift?: boolean } = {},
): FocusPlan | null {
  return trapPlan(stops, {
    initial: activeId === null ? null : { id: activeId },
    shift,
  });
}

/** The dialog's real tabbable elements, tagged with their index as the id. */
function actionsMenuStops(root: HTMLElement): {
  stops: Focusable[];
  nodes: HTMLElement[];
} {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
  const stops = nodes.map((element, index) => ({
    id: String(index),
    disabled:
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true",
    hidden: element.hidden || element.getAttribute("aria-hidden") === "true",
    tabIndex: element.tabIndex,
  }));
  return { stops, nodes };
}

export type NotifyLevel = "all" | "mentions" | "none";
export type ActionsMenuToggleKey = "smallText" | "fullWidth" | "locked";

/**
 * The payload a toggled row hands back: either the page-appearance patch (when
 * the engine is wired) or the legacy `onToggle` key. Both shapes are exactly
 * what the component already called — this just makes the mapping pure.
 */
export type ToggleAction =
  | { kind: "appearance"; patch: Partial<PageAppearance> }
  | { kind: "toggle"; key: ActionsMenuToggleKey };

/**
 * Map a toggle row id (`small-text` / `full-width` / `lock`) to its payload.
 * `smallText` is the resolved *current* state: the page-appearance path flips
 * it (the new patch is the opposite size), the legacy path reports the key and
 * lets `onToggle` do the flip. Returns `null` for a non-toggle id.
 */
export function resolveToggleAction(
  id: string,
  { smallText, hasAppearance }: { smallText: boolean; hasAppearance: boolean },
): ToggleAction | null {
  switch (id) {
    case "small-text":
      return hasAppearance
        ? {
            kind: "appearance",
            patch: { fontSize: smallText ? "default" : "small" },
          }
        : { kind: "toggle", key: "smallText" };
    case "full-width":
      return { kind: "toggle", key: "fullWidth" };
    case "lock":
      return { kind: "toggle", key: "locked" };
    default:
      return null;
  }
}

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
  const [view, setView] = useState<
    "main" | "customize" | "accessibility" | "updates"
  >("main");
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
  const { setTheme, theme, resolvedTheme } = useTheme();
  const [highContrast, setHighContrast] = useState(false);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const invokerRef = useRef<HTMLElement | null>(null);
  const liRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const subRefs = useRef<Record<string, HTMLElement | null>>({});
  const specRef = useRef<SubmenuSpec | null>(null);

  // ---- data model ---------------------------------------------------------
  const baseItems = useMemo(
    () => [
      ...visibleMenuItems({ editable, locked })
        .filter((item) => {
          if (item.id === "workspace-move") return workspaces.length > 0;
          if (item.id === "teamspace-move") return teamspaces.length > 0;
          return true;
        })
        // The Lock toggle is state-dependent: the same canonical row reads
        // "Lock page" when unlocked and "Unlock page" when locked. The label is
        // resolved here (not in `lib/actions-menu.ts`) so the engine's item list
        // stays static; only the presentation reacts to `locked`. Both spellings
        // are added as keywords so the row stays findable in either state.
        .map((item): MenuItem =>
          item.id === "lock"
            ? {
                ...item,
                label: locked ? "Unlock page" : "Lock page",
                keywords: Array.from(
                  new Set([...(item.keywords ?? []), "lock", "unlock"]),
                ),
              }
            : item,
        ),
      A11Y_CHECK_ITEM,
    ],
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

  // The accessibility check runs the pure audit engine over the same block
  // tree the footer stats use; it never throws and never blocks, so a missing
  // or malformed document just yields "content unavailable" / a clean report.
  const a11yReport = useMemo(() => {
    if (!content) return null;
    const issues = auditDocument(toAuditBlocks(content));
    return { issues, summary: summarizeAudit(issues) };
  }, [content]);

  const a11yBreakdown = useMemo(
    () =>
      a11yReport
        ? (Object.keys(AUDIT_RULES) as AuditCode[])
            .map((code) => ({
              code,
              title: AUDIT_RULES[code].title,
              count: a11yReport.summary.byCode[code] ?? 0,
            }))
            .filter((row) => row.count > 0)
        : [],
    [a11yReport],
  );

  const toggleState: Record<string, boolean> = {
    "small-text": resolvedAppearance.fontSize === "small",
    "full-width": fullWidth,
    lock: locked,
  };

  // Leading glyph for the state-dependent Lock/Unlock row. It mirrors the
  // action the row performs: a closed padlock offers to lock an open page, an
  // open padlock offers to unlock a locked one. The trailing check still marks
  // the toggle as on; the sr-only "(on)"/"(off)" text carries the same state
  // for assistive tech.
  const LockIcon = locked ? LockOpen : Lock;

  // Live contrast readout for the high-contrast toggle, straight from the
  // engine so the control reports the ratio the theme actually ships.
  const contrastTheme: ContrastTheme = resolvedTheme === "dark" ? "dark" : "light";
  const contrastLabel = `${contrastRatio(
    HIGH_CONTRAST_TOKENS[contrastTheme].fg,
    HIGH_CONTRAST_TOKENS[contrastTheme].bg,
  ).toFixed(1)}:1 body text`;

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

  // High-contrast preference: seeded from localStorage, then mirrored back onto
  // the document root's `.high-contrast` class (the token set `globals.css`
  // ships and `@/lib/high-contrast` documents).
  useEffect(() => {
    try {
      setHighContrast(window.localStorage.getItem(HIGH_CONTRAST_KEY) === "1");
    } catch {
      // Storage unavailable (private mode): keep the in-memory default.
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("high-contrast", highContrast);
    try {
      window.localStorage.setItem(HIGH_CONTRAST_KEY, highContrast ? "1" : "0");
    } catch {
      // Ignore a storage write failure; the class above already applied.
    }
  }, [highContrast]);

  // Record the invoking control on open and restore focus to it on close
  // (`resolveReturnTarget` returns it only while still connected).
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      invokerRef.current = active;
    }
    return () => {
      const invoker = invokerRef.current;
      invokerRef.current = null;
      const target = resolveReturnTarget({
        invoker: invoker
          ? { id: "actions-invoker", connected: invoker.isConnected }
          : null,
      });
      if (target) invoker?.focus();
    };
  }, [open]);

  // Tab / Shift+Tab cycles inside the dialog; Escape keeps its handling in the
  // dedicated effect below.
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const { stops, nodes } = actionsMenuStops(event.currentTarget);
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? nodes.indexOf(active) : -1;
    const plan = planActionsMenuTab(stops, {
      activeId: activeIndex >= 0 ? String(activeIndex) : null,
      shift: event.shiftKey,
    });
    if (!plan) return;
    const target = nodes[Number(plan.target.id)];
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

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
      const action = resolveToggleAction(item.id, {
        smallText: resolvedAppearance.fontSize === "small",
        hasAppearance: Boolean(onAppearance),
      });
      if (!action) return;
      if (action.kind === "appearance") {
        onAppearance?.(action.patch);
      } else {
        onToggle(action.key);
      }
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
      case "a11y-check":
        setSubmenu(null);
        setView("accessibility");
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
        data-contrast={highContrast ? "more" : "normal"}
        onKeyDown={onDialogKeyDown}
        style={{ zIndex: Z.popover }}
        className={cn(
          "surface-raised absolute end-0 top-full mt-1 w-64 animate-rise",
          highContrast && "high-contrast",
        )}
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
              className="focus-ring w-full border-b border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted"
            />
            {query.trim() === "" && (
              <div className="border-b border-border px-2 py-1.5">
                <Select
                  aria-label="Font style"
                  options={FONT_SELECT_OPTIONS}
                  value={resolvedAppearance.font}
                  allowClear={false}
                  searchable={false}
                  size="sm"
                  placeholder="Font"
                  onChange={(font) => {
                    if (font === "") return;
                    if (onAppearance) onAppearance({ font: font as PageFont });
                    else onStyle(font);
                  }}
                />
              </div>
            )}
            {query.trim() === "" && onAppearance && (
              <div className="border-b border-border px-2 py-1.5">
                <RadioGroup
                  aria-label="Line spacing"
                  orientation="horizontal"
                  value={resolvedAppearance.lineSpacing}
                  onValueChange={(value) =>
                    onAppearance({ lineSpacing: value as PageLineSpacing })
                  }
                >
                  {LINE_SPACING_OPTIONS.map((option) => (
                    <Radio key={option.id} value={option.id} label={option.label} />
                  ))}
                </RadioGroup>
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
                        "u-colors focus-ring mx-1 flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg",
                        groupIndex > 0 &&
                          indexOf.get(group.items[0].id) === index &&
                          "mt-1 border-t border-border pt-2.5",
                        isActive && "bg-surface-2",
                        item.kind === "disabled" && "cursor-not-allowed opacity-50",
                      )}
                    >
                      {item.id === "lock" && (
                        <LockIcon
                          className="h-3.5 w-3.5 shrink-0 text-muted"
                          aria-hidden
                        />
                      )}
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
                style={{ top: submenu.top, zIndex: Z.popover }}
                className="surface-raised scrollbar-thin absolute start-full min-w-48 max-w-64 animate-rise overflow-y-auto py-1 outline-none"
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
                          "u-colors focus-ring mx-1 flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                          index === subIndex && "bg-surface-2",
                          entry.disabled && "cursor-not-allowed opacity-50",
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
            <CustomizePanel
              theme={theme}
              onThemeChange={setTheme}
              highContrast={highContrast}
              onHighContrastChange={setHighContrast}
              contrastLabel={contrastLabel}
              cover={storedCover}
              position={coverPosition}
              onPickIcon={pickIcon}
              onPickCover={pickCoverValue}
              onPickPosition={pickCoverPosition}
            />
          </>
        ) : view === "accessibility" ? (
          <>
            <PanelHeader title="Accessibility check" onBack={backToMain} />
            <div className="max-h-80 overflow-y-auto p-2 text-sm">
              {a11yReport === null ? (
                <p className="text-muted">Page content isn&apos;t loaded yet.</p>
              ) : a11yReport.summary.total === 0 ? (
                <p className="text-muted">
                  No accessibility issues found.
                </p>
              ) : (
                <>
                  <p>
                    {a11yReport.summary.errors} errors ·{" "}
                    {a11yReport.summary.warnings} warnings ·{" "}
                    {a11yReport.summary.infos} info
                  </p>
                  <ul className="mt-2 space-y-1 border-t border-border pt-2">
                    {a11yBreakdown.map((row) => (
                      <li key={row.code} className="flex items-center gap-2">
                        <span className="flex-1 truncate">{row.title}</span>
                        <span className="shrink-0 text-muted">{row.count}</span>
                      </li>
                    ))}
                  </ul>
                  <ul className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted">
                    {a11yReport.issues.map((issue, index) => (
                      <li key={`${issue.blockId}:${issue.code}:${index}`}>
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                </>
              )}
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

export type CustomizePanelProps = {
  /** Resolved theme name (`light` / `dark` / `system`) or `undefined`. */
  theme?: string;
  onThemeChange: (theme: string) => void;
  highContrast: boolean;
  onHighContrastChange: (value: boolean) => void;
  /** Live contrast readout shown under the switch. */
  contrastLabel: string;
  /** Decoded stored cover, or `null` when the page has none. */
  cover: ResolvedCover | null;
  position: CoverPosition;
  onPickIcon: (candidate: string) => void;
  onPickCover: (value: CoverValue | null) => void;
  onPickPosition: (position: CoverPosition) => void;
};

/**
 * Customize tab body — the icon, cover and theme groups. Each group is a
 * `Section` (shared settings rhythm) divided by a `Separator`; the toggles and
 * radios are the shared `Switch` / `RadioGroup` primitives, and every custom
 * button carries the `.focus-ring` / `.u-colors` / `.u-interactive` contract.
 *
 * Extracted from `ActionsMenu` so the panel renders (and is pinned by tests)
 * without the dialog's open/submenu state machine.
 */
export function CustomizePanel({
  theme,
  onThemeChange,
  highContrast,
  onHighContrastChange,
  contrastLabel,
  cover,
  position,
  onPickIcon,
  onPickCover,
  onPickPosition,
}: CustomizePanelProps) {
  const themeValue = theme ?? "system";

  return (
    <div className="flex max-h-80 flex-col gap-3 overflow-y-auto p-2">
      <Section title="Icon" level={3} className="gap-2">
        <div className="grid grid-cols-8 gap-1">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`Set icon ${emoji}`}
              onClick={() => onPickIcon(emoji)}
              className="focus-ring u-interactive u-colors grid h-7 w-7 place-items-center rounded-sm text-lg text-fg hover:bg-surface-2"
            >
              {emoji}
            </button>
          ))}
        </div>
      </Section>

      <Separator />

      <Section title="Cover" level={3} className="gap-2">
        <div className="grid grid-cols-4 gap-1">
          {GRADIENT_IDS.map((id) => {
            const selected =
              cover?.value.type === "gradient" &&
              cover.value.gradientId === id;
            return (
              <button
                key={id}
                type="button"
                aria-label={`Set cover ${id}`}
                aria-pressed={selected}
                onClick={() => onPickCover({ type: "gradient", gradientId: id })}
                className={cn(
                  "focus-ring u-interactive u-colors h-10 rounded-sm bg-cover bg-center",
                  selected && "ring-2 ring-accent",
                )}
                style={{
                  backgroundImage: coverPreviewCss(id),
                  backgroundPosition: formatObjectPosition(position),
                }}
              />
            );
          })}
        </div>
        {cover && (
          <>
            <p className="mt-2 text-xs font-medium text-muted">Position</p>
            <div
              role="group"
              aria-label="Cover position"
              className="grid w-24 grid-cols-3 gap-1"
            >
              {POSITION_PRESETS.map((preset) => {
                const selected =
                  formatObjectPosition(position) ===
                  formatObjectPosition(preset.position);
                return (
                  <button
                    key={preset.label}
                    type="button"
                    aria-label={`Cover position ${preset.label}`}
                    aria-pressed={selected}
                    onClick={() => onPickPosition(preset.position)}
                    className={cn(
                      "focus-ring u-interactive u-colors h-7 w-7 rounded-sm border border-border",
                      selected && "bg-surface-2 ring-1 ring-accent",
                    )}
                  />
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => onPickCover(null)}
              className="focus-ring u-interactive u-colors mt-1 self-start rounded-sm px-1 py-0.5 text-xs text-muted hover:bg-surface-2"
            >
              Remove cover
            </button>
          </>
        )}
      </Section>

      <Separator />

      <Section title="Theme" level={3} className="gap-2">
        <RadioGroup
          aria-label="Theme"
          orientation="horizontal"
          value={themeValue}
          onValueChange={onThemeChange}
        >
          {(["light", "dark", "system"] as const).map((mode) => (
            <Radio
              key={mode}
              value={mode}
              label={<span className="capitalize">{mode}</span>}
            />
          ))}
        </RadioGroup>
      </Section>

      <Separator />

      <Section title="Contrast" level={3} className="gap-2">
        <Switch
          checked={highContrast}
          onCheckedChange={onHighContrastChange}
          label="High contrast"
          description={contrastLabel}
          aria-label={`High contrast (${contrastLabel})`}
        />
      </Section>
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
      className="focus-ring u-interactive u-colors flex h-7 w-7 items-center justify-center rounded-sm text-muted hover:bg-surface-2"
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
        className="focus-ring u-interactive u-colors rounded-sm p-1 text-muted hover:bg-surface-2"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
      </button>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}
