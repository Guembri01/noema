import { describe, expect, it } from "vitest";
import {
  EMOJI_ALIASES,
  EMOJI_SHORTCODES,
  emojiCandidates,
  emojiForShortcode,
  expandEmojiShortcodes,
  expandShortcodes,
  matchEmojiShortcode,
  parseShortcodeAt,
} from "@/lib/emoji";

/**
 * B18 — emoji shortcode expansion (`:smile:` → 🙂).
 *
 * Pure helpers: the lookup table, the text-level expander (paste / import
 * paths) and the cursor matcher the editor input rule is built on.
 */
describe("emoji shortcodes", () => {
  it("maps common shortcodes to emoji", () => {
    expect(emojiForShortcode("smile")).toBe("🙂");
    expect(emojiForShortcode("tada")).toBe("🎉");
    expect(emojiForShortcode("+1")).toBe("👍");
    expect(emojiForShortcode("SMILE")).toBe("🙂"); // lookup is case-insensitive
    expect(emojiForShortcode("notarealemoji")).toBeNull();
    expect(Object.keys(EMOJI_SHORTCODES).length).toBeGreaterThanOrEqual(30);
  });

  it("expands shortcodes in text and leaves unknown ones alone", () => {
    expect(expandEmojiShortcodes("hi :smile: there")).toBe("hi 🙂 there");
    expect(expandEmojiShortcodes(":tada: now")).toBe("🎉 now");
    expect(expandEmojiShortcodes("two :smile: and :rocket:")).toBe("two 🙂 and 🚀");
    expect(expandEmojiShortcodes(":nope: stays")).toBe(":nope: stays");
    expect(expandEmojiShortcodes("no shortcodes here")).toBe("no shortcodes here");
  });

  it("never treats mid-word colons or clock times as shortcodes", () => {
    expect(expandEmojiShortcodes("10:30: done")).toBe("10:30: done");
    expect(expandEmojiShortcodes("see:x: y")).toBe("see:x: y");
    expect(expandEmojiShortcodes("https://example.com")).toBe("https://example.com");
  });

  it("matches the shortcode being typed at the cursor", () => {
    expect(matchEmojiShortcode("hi :smile:")).toMatchObject({
      from: 3,
      to: 10,
      code: "smile",
      emoji: "🙂",
    });
    expect(matchEmojiShortcode(":tada:")).toMatchObject({ from: 0, to: 6, emoji: "🎉" });
    expect(matchEmojiShortcode("x:smile:")).toBeNull(); // no word boundary
    expect(matchEmojiShortcode(":nope:")).toBeNull(); // unknown shortcode
    expect(matchEmojiShortcode("hi :smi")).toBeNull(); // still typing
    expect(matchEmojiShortcode("https://example.com")).toBeNull();
  });
});

/**
 * Inline expansion (`expandShortcodes`) — paste / import path.
 * Same semantics as `expandEmojiShortcodes`, plus adjacent tokens.
 */
describe("expandShortcodes (inline expansion)", () => {
  it("expands several shortcodes in mixed prose", () => {
    expect(expandShortcodes("Ship it :rocket: then celebrate :tada:!")).toBe(
      "Ship it 🚀 then celebrate 🎉!",
    );
    expect(expandShortcodes(":smile: :thumbsup:")).toBe("🙂 👍");
    expect(expandShortcodes("plain text, no emoji")).toBe("plain text, no emoji");
  });

  it("expands adjacent shortcodes back-to-back", () => {
    expect(expandShortcodes(":smile::tada:")).toBe("🙂🎉");
    expect(expandShortcodes("look: :fire::100: done")).toBe("look: 🔥💯 done");
  });

  it("leaves unknown, unterminated, and stray-colon text untouched", () => {
    expect(expandShortcodes("a:b")).toBe("a:b"); // mid-word colon
    expect(expandShortcodes(":not an emoji :")).toBe(":not an emoji :"); // spaces inside
    expect(expandShortcodes(":")).toBe(":"); // lone colon
    expect(expandShortcodes("type :smile here")).toBe("type :smile here"); // unterminated
    expect(expandShortcodes(":nope::smile:")).toBe(":nope:🙂"); // unknown stays, next expands
  });
});

/**
 * `parseShortcodeAt` — the live-suggestion matcher for the `:` trigger.
 */
describe("parseShortcodeAt", () => {
  it("returns the partial query and range while typing inside a token", () => {
    expect(parseShortcodeAt("hi :smi", 7)).toMatchObject({ from: 3, to: 7, query: "smi" });
    // caret mid-token: query is only the text up to the caret, lowercased
    expect(parseShortcodeAt("hi :SMIle", 7)).toMatchObject({ from: 3, to: 7, query: "smi" });
    expect(parseShortcodeAt(":s", 2)).toMatchObject({ from: 0, to: 2, query: "s" });
    expect(parseShortcodeAt("see :smile done", 10)).toMatchObject({
      from: 4,
      to: 10,
      query: "smile",
    });
  });

  it("handles token boundaries", () => {
    expect(parseShortcodeAt("hi :", 4)).toMatchObject({ from: 3, to: 4, query: "" }); // right after `:`
    expect(parseShortcodeAt("hi :smile", 4)).toMatchObject({ from: 3, to: 4, query: "" });
    expect(parseShortcodeAt(":smile", 0)).toBeNull(); // caret on the opening colon
    expect(parseShortcodeAt(":smile:", 7)).toBeNull(); // right after a completed token
    expect(parseShortcodeAt("::", 2)).toMatchObject({ from: 1, to: 2, query: "" }); // start a new one adjacent
  });

  it("returns null when the caret is not inside a token", () => {
    expect(parseShortcodeAt("plain text", 5)).toBeNull();
    expect(parseShortcodeAt("", 0)).toBeNull();
    expect(parseShortcodeAt("a:b", 3)).toBeNull(); // mid-word colon
    expect(parseShortcodeAt("see:x", 5)).toBeNull(); // no word boundary
    expect(parseShortcodeAt("10:30", 5)).toBeNull(); // clock time
    expect(parseShortcodeAt("hi :smi", 99)).toBeNull(); // caret out of range
    expect(parseShortcodeAt("hi :smi", -1)).toBeNull();
  });
});

/**
 * `emojiCandidates` — ranked search by shortcode prefix and keyword aliases.
 */
describe("emojiCandidates", () => {
  it("matches by shortcode prefix in a stable ranked order", () => {
    const all = emojiCandidates("thum", 100);
    expect(all.length).toBeGreaterThan(1);
    for (const c of all) expect(c.shortcode.startsWith("thum")).toBe(true);
    expect(all.map((c) => c.emoji)).toContain("👍");
    expect(all.map((c) => c.emoji)).toContain("👎");
    expect(emojiCandidates("rocket")).toMatchObject([{ shortcode: "rocket", emoji: "🚀" }]);
  });

  it("matches keyword aliases, not just shortcodes", () => {
    expect(emojiCandidates("party")[0]).toMatchObject({ shortcode: "party", emoji: "🥳" });
    expect(emojiCandidates("party").map((c) => c.emoji)).toContain("🎉"); // via tada alias
    expect(emojiCandidates("celebr")[0]).toMatchObject({ shortcode: "tada", emoji: "🎉" });
    expect(emojiCandidates("LOVE").map((c) => c.emoji)).toContain("❤️"); // case-insensitive
  });

  it("caps results at the requested limit, keeping ranked order", () => {
    const all = emojiCandidates("s", 100);
    expect(all.length).toBeGreaterThan(3);
    expect(emojiCandidates("s", 3)).toEqual(all.slice(0, 3));
    expect(emojiCandidates("s", 3).length).toBe(3);
  });

  it("returns a stable top-N for an empty query", () => {
    const top = emojiCandidates("", 5);
    expect(top).toHaveLength(5);
    expect(top).toEqual(emojiCandidates("", 5)); // deterministic
    for (const c of top) {
      expect(emojiForShortcode(c.shortcode)).toBe(c.emoji);
    }
    expect(emojiCandidates("   ")).toEqual(emojiCandidates(""));
  });

  it("returns an empty list when nothing matches", () => {
    expect(emojiCandidates("zzznotanemoji")).toEqual([]);
    expect(emojiCandidates("🎉")).toEqual([]); // emoji input is not a query
  });

  it("keeps a curated alias index across common groups", () => {
    // every alias must reference a real shortcode
    for (const [code, words] of Object.entries(EMOJI_ALIASES)) {
      expect(EMOJI_SHORTCODES[code], `alias target missing: ${code}`).toBeDefined();
      expect(words.length).toBeGreaterThan(0);
    }
    // one representative query per group
    expect(emojiCandidates("happy")[0]?.emoji).toBe("🙂"); // smileys
    expect(emojiCandidates("plant")[0]?.emoji).toBe("🌱"); // nature
    expect(emojiCandidates("caffeine")[0]?.emoji).toBe("☕"); // food
    expect(emojiCandidates("confetti")[0]?.emoji).toBe("🎉"); // activities
    expect(emojiCandidates("flight")[0]?.emoji).toBe("✈️"); // travel
    expect(emojiCandidates("idea")[0]?.emoji).toBe("💡"); // objects
    expect(emojiCandidates("warning")[0]?.emoji).toBe("⚠️"); // symbols
  });
});
