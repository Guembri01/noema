"use client";

import type { ComponentType, ReactNode } from "react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Link2, MessageSquarePlus, Quote, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { regenerateChatAnswerAction, saveChatAnswerAction } from "@/server/actions/chat";
import { safeAction } from "@/lib/actions-client";
import { markdownToText } from "@/lib/markdown";
import { t } from "@/lib/i18n";

/** Minimal shape shared by Radix's dropdown and context-menu items. */
type MenuItem = ComponentType<{
  onSelect?: (event: Event) => void;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
}>;

export type ChatAnswerTarget = {
  id: string;
  body: string;
  savedPageId?: string;
  savedPageTitle?: string;
  threadPageId?: string | null;
};

/**
 * The action set for one assistant answer. Rendered twice — as a right-click
 * context menu on the message and as a `⋯` dropdown button — so the same
 * actions are reachable by mouse, keyboard and touch alike.
 */
export function ChatAnswerItems({
  Item,
  Separator,
  message,
  slug,
  locale,
  threadId,
  onFollowUp,
  onSaved,
}: {
  Item: MenuItem;
  Separator?: ComponentType;
  message: ChatAnswerTarget;
  slug: string;
  locale: string;
  /** Conversation id — enables Regenerate. */
  threadId?: string | null;
  onFollowUp: (prompt: string) => void;
  onSaved: (pageId: string, title: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [savedId, setSavedId] = useState<string | undefined>(message.savedPageId);
  const [savedTitle, setSavedTitle] = useState<string | undefined>(message.savedPageTitle);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
    } catch {
      toast.error("Could not copy");
    }
  };

  const save = () =>
    startTransition(async () => {
      const outcome = await safeAction(() => saveChatAnswerAction(message.id));
      const value = outcome.ok ? outcome.value : { error: outcome.error };
      if ("error" in value) {
        toast.error(value.error);
        return;
      }
      setSavedId(value.pageId);
      setSavedTitle(value.title);
      onSaved(value.pageId, value.title);
      toast.success(`Saved to “${value.title}”`);
      router.refresh();
    });

  return (
    <>
      <Item onSelect={() => void copy(message.body, "Answer copied")}>
        <Quote className="h-4 w-4 text-muted" /> {t(locale, "chatCopyAnswer")}
      </Item>
      <Item onSelect={() => void copy(markdownToText(message.body), "Copied as plain text")}>
        <Link2 className="h-4 w-4 text-muted" /> {t(locale, "chatCopyPlain")}
      </Item>
      {Separator && <Separator />}
      {savedId ? (
        <Item onSelect={() => router.push(`/w/${slug}/${savedId}`)}>
          <Sparkles className="h-4 w-4 text-accent" /> Open “{savedTitle ?? "note"}”
        </Item>
      ) : (
        <Item onSelect={save} disabled={pending}>
          <FilePlus2 className="h-4 w-4 text-muted" /> {pending ? "…" : t(locale, "chatSaveNote")}
        </Item>
      )}
      <Item
        onSelect={() =>
          onFollowUp(
            "Expand on your last answer — go deeper on the parts that matter and keep it structured.",
          )
        }
      >
        <MessageSquarePlus className="h-4 w-4 text-muted" /> {t(locale, "chatFollowUp")}
      </Item>
      {threadId && (
        <Item
          onSelect={() =>
            startTransition(async () => {
              const outcome = await safeAction(() => regenerateChatAnswerAction(threadId));
              const value = outcome.ok ? outcome.value : { error: outcome.error };
              if ("error" in value) {
                toast.error(value.error);
                return;
              }
              toast.success("Answer regenerated");
              router.refresh();
            })
          }
          disabled={pending}
        >
          <RefreshCw className="h-4 w-4 text-muted" /> {t(locale, "chatRegenerate")}
        </Item>
      )}
      {message.threadPageId && (
        <Item onSelect={() => router.push(`/w/${slug}/${message.threadPageId}`)}>
          <Sparkles className="h-4 w-4 text-muted" /> Open the note this discusses
        </Item>
      )}
    </>
  );
}
