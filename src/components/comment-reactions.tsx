"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { toggleCommentReactionAction } from "@/server/actions/comments";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Tag } from "@/components/ui/tag";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";

/**
 * Emoji reactions on a comment (docs/DESIGN_SYSTEM.md §9 baseline).
 *
 * The pure core lives beside the view so it can be node-tested without a DOM:
 * `aggregateReactions` collapses a wire list into one chip per glyph (summing
 * counts, keeping first-seen order), `toggleReactionRow` is the optimistic
 * add/remove a click applies before the server answers, `reactionDiff` is the
 * before/after change set the pop animation keys off, and `whoReacted` is the
 * tooltip sentence.
 *
 * The view is entirely design-system primitives:
 *  - a reaction is a selectable `Tag` (its pressed state is `selected`), so the
 *    chip, the keyboard path (Space/Enter) and the focus ring all come for
 *    free;
 *  - a `Tooltip` names who reacted (falling back to a count sentence when the
 *    query only sends a number);
 *  - the picker is the shared `EmojiPicker`, whose "frequently used" strip is
 *    ranked by `@/lib/emoji-frecency` — one picker, one history, no bespoke
 *    emoji grid;
 *  - a changed count plays `animate-scale-in` retimed to `--dur-2` and
 *    `--ease-spring` (a spring pop), which `prefers-reduced-motion` neutralises
 *    globally. No raw hex, magic z-index or ad-hoc duration anywhere.
 */

/** The localStorage bucket so comment reactions keep their own frecency list. */
export const REACTION_FRECENCY_NAMESPACE = "noema:emoji-frecency:reactions";

/** One person behind a reaction, when the caller can name them. */
export type ReactionReactor = { id: string; name: string };

/** One aggregated reaction chip. `reactors` is optional (depends on the query). */
export type ReactionRow = {
  emoji: string;
  count: number;
  mine: boolean;
  reactors?: ReactionReactor[];
};

/** One count that changed between two renders. */
export type ReactionChange = {
  emoji: string;
  before: number;
  after: number;
  direction: "up" | "down";
};

/**
 * Collapse a reaction list into one row per emoji: counts sum, `mine` is the
 * OR of the rows, `reactors` concatenates, and the first-seen order is kept.
 * Blank glyphs and non-positive counts are dropped so a malformed payload can
 * never render an empty chip. Pure — the input is never mutated.
 */
export function aggregateReactions(
  rows: readonly ReactionRow[] | null | undefined,
): ReactionRow[] {
  const byEmoji = new Map<string, ReactionRow>();
  for (const row of rows ?? []) {
    if (!row || typeof row.emoji !== "string" || row.emoji === "") continue;
    const count =
      typeof row.count === "number" && Number.isFinite(row.count)
        ? Math.max(0, Math.trunc(row.count))
        : 0;
    if (count <= 0) continue;

    const existing = byEmoji.get(row.emoji);
    if (existing) {
      existing.count += count;
      existing.mine = existing.mine || row.mine === true;
      if (row.reactors && row.reactors.length > 0) {
        existing.reactors = [...(existing.reactors ?? []), ...row.reactors];
      }
    } else {
      byEmoji.set(row.emoji, {
        emoji: row.emoji,
        count,
        mine: row.mine === true,
        reactors: row.reactors ? [...row.reactors] : undefined,
      });
    }
  }
  return [...byEmoji.values()];
}

/**
 * Toggle the current user's reaction optimistically. Adding a glyph appends a
 * `{ count: 1, mine: true }` row; toggling `mine` off decrements and removes the
 * row at zero. Pure — returns a new list.
 */
export function toggleReactionRow(
  rows: readonly ReactionRow[] | null | undefined,
  emoji: string,
): ReactionRow[] {
  const next = aggregateReactions(rows).map((row) => ({ ...row }));
  const index = next.findIndex((row) => row.emoji === emoji);
  if (index === -1) {
    next.push({ emoji, count: 1, mine: true });
  } else if (next[index].mine) {
    next[index].count -= 1;
    next[index].mine = false;
  } else {
    next[index].count += 1;
    next[index].mine = true;
  }
  return next.filter((row) => row.count > 0);
}

/**
 * The counts that changed from `before` to `after`, in `after`-then-removed
 * order. Drives the count-pop animation. Pure.
 */
export function reactionDiff(
  before: readonly ReactionRow[] | null | undefined,
  after: readonly ReactionRow[] | null | undefined,
): ReactionChange[] {
  const beforeCounts = new Map(
    aggregateReactions(before).map((row) => [row.emoji, row.count]),
  );
  const afterRows = aggregateReactions(after);
  const seen = new Set<string>();
  const changes: ReactionChange[] = [];

  for (const row of afterRows) {
    seen.add(row.emoji);
    const previous = beforeCounts.get(row.emoji) ?? 0;
    if (previous !== row.count) {
      changes.push({
        emoji: row.emoji,
        before: previous,
        after: row.count,
        direction: row.count > previous ? "up" : "down",
      });
    }
  }
  for (const row of aggregateReactions(before)) {
    if (seen.has(row.emoji)) continue;
    changes.push({ emoji: row.emoji, before: row.count, after: 0, direction: "down" });
  }
  return changes;
}

/** "Ada", "Ada and Bob", "Ada, Bob and Carol" — the tooltip's name list. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The "who reacted" sentence for the tooltip. When the caller supplied exactly
 * as many reactor names as the count, the names are listed; otherwise it falls
 * back to a count sentence ("You and 2 others", "3 people reacted") so a stale
 * or absent `reactors` list can never read wrong.
 */
export function whoReacted(row: ReactionRow): string {
  const names = (row.reactors ?? [])
    .map((reactor) => (reactor?.name ?? "").trim())
    .filter((name) => name !== "");
  if (names.length > 0 && names.length === row.count) return joinNames(names);
  if (row.mine && row.count <= 1) return "You reacted";
  if (row.mine) {
    const others = row.count - 1;
    return `You and ${others} ${others === 1 ? "other" : "others"}`;
  }
  return `${row.count} ${row.count === 1 ? "person" : "people"} reacted`;
}

/**
 * Track which chips just changed count: a ref remembers the previous counts,
 * and an effect diffs them on each new list. The first render seeds the ref and
 * pops nothing (a chip should not animate on load). `clearPop` is wired to
 * `onAnimationEnd`, so a chip stops carrying the animation class once it has
 * played and the next change replays it.
 */
function useCountPop(reactions: readonly ReactionRow[]): {
  popping: ReadonlySet<string>;
  clearPop: (emoji: string) => void;
} {
  const previous = useRef<Map<string, number> | null>(null);
  const [popping, setPopping] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const next = new Map(
      aggregateReactions(reactions).map((row) => [row.emoji, row.count]),
    );
    const before = previous.current;
    previous.current = next;
    if (!before) return;
    const changed = new Set<string>();
    next.forEach((count, emoji) => {
      const was = before.get(emoji);
      if (was !== undefined && was !== count) changed.add(emoji);
    });
    if (changed.size > 0) setPopping(changed);
  }, [reactions]);

  const clearPop = useCallback((emoji: string) => {
    setPopping((current) => {
      if (!current.has(emoji)) return current;
      const next = new Set(current);
      next.delete(emoji);
      return next;
    });
  }, []);

  return { popping, clearPop };
}

/**
 * Emoji reactions on a comment: chips for what exists, the shared picker for
 * what you can add. Counts update optimistically so the click feels instant;
 * an `onChanged` host owns the next state, otherwise the server list is pulled
 * back with `router.refresh()`.
 */
export function CommentReactions({
  commentId,
  reactions,
  onChanged,
  locale,
  userId,
}: {
  commentId: string;
  reactions: ReactionRow[];
  onChanged?: (reactions: ReactionRow[]) => void;
  locale: string;
  /** Per-user frecency bucket for the picker's "frequently used" strip. */
  userId?: string;
}) {
  const router = useRouter();
  const rows = useMemo(() => aggregateReactions(reactions), [reactions]);
  const { popping, clearPop } = useCountPop(reactions);

  const toggle = async (emoji: string) => {
    const next = toggleReactionRow(rows, emoji);
    onChanged?.(next);

    const outcome = await safeAction(
      () => toggleCommentReactionAction(commentId, emoji),
      { locale },
    );
    if (!outcome.ok) {
      toast.error(outcome.error);
      onChanged?.(rows);
      return;
    }
    const value = outcome.value;
    if (value && typeof value === "object" && "error" in value && value.error) {
      toast.error(String(value.error));
      onChanged?.(rows);
      return;
    }
    // The chip list is server-rendered, so pull the authoritative state back.
    if (!onChanged) router.refresh();
  };

  return (
    <TooltipProvider>
      <span
        role="group"
        aria-label={t(locale, "addReaction")}
        className="relative inline-flex flex-wrap items-center gap-1"
        data-testid="comment-reactions"
      >
        {rows.map((row) => (
          <Tooltip key={row.emoji} label={whoReacted(row)}>
            <Tag
              size="md"
              hue={row.mine ? "blue" : null}
              selected={row.mine}
              onSelectedChange={() => void toggle(row.emoji)}
              onAnimationEnd={() => clearPop(row.emoji)}
              aria-label={`${row.emoji} (${row.count})`}
              data-testid={`reaction-chip-${row.emoji}`}
              className={cn(
                "cursor-pointer gap-1 tabular-nums",
                popping.has(row.emoji) &&
                  "animate-scale-in [animation-duration:var(--dur-2)] [animation-timing-function:var(--ease-spring)]",
              )}
            >
              <span aria-hidden>{row.emoji}</span>
              <span>{row.count}</span>
            </Tag>
          </Tooltip>
        ))}

        <EmojiPicker
          onSelect={(emoji) => void toggle(emoji)}
          locale={locale}
          userId={userId}
          storageKey={REACTION_FRECENCY_NAMESPACE}
          triggerLabel={t(locale, "reactTo")}
        />
      </span>
    </TooltipProvider>
  );
}
