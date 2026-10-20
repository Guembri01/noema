import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { canMembersAction } from "@/lib/workspace-role-map";
import { rateLimit } from "@/lib/api-guard";
import {
  bodyReadError,
  MAX_JSON_BODY_BYTES,
  readJsonBody,
} from "@/lib/body-limit";
import { listEmailDeliveries, sendWorkspaceInviteAction } from "@/server/actions/email";
import { inviteTeamspaceMemberAction } from "@/server/actions/teamspace-invites";

export const runtime = "nodejs";

/** List recent email deliveries for a workspace (admins only). */
export async function GET(request: Request) {
  const limited = rateLimit(request, "invites-read", 60, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
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
  const limited = rateLimit(request, "invites-write", 20, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    target?: string;
    workspaceId?: string;
    teamspaceId?: string;
    email?: string;
    role?: string;
  };
  try {
    body = await readJsonBody<typeof body>(request, MAX_JSON_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Invalid JSON body.");
  }

  if (body.target === "teamspace") {
    const result = await inviteTeamspaceMemberAction({
      teamspaceId: String(body.teamspaceId ?? ""),
      email: String(body.email ?? ""),
      role: body.role,
    });
    if ("error" in result) return NextResponse.json(result, { status: 400 });
    return NextResponse.json(result);
  }

  // The role policy is not decided here: the role an invitation carries is a
  // grant, so `sendWorkspaceInviteAction` applies the same rule as a role
  // change (`canGrantRole` in `@/lib/workspace-roles`) — only the workspace
  // owner may grant the admin role. The requested role is forwarded
  // unchanged, so the transport holds no role logic of its own: the action
  // answers "Unknown role." for anything outside `GUEST`/`MEMBER`/`ADMIN`,
  // and this route only surfaces the action's refusal as a 400.
  const result = await sendWorkspaceInviteAction({
    workspaceId: String(body.workspaceId ?? ""),
    email: String(body.email ?? ""),
    role: body.role,
  });
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
