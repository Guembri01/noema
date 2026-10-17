"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { markdownToDoc } from "@/lib/serialize";
import { assertScopedParent } from "@/lib/page-parent";
import { cardDescriptionBlocks, parseTrelloBoard, pathToTitles, type ImportCounts } from "@/lib/importers";
import type { CreatePropertyDescriptor } from "@/lib/csv-mapping";
import { fileNameExt, isAllowedType, mimeForExt } from "@/lib/file-type";
import {
  mapNotionBlockType,
  mapNotionPropertyType,
  unmappedBlocks,
} from "@/lib/import-notion-map";
import { importCsvAction } from "./database";

const TRELLO_COLORS = ["gray", "blue", "green", "yellow", "orange", "purple", "pink", "red"];

/**
 * B71 / R23.6: every multi-record import runs inside one `prisma.$transaction`
 * so a mid-import failure rolls back instead of leaving partial pages.
 * Counts (D23.4) report what was written vs dropped.
 */
type ImportResult =
  | { ok: true; id: string; slug: string; counts: ImportCounts; unmapped?: NotionMappingSummary }
  | { error: string };

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Distinct Notion block/property type coverage for an import: how many types
 * have a Noema equivalent and which have none. Computed through the vocabulary
 * layer (`src/lib/import-notion-map.ts`) so the server reports the same loss
 * the client preview shows, instead of silently dropping content.
 */
export type NotionMappingSummary = {
  blocks: { total: number; mapped: number; unmapped: string[] };
  properties: { total: number; mapped: number; unmapped: string[] };
};

/** Distinct, non-empty type strings in first-seen order (mirrors `unmappedBlocks`). */
function distinctTypes(types: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const type of types) {
    if (typeof type !== "string" || type.trim() === "" || seen.has(type)) continue;
    seen.add(type);
    out.push(type);
  }
  return out;
}

/**
 * Report/count the Notion types in an import that have no Noema mapping, using
 * the shared vocabulary layer (`mapNotionBlockType` / `mapNotionPropertyType` /
 * `unmappedBlocks`). Purely additive and total: unknown or malformed input
 * degrades to an empty summary rather than throwing.
 */
function summarizeNotionMapping(
  blockTypes: readonly unknown[] = [],
  propertyTypes: readonly unknown[] = [],
): NotionMappingSummary {
  const blocks = distinctTypes(blockTypes);
  const properties = distinctTypes(propertyTypes);
  return {
    blocks: {
      total: blocks.length,
      mapped: blocks.filter((type) => mapNotionBlockType(type) !== null).length,
      unmapped: unmappedBlocks(blocks),
    },
    properties: {
      total: properties.length,
      mapped: properties.filter((type) => mapNotionPropertyType(type) !== null).length,
      unmapped: properties.filter((type) => mapNotionPropertyType(type) === null),
    },
  };
}

/**
 * Server-side allow-lists per uploaded import entry, mirroring the sidebar
 * `<input accept>` attributes. Validated through `file-type` (extension →
 * MIME + shared allow-list matcher) instead of trusting `File.type`, which
 * browsers leave blank on many systems.
 */
const UPLOAD_ALLOW: Record<string, readonly string[]> = {
  docx: [".docx"],
  zip: [".zip"],
};

/**
 * Whether an uploaded file's extension resolves to a permitted type. The
 * browser-supplied `File.type` is ignored; the name is resolved via
 * `mimeForExt` and matched with `isAllowedType`.
 */
function isUploadAllowed(file: File, allow: readonly string[]): boolean {
  return isAllowedType(mimeForExt(fileNameExt(file.name)), { allow });
}

/**
 * Read an optional JSON string-array form field (Notion type hints). Anything
 * malformed or non-array degrades to `[]` so validation never rejects an
 * otherwise valid import.
 */
function readTypeHints(formData: FormData, field: string): string[] {
  const raw = formData.get(field);
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/** Import a Word (.docx) document as a page. */
export async function importDocxAction(formData: FormData): Promise<ImportResult> {
  const user = await requireUser();
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const parentId = (formData.get("parentId") as string) || null;
  const file = formData.get("file");
  if (!workspaceId || !(file instanceof File)) {
    return { error: "Missing file or workspace." };
  }
  if (!isUploadAllowed(file, UPLOAD_ALLOW.docx)) {
    return { error: `Unsupported file type: ${file.name}. Expected a .docx document.` };
  }
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to import." };
  }
  // The parent must live in the same workspace — `Page.parentId` is a plain
  // foreign key, so a foreign parent would link the imported page into another
  // tenant's tree (B08). Refused before anything is written.
  const parent = await assertScopedParent({ workspaceId, parentId });
  if ("error" in parent) return parent;
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  const mod = await import("mammoth");
  const convert =
    (mod as { convertToMarkdown?: (input: { buffer: Buffer }) => Promise<{ value: string }> })
      .convertToMarkdown ??
    (mod as { default?: { convertToMarkdown?: (input: { buffer: Buffer }) => Promise<{ value: string }> } })
      .default?.convertToMarkdown;
  if (!convert) return { error: "Word import is unavailable." };

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await convert({ buffer }).catch(() => null);
  if (!result) return { error: "That file is not a readable .docx document." };

  const title = file.name.replace(/\.docx$/i, "").slice(0, 200) || "Imported document";

  let pageId = "";
  try {
    await prisma.$transaction(async (tx) => {
      const last = await tx.page.findFirst({
        where: { workspaceId, parentId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      const page = await tx.page.create({
        data: {
          workspaceId,
          parentId: parent.parentId,
          title,
          icon: "📄",
          createdById: user.id,
          position: (last?.position ?? 0) + 1000,
          content: markdownToDoc(result.value) as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      pageId = page.id;
    });
  } catch (error) {
    return { error: errorMessage(error, "Word import failed.") };
  }

  revalidatePath("/w", "layout");
  return {
    ok: true,
    id: pageId,
    slug: workspace.slug,
    counts: { imported: 1, skippedColumns: 0, skippedCells: 0, failed: 0 },
  };
}

/** Import a Trello board JSON export as a database (lists → status options). */
export async function importTrelloAction(input: {
  workspaceId: string;
  parentId?: string | null;
  json: string;
}): Promise<ImportResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to import." };
  }
  // The parent must live in the same workspace — `Page.parentId` is a plain
  // foreign key, so a foreign parent would link the imported page into another
  // tenant's tree (B08). Refused before anything is written.
  const parent = await assertScopedParent({
    workspaceId: input.workspaceId,
    parentId: input.parentId,
  });
  if ("error" in parent) return parent;
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  let raw: unknown;
  try {
    raw = JSON.parse(input.json);
  } catch {
    return { error: "That file is not valid JSON." };
  }
  const board = parseTrelloBoard(raw);
  if ("error" in board) return board;

  const last = await prisma.page.findFirst({
    where: { workspaceId: input.workspaceId, parentId: parent.parentId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  let databaseId = "";
  let imported = 0;
  try {
    // R23.6: the whole board (page + properties + views + every card row)
    // commits or rolls back as one unit.
    await prisma.$transaction(async (tx) => {
      const database = await tx.page.create({
        data: {
          workspaceId: input.workspaceId,
          parentId: parent.parentId,
          type: "DATABASE",
          title: board.name,
          icon: "📋",
          createdById: user.id,
          position: (last?.position ?? 0) + 1000,
        },
        select: { id: true },
      });
      databaseId = database.id;

      const nameProperty = await tx.property.create({
        data: {
          databasePageId: database.id,
          name: "Name",
          type: "TEXT",
          position: 1000,
          config: { primary: true },
        },
      });
      const options = board.lists.map((list, index) => ({
        id: list.id,
        name: list.name,
        color: TRELLO_COLORS[index % TRELLO_COLORS.length],
      }));
      const statusProperty = await tx.property.create({
        data: {
          databasePageId: database.id,
          name: "List",
          type: "STATUS",
          position: 2000,
          config: { options },
        },
      });
      await tx.databaseView.createMany({
        data: [
          { databasePageId: database.id, name: "Table", type: "TABLE", position: 1000 },
          {
            databasePageId: database.id,
            name: "Board",
            type: "BOARD",
            position: 2000,
            config: { groupByPropertyId: statusProperty.id },
          },
        ],
      });

      let position = 1000;
      let rows = 0;
      for (const list of board.lists) {
        for (const card of list.cards) {
          const blocks = cardDescriptionBlocks(card.description);
          const row = await tx.page.create({
            data: {
              workspaceId: input.workspaceId,
              // The parent is the database page this action just created in
              // `input.workspaceId` — inside the workspace by construction
              // (B08: `assertScopedParent` would be redundant here).
              parentId: database.id,
              title: card.title,
              createdById: user.id,
              position,
              icon: "🗂️",
              ...(blocks.length > 0
                ? { content: { type: "doc", content: blocks } as Prisma.InputJsonValue }
                : {}),
            },
            select: { id: true },
          });
          position += 1000;
          rows += 1;
          await tx.propertyValue.createMany({
            data: [
              { propertyId: nameProperty.id, pageId: row.id, value: { text: card.title } },
              { propertyId: statusProperty.id, pageId: row.id, value: { optionId: list.id } },
            ],
          });
        }
      }
      imported = 1 + rows;
    });
  } catch (error) {
    return { error: errorMessage(error, "Trello import failed.") };
  }

  revalidatePath("/w", "layout");
  return {
    ok: true,
    id: databaseId,
    slug: workspace.slug,
    counts: { imported, skippedColumns: 0, skippedCells: 0, failed: 0 },
  };
}

/** Import a Markdown archive (e.g. a Notion/pages export) as nested pages. */
export async function importZipAction(formData: FormData): Promise<ImportResult> {
  const user = await requireUser();
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const parentId = (formData.get("parentId") as string) || null;
  const file = formData.get("file");
  if (!workspaceId || !(file instanceof File)) {
    return { error: "Missing file or workspace." };
  }
  if (!isUploadAllowed(file, UPLOAD_ALLOW.zip)) {
    return { error: `Unsupported file type: ${file.name}. Expected a .zip archive.` };
  }
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to import." };
  }
  // The parent must live in the same workspace — `Page.parentId` is a plain
  // foreign key, so a foreign parent would link the imported tree into another
  // tenant's tree (B08). Refused before anything is written.
  const parent = await assertScopedParent({ workspaceId, parentId });
  if ("error" in parent) return parent;
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  // m30: report which Notion block/property types in a Notion/pages export
  // have no Noema mapping. Additive: without the optional type hints (the
  // sidebar sends none) the summary is empty and the import is unchanged.
  const unmapped = summarizeNotionMapping(
    readTypeHints(formData, "blockTypes"),
    readTypeHints(formData, "propertyTypes"),
  );

  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer()).catch(() => null);
  if (!zip) return { error: "That file is not a readable .zip archive." };

  const entries = Object.values(zip.files).filter(
    (entry) => !entry.dir && /\.(md|markdown)$/i.test(entry.name),
  );
  if (entries.length === 0) {
    return { error: "No Markdown files found in the archive." };
  }

  const cache = new Map<string, string>();
  const positions = new Map<string, number>();
  const nextPosition = (parent: string | null) => {
    const key = parent ?? "root";
    const value = (positions.get(key) ?? 0) + 1000;
    positions.set(key, value);
    return value;
  };

  // R23.6: read/parse every entry first (no DB writes), then create the
  // whole tree inside one transaction so a failure mid-archive rolls back.
  const plan: { titles: string[]; content: ReturnType<typeof markdownToDoc> }[] = [];
  for (const entry of entries) {
    const titles = pathToTitles(entry.name);
    if (titles.length === 0) continue;
    plan.push({ titles, content: markdownToDoc(await entry.async("text")) });
  }
  if (plan.length === 0) return { error: "Nothing to import." };

  let created = 0;
  let imported = 0;
  let lastId = "";

  try {
    await prisma.$transaction(async (tx) => {
      for (const item of plan) {
        const { titles, content } = item;
        let parentPageId = parent.parentId;
        let prefix = "";
        for (let i = 0; i < titles.length; i += 1) {
          prefix = prefix ? `${prefix}/${titles[i]}` : titles[i];
          const isLeaf = i === titles.length - 1;
          let pageId = cache.get(prefix);
          if (!pageId) {
            const page = await tx.page.create({
              data: {
                workspaceId,
                parentId: parentPageId,
                title: titles[i],
                icon: isLeaf ? "📄" : "📁",
                createdById: user.id,
                position: nextPosition(parentPageId),
                ...(isLeaf ? { content: content as unknown as Prisma.InputJsonValue } : {}),
              },
              select: { id: true },
            });
            pageId = page.id;
            cache.set(prefix, pageId);
            imported += 1;
            if (isLeaf) {
              created += 1;
              lastId = pageId;
            }
          }
          parentPageId = pageId;
        }
      }
      if (created === 0) throw new Error("Nothing to import.");
    });
  } catch (error) {
    return { error: errorMessage(error, "Archive import failed.") };
  }

  revalidatePath("/w", "layout");
  return {
    ok: true,
    id: lastId,
    slug: workspace.slug,
    counts: { imported, skippedColumns: 0, skippedCells: 0, failed: 0 },
    unmapped,
  };
}

/** Import a Markdown document as a new page. */
export async function importMarkdownAction(input: {
  workspaceId: string;
  parentId?: string | null;
  filename: string;
  markdown: string;
}): Promise<{ ok: true; id: string; slug: string } | { error: string }> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to import pages." };
  }
  // The parent must live in the same workspace — `Page.parentId` is a plain
  // foreign key, so a foreign parent would link the imported page into another
  // tenant's tree (B08). Refused before anything is written.
  const parent = await assertScopedParent({
    workspaceId: input.workspaceId,
    parentId: input.parentId,
  });
  if ("error" in parent) return parent;

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  const title =
    input.filename.replace(/\.[^.]+$/, "").trim().slice(0, 200) || "Imported page";

  const last = await prisma.page.findFirst({
    where: { workspaceId: input.workspaceId, parentId: parent.parentId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const page = await prisma.page.create({
    data: {
      workspaceId: input.workspaceId,
      parentId: parent.parentId,
      title,
      icon: "📥",
      createdById: user.id,
      position: (last?.position ?? 0) + 1000,
      content: markdownToDoc(input.markdown) as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  revalidatePath("/w", "layout");
  return { ok: true, id: page.id, slug: workspace.slug };
}

/**
 * R23.2 — create a new DATABASE page from a parsed CSV.
 *
 * The client owns the header-mapping step (`suggestPropertyMapping` /
 * `buildCreatePlan`, `src/lib/csv-mapping.ts`) and hands over the reviewed
 * column plan as `properties` plus a normalised CSV whose header row already
 * matches the property names. This action only creates the database shell
 * (page + properties + a Table view); the row values are written by the shared
 * append core (`importCsvAction`), so create-import and append-import coerce
 * cells identically. Following R23.2 the first column always becomes the
 * primary TEXT property that carries row titles.
 */
export async function importCsvDatabaseAction(input: {
  workspaceId: string;
  parentId?: string | null;
  title: string;
  properties: CreatePropertyDescriptor[];
  csv: string;
}): Promise<ImportResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to import." };
  }
  // The parent must live in the same workspace — `Page.parentId` is a plain
  // foreign key, so a foreign parent would link the imported database into
  // another tenant's tree (B08). Refused before anything is written.
  const parent = await assertScopedParent({
    workspaceId: input.workspaceId,
    parentId: input.parentId,
  });
  if ("error" in parent) return parent;
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  const plan = input.properties.filter((property) => property.name.trim() !== "");
  if (plan.length === 0) return { error: "Nothing to import." };

  const last = await prisma.page.findFirst({
    where: { workspaceId: input.workspaceId, parentId: parent.parentId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  let databaseId = "";
  try {
    await prisma.$transaction(async (tx) => {
      const database = await tx.page.create({
        data: {
          workspaceId: input.workspaceId,
          parentId: parent.parentId,
          type: "DATABASE",
          title: input.title.trim().slice(0, 200) || "Imported CSV",
          icon: "📥",
          createdById: user.id,
          position: (last?.position ?? 0) + 1000,
        },
        select: { id: true },
      });
      databaseId = database.id;

      let position = 1000;
      for (const [index, descriptor] of plan.entries()) {
        const primary = index === 0;
        await tx.property.create({
          data: {
            databasePageId: database.id,
            name: descriptor.name.trim().slice(0, 80) || `Column ${index + 1}`,
            type: primary ? "TEXT" : descriptor.type,
            position,
            config: (primary ? { primary: true } : {}) as Prisma.InputJsonValue,
          },
        });
        position += 1000;
      }

      await tx.databaseView.create({
        data: {
          databasePageId: database.id,
          name: "Table",
          type: "TABLE",
          position: 1000,
        },
      });
    });
  } catch (error) {
    return { error: errorMessage(error, "CSV import failed.") };
  }

  // R23.6: rows are written by the shared append core. If that second phase
  // fails, compensate by deleting the database shell so a failed import never
  // leaves an empty database behind.
  const appended = await importCsvAction(databaseId, input.csv);
  if ("error" in appended) {
    await prisma.page.delete({ where: { id: databaseId } }).catch(() => undefined);
    return appended;
  }

  revalidatePath("/w", "layout");
  return {
    ok: true,
    id: databaseId,
    slug: workspace.slug,
    counts: appended.counts,
  };
}
