"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { assembleDoc, describeImport, type PdfImportSummary } from "@/lib/pdf-import";
import { extractedTextToPages, pdfBlocksToRichNodes } from "@/lib/pdf-import-blocks";
import { assertEditableParent } from "@/lib/page-parent";
import { sanitizeDocHrefs } from "@/lib/validation";
import type { ImportCounts } from "@/lib/importers";

/**
 * PDF text-layer import, wired through the previously un-wired engine in
 * `src/lib/pdf-import.ts`.
 *
 * The engine operates on text an upstream extractor already pulled out of a
 * PDF — there is deliberately no binary parsing and no new dependency here (the
 * dependency set has no PDF parser). So this action accepts the extracted text
 * layer (a `.txt`-style payload or the plain text a caller obtained elsewhere),
 * runs it through {@link assembleDoc}, converts the recovered blocks into the
 * TipTap/ProseMirror document every page stores (`pdf-import-blocks.ts`) and
 * creates one page. The sidebar previews the same pipeline client-side before
 * submitting, mirroring the Trello / Asana / Evernote importers (the client
 * parses for the preview, the server re-runs it for the write).
 */

/** Result shape mirrors the sibling format importers (`import-formats.ts`). */
export type PdfTextImportResult =
  | {
      ok: true;
      id: string;
      slug: string;
      format: "pdf";
      /** Title actually written (filename stem, else the inferred document title). */
      title: string;
      /** Text-layer pages recovered from the input. */
      pages: number;
      /** Engine summary (`describeImport`) the UI can report verbatim. */
      summary: PdfImportSummary;
      /** Human-readable engine warnings (stripped headers, low confidence, …). */
      warnings: string[];
      counts: ImportCounts;
    }
  | { error: string };

/** Upper bound on the extracted text we will parse (5 MB of characters). */
const MAX_TEXT_CHARS = 5_000_000;

/** Matches the sibling import actions' error-message extraction. */
const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

/** Filename stem → page title (the same rule the other import actions use). */
function titleFromFilename(filename: string | null | undefined): string | null {
  if (typeof filename !== "string") return null;
  const stem = filename.replace(/\.[^.]+$/, "").trim();
  return stem ? stem.slice(0, 200) : null;
}

/**
 * Import a PDF's extracted text layer as a page. Runs the `pdf-import` engine
 * (`assembleDoc`), maps its blocks to editor blocks and stores them; on failure
 * nothing is left behind because a single page is created in one `create`.
 */
export async function importPdfTextAction(input: {
  workspaceId: string;
  parentId?: string | null;
  filename?: string | null;
  text: string;
}): Promise<PdfTextImportResult> {
  const text = typeof input.text === "string" ? input.text : "";
  if (!text.trim()) return { error: "No PDF text was provided." };
  if (text.length > MAX_TEXT_CHARS) {
    return { error: "That text layer is too large to import (max 5 MB)." };
  }

  const workspaceId = String(input.workspaceId ?? "");
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to import." };
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  // The parent must live in the same workspace — `Page.parentId` is a plain
  // foreign key, so a foreign parent would link the imported page into another
  // tenant's tree (B08). The parent comes straight from the request body
  // (`POST /api/import/pdf`), so it is checked before anything is written.
  const parent = await assertEditableParent({
    workspaceId,
    parentId: input.parentId,
    userId: user.id,
    role: access.role,
  });
  if ("error" in parent) return parent;

  const pages = extractedTextToPages(text);
  const doc = assembleDoc(pages);
  const content = pdfBlocksToRichNodes(doc.blocks);
  if (content.length === 0) {
    return { error: "No text-layer content could be recovered from that input." };
  }

  const parentId = parent.parentId;
  const title = (titleFromFilename(input.filename) ?? doc.title).slice(0, 200) || "Imported PDF";

  let pageId = "";
  try {
    const last = await prisma.page.findFirst({
      where: { workspaceId, parentId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const page = await prisma.page.create({
      data: {
        workspaceId,
        parentId,
        title,
        icon: "📄",
        createdById: user.id,
        position: (last?.position ?? 0) + 1000,
        // B110: the imported document meets the same href allowlist the save
        // path applies (`parsePageContent`).
        content: sanitizeDocHrefs({ type: "doc", content }) as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    pageId = page.id;
  } catch (error) {
    return { error: errorMessage(error, "PDF import failed.") };
  }

  revalidatePath("/w", "layout");
  return {
    ok: true,
    id: pageId,
    slug: workspace.slug,
    format: "pdf",
    title,
    pages: pages.length,
    summary: describeImport(doc),
    warnings: doc.warnings.map((warning) => warning.message),
    counts: { imported: 1, skippedColumns: 0, skippedCells: 0, failed: 0 },
  };
}
