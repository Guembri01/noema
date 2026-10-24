"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  CornerDownRight,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Quote,
  Reply,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  addCommentAction,
  deleteCommentAction,
  editCommentAction,
  resolveCommentAction,
} from "@/server/actions/comments";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import {
  CommentReactions,
  type ReactionRow,
} from "@/components/comment-reactions";
import { actionError, safeAction } from "@/lib/actions-client";
import { resolveAvatar, type Avatar as ResolvedAvatar } from "@/lib/avatars";
import { cn } from "@/lib/utils";
import { contentDirProps } from "@/lib/bidi";
import { parseCommentBody, toPlainText, type CommentSegment } from "@/lib/comment-body";
import { extractMentions } from "@/lib/comments";
import { type CommentAnchorState } from "@/lib/comment-anchors";
import {
  COMMENT_ANCHOR_STATE_EVENT,
  COMMENT_EVENT,
  COMMENT_JUMP_EVENT,
  type CommentAnchorStateRequest,
  type CommentJumpRequest,
  type CommentRequest,
} from "@/lib/editor-events";
import { t } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/i18n-format";
import { stableTime } from "@/lib/time";
import { sanitizeHref } from "@/lib/validation";
import {
  buildThreads,
  threadCounts,
  validateThreadDepth,
  type Comment as ThreadComment,
} from "@/lib/comment-threads";

/**
 * Page comment panel (docs/DESIGN_SYSTEM.md §8, §9).
 *
 * The pure side of this module is deliberately small and exported so it can be
 * node-tested without a DOM or a Next runtime: `commentAvatar` maps a wire
 * author to a resolved avatar, `resolveState` reads a thread's open/resolved
 * state, `mentionHints` extracts the `@tokens` in a draft, and
 * `relativeTimestamp` phrases an instant. Everything else is presentation.
 *
 * The view adopts the design system end to end: `Avatar` for every author, a
 * `Tag` for the resolved badge and the filter chips, `Textarea`/`Button`/`Kbd`
 * in both composers, `Skeleton` for loading, `EmptyState` for the zero state,
 * `DropdownMenu` for the per-comment "More" menu and the shared
 * `CommentReactions` + `EmojiPicker` for reactions. Motion and colour are tokens
 * only — no raw hex, no magic z-index, no ad-hoc duration — and every panel
 * state (loading / empty / error / data) has a keyboard path.
 */

export type CommentAuthor = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

export type CommentNode = {
  id: string;
  body: string;
  quote: string | null;
  /** Stable top-level block id the selection was anchored to, when known. */
  blockId: string | null;
  /** Exact range start inside `blockId`'s plain text (root comments). */
  anchorFrom?: number | null;
  /** Exact range end inside `blockId`'s plain text (root comments). */
  anchorTo?: number | null;
  /** Whether the stored range still matches the current block text. */
  anchorState?: CommentAnchorState;
  resolved: boolean;
  reactions: ReactionRow[];
  createdAt: string;
  author: CommentAuthor;
  replies: {
    id: string;
    body: string;
    createdAt: string;
    author: CommentAuthor;
    reactions?: ReactionRow[];
  }[];
};

/** Custom event the editor fires when "Comment" is pressed. */
export { COMMENT_EVENT } from "@/lib/editor-events";

/** Pure: validate the editor's hand-off before it reaches composer state. */
export function commentComposerAnchor(
  detail: CommentRequest | undefined,
): {
  quote: string;
  blockId: string | null;
  from: number | null;
  to: number | null;
} {
  const quote = (detail?.quote ?? "").slice(0, 500);
  const blockId =
    typeof detail?.blockId === "string" && detail.blockId.trim() !== ""
      ? detail.blockId
      : null;
  const from = detail?.from;
  const to = detail?.to;
  const hasRange =
    typeof from === "number" &&
    Number.isInteger(from) &&
    from >= 0 &&
    typeof to === "number" &&
    Number.isInteger(to) &&
    to > from;
  return {
    quote,
    blockId,
    from: hasRange ? (from as number) : null,
    to: hasRange ? (to as number) : null,
  };
}

/** Pure: the panel's jump request for a stored root-comment anchor, or null. */
export function commentJumpTarget(comment: {
  id: string;
  blockId: string | null;
  quote?: string | null;
  anchorFrom?: number | null;
  anchorTo?: number | null;
}): CommentJumpRequest | null {
  if (!comment.blockId || comment.blockId.trim() === "") return null;
  return {
    commentId: comment.id,
    blockId: comment.blockId,
    quote: comment.quote ?? null,
    from: comment.anchorFrom ?? null,
    to: comment.anchorTo ?? null,
  };
}

/**
 * How long the composer keeps its accent flash after the editor hands it a
 * selection. Named (not inline) so the value is pinned by a test, mirroring the
 * `COPY_FEEDBACK_MS` pattern used elsewhere.
 */
export const COMMENT_FLASH_MS = 1200;

/** Ceiling the auto-growing composer stops at before it scrolls internally. */
export const COMPOSER_MAX_HEIGHT_PX = 200;

/** Synthetic row id for the probe reply the depth gate below validates. */
const PENDING_REPLY_ID = "__ui_pending_reply__";

/**
 * Which threads the panel lists: every thread (the default), only open ones, or
 * only resolved ones. A thread counts as resolved when its root carries a
 * `resolvedAt` stamp in the shared `src/lib/comment-threads.ts` model - the same
 * truth `threadCounts` tallies.
 */
type ResolvedFilter = "all" | "open" | "resolved";

/**
 * Filter chips, in display order; `all` is first so "showing all" is default.
 * Chip labels resolve through the shared i18n layer where an equivalent key
 * already exists (`open`, `resolvedLabel`); `all` has no such key yet, so its
 * chip keeps the literal `label` fallback.
 */
const RESOLVED_FILTERS: readonly {
  value: ResolvedFilter;
  labelKey: Parameters<typeof t>[1] | null;
  label: string;
}[] = [
  { value: "all", labelKey: null, label: "All" },
  { value: "open", labelKey: "open", label: "Open" },
  { value: "resolved", labelKey: "resolvedLabel", label: "Resolved" },
];

/** A thread's resolve state, as read by the badge and the filter. */
export type ResolveState = "open" | "resolved";

/** Pure: `resolved` boolean (the wire shape) → the panel's thread state. */
export function resolveState(resolved: boolean): ResolveState {
  return resolved ? "resolved" : "open";
}

/** Pure: a wire author → a resolved avatar (image or deterministic initials). */
export function commentAvatar(author: {
  id: string;
  name: string;
  avatarUrl?: string | null;
}): ResolvedAvatar {
  return resolveAvatar({
    id: author.id,
    name: author.name,
    avatarUrl: author.avatarUrl ?? null,
  });
}

/** Pure: the unique `@mention` tokens in a draft, in appearance order. */
export function mentionHints(body: string | null | undefined): string[] {
  return extractMentions(body ?? "");
}

/** Pure: an ISO instant as a relative phrase (deterministic with `base`). */
export function relativeTimestamp(
  iso: string,
  options: { locale?: string; base?: Date | number | string } = {},
): string {
  return formatRelativeTime(iso, { locale: options.locale, base: options.base });
}

/**
 * Flatten the server-shaped nodes into the pure thread model
 * (`src/lib/comment-threads.ts`) so `buildThreads`/`threadCounts` can drive the
 * resolved/unresolved readout. Purely derived - the boolean `resolved` maps to
 * `resolvedAt` presence (only whether the stamp exists is read, never its
 * value) and reactions are left out of this projection. The wire shape and the
 * server-authoritative actions are untouched.
 */
function toThreadComments(comments: CommentNode[]): ThreadComment[] {
  return comments.flatMap((comment) => [
    {
      id: comment.id,
      threadId: comment.id,
      authorId: comment.author.id,
      body: comment.body,
      createdAt: comment.createdAt,
      resolvedAt: comment.resolved ? comment.createdAt : undefined,
    },
    ...comment.replies.map((reply) => ({
      id: reply.id,
      threadId: comment.id,
      parentId: comment.id,
      authorId: reply.author.id,
      body: reply.body,
      createdAt: reply.createdAt,
    })),
  ]);
}

/**
 * Whether a new reply may target `parentId` under the one-level thread rule
 * (R79.1, feat/m07). Mirrors `addCommentAction`: append a synthetic reply to
 * the flattened thread rows and let the shared pure `validateThreadDepth`
 * decide with `maxDepth: 1`. A root (depth 0) is always replyable; a depth-1
 * reply never is, so the Reply affordance can be hidden/annotated exactly where
 * the server would reject the write.
 */
function canReplyTo(
  comments: readonly ThreadComment[],
  parentId: string,
): boolean {
  const parent = comments.find((comment) => comment.id === parentId);
  if (!parent) return false;
  const pending: ThreadComment = {
    id: PENDING_REPLY_ID,
    threadId: parent.threadId,
    parentId,
    authorId: "",
    body: "",
    createdAt: parent.createdAt,
  };
  return !validateThreadDepth([...comments, pending], { maxDepth: 1 }).some(
    (issue) => issue.commentId === PENDING_REPLY_ID,
  );
}

/** Grow a textarea to its content, up to a pixel ceiling (no layout jump). */
function resizeTextarea(
  node: HTMLTextAreaElement | null,
  maxHeightPx: number,
): void {
  if (!node) return;
  node.style.height = "auto";
  node.style.height = `${Math.min(node.scrollHeight, maxHeightPx)}px`;
}

/**
 * Auto-grow for a controlled textarea: `resize` runs after every render (so a
 * value that changes from props grows too) and on demand from `onChange`.
 * `height: auto` is set first so the box only ever measures the content, which
 * is what keeps the surrounding layout from jumping as it grows.
 */
function useAutoGrowTextarea(maxHeightPx: number): {
  ref: RefObject<HTMLTextAreaElement | null>;
  resize: () => void;
} {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const resize = useCallback(
    () => resizeTextarea(ref.current, maxHeightPx),
    [maxHeightPx],
  );
  useEffect(resize);
  return { ref, resize };
}

/**
 * Scroll the editor to a persisted block anchor. The editor stamps
 * `data-block-id` on every top-level block, so this works from the comment
 * panel below the editor without threading an editor instance through the
 * panel. Returns `false` when the block is gone (deleted, or a different page),
 * letting the caller explain why nothing moved.
 */
function scrollToBlock(blockId: string): boolean {
  if (typeof document === "undefined" || blockId.trim() === "") return false;
  const blocks = document.querySelectorAll<HTMLElement>("[data-block-id]");
  for (const block of blocks) {
    if (block.getAttribute("data-block-id") !== blockId) continue;
    block.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
    });
    return true;
  }
  return false;
}

/** Honour the user's motion preference for the panel-triggered scroll. */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * A timestamp that survives hydration: `stableTime` (fixed locale + UTC) on the
 * server and the first client paint, then the user's own relative phrasing
 * after mount. `dateTime`/`title` always carry the exact instant.
 */
function RelativeTime({
  value,
  locale,
  className,
}: {
  value: string;
  locale: string;
  className?: string;
}) {
  const [label, setLabel] = useState(() => stableTime(value, "datetime"));
  useEffect(() => {
    setLabel(formatRelativeTime(value, { locale }));
  }, [value, locale]);
  return (
    <time
      dateTime={value}
      title={stableTime(value, "datetime")}
      className={className}
      suppressHydrationWarning
    >
      {label}
    </time>
  );
}

/** The `@mention` hints under a composer; a quiet prompt when there are none. */
function MentionHints({ body }: { body: string }) {
  const mentions = mentionHints(body);
  if (mentions.length === 0) {
    return <p className="text-xs text-fg-subtle">Type @ to mention someone</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="mention-hints">
      {mentions.map((mention) => (
        <Tag key={mention} size="sm" data-testid={`mention-hint-${mention}`}>
          @{mention}
        </Tag>
      ))}
    </div>
  );
}

/**
 * The `loading` half of the panel's states contract: skeleton threads shaped
 * like the real rows (avatar + two text lines) so nothing shifts on load.
 */
function CommentListSkeleton() {
  return (
    <div className="space-y-4" data-testid="comment-list-loading" aria-hidden>
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="flex gap-3 rounded-card border border-border bg-bg p-3"
        >
          <Skeleton variant="circle" width={32} height={32} />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton variant="text" lines={1} className="w-40" />
            <Skeleton variant="text" lines={2} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CommentPanel({
  locale,
  pageId,
  comments,
  currentUserId,
  canComment,
  loading = false,
  loadError = null,
  onRetry,
  focusCommentId,
}: {
  pageId: string;
  comments: CommentNode[];
  currentUserId: string;
  canComment: boolean;
  locale: string;
  /** First-paint state: render the skeleton thread list. */
  loading?: boolean;
  /** The list failed to load: render the error + retry state. */
  loadError?: string | null;
  /** Retry hook for the error state; defaults to `router.refresh()`. */
  onRetry?: () => void;
  /** A deep link target: scroll to and briefly highlight this comment. */
  focusCommentId?: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [quote, setQuote] = useState("");
  const [anchorBlockId, setAnchorBlockId] = useState<string | null>(null);
  const [anchorFrom, setAnchorFrom] = useState<number | null>(null);
  const [anchorTo, setAnchorTo] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [pending, startTransition] = useTransition();
  const [flash, setFlash] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  /**
   * Ranges the live editor has reported as no longer matching their quote.
   * Server state starts the badge; this keeps it accurate while the user types.
   */
  const [liveStale, setLiveStale] = useState<ReadonlySet<string>>(new Set());
  // Resolved/open filter; `all` keeps every thread visible by default.
  const [resolvedFilter, setResolvedFilter] = useState<ResolvedFilter>("all");
  const composerRef = useRef<HTMLDivElement | null>(null);
  const composerErrorId = useId();

  const mainArea = useAutoGrowTextarea(COMPOSER_MAX_HEIGHT_PX);
  const replyArea = useAutoGrowTextarea(COMPOSER_MAX_HEIGHT_PX);
  const inputRef = mainArea.ref;

  // Purely derived from the props: flatten the roots/replies into the pure
  // thread model once, then group via `buildThreads` and tally resolved vs open
  // threads via `threadCounts`. Read-only presentation - no action or wire
  // shape changes.
  const threadComments = useMemo(() => toThreadComments(comments), [comments]);

  const threads = useMemo(() => buildThreads(threadComments), [threadComments]);

  const counts = useMemo(() => threadCounts(threads), [threads]);

  // Threads the filter admits, keyed by root id. `buildThreads` owns the
  // resolved truth (`root.resolvedAt`), so filtering the grouped threads keeps
  // the readout and the list on one source; props order is preserved when the
  // visible roots are projected back, so nothing but visibility changes.
  const visibleThreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of threads) {
      const resolved = thread.root.resolvedAt !== undefined;
      if (
        resolvedFilter === "all" ||
        resolved === (resolvedFilter === "resolved")
      ) {
        ids.add(thread.root.id);
      }
    }
    return ids;
  }, [threads, resolvedFilter]);

  const visibleComments = useMemo(
    () => comments.filter((comment) => visibleThreadIds.has(comment.id)),
    [comments, visibleThreadIds],
  );

  const [focusedComment, setFocusedComment] = useState<string | null>(null);

  // Deep link from the inbox (`?comment=<id>`): scroll the exact thread into
  // view and flash it briefly. The block anchor in `#<blockId>` is handled by
  // the browser when the editor renders the block.
  useEffect(() => {
    if (!focusCommentId) return;
    const element = document.getElementById(`comment-${focusCommentId}`);
    if (!element) return;
    element.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    setFocusedComment(focusCommentId);
    const timer = window.setTimeout(() => setFocusedComment(null), 2200);
    return () => window.clearTimeout(timer);
  }, [focusCommentId]);

  const filterCounts: Record<ResolvedFilter, number> = {
    all: counts.threads,
    open: counts.unresolved,
    resolved: counts.resolved,
  };

  // Which comments may be replied to, per the shared one-level depth rule: a
  // root is replyable, a depth-1 reply is not (R79.1, feat/m07). Computed over
  // every thread - filtering the visible list never relaxes the reply gate.
  const replyableIds = useMemo(
    () =>
      new Set(
        threadComments
          .filter((comment) => canReplyTo(threadComments, comment.id))
          .map((comment) => comment.id),
      ),
    [threadComments],
  );

  // The editor's "Comment" action hands the selection to us here.
  useEffect(() => {
    const onComment = (event: Event) => {
      const detail = (event as CustomEvent<CommentRequest>).detail;
      const anchor = commentComposerAnchor(detail);
      setQuote(anchor.quote);
      setAnchorBlockId(anchor.blockId);
      // The editor's real selection, when it captured one. Both offsets must be
      // present; a half range is dropped rather than guessed.
      setAnchorFrom(anchor.from);
      setAnchorTo(anchor.to);
      setReplyTo(null);
      composerRef.current?.scrollIntoView({
        block: "center",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      inputRef.current?.focus();
      setFlash(true);
      window.setTimeout(() => setFlash(false), COMMENT_FLASH_MS);
    };
    window.addEventListener(COMMENT_EVENT, onComment);
    return () => window.removeEventListener(COMMENT_EVENT, onComment);
  }, [inputRef]);

  // The live editor reports ranges whose text changed. Only the exact-range
  // claim is withdrawn; the quote stays visible.
  useEffect(() => {
    const onAnchorState = (event: Event) => {
      const detail = (event as CustomEvent<CommentAnchorStateRequest>).detail;
      const ids = Array.isArray(detail?.staleIds) ? detail.staleIds : [];
      setLiveStale(new Set(ids.filter((id) => typeof id === "string")));
    };
    window.addEventListener(COMMENT_ANCHOR_STATE_EVENT, onAnchorState);
    return () =>
      window.removeEventListener(COMMENT_ANCHOR_STATE_EVENT, onAnchorState);
  }, []);

  const submit = (text: string, parentId: string | null) => {
    if (!text.trim()) return;
    setComposerError(null);
    startTransition(async () => {
      const outcome = await safeAction(() =>
        addCommentAction({
          pageId,
          body: text,
          parentId,
          quote: parentId ? undefined : quote.trim() || undefined,
          blockId: parentId ? undefined : anchorBlockId ?? undefined,
          anchorFrom: parentId ? undefined : anchorFrom ?? undefined,
          anchorTo: parentId ? undefined : anchorTo ?? undefined,
        }),
      );
      if (!outcome.ok) {
        setComposerError(outcome.error);
        toast.error(outcome.error);
        return;
      }
      const failure = actionError(outcome.value);
      if (failure) {
        setComposerError(failure);
        toast.error(failure);
        return;
      }
      setBody("");
      setReplyBody("");
      setReplyTo(null);
      setQuote("");
      setAnchorBlockId(null);
      setAnchorFrom(null);
      setAnchorTo(null);
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

  const retry = onRetry ?? (() => router.refresh());

  const showThreadList =
    !loading && !loadError && visibleComments.length > 0;
  const showEmpty = !loading && !loadError && counts.threads === 0;

  return (
    <section className="mt-14 border-t border-border pt-8" aria-busy={pending}>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted">
          <MessageSquare className="h-4 w-4" />
          {t(locale, "commentsHeading")} ({counts.threads})
        </h2>
        {counts.threads > 0 && (
          <p className="text-xs text-muted">
            {counts.resolved} resolved · {counts.unresolved} open
          </p>
        )}
        {counts.threads > 0 && (
          // Resolved/open filter: `All` (default) shows every thread, while
          // `Open`/`Resolved` hide the other side. Counts come from the shared
          // `threadCounts`, so the chips and the readout never disagree.
          <div role="group" aria-label={t(locale, "filter")} className="flex items-center gap-1">
            {RESOLVED_FILTERS.map(({ value, label, labelKey }) => (
              <Tag
                key={value}
                size="sm"
                selected={resolvedFilter === value}
                onSelectedChange={() => setResolvedFilter(value)}
                data-testid={`thread-filter-${value}`}
              >
                {labelKey ? t(locale, labelKey) : label} ({filterCounts[value]})
              </Tag>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <CommentListSkeleton />
      ) : loadError ? (
        <EmptyState
          variant="compact"
          data-testid="comment-error"
          icon={<AlertTriangle />}
          title={t(locale, "somethingWentWrong")}
          description={loadError}
          primaryAction={
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
              onClick={retry}
            >
              {t(locale, "retry")}
            </Button>
          }
        />
      ) : showEmpty ? (
        <EmptyState
          variant="compact"
          data-testid="comment-empty"
          icon={<MessageSquare />}
          title="No comments yet"
          description="Start the discussion."
          primaryAction={
            canComment ? (
              <Button size="sm" onClick={() => inputRef.current?.focus()}>
                {t(locale, "addComment")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {visibleComments.length === 0 && counts.threads > 0 && (
            <p className="text-sm text-muted">
              {resolvedFilter === "resolved"
                ? "No resolved threads."
                : "No open threads."}
            </p>
          )}
          {showThreadList && (
            <ul className="space-y-4">
              {visibleComments.map((comment) => {
                const isAuthor = comment.author.id === currentUserId;
                const resolved = resolveState(comment.resolved) === "resolved";
                const canReplyToThis = replyableIds.has(comment.id);
                const commentBlockId = comment.blockId;
                const jumpTarget = commentJumpTarget(comment);
                const anchorStale =
                  comment.anchorState === "stale" ||
                  liveStale.has(comment.id);
                const anchorValid =
                  comment.anchorState === "valid" && !liveStale.has(comment.id);
                const jumpLabel = anchorValid ? "Jump to text" : t(locale, "jumpToBlock");
                // Quoted page text is user-authored too: isolate it so a mixed
                // quote never reorders the comment header around it.
                const quoteDirection = contentDirProps(comment.quote ?? "");
                return (
                  <li
                    key={comment.id}
                    id={`comment-${comment.id}`}
                    data-testid={`comment-${comment.id}`}
                    data-focused={focusedComment === comment.id ? "true" : undefined}
                    data-resolved={resolved ? "true" : undefined}
                    className={cn(
                      "group u-surface flex gap-3 rounded-card border p-3",
                      resolved
                        ? "border-border bg-surface-2/50"
                        : "border-border bg-bg",
                      focusedComment === comment.id &&
                        "ring-2 ring-focus ring-offset-2 ring-offset-bg",
                    )}
                  >
                    <Avatar
                      user={{
                        id: comment.author.id,
                        name: comment.author.name,
                        avatarUrl: comment.author.avatarUrl,
                      }}
                      size={32}
                    />
                    <div className={cn("min-w-0 flex-1", resolved && "text-muted")}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          <bdi>{comment.author.name}</bdi>
                        </span>
                        <RelativeTime
                          value={comment.createdAt}
                          locale={locale}
                          className="shrink-0 text-xs text-muted"
                        />
                        {resolved && (
                          <Tag hue="green" size="sm" dot data-testid="resolved-tag">
                            {t(locale, "resolvedLabel")}
                          </Tag>
                        )}
                      </div>

                      {comment.quote && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <blockquote
                            data-testid="comment-quote"
                            dir={quoteDirection.dir}
                            className={cn(
                              "rounded-md border-s-2 border-s-accent bg-surface-2 px-2.5 py-1.5 text-xs italic text-muted",
                              quoteDirection.className,
                            )}
                          >
                            {comment.quote}
                          </blockquote>
                          {anchorStale && (
                            // The quote is kept, but the persisted range no
                            // longer matches the block: say so instead of
                            // highlighting the wrong words.
                            <Tag
                              hue="orange"
                              size="sm"
                              data-testid="comment-anchor-stale"
                              title="The text this comment quoted has changed."
                            >
                              Text changed
                            </Tag>
                          )}
                        </div>
                      )}

                      {commentBlockId && jumpTarget && (
                        <button
                          type="button"
                          data-testid={`comment-jump-${comment.id}`}
                          data-comment-block-id={commentBlockId}
                          data-comment-anchor-state={comment.anchorState ?? "block"}
                          aria-label={`${jumpLabel}: ${commentBlockId}`}
                          onClick={() => {
                            // The editor listens for the exact range and paints
                            // it; the DOM scroll is the fallback for a block the
                            // editor no longer renders (deleted/other page).
                            window.dispatchEvent(
                              new CustomEvent(COMMENT_JUMP_EVENT, {
                                detail: jumpTarget,
                              }),
                            );
                            if (!scrollToBlock(commentBlockId)) {
                              toast.error(t(locale, "nothingToWorkWith"));
                            }
                          }}
                          className="focus-ring u-colors mt-2 flex items-center gap-1 rounded-xs text-xs text-accent hover:underline"
                        >
                          <CornerDownRight className="h-3 w-3" />
                          {jumpLabel}
                        </button>
                      )}

                      {editingId === comment.id ? (
                        <form
                          className="mt-2 space-y-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const value = editBody.trim();
                            if (!value) return;
                            startTransition(async () => {
                              const outcome = await safeAction(() =>
                                editCommentAction(comment.id, value),
                              );
                              const failure =
                                actionError(outcome.ok ? outcome.value : undefined) ??
                                (outcome.ok ? null : outcome.error);
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
                          <Textarea
                            defaultValue={comment.body}
                            dir={contentDirProps(comment.body).dir}
                            aria-label={t(locale, "editComment")}
                            onChange={(event) => setEditBody(event.target.value)}
                            size="sm"
                          />
                          <div className="flex items-center gap-2">
                            <Button type="submit" size="sm">
                              {t(locale, "save")}
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => setEditingId(null)}
                            >
                              {t(locale, "cancel")}
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <CommentBody body={comment.body} className="mt-1 text-sm" />
                      )}

                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <CommentReactions
                          commentId={comment.id}
                          reactions={comment.reactions}
                          locale={locale}
                          userId={currentUserId}
                        />
                        {/* Reply / Resolve / More: revealed on hover and on
                            keyboard focus, never hidden from the tab order. */}
                        <span
                          data-testid="comment-actions"
                          className="u-transform flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100"
                        >
                          {canReplyToThis ? (
                            <Button
                              variant="ghost"
                              size="xs"
                              leftIcon={<Reply className="h-3.5 w-3.5" />}
                              onClick={() =>
                                setReplyTo((value) =>
                                  value === comment.id ? null : comment.id,
                                )
                              }
                            >
                              {t(locale, "reply")}
                            </Button>
                          ) : (
                            // A root should always be replyable; if the depth
                            // gate ever rejects one, keep the affordance visible
                            // but annotate-only rather than dispatching a write
                            // the server would refuse.
                            <span
                              title={t(locale, "linkLimitOneLevel")}
                              data-reply-limited="true"
                              className="cursor-default select-none px-2 text-xs text-muted/60"
                            >
                              {t(locale, "reply")}
                            </span>
                          )}
                          {canComment && (
                            <Button
                              variant="ghost"
                              size="xs"
                              leftIcon={<Check className="h-3.5 w-3.5" />}
                              onClick={() =>
                                toggleResolved(comment.id, !comment.resolved)
                              }
                            >
                              {comment.resolved
                                ? t(locale, "reopen")
                                : t(locale, "resolve")}
                            </Button>
                          )}
                          {isAuthor && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={t(locale, "moreActions")}
                                >
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start">
                                <DropdownMenuItem
                                  onSelect={() => {
                                    setEditBody(comment.body);
                                    setEditingId(comment.id);
                                  }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                  Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => remove(comment.id)}
                                  className="text-danger"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  {t(locale, "delete")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </span>
                      </div>

                      {comment.replies.length > 0 && (
                        <ul className="mt-3 space-y-3 border-s border-border ps-4">
                          {comment.replies.map((reply) => (
                            <li key={reply.id} className="flex gap-2">
                              <Avatar
                                user={{
                                  id: reply.author.id,
                                  name: reply.author.name,
                                  avatarUrl: reply.author.avatarUrl,
                                }}
                                size={24}
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="truncate text-sm font-medium">
                                    <bdi>{reply.author.name}</bdi>
                                  </span>
                                  <RelativeTime
                                    value={reply.createdAt}
                                    locale={locale}
                                    className="shrink-0 text-xs text-muted"
                                  />
                                </div>
                                <CommentBody
                                  body={reply.body}
                                  className="mt-0.5 text-sm"
                                />
                                {reply.reactions && reply.reactions.length > 0 && (
                                  <div className="mt-1">
                                    <CommentReactions
                                      commentId={reply.id}
                                      reactions={reply.reactions}
                                      locale={locale}
                                      userId={currentUserId}
                                    />
                                  </div>
                                )}
                                {/* Depth-aware reply affordance: a reply is a
                                    depth-1 node, so replying to it would exceed
                                    the one-level thread rule (R79.1). Keep the
                                    action visible but annotate it instead of
                                    dispatching a rejected write. */}
                                {!replyableIds.has(reply.id) && (
                                  <span
                                    title={t(locale, "linkLimitOneLevel")}
                                    data-reply-limited="true"
                                    className="mt-1 inline-block cursor-default select-none text-xs text-muted/60"
                                  >
                                    {t(locale, "reply")}
                                  </span>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}

                      {replyTo === comment.id && (
                        <div className="mt-3 space-y-2">
                          <Textarea
                            ref={replyArea.ref}
                            value={replyBody}
                            dir={contentDirProps(replyBody).dir}
                            aria-label={t(locale, "writeReply")}
                            onChange={(event) => {
                              setReplyBody(event.target.value);
                              replyArea.resize();
                            }}
                            size="sm"
                            placeholder={t(locale, "writeReply")}
                            className="resize-none"
                          />
                          <div className="flex items-center justify-between gap-2">
                            <MentionHints body={replyBody} />
                            <Button
                              size="sm"
                              aria-label={t(locale, "postReply")}
                              loading={pending}
                              disabled={!replyBody.trim()}
                              onClick={() => submit(replyBody, comment.id)}
                            >
                              {t(locale, "postReply")}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {canComment && (
        <div
          ref={composerRef}
          className={cn(
            "u-colors mt-6 space-y-2 rounded-lg border p-3",
            flash
              ? "border-focus bg-selection-soft"
              : "border-border",
          )}
        >
          {quote && (
            <div
              data-testid="comment-composer-quote"
              data-anchor-block-id={anchorBlockId ?? undefined}
              data-anchor-from={anchorFrom ?? undefined}
              data-anchor-to={anchorTo ?? undefined}
              className="flex items-start gap-2 rounded-control bg-surface px-2 py-1.5 text-xs text-muted"
            >
              <Quote className="mt-0.5 h-3 w-3 shrink-0" />
              <bdi className="min-w-0 flex-1 truncate">{quote}</bdi>
              <button
                type="button"
                aria-label={t(locale, "removeQuote")}
                onClick={() => {
                  setQuote("");
                  setAnchorBlockId(null);
                  setAnchorFrom(null);
                  setAnchorTo(null);
                }}
                className="focus-ring shrink-0 rounded-xs u-colors hover:text-fg"
              >
                ×
              </button>
            </div>
          )}
          <Textarea
            ref={inputRef}
            value={body}
            dir={contentDirProps(body).dir}
            aria-label={t(locale, "addComment")}
            data-comment-input
            invalid={Boolean(composerError)}
            aria-describedby={composerError ? composerErrorId : undefined}
            onChange={(event) => {
              setBody(event.target.value);
              mainArea.resize();
            }}
            onKeyDown={(event) => {
              // Ctrl/Cmd+Enter posts, matching the Kbd hint below.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit(body, null);
              }
            }}
            placeholder={quote ? t(locale, "commentOnSelection") : t(locale, "addAComment")}
            className="resize-none"
          />
          <MentionHints body={body} />
          {composerError && (
            <p
              id={composerErrorId}
              role="alert"
              className="flex items-center gap-2 text-xs text-danger"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{composerError}</span>
              <Button
                variant="ghost"
                size="xs"
                leftIcon={<RotateCcw className="h-3 w-3" />}
                onClick={() => submit(body, null)}
              >
                {t(locale, "retry")}
              </Button>
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-xs text-fg-subtle">
              Press
              <Kbd size="xs" keys={["Ctrl", "Enter"]} />
            </span>
            <span className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setBody("");
                  setQuote("");
                  setAnchorBlockId(null);
                  setAnchorFrom(null);
                  setAnchorTo(null);
                  setComposerError(null);
                }}
              >
                {t(locale, "cancel")}
              </Button>
              <Button
                size="sm"
                aria-label={t(locale, "postComment")}
                loading={pending}
                disabled={!body.trim()}
                onClick={() => submit(body, null)}
              >
                {t(locale, "postComment")}
              </Button>
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Render a stored comment body: split it with {@link parseCommentBody} so
 * `@[Label](userId)` mentions become chips, bare URLs become links and
 * `:shortcode:` tokens become their glyph, while everything else stays literal
 * text. Bodies with no rich segments take the canonical {@link toPlainText}
 * path. Presentation only — the wire body is never rewritten.
 */
function CommentBody({ body, className }: { body: string; className?: string }) {
  const segments = parseCommentBody(body);
  const rich = segments.some((segment) => segment.type !== "text");
  // A comment can be written in any script (or mix two). Give the paragraph
  // its own base direction so an Arabic body inside the English UI — and an
  // English body inside `ar` — keeps its punctuation on the authored side.
  const direction = contentDirProps(body);
  return (
    <p
      dir={direction.dir}
      className={cn("whitespace-pre-wrap", direction.className, className)}
    >
      {rich
        ? segments.map((segment, index) => (
            <CommentSegmentView key={index} segment={segment} />
          ))
        : toPlainText(segments)}
    </p>
  );
}

/** One parsed segment: a mention chip, an external link, an emoji or raw text. */
function CommentSegmentView({ segment }: { segment: CommentSegment }) {
  switch (segment.type) {
    case "mention":
      return (
        <span className="rounded-chip bg-surface-2 px-1 font-medium text-fg">
          <bdi>@{segment.value}</bdi>
        </span>
      );
    case "link": {
      // `parseCommentBody` only yields http(s)/www links; `sanitizeHref` is the
      // same scheme gate the renderer/markdown use, and `www.` needs a scheme.
      const href = sanitizeHref(
        /^www\./i.test(segment.value) ? `https://${segment.value}` : segment.value,
      );
      return href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline underline-offset-2"
        >
          <bdi>{segment.value}</bdi>
        </a>
      ) : (
        <span>{segment.value}</span>
      );
    }
    case "emoji":
      return (
        <span role="img" aria-label={`:${segment.id}:`} title={`:${segment.id}:`}>
          {segment.value}
        </span>
      );
    default:
      return <>{segment.value}</>;
  }
}
