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
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { dispatchWebhooks } from "@/lib/webhooks";
import { pageSearchText } from "@/lib/search";
import { prosemirrorToText } from "@/lib/blocks";
import { formatWordStats } from "@/lib/actions-menu";

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
      page: { workspaceId: string; deletedAt: Date | null };
    }
  | { error: string };

async function loadPageForRead(pageId: string): Promise<ReadAccess> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true, deletedAt: true },
  });
  if (!page || page.deletedAt) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return { error: "No access." };
  return { ok: true, user, page };
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
  const { user, page } = loaded;

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
      where: { workspaceId: page.workspaceId, deletedAt: null },
      select: { id: true, parentId: true, title: true, icon: true, type: true },
    }),
  ]);
  if (!detail) return { error: "Page not found." };

  // Author names for the timeline (PageVersion has no user relation).
  const authorIds = [
    ...new Set(
      versions.map((version) => version.createdById).filter((id): id is string => Boolean(id)),
    ),
  ];
  const authors = authorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, name: true },
      })
    : [];
  const authorName = (id: string | null) =>
    id ? (authors.find((author) => author.id === id)?.name ?? null) : null;

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
      content: true,
      deletedAt: true,
      workspace: { select: { slug: true } },
    },
  });
  if (!source || source.deletedAt) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, source.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to duplicate this page." };
  }

  const last = await prisma.page.findFirst({
    where: { workspaceId: source.workspaceId, parentId: source.parentId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const created = await prisma.page.create({
    data: {
      workspaceId: source.workspaceId,
      parentId: source.parentId,
      teamspaceId: source.teamspaceId,
      projectId: source.projectId,
      type: source.type,
      title: source.title,
      icon: source.icon,
      coverUrl: source.coverUrl,
      fullWidth: source.fullWidth,
      smallText: source.smallText,
      font: source.font,
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
