"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import type { ImportCounts } from "@/lib/importers";
import {
  NOTION_PAGE_BLOCKS,
  notionBlocksToDoc,
  notionPageTitle,
  type NotionBlock,
} from "@/lib/notion-api";

const NOTION_VERSION = process.env.NOTION_VERSION ?? "2022-06-28";

function notionBase(): string {
  return (process.env.NOTION_API_BASE ?? "https://api.notion.com/v1").replace(/\/$/, "");
}

async function notionGet(path: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${notionBase()}${path}`, {
    headers: { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Notion rejected the integration token (401 Unauthorized).");
    }
    if (response.status === 404) {
      throw new Error(
        "That Notion page was not found. Make sure it is shared with your integration.",
      );
    }
    throw new Error(`Notion request failed (${response.status}).`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function listChildren(blockId: string, token: string): Promise<NotionBlock[]> {
  const results: NotionBlock[] = [];
  let cursor: string | null = null;
  do {
    const query = cursor
      ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
      : "?page_size=100";
    const data = await notionGet(`/blocks/${blockId}/children${query}`, token);
    const page = data.results as NotionBlock[] | undefined;
    if (Array.isArray(page)) results.push(...page);
    cursor = data.has_more ? String(data.next_cursor ?? "") : null;
  } while (cursor);
  return results;
}

/** Accept a raw id, a dashed uuid, or a Notion URL and return a dashed uuid. */
function normalizeId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hex = trimmed.replace(/-/g, "").match(/[0-9a-fA-F]{32}/);
  if (!hex) return trimmed.split("?")[0];
  const raw = hex[0].toLowerCase();
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export type NotionImportResult =
  | { ok: true; id: string; slug: string; pages: number; counts: ImportCounts }
  | { error: string };

/** Fetch-phase payload; every Notion read happens before any DB write. */
type FetchedPage = {
  blockId: string;
  parentBlockId: string | null;
  title: string;
  doc: ReturnType<typeof notionBlocksToDoc>;
};

/**
 * Import a Notion page (and its nested child pages) using a Notion integration
 * token. Requires the page to be shared with that integration in Notion.
 *
 * B71 / R23.6: two phases — fetch the whole subtree from the Notion API
 * first, then write it inside ONE `prisma.$transaction`, so a failure at any
 * point leaves exactly the rows the workspace had before. Child subtree
 * fetch failures are counted into `counts.failed` instead of being swallowed
 * silently (D23.3, honesty per D23.4). The depth cap (4) is unchanged.
 */
export async function importNotionPageAction(input: {
  workspaceId: string;
  parentId?: string | null;
  token: string;
  pageId: string;
}): Promise<NotionImportResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to import pages." };
  }

  const token = input.token.trim();
  if (!token) return { error: "A Notion integration token is required." };
  const rootId = normalizeId(input.pageId);
  if (!rootId) return { error: "A Notion page id or URL is required." };

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  let failed = 0;

  // Phase 1 — fetch (network only, no DB writes): pre-order so parents
  // always precede their children.
  const fetched: FetchedPage[] = [];

  const fetchOne = async (
    blockId: string,
    parentBlockId: string | null,
    depth: number,
  ): Promise<void> => {
    const pageData = await notionGet(`/pages/${blockId}`, token);
    const title = notionPageTitle(pageData.properties);
    const children = await listChildren(blockId, token);
    const doc = notionBlocksToDoc(children);
    fetched.push({ blockId, parentBlockId, title, doc });

    if (depth >= 4) return;
    for (const child of children) {
      if (!NOTION_PAGE_BLOCKS.includes(child.type)) continue;
      await fetchOne(child.id, blockId, depth + 1).catch(() => {
        failed += 1; // collected, not swallowed — surfaced via counts.failed
      });
    }
  };

  try {
    await fetchOne(rootId, null, 0);
  } catch (error) {
    // Pre-transaction failure: nothing was written — zero residue by
    // construction (R23.6).
    return {
      error: error instanceof Error && error.message ? error.message : "Notion import failed.",
    };
  }
  if (fetched.length === 0) return { error: "Nothing was imported." };

  // Phase 2 — one transaction for the whole tree (R23.6).
  let created = 0;
  let firstId = "";
  try {
    await prisma.$transaction(async (tx) => {
      const ids = new Map<string, string>();
      const nextPosition = async (parentId: string | null) => {
        const last = await tx.page.findFirst({
          where: { workspaceId: input.workspaceId, parentId },
          orderBy: { position: "desc" },
          select: { position: true },
        });
        return (last?.position ?? 0) + 1000;
      };

      for (const item of fetched) {
        const parentId =
          item.parentBlockId === null
            ? (input.parentId ?? null)
            : (ids.get(item.parentBlockId) ?? null);
        const page = await tx.page.create({
          data: {
            workspaceId: input.workspaceId,
            parentId,
            title: item.title.slice(0, 200),
            icon: "📥",
            createdById: user.id,
            position: await nextPosition(parentId),
            content: item.doc as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        ids.set(item.blockId, page.id);
        created += 1;
        if (!firstId) firstId = page.id;
      }
    });
  } catch (error) {
    // Rolled back — the workspace holds exactly the rows it had before (R23.6).
    return {
      error: error instanceof Error && error.message ? error.message : "Notion import failed.",
    };
  }

  if (created === 0) return { error: "Nothing was imported." };
  revalidatePath("/w", "layout");
  return {
    ok: true,
    id: firstId,
    slug: workspace.slug,
    pages: created,
    counts: { imported: created, skippedColumns: 0, skippedCells: 0, failed },
  };
}
