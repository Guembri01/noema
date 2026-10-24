import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/slug";
import { authenticateScim } from "@/server/scim/auth";
import {
  parseScimUser,
  scimError,
  scimList,
  scimUserResource,
} from "@/lib/scim/users";

export const runtime = "nodejs";

function scimResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/scim+json", ...headers },
  });
}

function pageParams(request: Request): { startIndex: number; count: number } {
  const url = new URL(request.url);
  const startIndex = Math.max(1, Number(url.searchParams.get("startIndex") ?? "1") || 1);
  const count = Math.min(100, Math.max(1, Number(url.searchParams.get("count") ?? "100") || 100));
  return { startIndex, count };
}

/** GET /api/scim/v2/Users — list workspace members as SCIM users. */
export async function GET(request: Request) {
  const context = await authenticateScim(request);
  if (!context) return scimError(401, "A valid SCIM bearer token is required.");
  const { startIndex, count } = pageParams(request);
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: context.workspaceId },
    select: { user: { select: { id: true, email: true, name: true } } },
  });
  const sorted = members
    .map((member) => member.user)
    .sort((a, b) => a.email.localeCompare(b.email));
  const page = sorted.slice(startIndex - 1, startIndex - 1 + count);
  return scimResponse(
    scimList(
      page.map((user) =>
        scimUserResource({ id: user.id, email: user.email, name: user.name }),
      ),
      sorted.length,
      startIndex,
    ),
  );
}

/** POST /api/scim/v2/Users — provision a user and workspace membership. */
export async function POST(request: Request) {
  const context = await authenticateScim(request);
  if (!context) return scimError(401, "A valid SCIM bearer token is required.");
  const parsed = parseScimUser(await request.json().catch(() => null));
  if (!parsed) return scimError(400, "userName or a primary email is required.", "invalidValue");

  const existing = await prisma.user.findUnique({
    where: { email: parsed.email },
    select: { id: true, email: true, name: true },
  });
  const user =
    existing ??
    (await prisma.user.create({
      data: {
        email: parsed.email,
        name: parsed.name,
        passwordHash: `sso:${randomToken(24)}`,
        emailVerified: true,
      },
      select: { id: true, email: true, name: true },
    }));

  try {
    await prisma.workspaceMember.create({
      data: { workspaceId: context.workspaceId, userId: user.id, role: "MEMBER" },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002") {
      return scimError(409, "That user is already a member of this workspace.", "uniqueness");
    }
    throw error;
  }
  const resource = scimUserResource({
    id: user.id,
    email: user.email,
    name: user.name,
    active: parsed.active,
  });
  return scimResponse(resource, 201, {
    location: `/api/scim/v2/Users/${user.id}`,
  });
}
