"use server";

import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";

export type MentionSuggestion = {
  id: string;
  label: string;
  type: "page" | "user";
  icon?: string | null;
};

/** Suggest pages and workspace members for the @-mention menu. */
export async function mentionSearchAction(
  workspaceId: string,
  query: string,
): Promise<MentionSuggestion[]> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return [];

  const q = query.trim();
  const [pages, members] = await Promise.all([
    prisma.page.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: { id: true, title: true, icon: true },
    }),
    prisma.workspaceMember.findMany({
      where: {
        workspaceId,
        ...(q ? { user: { name: { contains: q, mode: "insensitive" } } } : {}),
      },
      take: 8,
      select: { user: { select: { id: true, name: true } } },
    }),
  ]);

  return [
    ...pages.map((p) => ({
      id: p.id,
      label: p.title || "Untitled",
      type: "page" as const,
      icon: p.icon,
    })),
    ...members.map((m) => ({
      id: m.user.id,
      label: m.user.name,
      type: "user" as const,
    })),
  ];
}
