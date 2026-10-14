/**
 * Pure helpers for mention nodes. Mentions are inline atoms carrying
 * `{ id, label, type }` where `type` is "page" | "user" | "date". Page mentions
 * are how backlinks ("linked references") are discovered.
 */

export type MentionType = "page" | "user" | "date";

export type MentionAttrs = {
  id: string;
  label: string;
  type: MentionType;
};

type AnyNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: AnyNode[];
};

/** Collect the distinct mention ids of a given type from a document. */
export function collectMentionIds(doc: unknown, type?: MentionType): string[] {
  const ids = new Set<string>();
  const walk = (node: AnyNode | undefined) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "mention") {
      const attrs = (node.attrs ?? {}) as Record<string, unknown>;
      const nodeType = typeof attrs.type === "string" ? attrs.type : "page";
      if ((!type || nodeType === type) && typeof attrs.id === "string") {
        ids.add(attrs.id);
      }
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  const root = doc as AnyNode | null;
  if (root && Array.isArray(root.content)) root.content.forEach(walk);
  else walk(root ?? undefined);
  return [...ids];
}

/** Does a document reference the given page? */
export function docMentionsPage(doc: unknown, pageId: string): boolean {
  return collectMentionIds(doc, "page").includes(pageId);
}

/** Build the mention attributes for a page. */
export function pageMention(page: { id: string; title: string }): MentionAttrs {
  return { id: page.id, label: page.title || "Untitled", type: "page" };
}

/** Build the mention attributes for a user. */
export function userMention(user: { id: string; name: string }): MentionAttrs {
  return { id: user.id, label: user.name, type: "user" };
}

/** How a date mention chip renders its label. */
export type DateMentionStyle = "short" | "long" | "weekday";

export type DateMentionOptions = {
  /** Chip style; defaults to the compact `short` form. */
  style?: DateMentionStyle;
  /** BCP-47 locale; defaults to the runtime locale. */
  locale?: string;
};

const DATE_MENTION_FORMATS: Record<DateMentionStyle, Intl.DateTimeFormatOptions> = {
  short: { month: "short", day: "numeric", year: "numeric" },
  long: { month: "long", day: "numeric", year: "numeric" },
  weekday: { weekday: "short", month: "short", day: "numeric", year: "numeric" },
};

/**
 * Build a date mention from a Date. The `id` is always the ISO day (stable
 * across styles) so backlinks and dedup keep working when the label changes.
 */
export function dateMention(date: Date, options: DateMentionOptions = {}): MentionAttrs {
  const { style = "short", locale } = options;
  const iso = date.toISOString().slice(0, 10);
  return {
    id: iso,
    label: date.toLocaleDateString(locale, DATE_MENTION_FORMATS[style] ?? DATE_MENTION_FORMATS.short),
    type: "date",
  };
}

/**
 * Apply a page-visibility scope to mention suggestions: pages outside the
 * scope disappear, people and dates (which are not page resources) always
 * stay. `null` means "the viewer sees the whole workspace" and leaves the
 * list untouched.
 */
export function scopeMentionSuggestions<T extends { id: string; type: string }>(
  items: T[],
  visiblePageIds: ReadonlySet<string> | null,
): T[] {
  if (!visiblePageIds) return items;
  return items.filter((item) => item.type !== "page" || visiblePageIds.has(item.id));
}

/* ------------------------------------------------------------------ *
 * B18 — live `@`-mention query parsing (mention menu scoping).
 * ------------------------------------------------------------------ */

/** What the picker should search for: a concrete kind, or everything. */
export type MentionQueryKind = MentionType | "any";

export type MentionQuery = {
  /** Index of the `@` trigger — where a replacement starts. */
  from: number;
  /** The caret position — where a replacement ends. */
  to: number;
  /** The filter text typed after the trigger (and any scope word), trimmed. */
  query: string;
  /** Explicit scope from a prefix word, or the inferred kind. */
  kind: MentionQueryKind;
};

/** Characters that extend an in-progress `@query` token (space allows `@page ro`). */
const MENTION_TOKEN_CHAR = /[\p{L}\p{N}'_\- ]/u;
/** Word characters for the "not inside a word/email" boundary rule. */
const MENTION_WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Prefix words that scope the query to one mention kind. */
const MENTION_SCOPE_ALIASES: Record<string, MentionType> = {
  page: "page",
  user: "user",
  person: "user",
  people: "user",
  date: "date",
};

const ISO_DATE_QUERY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A trigger `@` may not sit directly behind a plain word ("foo@bar", an
 * email address) — unless that word is itself a completed mention
 * ("@Roadmap@pro" is a new token right after an existing mention node).
 */
function mentionTriggerBoundaryOk(src: string, at: number): boolean {
  if (at <= 0) return true;
  if (!MENTION_WORD_CHAR.test(src[at - 1])) return true;
  let i = at;
  while (i > 0 && MENTION_WORD_CHAR.test(src[i - 1])) i -= 1;
  return i > 0 && src[i - 1] === "@";
}

/**
 * The live-query matcher behind the `@` trigger: given a caret inside an
 * in-progress `@query` token, return the filter query, the range a picker
 * would replace, and the kind to search. `kind` is scoped by a prefix word
 * (`@page ro` → "page"/"ro", `@person`, `@date`) or inferred — an ISO date
 * query implies "date", anything else searches all kinds ("any"). `null`
 * when the caret is not inside a token: mid-word or email triggers,
 * newlines terminate a token, out-of-range carets. An empty `query` means
 * the caret sits right after the trigger (or a scope word).
 */
export function parseMentionQuery(text: string, caretPos: number): MentionQuery | null {
  const src = text ?? "";
  const caret = caretPos;
  if (!Number.isInteger(caret) || caret < 0 || caret > src.length) return null;
  let start = caret;
  while (start > 0 && MENTION_TOKEN_CHAR.test(src[start - 1])) start -= 1;
  const from = start - 1;
  if (from < 0 || src[from] !== "@") return null;
  if (!mentionTriggerBoundaryOk(src, from)) return null;
  const raw = src.slice(from + 1, caret).trim();
  const scopeWord = raw.split(/\s+/)[0];
  const scope = MENTION_SCOPE_ALIASES[scopeWord.toLowerCase()];
  if (scope) {
    return { from, to: caret, query: raw.slice(scopeWord.length).trim(), kind: scope };
  }
  const kind: MentionQueryKind = ISO_DATE_QUERY.test(raw) ? "date" : "any";
  return { from, to: caret, query: raw, kind };
}

/* ------------------------------------------------------------------ *
 * Unlinked mentions — backlink discovery for titles typed without a link.
 * ------------------------------------------------------------------ */

export type UnlinkedMention = {
  /** The canonical page title (as passed in, trimmed). */
  title: string;
  /** Start offset of the match in the text. */
  index: number;
  /** The exact substring as typed (case may differ from the title). */
  matched: string;
};

export type UnlinkedMentionOptions = {
  /**
   * Text of nodes that are already real mentions/links. Titles matching one
   * of these (case-insensitively) are skipped — the page already has a
   * linked reference, so only untyped occurrences would be noise.
   */
  exclude?: Iterable<string>;
};

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(source: string): string {
  return source.replace(REGEX_SPECIALS, "\\$&");
}

/**
 * Find page titles typed as plain text (no link/mention node) so a
 * backlink-discovery pass can offer them as references. Matches are
 * case-insensitive and must sit on unicode word boundaries ("Roadmap" is
 * not found inside "Roadmap2" or "xRoadmap"); blank/duplicate titles and
 * titles already linked (see `options.exclude`) are skipped. Results are
 * sorted by position, longer matches first on ties.
 */
export function findUnlinkedMentions(
  text: string,
  pageTitles: Iterable<string>,
  options: UnlinkedMentionOptions = {},
): UnlinkedMention[] {
  const src = text ?? "";
  const excluded = new Set<string>();
  for (const title of options.exclude ?? []) {
    const key = (title ?? "").trim().toLowerCase();
    if (key) excluded.add(key);
  }
  const seen = new Set<string>();
  const matches: UnlinkedMention[] = [];
  for (const title of pageTitles) {
    const label = (title ?? "").trim();
    const key = label.toLowerCase();
    if (!key || excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}_])(${escapeRegExp(label)})(?![\\p{L}\\p{N}_])`,
      "giu",
    );
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(src)) !== null) {
      matches.push({ title: label, index: match.index + (match[1]?.length ?? 0), matched: match[2] });
    }
  }
  matches.sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    return b.matched.length - a.matched.length;
  });
  return matches;
}

/* ------------------------------------------------------------------ *
 * Ranked autocomplete for people/pages/dates.
 * ------------------------------------------------------------------ */

export type MentionCandidate = {
  id: string;
  label: string;
  type: MentionType;
};

const RANK_EXACT_LABEL = 0;
const RANK_LABEL_PREFIX = 1;
const RANK_WORD_PREFIX = 2;
const RANK_SUBSTRING = 3;

/** How well a lowercased label matches a lowercased query; `null` = no match. */
function mentionCandidateRank(label: string, query: string): number | null {
  if (label === query) return RANK_EXACT_LABEL;
  if (label.startsWith(query)) return RANK_LABEL_PREFIX;
  if (label.split(/\s+/).some((word) => word.startsWith(query))) return RANK_WORD_PREFIX;
  if (label.includes(query)) return RANK_SUBSTRING;
  return null;
}

/**
 * Ranked mention autocomplete with `emojiCandidates` semantics: exact
 * label, label prefix, word prefix, then substring; case-insensitive;
 * ties keep the caller's (server-curated) input order; capped at `limit`.
 * A blank query returns the stable top-N; non-matches are dropped.
 */
export function mentionCandidates(
  query: string,
  entities: ReadonlyArray<{ id: string; label: string; type: MentionType }>,
  limit = 10,
): MentionCandidate[] {
  const q = (query ?? "").trim().toLowerCase();
  const max = Number.isInteger(limit) ? Math.max(0, limit) : 10;
  if (q === "") {
    return entities.slice(0, max).map(({ id, label, type }) => ({ id, label, type }));
  }
  const scored: Array<{ rank: number; candidate: MentionCandidate }> = [];
  for (const entity of entities) {
    const rank = mentionCandidateRank(entity.label.toLowerCase(), q);
    if (rank !== null) {
      scored.push({ rank, candidate: { id: entity.id, label: entity.label, type: entity.type } });
    }
  }
  scored.sort((a, b) => a.rank - b.rank); // stable sort → input order breaks ties
  return scored.slice(0, max).map((entry) => entry.candidate);
}
