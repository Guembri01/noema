"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { markdownToDoc } from "@/lib/serialize";
import { cardDescriptionBlocks, parseTrelloBoard, pathToTitles, type ImportCounts } from "@/lib/importers";

const TRELLO_COLORS = ["gray", "blue", "green", "yellow", "orange", "purple", "pink", "red"];

/**
 * B71 / R23.6: every multi-record import runs inside one `prisma.$transaction`
 * so a mid-import failure rolls back instead of leaving partial pages.
 * Counts (D23.4) report what was written vs dropped.
 */
type ImportResult =
  | { ok: true; id: string; slug: string; counts: ImportCounts }
  | { error: string };

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** Import a Word (.docx) document as a page. */
export async function importDocxAction(formData: FormData): Promise<ImportResult> {
  const user = await requireUser();
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const parentId = (formData.get("parentId") as string) || null;
  const file = formData.get("file");
  if (!workspaceId || !(file instanceof File)) {
    return { error: "Missing file or workspace." };
  }
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to import." };
  }
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
          parentId,
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
    where: { workspaceId: input.workspaceId, parentId: input.parentId ?? null },
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
          parentId: input.parentId ?? null,
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
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to import." };
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

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
        let parent = parentId;
        let prefix = "";
        for (let i = 0; i < titles.length; i += 1) {
          prefix = prefix ? `${prefix}/${titles[i]}` : titles[i];
          const isLeaf = i === titles.length - 1;
          let pageId = cache.get(prefix);
          if (!pageId) {
            const page = await tx.page.create({
              data: {
                workspaceId,
                parentId: parent,
                title: titles[i],
                icon: isLeaf ? "📄" : "📁",
                createdById: user.id,
                position: nextPosition(parent),
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
          parent = pageId;
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

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  const title =
    input.filename.replace(/\.[^.]+$/, "").trim().slice(0, 200) || "Imported page";

  const last = await prisma.page.findFirst({
    where: { workspaceId: input.workspaceId, parentId: input.parentId ?? null },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const page = await prisma.page.create({
    data: {
      workspaceId: input.workspaceId,
      parentId: input.parentId ?? null,
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
