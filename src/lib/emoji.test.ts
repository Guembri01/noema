import { describe, expect, it } from "vitest";
import {
  EMOJI_SHORTCODES,
  emojiForShortcode,
  expandEmojiShortcodes,
  matchEmojiShortcode,
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
