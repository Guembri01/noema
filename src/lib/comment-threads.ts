/**
 * Pure comment-thread model (docs/specs/collaboration-deep.md, R79.1 thread
 * depth enforcement + R79.2 reply affordance parity, extended with the §7
 * "Comment depth, Page comments" engine: anchors, dispatch scoping and thread
 * descriptions).
 *
 * PURE module: no prisma, no node:* imports, no routes, no React and no ambient
 * clock - every helper is handed its rows/timestamps and returns new values, so
 * `buildThreads`, depth validation, reaction toggling and resolve/unresolve can
 * be unit-pinned without a database.
 *
 * The row shape mirrors the `Comment` table's thread-relevant columns
 * (`schema.prisma:330-349`): a `parentId` self-relation, an ISO `createdAt`, a
 * `resolvedAt` stamp, an optional block `anchor` and reaction rows (either a
 * `{ emoji: userId[] }` map - the shape `validateThreadDepth` and the panel emit
 * - or a `{ emoji, userIds[] }[]` chip list - the shape the depth engine's
 * mutators emit). The `threadId` field is optional and only present on the
 * legacy projection: when absent the thread root is derived by walking
 * `parentId`, so both shapes group identically.
 *
 * Depth: the *stored* one-level rule stays enforced by `validateThreadDepth`
 * (maxDepth 1, what the server action applies) but the general engine supports
 * up to `MAX_DEPTH` (3) levels, and `validateComment` is the server-side gate
 * that rejects anything deeper before a row is written (R79.1).
 *
 * Unit-pinned red-first by `src/lib/comment-threads.test.ts`.
 */

import { extractMentions, mentionMatches } from "./comments";

/** Largest number of body characters a comment may carry (mirrors `commentSchema`). */
export const MAX_BODY_LENGTH = 4000;

/** How deep a reply chain may go before `validateComment` rejects it. */
export const MAX_DEPTH = 3;

/** Reaction rows collapsed per emoji, each preserving the order users reacted. */
export type ReactionMap = Readonly<Record<string, readonly string[]>>;

/** One emoji and the users who reacted with it, in reaction order. */
export type ReactionChip = {
  readonly emoji: string;
  readonly userIds: readonly string[];
};

/** Either reaction representation; `reactionSummary` normalizes both. */
export type CommentsReaction = ReactionMap | readonly ReactionChip[];

/** Where a comment is anchored inside the document, by stable block id. */
export type CommentAnchor = {
  readonly blockId: string;
  /** Selection start offset inside the block, when the anchor is a range. */
  readonly from?: number;
  /** Selection end offset inside the block, when the anchor is a range. */
  readonly to?: number;
};

/** One comment row; the subset of the wire row the thread model needs. */
export type Comment = {
  readonly id: string;
  /** The page this comment lives on; absent on the legacy projection. */
  readonly pageId?: string;
  /** The thread this comment belongs to; a root's `threadId` is its own `id`. */
  readonly threadId?: string;
  /** Absent on a root; the parent comment's id otherwise. */
  readonly parentId?: string;
  readonly authorId: string;
  readonly body: string;
  /** Optional block anchor for inline display (`anchorKey`/`commentsForBlock`). */
  readonly anchor?: CommentAnchor;
  /** ISO-8601 timestamp; compared as instants, then by id for a total order. */
  readonly createdAt: string;
  /** Set on the thread root once resolved; children inherit it (R79.2c). */
  readonly resolvedAt?: string;
  /** Who resolved the thread (whole-thread resolve). */
  readonly resolvedBy?: string;
  readonly reactions?: CommentsReaction;
};

/** A comment node in the nested thread tree. */
export type CommentNode = {
  readonly comment: Comment;
  readonly children: readonly CommentNode[];
};

/** A root comment with its (flattened) replies plus the derived engine fields. */
export type CommentThread = {
  readonly root: Comment;
  readonly replies: readonly Comment[];
  /** Nested view of the same group, deepest first child in `createdAt` order. */
  readonly tree?: CommentNode;
  /** Distinct author ids, root first then replies in chronological order. */
  readonly participants?: readonly string[];
  /** Distinct `@mention` tokens across every body in the thread. */
  readonly mentions?: readonly string[];
  /** Deepest nesting level in the thread (a root-only thread is 0). */
  readonly depth?: number;
  /** Whether the root carries a `resolvedAt` stamp. */
  readonly resolved?: boolean;
  /** Resolved-user ids supplied by the caller for `dispatchScope`. */
  readonly mentionedUserIds?: readonly string[];
  /** Page follower ids supplied by the caller for `dispatchScope`. */
  readonly followerIds?: readonly string[];
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
  readonly replies: number;
  readonly comments: number;
  readonly resolved: number;
  readonly unresolved: number;
};

export type ReactionSummaryEntry = {
  readonly emoji: string;
  readonly count: number;
  readonly userIds: readonly string[];
};

/** A workspace member, for resolving `@mentions` in `validateComment`. */
export type MentionMember = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
};

/** Why `validateComment` rejected a comment. */
export type CommentValidationCode =
  | "body-empty"
  | "body-too-long"
  | "body-charset"
  | "unknown-parent"
  | "cross-page-parent"
  | "max-depth-exceeded"
  | "cycle";

/** `validateComment` verdict: accepted (with resolved mentions) or rejected. */
export type CommentValidation =
  | {
      readonly ok: true;
      readonly mentions: readonly string[];
      readonly mentionedUserIds: readonly string[];
      /** Mention tokens that matched no member; advisory, not an error. */
      readonly unresolved: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: CommentValidationCode;
      readonly error: string;
    };

/** Input for the array form of `toggleReaction`. */
export type ToggleReactionInput = {
  readonly commentId: string;
  readonly emoji: string;
  readonly userId: string;
};

/** Input for the whole-thread resolve/unresolve forms. */
export type ThreadMutationInput = {
  readonly now: string;
  readonly byUserId: string;
};

/** Flattened description of a thread, for the panel header and inbox copy. */
export type ThreadDescription = {
  readonly rootId: string;
  readonly authorId: string;
  readonly replyCount: number;
  readonly participantCount: number;
  readonly resolved: boolean;
  readonly mentions: readonly string[];
  readonly anchorKey: string | null;
};

/** Control characters that make a body non-renderable; tab/LF/CR are allowed. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** `true` when a reaction value is the chip-list representation. */
function isChipList(reactions: CommentsReaction): reactions is readonly ReactionChip[] {
  return Array.isArray(reactions);
}

/** Normalize either reaction representation into a chip list. */
function toChipList(reactions: CommentsReaction | undefined): ReactionChip[] {
  if (!reactions) return [];
  if (isChipList(reactions)) {
    return reactions.map((chip) => ({ emoji: chip.emoji, userIds: [...chip.userIds] }));
  }
  return Object.entries(reactions).map(([emoji, userIds]) => ({ emoji, userIds: [...userIds] }));
}

/** Normalize either reaction representation into a map. */
function toReactionMap(reactions: CommentsReaction | undefined): Record<string, readonly string[]> {
  if (!reactions) return {};
  if (isChipList(reactions)) {
    const map: Record<string, readonly string[]> = {};
    for (const chip of reactions) map[chip.emoji] = [...chip.userIds];
    return map;
  }
  const map: Record<string, readonly string[]> = {};
  for (const [emoji, userIds] of Object.entries(reactions)) map[emoji] = [...userIds];
  return map;
}

/** createdAt asc, then id asc - total and deterministic for equal instants. */
function compareCreatedAt(a: Comment, b: Comment): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Distinct author ids, root first and replies in the order given. */
function distinctAuthors(root: Comment, replies: readonly Comment[]): string[] {
  const authors = [root.authorId];
  for (const reply of replies) {
    if (!authors.includes(reply.authorId)) authors.push(reply.authorId);
  }
  return authors;
}

/** Distinct `@mention` tokens across a group of comments, in appearance order. */
function distinctMentions(comments: readonly Comment[]): string[] {
  const mentions: string[] = [];
  for (const comment of comments) {
    for (const mention of extractMentions(comment.body)) {
      if (!mentions.includes(mention)) mentions.push(mention);
    }
  }
  return mentions;
}

/** The thread root id for one comment: its `threadId`, else walk `parentId`. */
function deriveRootId(comment: Comment, byId: ReadonlyMap<string, Comment>): string {
  if (comment.threadId !== undefined) return comment.threadId;
  const seen = new Set<string>([comment.id]);
  let current = comment;
  while (current.parentId !== undefined) {
    const parent = byId.get(current.parentId);
    // Missing ancestor or a cycle: the comment becomes its own root so its
    // content still renders instead of vanishing into an orphaned group.
    if (!parent || seen.has(parent.id)) return comment.id;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

/** Build the nested tree for one group, skipping nodes on a cycle. */
function buildTree(root: Comment, group: readonly Comment[]): CommentNode {
  const childrenOf = new Map<string, Comment[]>();
  for (const comment of group) {
    if (comment.parentId === undefined || comment.id === root.id) continue;
    const siblings = childrenOf.get(comment.parentId) ?? [];
    siblings.push(comment);
    childrenOf.set(comment.parentId, siblings);
  }

  const build = (node: Comment, ancestors: ReadonlySet<string>): CommentNode => {
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(node.id);
    const children = (childrenOf.get(node.id) ?? [])
      .filter((child) => !nextAncestors.has(child.id))
      .sort(compareCreatedAt);
    return { comment: node, children: children.map((child) => build(child, nextAncestors)) };
  };

  return build(root, new Set());
}

/** Deepest level of a tree; a leaf is 0. */
function treeDepth(node: CommentNode): number {
  if (node.children.length === 0) return 0;
  return 1 + Math.max(...node.children.map(treeDepth));
}

/**
 * Group comments into root-plus-replies threads, oldest first, replies oldest
 * first. Used to render the comment panel deterministically. The root is found
 * by `threadId` when present (the legacy projection) or by walking `parentId`.
 * A group whose root is absent is dropped - an orphaned reply cannot be shown
 * and `validateThreadDepth` reports it as a `missing-parent` issue instead.
 * `tree`/`participants`/`mentions`/`depth`/`resolved` are derived additively.
 */
export function buildThreads(comments: readonly Comment[]): CommentThread[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const byThread = new Map<string, Comment[]>();
  for (const comment of comments) {
    const key = deriveRootId(comment, byId);
    const group = byThread.get(key);
    if (group) group.push(comment);
    else byThread.set(key, [comment]);
  }

  const threads: CommentThread[] = [];
  for (const [key, group] of byThread) {
    const root = group.find((comment) => comment.id === key);
    if (!root) continue;
    const replies = group.filter((comment) => comment.id !== root.id).sort(compareCreatedAt);
    const tree = buildTree(root, group);
    threads.push({
      root,
      replies,
      tree,
      participants: distinctAuthors(root, replies),
      mentions: distinctMentions(group),
      depth: treeDepth(tree),
      resolved: root.resolvedAt !== undefined,
    });
  }
  return threads.sort((a, b) => compareCreatedAt(a.root, b.root));
}

/**
 * Depth of a comment in its parent chain (root = 0). Returns `-1` for an unknown
 * id or a malformed chain (missing ancestor or cycle), so callers can tell
 * "not here" from "top level" without throwing.
 */
export function depthOf(comments: readonly Comment[], id: string): number {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  let current = byId.get(id);
  if (!current) return -1;
  const seen = new Set<string>([id]);
  let depth = 0;
  while (current.parentId !== undefined) {
    const parent = byId.get(current.parentId);
    if (!parent || seen.has(parent.id)) return -1;
    seen.add(parent.id);
    depth += 1;
    current = parent;
  }
  return depth;
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
 * Server-side comment gate (R79.1): reject an empty/oversized/non-renderable
 * body, an unknown or cross-page parent, a parent chain deeper than `MAX_DEPTH`
 * or one that cycles, and return the resolved mention targets otherwise. Pure,
 * so the whole rejection matrix is pinned without a database.
 */
export function validateComment(
  comment: Comment,
  context: { readonly existing: readonly Comment[]; readonly members: readonly MentionMember[] },
): CommentValidation {
  const body = comment.body ?? "";
  if (body.trim().length === 0) {
    return { ok: false, code: "body-empty", error: "Comment cannot be empty." };
  }
  if (body.length > MAX_BODY_LENGTH) {
    return {
      ok: false,
      code: "body-too-long",
      error: `Comment cannot exceed ${MAX_BODY_LENGTH} characters.`,
    };
  }
  if (CONTROL_CHARS.test(body)) {
    return { ok: false, code: "body-charset", error: "Comment contains unsupported characters." };
  }

  const mentions = extractMentions(body);
  const mentionedUserIds: string[] = [];
  const unresolved: string[] = [];
  for (const mention of mentions) {
    const member = context.members.find((candidate) => mentionMatches(mention, candidate));
    if (member) {
      if (!mentionedUserIds.includes(member.id)) mentionedUserIds.push(member.id);
    } else {
      unresolved.push(mention);
    }
  }

  if (comment.parentId !== undefined) {
    const byId = new Map(context.existing.map((row) => [row.id, row]));
    const parent = byId.get(comment.parentId);
    if (!parent) {
      return { ok: false, code: "unknown-parent", error: "The comment being replied to does not exist." };
    }
    if (
      comment.pageId !== undefined &&
      parent.pageId !== undefined &&
      parent.pageId !== comment.pageId
    ) {
      return {
        ok: false,
        code: "cross-page-parent",
        error: "The comment being replied to belongs to a different page.",
      };
    }
    const parentDepth = depthOf(context.existing, parent.id);
    if (parentDepth < 0) {
      return { ok: false, code: "cycle", error: "That comment's thread is malformed." };
    }
    if (parentDepth + 1 > MAX_DEPTH) {
      return {
        ok: false,
        code: "max-depth-exceeded",
        error: `Replies can be at most ${MAX_DEPTH} levels deep.`,
      };
    }
  }

  return { ok: true, mentions, mentionedUserIds, unresolved };
}

/**
 * Append a reply to `parent` (an id or the comment itself), returning a new
 * array. The reply inherits `pageId` and the resolved thread root, gets a
 * deterministic id and `createdAt: now` from the injected clock. An unknown
 * parent yields an unchanged copy; the input is never mutated.
 */
export function addReply(
  comments: readonly Comment[],
  parent: string | Comment,
  input: { readonly authorId: string; readonly body: string; readonly now: string },
): Comment[] {
  const parentComment =
    typeof parent === "string" ? comments.find((comment) => comment.id === parent) : parent;
  if (!parentComment) return [...comments];

  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootId = deriveRootId(parentComment, byId);
  const siblings = comments.filter((comment) => comment.parentId === parentComment.id).length;
  const reply: Comment = {
    id: `reply-${rootId}-${siblings + 1}`,
    pageId: parentComment.pageId,
    threadId: rootId,
    parentId: parentComment.id,
    authorId: input.authorId,
    body: input.body,
    createdAt: input.now,
  };
  return [...comments, reply];
}

/** Add/remove one user's map-shaped reaction; returns the same representation. */
function toggleMapReaction(
  comment: Comment,
  emoji: string,
  userId: string,
): Comment & { reactions?: ReactionMap } {
  const current = toReactionMap(comment.reactions);
  const existing = current[emoji] ?? [];
  const reactions: Record<string, readonly string[]> = { ...current };

  if (existing.includes(userId)) {
    const remaining = existing.filter((id) => id !== userId);
    if (remaining.length === 0) delete reactions[emoji];
    else reactions[emoji] = remaining;
  } else {
    reactions[emoji] = [...existing, userId];
  }

  return { ...comment, reactions };
}

/** Add/remove one user's chip-shaped reaction, preserving chip order. */
function toggleChipReaction(comment: Comment, emoji: string, userId: string): Comment {
  const chips = toChipList(comment.reactions);
  const index = chips.findIndex((chip) => chip.emoji === emoji);

  if (index === -1) {
    chips.push({ emoji, userIds: [userId] });
  } else {
    const chip = chips[index] as ReactionChip;
    if (chip.userIds.includes(userId)) {
      const remaining = chip.userIds.filter((id) => id !== userId);
      if (remaining.length === 0) chips.splice(index, 1);
      else chips[index] = { emoji, userIds: remaining };
    } else {
      chips[index] = { emoji, userIds: [...chip.userIds, userId] };
    }
  }

  return { ...comment, reactions: chips };
}

/**
 * Toggle one user's reaction on one comment.
 *
 * - `toggleReaction(comment, emoji, userId)` returns the next comment with a
 *   map-shaped `reactions` (the panel's shape).
 * - `toggleReaction(comments, { commentId, emoji, userId })` returns the next
 *   array with the targeted comment's `reactions` as a chip list (the engine's
 *   shape). An unknown id yields an unchanged copy; the input is never mutated.
 */
export function toggleReaction(
  comments: readonly Comment[],
  input: ToggleReactionInput,
): Comment[];
export function toggleReaction(
  comment: Comment,
  emoji: string,
  userId: string,
): Comment & { reactions?: ReactionMap };
export function toggleReaction(
  commentOrComments: Comment | readonly Comment[],
  emojiOrInput: string | ToggleReactionInput,
  maybeUserId?: string,
): Comment[] | (Comment & { reactions?: ReactionMap }) {
  if (Array.isArray(commentOrComments)) {
    const list = commentOrComments as readonly Comment[];
    const input = emojiOrInput as ToggleReactionInput;
    return list.map((comment) =>
      comment.id === input.commentId
        ? toggleChipReaction(comment, input.emoji, input.userId)
        : comment,
    );
  }
  return toggleMapReaction(
    commentOrComments as Comment,
    emojiOrInput as string,
    maybeUserId as string,
  );
}

/** Reaction chips for a comment: emoji, count and reacting users, in order. */
export function reactionSummary(comment: Comment): ReactionSummaryEntry[] {
  return toChipList(comment.reactions)
    .filter((chip) => chip.userIds.length > 0)
    .map((chip) => ({ emoji: chip.emoji, count: chip.userIds.length, userIds: [...chip.userIds] }));
}

/** Every comment id belonging to `rootId`'s thread (root plus descendants). */
function threadMemberIds(comments: readonly Comment[], rootId: string): Set<string> {
  const members = new Set<string>();
  if (!comments.some((comment) => comment.id === rootId)) return members;
  members.add(rootId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const comment of comments) {
      if (
        comment.parentId !== undefined &&
        members.has(comment.parentId) &&
        !members.has(comment.id)
      ) {
        members.add(comment.id);
        changed = true;
      }
    }
  }
  return members;
}

/**
 * Resolve a whole thread.
 *
 * - `resolveThread(thread, resolvedAt)` stamps the root only (the panel shape).
 * - `resolveThread(comments, rootId, { now, byUserId })` stamps every comment in
 *   the thread with `resolvedAt: now` and `resolvedBy`, returning a new array.
 *   An unknown root yields an unchanged copy; the input is never mutated.
 */
export function resolveThread(
  comments: readonly Comment[],
  rootId: string,
  input: ThreadMutationInput,
): Comment[];
export function resolveThread(thread: CommentThread, resolvedAt: string): CommentThread;
export function resolveThread(
  threadOrComments: CommentThread | readonly Comment[],
  rootIdOrResolvedAt: string,
  input?: ThreadMutationInput,
): CommentThread | Comment[] {
  if (Array.isArray(threadOrComments)) {
    const comments = threadOrComments as readonly Comment[];
    const members = threadMemberIds(comments, rootIdOrResolvedAt);
    if (members.size === 0) return [...comments];
    const mutation = input as ThreadMutationInput;
    return comments.map((comment) =>
      members.has(comment.id)
        ? { ...comment, resolvedAt: mutation.now, resolvedBy: mutation.byUserId }
        : comment,
    );
  }
  const thread = threadOrComments as CommentThread;
  return {
    ...thread,
    root: { ...thread.root, resolvedAt: rootIdOrResolvedAt },
    resolved: true,
  };
}

/**
 * Reopen a whole thread.
 *
 * - `unresolveThread(thread)` clears the root's `resolvedAt` (panel shape).
 * - `unresolveThread(comments, rootId, { now, byUserId })` clears `resolvedAt`
 *   and `resolvedBy` on every comment in the thread, returning a new array.
 */
export function unresolveThread(
  comments: readonly Comment[],
  rootId: string,
  input: ThreadMutationInput,
): Comment[];
export function unresolveThread(thread: CommentThread): CommentThread;
export function unresolveThread(
  threadOrComments: CommentThread | readonly Comment[],
  rootId?: string,
): CommentThread | Comment[] {
  if (Array.isArray(threadOrComments)) {
    const comments = threadOrComments as readonly Comment[];
    const members = threadMemberIds(comments, rootId as string);
    if (members.size === 0) return [...comments];
    return comments.map((comment) =>
      members.has(comment.id)
        ? { ...comment, resolvedAt: undefined, resolvedBy: undefined }
        : comment,
    );
  }
  const thread = threadOrComments as CommentThread;
  return {
    ...thread,
    root: { ...thread.root, resolvedAt: undefined },
    resolved: false,
  };
}

/**
 * Stable key for a block anchor, used for inline display and grouping: the bare
 * block id, or `blockId#from-to` for a range (an open end is left blank). `null`
 * for a comment with no anchor.
 */
export function anchorKey(anchor: CommentAnchor | undefined): string | null {
  if (!anchor || anchor.blockId.length === 0) return null;
  if (anchor.from === undefined && anchor.to === undefined) return anchor.blockId;
  const from = anchor.from === undefined ? "" : String(anchor.from);
  const to = anchor.to === undefined ? "" : String(anchor.to);
  return `${anchor.blockId}#${from}-${to}`;
}

/** Comments anchored to a block, in input order; unanchored rows are ignored. */
export function commentsForBlock(
  comments: readonly Comment[],
  blockId: string,
): Comment[] {
  return comments.filter((comment) => comment.anchor?.blockId === blockId);
}

/** Distinct authors of a thread, root first. */
function threadParticipants(thread: CommentThread): readonly string[] {
  return thread.participants ?? distinctAuthors(thread.root, thread.replies);
}

/**
 * Who should be notified about `comment`: the thread's participants, the users
 * it mentions and the page followers, de-duplicated and **excluding the actor**
 * (the comment's own author) so nobody is told about their own comment.
 */
export function dispatchScope(comment: Comment, thread: CommentThread): string[] {
  const actor = comment.authorId;
  const recipients: string[] = [];
  const add = (userId: string) => {
    if (userId.length > 0 && userId !== actor && !recipients.includes(userId)) {
      recipients.push(userId);
    }
  };

  for (const userId of threadParticipants(thread)) add(userId);
  for (const userId of thread.mentionedUserIds ?? []) add(userId);
  for (const userId of thread.followerIds ?? []) add(userId);

  return recipients;
}

/**
 * Flatten a thread into the facts the panel header and inbox copy need: root,
 * author, reply/participant counts, resolved state, the distinct mentions and
 * the root's anchor key.
 */
export function describeThread(thread: CommentThread): ThreadDescription {
  return {
    rootId: thread.root.id,
    authorId: thread.root.authorId,
    replyCount: thread.replies.length,
    participantCount: threadParticipants(thread).length,
    resolved: thread.resolved ?? thread.root.resolvedAt !== undefined,
    mentions: thread.mentions ?? distinctMentions([thread.root, ...thread.replies]),
    anchorKey: anchorKey(thread.root.anchor),
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

export { extractMentions };
