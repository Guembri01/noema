import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { canMembersAction } from "@/lib/workspace-role-map";
import { rateLimit } from "@/lib/api-guard";
import { listEmailDeliveries, sendWorkspaceInviteAction } from "@/server/actions/email";
import { inviteTeamspaceMemberAction } from "@/server/actions/teamspace-invites";

export const runtime = "nodejs";

/** List recent email deliveries for a workspace (admins only). */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  const limited = rateLimit(request, "invites-read", 60, 60_000, { userId: user?.id });
  if (limited) return limited;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  // The listing is the workspace's invitation log — every address it ever
  // invited — so it is admin-only, exactly as the doc comment says. The role
  // comes from the enforcement matrix (`inviteMember` → owner/admin), asked
  // through the persisted→engine bridge, and an unknown role fails closed.
  if (!canMembersAction(access.role, "inviteMember")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ deliveries: await listEmailDeliveries(workspaceId, 25) });
}

/**
 * Send an invitation. Body:
 *   { target: "workspace", workspaceId, email, role?: "GUEST" | "MEMBER" | "ADMIN" }
 *   { target: "teamspace", teamspaceId, email, role?: "MEMBER" | "ADMIN" }
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  const limited = rateLimit(request, "invites-write", 20, 60_000, { userId: user?.id });
  if (limited) return limited;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    target?: string;
    workspaceId?: string;
    teamspaceId?: string;
    email?: string;
    role?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.target === "teamspace") {
    const result = await inviteTeamspaceMemberAction({
      teamspaceId: String(body.teamspaceId ?? ""),
      email: String(body.email ?? ""),
      role: body.role === "ADMIN" ? "ADMIN" : "MEMBER",
    });
    if ("error" in result) return NextResponse.json(result, { status: 400 });
    return NextResponse.json(result);
  }

  // The role policy is not decided here: the role an invitation carries is a
  // grant, so `sendWorkspaceInviteAction` applies the same rule as a role
  // change (`canGrantRole` in `@/lib/workspace-roles`) — only the workspace
  // owner may grant the admin role. This route only translates the request and
  // surfaces the action's refusal.
  const role = body.role === "GUEST" ? "GUEST" : body.role === "ADMIN" ? "ADMIN" : "MEMBER";
  const result = await sendWorkspaceInviteAction({
    workspaceId: String(body.workspaceId ?? ""),
    email: String(body.email ?? ""),
    role,
  });
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
