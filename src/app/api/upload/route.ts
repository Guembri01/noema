import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/slug";
import { rateLimit } from "@/lib/api-guard";
import { storageDriver } from "@/lib/storage";
import { extForMime, fileNameExt, isAllowedType, mimeForExt } from "@/lib/file-type";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * MIME types the uploader accepts. Kept as an allow-list of rules so the shared
 * `isAllowedType` matcher owns the comparison and `extForMime` derives the
 * stored extension — `@/lib/file-type` is the single source of truth.
 */
const ALLOWED_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/zip",
];

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

  // Validate against the shared allow-list. `File.type` is blank on many
  // systems, so fall back to the MIME implied by the file name's extension.
  const mime = file.type || mimeForExt(fileNameExt(file.name));
  if (!isAllowedType(mime, { allow: ALLOWED_TYPES })) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type || "unknown"}` },
      { status: 415 },
    );
  }

  const extension = `.${extForMime(mime)}`;
  const storedName = `${randomToken(12)}${extension}`;
  const driver = storageDriver();
  try {
    await driver.put(
      `${workspaceId}/${storedName}`,
      new Uint8Array(await file.arrayBuffer()),
      mime,
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
      mimeType: mime,
      size: file.size,
    },
  });

  return NextResponse.json({
    url,
    name: file.name || storedName,
    mimeType: mime,
    size: file.size,
  });
}
