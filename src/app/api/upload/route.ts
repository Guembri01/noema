import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/slug";
import { rateLimit } from "@/lib/api-guard";
import { storageDriver } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_TYPES = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"],
  ["image/avif", ".avif"],
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
  ["text/markdown", ".md"],
  ["application/json", ".json"],
  ["application/zip", ".zip"],
]);

/**
 * File upload. Validates auth + workspace access, type and size, hands the
 * bytes to the configured storage driver (filesystem by default, S3-compatible
 * when `S3_BUCKET` is set), records an Asset, and returns the serving URL.
 */
export async function POST(request: Request) {
  const limited = rateLimit(request, "upload", 60, 60_000);
  if (limited) return limited;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const workspaceId = String(form.get("workspaceId") ?? "");
  const file = form.get("file");
  if (!workspaceId || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing file or workspaceId" }, { status: 400 });
  }

  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || access.role === "GUEST") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 10 MB)" }, { status: 413 });
  }

  const extension = ALLOWED_TYPES.get(file.type);
  if (!extension) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type || "unknown"}` },
      { status: 415 },
    );
  }

  const storedName = `${randomToken(12)}${extension}`;
  const driver = storageDriver();
  try {
    await driver.put(
      `${workspaceId}/${storedName}`,
      new Uint8Array(await file.arrayBuffer()),
      file.type,
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Storage failed" },
      { status: 502 },
    );
  }

  const url = `/api/files/${workspaceId}/${storedName}`;
  await prisma.asset.create({
    data: {
      name: file.name || storedName,
      url,
      mimeType: file.type,
      size: file.size,
    },
  });

  return NextResponse.json({
    url,
    name: file.name || storedName,
    mimeType: file.type,
    size: file.size,
  });
}
