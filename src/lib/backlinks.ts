/**
 * Backlinks — the page link graph behind the "Backlinks" and "Linked
 * references" panels (docs/MISSING_FEATURES.md §1) plus the unlinked-mention
 * discovery pass. Pure functions only — no DB, no React, no routes.
 *
 * A block can point at another page two ways, and both are honoured:
 * an explicit `pageLinkId` (the `@`-picker's page-link node) and an internal
 * link stored in `href` shaped like `/page/<id>` (query, hash and a trailing
 * path segment are ignored, as are links to other hosts).
 *
 * The graph is a plain `Map<targetPageId, BacklinkRef[]>` so lookups are
 * O(1). Refs are deduped per (source page, block): one block links a target
 * at most once, while the same target reached from two blocks yields two
 * refs. `backlinksFor` sorts on read, so the index keeps insertion order and
 * callers get deterministic output.
 */

/** The minimal block shape the link graph understands. */
export type Block = {
  id: string;
  type: string;
  text?: string;
  children?: Block[];
  /** Explicit page-link target (the `@` picker node). */
  pageLinkId?: string;
  /** Link destination; internal `/page/<id>` links are recognized. */
  href?: string;
};

/** A page plus its blocks — the input to index building. */
export type LinkablePage = { id: string; blocks: Block[] };

/** One link found in a page: which block points where. */
export type PageLink = { targetPageId: string; blockId: string };

/** The result of scanning a single page's blocks. */
export type PageLinks = { pageId: string; links: PageLink[] };

/** One incoming reference to a target page, from a specific source block. */
export type BacklinkRef = { sourcePageId: string; blockId: string };

/** target page id → the refs that link to it (deduped per source block). */
export type BacklinkIndex = Map<string, BacklinkRef[]>;

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const byRef = (a: BacklinkRef, b: BacklinkRef) =>
  byId(a.sourcePageId, b.sourcePageId) || byId(a.blockId, b.blockId);

/** Depth-first walk over a block forest, parents before children. */
function* walk(blocks: readonly Block[]): Generator<Block> {
  for (const block of blocks) {
    yield block;
    if (block.children?.length) yield* walk(block.children);
  }
}

/** `/page/<id>` anywhere in the href, stopping at `/`, `?` or `#`. */
const PAGE_HREF = /(?:^|\/)page\/([^/?#\s]+)/;

/** The target page id encoded in an internal href, or `null`. */
function pageIdFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const match = PAGE_HREF.exec(href);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Every page link in `blocks`, in document order, deduped per block.
 * When a block carries both `pageLinkId` and an href, the explicit id wins
 * the ordering but both distinct targets are reported.
 */
export function extractPageLinks(pageId: string, blocks: readonly Block[]): PageLinks {
  const links: PageLink[] = [];
  const seen = new Set<string>();
  for (const block of walk(blocks)) {
    const targets: string[] = [];
    if (block.pageLinkId) targets.push(block.pageLinkId);
    const fromHref = pageIdFromHref(block.href);
    if (fromHref) targets.push(fromHref);
    for (const targetPageId of targets) {
      const key = `${targetPageId}\u0000${block.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ targetPageId, blockId: block.id });
    }
  }
  return { pageId, links };
}

/**
 * Fold many pages into the reverse index. A ref is stored once per
 * (target, source page, block); feeding the same page twice is harmless.
 */
export function buildBacklinkIndex(pages: Iterable<LinkablePage>): BacklinkIndex {
  const index: BacklinkIndex = new Map();
  for (const page of pages) {
    for (const link of extractPageLinks(page.id, page.blocks).links) {
      const list = index.get(link.targetPageId);
      const entry: BacklinkRef = { sourcePageId: page.id, blockId: link.blockId };
      if (!list) {
        index.set(link.targetPageId, [entry]);
        continue;
      }
      if (!list.some((ref) => ref.sourcePageId === page.id && ref.blockId === link.blockId)) {
        list.push(entry);
      }
    }
  }
  return index;
}

/** Refs into `pageId`, sorted by source page then block. Unresolved → `[]`. */
export function backlinksFor(index: BacklinkIndex, pageId: string): BacklinkRef[] {
  return [...(index.get(pageId) ?? [])].sort(byRef);
}

/** How many blocks link to `pageId`. */
export function countIncoming(index: BacklinkIndex, pageId: string): number {
  return index.get(pageId)?.length ?? 0;
}

/** Plain text of a block, including nested children. */
function plainText(block: Block): string {
  const parts: string[] = [];
  if (block.text) parts.push(block.text);
  for (const child of block.children ?? []) parts.push(plainText(child));
  return parts.join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive, word-bounded containment. Boundaries are "not a letter
 * or digit", so "Project Alpha" matches "... project alpha today" but not
 * "Project Alphabet".
 */
function mentionsTitle(text: string, title: string): boolean {
  if (!text || !title) return false;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(title)}(?![\\p{L}\\p{N}])`,
    "iu",
  );
  return pattern.test(text);
}

/**
 * Source pages that spell out `titleOf(pageId)` in plain text without ever
 * linking the page. Pages that already link it (via the index) and the target
 * itself are skipped; each remaining source page is reported once, at its
 * first mentioning block. Result is sorted by source page id.
 */
export function unlinkedMentions(
  index: BacklinkIndex,
  pageId: string,
  pages: Iterable<LinkablePage>,
  options: { titleOf: (id: string) => string | undefined },
): BacklinkRef[] {
  const title = options.titleOf(pageId)?.trim();
  if (!title) return [];
  const linked = new Set((index.get(pageId) ?? []).map((ref) => ref.sourcePageId));
  const mentions: BacklinkRef[] = [];
  for (const page of pages) {
    if (page.id === pageId || linked.has(page.id)) continue;
    for (const block of walk(page.blocks)) {
      if (!mentionsTitle(plainText(block), title)) continue;
      mentions.push({ sourcePageId: page.id, blockId: block.id });
      break;
    }
  }
  return mentions.sort(byRef);
}

/**
 * Candidate page ids to offer as links on this page: every known page except
 * the page itself and any target it already links. Sorted, deduped.
 * `blocks` is what makes "already linked" answerable without a round-trip.
 */
export function linkifyableTargets(
  pageId: string,
  blocks: readonly Block[],
  knownPageIds: Iterable<string>,
): string[] {
  const alreadyLinked = new Set(
    extractPageLinks(pageId, blocks).links.map((link) => link.targetPageId),
  );
  const candidates = new Set<string>();
  for (const id of knownPageIds) {
    if (id === pageId || alreadyLinked.has(id)) continue;
    candidates.add(id);
  }
  return [...candidates].sort(byId);
}
