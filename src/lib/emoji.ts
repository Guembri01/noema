/**
 * Emoji shortcodes (`:smile:` → 🙂).
 *
 * Pure and dependency-free: a curated shortcode table (the short tail people
 * actually type), a text-level expander for paste/import paths, the cursor
 * matcher the editor input rule is built on, plus the live-query helpers the
 * picker needs: `parseShortcodeAt` (caret → partial token) and
 * `emojiCandidates` (ranked prefix/keyword search). Only word-boundary
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
  gift: "🎁",
  fire: "🔥",
  heart: "❤️",
  broken_heart: "💔",
  rocket: "🚀",
  airplane: "✈️",
  car: "🚗",
  coffee: "☕",
  pizza: "🍕",
  apple: "🍎",
  cake: "🍰",
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

/**
 * Shortcode → keyword aliases backing `emojiCandidates`. Curated per group
 * (smileys, gestures, nature, food, activities, travel, objects, symbols) —
 * every alias must reference a key of `EMOJI_SHORTCODES` (tested).
 */
export const EMOJI_ALIASES: Record<string, string[]> = {
  // Smileys
  smile: ["happy", "smiley", "face"],
  grin: ["cheese", "teeth"],
  joy: ["laugh", "lol", "haha", "funny"],
  sob: ["cry", "tear", "sad"],
  angry: ["mad", "rage", "upset"],
  thinking: ["hmm", "think", "consider"],
  neutral_face: ["meh", "blank", "expressionless"],
  confounded: ["ugh", "frustrated"],
  sunglasses: ["cool", "chill"],
  crying_face: ["tear", "bawl"],
  // Gestures
  thumbsup: ["like", "yes", "approve", "good"],
  "+1": ["like", "yes", "approve"],
  thumbs_down: ["no", "dislike", "down"],
  "-1": ["no", "dislike"],
  clap: ["applause", "bravo", "clapping"],
  wave: ["hello", "hi", "bye"],
  pray: ["thanks", "please", "high five"],
  muscle: ["strong", "flex", "strength"],
  point_up: ["point", "up", "index"],
  ok_hand: ["okay", "perfect", "gotcha"],
  // Activities
  tada: ["party", "celebration", "confetti", "birthday", "hooray"],
  party: ["birthday", "bash"],
  puzzle: ["piece", "game", "jigsaw"],
  gift: ["present", "reward"],
  // Nature
  bug: ["insect", "beetle", "debug"],
  seedling: ["plant", "grow", "nature", "sprout"],
  // Food & drink
  coffee: ["drink", "caffeine", "espresso", "mug"],
  pizza: ["slice", "cheese", "food"],
  apple: ["fruit", "snack", "health"],
  cake: ["dessert", "sweet"],
  // Travel & places
  rocket: ["launch", "space", "fast", "startup"],
  airplane: ["plane", "flight", "travel", "vacation"],
  car: ["drive", "vehicle", "road"],
  // Objects
  eyes: ["look", "see", "watch"],
  bulb: ["idea", "light", "innovation"],
  hourglass: ["time", "wait", "loading"],
  calendar: ["date", "event", "schedule"],
  page: ["document", "paper", "file"],
  lock: ["secure", "password", "private"],
  chart: ["graph", "stats", "data"],
  memo: ["note", "pencil", "write"],
  mail: ["email", "letter", "message", "envelope"],
  // Symbols
  heart: ["love", "like", "valentine"],
  broken_heart: ["heartbreak", "breakup"],
  "100": ["perfect", "score", "keep it"],
  sparkles: ["shine", "magic", "shiny"],
  warning: ["caution", "alert", "exclamation"],
  check: ["done", "yes", "complete", "tick"],
  x: ["cross", "no", "wrong", "error"],
  star: ["favorite", "favourite", "rating"],
  zap: ["lightning", "bolt", "electric"],
  fire: ["lit", "hot", "flame", "burn"],
};

/** One character of a shortcode body (`:body:`). */
const TOKEN_CHAR = /^[a-z0-9_+\-]$/i;
/** A shortcode only counts at the start of the text or after whitespace/a bracket (or `:`, so `:a::b:` expands both). */
const BOUNDARY_BEFORE = /[\s(\[|:]/;

const CODE = "(:[a-z0-9_+\\-]{1,64}:)";
/** A shortcode only counts at the start of the text or after whitespace/a bracket. */
const BOUNDARY = "(^|[\\s(\\[|])";

/** Look up a shortcode (case-insensitive). Returns `null` when unknown. */
export function emojiForShortcode(code: string): string | null {
  const key = (code ?? "").trim().toLowerCase();
  if (!key) return null;
  return EMOJI_SHORTCODES[key] ?? null;
}

/**
 * Expand every known `:shortcode:` in the text; unknown, unterminated and
 * mid-word tokens (`a:b`, `:not an emoji :`, a lone `:`) stay literal.
 * Adjacent tokens (`:smile::tada:`) both expand.
 */
export function expandShortcodes(text: string): string {
  const src = text ?? "";
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const atBoundary = i === 0 || BOUNDARY_BEFORE.test(src[i - 1]);
    if (ch === ":" && atBoundary) {
      const close = src.indexOf(":", i + 1);
      const body = close === -1 ? "" : src.slice(i + 1, close);
      const isToken =
        body.length >= 1 &&
        body.length <= 64 &&
        Array.from(body).every((c) => TOKEN_CHAR.test(c));
      if (isToken) {
        const emoji = emojiForShortcode(body);
        if (emoji) {
          out += emoji;
          i = close + 1;
          continue;
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** @deprecated Use {@link expandShortcodes}; kept as the original export name. */
export function expandEmojiShortcodes(text: string): string {
  return expandShortcodes(text);
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

export type EmojiQuery = {
  /** Index of the opening colon — where a replacement starts. */
  from: number;
  /** The caret position — where a replacement ends. */
  to: number;
  /** The text typed between the colon and the caret, lowercased. */
  query: string;
};

/**
 * The live-query matcher behind the `:` trigger: given a caret inside a
 * `:word` token, return the partial query and the range a picker would
 * replace. `null` when the caret is not inside a token (mid-word colons,
 * clock times, a completed `:smile:`, out-of-range positions). An empty
 * `query` means the caret sits right after the opening `:`.
 */
export function parseShortcodeAt(text: string, caretPos: number): EmojiQuery | null {
  const src = text ?? "";
  const caret = caretPos;
  if (!Number.isInteger(caret) || caret < 0 || caret > src.length) return null;
  let start = caret;
  while (start > 0 && TOKEN_CHAR.test(src[start - 1])) start -= 1;
  const from = start - 1;
  if (from < 0 || src[from] !== ":") return null;
  if (from > 0 && !BOUNDARY_BEFORE.test(src[from - 1])) return null;
  return { from, to: caret, query: src.slice(start, caret).toLowerCase() };
}

export type EmojiCandidate = {
  /** The shortcode without its colons, lowercased. */
  shortcode: string;
  /** The emoji it expands to. */
  emoji: string;
  /** Curated keywords/aliases for this shortcode. */
  keywords: string[];
};

const RANK_EXACT_SHORTCODE = 0;
const RANK_SHORTCODE_PREFIX = 1;
const RANK_EXACT_KEYWORD = 2;
const RANK_KEYWORD_PREFIX = 3;
const RANK_KEYWORD_SUBSTRING = 4;

/** How well a shortcode matches a normalized query; `null` = no match. */
function candidateRank(shortcode: string, query: string): number | null {
  if (shortcode === query) return RANK_EXACT_SHORTCODE;
  if (shortcode.startsWith(query)) return RANK_SHORTCODE_PREFIX;
  const words = EMOJI_ALIASES[shortcode] ?? [];
  if (words.includes(query)) return RANK_EXACT_KEYWORD;
  if (words.some((w) => w.startsWith(query))) return RANK_KEYWORD_PREFIX;
  if (words.some((w) => w.includes(query))) return RANK_KEYWORD_SUBSTRING;
  return null;
}

/**
 * Ranked autocomplete for the picker: matches by shortcode prefix AND by
 * keyword aliases ("party" → 🥳 and 🎉 via tada). Order is stable — exact
 * shortcode, shortcode prefix, exact keyword, keyword prefix, keyword
 * substring, ties broken alphabetically — capped at `limit`.
 * An empty/blank query returns the stable top-N.
 */
export function emojiCandidates(query: string, limit = 10): EmojiCandidate[] {
  const q = (query ?? "").trim().toLowerCase();
  const max = Number.isInteger(limit) ? Math.max(0, limit) : 10;
  const scored: Array<{ rank: number; shortcode: string }> = [];
  for (const shortcode of Object.keys(EMOJI_SHORTCODES)) {
    const rank = q === "" ? RANK_EXACT_SHORTCODE : candidateRank(shortcode, q);
    if (rank !== null) scored.push({ rank, shortcode });
  }
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.shortcode < b.shortcode ? -1 : a.shortcode > b.shortcode ? 1 : 0;
  });
  return scored.slice(0, max).map(({ shortcode }) => ({
    shortcode,
    emoji: EMOJI_SHORTCODES[shortcode],
    keywords: [...(EMOJI_ALIASES[shortcode] ?? [])],
  }));
}
