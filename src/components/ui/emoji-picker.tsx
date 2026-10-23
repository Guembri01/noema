"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EMOJI_SHORTCODES, emojiCandidates } from "@/lib/emoji";
import {
  DEFAULT_TOP_LIMIT,
  mergeUsages,
  recordUse,
  topRecent,
  type EmojiUsage,
} from "@/lib/emoji-frecency";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { floatingStyle, placeFloating, type Placement } from "@/lib/floating";
import { FloatingLayer } from "@/components/ui/floating-layer";
import { Z } from "@/lib/design-tokens";

/**
 * Emoji picker with a per-user "frequently used" strip.
 *
 * `@/lib/emoji-frecency` is the pure ranking core: this component is the UI
 * that finally reaches for it. Every pick is recorded once
 * (`recordUse(..., now)`), the strip is the module's `topRecent` ranking, and
 * the list is persisted per user in `localStorage` (the same store
 * `command-palette.tsx` uses for its recents — the codebase has no per-user
 * preference row for a client-only strip, so the browser store is the one the
 * codebase already uses for this shape). A missing/corrupt/blocked store just
 * degrades to a session-only strip.
 *
 * The component is intentionally generic: `onSelect` + a `storageKey`
 * namespace mean the database's icon/emoji cell and a comment-reaction picker
 * share one implementation without sharing a history. The pure helpers below
 * are exported so the node test can prove the ranking/decay and persistence
 * without a DOM.
 */

/** Default number of recently-used glyphs shown above the full grid. */
export const EMOJI_RECENT_LIMIT = DEFAULT_TOP_LIMIT;

/** localStorage namespace for the frecency list. */
export const EMOJI_FRECENCY_NAMESPACE = "noema:emoji-frecency";

/** The picker panel's design bounds, used for placement and for the box itself. */
const EMOJI_PANEL_WIDTH = 272;
const EMOJI_PANEL_HEIGHT = 320;
/** Rendered before the first measurement lands (one frame). */
const EMOJI_PANEL_FALLBACK: Placement = {
  top: 0,
  left: 0,
  side: "bottom",
  flipped: false,
  cramped: false,
  maxHeight: EMOJI_PANEL_HEIGHT,
};

/** The minimal storage surface the picker needs (satisfied by `localStorage`). */
export type EmojiStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * The per-user storage key. A blank/absent user id shares the `anon` bucket so
 * a signed-out picker still remembers what was used in the session.
 */
export function emojiFrecencyKey(namespace: string, userId?: string): string {
  const id =
    typeof userId === "string" && userId.trim() !== "" ? userId.trim() : "anon";
  return `${namespace}:${id}`;
}

/**
 * Parse a persisted usage list, dropping anything malformed. Duplicate rows are
 * folded through `mergeUsages`, so a hand-edited/older payload can never yield
 * two entries for one glyph.
 */
export function parseEmojiUsages(raw: string | null | undefined): EmojiUsage[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: EmojiUsage[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      emoji?: unknown;
      count?: unknown;
      lastUsedAt?: unknown;
    };
    if (typeof record.emoji !== "string" || record.emoji === "") continue;
    if (
      typeof record.count !== "number" ||
      !Number.isFinite(record.count) ||
      record.count <= 0
    ) {
      continue;
    }
    if (
      typeof record.lastUsedAt !== "number" ||
      !Number.isFinite(record.lastUsedAt)
    ) {
      continue;
    }
    entries.push({
      emoji: record.emoji,
      count: record.count,
      lastUsedAt: record.lastUsedAt,
    });
  }
  return mergeUsages([], entries);
}

/** The browser store, or `null` when unavailable (SSR / private mode). */
function defaultEmojiStorage(): EmojiStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Read + normalise the persisted list; tolerates a blocked/corrupt store. */
export function loadEmojiUsages(
  storageKey: string,
  storage: EmojiStorage | null = defaultEmojiStorage(),
): EmojiUsage[] {
  if (!storage) return [];
  try {
    return parseEmojiUsages(storage.getItem(storageKey));
  } catch {
    return [];
  }
}

/** Persist the list; a blocked store is ignored (session ranking still works). */
export function saveEmojiUsages(
  storageKey: string,
  list: readonly EmojiUsage[],
  storage: EmojiStorage | null = defaultEmojiStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(list));
  } catch {
    // No storage — the in-memory list still ranks this session.
  }
}

/**
 * The unique glyphs of the curated `@/lib/emoji` shortcode table, in insertion
 * order. Aliases (`thumbsup`/`"+1"`) collapse to one glyph.
 */
export function emojiCatalog(): string[] {
  const seen = new Set<string>();
  const glyphs: string[] = [];
  for (const glyph of Object.values(EMOJI_SHORTCODES)) {
    if (!seen.has(glyph)) {
      seen.add(glyph);
      glyphs.push(glyph);
    }
  }
  return glyphs;
}

/**
 * The glyphs matching `query` by shortcode or keyword (`emojiCandidates`),
 * de-duplicated. A blank query returns the full curated catalogue.
 */
export function filterEmojiCatalog(query: string, limit = 48): string[] {
  if ((query ?? "").trim() === "") return emojiCatalog();
  const seen = new Set<string>();
  const glyphs: string[] = [];
  for (const candidate of emojiCandidates(query, limit)) {
    if (!seen.has(candidate.emoji)) {
      seen.add(candidate.emoji);
      glyphs.push(candidate.emoji);
    }
  }
  return glyphs;
}

/**
 * The live frecency state behind a picker: the loaded usages, the ranked
 * `recent` glyphs (`topRecent`) and a `record` that stamps a pick, persists it
 * and refreshes `recent`. Shared by the icon cell and any reactions picker so
 * they rank through the same module.
 */
export function useEmojiFrecency({
  storageKey,
  userId,
  limit = EMOJI_RECENT_LIMIT,
}: {
  storageKey: string;
  userId?: string;
  limit?: number;
}): {
  usages: EmojiUsage[];
  recent: string[];
  record: (emoji: string) => void;
} {
  const key = emojiFrecencyKey(storageKey, userId);
  const [usages, setUsages] = useState<EmojiUsage[]>([]);

  useEffect(() => {
    setUsages(loadEmojiUsages(key));
  }, [key]);

  const record = useCallback(
    (emoji: string) => {
      if (!emoji) return;
      setUsages((current) => {
        const next = recordUse(current, emoji, Date.now());
        saveEmojiUsages(key, next);
        return next;
      });
    },
    [key],
  );

  // Decay is measured at render time; ranking only changes when the usages do.
  const recent = useMemo(
    () => topRecent(usages, { now: Date.now(), limit }).map((entry) => entry.emoji),
    [usages, limit],
  );

  return { usages, recent, record };
}

/** Arguments handed to a custom `trigger` render-prop. */
export type EmojiPickerTriggerProps = {
  /** Whether the picker is currently open. */
  open: boolean;
  /** Toggle the picker: opens when closed, closes when open. */
  toggle: () => void;
  /** The computed accessible name (`triggerLabel` or the locale default). */
  label: string;
  /** id of the dialog, so a custom trigger can set `aria-controls`. */
  controls: string;
};

export function EmojiPicker({
  onSelect,
  locale,
  userId,
  storageKey = EMOJI_FRECENCY_NAMESPACE,
  triggerLabel,
  trigger,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
}: {
  /** Called with the chosen glyph; the picker records the use first. */
  onSelect: (emoji: string) => void;
  locale: string;
  /** Per-user persistence bucket (the session user id). */
  userId?: string;
  /**
   * Namespace so two pickers keep separate histories, e.g.
   * `"noema:emoji-frecency:icon"` vs a reactions bucket.
   */
  storageKey?: string;
  /** Accessible name for the trigger; defaults to `t(locale, "useEmoji")`. */
  triggerLabel?: string;
  /**
   * Render the trigger yourself (a literal `+`, a tag-shaped button, …). Receives
   * `{ open, toggle, label, controls }`. When omitted the default 🙂 button is
   * rendered unchanged.
   */
  trigger?: (props: EmojiPickerTriggerProps) => ReactNode;
  /** Controlled open state; pair with `onOpenChange`. */
  open?: boolean;
  /** Uncontrolled initial open state; ignored when `open` is provided. */
  defaultOpen?: boolean;
  /** Notified on every open/close change. */
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [query, setQuery] = useState("");
  const { recent, record } = useEmojiFrecency({ storageKey, userId });
  const catalog = useMemo(() => filterEmojiCatalog(query), [query]);
  const label = triggerLabel ?? t(locale, "useEmoji");
  const dialogId = `${useId()}-emoji-picker`;

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  const choose = (emoji: string) => {
    record(emoji);
    onSelect(emoji);
    setOpen(false);
    setQuery("");
  };

  const toggle = () => setOpen(!open);

  // Place against the trigger: flipped up when there is no room below, clamped
  // inside the viewport, and portalled (see FloatingLayer) so an ancestor with
  // `backdrop-blur` or `transform` cannot re-root it. The panel used to be
  // `absolute left-0 top-7` with a magic z-index, which clipped at the window
  // edge and drifted inside the blurred page header.
  useEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const resolve = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPlacement(
        placeFloating({
          anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          size: { width: EMOJI_PANEL_WIDTH, height: EMOJI_PANEL_HEIGHT },
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
  }, [open]);

  return (
    <span ref={anchorRef} className={cn("relative inline-flex", className)}>
      {trigger ? (
        trigger({ open, toggle, label, controls: dialogId })
      ) : (
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={dialogId}
          data-testid="emoji-picker-trigger"
          onClick={toggle}
          className="focus-ring u-interactive flex h-6 w-6 items-center justify-center rounded-control text-muted hover:bg-surface-2"
        >
          <span aria-hidden>🙂</span>
        </button>
      )}
      {open && (
        <FloatingLayer>
        <div
          id={dialogId}
          role="dialog"
          aria-label={label}
          data-testid="emoji-picker"
          style={{
            ...floatingStyle(placement ?? EMOJI_PANEL_FALLBACK),
            zIndex: Z.popover,
            width: EMOJI_PANEL_WIDTH,
          }}
          className="surface-raised scrollbar-thin overflow-y-auto rounded-lg p-2"
        >
          <input
            autoFocus
            value={query}
            aria-label={t(locale, "search")}
            placeholder={t(locale, "search")}
            onChange={(event) => setQuery(event.target.value)}
            className="mb-2 w-full rounded-control border-control bg-bg px-2 py-1 text-xs outline-none"
          />
          {recent.length > 0 && (
            <div className="mb-2" role="group" aria-label={t(locale, "frequentlyUsed")}>
              <div className="mb-1 text-3xs uppercase tracking-wide text-muted">
                {t(locale, "frequentlyUsed")}
              </div>
              <div className="flex flex-wrap gap-0.5">
                {recent.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`${label} ${emoji}`}
                    data-testid={`emoji-recent-${emoji}`}
                    onClick={() => choose(emoji)}
                    className="focus-ring u-interactive grid h-7 w-7 place-items-center rounded-control text-base hover:bg-surface-2"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex max-h-40 flex-wrap gap-0.5 overflow-y-auto">
            {catalog.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`${label} ${emoji}`}
                onClick={() => choose(emoji)}
                className="focus-ring u-interactive grid h-7 w-7 place-items-center rounded-control text-base hover:bg-surface-2"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
          </FloatingLayer>
      )}
    </span>
  );
}
