/**
 * Page icon model — the pure, view-facing layer over `Page.icon`.
 *
 * `Page.icon` (and the same column on databases, templates, projects,
 * workspaces, teams) is a nullable free-text column that the app has so far
 * treated as "an emoji, rendered as text". In practice Notion stores either an
 * emoji glyph or an image URL in the same slot, so every consumer needs the
 * same tolerant classifier before it can render or edit one. This module owns
 * that decision, with no DB, DOM, React or clock:
 *
 *  - {@link parsePageIcon} — classify a raw stored value into a `PageIcon`,
 *    failing closed to `none` for anything unrecognised;
 *  - {@link isEmoji} / {@link isImageIcon} — the two family predicates;
 *  - {@link normalizePageIcon} — repair a stale/mismatched record, treating the
 *    stored value as the source of truth for `kind`;
 *  - {@link randomEmoji} — a curated placeholder for "add icon", deterministic
 *    under an injected `rand`;
 *  - {@link pageIconToCss} — the inline-style declarations a renderer needs.
 *
 * Everything is pure: no helper mutates its arguments, none reads a clock, and
 * equal inputs always yield equal output (the only randomness is the injected
 * draw in {@link randomEmoji}).
 */

/** The three families a page icon can belong to. */
export type PageIconKind = "emoji" | "image" | "none";

/**
 * A classified page icon. `value` is the trimmed stored string for `emoji` and
 * `image`, and the empty string for `none`.
 */
export type PageIcon = {
  kind: PageIconKind;
  value: string;
};

/** The canonical "no icon" record. Frozen so it cannot be mutated in place. */
export const NONE_PAGE_ICON: PageIcon = Object.freeze({
  kind: "none",
  value: "",
});

/**
 * Curated, page-icon-friendly emoji used by {@link randomEmoji}. Deliberately
 * small and stable (no clock, no `Object.keys` order) so a seeded draw is
 * reproducible; every entry is a valid {@link isEmoji} value.
 */
export const PAGE_ICON_EMOJI: readonly string[] = Object.freeze([
  "📄",
  "📝",
  "📌",
  "📁",
  "🗂️",
  "📊",
  "📈",
  "🧠",
  "✅",
  "🚀",
  "💡",
  "🔥",
  "⭐",
  "🎯",
  "🧩",
  "🌱",
  "🎉",
  "🔒",
  "☕",
  "🍕",
  "🎨",
  "🎵",
  "🌍",
  "⚙️",
]);

/** `http(s)://` scheme, with at least one non-space character after it. */
const IMAGE_ICON_PATTERN = /^https?:\/\/\S+$/i;

/**
 * Characters that make a string emoji-shaped (a rough, dependency-free stand-in
 * for `\p{Extended_Pictographic}`): the pictographic planes plus the dingbats,
 * misc-symbols, arrows, variation selectors and ZWJ that compose sequences.
 */
const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{2190}-\u{21FF}\u{FE00}-\u{FE0F}\u{200D}]/u;
/** ASCII letters/digits: a text-ish string is never treated as a lone emoji. */
const ASCII_ALNUM_PATTERN = /[A-Za-z0-9]/;
/** Any whitespace, including inside the string. */
const WHITESPACE_PATTERN = /\s/;

/**
 * Upper bound (in code points) on what still counts as "an emoji". Generous
 * enough for the longest real ZWJ sequences (a family is 7) while rejecting a
 * wall of emoji that no picker would ever store as a single icon.
 */
const MAX_EMOJI_CODE_POINTS = 8;

/**
 * Rough grapheme check: true when `value` is a short, whitespace-free,
 * ASCII-free string containing at least one pictographic character — i.e. it
 * looks like one emoji (or a composed sequence such as a ZWJ family or a flag),
 * and not like a URL, a word, or mixed prose.
 */
export function isEmoji(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (WHITESPACE_PATTERN.test(trimmed)) return false;
  if (ASCII_ALNUM_PATTERN.test(trimmed)) return false;
  if (Array.from(trimmed).length > MAX_EMOJI_CODE_POINTS) return false;
  return EMOJI_PATTERN.test(trimmed);
}

/**
 * True when `value` is an absolute `http`/`https` URL — the only image shapes a
 * page icon may store. Other schemes (`javascript:`, `data:`), protocol-relative
 * URLs and relative paths are rejected so nothing unsafe reaches an `img`/CSS
 * sink.
 */
export function isImageIcon(value: unknown): value is string {
  return typeof value === "string" && IMAGE_ICON_PATTERN.test(value.trim());
}

function noneIcon(): PageIcon {
  return { kind: "none", value: "" };
}

/**
 * Classify a raw stored value. Tolerant of every input shape and never throws:
 * a non-string, a blank string, an unsafe scheme or unparseable text all
 * resolve to {@link NONE_PAGE_ICON}'s shape. Recognised values are trimmed, and
 * an image URL wins over the emoji heuristic.
 */
export function parsePageIcon(raw: unknown): PageIcon {
  if (typeof raw !== "string") return noneIcon();
  const value = raw.trim();
  if (value === "") return noneIcon();
  if (isImageIcon(value)) return { kind: "image", value };
  if (isEmoji(value)) return { kind: "emoji", value };
  return noneIcon();
}

/**
 * Produce a canonical {@link PageIcon} from a raw string, a `PageIcon`-like
 * record or junk. The stored `value` is the source of truth: a stale or
 * mismatched `kind` (e.g. `{ kind: "image", value: "🙂" }`) is corrected rather
 * than trusted, and a record whose value does not parse becomes `none`. Accepts
 * the same inputs as {@link parsePageIcon} plus `{ value }` objects. Never
 * throws; never mutates `input`.
 */
export function normalizePageIcon(input: unknown): PageIcon {
  if (typeof input === "string") return parsePageIcon(input);
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const { value } = input as { value?: unknown };
    return parsePageIcon(value);
  }
  return noneIcon();
}

/**
 * Draw a curated placeholder emoji. `rand` is injected for deterministic tests
 * (and callers seeding a stable placeholder); it defaults to `Math.random`. The
 * draw is clamped to `[0, 1]` and non-finite values fall back to the first
 * entry, so an out-of-range or `NaN` draw still returns a valid emoji.
 */
export function randomEmoji(rand: () => number = Math.random): string {
  const count = PAGE_ICON_EMOJI.length;
  const draw = rand();
  const safe = Number.isFinite(draw) ? draw : 0;
  const index = Math.min(count - 1, Math.max(0, Math.floor(safe * count)));
  return PAGE_ICON_EMOJI[index]!;
}

/** Escape a `"` / `\` so a URL survives a `url("…")` CSS value. */
function escapeCssUrl(value: string): string {
  return value.replace(/[\\"]/g, (char) => `\\${char}`);
}

/**
 * Inline-style declarations (React `style` shape) for rendering an icon. An
 * image icon becomes a `background-image` layer; an emoji renders as text and
 * a `none` icon renders nothing, so both yield an empty record.
 */
export function pageIconToCss(icon: PageIcon): Record<string, string> {
  if (icon.kind !== "image") return {};
  return { backgroundImage: `url("${escapeCssUrl(icon.value)}")` };
}
