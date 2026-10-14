"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, MessageSquare, Quote, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  addCommentAction,
  deleteCommentAction,
  editCommentAction,
  resolveCommentAction,
} from "@/server/actions/comments";
import { Button } from "@/components/ui/button";
import { CommentReactions } from "@/components/comment-reactions";
import { actionError, safeAction } from "@/lib/actions-client";
import { cn, initials, avatarColor } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { LocalTime } from "@/components/local-time";

export type CommentNode = {
  id: string;
  body: string;
  quote: string | null;
  resolved: boolean;
  reactions: { emoji: string; count: number; mine: boolean }[];
  createdAt: string;
  author: { id: string; name: string; avatarUrl: string | null };
  replies: {
    id: string;
    body: string;
    createdAt: string;
    author: { id: string; name: string; avatarUrl: string | null };
  }[];
};

/** Custom event the editor fires when "Comment" is pressed. */
export const COMMENT_EVENT = "noema:comment";

export function CommentPanel({
  locale,
  pageId,
  comments,
  currentUserId,
  canComment,
}: {
  pageId: string;
  comments: CommentNode[];
  currentUserId: string;
  canComment: boolean;
  locale: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [quote, setQuote] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [flash, setFlash] = useState(false);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // The editor's "Comment" action hands the selection to us here.
  useEffect(() => {
    const onComment = (event: Event) => {
      const detail = (event as CustomEvent<{ quote?: string }>).detail;
      setQuote((detail?.quote ?? "").slice(0, 500));
      setReplyTo(null);
      composerRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      inputRef.current?.focus();
      setFlash(true);
      window.setTimeout(() => setFlash(false), 1200);
    };
    window.addEventListener(COMMENT_EVENT, onComment);
    return () => window.removeEventListener(COMMENT_EVENT, onComment);
  }, []);

  const submit = (text: string, parentId: string | null) => {
    if (!text.trim()) return;
    startTransition(async () => {
      const outcome = await safeAction(() =>
        addCommentAction({
          pageId,
          body: text,
          parentId,
          quote: parentId ? undefined : quote.trim() || undefined,
        }),
      );
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      const failure = actionError(outcome.value);
      if (failure) {
        toast.error(failure);
        return;
      }
      setBody("");
      setReplyBody("");
      setReplyTo(null);
      setQuote("");
      toast.success(parentId ? "Reply added" : "Comment added");
      router.refresh();
    });
  };

  const toggleResolved = (id: string, resolved: boolean) =>
    startTransition(async () => {
      const outcome = await safeAction(() => resolveCommentAction(id, resolved));
      if (!outcome.ok) toast.error(outcome.error);
      router.refresh();
    });

  const remove = (id: string) =>
    startTransition(async () => {
      const outcome = await safeAction(() => deleteCommentAction(id));
      if (!outcome.ok) toast.error(outcome.error);
      router.refresh();
    });

  return (
    <section className="mt-14 border-t border-border pt-8">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
        <MessageSquare className="h-4 w-4" />
        {t(locale, "commentsHeading")} ({comments.length})
      </h2>

      <ul className="space-y-5">
        {comments.map((comment) => (
          <li key={comment.id} className="flex gap-3">
            <Avatar name={comment.author.name} seed={comment.author.id} />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  {comment.author.name}
                </span>
                <span className="text-xs text-muted">
                  {<LocalTime value={comment.createdAt} />}
                </span>
                {comment.resolved && (
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-600">
                    Resolved
                  </span>
                )}
              </div>
              {comment.quote && (
                <p className="mt-1 border-l-2 border-border pl-2 text-xs italic text-muted">
                  {comment.quote}
                </p>
              )}
              {editingId === comment.id ? (
                <form
                  className="mt-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const value = editBody.trim();
                    if (!value) return;
                    startTransition(async () => {
                      const outcome = await safeAction(() => editCommentAction(comment.id, value));
                      const failure = actionError(outcome.ok ? outcome.value : undefined) ?? (outcome.ok ? null : outcome.error);
                      if (failure) {
                        toast.error(failure);
                        return;
                      }
                      setEditingId(null);
                      toast.success("Comment updated");
                      router.refresh();
                    });
                  }}
                >
                  <textarea
                    defaultValue={comment.body}
                    aria-label={t(locale, "editComment")}
                    onChange={(event) => setEditBody(event.target.value)}
                    rows={3}
                    className="w-full rounded border border-border bg-bg px-2 py-1 text-sm outline-none focus:border-accent"
                  />
                  <span className="mt-1 flex items-center gap-2">
                    <Button type="submit" size="sm">
                      Save
                    </Button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="text-xs text-muted hover:text-fg"
                    >
                      Cancel
                    </button>
                  </span>
                </form>
              ) : (
                <p className="mt-1 whitespace-pre-wrap text-sm">{comment.body}</p>
              )}

              <div className="mt-1 flex items-center gap-3 text-xs text-muted">
                <CommentReactions
                  commentId={comment.id}
                  reactions={comment.reactions}
                  locale={locale}
                />
                <button
                  type="button"
                  onClick={() =>
                    setReplyTo((v) => (v === comment.id ? null : comment.id))
                  }
                  className="hover:text-fg"
                >
                  Reply
                </button>
                {canComment && (
                  <button
                    type="button"
                    onClick={() => toggleResolved(comment.id, !comment.resolved)}
                    className="flex items-center gap-1 hover:text-fg"
                  >
                    <Check className="h-3 w-3" />
                    {comment.resolved ? t(locale, "reopen") : t(locale, "resolve")}
                  </button>
                )}
                {comment.author.id === currentUserId && editingId !== comment.id && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditBody(comment.body);
                      setEditingId(comment.id);
                    }}
                    className="hover:text-fg"
                  >
                    Edit
                  </button>
                )}
                {comment.author.id === currentUserId && (
                  <button
                    type="button"
                    onClick={() => remove(comment.id)}
                    className="flex items-center gap-1 hover:text-red-500"
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </button>
                )}
              </div>

              {comment.replies.length > 0 && (
                <ul className="mt-3 space-y-3 border-l border-border pl-4">
                  {comment.replies.map((reply) => (
                    <li key={reply.id} className="flex gap-2">
                      <Avatar
                        name={reply.author.name}
                        seed={reply.author.id}
                        size="sm"
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">
                            {reply.author.name}
                          </span>
                          <span className="text-xs text-muted">
                            {<LocalTime value={reply.createdAt} />}
                          </span>
                        </div>
                        <p className="mt-0.5 whitespace-pre-wrap text-sm">
                          {reply.body}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {replyTo === comment.id && (
                <div className="mt-3 space-y-2">
                  <textarea
                    value={replyBody}
                    aria-label={t(locale, "writeReply")}
                    onChange={(e) => setReplyBody(e.target.value)}
                    rows={2}
                    placeholder="Write a reply…"
                    className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                  <Button
                    size="sm"
                    aria-label={t(locale, "postReply")}
                    disabled={pending}
                    onClick={() => submit(replyBody, comment.id)}
                  >
                    Reply
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {canComment && (
        <div
          ref={composerRef}
          className={cn(
            "mt-6 space-y-2 rounded-lg border p-3 transition",
            flash
              ? "border-accent bg-accent/5 ring-2 ring-accent/30"
              : "border-border",
          )}
        >
          {quote && (
            <div className="flex items-start gap-2 rounded-md bg-surface px-2 py-1.5 text-xs text-muted">
              <Quote className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{quote}</span>
              <button
                type="button"
                aria-label="Remove quoted text"
                onClick={() => setQuote("")}
                className="shrink-0 hover:text-fg"
              >
                ×
              </button>
            </div>
          )}
          <textarea
            ref={inputRef}
            value={body}
            aria-label={t(locale, "addComment")}
            data-comment-input
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder={quote ? "Comment on the selected text…" : "Add a comment…"}
            className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <Button
            size="sm"
            aria-label={t(locale, "postComment")}
            disabled={pending || !body.trim()}
            onClick={() => submit(body, null)}
          >
            {pending ? "Posting…" : "Comment"}
          </Button>
        </div>
      )}
    </section>
  );
}

function Avatar({
  name,
  seed,
  size = "md",
}: {
  name: string;
  seed: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-medium text-white",
        size === "sm" ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-xs",
      )}
      style={{ backgroundColor: avatarColor(seed) }}
    >
      {initials(name)}
    </span>
  );
}
