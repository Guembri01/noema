"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { templateContent, type TemplateId } from "@/lib/templates";
import { galleryTemplate, type GalleryProperty } from "@/lib/workflow-templates";

export type TemplateResult =
  | { ok: true; id: string; slug: string }
  | { error: string };

async function nextPosition(workspaceId: string, parentId: string | null) {
  const last = await prisma.page.findFirst({
    where: { workspaceId, parentId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (last?.position ?? 0) + 1000;
}

function optionsFor(property: GalleryProperty) {
  return (property.options ?? []).map((option, index) => ({
    id: `opt-${index}-${option.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: option.name,
    color: option.color,
  }));
}

/**
 * Create a workspace from one of the home-gallery workflow templates:
 * a database with its properties, views and sample rows.
 */
export async function createGalleryTemplateAction(input: {
  workspaceId: string;
  templateId: string;
  parentId?: string | null;
}): Promise<TemplateResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to create pages." };
  }
  const template = galleryTemplate(input.templateId);
  if (!template) return { error: "That template does not exist." };
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  const parentId = input.parentId ?? null;
  const database = await prisma.page.create({
    data: {
      workspaceId: input.workspaceId,
      parentId,
      type: "DATABASE",
      title: template.label,
      icon: template.emoji,
      createdById: user.id,
      position: await nextPosition(input.workspaceId, parentId),
    },
    select: { id: true },
  });

  const propertyIds = new Map<string, { id: string; type: string; options: { id: string; name: string }[] }>();
  let position = 1000;
  for (const property of template.properties) {
    const options = optionsFor(property);
    const created = await prisma.property.create({
      data: {
        databasePageId: database.id,
        name: property.name,
        type: property.type,
        position,
        config: {
          ...(property.primary ? { primary: true } : {}),
          ...(options.length > 0 ? { options } : {}),
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    propertyIds.set(property.name, {
      id: created.id,
      type: property.type,
      options: options.map((option) => ({ id: option.id, name: option.name })),
    });
    position += 1000;
  }

  const views: Prisma.DatabaseViewCreateManyInput[] = [
    { databasePageId: database.id, name: "Table", type: "TABLE", position: 1000 },
  ];
  if (template.boardBy) {
    const groupBy = propertyIds.get(template.boardBy);
    if (groupBy) {
      views.push({
        databasePageId: database.id,
        name: "Board",
        type: "BOARD",
        position: 2000,
        config: { groupByPropertyId: groupBy.id } as Prisma.InputJsonValue,
      });
    }
  }
  await prisma.databaseView.createMany({ data: views });

  let rowPosition = 1000;
  for (const row of template.rows) {
    const page = await prisma.page.create({
      data: {
        workspaceId: input.workspaceId,
        parentId: database.id,
        title: row.title,
        createdById: user.id,
        position: rowPosition,
      },
      select: { id: true },
    });
    rowPosition += 1000;

    const values: Prisma.PropertyValueCreateManyInput[] = [];
    for (const [name, raw] of Object.entries(row.values ?? {})) {
      const property = propertyIds.get(name);
      if (!property) continue;
      if (property.type === "STATUS" || property.type === "SELECT") {
        const option = property.options.find((candidate) => candidate.name === raw);
        if (option) {
          values.push({ propertyId: property.id, pageId: page.id, value: { optionId: option.id } });
        }
      } else if (property.type === "DATE") {
        values.push({ propertyId: property.id, pageId: page.id, value: { start: String(raw) } });
      }
    }
    if (values.length > 0) await prisma.propertyValue.createMany({ data: values });
  }

  revalidatePath("/w", "layout");
  return { ok: true, id: database.id, slug: workspace.slug };
}

/** Create a page seeded from one of the simpler block templates. */
export async function createBlockTemplateAction(input: {
  workspaceId: string;
  templateId: TemplateId;
  parentId?: string | null;
}): Promise<TemplateResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to create pages." };
  }
  const content = templateContent(input.templateId);
  if (content.length === 0) return { error: "That template does not exist." };
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  const parentId = input.parentId ?? null;
  const page = await prisma.page.create({
    data: {
      workspaceId: input.workspaceId,
      parentId,
      title: content[0]?.content?.[0]?.text ?? "Untitled",
      icon: "📄",
      createdById: user.id,
      position: await nextPosition(input.workspaceId, parentId),
      content: { type: "doc", content } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  revalidatePath("/w", "layout");
  return { ok: true, id: page.id, slug: workspace.slug };
}

/** Create an empty page or an empty database (the two quick-start cards). */
export async function createQuickStartAction(input: {
  workspaceId: string;
  kind: "page" | "database";
  parentId?: string | null;
}): Promise<TemplateResult> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access || !canEditContent(access.role)) {
    return { error: "You do not have permission to create pages." };
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return { error: "Workspace not found." };

  const parentId = input.parentId ?? null;
  const isDatabase = input.kind === "database";
  const page = await prisma.page.create({
    data: {
      workspaceId: input.workspaceId,
      parentId,
      type: isDatabase ? "DATABASE" : "PAGE",
      title: "",
      icon: isDatabase ? "🗂️" : "📄",
      createdById: user.id,
      position: await nextPosition(input.workspaceId, parentId),
      ...(isDatabase
        ? {}
        : { content: { type: "doc", content: [{ type: "paragraph" }] } as unknown as Prisma.InputJsonValue }),
    },
    select: { id: true },
  });

  if (isDatabase) {
    await prisma.property.create({
      data: {
        databasePageId: page.id,
        name: "Name",
        type: "TEXT",
        position: 1000,
        config: { primary: true },
      },
    });
    await prisma.databaseView.create({
      data: { databasePageId: page.id, name: "Table", type: "TABLE", position: 1000 },
    });
  }

  revalidatePath("/w", "layout");
  return { ok: true, id: page.id, slug: workspace.slug };
}
