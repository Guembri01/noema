import { prisma } from "@/lib/db";
import { authenticateScim } from "@/server/scim/auth";
import { parseScimPatch, scimError, scimUserResource } from "@/lib/scim/users";

export const runtime = "nodejs";

async function membership(context: { workspaceId: string }, userId: string) {
  return prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: context.workspaceId, userId } },
    select: {
      role: true,
      user: { select: { id: true, email: true, name: true } },
    },
  });
}

/** GET /api/scim/v2/Users/:id */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await authenticateScim(request);
  if (!context) return scimError(401, "A valid SCIM bearer token is required.");
  const { id } = await params;
  const row = await membership(context, id);
  if (!row) return scimError(404, "User not found.");
  return new Response(
    JSON.stringify(
      scimUserResource({
        id: row.user.id,
        email: row.user.email,
        name: row.user.name,
      }),
    ),
    { status: 200, headers: { "content-type": "application/scim+json" } },
  );
}

/** PATCH /api/scim/v2/Users/:id — `active` is the supported attribute. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await authenticateScim(request);
  if (!context) return scimError(401, "A valid SCIM bearer token is required.");
  const { id } = await params;
  const row = await membership(context, id);
  if (!row) return scimError(404, "User not found.");
  const patch = parseScimPatch(await request.json().catch(() => null));
  if (!patch || patch.active === undefined) {
    return scimError(400, "Only the active attribute can be patched.", "invalidValue");
  }
  if (patch.active === false) {
    if (row.role === "OWNER") {
      return scimError(409, "The workspace owner cannot be deactivated through SCIM.");
    }
    await prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: id } },
    });
  }
  return new Response(null, { status: 204 });
}

/** DELETE /api/scim/v2/Users/:id — deprovision by removing membership. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await authenticateScim(request);
  if (!context) return scimError(401, "A valid SCIM bearer token is required.");
  const { id } = await params;
  const row = await membership(context, id);
  if (!row) return scimError(404, "User not found.");
  if (row.role === "OWNER") {
    return scimError(409, "The workspace owner cannot be deprovisioned through SCIM.");
  }
  await prisma.workspaceMember.delete({
    where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: id } },
  });
  return new Response(null, { status: 204 });
}
