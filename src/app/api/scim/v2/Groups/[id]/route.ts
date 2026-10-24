import { prisma } from "@/lib/db";
import { authenticateScim } from "@/server/scim/auth";
import { syncScimGroupRoles } from "@/server/scim/roles";
import { parseScimGroupPatch, scimGroupResource } from "@/lib/scim/groups";
import { scimError } from "@/lib/scim/users";

export const runtime = "nodejs";

async function group(workspaceId: string, id: string) {
  return prisma.teamspace.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      name: true,
      members: { select: { user: { select: { id: true, email: true } } } },
    },
  });
}

async function allMembers(workspaceId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId, userId: { in: ids } },
    select: { userId: true },
  });
  return rows.length === ids.length;
}

/** GET /api/scim/v2/Groups/:id */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await authenticateScim(request);
  if (!context) return scimError(401, "A valid SCIM bearer token is required.");
  const { id } = await params;
  const row = await group(context.workspaceId, id);
  if (!row) return scimError(404, "Group not found.");
  return new Response(
    JSON.stringify(
      scimGroupResource({
        id: row.id,
        displayName: row.name,
        members: row.members.map((member) => member.user),
      }),
    ),
    { status: 200, headers: { "content-type": "application/scim+json" } },
  );
}

/** PATCH /api/scim/v2/Groups/:id — add/remove/replace members. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await authenticateScim(request);
  if (!context) return scimError(401, "A valid SCIM bearer token is required.");
  const { id } = await params;
  const row = await group(context.workspaceId, id);
  if (!row) return scimError(404, "Group not found.");
  const patches = parseScimGroupPatch(await request.json().catch(() => null));
  if (!patches) return scimError(400, "No supported member operation was supplied.", "invalidValue");

  const candidates = patches
    .filter((patch) => patch.op !== "remove")
    .flatMap((patch) => patch.userIds);
  if (!(await allMembers(context.workspaceId, candidates))) {
    return scimError(400, "Every member must belong to the workspace.", "invalidValue");
  }

  const affected = new Set(row.members.map((member) => member.user.id));
  for (const patch of patches) {
    for (const userId of patch.userIds) affected.add(userId);
    if (patch.op === "replace") {
      await prisma.$transaction([
        prisma.teamspaceMember.deleteMany({ where: { teamspaceId: id } }),
        ...(patch.userIds.length > 0
          ? [
              prisma.teamspaceMember.createMany({
                data: patch.userIds.map((userId) => ({ teamspaceId: id, userId, role: "MEMBER" })),
                skipDuplicates: true,
              }),
            ]
          : []),
      ]);
    } else if (patch.op === "add") {
      await prisma.teamspaceMember.createMany({
        data: patch.userIds.map((userId) => ({ teamspaceId: id, userId, role: "MEMBER" })),
        skipDuplicates: true,
      });
    } else {
      await prisma.teamspaceMember.deleteMany({
        where: { teamspaceId: id, userId: { in: patch.userIds } },
      });
    }
  }
  await syncScimGroupRoles(context.workspaceId, context.connectionId, [...affected]);
  return new Response(null, { status: 204 });
}

/** DELETE /api/scim/v2/Groups/:id — delete the teamspace. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await authenticateScim(request);
  if (!context) return scimError(401, "A valid SCIM bearer token is required.");
  const { id } = await params;
  const row = await group(context.workspaceId, id);
  if (!row) return scimError(404, "Group not found.");
  const affected = row.members.map((member) => member.user.id);
  await prisma.teamspace.delete({ where: { id } });
  await syncScimGroupRoles(context.workspaceId, context.connectionId, affected);
  return new Response(null, { status: 204 });
}
