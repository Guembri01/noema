"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";
import { templateContent, type TemplateId } from "@/lib/templates";
import { galleryTemplate, type GalleryProperty } from "@/lib/workflow-templates";
import { pageSearchText } from "@/lib/search";
import type { RichNode } from "@/lib/blocks";
import {
  applyTemplate,
  type DatabaseTemplate,
} from "@/lib/database-templates";
import {
  assertMutable,
  duplicateTemplate as duplicateRowTemplate,
  instantiateRow,
  reorderTemplates,
  resolveDefaultTemplate as resolveDefaultRowTemplate,
  setDefaultTemplate as setDefaultRowTemplate,
  type RowTemplate,
} from "@/lib/database-template-engine";
import {
  createFromPage,
  groupByScope,
  listTemplates,
  recordUsage,
  validateTemplateMeta,
  type PageTemplate,
  type PageTemplateScope,
  type TemplateScopeGroups,
  type TemplateSortKey,
} from "@/lib/template-gallery";
import {
  interpolate,
  interpolateBlocks,
  renderBuiltins,
  type TemplateContext,
} from "@/lib/template-variables";

export type TemplateResult =
  | { ok: true; id: string; slug: string; usageCount?: number }
  | { error: string };

export type WorkspaceTemplateList =
  | {
      ok: true;
      templates: PageTemplate[];
      groups: TemplateScopeGroups;
      defaultTemplateId: string | null;
    }
  | { error: string };

/** The JSON block tree of a stored template, as a `RichNode[]`. */
function templateBlocks(content: unknown): RichNode[] {
  if (Array.isArray(content)) return content as RichNode[];
  if (content && typeof content === "object") {
    const nested = (content as { content?: unknown }).content;
    if (Array.isArray(nested)) return nested as RichNode[];
  }
  return [];
}

/** `config.values` entries of a stored template, dropping malformed rows. */
function templateValues(config: unknown): { propertyId: string; value: unknown }[] {
  if (!config || typeof config !== "object") return [];
  const candidate = (config as { values?: unknown }).values;
  if (!Array.isArray(candidate)) return [];
  const values: { propertyId: string; value: unknown }[] = [];
  for (const entry of candidate) {
    if (!entry || typeof entry !== "object") continue;
    const propertyId = (entry as { propertyId?: unknown }).propertyId;
    if (typeof propertyId === "string") {
      values.push({ propertyId, value: (entry as { value?: unknown }).value });
    }
  }
  return values;
}

/**
 * Project a stored row template onto the gallery's `PageTemplate` shape, using
 * `createFromPage` so the snapshot/timestamps/block count come from one source.
 */
function toPageTemplate(
  template: {
    id: string;
    name: string;
    icon: string | null;
    content: unknown;
    recurrence: string | null;
    createdAt: Date;
  },
  database: { id: string; title: string },
): PageTemplate {
  return createFromPage(
    {
      id: database.id,
      icon: template.icon ?? undefined,
      description: template.recurrence ? `Repeats ${template.recurrence}` : database.title,
      blocks: templateBlocks(template.content),
    },
    { name: template.name, scope: "workspace", id: template.id, now: template.createdAt },
  );
}

/** Project a stored row template onto the engine's `RowTemplate` shape. */
function toRowTemplate(template: {
  id: string;
  databasePageId: string;
  name: string;
  config: unknown;
  isDefault: boolean;
  position: number;
  createdAt: Date;
}): RowTemplate {
  const values: Record<string, unknown> = {};
  for (const entry of templateValues(template.config)) values[entry.propertyId] = entry.value;
  return {
    id: template.id,
    databaseId: template.databasePageId,
    name: template.name,
    values,
    isDefault: template.isDefault,
    position: template.position,
    createdAt: template.createdAt.toISOString(),
  };
}

/** Render `{{tokens}}` in a stored cell value; anything else passes through. */
function interpolateValue(value: unknown, context: TemplateContext): unknown {
  return typeof value === "string" ? interpolate(value, context) : value;
}

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
  // Instantiation context: the gallery's sample rows may carry `{{tokens}}`
  // (`{{date}}`, `{{user}}`, …) that must resolve at creation time.
  const context = renderBuiltins({ now: new Date(), user: user.name });
  const databaseTitle = interpolate(template.label, context);
  const database = await prisma.page.create({
    data: {
      workspaceId: input.workspaceId,
      parentId,
      type: "DATABASE",
      title: databaseTitle,
      icon: template.emoji,
      createdById: user.id,
      position: await nextPosition(input.workspaceId, parentId),
      searchText: pageSearchText(databaseTitle, null),
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
    const rowTitle = interpolate(row.title, context);
    const page = await prisma.page.create({
      data: {
        workspaceId: input.workspaceId,
        parentId: database.id,
        title: rowTitle,
        createdById: user.id,
        position: rowPosition,
        searchText: pageSearchText(rowTitle, null),
      },
      select: { id: true },
    });
    rowPosition += 1000;

    const values: Prisma.PropertyValueCreateManyInput[] = [];
    for (const [name, raw] of Object.entries(row.values ?? {})) {
      const property = propertyIds.get(name);
      if (!property) continue;
      const value = interpolateValue(raw, context);
      if (property.type === "STATUS" || property.type === "SELECT") {
        const option = property.options.find((candidate) => candidate.name === value);
        if (option) {
          values.push({ propertyId: property.id, pageId: page.id, value: { optionId: option.id } });
        }
      } else if (property.type === "DATE") {
        values.push({ propertyId: property.id, pageId: page.id, value: { start: String(value) } });
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

  // Render `{{tokens}}` in the title and body at insertion time.
  const context = renderBuiltins({ now: new Date(), user: user.name });
  const blocks = interpolateBlocks(content, context);
  const title = interpolate(content[0]?.content?.[0]?.text ?? "Untitled", context);
  const parentId = input.parentId ?? null;
  const page = await prisma.page.create({
    data: {
      workspaceId: input.workspaceId,
      parentId,
      title,
      icon: "📄",
      createdById: user.id,
      position: await nextPosition(input.workspaceId, parentId),
      content: { type: "doc", content: blocks } as unknown as Prisma.InputJsonValue,
      searchText: pageSearchText(title, { type: "doc", content: blocks }),
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

/**
 * The workspace template gallery model (R31.7/R31.12/R31.15): every row
 * template of the workspace's databases, projected onto
 * `@/lib/template-gallery`'s `PageTemplate` so the gallery can list, search,
 * rank, filter and group them. Read-only — the page and the home gallery both
 * render from this, so the gallery rules stay in one place.
 */
export async function listWorkspaceTemplatesAction(input: {
  workspaceId: string;
  query?: string;
  scope?: PageTemplateScope;
  tag?: string;
  sort?: TemplateSortKey;
}): Promise<WorkspaceTemplateList> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, input.workspaceId);
  if (!access) return { error: "You do not have access to this workspace." };

  const databases = await prisma.page.findMany({
    where: { workspaceId: input.workspaceId, type: "DATABASE", deletedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, title: true },
  });

  const rows = databases.length
    ? await prisma.template.findMany({
        where: { databasePageId: { in: databases.map((database) => database.id) } },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          databasePageId: true,
          name: true,
          icon: true,
          content: true,
          config: true,
          recurrence: true,
          isDefault: true,
          position: true,
          createdAt: true,
        },
      })
    : [];

  const databaseById = new Map(databases.map((database) => [database.id, database]));
  const templates = listTemplates(
    rows.flatMap((row) => {
      const database = databaseById.get(row.databasePageId);
      return database ? [toPageTemplate(row, database)] : [];
    }),
    { query: input.query, scope: input.scope, tag: input.tag, sort: input.sort },
  );
  const defaultTemplate = resolveDefaultRowTemplate(rows.map(toRowTemplate));

  return {
    ok: true,
    templates,
    groups: groupByScope(templates),
    defaultTemplateId: defaultTemplate ? defaultTemplate.id : null,
  };
}

/**
 * Apply a workspace template as a new row (R31.10): the planner
 * (`@/lib/database-templates`' `applyTemplate`) merges the template's saved
 * values/body against the database's live properties, then
 * `@/lib/database-template-engine`'s `instantiateRow` materializes the row
 * payload (deep copy + actor/timestamp). Variables in the body/title resolve
 * against the run time via `@/lib/template-variables`.
 */
export async function instantiateWorkspaceTemplateAction(input: {
  workspaceId: string;
  templateId: string;
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

  const template = await prisma.template.findUnique({
    where: { id: input.templateId },
    select: {
      id: true,
      databasePageId: true,
      name: true,
      icon: true,
      content: true,
      config: true,
      recurrence: true,
      createdAt: true,
    },
  });
  if (!template) return { error: "That template does not exist." };
  const database = await prisma.page.findUnique({
    where: { id: template.databasePageId },
    select: { id: true, workspaceId: true, title: true },
  });
  if (!database || database.workspaceId !== input.workspaceId) {
    return { error: "That template does not exist." };
  }

  const properties = await prisma.property.findMany({
    where: { databasePageId: database.id },
    select: { id: true },
  });
  const stored: DatabaseTemplate = {
    id: template.id,
    name: template.name,
    icon: template.icon,
    propertyDefaults: Object.fromEntries(
      templateValues(template.config).map((entry) => [entry.propertyId, entry.value]),
    ),
    content: templateBlocks(template.content),
  };
  // Stale `propertyId`s (a deleted property) are dropped by the planner so the
  // insert cannot throw on a dangling foreign key (R31.5).
  const planned = applyTemplate(stored, {}, properties.map((property) => property.id));
  const rowTemplate: RowTemplate = {
    id: template.id,
    databaseId: database.id,
    name: template.name,
    values: Object.fromEntries(
      planned.values.map((entry) => [entry.propertyId, entry.value]),
    ),
    createdAt: template.createdAt.toISOString(),
  };
  const payload = instantiateRow(rowTemplate, { now: new Date(), actorId: user.id });

  const context = renderBuiltins({ now: new Date(), user: user.name });
  const blocks = interpolateBlocks(planned.content as RichNode[], context);
  const title = interpolate(template.name, context);
  const content = { type: "doc" as const, content: blocks };
  const last = await prisma.page.findFirst({
    where: { parentId: database.id },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const page = await prisma.page.create({
    data: {
      workspaceId: input.workspaceId,
      parentId: database.id,
      title,
      icon: template.icon,
      createdById: user.id,
      position: (last?.position ?? 0) + 1000,
      content: content as unknown as Prisma.InputJsonValue,
      searchText: pageSearchText(title, content),
    },
    select: { id: true },
  });

  const entries = Object.entries(payload.values);
  if (entries.length > 0) {
    await prisma.propertyValue.createMany({
      data: entries.map(([propertyId, value]) => ({
        propertyId,
        pageId: page.id,
        value: value as Prisma.InputJsonValue,
      })),
    });
  }

  // Usage tracking (R31.10): the count is derived and returned; persisting it
  // rides on the `Template.usageCount` column (follow-up — not in the schema).
  const used = recordUsage(toPageTemplate(template, database), { now: new Date() });
  revalidatePath("/w", "layout");
  return { ok: true, id: page.id, slug: workspace.slug, usageCount: used.usageCount };
}

/**
 * Form-friendly wrapper for the gallery page's "Apply" button. Server-rendered
 * forms submit `FormData`, so the page posts here and this delegates to the
 * object-input action the home gallery calls directly.
 */
export async function applyWorkspaceTemplateFormAction(formData: FormData): Promise<void> {
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const templateId = String(formData.get("templateId") ?? "");
  await instantiateWorkspaceTemplateAction({ workspaceId, templateId });
}

/**
 * Row-template lifecycle mutations from the gallery (R31.6/R31.8/R31.13):
 * rename, duplicate, set/clear the database default, and move a template
 * up/down. All invariants defer to `@/lib/database-template-engine` — which is
 * canonical for the row-template lifecycle — while `@/lib/database-templates`
 * stays canonical for the template→row planner merge used by `instantiate`.
 *
 * Form actions receive `FormData` so the gallery page works without JS.
 */
export async function manageWorkspaceTemplateAction(formData: FormData): Promise<void> {
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const templateId = String(formData.get("templateId") ?? "");
  const op = String(formData.get("op") ?? "");
  const requestedName = formData.get("name");

  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access || !canEditContent(access.role)) return;

  const target = await prisma.template.findUnique({
    where: { id: templateId },
    select: {
      id: true,
      databasePageId: true,
      name: true,
      icon: true,
      content: true,
      config: true,
      recurrence: true,
      isDefault: true,
      position: true,
      createdAt: true,
    },
  });
  if (!target) return;
  const database = await prisma.page.findUnique({
    where: { id: target.databasePageId },
    select: { id: true, workspaceId: true, title: true },
  });
  if (!database || database.workspaceId !== workspaceId) return;

  const siblings = await prisma.template.findMany({
    where: { databasePageId: target.databasePageId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      databasePageId: true,
      name: true,
      icon: true,
      content: true,
      config: true,
      recurrence: true,
      isDefault: true,
      position: true,
      createdAt: true,
    },
  });
  const projected = siblings.map(toRowTemplate);
  const current = projected.find((entry) => entry.id === templateId) ?? toRowTemplate(target);

  // R31.6 — a locked template refuses edits. No `locked` column yet, so this
  // fails open today; the guard lives here so it engages once the column lands.
  assertMutable(current);

  if (op === "rename") {
    const nextName = typeof requestedName === "string" ? requestedName : "";
    const existing = siblings.map((row) => toPageTemplate(row, database));
    const validation = validateTemplateMeta(
      { id: templateId, name: nextName, scope: "workspace" },
      existing,
    );
    if (!validation.ok) return;
    await prisma.template.update({ where: { id: templateId }, data: { name: nextName.trim() } });
  } else if (op === "duplicate") {
    const copy = duplicateRowTemplate(current, { newId: randomUUID() });
    await prisma.template.create({
      data: {
        id: copy.id,
        databasePageId: target.databasePageId,
        name: copy.name,
        icon: target.icon,
        content: (target.content ?? undefined) as Prisma.InputJsonValue | undefined,
        config: {
          values: Object.entries(copy.values).map(([propertyId, value]) => ({
            propertyId,
            value,
          })),
        } as Prisma.InputJsonValue,
        position: siblings.length,
      },
    });
  } else if (op === "default") {
    const next = setDefaultRowTemplate(projected, templateId);
    const selected = resolveDefaultRowTemplate(next);
    if (!selected) return;
    await prisma.$transaction([
      prisma.template.updateMany({
        where: { databasePageId: target.databasePageId },
        data: { isDefault: false },
      }),
      prisma.template.update({ where: { id: selected.id }, data: { isDefault: true } }),
    ]);
  } else if (op === "clear-default") {
    await prisma.template.updateMany({
      where: { databasePageId: target.databasePageId },
      data: { isDefault: false },
    });
  } else if (op === "move-up" || op === "move-down") {
    const from = projected.findIndex((entry) => entry.id === templateId);
    if (from === -1) return;
    const next = reorderTemplates(projected, templateId, op === "move-up" ? from - 1 : from + 1);
    await prisma.$transaction(
      next.map((entry) =>
        prisma.template.update({
          where: { id: entry.id },
          data: { position: entry.position ?? 0 },
        }),
      ),
    );
  } else {
    return;
  }

  revalidatePath("/w", "layout");
}
