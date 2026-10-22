"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageCapabilitiesFromRelation } from "@/lib/page-access";
import { canEditSchema, type LockRole } from "@/lib/database-lock";
import { dispatchWebhooks } from "@/lib/webhooks";
import { pageSearchText } from "@/lib/search";
import { prosemirrorToText } from "@/lib/blocks";
import { restoreVersionSummary } from "@/lib/version-history";

export type Result<T = unknown> = ({ ok: true } & T) | { error: string };

/**
 * Reduce workspace access to the lock policy's role shape
 * (`src/lib/database-lock.ts`), mirroring `updatePageAction`'s content lock:
 * only the owner keeps the locked-page override so the lock stays releasable.
 */
function lockRoleFor(role: WorkspaceRole): LockRole {
  return {
    isOwner: role === "OWNER",
    isMember: role === "ADMIN" || role === "MEMBER",
  };
}

/**
 * Restore a past revision. The current state is pushed onto the history first,
 * so a restore is itself undoable; snapshot + page write commit in one
 * transaction (R30.2), and the FTS mirror is rewritten in the same update as
 * the content (R30.1) so the restored text is searchable immediately - the
 * non-collab half of D8 in docs/specs/realtime-collab.md.
 */
export async function restorePageVersionAction(versionId: string): Promise<Result> {
  const user = await requireUser();
  const version = await prisma.pageVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      title: true,
      content: true,
      createdAt: true,
      pageId: true,
      page: {
        select: {
          id: true,
          title: true,
          content: true,
          workspaceId: true,
          locked: true,
          permissions: {
            where: { userId: user.id },
            select: { level: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!version) return { error: "Version not found." };

  const access = await getWorkspaceAccess(user.id, version.page.workspaceId);
  if (!access) {
    return { error: "You do not have permission to restore this page." };
  }
  if (!pageCapabilitiesFromRelation(access.role, version.page.permissions).edit) {
    return { error: "You do not have permission to restore this page." };
  }

  // R15 (L4): the render-time `Page.locked` gate must
  // also hold on restore, or any editor can bypass the lock by restoring an old
  // revision (D6 in docs/specs/realtime-collab.md). Same policy as the q17
  // content-edit lock in `updatePageAction`: only the owner keeps the override.
  if (
    !canEditSchema({ locked: Boolean(version.page.locked) }, lockRoleFor(access.role))
  ) {
    return { error: "This page is locked. Unlock it to restore a version." };
  }

  const before = prosemirrorToText(version.page.content).length;
  const after = prosemirrorToText(version.content).length;

  // One transaction: pre-restore snapshot + page write (title, content, FTS
  // mirror). Content is written explicitly - `Prisma.DbNull` when the version
  // snapshotted an empty page, never omitted via `?? undefined` (R30.2).
  await prisma.$transaction([
    prisma.pageVersion.create({
      data: {
        pageId: version.pageId,
        title: version.page.title,
        content:
          version.page.content === null
            ? Prisma.DbNull
            : (version.page.content as Prisma.InputJsonValue),
        createdById: user.id,
        summary: restoreVersionSummary(version.createdAt),
        charDelta: after - before,
      },
    }),
    prisma.page.update({
      where: { id: version.pageId },
      data: {
        title: version.title.slice(0, 500),
        content:
          version.content === null
            ? Prisma.DbNull
            : (version.content as Prisma.InputJsonValue),
        // Same mirror formula as the save path (pageSearchText over the
        // restored title + content) - closes the searchText bypass (R30.1).
        searchText: pageSearchText(version.title, version.content),
      },
    }),
  ]);

  await dispatchWebhooks(version.page.workspaceId, "page.updated", {
    pageId: version.pageId,
  });
  revalidatePath("/w", "layout");
  return { ok: true };
}
