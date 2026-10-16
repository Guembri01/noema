import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import { getWorkspaceBySlug } from "@/server/queries";
import { getAuditRecords } from "@/server/audit-engine-data";
import { redactEvent, toCsv } from "@/lib/audit-log-engine";
import { isAuditAdmin, parseAuditQuery, selectAuditEvents } from "@/lib/audit-engine-query";

export const runtime = "nodejs";

/**
 * CSV export for the workspace audit page — the exact filtered set the page
 * describes, ordered the same way, rendered by the engine's RFC-4180 `toCsv`.
 *
 * Auth + role gated: 401 unauthenticated, 403 for a caller below manager, and
 * each row is passed through `redactEvent` so a manager downloads the trail
 * without the sensitive `ip`/`meta` columns while the owner gets them.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { slug } = await params;
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access || !canManageMembers(access.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const query = parseAuditQuery(Object.fromEntries(new URL(request.url).searchParams));
  const records = await getAuditRecords(workspace.id, query.filter);
  const events = selectAuditEvents(records, query);

  const admin = isAuditAdmin(access.role);
  const csv = toCsv(events.map((event) => redactEvent(event, admin)));

  const safeSlug = slug.replace(/[^\w.-]+/g, "-").slice(0, 60) || "workspace";
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="audit-${safeSlug}.csv"`,
    },
  });
}
