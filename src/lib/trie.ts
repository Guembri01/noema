/**
 * Prefix trie — the pure, immutable index behind autocomplete / quick-find
 * (mention pickers, command palettes, page link suggestions).
 *
 * A trie is a tree of single-character edges: every node is a prefix, and a node
 * that ends a stored word is marked with that word. Membership, prefix tests and
 * completion are all O(length of the query) plus the size of the result set, so
 * a picker can answer as the user types without rescanning the corpus.
 *
 * The whole structure is treated as a value: `insert` and `remove` return a
 * fresh trie and never mutate (or alias the maps of) the one they were given;
 * the other functions only read. Given the same inputs the output is always
 * identical, which makes the index safe to rebuild and easy to test.
 *
 * The `caseInsensitive` option folds case for every lookup, while completions
 * still echo the casing each word was inserted with (so a picker shows
 * "Apple", not "apple"). Words are ignored when empty.
 */

/** A node in the trie: a prefix, its stored word (if any) and its children. */
export type TrieNode = {
  /** The complete word this node terminates, or `null` for a pure prefix. */
  readonly word: string | null;
  /** Edges to the next character, keyed by one (possibly folded) character. */
  readonly children: ReadonlyMap<string, TrieNode>;
};

/** An immutable prefix index over a set of words. */
export type Trie = {
  /** Root of the tree; every word is a path from here. */
  readonly root: TrieNode;
  /** Whether lookups fold case (words still echo their inserted casing). */
  readonly caseInsensitive: boolean;
  /** Number of distinct words stored. */
  readonly size: number;
};

/** Options accepted by `createTrie` / `buildTrie`. */
export type TrieOptions = {
  /** Fold case for all lookups; completions echo inserted casing. Default `false`. */
  caseInsensitive?: boolean;
};

/** Options accepted by `complete`. */
export type CompleteOptions = {
  /** Maximum number of completions to return. Fractions floor; negatives give none. */
  limit?: number;
};

/** The one shared empty node; every empty trie starts here. */
const EMPTY_NODE: TrieNode = { word: null, children: new Map() };

/** Fold a word for storage/lookup when case-insensitive; identity otherwise. */
function normalize(word: string, caseInsensitive: boolean): string {
  return caseInsensitive ? word.toLowerCase() : word;
}

/** Split into code points (so astral characters count as one edge). */
function codePoints(word: string): string[] {
  return [...word];
}

/** Walk `chars` from `root`, returning the node reached or `null` if absent. */
function findNode(root: TrieNode, chars: readonly string[]): TrieNode | null {
  let node = root;
  for (const ch of chars) {
    const next = node.children.get(ch);
    if (next === undefined) return null;
    node = next;
  }
  return node;
}

/** Immutable insertion of `word` (given as code points) below `node`. */
function insertNode(
  node: TrieNode,
  chars: readonly string[],
  index: number,
  word: string,
): TrieNode {
  if (index === chars.length) {
    return node.word === null ? { word, children: node.children } : node;
  }
  const ch = chars[index];
  const child = node.children.get(ch);
  const nextChild = insertNode(child ?? EMPTY_NODE, chars, index + 1, word);
  if (nextChild === child) return node;
  const children = new Map(node.children);
  children.set(ch, nextChild);
  return { word: node.word, children };
}

/** Immutable removal of the word at `chars`, pruning any leaf branches left empty. */
function removeNode(node: TrieNode, chars: readonly string[], index: number): TrieNode {
  if (index === chars.length) {
    return { word: null, children: node.children };
  }
  const ch = chars[index];
  const child = node.children.get(ch);
  if (child === undefined) return node;
  const nextChild = removeNode(child, chars, index + 1);
  const children = new Map(node.children);
  if (nextChild.word === null && nextChild.children.size === 0) {
    children.delete(ch);
  } else {
    children.set(ch, nextChild);
  }
  return { word: node.word, children };
}

/** Depth-first collection of every word at or below `node`, in edge order. */
function collect(node: TrieNode, out: string[]): void {
  if (node.word !== null) out.push(node.word);
  for (const child of node.children.values()) collect(child, out);
}

/** A usable cap for `complete`: a floored integer ≥ 0, or `Infinity` for "all". */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(limit)) {
    return limit === Number.NEGATIVE_INFINITY ? 0 : Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.floor(limit));
}

/** A fresh, empty trie. */
export function createTrie({ caseInsensitive = false }: TrieOptions = {}): Trie {
  return { root: EMPTY_NODE, caseInsensitive, size: 0 };
}

/**
 * Build a trie from `words`, in order. Empty words are ignored and duplicates
 * collapse, so `size` is the number of distinct words actually stored.
 */
export function buildTrie(words: readonly string[], options: TrieOptions = {}): Trie {
  let trie = createTrie(options);
  for (const word of words) trie = insert(trie, word);
  return trie;
}

/**
 * Add `word`, returning a fresh trie. Inserting a word that is already present
 * is a no-op that returns the same reference; an empty word is ignored.
 */
export function insert(trie: Trie, word: string): Trie {
  if (word.length === 0) return trie;
  const chars = codePoints(normalize(word, trie.caseInsensitive));
  const existing = findNode(trie.root, chars);
  if (existing !== null && existing.word !== null) return trie;
  const root = insertNode(trie.root, chars, 0, word);
  return { root, caseInsensitive: trie.caseInsensitive, size: trie.size + 1 };
}

/** Whether `word` is stored exactly (whole word, not a prefix). */
export function has(trie: Trie, word: string): boolean {
  const node = findNode(trie.root, codePoints(normalize(word, trie.caseInsensitive)));
  return node !== null && node.word !== null;
}

/** Whether any stored word begins with `prefix` (a stored word matches itself). */
export function startsWith(trie: Trie, prefix: string): boolean {
  const node = findNode(trie.root, codePoints(normalize(prefix, trie.caseInsensitive)));
  return node !== null && (node.word !== null || node.children.size > 0);
}

/**
 * Every stored word beginning with `prefix`, sorted in default lexicographic
 * (UTF-16 code unit) order, capped at `limit` when given. The empty prefix
 * yields all words.
 */
export function complete(trie: Trie, prefix: string, options: CompleteOptions = {}): string[] {
  const node = findNode(trie.root, codePoints(normalize(prefix, trie.caseInsensitive)));
  if (node === null) return [];
  const out: string[] = [];
  collect(node, out);
  out.sort();
  return out.slice(0, normalizeLimit(options.limit));
}

/**
 * Remove `word`, returning a fresh trie, pruning branches left with no words.
 * Removing an absent or empty word is a no-op that returns the same reference.
 */
export function remove(trie: Trie, word: string): Trie {
  if (word.length === 0) return trie;
  const chars = codePoints(normalize(word, trie.caseInsensitive));
  const node = findNode(trie.root, chars);
  if (node === null || node.word === null) return trie;
  const root = removeNode(trie.root, chars, 0);
  return { root, caseInsensitive: trie.caseInsensitive, size: trie.size - 1 };
}
