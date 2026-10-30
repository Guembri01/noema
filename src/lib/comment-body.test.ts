import { describe, expect, it } from "vitest";
import {
  commentMentionedUserIds,
  commentMentionHref,
  commentMentionToken,
  extractMentions,
  hasMentions,
  parseCommentBody,
  toCommentBody,
  toPlainText,
  type CommentSegment,
} from "./comment-body";

/**
 * F9 — comment body parsing.
 *
 * A comment string is split into ordered `text` / `mention` / `link` / `emoji`
 * segments. Mentions use the wire token `@[Label](userId)`, links are bare
 * `http(s)://`, `www.` or app-asset `/api/files/...` URLs, and emoji are
 * `:shortcode:` resolved through `emojiForShortcode`. Malformed input never
 * throws - it degrades to text.
 */

describe("parseCommentBody", () => {
  it("splits a mixed body into ordered segments", () => {
    const body = "Hi @[Ada Lovelace](u1), see https://example.com/docs 🙂";
    expect(parseCommentBody(body)).toEqual([
      { type: "text", value: "Hi " },
      { type: "mention", value: "Ada Lovelace", id: "u1" },
      { type: "text", value: ", see " },
      { type: "link", value: "https://example.com/docs" },
      { type: "text", value: " 🙂" },
    ]);
  });

  it("keeps mention labels and ids, including several mentions", () => {
    expect(parseCommentBody("@[Ada](u1) and @[Grace Hopper](user_2)")).toEqual([
      { type: "mention", value: "Ada", id: "u1" },
      { type: "text", value: " and " },
      { type: "mention", value: "Grace Hopper", id: "user_2" },
    ]);
  });

  it("does not treat a plain @handle as a mention token", () => {
    expect(parseCommentBody("@ada hello")).toEqual([{ type: "text", value: "@ada hello" }]);
  });

  it("treats malformed mention tokens as text", () => {
    expect(parseCommentBody("@[Ada](u1")).toEqual([{ type: "text", value: "@[Ada](u1" }]);
    expect(parseCommentBody("@[Ada]()")).toEqual([{ type: "text", value: "@[Ada]()" }]);
    expect(parseCommentBody("@[Ada](has space)")).toEqual([
      { type: "text", value: "@[Ada](has space)" },
    ]);
  });

  it("parses http, https and www links, trimming trailing punctuation", () => {
    expect(parseCommentBody("go to https://a.test/x, then www.b.test.")).toEqual([
      { type: "text", value: "go to " },
      { type: "link", value: "https://a.test/x" },
      { type: "text", value: ", then " },
      { type: "link", value: "www.b.test" },
      { type: "text", value: "." },
    ]);
  });

  it("parses app-owned uploaded assets as links", () => {
    expect(parseCommentBody("report /api/files/ws-1/report.pdf now")).toEqual([
      { type: "text", value: "report " },
      { type: "link", value: "/api/files/ws-1/report.pdf" },
      { type: "text", value: " now" },
    ]);
  });

  it("does not parse a link inside the middle of a word", () => {
    expect(parseCommentBody("xwww.example.com")).toEqual([{ type: "text", value: "xwww.example.com" }]);
  });

  it("resolves known shortcodes to emoji and keeps unknown ones literal", () => {
    expect(parseCommentBody(":smile: and :notarealemoji:")).toEqual([
      { type: "emoji", value: "🙂", id: "smile" },
      { type: "text", value: " and :notarealemoji:" },
    ]);
  });

  it("parses adjacent shortcodes and normalizes the case of the id", () => {
    expect(parseCommentBody(":SMILE::tada:")).toEqual([
      { type: "emoji", value: "🙂", id: "smile" },
      { type: "emoji", value: "🎉", id: "tada" },
    ]);
  });

  it("never treats clock times or mid-word colons as emoji", () => {
    expect(parseCommentBody("meet at 10:30: sharp")).toEqual([
      { type: "text", value: "meet at 10:30: sharp" },
    ]);
    expect(parseCommentBody("see:x: y")).toEqual([{ type: "text", value: "see:x: y" }]);
  });

  it("merges runs of plain text and returns [] for an empty body", () => {
    expect(parseCommentBody("just words")).toEqual([{ type: "text", value: "just words" }]);
    expect(parseCommentBody("")).toEqual([]);
  });

  it("never throws on malformed or non-string input", () => {
    expect(() => parseCommentBody(null as unknown as string)).not.toThrow();
    expect(parseCommentBody(null as unknown as string)).toEqual([]);
    expect(parseCommentBody("@[:)(")).toEqual([{ type: "text", value: "@[:)(" }]);
  });
});

describe("toPlainText", () => {
  const segments: CommentSegment[] = [
    { type: "text", value: "Hi " },
    { type: "mention", value: "Ada", id: "u1" },
    { type: "text", value: " " },
    { type: "link", value: "https://a.test" },
    { type: "emoji", value: "🎉", id: "tada" },
  ];

  it("renders mentions, links and emoji as readable text", () => {
    expect(toPlainText(segments)).toBe("Hi @Ada https://a.test🎉");
  });

  it("is empty for an empty list and survives bad input", () => {
    expect(toPlainText([])).toBe("");
    expect(toPlainText(undefined as unknown as CommentSegment[])).toBe("");
  });
});

describe("extractMentions", () => {
  it("returns distinct ids in first-seen order, ignoring text", () => {
    const segments = parseCommentBody("@[Ada](u1) @[Ada again](u1) @[Bob](u2)");
    expect(extractMentions(segments)).toEqual(["u1", "u2"]);
  });

  it("is empty when there are no mentions", () => {
    expect(extractMentions(parseCommentBody("nothing here"))).toEqual([]);
    expect(extractMentions(undefined as unknown as CommentSegment[])).toEqual([]);
  });
});

describe("hasMentions", () => {
  it("detects whether any segment is a mention", () => {
    expect(hasMentions(parseCommentBody("hi @[Ada](u1)"))).toBe(true);
    expect(hasMentions(parseCommentBody("hi 🙂"))).toBe(false);
    expect(hasMentions(undefined as unknown as CommentSegment[])).toBe(false);
  });
});

describe("commentMentionedUserIds", () => {
  it("keeps typed people and legacy ids, ignores navigable targets", () => {
    const body =
      "@[Ada](user:u1) @[Bob](u2) @[Roadmap](project:p1) " +
      "@[Bugs](page:pg1) @[Ship it](milestone:p1:m1) @[Ada](user:u1)";
    expect(commentMentionedUserIds(body)).toEqual(["u1", "u2"]);
  });

  it("does not mistake a page token for a user id", () => {
    expect(commentMentionedUserIds("@[Bugs](page:pg1)")).toEqual([]);
  });
});

describe("comment mention links", () => {
  it("builds the route for each navigable target", () => {
    expect(commentMentionHref("page:pg1", "acme")).toBe("/w/acme/pg1");
    expect(commentMentionHref("project:p1", "acme")).toBe("/w/acme/projects/p1");
    expect(commentMentionHref("milestone:p1:m1", "acme")).toBe(
      "/w/acme/projects/p1#milestone-m1",
    );
    expect(commentMentionHref("user:u1", "acme")).toBeNull();
    expect(commentMentionHref("page:pg1", "")).toBeNull();
  });

  it("emits typed tokens the parser round-trips", () => {
    expect(
      commentMentionToken({ id: "p1", label: "Roadmap (Q4)", type: "project" }),
    ).toBe("@[Roadmap Q4](project:p1)");
    expect(
      commentMentionToken({
        id: "m1",
        label: "Ship it",
        type: "milestone",
        projectId: "p1",
      }),
    ).toBe("@[Ship it](milestone:p1:m1)");
    const token = commentMentionToken({ id: "pg1", label: "Bugs", type: "page" });
    expect(parseCommentBody(token)).toEqual([
      { type: "mention", value: "Bugs", id: "page:pg1" },
    ]);
  });
});

describe("round-trip", () => {
  it("reconstructs the original token body", () => {
    const body = "cc @[Ada](u1) :fire: https://a.test/x end";
    expect(toCommentBody(parseCommentBody(body))).toBe(body);
  });

  it("round-trips each token type in isolation", () => {
    for (const body of ["@[Ada Lovelace](u1)", "https://a.test/x", ":tada:", "plain"]) {
      expect(toCommentBody(parseCommentBody(body))).toBe(body);
    }
  });

  it("returns an empty string for an empty or bad list", () => {
    expect(toCommentBody([])).toBe("");
    expect(toCommentBody(null as unknown as CommentSegment[])).toBe("");
  });
});
