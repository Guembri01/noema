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
import { Tag } from "@/components/ui/tag";
import type { TagHue } from "@/lib/design-tokens";

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

/* -------------------------------------------------------------------------- *
 * Answer actions as a pure mapping
 * -------------------------------------------------------------------------- */

/** Every action the answer menu can offer. */
export type ChatAnswerActionId =
  | "copy"
  | "copyPlain"
  | "save"
  | "followUp"
  | "regenerate"
  | "openNote"
  | "openSaved";

/** The `Tag` shown on the right of a menu row: a keyboard hint + a token hue. */
export type AnswerActionTag = { hint: string; hue: TagHue };

/**
 * Pure, testable decoration for each action. A `null` tag means the row has no
 * shortcut chip (the "open" rows). The hues come from the tag palette, never a
 * raw colour, so light / dark / high-contrast all inherit from the tokens.
 */
export const ANSWER_ACTION_TAGS: Record<ChatAnswerActionId, AnswerActionTag | null> = {
  copy: { hint: "⌘C", hue: "blue" },
  copyPlain: { hint: "⇧⌘C", hue: "gray" },
  save: { hint: "⌘S", hue: "green" },
  followUp: { hint: "⌘⏎", hue: "purple" },
  regenerate: { hint: "⌘R", hue: "orange" },
  openNote: null,
  openSaved: null,
};

/** The tag for an action, or `null` when the action has no hint. */
export function answerActionTag(id: ChatAnswerActionId): AnswerActionTag | null {
  return ANSWER_ACTION_TAGS[id] ?? null;
}

/** One menu row: decorative icon, label, and a right-aligned token `Tag`. */
function ActionRow({
  id,
  icon,
  label,
}: {
  id: ChatAnswerActionId;
  icon: ReactNode;
  label: ReactNode;
}) {
  const tag = answerActionTag(id);
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <span aria-hidden className="inline-flex shrink-0">
        {icon}
      </span>
      <span className="truncate">{label}</span>
      {tag ? (
        <Tag size="sm" hue={tag.hue} className="ms-auto shrink-0">
          {tag.hint}
        </Tag>
      ) : null}
    </span>
  );
}

/**
 * The action set for one assistant answer. Rendered as a `⋯` dropdown button on
 * the message (mouse, keyboard and touch). Every row carries the design-system
 * icon ink and, where one exists, a keyboard-hint `Tag`; colours stay on tokens
 * (`text-muted` / `text-accent`) — never a raw palette class.
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
        <ActionRow
          id="copy"
          icon={<Quote className="h-4 w-4 text-muted" />}
          label={t(locale, "chatCopyAnswer")}
        />
      </Item>
      <Item onSelect={() => void copy(markdownToText(message.body), "Copied as plain text")}>
        <ActionRow
          id="copyPlain"
          icon={<Link2 className="h-4 w-4 text-muted" />}
          label={t(locale, "chatCopyPlain")}
        />
      </Item>
      {Separator && <Separator />}
      {savedId ? (
        <Item onSelect={() => router.push(`/w/${slug}/${savedId}`)}>
          <ActionRow
            id="openSaved"
            icon={<Sparkles className="h-4 w-4 text-muted" />}
            label={`Open “${savedTitle ?? "note"}”`}
          />
        </Item>
      ) : (
        <Item onSelect={save} disabled={pending}>
          <ActionRow
            id="save"
            icon={<FilePlus2 className="h-4 w-4 text-muted" />}
            label={pending ? "…" : t(locale, "chatSaveNote")}
          />
        </Item>
      )}
      <Item
        onSelect={() =>
          onFollowUp(
            "Expand on your last answer — go deeper on the parts that matter and keep it structured.",
          )
        }
      >
        <ActionRow
          id="followUp"
          icon={<MessageSquarePlus className="h-4 w-4 text-muted" />}
          label={t(locale, "chatFollowUp")}
        />
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
          <ActionRow
            id="regenerate"
            icon={<RefreshCw className="h-4 w-4 text-muted" />}
            label={t(locale, "chatRegenerate")}
          />
        </Item>
      )}
      {message.threadPageId && (
        <Item onSelect={() => router.push(`/w/${slug}/${message.threadPageId}`)}>
          <ActionRow
            id="openNote"
            icon={<Sparkles className="h-4 w-4 text-muted" />}
            label="Open the note this discusses"
          />
        </Item>
      )}
    </>
  );
}
