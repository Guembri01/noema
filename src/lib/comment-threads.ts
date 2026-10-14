/**
 * Pure comment-thread model (docs/specs/collaboration-deep.md, R79.1 thread
 * depth enforcement + R79.2 reply affordance parity).
 *
 * PURE module: no prisma, no node:* imports, no routes, no React and no ambient
 * clock - every helper is handed its rows/timestamps and returns new values, so
 * `buildThreads`, depth validation, reaction toggling and resolve/unresolve can
 * be unit-pinned without a database.
 *
 * The row shape mirrors the `Comment` table's thread-relevant columns
 * (`schema.prisma:330-349`): a `parentId` self-relation, an ISO `createdAt`, a
 * `resolvedAt` stamp and reaction rows collapsed to `{ emoji: userId[] }`.
 * Threads are one level deep (R79.1): a reply's parent must be the thread root.
 *
 * Unit-pinned red-first by `src/lib/comment-threads.test.ts`.
 */

/** Reaction rows collapsed per emoji, each preserving the order users reacted. */
export type ReactionMap = Readonly<Record<string, readonly string[]>>;

/** One comment row; the subset of the wire row the thread model needs. */
export type Comment = {
  readonly id: string;
  /** The thread this comment belongs to; a root's `threadId` is its own `id`. */
  readonly threadId: string;
  /** Absent on a root; the root's id on a depth-1 reply. */
  readonly parentId?: string;
  readonly authorId: string;
  readonly body: string;
  /** ISO-8601 timestamp; compared as instants, then by id for a total order. */
  readonly createdAt: string;
  /** Set on the thread root once resolved; children stay unresolved (R79.2c). */
  readonly resolvedAt?: string;
  readonly reactions?: ReactionMap;
};

/** A root comment with its depth-1 replies, both chronologically ordered. */
export type CommentThread = {
  readonly root: Comment;
  readonly replies: readonly Comment[];
};

/** Why a comment breaks the one-level thread rule (R79.1). */
export type DepthIssueReason =
  | "missing-parent"
  | "cross-thread-parent"
  | "max-depth-exceeded"
  | "cycle";

export type DepthIssue = {
  readonly commentId: string;
  readonly reason: DepthIssueReason;
  /** The comment's depth in the parent chain (root = 0). */
  readonly depth: number;
};

export type ThreadCounts = {
  readonly threads: number;
  /** Roots plus replies. */
  readonly comments: number;
  readonly replies: number;
  readonly resolved: number;
  readonly unresolved: number;
};

export type ReactionSummaryEntry = {
  readonly emoji: string;
  readonly count: number;
  readonly userIds: readonly string[];
};

/** createdAt asc, then id asc - total and deterministic for equal instants. */
function compareCreatedAt(a: Comment, b: Comment): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Group comments into root-plus-replies threads, oldest first, replies oldest
 * first. Used to render the comment panel deterministically. A group whose root
 * (`id === threadId`) is absent is dropped - an orphaned reply cannot be shown
 * and `validateThreadDepth` reports it as a `missing-parent` issue instead.
 */
export function buildThreads(comments: readonly Comment[]): CommentThread[] {
  const byThread = new Map<string, Comment[]>();
  for (const comment of comments) {
    const group = byThread.get(comment.threadId);
    if (group) group.push(comment);
    else byThread.set(comment.threadId, [comment]);
  }

  const threads: CommentThread[] = [];
  for (const group of byThread.values()) {
    const root = group.find((comment) => comment.id === comment.threadId);
    if (!root) continue;
    const replies = group
      .filter((comment) => comment.id !== root.id)
      .sort(compareCreatedAt);
    threads.push({ root, replies });
  }
  return threads.sort((a, b) => compareCreatedAt(a.root, b.root));
}

/**
 * Report every comment that breaks the one-level thread rule (R79.1): a reply
 * whose parent is absent, points at another thread, sits deeper than `maxDepth`
 * (default 1), or forms a parent cycle. Roots and valid depth-1 replies produce
 * no issue; order follows the input, so the result is deterministic.
 */
export function validateThreadDepth(
  comments: readonly Comment[],
  { maxDepth = 1 }: { maxDepth?: number } = {},
): DepthIssue[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const issues: DepthIssue[] = [];

  for (const comment of comments) {
    const seen = new Set<string>([comment.id]);
    let current = comment;
    let depth = 0;
    let issue: DepthIssue | null = null;

    while (current.parentId !== undefined) {
      const parent = byId.get(current.parentId);
      if (!parent) {
        issue = { commentId: comment.id, reason: "missing-parent", depth: depth + 1 };
        break;
      }
      if (parent.threadId !== comment.threadId) {
        issue = { commentId: comment.id, reason: "cross-thread-parent", depth: depth + 1 };
        break;
      }
      if (seen.has(parent.id)) {
        issue = { commentId: comment.id, reason: "cycle", depth: depth + 1 };
        break;
      }
      seen.add(parent.id);
      depth += 1;
      if (depth > maxDepth) {
        issue = { commentId: comment.id, reason: "max-depth-exceeded", depth };
        break;
      }
      current = parent;
    }

    if (issue) issues.push(issue);
  }

  return issues;
}

/**
 * Toggle one user's reaction on one emoji, returning a new comment. The input
 * and its reaction map are never mutated; removing the last user of an emoji
 * drops that emoji, and other emojis keep their insertion order.
 */
export function toggleReaction(
  comment: Comment,
  emoji: string,
  userId: string,
): Comment {
  const current = comment.reactions ?? {};
  const existing = current[emoji] ?? [];
  let reactions: Record<string, readonly string[]>;

  if (existing.includes(userId)) {
    const remaining = existing.filter((id) => id !== userId);
    reactions = { ...current };
    if (remaining.length === 0) delete reactions[emoji];
    else reactions[emoji] = remaining;
  } else {
    reactions = { ...current, [emoji]: [...existing, userId] };
  }

  return { ...comment, reactions };
}

/** Reaction chips for a comment: emoji, count and reacting users, in order. */
export function reactionSummary(comment: Comment): ReactionSummaryEntry[] {
  const reactions = comment.reactions ?? {};
  return Object.entries(reactions)
    .filter(([, userIds]) => userIds.length > 0)
    .map(([emoji, userIds]) => ({
      emoji,
      count: userIds.length,
      userIds: [...userIds],
    }));
}

/**
 * Resolve a thread by stamping `resolvedAt` on its root (R79.2c). Replies keep
 * their own state; the root's stamp is the stored truth.
 */
export function resolveThread(
  thread: CommentThread,
  resolvedAt: string,
): CommentThread {
  return { root: { ...thread.root, resolvedAt }, replies: thread.replies };
}

/** Reopen a thread by clearing the root's `resolvedAt`; replies are untouched. */
export function unresolveThread(thread: CommentThread): CommentThread {
  return {
    root: { ...thread.root, resolvedAt: undefined },
    replies: thread.replies,
  };
}

/** Summary counts across threads: totals plus resolved/unresolved. */
export function threadCounts(threads: readonly CommentThread[]): ThreadCounts {
  let replies = 0;
  let resolved = 0;
  for (const thread of threads) {
    replies += thread.replies.length;
    if (thread.root.resolvedAt !== undefined) resolved += 1;
  }
  return {
    threads: threads.length,
    comments: threads.length + replies,
    replies,
    resolved,
    unresolved: threads.length - resolved,
  };
}
