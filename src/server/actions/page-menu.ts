"use server";

/**
 * B11 — data + mutations behind the topbar Actions (⋯) menu.
 *
 * Three actions, all permission-checked:
 *  - getPageEditedAction   → the relative "Edited … ago" topbar label
 *  - getPageMenuDataAction → footer stats, version timeline, connections and
 *                            Move-to targets, loaded when the menu opens
 *  - duplicatePageAction    → page-level Duplicate (Ctrl+D)
 *
 * The per-page "Notify me" level has no server-side data model yet; the menu
 * persists it per page in localStorage (recorded as a partial in the matrix).
 */
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import { pageCapabilitiesFromRelation } from "@/lib/page-access";
import { dispatchWebhooks } from "@/lib/webhooks";
import { pageSearchText } from "@/lib/search";
import { prosemirrorToText } from "@/lib/blocks";
import { assertEditableParent } from "@/lib/page-parent";
import { formatWordStats } from "@/lib/actions-menu";
import { loadVersionAuthors } from "@/server/version-authors";

type Result<T = unknown> = ({ ok: true } & T) | { error: string };

export type PageEditedInfo = {
  updatedAt: string;
  lastEditedBy: string | null;
};

export type PageMenuVersion = {
  id: string;
  title: string;
  summary: string | null;
  charDelta: number | null;
  createdAt: string;
  authorName: string | null;
};

export type PageMenuConnection = {
  id: string;
  label: string;
  detail: string | null;
  kind: "oauth" | "webhook";
};

export type PageMenuData = PageEditedInfo & {
  stats: { words: number; chars: number; reading: string };
  versions: PageMenuVersion[];
  connections: PageMenuConnection[];
  moveTargets: { id: string; title: string; icon: string | null }[];
};

type ReadAccess =
  | {
      ok: true;
      user: Awaited<ReturnType<typeof requireUser>>;
      page: { id: string; workspaceId: string; deletedAt: Date | null };
      /** The caller's page scope: `null` = the whole workspace. */
      visiblePageIds: Set<string> | null;
    }
  | { error: string };

/**
 * Load a page for a read, honouring the guest page scope: a page outside the
 * caller's scope is refused exactly like the page route (404 / "Page not
 * found."), so the menu cannot describe a page the caller may not open.
 */
async function loadPageForRead(pageId: string): Promise<ReadAccess> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, workspaceId: true, deletedAt: true },
  });
  if (!page || page.deletedAt) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return { error: "No access." };
  const visiblePageIds = await pageScopeFor(user.id, page.workspaceId, access.role);
  if (visiblePageIds && !visiblePageIds.has(page.id)) {
    return { error: "Page not found." };
  }
  return { ok: true, user, page, visiblePageIds };
}

/** Relative topbar label: last edited timestamp + author name. */
export async function getPageEditedAction(
  pageId: string,
): Promise<Result<PageEditedInfo>> {
  const loaded = await loadPageForRead(pageId);
  if ("error" in loaded) return loaded;
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: {
      updatedAt: true,
      createdBy: { select: { name: true } },
      versions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdById: true },
      },
    },
  });
  if (!page) return { error: "Page not found." };
  const editorId = page.versions[0]?.createdById ?? null;
  let lastEditedBy = page.createdBy.name;
  if (editorId && editorId !== undefined) {
    const editor = await prisma.user.findUnique({
      where: { id: editorId },
      select: { name: true },
    });
    if (editor) lastEditedBy = editor.name;
  }
  return {
    ok: true,
    updatedAt: page.updatedAt.toISOString(),
    lastEditedBy,
  };
}

/** Everything the open menu needs: stats, timeline, connections, move targets. */
export async function getPageMenuDataAction(
  pageId: string,
): Promise<Result<PageMenuData>> {
  const loaded = await loadPageForRead(pageId);
  if ("error" in loaded) return loaded;
  const { user, page, visiblePageIds } = loaded;

  const [detail, versions, webhooks, oauthApps, allPages] = await Promise.all([
    prisma.page.findUnique({
      where: { id: pageId },
      select: {
        content: true,
        updatedAt: true,
        createdBy: { select: { name: true } },
      },
    }),
    prisma.pageVersion.findMany({
      where: { pageId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        title: true,
        summary: true,
        charDelta: true,
        createdAt: true,
        createdById: true,
      },
    }),
    prisma.webhook.findMany({
      where: { workspaceId: page.workspaceId },
      select: { id: true, url: true, events: true, active: true },
    }),
    prisma.oAuthApp.findMany({
      where: { userId: user.id },
      select: { id: true, name: true },
    }),
    prisma.page.findMany({
      // The move targets are a page list, so they carry the guest scope: a
      // guest never receives the title of a page they may not open.
      where: {
        workspaceId: page.workspaceId,
        deletedAt: null,
        ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
      },
      select: { id: true, parentId: true, title: true, icon: true, type: true },
    }),
  ]);
  if (!detail) return { error: "Page not found." };

  // One shared authorship resolver for both history surfaces (R30.11 of
  // docs/specs/version-history-v2.md): User-row lookup by createdById,
  // membership-independent, so the timeline agrees with the page panel.
  const resolveVersionAuthor = await loadVersionAuthors(
    versions.map((version) => version.createdById),
  );
  const authorName = (id: string | null) => resolveVersionAuthor(id)?.name ?? null;

  const latestAuthorId = versions[0]?.createdById ?? null;
  const lastEditedBy =
    authorName(latestAuthorId) ?? detail.createdBy.name ?? null;

  // Move-to targets: every page except this one and its own descendants.
  const childrenOf = new Map<string, string[]>();
  for (const candidate of allPages) {
    if (!candidate.parentId) continue;
    const bucket = childrenOf.get(candidate.parentId) ?? [];
    bucket.push(candidate.id);
    childrenOf.set(candidate.parentId, bucket);
  }
  const excluded = new Set<string>([pageId]);
  const stack: string[] = [pageId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of childrenOf.get(current) ?? []) {
      if (excluded.has(child)) continue;
      excluded.add(child);
      stack.push(child);
    }
  }
  const moveTargets = allPages
    .filter((candidate) => !excluded.has(candidate.id) && candidate.type === "PAGE")
    .slice(0, 30)
    .map((candidate) => ({
      id: candidate.id,
      title: candidate.title || "Untitled",
      icon: candidate.icon,
    }));

  const connections: PageMenuConnection[] = [
    ...oauthApps.map((app) => ({
      id: `oauth-${app.id}`,
      label: app.name,
      detail: "OAuth app",
      kind: "oauth" as const,
    })),
    ...webhooks.map((hook) => ({
      id: `webhook-${hook.id}`,
      label: hook.url,
      detail: hook.events.join(", ") || (hook.active ? "active" : "paused"),
      kind: "webhook" as const,
    })),
  ];

  return {
    ok: true,
    updatedAt: detail.updatedAt.toISOString(),
    lastEditedBy,
    stats: formatWordStats(prosemirrorToText(detail.content)),
    versions: versions.map((version) => ({
      id: version.id,
      title: version.title,
      summary: version.summary,
      charDelta: version.charDelta,
      createdAt: version.createdAt.toISOString(),
      authorName: authorName(version.createdById),
    })),
    connections,
    moveTargets,
  };
}

/** Page-level Duplicate (Ctrl+D): a sibling with the same content. */
export async function duplicatePageAction(
  pageId: string,
): Promise<Result<{ id: string; slug: string }>> {
  const user = await requireUser();
  const source = await prisma.page.findUnique({
    where: { id: pageId },
    select: {
      workspaceId: true,
      parentId: true,
      teamspaceId: true,
      projectId: true,
      type: true,
      title: true,
      icon: true,
      coverUrl: true,
      fullWidth: true,
      smallText: true,
      font: true,
      lineSpacing: true,
      locked: true,
      schemaLocked: true,
      content: true,
      deletedAt: true,
      permissions: {
        where: { userId: user.id },
        select: { level: true },
        take: 1,
      },
      workspace: { select: { slug: true } },
    },
  });
  if (!source || source.deletedAt) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, source.workspaceId);
  if (!access) {
    return { error: "You do not have permission to duplicate this page." };
  }
  if (!pageCapabilitiesFromRelation(access.role, source.permissions).edit) {
    return { error: "You do not have permission to duplicate this page." };
  }

  // The copy becomes a sibling of the source, so it keeps the source's own
  // parent. The parent must be in this workspace (B08) and editable by the
  // caller (a READ/COMMENT parent must not become a writable branch).
  const parent = await assertEditableParent({
    workspaceId: source.workspaceId,
    parentId: source.parentId,
    userId: user.id,
    role: access.role,
  });
  if ("error" in parent) return parent;

  const last = await prisma.page.findFirst({
    where: { workspaceId: source.workspaceId, parentId: parent.parentId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const created = await prisma.page.create({
    data: {
      workspaceId: source.workspaceId,
      parentId: parent.parentId,
      teamspaceId: source.teamspaceId,
      projectId: source.projectId,
      type: source.type,
      title: source.title,
      icon: source.icon,
      coverUrl: source.coverUrl,
      fullWidth: source.fullWidth,
      smallText: source.smallText,
      font: source.font,
      lineSpacing: source.lineSpacing,
      // A locked page keeps its lock on the copy; the request that asked for
      // the duplicate already passed the edit check on the source.
      locked: source.locked,
      schemaLocked: source.schemaLocked,
      content: (source.content ?? undefined) as Prisma.InputJsonValue | undefined,
      createdById: user.id,
      position: (last?.position ?? 0) + 1000,
      searchText: pageSearchText(source.title, source.content),
    },
    select: { id: true },
  });

  await dispatchWebhooks(source.workspaceId, "page.created", {
    pageId: created.id,
    type: source.type,
  });
  revalidatePath("/w", "layout");
  return { ok: true, id: created.id, slug: source.workspace.slug };
}
