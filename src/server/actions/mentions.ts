"use server";

import { requireUser } from "@/lib/auth";
import { pageScopeFor } from "@/lib/guest-access";
import { scopeMentionSuggestions } from "@/lib/mentions";
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

  // B18 scoping: a guest may only ever be offered pages they can open, and
  // the workspace member directory is not exposed to them (the editor is
  // read-only for GUEST, but the action must not leak on its own either).
  const scope = await pageScopeFor(user.id, workspaceId, access.role);
  const isGuest = access.role === "GUEST";
  const q = query.trim();

  const [pages, members] = await Promise.all([
    prisma.page.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(scope ? { id: { in: [...scope] } } : {}),
        ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: { id: true, title: true, icon: true },
    }),
    (
      isGuest
        ? Promise.resolve([])
        : prisma.workspaceMember.findMany({
            where: {
              workspaceId,
              ...(q ? { user: { name: { contains: q, mode: "insensitive" } } } : {}),
            },
            take: 8,
            select: { user: { select: { id: true, name: true } } },
          })
    ) as Promise<{ user: { id: string; name: string } }[]>,
  ]);

  const suggestions: MentionSuggestion[] = [
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

  // Second layer of the same rule (the query above already filters): the
  // pure helper is what the unit tests pin down.
  return scopeMentionSuggestions(suggestions, scope);
}
