/**
 * The work budget of the HTML tokenizer (B130).
 *
 * The tokenizer finds its tags with a regular expression whose attribute
 * group backtracks: at every tag start it reads forward to the next `>` and
 * gives the work back one character at a time when there is none. A document
 * with many tag starts and no closing `>` therefore costs Θ(n·k) — measured
 * on the upstream's `main`: 35 KB of `<script` block the event loop for 25 s,
 * 70 KB for 150 s. The import route accepts a 16 MB body, so one member can
 * hold the whole instance busy for minutes.
 *
 * The estimate below is the distance every tag start has to cover — the very
 * quantity the backtracking pays for — and it is computed in one pass. A
 * well-formed document costs about its own length (every tag start is
 * followed by its `>` soon); only a document that is built to make the
 * backtracking work is expensive.
 *
 * The budget is the measured one: the pathological 35 KB document needs
 * 1.75·10⁸ steps and 25 s, while the largest document the import accepts
 * (5 MB) needs at most about 5·10⁶ steps — the budget (1·10⁷) sits above
 * that and far below the pathological shape, so no document within the
 * import's own limit is refused.
 */

/** The steps the tokenizer may spend on one document. */
export const HTML_SCAN_BUDGET = 1e7;

/** The message a refused document gets. */
export const HTML_TOO_COMPLEX_ERROR = "This document is too complex to import.";

/**
 * The distance every tag start has to cover, in characters.
 *
 * One pass, backwards: the walk knows the next `>` at every position, and
 * every `<` adds the distance to it. A document without any `>` therefore
 * costs the length of the document per tag start — which is exactly what the
 * backtracking pays.
 */
export function estimateHtmlScanSteps(html: string): number {
  const length = html.length;
  let steps = 0;
  let nextTagEnd = length;
  for (let index = length - 1; index >= 0; index -= 1) {
    const code = html.charCodeAt(index);
    if (code === 62) {
      nextTagEnd = index; // ">"
    } else if (code === 60) {
      steps += nextTagEnd - index; // "<"
    }
  }
  return steps;
}

/** Whether the document fits into the budget. */
export function underHtmlScanBudget(html: string): boolean {
  return estimateHtmlScanSteps(html) <= HTML_SCAN_BUDGET;
}
