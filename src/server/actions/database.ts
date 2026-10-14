"use server";

import { revalidatePath } from "next/cache";
import type { Prisma, PropertyType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser, type SessionUser } from "@/lib/auth";
import {
  getWorkspaceAccess,
  canEditContent,
  type WorkspaceAccess,
} from "@/lib/permissions";
import { csvToMatrix } from "@/lib/serialize";
import { normalizeViewConfig } from "@/lib/database-query";
import { dispatchWebhooks } from "@/lib/webhooks";
import { nextRunFor } from "@/lib/recurrence";

type Result<T = unknown> = ({ ok: true } & T) | { error: string };

type DatabaseAuth =
  | { error: string }
  | {
      page: { id: string; workspaceId: string; type: string };
      access: NonNullable<WorkspaceAccess>;
      user: SessionUser;
    };

/**
 * Property value shapes (stored as JSON on `PropertyValue.value`):
 *   TEXT | URL | EMAIL | PHONE      -> { text: string }
 *   NUMBER                          -> { number: number }
 *   SELECT | STATUS                 -> { optionId: string }
 *   MULTI_SELECT                    -> { optionIds: string[] }
 *   DATE                            -> { start: string; end?: string; includeTime?: boolean }
 *   CHECKBOX                        -> { checked: boolean }
 *   PEOPLE                          -> { names: string[] }
 *   FILES                           -> { files: { name: string; url: string; mimeType?: string }[] }
 *   RELATION                        -> { pageIds: string[] }
 */

async function authorizeDatabase(
  databasePageId: string,
): Promise<DatabaseAuth> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: databasePageId },
    select: { id: true, workspaceId: true, type: true },
  });
  if (!page || page.type !== "DATABASE") return { error: "Database not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return { error: "No access to this database." };
  return { page, access, user };
}

function revalidateDatabase(workspaceId: string) {
  revalidatePath("/w", "layout");
  void workspaceId;
}

export async function createPropertyAction(
  databasePageId: string,
  name: string,
  type: PropertyType,
): Promise<Result<{ id: string }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };

  const last = await prisma.property.findFirst({
    where: { databasePageId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const defaultConfig: Record<string, unknown> =
    type === "SELECT" || type === "MULTI_SELECT" || type === "STATUS"
      ? { options: [] }
      : type === "NUMBER"
        ? { format: "number" }
        : type === "FORMULA"
          ? { expression: "" }
          : type === "RELATION"
            ? { targetDatabaseId: null }
            : type === "ROLLUP"
              ? { relationPropertyId: null, targetPropertyId: null, function: "count" }
              : {};

  const property = await prisma.property.create({
    data: {
      databasePageId,
      name: name.trim().slice(0, 80) || "Property",
      type,
      position: (last?.position ?? 0) + 1000,
      config: defaultConfig as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, id: property.id };
}

export async function updatePropertyAction(
  propertyId: string,
  patch: { name?: string; config?: unknown },
): Promise<Result> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { databasePageId: true },
  });
  if (!property) return { error: "Property not found." };
  const auth = await authorizeDatabase(property.databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };

  await prisma.property.update({
    where: { id: propertyId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.slice(0, 80) } : {}),
      ...(patch.config !== undefined
        ? { config: patch.config as Prisma.InputJsonValue }
        : {}),
    },
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true };
}

export async function deletePropertyAction(
  propertyId: string,
): Promise<Result> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { databasePageId: true },
  });
  if (!property) return { error: "Property not found." };
  const auth = await authorizeDatabase(property.databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };
  await prisma.property.delete({ where: { id: propertyId } });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true };
}

/**
 * Persist a column order: positions are rewritten from the client's visible
 * order (dense 1000-steps). Ids the client does not know are kept and pushed
 * to the end, so a stale tab can never drop a property someone else added.
 */
export async function reorderPropertiesAction(
  databasePageId: string,
  orderedIds: string[],
): Promise<Result> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };

  const existing = await prisma.property.findMany({
    where: { databasePageId },
    select: { id: true },
  });
  const known = new Set(existing.map((property) => property.id));
  const order = orderedIds.filter((id) => known.has(id));
  for (const property of existing) {
    if (!order.includes(property.id)) order.push(property.id);
  }

  await prisma.$transaction(
    order.map((id, index) =>
      prisma.property.update({
        where: { id },
        data: { position: (index + 1) * 1000 },
      }),
    ),
  );
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true };
}

export async function setPropertyValueAction(
  rowPageId: string,
  propertyId: string,
  value: unknown,
): Promise<Result> {
  const row = await prisma.page.findUnique({
    where: { id: rowPageId },
    select: { workspaceId: true, parentId: true },
  });
  if (!row) return { error: "Row not found." };
  const auth = await authorizeDatabase(row.parentId ?? "");
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };

  await prisma.propertyValue.upsert({
    where: { propertyId_pageId: { propertyId, pageId: rowPageId } },
    create: {
      propertyId,
      pageId: rowPageId,
      value: value as Prisma.InputJsonValue,
    },
    update: { value: value as Prisma.InputJsonValue },
  });

  // One activity line per property write: this is what the LAST_EDITED_BY
  // property surfaces as the row's last editor. An audit line must never
  // break the write it records, so failures are swallowed.
  try {
    await prisma.activity.create({
      data: {
        workspaceId: row.workspaceId,
        actorId: auth.user.id,
        action: "row.edited",
        targetType: "page",
        targetId: rowPageId,
      },
    });
  } catch {
    /* see above */
  }

  revalidateDatabase(row.workspaceId);
  return { ok: true };
}

export async function createRowAction(
  databasePageId: string,
  title = "",
): Promise<Result<{ id: string }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };

  const last = await prisma.page.findFirst({
    where: { parentId: databasePageId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const row = await prisma.page.create({
    data: {
      workspaceId: auth.page.workspaceId,
      parentId: databasePageId,
      title: title || "Untitled",
      createdById: auth.user.id,
      position: (last?.position ?? 0) + 1000,
    },
    select: { id: true },
  });

  const primary = await prisma.property.findFirst({
    where: { databasePageId },
    orderBy: { position: "asc" },
    select: { id: true, type: true },
  });
  if (primary) {
    await prisma.propertyValue.create({
      data: {
        propertyId: primary.id,
        pageId: row.id,
        value: { text: title || "" } as Prisma.InputJsonValue,
      },
    });
  }

  await dispatchWebhooks(auth.page.workspaceId, "row.created", {
    rowId: row.id,
    databasePageId,
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, id: row.id };
}

export async function deleteRowAction(rowId: string): Promise<Result> {
  const row = await prisma.page.findUnique({
    where: { id: rowId },
    select: { parentId: true, workspaceId: true },
  });
  if (!row?.parentId) return { error: "Row not found." };
  const auth = await authorizeDatabase(row.parentId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };
  // Soft delete: the row leaves every view (queries filter `deletedAt`) but
  // stays restorable from the database's "Deleted rows" panel and the
  // workspace trash.
  await prisma.page.update({
    where: { id: rowId },
    data: { deletedAt: new Date(), isArchived: true },
  });
  revalidateDatabase(row.workspaceId);
  return { ok: true };
}

/** Soft-deleted rows of one database, most recently deleted first. */
export async function listDeletedRowsAction(
  databasePageId: string,
): Promise<{ ok: true; rows: { id: string; title: string; icon: string | null; deletedAt: string }[] } | { error: string }> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  const rows = await prisma.page.findMany({
    where: { parentId: databasePageId, deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    take: 50,
    select: { id: true, title: true, icon: true, deletedAt: true },
  });
  return {
    ok: true,
    rows: rows.map((row) => ({
      id: row.id,
      title: row.title,
      icon: row.icon,
      deletedAt: row.deletedAt?.toISOString() ?? "",
    })),
  };
}

const VIEW_TYPES = [
  "TABLE",
  "BOARD",
  "LIST",
  "GALLERY",
  "CALENDAR",
  "TIMELINE",
  "CHART",
] as const;
type ViewType = (typeof VIEW_TYPES)[number];

function isViewType(value: unknown): value is ViewType {
  return typeof value === "string" && (VIEW_TYPES as readonly string[]).includes(value);
}

export async function createViewAction(
  databasePageId: string,
  type: "TABLE" | "BOARD" | "LIST" | "GALLERY" | "CALENDAR" | "TIMELINE" | "CHART",
  name: string,
): Promise<Result<{ id: string }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };
  const last = await prisma.databaseView.findFirst({
    where: { databasePageId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const view = await prisma.databaseView.create({
    data: {
      databasePageId,
      name,
      type,
      position: (last?.position ?? 0) + 1000,
    },
    select: { id: true },
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, id: view.id };
}

export async function updateViewAction(
  viewId: string,
  patch: { name?: string; type?: string; config?: unknown },
): Promise<Result> {
  const view = await prisma.databaseView.findUnique({
    where: { id: viewId },
    select: { databasePageId: true },
  });
  if (!view) return { error: "View not found." };
  const auth = await authorizeDatabase(view.databasePageId);
  if ("error" in auth) return auth;
  if (patch.type !== undefined && !isViewType(patch.type)) {
    return { error: "Unknown view type." };
  }
  await prisma.databaseView.update({
    where: { id: viewId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.slice(0, 80) } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      // Normalise on write: only the keys this build understands reach storage.
      ...(patch.config !== undefined
        ? { config: normalizeViewConfig(patch.config) as Prisma.InputJsonValue }
        : {}),
    },
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true };
}

/**
 * Duplicate a view: same type, same configuration (filters, sorts, visible
 * properties), a fresh name and the last position in the tab strip.
 */
export async function duplicateViewAction(
  viewId: string,
): Promise<Result<{ id: string }>> {
  const source = await prisma.databaseView.findUnique({
    where: { id: viewId },
    select: { id: true, databasePageId: true, name: true, type: true, config: true },
  });
  if (!source) return { error: "View not found." };
  const auth = await authorizeDatabase(source.databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };

  const last = await prisma.databaseView.findFirst({
    where: { databasePageId: source.databasePageId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const copy = await prisma.databaseView.create({
    data: {
      databasePageId: source.databasePageId,
      name: `${source.name} copy`.slice(0, 80),
      type: source.type,
      config: normalizeViewConfig(source.config) as Prisma.InputJsonValue,
      position: (last?.position ?? 0) + 1000,
    },
    select: { id: true },
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, id: copy.id };
}

/** Coerce a CSV cell into the JSON shape for a property type. */
function coerceCsvValue(
  raw: string,
  property: { type: PropertyType; config: unknown },
): Prisma.InputJsonValue | null {
  const options =
    (property.config as { options?: { id: string; name: string }[] } | null)?.options ?? [];
  const findOption = (name: string) =>
    options.find((o) => o.name.toLowerCase() === name.trim().toLowerCase())?.id;
  switch (property.type) {
    case "NUMBER": {
      // Display-formatted cells round-trip: "7.5%" → 0.075 (the percent
      // format stores the fraction), "$1,234.50" → 1234.5. A plain number in
      // a percent-formatted column is read as the percentage, exactly like
      // typing it into the cell.
      const text = raw.trim();
      const percentFormat =
        (property.config as { format?: string } | null)?.format === "percent";
      const numeric = Number(text.replace(/[%,$\s€£¥]/g, ""));
      if (!Number.isFinite(numeric)) return null;
      const asFraction = text.endsWith("%") || percentFormat;
      return { number: asFraction ? numeric / 100 : numeric };
    }
    case "CHECKBOX":
      return { checked: ["true", "yes", "1", "x", "✓"].includes(raw.toLowerCase()) };
    case "DATE":
      return { start: raw };
    case "SELECT":
    case "STATUS": {
      const id = findOption(raw);
      return id ? { optionId: id } : null;
    }
    case "MULTI_SELECT": {
      const ids = raw
        .split(",")
        .map((part) => findOption(part))
        .filter((id): id is string => Boolean(id));
      return ids.length ? { optionIds: ids } : null;
    }
    default:
      return { text: raw };
  }
}

/** Save a row's values as a reusable database template. */
export async function saveRowAsTemplateAction(
  databasePageId: string,
  rowId: string,
  name: string,
): Promise<Result<{ id: string }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };

  const row = await prisma.page.findUnique({
    where: { id: rowId },
    select: { icon: true, content: true, propertyValues: true },
  });
  if (!row) return { error: "Row not found." };

  const template = await prisma.template.create({
    data: {
      databasePageId,
      name: name.trim().slice(0, 80) || "Template",
      icon: row.icon,
      content: (row.content ?? undefined) as Prisma.InputJsonValue | undefined,
      config: {
        values: row.propertyValues.map((value) => ({
          propertyId: value.propertyId,
          value: value.value,
        })),
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, id: template.id };
}

/** Create a row from a saved template. */
export async function createRowFromTemplateAction(
  databasePageId: string,
  templateId: string,
): Promise<Result<{ id: string }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };

  const template = await prisma.template.findUnique({
    where: { id: templateId },
    select: { content: true, config: true, name: true, icon: true },
  });
  if (!template) return { error: "Template not found." };

  const last = await prisma.page.findFirst({
    where: { parentId: databasePageId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const row = await prisma.page.create({
    data: {
      workspaceId: auth.page.workspaceId,
      parentId: databasePageId,
      title: template.name,
      icon: template.icon,
      createdById: auth.user.id,
      position: (last?.position ?? 0) + 1000,
      content: (template.content ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    select: { id: true },
  });

  const configured = (template.config ?? {}) as {
    values?: { propertyId: string; value: unknown }[];
  };
  const values = configured.values ?? [];
  if (values.length > 0) {
    await prisma.propertyValue.createMany({
      data: values.map((entry) => ({
        propertyId: entry.propertyId,
        pageId: row.id,
        value: entry.value as Prisma.InputJsonValue,
      })),
    });
  }

  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, id: row.id };
}

export async function deleteTemplateAction(
  templateId: string,
): Promise<Result> {
  const template = await prisma.template.findUnique({
    where: { id: templateId },
    select: { databasePageId: true },
  });
  if (!template) return { error: "Template not found." };
  const auth = await authorizeDatabase(template.databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };
  await prisma.template.delete({ where: { id: templateId } });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true };
}

export type TemplateRecurrence = "daily" | "weekly" | "monthly";

/** Set or clear a template's recurrence (drives the cron materializer). */
export async function setTemplateRecurrenceAction(
  templateId: string,
  recurrence: TemplateRecurrence | null,
): Promise<Result> {
  const template = await prisma.template.findUnique({
    where: { id: templateId },
    select: { databasePageId: true },
  });
  if (!template) return { error: "Template not found." };
  const auth = await authorizeDatabase(template.databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };
  await prisma.template.update({
    where: { id: templateId },
    data: {
      recurrence: recurrence ?? null,
      nextRunAt: recurrence ? nextRunFor(recurrence) : null,
    },
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true };
}

/** Import rows into a database from CSV (first row = property names). */
export async function importCsvAction(
  databasePageId: string,
  csv: string,
): Promise<Result<{ created: number }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };

  const matrix = csvToMatrix(csv);
  if (matrix.length < 2) {
    return { error: "CSV needs a header row and at least one data row." };
  }

  const header = matrix[0].map((h) => h.trim());
  const properties = await prisma.property.findMany({
    where: { databasePageId },
    orderBy: { position: "asc" },
  });
  const byName = new Map(properties.map((p) => [p.name.toLowerCase(), p]));
  const columns = header.map((name) => byName.get(name.toLowerCase()) ?? null);
  const primary = properties.find((p) => p.config && (p.config as { primary?: boolean }).primary);
  const primaryIndex = primary
    ? header.findIndex((h) => h.toLowerCase() === primary.name.toLowerCase())
    : -1;

  const last = await prisma.page.findFirst({
    where: { parentId: databasePageId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  let position = (last?.position ?? 0) + 1000;
  let created = 0;

  for (const row of matrix.slice(1)) {
    if (row.every((cell) => cell.trim() === "")) continue;
    const title = (primaryIndex >= 0 ? row[primaryIndex] : row[0]) ?? "";
    const page = await prisma.page.create({
      data: {
        workspaceId: auth.page.workspaceId,
        parentId: databasePageId,
        title: title.trim() || "Untitled",
        createdById: auth.user.id,
        position,
      },
      select: { id: true },
    });
    position += 1000;

    const values: Prisma.PropertyValueCreateManyInput[] = [];
    for (let i = 0; i < columns.length; i += 1) {
      const property = columns[i];
      if (!property) continue;
      if (property.config && (property.config as { primary?: boolean }).primary) continue;
      const raw = (row[i] ?? "").trim();
      if (raw === "") continue;
      const value = coerceCsvValue(raw, property);
      if (value === null) continue;
      values.push({ propertyId: property.id, pageId: page.id, value });
    }
    if (values.length > 0) {
      await prisma.propertyValue.createMany({ data: values });
    }
    created += 1;
  }

  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, created };
}
