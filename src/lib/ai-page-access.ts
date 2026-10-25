/**
 * Server-side page access for the Ask-AI block.
 *
 * The block lives inside a page, and the page content it asks about is
 * workspace content like any other: it may have been written by someone else
 * and it may be restricted. A client can send any `pageId`, and an Ask-AI
 * node's stored attributes can be edited by anyone who can edit the document,
 * so neither is trusted. This module loads the page by id and answers one
 * question before any content is read:
 *
 * - does the caller belong to the page's workspace?
 * - does the page exist and is it live?
 * - may the caller read *this* page (page-level permissions; a guest's read
 *   scope is the shared subtree, never its ancestors)?
 *
 * Only then does it derive the plain text the route grounds in. The route never
 * accepts a `context` string as page content when a `pageId` is present.
 */

import type { SharePermission } from "@prisma/client";
import { prisma } from "./db";
import { prosemirrorToText } from "./blocks";
import { getWorkspaceAccess } from "./permissions";
import { pageCapabilitiesFromRelation } from "./page-access";
import { guestReadablePageIds } from "./guest-access";

/** Hard cap matching the route's client-context cap (8k characters). */
export const AI_PAGE_CONTEXT_MAX_CHARS = 8000;

export type AiAccessiblePage = {
  id: string;
  workspaceId: string;
  title: string;
  content: unknown;
};

export type AiPageAccessResult =
  | { ok: true; page: AiAccessiblePage }
  | { ok: false; status: number; error: string };

/** The narrow page projection this module reads. */
type PageLookup = {
  id: string;
  workspaceId: string;
  title: string;
  content: unknown;
  deletedAt: Date | null;
  permissions: { level: SharePermission }[];
};

/**
 * Load a page the caller may read. A page id that does not exist, a deleted
 * page, and a page id paired with a different workspace all answer the same
 * way, so a forged id is not an existence oracle.
 */
export async function resolveAiPageForUser(
  userId: string,
  pageId: string,
  claimedWorkspaceId?: string | null,
): Promise<AiPageAccessResult> {
  if (typeof pageId !== "string" || pageId.trim() === "") {
    return { ok: false, status: 404, error: "Page not found." };
  }

  let page: PageLookup | null = null;
  try {
    page = (await prisma.page.findUnique({
      where: { id: pageId.trim() },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        content: true,
        deletedAt: true,
        permissions: { where: { userId }, select: { level: true }, take: 1 },
      },
    })) as PageLookup | null;
  } catch {
    // A read failure is treated like a missing page: no content is sent.
    page = null;
  }

  if (!page || page.deletedAt) {
    return { ok: false, status: 404, error: "Page not found." };
  }

  // The workspace id on the block's request is a hint, not the authority: the
  // page row names its own workspace. A mismatch is a forged/stale request and
  // is refused before the page's workspace provider is touched.
  const claimed = typeof claimedWorkspaceId === "string" ? claimedWorkspaceId.trim() : "";
  if (claimed !== "" && claimed !== page.workspaceId) {
    return { ok: false, status: 403, error: "That page does not belong to this workspace." };
  }

  const access = await getWorkspaceAccess(userId, page.workspaceId);
  if (!access) {
    return { ok: false, status: 403, error: "You do not have access to this page." };
  }

  if (!pageCapabilitiesFromRelation(access.role, page.permissions).read) {
    return { ok: false, status: 403, error: "You do not have access to this page." };
  }

  // A guest's display scope includes ancestors so the sidebar can draw a
  // breadcrumb; that does not make an ancestor readable. Use the read scope.
  if (access.role === "GUEST") {
    const readable = await guestReadablePageIds(userId, page.workspaceId);
    if (!readable.has(page.id)) {
      return { ok: false, status: 403, error: "You do not have access to this page." };
    }
  }

  return {
    ok: true,
    page: {
      id: page.id,
      workspaceId: page.workspaceId,
      title: page.title,
      content: page.content,
    },
  };
}

/**
 * The grounding text of a page: its title and body, capped like client context.
 * Title first so a summarizer knows what it is summarizing; the body is the
 * stored ProseMirror document folded to plain text.
 */
export function aiPageContextText(page: AiAccessiblePage): string {
  const title = typeof page.title === "string" ? page.title.trim() : "";
  const body = prosemirrorToText(page.content).trim();
  const text = [title ? `# ${title}` : "", body].filter((part) => part !== "").join("\n\n");
  return text.slice(0, AI_PAGE_CONTEXT_MAX_CHARS);
}
