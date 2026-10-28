/**
 * Conservative, opt-in autocorrection.
 *
 * The editor keeps native spellcheck on, so misspellings are underlined and the
 * browser can offer suggestions. This module is the *automatic* layer: a small
 * set of unambiguous typos that is safe to rewrite without asking. It is off by
 * default and only rewrites a complete word when the user types a space or
 * punctuation after it.
 */

const CORRECTIONS: Readonly<Record<string, string>> = Object.freeze({
  adn: "and",
  alot: "a lot",
  becuase: "because",
  definately: "definitely",
  dont: "don't",
  doesnt: "doesn't",
  didnt: "didn't",
  isnt: "isn't",
  wasnt: "wasn't",
  werent: "weren't",
  wont: "won't",
  cant: "can't",
  couldnt: "couldn't",
  wouldnt: "wouldn't",
  shouldnt: "shouldn't",
  hasnt: "hasn't",
  havent: "haven't",
  im: "I'm",
  ive: "I've",
  ill: "I'll",
  id: "I'd",
  its: "it's",
  recieve: "receive",
  recieved: "received",
  seperate: "separate",
  seperated: "separated",
  occured: "occurred",
  occuring: "occurring",
  teh: "the",
  thier: "their",
  untill: "until",
  wierd: "weird",
  whcih: "which",
  wich: "which",
  youre: "you're",
  youve: "you've",
  theyre: "they're",
  theres: "there's",
  thats: "that's",
  whats: "what's",
  lets: "let's",
});

/**
 * Correct one word, preserving the all-caps or title-case form the user typed.
 * Returns `null` when the word is already correct/unknown, so callers can leave
 * the transaction untouched.
 */
export function autocorrectWord(word: string): string | null {
  if (word.length < 2 || !/^[A-Za-z']+$/.test(word)) return null;
  const correction = CORRECTIONS[word.toLowerCase()];
  if (!correction) return null;

  if (word === word.toUpperCase()) return correction.toUpperCase();
  if (word[0] === word[0].toUpperCase()) {
    return correction[0].toUpperCase() + correction.slice(1);
  }
  return correction;
}

/** Characters that end a word for autocorrection purposes. */
export function isAutocorrectTrigger(text: string): boolean {
  return /^[ .,!?;:]$/.test(text);
}

/** The dictionary size, exported for tests and diagnostics. */
export const AUTOCORRECT_WORD_COUNT = Object.keys(CORRECTIONS).length;
