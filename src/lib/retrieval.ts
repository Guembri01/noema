/**
 * Lightweight, dependency-free retrieval for AI grounding and search.
 *
 * The AI route previously used the whole prompt as a LIKE query, which almost
 * never matched. Here a prompt is reduced to meaningful terms and pages are
 * scored by where the terms appear (title beats body) so the model gets a
 * small, relevant context block instead of nothing.
 */

const STOPWORDS = new Set([
  "the", "and", "for", "with", "what", "that", "this", "these", "those",
  "from", "your", "you", "our", "their", "are", "was", "were", "have", "has",
  "had", "how", "why", "when", "who", "which", "into", "about", "only", "just",
  "reply", "respond", "page", "pages", "context", "mentioned", "mention",
  "list", "them", "then", "than", "there", "here", "does", "did", "can",
  "could", "should", "would", "will", "shall", "may", "might", "must",
  "give", "show", "tell", "find", "please", "using", "use", "used", "code",
  "answer", "answers", "question", "questions", "below", "above", "text",
  "exactly", "word", "words", "nothing", "else", "some", "any", "all", "one",
  "two", "three", "not", "but", "its", "it's", "they", "we", "i", "me", "my",
]);

/** Reduce a prompt to at most `limit` distinct, meaningful lowercase terms. */
export function promptTerms(prompt: string, limit = 8): string[] {
  const matches = prompt.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]{2,}/gu) ?? [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of matches) {
    const term = raw.replace(/^['’-]+|['’-]+$/g, "");
    if (term.length < 3 || STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= limit) break;
  }
  return terms;
}

export type PageScore = { score: number; matched: string[] };

/** Score a page against prompt terms: title hits weigh more than body hits. */
export function scorePage(terms: string[], title: string, text: string): PageScore {
  const lowerTitle = title.toLowerCase();
  const body = text.toLowerCase();
  let score = 0;
  const matched: string[] = [];
  for (const term of terms) {
    let hit = 0;
    if (lowerTitle.includes(term)) hit += 3;
    const count = body.split(term).length - 1;
    if (count > 0) hit += Math.min(2, count);
    if (hit > 0) {
      score += hit;
      matched.push(term);
    }
  }
  return { score, matched };
}

/** A short excerpt centred on the first occurrence of a matched term. */
export function snippetAround(text: string, term: string, radius = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const index = term ? flat.toLowerCase().indexOf(term) : -1;
  if (index === -1) return flat.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, index + radius)}${index + radius < flat.length ? "…" : ""}`;
}
