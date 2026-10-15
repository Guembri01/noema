"use server";

/**
 * K07 — "Duplicate" from the sidebar page tree.
 *
 * The topbar's `duplicatePageAction` (`page-menu.ts`) clones a single row. This
 * action copies the whole *subtree*: the pure planner in `@/lib/page-duplicate`
 * walks the descendants, hands every copy a fresh id, a remapped `parentId` and
 * a suffixed title, and this action persists that plan inside one
 * `prisma.$transaction` so a failure leaves no half-copied branch. Permission
 * mirrors the other page mutations (`requireUser` + `canEditContent`), the copy
 * root lands as a sibling of the source, and the caller gets back the new root
 * id + workspace slug so it can navigate straight to the copy.
 */
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { dispatchWebhooks } from "@/lib/webhooks";
import { pageSearchText } from "@/lib/search";
import {
  planPageDuplicate,
  validatePageDuplicate,
  type PageNode,
} from "@/lib/page-duplicate";

type Result<T = unknown> = ({ ok: true } & T) | { error: string };

/**
 * The fields a copied page carries over from its source. Intersecting with
 * `PageNode` keeps the planner's index signature while pinning the columns we
 * read back, so the write path stays fully typed (no `any`).
 */
type DuplicateSourceRow = PageNode & {
  parentId: string | null;
  title: string;
  type: "PAGE" | "DATABASE";
  icon: string | null;
  coverUrl: string | null;
  fullWidth: boolean;
  smallText: boolean;
  font: string;
  lineSpacing: string;
  locked: boolean;
  teamspaceId: string | null;
  projectId: string | null;
  content: Prisma.JsonValue | null;
  position: number;
};

/**
 * Order copies so every parent row is created before its children (the
 * `Page.parent` self-FK): start at the copy root and walk the copied `parentId`
 * links breadth-first. A well-formed plan has exactly one root; anything left
 * unreachable is appended as-is so a malformed row still surfaces as a clear
 * validation error instead of silently going missing.
 */
function orderParentFirst(pages: readonly PageNode[]): PageNode[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const children = new Map<string, PageNode[]>();
  const roots: PageNode[] = [];
  for (const page of pages) {
    const parent = page.parentId;
    if (parent && byId.has(parent)) {
      const bucket = children.get(parent) ?? [];
      bucket.push(page);
      children.set(parent, bucket);
    } else {
      roots.push(page);
    }
  }
  const ordered: PageNode[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const page = queue.shift()!;
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    ordered.push(page);
    for (const child of children.get(page.id) ?? []) queue.push(child);
  }
  for (const page of pages) if (!seen.has(page.id)) ordered.push(page);
  return ordered;
}

/** Duplicate a page and its whole subtree, as a sibling of the source. */
export async function duplicatePageSubtreeAction(
  pageId: string,
): Promise<Result<{ id: string; slug: string; count: number }>> {
  const user = await requireUser();
  const source = await prisma.page.findUnique({
    where: { id: pageId },
    select: {
      workspaceId: true,
      parentId: true,
      deletedAt: true,
      workspace: { select: { slug: true } },
    },
  });
  if (!source || source.deletedAt) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, source.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to duplicate this page." };
  }

  // Every live page in the workspace: the planner needs the flat list to find
  // the subtree, and each copy carries its source row's settings over. Trashed
  // pages are excluded so a copy never resurrects a deleted branch.
  const rows: DuplicateSourceRow[] = await prisma.page.findMany({
    where: { workspaceId: source.workspaceId, deletedAt: null },
    select: {
      id: true,
      parentId: true,
      title: true,
      type: true,
      icon: true,
      coverUrl: true,
      fullWidth: true,
      smallText: true,
      font: true,
      lineSpacing: true,
      locked: true,
      teamspaceId: true,
      projectId: true,
      content: true,
      position: true,
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });

  const plan = planPageDuplicate(rows, pageId);
  const validation = validatePageDuplicate(rows, plan);
  if (plan.pages.length === 0 || !validation.ok) {
    return { error: "Could not plan the page copy." };
  }
  const rootId = plan.idMap.get(pageId);
  if (!rootId) return { error: "Could not plan the page copy." };

  const sourceById = new Map(rows.map((row) => [row.id, row]));
  const originalIdByCopyId = new Map<string, string>();
  for (const [oldId, newId] of plan.idMap) originalIdByCopyId.set(newId, oldId);

  // The copy root sits after the last current sibling; descendants keep their
  // source position, which preserves each copied sibling group's order.
  const lastSibling = await prisma.page.findFirst({
    where: { workspaceId: source.workspaceId, parentId: source.parentId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const rootPosition = (lastSibling?.position ?? 0) + 1000;

  try {
    await prisma.$transaction(async (tx) => {
      for (const copy of orderParentFirst(plan.pages)) {
        const originalId = originalIdByCopyId.get(copy.id);
        const origin = originalId ? sourceById.get(originalId) : undefined;
        if (!origin) throw new Error(`missing source row for ${copy.id}`);
        await tx.page.create({
          data: {
            id: copy.id,
            workspaceId: source.workspaceId,
            parentId: copy.parentId ?? null,
            teamspaceId: origin.teamspaceId,
            projectId: origin.projectId,
            type: origin.type,
            title: copy.title ?? "",
            icon: origin.icon,
            coverUrl: origin.coverUrl,
            fullWidth: origin.fullWidth,
            smallText: origin.smallText,
            font: origin.font,
            lineSpacing: origin.lineSpacing,
            locked: origin.locked,
            content: (origin.content ?? undefined) as Prisma.InputJsonValue | undefined,
            createdById: user.id,
            position: copy.id === rootId ? rootPosition : origin.position,
            searchText: pageSearchText(copy.title ?? "", origin.content),
          },
        });
      }
    });
  } catch (error) {
    console.error("duplicate page subtree failed", error);
    return { error: "Could not duplicate this page." };
  }

  await dispatchWebhooks(source.workspaceId, "page.created", {
    pageId: rootId,
    type: sourceById.get(pageId)?.type ?? "PAGE",
    duplicated: plan.pages.length,
  });
  revalidatePath("/w", "layout");
  return {
    ok: true,
    id: rootId,
    slug: source.workspace.slug,
    count: plan.pages.length,
  };
}
