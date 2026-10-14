/**
 * Linked references (backlinks) — server-side assembly of the
 * `src/lib/backlinks.ts` engine.
 *
 * A page stores its body as a ProseMirror/TipTap `doc` (see `src/lib/blocks.ts`),
 * while the pure engine models a page as a list of `Block`s that may carry a
 * `pageLinkId` (the `@`-picker's page node) or an internal `href`. This module
 * is the adapter between the two: it loads the workspace's pages, folds their
 * stored documents into `LinkablePage`s, builds the reverse index and resolves
 * the incoming refs for one target into the `{ id, title, icon }` shape the
 * `Backlinks` panel renders.
 *
 * Data shape note: editor page links are stored as inline `mention` nodes
 * (`attrs: { id, label, type: "page" }`) and as `pageEmbed` block atoms
 * (`attrs.pageId`); the engine's `/page/<id>` href branch also matches internal
 * link *marks* written in that form. The app's canonical page route is
 * `/w/<slug>/<pageId>` (`src/lib/deep-links.ts`), so `href` targets in that
 * form are resolved here and fed to the engine as `pageLinkId`. A link mark
 * whose href is neither a page deep link nor an engine `/page/<id>` link
 * (external URLs, mailto, …) is ignored.
 */

import { prisma } from "@/lib/db";
import { parseBlockDeepLink } from "@/lib/deep-links";
import {
  backlinksFor,
  buildBacklinkIndex,
  type Block,
  type LinkablePage,
} from "@/lib/backlinks";
import type { RichNode } from "@/lib/blocks";

/** A page as the "Linked references" panel renders it. */
export type LinkedReference = { id: string; title: string; icon: string | null };

/** Inline node types — the only nodes that can carry a mention or a link mark. */
const INLINE_TYPES = new Set(["text", "hardBreak", "mention", "inlineMath"]);

const isInline = (node: RichNode): boolean => INLINE_TYPES.has(node.type ?? "");

/** A link destination translated into one of the engine's link fields. */
type PageRef = { pageLinkId?: string; href?: string };

/**
 * Map a link mark's `href` to an engine field:
 * - a canonical `/w/<slug>/<pageId>` deep link → `pageLinkId` (the app's shape);
 * - an engine-shaped `/page/<id>` href → `href`, so the engine parses it;
 * - anything else (external, mailto, …) → `null`, ignored.
 */
function hrefRef(href: string): PageRef | null {
  const deep = parseBlockDeepLink(href);
  if (deep.ok) return { pageLinkId: deep.pageId };
  if (/(?:^|\/)page\/[^/?#\s]+/.test(href)) return { href };
  return null;
}

/** Walk a node's inline descendants, reporting each page mention / link once. */
function collectInlineRefs(node: RichNode, add: (ref: PageRef) => void): void {
  if (node.type === "mention") {
    const attrs = node.attrs ?? {};
    if ((attrs.type ?? "page") === "page" && typeof attrs.id === "string") {
      add({ pageLinkId: attrs.id });
    }
  }
  for (const mark of node.marks ?? []) {
    if (mark.type !== "link") continue;
    const href = mark.attrs?.href;
    if (typeof href !== "string" || href === "") continue;
    const ref = hrefRef(href);
    if (ref) add(ref);
  }
  for (const child of node.content ?? []) {
    if (isInline(child)) collectInlineRefs(child, add);
  }
}

/**
 * Page references carried by one block's inline content, deduped per block
 * (the engine counts a target at most once per block). Only inline descendants
 * are walked, so nested textblocks are not attributed to their container twice.
 */
function inlinePageRefs(block: RichNode): PageRef[] {
  const refs: PageRef[] = [];
  const seen = new Set<string>();
  const add = (ref: PageRef) => {
    const key = ref.pageLinkId ?? ref.href ?? "";
    if (!key || seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  for (const child of block.content ?? []) {
    if (isInline(child)) collectInlineRefs(child, add);
  }
  return refs;
}

/** Plain text of a block (including nested content), for the engine's text side. */
function blockText(node: RichNode): string {
  const parts: string[] = [];
  const visit = (current: RichNode) => {
    if (typeof current.text === "string") parts.push(current.text);
    if (current.type === "mention" && typeof current.attrs?.label === "string") {
      parts.push(current.attrs.label);
    }
    for (const child of current.content ?? []) visit(child);
  };
  visit(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Adapt a stored ProseMirror document to the engine's `Block` forest.
 *
 * Each block-level node becomes a `Block`; its page references are attached as
 * synthetic `pageLink` children (one per distinct target, so a paragraph can
 * mention several pages) and nested block nodes are converted recursively.
 * `pageEmbed` atoms carry their target on the block itself. A `null`/malformed
 * document yields no blocks.
 */
export function docToBlocks(doc: unknown): Block[] {
  const root = doc as RichNode | null;
  if (!root || !Array.isArray(root.content)) return [];
  let seq = 0;

  const convert = (node: RichNode): Block => {
    const id = `b${seq++}`;
    const block: Block = { id, type: node.type ?? "node" };
    const text = blockText(node);
    if (text) block.text = text;

    const children: Block[] = [];
    inlinePageRefs(node).forEach((ref, index) => {
      const refBlock: Block = { id: `${id}::${index}`, type: "pageLink" };
      if (ref.pageLinkId) refBlock.pageLinkId = ref.pageLinkId;
      if (ref.href) refBlock.href = ref.href;
      children.push(refBlock);
    });

    // A `pageEmbed` atom is a single page reference held on the node itself.
    if (node.type === "pageEmbed" && typeof node.attrs?.pageId === "string") {
      block.pageLinkId = node.attrs.pageId;
    }

    for (const child of node.content ?? []) {
      if (!isInline(child)) children.push(convert(child));
    }
    if (children.length > 0) block.children = children;
    return block;
  };

  return root.content.filter((node) => !isInline(node)).map(convert);
}

/**
 * Pages in the workspace that link to `pageId` (linked references), newest
 * page first is not guaranteed — the engine orders by source page then block,
 * which is stable and deduplicated per source page here.
 *
 * Workspace-scoped like the other page queries. `visiblePageIds` applies the
 * guest scope (R80.12): when the viewer is a guest, only source pages they may
 * open are considered, so hidden mentioners never leak their titles.
 *
 * The scan is bounded to the most recently updated 1000 pages, mirroring the
 * previous mention-based query; the cap is silent (D7).
 */
export async function getLinkedReferences(
  workspaceId: string,
  pageId: string,
  visiblePageIds: ReadonlySet<string> | null = null,
): Promise<LinkedReference[]> {
  const pages = await prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      NOT: { id: pageId },
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 1000,
    select: { id: true, title: true, icon: true, content: true },
  });

  const linkable: LinkablePage[] = pages.map((page) => ({
    id: page.id,
    blocks: docToBlocks(page.content),
  }));
  const index = buildBacklinkIndex(linkable);

  const byId = new Map(pages.map((page) => [page.id, page]));
  const items: LinkedReference[] = [];
  const seen = new Set<string>();
  for (const ref of backlinksFor(index, pageId)) {
    if (seen.has(ref.sourcePageId)) continue;
    seen.add(ref.sourcePageId);
    const source = byId.get(ref.sourcePageId);
    if (!source) continue;
    items.push({ id: source.id, title: source.title, icon: source.icon });
  }
  return items;
}
