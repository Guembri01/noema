"use server";

import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { updatePageAction } from "@/server/actions/pages";
import type { RichNode } from "@/lib/blocks";

type Result = { ok: true } | { error: string };

/**
 * Word-bounded, case-insensitive locator for `title` inside one text run.
 * Boundaries are "not a letter or digit", the same rule the unlinked-mention
 * scan uses, so we only ever link the occurrence the panel reported.
 */
function findTitle(text: string, title: string): { start: number; end: number } | null {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
  const match = pattern.exec(text);
  if (!match || match.index === undefined) return null;
  return { start: match.index, end: match.index + match[0].length };
}

/**
 * Rewrite the first plain-text occurrence of `title` in a block forest into the
 * `@`-picker's page-link node — an inline `mention` atom with
 * `attrs: { id, label, type: "page" }`. That is exactly the shape
 * `src/server/backlinks.ts` reads as a `pageLinkId`, so the source page becomes
 * a linked reference. Surrounding runs keep their marks; the match itself is
 * replaced wholesale. Returns `true` once one occurrence has been linked.
 */
function linkFirstMention(
  nodes: RichNode[],
  targetPageId: string,
  title: string,
): boolean {
  for (const node of nodes) {
    if (node.type === "text" && typeof node.text === "string") {
      const hit = findTitle(node.text, title);
      if (hit) {
        const before = node.text.slice(0, hit.start);
        const after = node.text.slice(hit.end);
        const replacement: RichNode[] = [];
        if (before) replacement.push({ ...node, text: before });
        replacement.push({
          type: "mention",
          attrs: {
            id: targetPageId,
            label: node.text.slice(hit.start, hit.end),
            type: "page",
          },
        });
        if (after) replacement.push({ ...node, text: after });
        nodes.splice(nodes.indexOf(node), 1, ...replacement);
        return true;
      }
    }
    if (Array.isArray(node.content) && linkFirstMention(node.content, targetPageId, title)) {
      return true;
    }
  }
  return false;
}

/**
 * Turn a plain-text mention of `targetPageId` into a real page link in
 * `sourcePageId`.
 *
 * The rewrite is the only new piece of logic here: permission checks, the
 * revision snapshot, the search-text mirror, webhooks and revalidation all run
 * through the canonical `updatePageAction`, so this action cannot drift from
 * the editor's edit path. `targetPageId` is the linking page (the one whose
 * "Unlinked mentions" list rendered the row); `sourcePageId` is the page that
 * spells its title out as text. Both must live in the same workspace, and the
 * caller must be able to edit the source.
 */
export async function linkUnlinkedMentionAction(
  sourcePageId: string,
  targetPageId: string,
): Promise<Result> {
  if (!sourcePageId || !targetPageId) {
    return { error: "A page to link is required." };
  }
  const user = await requireUser();
  const source = await prisma.page.findUnique({
    where: { id: sourcePageId },
    select: { id: true, workspaceId: true, deletedAt: true, content: true },
  });
  if (!source || source.deletedAt) return { error: "Page not found." };

  const access = await getWorkspaceAccess(user.id, source.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to edit this page." };
  }

  const target = await prisma.page.findUnique({
    where: { id: targetPageId },
    select: { id: true, title: true, workspaceId: true, deletedAt: true },
  });
  if (!target || target.deletedAt || target.workspaceId !== source.workspaceId) {
    return { error: "That page is not available to link." };
  }
  const title = target.title.trim();
  if (!title) return { error: "That page has no title to link." };

  const root = source.content as RichNode | null;
  if (!root || !Array.isArray(root.content)) {
    return { error: "That mention is no longer in the page." };
  }
  const doc = JSON.parse(JSON.stringify(root)) as RichNode;
  if (!linkFirstMention(doc.content as RichNode[], target.id, title)) {
    return { error: "That mention is no longer in the page." };
  }

  return updatePageAction(sourcePageId, { content: doc });
}
