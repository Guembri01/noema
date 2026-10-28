import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/slug";
import { rateLimit } from "@/lib/api-guard";
import { bodyReadError, readFormDataBody } from "@/lib/body-limit";
import { storageDriver } from "@/lib/storage";
import { extForMime, fileNameExt, isAllowedType, mimeForExt } from "@/lib/file-type";
import { isSvgSafe } from "@/lib/svg-safety";
import { isComplete, planChunks, validateChunkPlan } from "@/lib/upload-chunk";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * B22 — the budget for one upload request.
 *
 * `request.formData()` buffers the whole multipart body, so the budget has to
 * sit above the file limit ({@link MAX_BYTES}) plus the multipart envelope.
 * The file limit itself is still enforced per file below — this one bounds
 * what the route reads at all.
 */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

/** Upper bound on a declared `totalParts` — guards the plan allocation. */
const MAX_PARTS = 10_000;

/**
 * MIME types the uploader accepts. Kept as an allow-list of rules so the shared
 * `isAllowedType` matcher owns the comparison and `extForMime` derives the
 * stored extension — `@/lib/file-type` is the single source of truth.
 *
 * `image/svg+xml` is on the list, so an SVG can be pasted and uploaded like
 * every other image. It is an active document, though: the file route
 * delivers it with `Content-Disposition: attachment`, so it never runs as a
 * document in the app's own origin (B112).
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
  "text/csv",
  "application/json",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/**
 * Parse the declared, zero-based part indexes from the repeatable `part` form
 * field. A single value may also carry a comma-separated list (`part=0,1,2`).
 * Every token must be an integer inside `[0, totalParts)`; anything else
 * yields `null` so the caller can answer 400 rather than silently resuming
 * from a wrong offset. Junk handling mirrors `upload-chunk`'s index rules.
 */
function parsePartIndexes(
  values: readonly FormDataEntryValue[],
  totalParts: number,
): number[] | null {
  const indexes: number[] = [];
  for (const value of values) {
    for (const token of String(value).split(",")) {
      const trimmed = token.trim();
      if (trimmed === "") continue;
      const index = Number(trimmed);
      if (!Number.isInteger(index) || index < 0 || index >= totalParts) return null;
      indexes.push(index);
    }
  }
  return indexes;
}

/**
 * File upload. Validates auth + workspace access, type and size, hands the
 * bytes to the configured storage driver (filesystem by default, S3-compatible
 * when `S3_BUCKET` is set), records an Asset, and returns the serving URL.
 *
 * Two shapes share the endpoint:
 * - **single-shot** (no `part`/`totalParts`): one whole file, unchanged.
 * - **resumable/chunked** (`part` and/or `totalParts` present): the request
 *   declares which parts of a split upload have landed; the response reports
 *   the plan and exactly which parts are still needed.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  const limited = rateLimit(request, "upload", 60, 60_000, { userId: user?.id });
  if (limited) return limited;
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await readFormDataBody(request, MAX_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Expected multipart form data");
  }

  const workspaceId = String(form.get("workspaceId") ?? "");

  // ── Resumable / chunked upload ─────────────────────────────────────────
  // A chunked request carries progress, not the whole file, so the canonical
  // plan is expressed over part *indexes* — one unit part per index — and the
  // reply names exactly which parts are still needed. When neither field is
  // present the byte-for-byte single-shot path below runs unchanged.
  if (form.has("part") || form.has("totalParts")) {
    if (!workspaceId) {
      return NextResponse.json({ error: "Missing workspaceId" }, { status: 400 });
    }

    const access = await getWorkspaceAccess(user.id, workspaceId);
    if (!access || access.role === "GUEST") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const totalParts = Number(String(form.get("totalParts") ?? "").trim());
    if (!Number.isInteger(totalParts) || totalParts < 1 || totalParts > MAX_PARTS) {
      return NextResponse.json({ error: "Invalid totalParts" }, { status: 400 });
    }

    // One unit part per index: `planChunks(n, { chunkSize: 1 })` tiles `[0, n)`
    // as n parts, so plan indexes map 1:1 to part indexes while the shared
    // validator still owns well-formedness.
    const plan = planChunks(totalParts, { chunkSize: 1 });
    if (!validateChunkPlan(plan)) {
      return NextResponse.json({ error: "Invalid chunk plan" }, { status: 400 });
    }

    const received = parsePartIndexes(form.getAll("part"), totalParts);
    if (received === null) {
      return NextResponse.json({ error: "Invalid part index" }, { status: 400 });
    }

    const receivedSet = new Set(received);
    const remainingParts = plan
      .filter((part) => !receivedSet.has(part.index))
      .map((part) => part.index);

    return NextResponse.json({
      chunked: true,
      totalParts,
      receivedParts: [...receivedSet].sort((a, b) => a - b),
      remainingParts,
      complete: isComplete(plan, received),
    });
  }

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
  // Strip parameters (`image/svg+xml; charset=utf-8`) before both the allow
  // check and the SVG comparison: the matcher normalises them, but a raw
  // comparison would let the parameterised form skip the SVG scanner.
  const mime = (file.type || mimeForExt(fileNameExt(file.name)))
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!isAllowedType(mime, { allow: ALLOWED_TYPES })) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type || "unknown"}` },
      { status: 415 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // An SVG is served inline from the app origin, so it runs the same safety
  // rule the clipboard path applies (`@/lib/svg-safety` - one rule, one
  // place). Fail closed: the bytes are checked *before* anything is stored,
  // so a refused SVG never reaches the disk, the Asset table or a URL.
  // The answer names the rule, not the place in the file that broke it, so
  // two different unsafe SVGs get the same reply.
  if (mime === "image/svg+xml") {
    // A UTF-16/UTF-32 document is full of NUL bytes and `file.text()` would
    // decode it as UTF-8 garbage; the markup scanner would then miss the
    // script tags. Only a valid UTF-8 SVG without NULs is accepted.
    let svgText: string;
    try {
      if (bytes.includes(0)) throw new Error("NUL byte");
      svgText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return NextResponse.json(
        { error: "File rejected by the image safety policy" },
        { status: 415 },
      );
    }
    if (!isSvgSafe(svgText)) {
      return NextResponse.json(
        { error: "File rejected by the image safety policy" },
        { status: 415 },
      );
    }
  }

  const extension = `.${extForMime(mime)}`;
  const storedName = `${randomToken(12)}${extension}`;
  const driver = storageDriver();
  try {
    await driver.put(`${workspaceId}/${storedName}`, bytes, mime);
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
