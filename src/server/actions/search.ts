"use server";

import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { searchPages, searchPagesPaged } from "@/server/queries";
import type { SummaryBlock } from "@/lib/page-summary";

export type QuickFindResult = {
  id: string;
  title: string;
  icon: string | null;
  type: string;
  snippet: string;
  /**
   * Content-derived teaser blocks, when the caller has them. The search page
   * asks the query for these (via `includeBlocks`) so appended "Load more" rows
   * render the same real teaser as the initial window; the palette leaves it
   * unset and keeps using `snippet`.
   */
  blocks?: SummaryBlock[];
};

/**
 * Quick-find search (⌘K). Scoped for guests exactly like the search page, so the
 * palette can never surface a page the viewer may not open.
 */
export async function quickFindAction(
  workspaceId: string,
  query: string,
): Promise<QuickFindResult[] | { error: string }> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return { error: "Workspace not found." };
  if (!query.trim()) return [];

  const visiblePageIds = await pageScopeFor(user.id, workspaceId, access.role);
  const results = await searchPages(workspaceId, query, visiblePageIds, { take: 8 });
  return results.map((result) => ({
    id: result.id,
    title: result.title ?? "Untitled",
    icon: result.icon,
    type: result.type,
    snippet: result.snippet ?? "",
  }));
}

/** Next window of search results (the search page's "Load more"). */
export async function loadMoreSearchAction(input: {
  workspaceId: string;
  query: string;
  offset: number;
}): Promise<
  | { ok: true; results: QuickFindResult[]; nextOffset: number | null }
  | { error: string }
> {
  try {
    const user = await requireUser();
    const access = await getWorkspaceAccess(user.id, input.workspaceId);
    if (!access) return { error: "Workspace not found." };
    const visiblePageIds = await pageScopeFor(user.id, input.workspaceId, access.role);
    const page = await searchPagesPaged(input.workspaceId, input.query, visiblePageIds, {
      offset: input.offset,
      // Mirror the search page's initial window (`includeBlocks: true`) so the
      // next page carries the same content-derived teasers, not a bare snippet.
      includeBlocks: true,
    });
    return {
      ok: true,
      results: page.results.map((result) => ({
        id: result.id,
        title: result.title ?? "Untitled",
        icon: result.icon,
        type: result.type,
        snippet: result.snippet ?? "",
        blocks: result.blocks ?? [],
      })),
      nextOffset: page.nextOffset,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not load more results." };
  }
}
