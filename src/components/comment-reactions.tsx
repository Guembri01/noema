"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SmilePlus } from "lucide-react";
import { toggleCommentReactionAction } from "@/server/actions/comments";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const EMOJI = ["👍", "🎉", "❤️", "😄", "🙌", "👀", "❓"];

export type ReactionRow = { emoji: string; count: number; mine: boolean };

/**
 * Emoji reactions on a comment: chips for what exists, a picker for what you can
 * add. Counts update optimistically so the click feels instant.
 */
export function CommentReactions({
  commentId,
  reactions,
  onChanged,
  locale,
}: {
  commentId: string;
  reactions: ReactionRow[];
  onChanged?: (reactions: ReactionRow[]) => void;
  locale: string;
}) {
  const router = useRouter();
  const [picking, setPicking] = useState(false);

  const toggle = async (emoji: string) => {
    const next = [...reactions];
    const index = next.findIndex((reaction) => reaction.emoji === emoji);
    if (index === -1) next.push({ emoji, count: 1, mine: true });
    else if (next[index].mine) {
      next[index] = { ...next[index], count: next[index].count - 1, mine: false };
      if (next[index].count <= 0) next.splice(index, 1);
    } else next[index] = { ...next[index], count: next[index].count + 1, mine: true };
    onChanged?.(next.filter((reaction) => reaction.count > 0));
    setPicking(false);

    const outcome = await safeAction(
      () => toggleCommentReactionAction(commentId, emoji),
      { locale },
    );
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    const value = outcome.value;
    if (value && typeof value === "object" && "error" in value && value.error) {
      toast.error(String(value.error));
      return;
    }
    // The chip list is server-rendered, so pull the authoritative state back.
    if (!onChanged) router.refresh();
  };

  return (
    <span className="relative inline-flex items-center gap-1">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          aria-label={`${reaction.emoji} (${reaction.count})`}
          aria-pressed={reaction.mine}
          onClick={() => void toggle(reaction.emoji)}
          className={cn(
            "flex h-6 items-center gap-1 rounded-full border px-1.5 text-[11px]",
            reaction.mine
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-border text-muted hover:bg-surface-2",
          )}
        >
          <span aria-hidden>{reaction.emoji}</span>
          {reaction.count}
        </button>
      ))}

      <button
        type="button"
        aria-label={t(locale, "addReaction")}
        aria-expanded={picking}
        onClick={() => setPicking((value) => !value)}
        className="flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-surface-2"
      >
        <SmilePlus className="h-3.5 w-3.5" />
      </button>

      {picking && (
        <span className="absolute bottom-7 left-0 z-20 flex gap-0.5 rounded-lg border border-border bg-bg p-1 shadow-lg">
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`${t(locale, "reactTo")} ${emoji}`}
              onClick={() => void toggle(emoji)}
              className="grid h-7 w-7 place-items-center rounded text-base hover:bg-surface-2"
            >
              {emoji}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
