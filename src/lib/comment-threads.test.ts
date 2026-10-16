import { describe, expect, it } from "vitest";
import {
  MAX_DEPTH,
  addReply,
  anchorKey,
  buildThreads,
  commentsForBlock,
  depthOf,
  describeThread,
  dispatchScope,
  extractMentions,
  reactionSummary,
  resolveThread,
  threadCounts,
  toggleReaction,
  unresolveThread,
  validateComment,
  validateThreadDepth,
} from "./comment-threads";
import type { Comment, CommentThread, MentionMember } from "./comment-threads";

/**
 * Pure comment-thread model (docs/specs/collaboration-deep.md, R79.1 depth
 * enforcement + R79.2 reply parity). Red-first: `src/lib/comment-threads.ts`
 * does not exist until this lands, so the first run fails to resolve the import
 * and the suite goes green with the implementation.
 *
 * Everything here is pure: roots/replies are plain rows with ISO timestamps and
 * no DB, no React, no ambient clock. Mutating helpers are asserted immutable -
 * the input row is never touched.
 */

/** Build a comment row with sane defaults, overriding only what a test needs. */
function make(over: Partial<Comment> & { id: string }): Comment {
  return {
    threadId: over.id,
    authorId: "u1",
    body: `body-${over.id}`,
    createdAt: "2026-03-10T09:00:00.000Z",
    ...over,
  };
}

describe("buildThreads", () => {
  it("groups a root with its replies in chronological order", () => {
    const threads = buildThreads([
      make({ id: "r2", threadId: "root", parentId: "root", createdAt: "2026-03-10T11:00:00.000Z" }),
      make({ id: "root", createdAt: "2026-03-10T09:00:00.000Z" }),
      make({ id: "r1", threadId: "root", parentId: "root", createdAt: "2026-03-10T10:00:00.000Z" }),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.root.id).toBe("root");
    expect(threads[0]?.replies.map((reply) => reply.id)).toEqual(["r1", "r2"]);
  });

  it("orders threads by their root's createdAt", () => {
    const threads = buildThreads([
      make({ id: "b", createdAt: "2026-03-10T10:00:00.000Z" }),
      make({ id: "a", createdAt: "2026-03-10T09:00:00.000Z" }),
    ]);

    expect(threads.map((thread) => thread.root.id)).toEqual(["a", "b"]);
  });

  it("breaks createdAt ties by id so the order is total", () => {
    const same = "2026-03-10T09:00:00.000Z";
    const threads = buildThreads([make({ id: "z", createdAt: same }), make({ id: "a", createdAt: same })]);

    expect(threads.map((thread) => thread.root.id)).toEqual(["a", "z"]);
  });

  it("drops a reply whose root is absent and returns [] for no comments", () => {
    expect(buildThreads([])).toEqual([]);
    expect(buildThreads([make({ id: "orphan", threadId: "gone", parentId: "gone" })])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [make({ id: "a" }), make({ id: "b", createdAt: "2026-03-10T08:00:00.000Z" })];
    const snapshot = input.map((comment) => comment.id);

    buildThreads(input);

    expect(input.map((comment) => comment.id)).toEqual(snapshot);
  });
});

describe("validateThreadDepth", () => {
  it("accepts roots and depth-1 replies", () => {
    expect(
      validateThreadDepth([
        make({ id: "root" }),
        make({ id: "reply", threadId: "root", parentId: "root" }),
      ]),
    ).toEqual([]);
  });

  it("flags a reply to a reply as max-depth-exceeded with its depth", () => {
    const issues = validateThreadDepth([
      make({ id: "root" }),
      make({ id: "reply", threadId: "root", parentId: "root" }),
      make({ id: "deep", threadId: "root", parentId: "reply" }),
    ]);

    expect(issues).toEqual([{ commentId: "deep", reason: "max-depth-exceeded", depth: 2 }]);
  });

  it("honours a custom maxDepth", () => {
    const comments = [
      make({ id: "root" }),
      make({ id: "reply", threadId: "root", parentId: "root" }),
      make({ id: "deep", threadId: "root", parentId: "reply" }),
    ];

    expect(validateThreadDepth(comments, { maxDepth: 2 })).toEqual([]);
  });

  it("flags a missing parent", () => {
    expect(
      validateThreadDepth([make({ id: "reply", threadId: "root", parentId: "ghost" })]),
    ).toEqual([{ commentId: "reply", reason: "missing-parent", depth: 1 }]);
  });

  it("flags a parent that lives on another thread", () => {
    expect(
      validateThreadDepth([
        make({ id: "a" }),
        make({ id: "b" }),
        make({ id: "reply", threadId: "b", parentId: "a" }),
      ]),
    ).toEqual([{ commentId: "reply", reason: "cross-thread-parent", depth: 1 }]);
  });

  it("flags a parent cycle instead of looping forever", () => {
    const issues = validateThreadDepth([
      make({ id: "a", threadId: "a", parentId: "b" }),
      make({ id: "b", threadId: "a", parentId: "a" }),
    ]);

    expect(issues).toEqual([
      { commentId: "a", reason: "cycle", depth: 2 },
      { commentId: "b", reason: "cycle", depth: 2 },
    ]);
  });
});

describe("toggleReaction", () => {
  const base = make({ id: "root" });

  it("adds a first reaction without mutating the input", () => {
    const next = toggleReaction(base, "👍", "u2");

    expect(next.reactions).toEqual({ "👍": ["u2"] });
    expect(base.reactions).toBeUndefined();
  });

  it("appends a second user on the same emoji", () => {
    const once = toggleReaction(base, "👍", "u2");
    const twice = toggleReaction(once, "👍", "u3");

    expect(twice.reactions).toEqual({ "👍": ["u2", "u3"] });
    expect(once.reactions).toEqual({ "👍": ["u2"] });
  });

  it("toggles the same user off and drops the emptied emoji", () => {
    const once = toggleReaction(base, "👍", "u2");
    const off = toggleReaction(once, "👍", "u2");

    expect(off.reactions).toEqual({});
  });

  it("keeps other emojis and their order when removing one", () => {
    const both = toggleReaction(toggleReaction(base, "👍", "u2"), "🎉", "u2");
    const off = toggleReaction(both, "👍", "u2");

    expect(Object.keys(off.reactions ?? {})).toEqual(["🎉"]);
    expect(off.reactions?.["🎉"]).toEqual(["u2"]);
  });
});

describe("reactionSummary", () => {
  it("lists emoji with their counts in insertion order", () => {
    const comment = toggleReaction(toggleReaction(make({ id: "root" }), "👍", "u2"), "👍", "u3");
    const withParty = toggleReaction(comment, "🎉", "u4");

    expect(reactionSummary(withParty)).toEqual([
      { emoji: "👍", count: 2, userIds: ["u2", "u3"] },
      { emoji: "🎉", count: 1, userIds: ["u4"] },
    ]);
  });

  it("is empty when there are no reactions", () => {
    expect(reactionSummary(make({ id: "root" }))).toEqual([]);
  });
});

describe("resolveThread / unresolveThread", () => {
  const thread: CommentThread = {
    root: make({ id: "root" }),
    replies: [make({ id: "reply", threadId: "root", parentId: "root" })],
  };

  it("stamps resolvedAt on the root only", () => {
    const resolved = resolveThread(thread, "2026-03-10T12:00:00.000Z");

    expect(resolved.root.resolvedAt).toBe("2026-03-10T12:00:00.000Z");
    expect(resolved.replies[0]?.resolvedAt).toBeUndefined();
    expect(thread.root.resolvedAt).toBeUndefined();
  });

  it("clears resolvedAt on unresolve without touching replies", () => {
    const resolved = resolveThread(thread, "2026-03-10T12:00:00.000Z");
    const reopened = unresolveThread(resolved);

    expect(reopened.root.resolvedAt).toBeUndefined();
    expect(reopened.root.id).toBe("root");
    expect(resolved.root.resolvedAt).toBe("2026-03-10T12:00:00.000Z");
  });
});

describe("threadCounts", () => {
  it("counts threads, comments, replies and resolved state", () => {
    const open: CommentThread = {
      root: make({ id: "open" }),
      replies: [
        make({ id: "o1", threadId: "open", parentId: "open" }),
        make({ id: "o2", threadId: "open", parentId: "open" }),
      ],
    };
    const closed: CommentThread = {
      root: make({ id: "closed", resolvedAt: "2026-03-10T12:00:00.000Z" }),
      replies: [],
    };

    expect(threadCounts([open, closed])).toEqual({
      threads: 2,
      comments: 4,
      replies: 2,
      resolved: 1,
      unresolved: 1,
    });
  });

  it("returns zeroes for no threads", () => {
    expect(threadCounts([])).toEqual({
      threads: 0,
      comments: 0,
      replies: 0,
      resolved: 0,
      unresolved: 0,
    });
  });
});

/**
 * docs/specs/collaboration-deep.md §7 comment depth engine - the extended
 * surface: depth measurement, server-side `validateComment`, reply creation,
 * whole-thread resolve, anchor grouping, notification scoping and thread
 * descriptions. Red-first: these helpers do not exist on the pre-engine
 * `comment-threads.ts`, so the first run fails to resolve the new imports and
 * the suite goes green with the implementation.
 */

/** Build a depth-engine comment row (no `threadId`; roots derive from parentId). */
function row(over: Partial<Comment> & { id: string }): Comment {
  return {
    authorId: "u1",
    body: `body-${over.id}`,
    createdAt: "2026-03-10T09:00:00.000Z",
    ...over,
  };
}

describe("depthOf", () => {
  const root = row({ id: "root" });
  const reply = row({ id: "reply", parentId: "root" });
  const deep = row({ id: "deep", parentId: "reply" });

  it("is 0 for a root (R79.1)", () => {
    expect(depthOf([root], "root")).toBe(0);
  });

  it("counts a reply as depth 1 (R79.1)", () => {
    expect(depthOf([root, reply], "reply")).toBe(1);
  });

  it("counts a reply of a reply as depth 2 (R79.1)", () => {
    expect(depthOf([root, reply, deep], "deep")).toBe(2);
  });

  it("is -1 for an unknown id", () => {
    expect(depthOf([root], "ghost")).toBe(-1);
    expect(depthOf([], "root")).toBe(-1);
  });

  it("is -1 for a cycle instead of looping", () => {
    const a = row({ id: "a", parentId: "b" });
    const b = row({ id: "b", parentId: "a" });
    expect(depthOf([a, b], "a")).toBe(-1);
  });
});

describe("MAX_DEPTH", () => {
  it("allows three levels of replies", () => {
    expect(MAX_DEPTH).toBe(3);
  });
});

describe("validateComment", () => {
  const members: MentionMember[] = [{ id: "u2", name: "Ada Lovelace", email: "ada@example.com" }];
  const existing: Comment[] = [
    row({ id: "root", pageId: "p1", authorId: "u1" }),
    row({ id: "reply", pageId: "p1", parentId: "root", authorId: "u1" }),
  ];

  it("accepts a top-level comment and resolves its mentions", () => {
    const verdict = validateComment(row({ id: "c", pageId: "p1", body: "hey @Ada" }), {
      existing,
      members,
    });
    expect(verdict).toEqual({
      ok: true,
      mentions: ["ada"],
      mentionedUserIds: ["u2"],
      unresolved: [],
    });
  });

  it("accepts a reply within MAX_DEPTH", () => {
    expect(
      validateComment(row({ id: "r", pageId: "p1", parentId: "reply" }), { existing, members }).ok,
    ).toBe(true);
  });

  it("rejects an empty body (R79.1)", () => {
    expect(validateComment(row({ id: "c", body: "   " }), { existing, members })).toMatchObject({
      ok: false,
      code: "body-empty",
    });
  });

  it("rejects an over-long body", () => {
    expect(
      validateComment(row({ id: "c", body: "x".repeat(4001) }), { existing, members }),
    ).toMatchObject({ ok: false, code: "body-too-long" });
  });

  it("rejects control characters", () => {
    expect(
      validateComment(row({ id: "c", body: "bad\u0007body" }), { existing, members }),
    ).toMatchObject({ ok: false, code: "body-charset" });
  });

  it("rejects an unknown parent (R79.1)", () => {
    expect(
      validateComment(row({ id: "c", pageId: "p1", parentId: "ghost" }), { existing, members }),
    ).toMatchObject({ ok: false, code: "unknown-parent" });
  });

  it("rejects a parent on another page", () => {
    expect(
      validateComment(row({ id: "c", pageId: "other", parentId: "root" }), { existing, members }),
    ).toMatchObject({ ok: false, code: "cross-page-parent" });
  });

  it("rejects a reply deeper than MAX_DEPTH (R79.1)", () => {
    const chain: Comment[] = [
      row({ id: "d0", pageId: "p1" }),
      row({ id: "d1", pageId: "p1", parentId: "d0" }),
      row({ id: "d2", pageId: "p1", parentId: "d1" }),
      row({ id: "d3", pageId: "p1", parentId: "d2" }),
    ];
    expect(
      validateComment(row({ id: "d4", pageId: "p1", parentId: "d3" }), {
        existing: chain,
        members: [],
      }),
    ).toMatchObject({ ok: false, code: "max-depth-exceeded" });
  });

  it("rejects a parent chain that cycles", () => {
    const cycle: Comment[] = [
      row({ id: "a", pageId: "p1", parentId: "b" }),
      row({ id: "b", pageId: "p1", parentId: "a" }),
    ];
    expect(
      validateComment(row({ id: "c", pageId: "p1", parentId: "a" }), {
        existing: cycle,
        members: [],
      }),
    ).toMatchObject({ ok: false, code: "cycle" });
  });

  it("reports mentions that match no member as unresolved", () => {
    const verdict = validateComment(row({ id: "c", body: "ping @Ada and @ghost" }), {
      existing,
      members,
    });
    expect(verdict).toMatchObject({ ok: true, mentionedUserIds: ["u2"], unresolved: ["ghost"] });
  });
});

describe("addReply", () => {
  const base: Comment[] = [row({ id: "root", pageId: "p1", authorId: "u1" })];

  it("appends a reply that inherits page and thread", () => {
    const next = addReply(base, "root", {
      authorId: "u2",
      body: "hey back",
      now: "2026-03-10T12:00:00.000Z",
    });
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      parentId: "root",
      threadId: "root",
      pageId: "p1",
      authorId: "u2",
      body: "hey back",
      createdAt: "2026-03-10T12:00:00.000Z",
    });
  });

  it("does not mutate the input array", () => {
    addReply(base, "root", { authorId: "u2", body: "hi", now: "t" });
    expect(base).toHaveLength(1);
  });

  it("returns an unchanged copy for an unknown parent", () => {
    const next = addReply(base, "ghost", { authorId: "u2", body: "hi", now: "t" });
    expect(next).toHaveLength(1);
    expect(next).not.toBe(base);
  });

  it("resolves the thread root when replying to a reply", () => {
    const reply: Comment = row({ id: "reply", pageId: "p1", parentId: "root" });
    const next = addReply([...base, reply], "reply", { authorId: "u3", body: "deep", now: "t" });
    expect(next[2]?.threadId).toBe("root");
    expect(next[2]?.parentId).toBe("reply");
  });
});

describe("buildThreads - engine fields", () => {
  it("lists participants with the root author first (R79.2)", () => {
    const thread = buildThreads([
      row({ id: "root", authorId: "u1" }),
      row({ id: "r1", parentId: "root", authorId: "u2", createdAt: "2026-03-10T10:00:00.000Z" }),
      row({ id: "r2", parentId: "root", authorId: "u1", createdAt: "2026-03-10T11:00:00.000Z" }),
    ])[0] as CommentThread;
    expect(thread.participants).toEqual(["u1", "u2"]);
  });

  it("extracts distinct mentions across every body", () => {
    const thread = buildThreads([
      row({ id: "root", body: "hi @Ada and @bob" }),
      row({
        id: "r1",
        parentId: "root",
        body: "thanks @ada",
        createdAt: "2026-03-10T10:00:00.000Z",
      }),
    ])[0] as CommentThread;
    expect(thread.mentions).toEqual(["ada", "bob"]);
  });

  it("reports the deepest nesting level and a nested tree", () => {
    const thread = buildThreads([
      row({ id: "root" }),
      row({ id: "child", parentId: "root", createdAt: "2026-03-10T10:00:00.000Z" }),
      row({ id: "grand", parentId: "child", createdAt: "2026-03-10T11:00:00.000Z" }),
    ])[0] as CommentThread;
    expect(thread.depth).toBe(2);
    expect(thread.tree?.children[0]?.comment.id).toBe("child");
    expect(thread.tree?.children[0]?.children[0]?.comment.id).toBe("grand");
  });

  it("marks a thread resolved from the root stamp", () => {
    const thread = buildThreads([row({ id: "root", resolvedAt: "2026-03-10T12:00:00.000Z" })])[0] as
      | CommentThread
      | undefined;
    expect(thread?.resolved).toBe(true);
  });

  it("handles a parent cycle by making each comment its own root", () => {
    const threads = buildThreads([
      row({ id: "a", parentId: "b" }),
      row({ id: "b", parentId: "a" }),
    ]);
    expect(threads.map((thread) => thread.root.id).sort()).toEqual(["a", "b"]);
    expect(threads.every((thread) => thread.replies.length === 0)).toBe(true);
  });
});

describe("toggleReaction - array overload", () => {
  const base: Comment[] = [row({ id: "a" }), row({ id: "b" })];
  const input = { commentId: "a", emoji: "👍", userId: "u2" };

  it("adds a chip reaction to the targeted comment", () => {
    const next = toggleReaction(base, input);
    expect(next[0]?.reactions).toEqual([{ emoji: "👍", userIds: ["u2"] }]);
  });

  it("toggles the same user off again (idempotent round-trip)", () => {
    const off = toggleReaction(toggleReaction(base, input), input);
    expect(off[0]?.reactions).toEqual([]);
  });

  it("keeps other emojis and leaves other comments untouched", () => {
    const party = toggleReaction(toggleReaction(base, input), { ...input, emoji: "🎉" });
    expect(party[0]?.reactions).toEqual([
      { emoji: "👍", userIds: ["u2"] },
      { emoji: "🎉", userIds: ["u2"] },
    ]);
    expect(party[1]).toBe(base[1]);
  });

  it("returns a copy when the comment id is unknown", () => {
    const next = toggleReaction(base, { commentId: "ghost", emoji: "👍", userId: "u2" });
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(base[0]);
    expect(next).not.toBe(base);
  });
});

describe("resolveThread / unresolveThread - whole thread", () => {
  const thread: Comment[] = [
    row({ id: "root" }),
    row({ id: "r1", parentId: "root", createdAt: "2026-03-10T10:00:00.000Z" }),
    row({ id: "r2", parentId: "r1", createdAt: "2026-03-10T11:00:00.000Z" }),
  ];
  const input = { now: "2026-03-10T12:00:00.000Z", byUserId: "u9" };

  it("stamps every comment in the thread (R79.2c)", () => {
    const resolved = resolveThread(thread, "root", input);
    expect(resolved.map((comment) => comment.resolvedAt)).toEqual([
      input.now,
      input.now,
      input.now,
    ]);
    expect(resolved.every((comment) => comment.resolvedBy === "u9")).toBe(true);
  });

  it("does not mutate the input", () => {
    resolveThread(thread, "root", input);
    expect(thread.every((comment) => comment.resolvedAt === undefined)).toBe(true);
  });

  it("returns a copy for an unknown root", () => {
    const next = resolveThread(thread, "ghost", input);
    expect(next).toHaveLength(3);
    expect(next).not.toBe(thread);
    expect(next[0]?.resolvedAt).toBeUndefined();
  });

  it("clears the whole thread on unresolve", () => {
    const reopened = unresolveThread(resolveThread(thread, "root", input), "root", input);
    expect(reopened.every((comment) => comment.resolvedAt === undefined)).toBe(true);
    expect(reopened.every((comment) => comment.resolvedBy === undefined)).toBe(true);
  });
});

describe("anchorKey / commentsForBlock", () => {
  const comments: Comment[] = [
    row({ id: "a", anchor: { blockId: "b1" } }),
    row({ id: "b", anchor: { blockId: "b2" } }),
    row({ id: "c", anchor: { blockId: "b1", from: 1, to: 3 } }),
    row({ id: "d" }),
  ];

  it("keys a bare block anchor", () => {
    expect(anchorKey({ blockId: "b1" })).toBe("b1");
  });

  it("keys a range anchor", () => {
    expect(anchorKey({ blockId: "b1", from: 2, to: 5 })).toBe("b1#2-5");
  });

  it("leaves an open range end blank", () => {
    expect(anchorKey({ blockId: "b1", from: 2 })).toBe("b1#2-");
    expect(anchorKey({ blockId: "b1", to: 5 })).toBe("b1#-5");
  });

  it("is null for a comment with no anchor", () => {
    expect(anchorKey(undefined)).toBeNull();
  });

  it("groups comments by block id in input order", () => {
    expect(commentsForBlock(comments, "b1").map((comment) => comment.id)).toEqual(["a", "c"]);
  });

  it("returns [] for a block with no comments", () => {
    expect(commentsForBlock(comments, "b9")).toEqual([]);
  });
});

describe("dispatchScope", () => {
  const thread = buildThreads([
    row({ id: "root", authorId: "u1", body: "hi @u3" }),
    row({ id: "r1", parentId: "root", authorId: "u2", createdAt: "2026-03-10T10:00:00.000Z" }),
  ])[0] as CommentThread;

  it("notifies participants, mentioned users and followers minus the actor (R79.4/R79.5)", () => {
    const scoped: CommentThread = { ...thread, mentionedUserIds: ["u3", "u1"], followerIds: ["u4", "u2"] };
    const actor = thread.replies[0] as Comment;
    expect(dispatchScope(actor, scoped)).toEqual(["u1", "u3", "u4"]);
  });

  it("never notifies the actor even when mentioned or following", () => {
    const scoped: CommentThread = { ...thread, mentionedUserIds: ["u1"], followerIds: ["u1"] };
    expect(dispatchScope(thread.root, scoped)).toEqual(["u2"]);
  });

  it("de-duplicates a user appearing in several sources", () => {
    const scoped: CommentThread = { ...thread, mentionedUserIds: ["u2", "u3"], followerIds: ["u2", "u3"] };
    expect(dispatchScope(thread.root, scoped)).toEqual(["u2", "u3"]);
  });
});

describe("describeThread", () => {
  it("summarizes reply count, participants, mentions and anchor", () => {
    const thread = buildThreads([
      row({ id: "root", authorId: "u1", body: "hi @Ada", anchor: { blockId: "b1" } }),
      row({
        id: "r1",
        parentId: "root",
        authorId: "u2",
        body: "ok",
        createdAt: "2026-03-10T10:00:00.000Z",
      }),
    ])[0] as CommentThread;
    expect(describeThread(thread)).toEqual({
      rootId: "root",
      authorId: "u1",
      replyCount: 1,
      participantCount: 2,
      resolved: false,
      mentions: ["ada"],
      anchorKey: "b1",
    });
  });

  it("reports a resolved thread", () => {
    const thread = buildThreads([
      row({ id: "root", resolvedAt: "2026-03-10T12:00:00.000Z" }),
    ])[0] as CommentThread;
    expect(describeThread(thread).resolved).toBe(true);
  });

  it("is null-anchored for an unanchored thread", () => {
    const thread = buildThreads([row({ id: "root" })])[0] as CommentThread;
    expect(describeThread(thread).anchorKey).toBeNull();
  });
});

describe("extractMentions (re-export parity)", () => {
  it("finds names, first names and emails, de-duplicated", () => {
    expect(extractMentions("hey @Ada and @ada.lovelace and @ada@example.com")).toEqual([
      "ada",
      "ada.lovelace",
      "ada@example.com",
    ]);
  });

  it("ignores a bare email", () => {
    expect(extractMentions("write to ada@example.com")).toEqual([]);
  });
});
