import { describe, expect, it } from "vitest";
import {
  buildThreads,
  reactionSummary,
  resolveThread,
  threadCounts,
  toggleReaction,
  unresolveThread,
  validateThreadDepth,
} from "./comment-threads";
import type { Comment, CommentThread } from "./comment-threads";

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
