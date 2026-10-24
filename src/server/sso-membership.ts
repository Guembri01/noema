/**
 * SAML workspace membership: one place for the owner-protection rule shared by
 * connection/env auto-join and verified-domain auto-join. An existing owner is
 * never demoted; every other row is set to the mapped member/admin role.
 */

import { prisma } from "@/lib/db";

export type SamlMembershipRole = "MEMBER" | "ADMIN" | "GUEST";

export async function ensureSamlMembership(
  workspaceId: string,
  userId: string,
  role: SamlMembershipRole,
): Promise<void> {
  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (existing?.role === "OWNER") return;
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId, role },
    update: { role },
  });
}
