import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * dz16 — the comment reactions surface.
 *
 * The pure mappings (`aggregateReactions`, `toggleReactionRow`,
 * `reactionDiff`, `whoReacted`) are exercised with node tests, and the chip
 * markup is pinned with `renderToStaticMarkup` (Radix's tooltip content is
 * portal-only, so SSR renders just the trigger — exactly what we assert).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/server/actions/comments", () => ({
  toggleCommentReactionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const {
  aggregateReactions,
  toggleReactionRow,
  reactionDiff,
  whoReacted,
  CommentReactions,
} = await import("./comment-reactions");

type Row = {
  emoji: string;
  count: number;
  mine: boolean;
  reactors?: { id: string; name: string }[];
};

describe("aggregateReactions", () => {
  it("sums duplicate glyphs, ORs `mine` and keeps first-seen order", () => {
    const rows = aggregateReactions([
      { emoji: "👍", count: 1, mine: false },
      { emoji: "🎉", count: 2, mine: true },
      { emoji: "👍", count: 2, mine: true },
    ]);
    expect(rows).toEqual([
      { emoji: "👍", count: 3, mine: true, reactors: undefined },
      { emoji: "🎉", count: 2, mine: true, reactors: undefined },
    ]);
  });

  it("drops blank glyphs and non-positive counts", () => {
    expect(
      aggregateReactions([
        { emoji: "", count: 4, mine: false },
        { emoji: "x", count: 0, mine: false },
        { emoji: "y", count: -3, mine: false },
        { emoji: "z", count: 1, mine: false },
      ]),
    ).toEqual([{ emoji: "z", count: 1, mine: false, reactors: undefined }]);
  });

  it("concatenates reactor names when the caller supplies them", () => {
    const rows = aggregateReactions([
      { emoji: "👍", count: 1, mine: false, reactors: [{ id: "u1", name: "Ada" }] },
      { emoji: "👍", count: 1, mine: false, reactors: [{ id: "u2", name: "Bob" }] },
    ]);
    expect(rows[0].reactors).toEqual([
      { id: "u1", name: "Ada" },
      { id: "u2", name: "Bob" },
    ]);
  });
});

describe("toggleReactionRow", () => {
  const base: Row[] = [{ emoji: "👍", count: 2, mine: false }];

  it("adds a brand-new glyph as mine", () => {
    expect(toggleReactionRow(base, "🎉")).toEqual([
      { emoji: "👍", count: 2, mine: false },
      { emoji: "🎉", count: 1, mine: true },
    ]);
  });

  it("increments and marks mine when the viewer had not reacted", () => {
    expect(toggleReactionRow(base, "👍")).toEqual([
      { emoji: "👍", count: 3, mine: true },
    ]);
  });

  it("decrements mine and removes the chip at zero", () => {
    const mine: Row[] = [{ emoji: "👍", count: 1, mine: true }];
    expect(toggleReactionRow(mine, "👍")).toEqual([]);
  });

  it("never mutates its input", () => {
    const input: Row[] = [{ emoji: "👍", count: 2, mine: false }];
    const snapshot = JSON.parse(JSON.stringify(input));
    toggleReactionRow(input, "👍");
    expect(input).toEqual(snapshot);
  });
});

describe("reactionDiff", () => {
  it("reports an added, an incremented and a removed count", () => {
    const before: Row[] = [
      { emoji: "👍", count: 1, mine: false },
      { emoji: "❤️", count: 2, mine: false },
    ];
    const after: Row[] = [
      { emoji: "👍", count: 3, mine: true },
      { emoji: "🎉", count: 1, mine: true },
    ];
    expect(reactionDiff(before, after)).toEqual([
      { emoji: "👍", before: 1, after: 3, direction: "up" },
      { emoji: "🎉", before: 0, after: 1, direction: "up" },
      { emoji: "❤️", before: 2, after: 0, direction: "down" },
    ]);
  });

  it("reports nothing when the counts agree", () => {
    const rows: Row[] = [{ emoji: "👍", count: 2, mine: true }];
    expect(reactionDiff(rows, rows)).toEqual([]);
  });
});

describe("whoReacted", () => {
  it("lists names when the reactor count matches", () => {
    expect(
      whoReacted({
        emoji: "👍",
        count: 2,
        mine: false,
        reactors: [
          { id: "u1", name: "Ada" },
          { id: "u2", name: "Bob" },
        ],
      }),
    ).toBe("Ada and Bob");
  });

  it("falls back to a count sentence when names are absent or stale", () => {
    expect(whoReacted({ emoji: "👍", count: 1, mine: true })).toBe("You reacted");
    expect(whoReacted({ emoji: "👍", count: 3, mine: true })).toBe("You and 2 others");
    expect(whoReacted({ emoji: "👍", count: 3, mine: false })).toBe("3 people reacted");
    // One name for three people: the list is stale, so it is not trusted.
    expect(
      whoReacted({
        emoji: "👍",
        count: 3,
        mine: false,
        reactors: [{ id: "u1", name: "Ada" }],
      }),
    ).toBe("3 people reacted");
  });
});

describe("reaction chip markup", () => {
  const render = (reactions: Row[]) =>
    renderToStaticMarkup(
      createElement(CommentReactions, { commentId: "c1", reactions, locale: "en" }),
    );

  it("renders a pressed chip with its count and the shared picker", () => {
    const html = render([{ emoji: "👍", count: 3, mine: true }]);
    expect(html).toContain('data-testid="reaction-chip-👍"');
    // count + the pressed (blue) tag ink
    expect(html).toContain(">3<");
    expect(html).toContain("--tag-blue-bg");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-testid="emoji-picker-trigger"');
  });

  it("renders the neutral ink when the viewer has not reacted", () => {
    const html = render([{ emoji: "🎉", count: 2, mine: false }]);
    expect(html).toContain('data-testid="reaction-chip-🎉"');
    expect(html).toContain("--tag-gray-bg");
    expect(html).not.toContain("--tag-blue-bg");
  });
});
