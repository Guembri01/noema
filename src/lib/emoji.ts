/**
 * Emoji shortcodes (`:smile:` → 🙂).
 *
 * Pure and dependency-free: a curated shortcode table (the short tail people
 * actually type), a text-level expander for paste/import paths, and the
 * cursor matcher the editor input rule is built on. Only word-boundary
 * matches count — `10:30:` and `https://…` are never treated as shortcodes.
 */

/** Shortcode (without colons) → emoji. Kept deliberately small and curated. */
export const EMOJI_SHORTCODES: Record<string, string> = {
  smile: "🙂",
  grin: "😄",
  joy: "😂",
  sob: "😢",
  angry: "😠",
  thinking: "🤔",
  neutral_face: "😐",
  confounded: "😖",
  sunglasses: "😎",
  crying_face: "😭",
  thumbsup: "👍",
  "+1": "👍",
  thumbs_down: "👎",
  "-1": "👎",
  clap: "👏",
  wave: "👋",
  pray: "🙏",
  muscle: "💪",
  point_up: "☝️",
  ok_hand: "👌",
  tada: "🎉",
  party: "🥳",
  fire: "🔥",
  heart: "❤️",
  broken_heart: "💔",
  rocket: "🚀",
  eyes: "👀",
  "100": "💯",
  sparkles: "✨",
  bulb: "💡",
  warning: "⚠️",
  check: "✅",
  x: "❌",
  star: "⭐",
  zap: "⚡",
  bug: "🐛",
  puzzle: "🧩",
  seedling: "🌱",
  hourglass: "⌛",
  calendar: "📅",
  page: "📄",
  lock: "🔒",
  chart: "📊",
  memo: "📝",
  mail: "📧",
};

const CODE = "(:[a-z0-9_+\\-]{1,64}:)";
/** A shortcode only counts at the start of the text or after whitespace/a bracket. */
const BOUNDARY = "(^|[\\s(\\[|])";

/** Look up a shortcode (case-insensitive). Returns `null` when unknown. */
export function emojiForShortcode(code: string): string | null {
  const key = (code ?? "").trim().toLowerCase();
  if (!key) return null;
  return EMOJI_SHORTCODES[key] ?? null;
}

const EXPAND_ALL = new RegExp(`${BOUNDARY}${CODE}`, "gi");

/** Expand every known `:shortcode:` in the text; unknown ones stay literal. */
export function expandEmojiShortcodes(text: string): string {
  return (text ?? "").replace(EXPAND_ALL, (whole, prefix: string, code: string) => {
    const emoji = emojiForShortcode(code.slice(1, -1));
    return emoji ? prefix + emoji : whole;
  });
}

export type EmojiShortcodeMatch = {
  /** Index of the opening colon. */
  from: number;
  /** Index just past the closing colon (the cursor). */
  to: number;
  /** The shortcode without its colons, lowercased. */
  code: string;
  /** The emoji it expands to. */
  emoji: string;
};

const AT_CURSOR = new RegExp(`${BOUNDARY}${CODE}$`);

/**
 * Match a complete `:shortcode:` ending at the cursor — the moment the input
 * rule fires. Returns `null` for unknown shortcodes, for a trigger that is
 * still being typed, and for mid-word colons.
 */
export function matchEmojiShortcode(textBeforeCursor: string): EmojiShortcodeMatch | null {
  const text = textBeforeCursor ?? "";
  const match = AT_CURSOR.exec(text);
  if (!match) return null;
  const raw = match[2];
  const code = raw.slice(1, -1).toLowerCase();
  const emoji = emojiForShortcode(code);
  if (!emoji) return null;
  const from = text.length - raw.length;
  return { from, to: text.length, code, emoji };
}
