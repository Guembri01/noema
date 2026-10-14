"use server";

import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { searchPages, searchPagesPaged } from "@/server/queries";

export type QuickFindResult = {
  id: string;
  title: string;
  icon: string | null;
  type: string;
  snippet: string;
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
    });
    return {
      ok: true,
      results: page.results.map((result) => ({
        id: result.id,
        title: result.title ?? "Untitled",
        icon: result.icon,
        type: result.type,
        snippet: result.snippet ?? "",
      })),
      nextOffset: page.nextOffset,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not load more results." };
  }
}
