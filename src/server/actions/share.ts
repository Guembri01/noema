"use server";

import { revalidatePath } from "next/cache";
import type { SharePermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/activity";
import { requireUser } from "@/lib/auth";
import { canPerformWorkspaceAction, getWorkspaceAccess } from "@/lib/permissions";
import { randomToken } from "@/lib/slug";
import { hashPassword, verifyPassword } from "@/lib/auth";

export type ShareOptions = {
  password?: string;
  expiresInDays?: number;
  /**
   * Edit vs read-only share. Explicit `true` grants EDIT; `false`/omitted is
   * READ, so a link is never editable unless the publisher asked for it.
   * On an existing link `undefined` leaves the current choice untouched.
   */
  allowEditing?: boolean;
  /**
   * Let viewers copy the published page. On an existing link `undefined`
   * leaves the current choice untouched.
   */
  allowDuplicate?: boolean;
  /**
   * Let search engines index the public page. On an existing link `undefined`
   * leaves the current choice untouched.
   */
  indexing?: boolean;
  /**
   * Disable exporting the published page. On an existing link `undefined`
   * leaves the current choice untouched.
   */
  exportRestricted?: boolean;
};

export type ShareLinkState = {
  published: boolean;
  token: string | null;
  allowEditing: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  allowDuplicate: boolean;
  indexing: boolean;
  exportRestricted: boolean;
};

/** Current share state of a page for the share panel (fail-closed for guests). */
export async function getShareLinkStateAction(pageId: string): Promise<ShareLinkState> {
  const empty: ShareLinkState = {
    published: false,
    token: null,
    allowEditing: false,
    hasPassword: false,
    expiresAt: null,
    allowDuplicate: false,
    indexing: true,
    exportRestricted: false,
  };
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true },
  });
  if (!page) return empty;
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) return empty;

  const link = await prisma.shareLink.findFirst({ where: { pageId } });
  if (!link) return empty;
  return {
    published: true,
    token: link.token,
    allowEditing: link.permission === "EDIT",
    hasPassword: Boolean(link.passwordHash),
    expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
    allowDuplicate: link.allowDuplicate,
    indexing: link.indexing,
    exportRestricted: link.exportRestricted,
  };
}

/** Publish a page to the web (idempotent) and return its public path. */
export async function createShareLinkAction(
  pageId: string,
  options: ShareOptions = {},
): Promise<{ url: string } | { error: string }> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) {
    return { error: "You do not have permission to share this page." };
  }

  const passwordHash = options.password ? await hashPassword(options.password) : undefined;
  const expiresAt =
    options.expiresInDays && options.expiresInDays > 0
      ? new Date(Date.now() + options.expiresInDays * 86_400_000)
      : undefined;
  const requested: SharePermission | undefined =
    options.allowEditing === undefined ? undefined : options.allowEditing ? "EDIT" : "READ";

  const existing = await prisma.shareLink.findFirst({ where: { pageId } });
  if (existing) {
    await prisma.shareLink.update({
      where: { id: existing.id },
      data: {
        passwordHash: passwordHash ?? existing.passwordHash,
        expiresAt: expiresAt ?? existing.expiresAt,
        permission: requested ?? existing.permission,
        allowDuplicate: options.allowDuplicate ?? existing.allowDuplicate,
        indexing: options.indexing ?? existing.indexing,
        exportRestricted: options.exportRestricted ?? existing.exportRestricted,
      },
    });
    revalidatePath("/w", "layout");
    return { url: `/s/${existing.token}` };
  }

  const link = await prisma.shareLink.create({
    data: {
      pageId,
      token: randomToken(24),
      permission: requested ?? "READ",
      ...(passwordHash ? { passwordHash } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(options.allowDuplicate !== undefined ? { allowDuplicate: options.allowDuplicate } : {}),
      ...(options.indexing !== undefined ? { indexing: options.indexing } : {}),
      ...(options.exportRestricted !== undefined
        ? { exportRestricted: options.exportRestricted }
        : {}),
    },
    select: { token: true },
  });
  await logActivity({ workspaceId: page.workspaceId, actorId: user.id, action: "page.shared", targetType: "page", targetId: pageId });
  revalidatePath("/w", "layout");
  return { url: `/s/${link.token}` };
}

/** Verify a share password and return the share row when valid. */
export async function verifySharePassword(
  token: string,
  password: string,
): Promise<boolean> {
  const link = await prisma.shareLink.findUnique({
    where: { token },
    select: { passwordHash: true },
  });
  if (!link?.passwordHash) return false;
  return verifyPassword(password, link.passwordHash);
}

/** Remove every public link for a page. */
export async function revokeShareLinkAction(
  pageId: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { workspaceId: true },
  });
  if (!page) return { error: "Page not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!canPerformWorkspaceAction(access?.role ?? null, "sharePage")) {
    return { error: "You do not have permission to change sharing." };
  }
  await prisma.shareLink.deleteMany({ where: { pageId } });
  await logActivity({ workspaceId: page.workspaceId, actorId: user.id, action: "page.unshared", targetType: "page", targetId: pageId });
  revalidatePath("/w", "layout");
  return { ok: true };
}
