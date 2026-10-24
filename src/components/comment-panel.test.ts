import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * dz16 — the page comment panel.
 *
 * Pure mappings (author → avatar/initials, resolve state, mention extraction,
 * relative timestamp) are node-tested; the panel's four states and its
 * open/resolved thread markup are pinned with `renderToStaticMarkup`, so the
 * design-system adoption is a live check rather than a class-name guess.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/server/actions/comments", () => ({
  addCommentAction: vi.fn(async () => ({})),
  deleteCommentAction: vi.fn(async () => ({})),
  editCommentAction: vi.fn(async () => ({})),
  resolveCommentAction: vi.fn(async () => ({})),
  toggleCommentReactionAction: vi.fn(async () => ({})),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const {
  CommentPanel,
  commentAvatar,
  mentionHints,
  relativeTimestamp,
  resolveState,
} = await import("./comment-panel");

/* --------------------------------------------------------------- pure ---- */

describe("commentAvatar", () => {
  it("derives deterministic initials and a palette fill for a photo-less author", () => {
    const avatar = commentAvatar({ id: "u1", name: "Ada Lovelace", avatarUrl: null });
    expect(avatar.kind).toBe("initials");
    expect(avatar.initials).toBe("AL");
    expect(avatar.background).toMatch(/^#[0-9a-f]{6}$/i);
    // Same id ⇒ same colour, byte for byte.
    expect(commentAvatar({ id: "u1", name: "Ada Lovelace", avatarUrl: null })).toEqual(avatar);
  });

  it("prefers a usable image URL", () => {
    const avatar = commentAvatar({
      id: "u2",
      name: "Bob",
      avatarUrl: "https://cdn.example.com/bob.png",
    });
    expect(avatar.kind).toBe("image");
    expect(avatar.src).toBe("https://cdn.example.com/bob.png");
    expect(avatar.initials).toBe("BO");
  });

  it("still yields initials for a blank name", () => {
    expect(commentAvatar({ id: "u3", name: "", avatarUrl: null }).initials).toBe("?");
  });
});

describe("resolveState", () => {
  it("reads the wire boolean as the panel's thread state", () => {
    expect(resolveState(true)).toBe("resolved");
    expect(resolveState(false)).toBe("open");
  });
});

describe("mentionHints", () => {
  it("extracts unique, lowercased @tokens in appearance order", () => {
    expect(mentionHints("hey @Ada and @bob@example.com, cc @ada")).toEqual([
      "ada",
      "bob@example.com",
    ]);
  });

  it("is empty for a draft with no mentions", () => {
    expect(mentionHints("plain body")).toEqual([]);
    expect(mentionHints(null)).toEqual([]);
  });
});

describe("relativeTimestamp", () => {
  it("phrases an instant relative to an injected base", () => {
    expect(
      relativeTimestamp("2026-03-16T00:00:00.000Z", {
        base: "2026-03-18T00:00:00.000Z",
      }),
    ).toBe("2 days ago");
    expect(relativeTimestamp("not-a-date")).toBe("");
  });
});

/* ------------------------------------------------------------- markup ---- */

type Comment = Parameters<typeof CommentPanel>[0]["comments"][number];

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    body: "First!",
    quote: "the anchored words",
    blockId: null,
    resolved: false,
    reactions: [{ emoji: "👍", count: 2, mine: false }],
    createdAt: "2026-03-16T00:00:00.000Z",
    author: { id: "u1", name: "Ada Lovelace", avatarUrl: null },
    replies: [],
    ...overrides,
  };
}

function render(overrides: Partial<Parameters<typeof CommentPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(CommentPanel, {
      pageId: "p1",
      comments: [makeComment()],
      currentUserId: "u1",
      canComment: true,
      locale: "en",
      ...overrides,
    }),
  );
}

describe("CommentPanel markup", () => {
  it("renders an open thread: avatar, author, quote rail, reaction chip and actions", () => {
    const html = render();
    expect(html).toContain('data-testid="comment-c1"');
    expect(html).not.toContain('data-resolved="true"');
    expect(html).not.toContain('data-testid="resolved-tag"');
    expect(html).toContain('data-kind="initials"');
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain('data-testid="comment-quote"');
    expect(html).toContain("the anchored words");
    // The quote uses an accent left rail, not a raw hex.
    expect(html).toContain("border-s-accent");
    expect(html).toContain('data-testid="comment-actions"');
    expect(html).toContain('data-testid="comment-reactions"');
    expect(html).toContain('data-testid="reaction-chip-👍"');
    expect(html).toContain("Reply");
    expect(html).toContain("Resolve");
    // No block anchor was stored, so there is no jump affordance.
    expect(html).not.toContain('data-testid="comment-jump-c1"');
  });

  it("offers a jump to a persisted block anchor", () => {
    const html = render({ comments: [makeComment({ blockId: "block-42" })] });
    expect(html).toContain('data-testid="comment-jump-c1"');
    expect(html).toContain('data-comment-block-id="block-42"');
    expect(html).toContain("Jump to block");
    expect(html).toContain('aria-label="Jump to block: block-42"');
  });

  it("renders a resolved thread muted with a Resolved tag", () => {
    const html = render({ comments: [makeComment({ resolved: true })] });
    expect(html).toContain('data-resolved="true"');
    expect(html).toContain('data-testid="resolved-tag"');
    expect(html).toContain("Resolved");
  });

  it("renders the actionable empty state", () => {
    const html = render({ comments: [] });
    expect(html).toContain('data-testid="comment-empty"');
    expect(html).toContain("No comments yet");
    expect(html).toContain("Start the discussion.");
    // The composer is still offered so the discussion can start.
    expect(html).toContain("data-comment-input");
    expect(html).toContain("<kbd");
  });

  it("renders a loading skeleton instead of the list", () => {
    const html = render({ loading: true });
    expect(html).toContain('data-testid="comment-list-loading"');
    expect(html).not.toContain('data-testid="comment-c1"');
  });

  it("lays a comment body and its quote out on their own bidi direction", () => {
    const arabic = "\u0645\u0631\u062D\u0628\u0627"; // مرحبا
    const html = render({ comments: [makeComment({ body: arabic, quote: arabic })] });
    // The body paragraph and the quote both resolve RTL from their content,
    // instead of inheriting the English document direction.
    expect(html).toMatch(/<p dir="rtl"[^>]*dir-rtl/);
    expect(html).toMatch(/<blockquote[^>]*dir="rtl"/);
    expect(html).toContain(arabic);
  });

  it("isolates rich segments and author names so punctuation cannot jump", () => {
    const arabic = "\u0645\u0631\u062D\u0628\u0627";
    const html = render({
      comments: [
        makeComment({
          body: `See @[${arabic}](u2) at https://example.com/${arabic}.`,
        }),
      ],
    });
    // Mentions and links are native <bdi> isolates; so is the author name.
    expect(html.match(/<bdi>/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain(`<bdi>@${arabic}</bdi>`);
    expect(html).toContain(`<bdi>https://example.com/${arabic}</bdi>`);
  });

  it("renders the error state with a retry action", () => {
    const html = render({ loadError: "Could not load comments." });
    expect(html).toContain('data-testid="comment-error"');
    expect(html).toContain("Could not load comments.");
    expect(html).toContain("Retry");
    expect(html).not.toContain('data-testid="comment-c1"');
  });
});
