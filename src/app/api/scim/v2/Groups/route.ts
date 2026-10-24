import { prisma } from "@/lib/db";
import { authenticateScim } from "@/server/scim/auth";
import { syncScimGroupRoles } from "@/server/scim/roles";
import {
  parseScimGroup,
  parseScimGroupPatch,
  scimGroupResource,
} from "@/lib/scim/groups";
import { scimError, scimList } from "@/lib/scim/users";

export const runtime = "nodejs";

function scimResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/scim+json", ...headers },
  });
}

async function validateMembers(workspaceId: string, userIds: string[]): Promise<boolean> {
  if (userIds.length === 0) return true;
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId, userId: { in: userIds } },
    select: { userId: true },
  });
  return rows.length === userIds.length;
}

/** GET /api/scim/v2/Groups — teamspaces as SCIM groups. */
export async function GET(request: Request) {
  const context = await authenticateScim(request);
  if (!context) return scimError(401, "A valid SCIM bearer token is required.");
  const groups = await prisma.teamspace.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      members: {
        select: { user: { select: { id: true, email: true } } },
      },
    },
  });
  const resources = groups.map((group) =>
    scimGroupResource({
      id: group.id,
      displayName: group.name,
      members: group.members.map((member) => member.user),
    }),
  );
  return scimResponse(scimList(resources, resources.length, 1));
}

/** POST /api/scim/v2/Groups — create a teamspace. */
export async function POST(request: Request) {
  const context = await authenticateScim(request);
  if (!context) return scimError(401, "A valid SCIM bearer token is required.");
  const parsed = parseScimGroup(await request.json().catch(() => null));
  if (!parsed) return scimError(400, "displayName is required.", "invalidValue");
  if (!(await validateMembers(context.workspaceId, parsed.userIds))) {
    return scimError(400, "Every member must belong to the workspace.", "invalidValue");
  }
  const group = await prisma.teamspace.create({
    data: {
      workspaceId: context.workspaceId,
      name: parsed.displayName,
      ...(parsed.userIds.length > 0
        ? { members: { create: parsed.userIds.map((userId) => ({ userId, role: "MEMBER" })) } }
        : {}),
    },
    select: {
      id: true,
      name: true,
      members: { select: { user: { select: { id: true, email: true } } } },
    },
  });
  await syncScimGroupRoles(context.workspaceId, context.connectionId, parsed.userIds);
  return scimResponse(
    scimGroupResource({
      id: group.id,
      displayName: group.name,
      members: group.members.map((member) => member.user),
    }),
    201,
    { location: `/api/scim/v2/Groups/${group.id}` },
  );
}
