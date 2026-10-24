/**
 * SCIM group → workspace role sync (R10.20).
 *
 * The connection's `roleRules` are the same `group:ROLE` rules used by SAML
 * login. A teamspace name is the group name; after a SCIM group change we
 * recompute each affected workspace member's role from all teamspaces they
 * belong to. `ADMIN` wins over `MEMBER`; the workspace OWNER is never changed.
 */

import { prisma } from "@/lib/db";
import { mapSamlGroupsToRole, parseSamlRoleRules } from "@/lib/sso/saml";

export async function syncScimGroupRoles(
  workspaceId: string,
  connectionId: string,
  userIds: readonly string[],
): Promise<void> {
  const uniqueUsers = [...new Set(userIds)].filter(Boolean);
  if (uniqueUsers.length === 0) return;

  const connection = await prisma.ssoConnection.findFirst({
    where: { id: connectionId, workspaceId },
    select: { roleRules: true },
  });
  if (!connection) return;
  const parsed = parseSamlRoleRules(
    connection.roleRules === null || connection.roleRules === undefined
      ? ""
      : JSON.stringify(connection.roleRules),
  );
  if (!parsed.ok || parsed.rules.length === 0) return;

  const teamspaces = await prisma.teamspace.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
  });
  const byId = new Map(teamspaces.map((teamspace) => [teamspace.id, teamspace.name]));
  const memberships = await prisma.teamspaceMember.findMany({
    where: { userId: { in: uniqueUsers }, teamspaceId: { in: [...byId.keys()] } },
    select: { userId: true, teamspaceId: true },
  });
  const groupsByUser = new Map<string, string[]>();
  for (const membership of memberships) {
    const name = byId.get(membership.teamspaceId);
    if (!name) continue;
    const groups = groupsByUser.get(membership.userId) ?? [];
    groups.push(name);
    groupsByUser.set(membership.userId, groups);
  }

  for (const userId of uniqueUsers) {
    const role = mapSamlGroupsToRole(parsed.rules, groupsByUser.get(userId) ?? []);
    // The owner is never demoted by a directory group.
    await prisma.workspaceMember.updateMany({
      where: { workspaceId, userId, role: { not: "OWNER" } },
      data: { role },
    });
  }
}
