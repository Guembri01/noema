/**
 * Smart typography: the pure engine behind "Ligatures & smart quotes"
 * (docs/MISSING_FEATURES.md §2 — *"Typographic niceties while typing."*,
 * planned as an editor option).
 *
 * While a user types, an editor wants to turn straight ASCII into real
 * punctuation — curly quotes, en/em dashes, ellipses, ©/®/™. That behaviour
 * is defined here as data: a list of `TypographyRule` descriptors (id, regex
 * source, replace function, description) that an editor extension can compile
 * into ProseMirror/TipTap input rules, and that are also usable directly via
 * `applySmartTypography`.
 *
 * Pure and DB-free: no React, no TipTap, no I/O. `applyRule` runs one rule over
 * a string; `applySmartTypography` runs the whole pipeline; and
 * `applySmartTypographyIncremental` applies the pipeline to a tail window of a
 * line so a typing handler can stay O(window) instead of O(document).
 */

/** The characters a straight double quote opens after. */
const OPENING_BRACKETS = "([{<";

/** One `\w`-style letter/digit/underscore. */
const WORD_CHAR = /\w/;

/**
 * Everything a rule's `replace` needs to decide its output.
 *
 * `preceding`/`following` are the neighbours of the match (empty at either
 * end), while `text`/`index` expose the whole subject so context-sensitive
 * rules — such as deciding whether a lone `'` opens a quote or elides a
 * letter — can look further afield.
 */
export type TypographyRuleContext = {
  /** The full subject string the rule is being applied to. */
  text: string;
  /** The matched substring. */
  match: string;
  /** Where the match starts in `text`. */
  index: number;
  /** Capture groups of the match (empty strings for unmatched groups). */
  groups: string[];
  /** Character immediately before the match, or `""` at the start. */
  preceding: string;
  /** Character immediately after the match, or `""` at the end. */
  following: string;
};

/**
 * A declarative typography transform.
 *
 * `pattern` is a **regex source string** (not a literal) so the descriptor is
 * plain data that an editor extension can serialise or recompile. `applyRule`
 * compiles it with the global flag; `replace` maps a match context to the
 * replacement text.
 *
 * `optional` rules are off unless the caller explicitly opts in; currently the
 * three ligature-expansion rules, enabled by `disableLigatures: true`.
 */
export type TypographyRule = {
  id: string;
  pattern: string;
  replace: (ctx: TypographyRuleContext) => string;
  description: string;
  optional?: boolean;
};

/** Options accepted by `applySmartTypography` / the incremental variant. */
export type SmartTypographyOptions = {
  /**
   * When `true`, expand the ﬀ/ﬁ/ﬂ ligature code points to plain `ff`/`fi`/`fl`.
   * The engine never *creates* ligatures, so this is a normalisation pass for
   * text (pasted, imported, or produced by a font) that already contains them.
   */
  disableLigatures?: boolean;
};

/** Options accepted by `applySmartTypographyIncremental`. */
export type IncrementalTypographyOptions = SmartTypographyOptions & {
  /** Number of trailing characters to reprocess. Defaults to 256. */
  windowSize?: number;
};

/** Default tail window for `applySmartTypographyIncremental`. */
export const DEFAULT_INCREMENTAL_WINDOW = 256;

function isWordChar(char: string): boolean {
  return char !== "" && WORD_CHAR.test(char);
}

/**
 * True when a quote at this position should open rather than close: at the
 * start of the line, after whitespace, or after an opening bracket.
 */
function isOpeningContext(preceding: string): boolean {
  if (preceding === "") return true;
  if (/\s/.test(preceding)) return true;
  return OPENING_BRACKETS.includes(preceding);
}

/**
 * A lone leading `'` before a word is ambiguous: it may open a quote (`'hi'`)
 * or elide a letter (`'tis`, `'80s`, `'Twas`). We open only when a later
 * straight `'` sits immediately after a word character, which makes it a
 * plausible closing quote; otherwise we treat the quote as an apostrophe.
 */
function hasClosingSingleQuote(text: string, from: number): boolean {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "'" && isWordChar(text[i - 1] ?? "")) return true;
  }
  return false;
}

function replaceDoubleQuote(ctx: TypographyRuleContext): string {
  const { preceding, following } = ctx;
  // Word-internal (`5"3`, `a"b`) is genuinely ambiguous, so leave it straight.
  if (isWordChar(preceding) && isWordChar(following)) return '"';
  return isOpeningContext(preceding) ? "\u201C" : "\u201D";
}

function replaceSingleQuote(ctx: TypographyRuleContext): string {
  const { preceding, following, text, index, match } = ctx;
  // Between two word characters it is an apostrophe: it's, don't.
  if (isWordChar(preceding) && isWordChar(following)) return "\u2019";
  if (
    isOpeningContext(preceding) &&
    isWordChar(following) &&
    hasClosingSingleQuote(text, index + match.length)
  ) {
    return "\u2018";
  }
  return "\u2019";
}

/**
 * The pipeline, in application order. The order is load-bearing: `---` must be
 * matched before `--`, or an em dash would degrade to an en dash plus a
 * leftover hyphen.
 *
 * An editor extension that compiles these into input rules should skip rules
 * flagged `optional` unless the user enabled ligature expansion.
 */
export const TYPOGRAPHY_RULES: TypographyRule[] = [
  {
    id: "ellipsis",
    pattern: "\\.\\.\\.",
    replace: () => "\u2026",
    description: "Three periods collapse to a single ellipsis (…).",
  },
  {
    id: "em-dash",
    pattern: "---",
    replace: () => "\u2014",
    description: "Three hyphens become an em dash (—); runs before en-dash.",
  },
  {
    id: "en-dash",
    pattern: "--",
    replace: () => "\u2013",
    description: "Two hyphens become an en dash (–); a lone hyphen is left.",
  },
  {
    id: "copyright",
    pattern: "\\([cC]\\)",
    replace: () => "\u00A9",
    description: "(c) / (C) becomes a copyright sign (©).",
  },
  {
    id: "registered",
    pattern: "\\([rR]\\)",
    replace: () => "\u00AE",
    description: "(r) / (R) becomes a registered sign (®).",
  },
  {
    id: "trademark",
    pattern: "\\([tT][mM]\\)",
    replace: () => "\u2122",
    description: "(tm) in any case becomes a trademark sign (™).",
  },
  {
    id: "double-quote",
    pattern: '"',
    replace: replaceDoubleQuote,
    description:
      'Straight " becomes “/” from context; word-internal quotes stay straight.',
  },
  {
    id: "single-quote",
    pattern: "'",
    replace: replaceSingleQuote,
    description:
      "Straight ' becomes ‘/’; contractions and leading elisions become ’.",
  },
  {
    id: "ligature-ff",
    pattern: "\\uFB00",
    replace: () => "ff",
    description: "Expand the ﬀ ligature to ff (needs disableLigatures).",
    optional: true,
  },
  {
    id: "ligature-fi",
    pattern: "\\uFB01",
    replace: () => "fi",
    description: "Expand the ﬁ ligature to fi (needs disableLigatures).",
    optional: true,
  },
  {
    id: "ligature-fl",
    pattern: "\\uFB02",
    replace: () => "fl",
    description: "Expand the ﬂ ligature to fl (needs disableLigatures).",
    optional: true,
  },
];

/**
 * Apply a single rule to `text` with its own global regex, so tests and an
 * editor extension can exercise one transform at a time.
 */
export function applyRule(rule: TypographyRule, text: string): string {
  const re = new RegExp(rule.pattern, "g");
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    // Defensive: a zero-width pattern would otherwise loop forever.
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const index = match.index;
    out += text.slice(last, index);
    out += rule.replace({
      text,
      match: match[0],
      index,
      groups: match.slice(1).map((group) => group ?? ""),
      preceding: index > 0 ? text[index - 1] : "",
      following:
        index + match[0].length < text.length
          ? text[index + match[0].length]
          : "",
    });
    last = index + match[0].length;
  }
  out += text.slice(last);
  return out;
}

/**
 * Run the whole pipeline over `text`. Optional rules are skipped unless the
 * caller opts in with `disableLigatures`.
 */
export function applySmartTypography(
  text: string,
  opts: SmartTypographyOptions = {},
): string {
  let out = text;
  for (const rule of TYPOGRAPHY_RULES) {
    if (rule.optional && !opts.disableLigatures) continue;
    out = applyRule(rule, out);
  }
  return out;
}

/**
 * Apply the pipeline to a tail window of `before + inserted`, returning the
 * whole resulting line.
 *
 * A typing handler replays only the last `windowSize` characters rather than
 * the entire document, keeping each keystroke O(window). The limitation: a
 * pattern that starts before the window and ends inside it is not seen, and
 * the single-quote rule can only find a closing quote that lies within the
 * window — so `windowSize` must exceed the longest pattern (4 for `(tm)`), and
 * context further back than the window is deliberately invisible. Reprocessing
 * text that `before` may already contain is safe because every rule is
 * idempotent on its own output.
 */
export function applySmartTypographyIncremental(
  before: string,
  inserted: string,
  opts: IncrementalTypographyOptions = {},
): string {
  const full = before + inserted;
  const requested = opts.windowSize ?? DEFAULT_INCREMENTAL_WINDOW;
  const windowSize = Math.max(0, Math.floor(requested));
  const tailStart = Math.max(0, full.length - windowSize);
  const head = full.slice(0, tailStart);
  const tail = full.slice(tailStart);
  return head + applySmartTypography(tail, opts);
}
