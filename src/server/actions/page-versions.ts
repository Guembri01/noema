"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { prosemirrorToText } from "@/lib/blocks";

export type Result<T = unknown> = ({ ok: true } & T) | { error: string };

/**
 * Restore a past revision. The current state is pushed onto the history first,
 * so a restore is itself undoable.
 */
export async function restorePageVersionAction(versionId: string): Promise<Result> {
  const user = await requireUser();
  const version = await prisma.pageVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      title: true,
      content: true,
      pageId: true,
      page: { select: { id: true, title: true, content: true, workspaceId: true } },
    },
  });
  if (!version) return { error: "Version not found." };

  const access = await getWorkspaceAccess(user.id, version.page.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to restore this page." };
  }

  const before = prosemirrorToText(version.page.content).length;
  await prisma.pageVersion.create({
    data: {
      pageId: version.pageId,
      title: version.page.title,
      content: (version.page.content ?? undefined) as Prisma.InputJsonValue,
      createdById: user.id,
      summary: `Restored the version from ${new Date(version.id ? Date.now() : 0).toLocaleDateString()}`,
      charDelta: 0,
    },
  });

  const after = prosemirrorToText(version.content).length;
  await prisma.page.update({
    where: { id: version.pageId },
    data: {
      title: version.title.slice(0, 500),
      content: (version.content ?? undefined) as Prisma.InputJsonValue,
    },
  });

  revalidatePath("/w", "layout");
  void before;
  void after;
  return { ok: true };
}
