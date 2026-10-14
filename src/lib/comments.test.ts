import { describe, expect, it } from "vitest";
import { extractMentions, groupReactions, mentionMatches } from "./comments";

describe("groupReactions", () => {
  it("counts by emoji and marks your own", () => {
    const grouped = groupReactions(
      [
        { emoji: "👍", userId: "u2" },
        { emoji: "👍", userId: "me" },
        { emoji: "🎉", userId: "u2" },
      ],
      "me",
    );
    expect(grouped).toEqual([
      { emoji: "👍", count: 2, mine: true },
      { emoji: "🎉", count: 1, mine: false },
    ]);
  });

  it("handles an empty list", () => {
    expect(groupReactions([], "me")).toEqual([]);
  });
});

describe("extractMentions", () => {
  it("finds names, first names and emails, de-duplicated", () => {
    expect(extractMentions("hey @Ada and @ada.lovelace and @ada@example.com")).toEqual([
      "ada",
      "ada.lovelace",
      "ada@example.com",
    ]);
  });

  it("ignores an email that is not a mention", () => {
    expect(extractMentions("write to ada@example.com")).toEqual([]);
  });
});

describe("mentionMatches", () => {
  const member = { name: "Ada Lovelace", email: "ada@example.com" };

  it("matches by first name, full name, compact name and address", () => {
    for (const token of ["ada", "adalovelace", "ada lovelace", "ada@example.com", "ada@"]) {
      expect(mentionMatches(token, member)).toBe(true);
    }
  });

  it("does not match unrelated tokens", () => {
    expect(mentionMatches("grace", member)).toBe(false);
    expect(mentionMatches("ada2", member)).toBe(false);
  });
});
