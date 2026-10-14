import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { contentTypeFor, isValidAssetKey, storageDriver } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * Serve an uploaded asset from the storage driver (local disk or S3-compatible).
 * The file is streamed only to members of the owning workspace, and the path
 * segments are validated to prevent traversal.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  if (!segments || segments.length !== 2) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [workspaceId, name] = segments;
  if (
    !/^[A-Za-z0-9_-]+$/.test(workspaceId) ||
    !/^[A-Za-z0-9._-]+$/.test(name) ||
    name.includes("..")
  ) {
    return NextResponse.json({ error: "Bad path" }, { status: 400 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const key = `${workspaceId}/${name}`;
  if (!isValidAssetKey(key)) {
    return NextResponse.json({ error: "Bad path" }, { status: 400 });
  }

  try {
    const stored = await storageDriver().get(key);
    if (!stored) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return new NextResponse(new Uint8Array(stored.body), {
      headers: {
        "content-type": stored.contentType || contentTypeFor(name),
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
