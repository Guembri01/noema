"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import type { Prisma, PropertyType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { pageSearchText } from "@/lib/search";
import { requireUser, type SessionUser } from "@/lib/auth";
import {
  getWorkspaceAccess,
  canEditContent,
  type WorkspaceAccess,
} from "@/lib/permissions";
import { guestReadablePageIds } from "@/lib/guest-access";
import { canEditSchema, type LockRole } from "@/lib/database-lock";
import { assertScopedParent } from "@/lib/page-parent";
import { csvToMatrix } from "@/lib/serialize";
import { coerceCsvValue, type CsvPropertyConfig } from "@/lib/csv-value-coercion";
import type { ImportCounts } from "@/lib/importers";
import { normalizeViewConfig } from "@/lib/database-query";
import {
  duplicateDatabase,
  remapReferences,
  validateCopy,
  type DatabaseStructure,
} from "@/lib/database-copy";
import { initializeRowValues } from "@/lib/property-defaults";
import { dispatchWebhooks } from "@/lib/webhooks";
import { nextRunFor } from "@/lib/recurrence";
import { ORDER_STEP } from "@/lib/row-order";
import { formatUniqueId, nextNumbers, type UniqueIdConfig } from "@/lib/unique-id";
import { fileUrlsAreAppOwned } from "@/lib/validation";

type Result<T = unknown> = ({ ok: true } & T) | { error: string };

type DatabaseAuth =
  | { error: string }
  | {
      page: {
        id: string;
        workspaceId: string;
        type: string;
        schemaLocked: boolean;
      };
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

/**
 * The roles that may read every page of a workspace. Everybody else — a
 * `GUEST`, and a role that is not a known workspace role at all — is scoped,
 * so the scope check in `authorizeDatabase` can never be skipped by a forged
 * role.
 */
const FULL_ACCESS_ROLES: ReadonlySet<string> = new Set(["OWNER", "ADMIN", "MEMBER"]);

async function authorizeDatabase(
  databasePageId: string,
): Promise<DatabaseAuth> {
  const user = await requireUser();
  const page = await prisma.page.findUnique({
    where: { id: databasePageId },
    select: { id: true, workspaceId: true, type: true, schemaLocked: true },
  });
  if (!page || page.type !== "DATABASE") return { error: "Database not found." };
  const access = await getWorkspaceAccess(user.id, page.workspaceId);
  if (!access) return { error: "No access to this database." };
  /**
   * A guest may read a database only inside their **read** scope: the pages
   * shared with them plus their whole subtree.
   *
   * The read scope is not the display scope (`pageScopeFor` /
   * `guestVisiblePageIds`): the display scope also carries the *ancestors* of
   * the shared pages, because the sidebar has to draw the breadcrumb chain
   * down to a shared child. The inheritance rule is the canonical one of
   * `src/lib/access-inheritance.ts` — a grant covers the page itself and its
   * descendants, never its ancestors — so a guest who was given a single row
   * of a database does not get the database above it, while a guest who was
   * given a parent page does get the database below it.
   *
   * The refusal is `Database not found.`, the same answer as for an id that
   * does not exist: a refusal must not confirm that the database exists (no
   * existence oracle). The check stands in front of the content query of every
   * action, so an out-of-scope database is never read.
   */
  if (access.role === "GUEST") {
    const readable = await guestReadablePageIds(user.id, page.workspaceId);
    if (!readable.has(databasePageId)) return { error: "Database not found." };
  } else if (!FULL_ACCESS_ROLES.has(access.role)) {
    // A role that is not a known workspace role gets no pages at all — it must
    // never widen the view (fail closed).
    return { error: "Database not found." };
  }
  return { page, access, user };
}

/**
 * The relation target named by an untrusted property config.
 *
 * `undefined` — the config names no target at all (`targetDatabaseId` absent,
 * `null` or blank: the relation is empty and nothing has to be resolved).
 * `null` — the config names a target that is not a database id (a number, an
 * object, …); it can never be resolved, so it is refused like a missing one.
 * Otherwise the trimmed id of the target.
 */
function relationTargetOf(config: unknown): string | null | undefined {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return undefined;
  }
  const raw = (config as { targetDatabaseId?: unknown }).targetDatabaseId;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id === "" ? undefined : id;
}

/**
 * B98 — a relation property may only point at a database of the *same*
 * workspace. `Property.config` is untrusted stored JSON and
 * `updatePropertyAction` persists it verbatim, so a `config.targetDatabaseId`
 * is resolved before it is written: the target must be a live
 * (`deletedAt: null`) database of the property's own workspace. A target that
 * is missing, deleted, not a database or belongs to another workspace is
 * answered with the module's own "Database not found." — the same answer for
 * a foreign and for a missing target, so the response is no existence oracle.
 */
async function relationTargetAllowed(
  targetDatabaseId: string,
  workspaceId: string,
): Promise<boolean> {
  const target = await prisma.page.findFirst({
    where: {
      id: targetDatabaseId,
      workspaceId,
      type: "DATABASE",
      deletedAt: null,
    },
    select: { id: true },
  });
  return target !== null;
}

/**
 * Reduce workspace access to the lock policy's role shape
 * (`src/lib/database-lock.ts`). Mirrors `lockRoleFor` in `pages.ts`: only the
 * owner keeps the locked-schema override, so the lock stays releasable.
 */
function lockRoleFor(role: NonNullable<WorkspaceAccess>["role"]): LockRole {
  return {
    isOwner: role === "OWNER",
    isMember: role === "ADMIN" || role === "MEMBER",
  };
}

/**
 * R89.23/R89.24 — the lock gate for *structural* database edits. A member may
 * change properties, views, templates and import while the database is
 * unlocked; `Page.schemaLocked` freezes all of it for them, while the owner
 * keeps access so the lock toggle stays reachable. Row and cell writes never
 * call this: the schema lock leaves values editable.
 *
 * Callers perform the role check first (the existing `canEditContent` guard),
 * so a denial here is always the schema lock and not a missing role.
 */
function schemaLockDenied(auth: {
  page: { schemaLocked: boolean };
  access: NonNullable<WorkspaceAccess>;
}): { error: string } | null {
  if (
    !canEditSchema(
      { locked: auth.page.schemaLocked },
      lockRoleFor(auth.access.role),
    )
  ) {
    return {
      error: "This database's schema is locked. Unlock it to change its structure.",
    };
  }
  return null;
}

function revalidateDatabase(workspaceId: string) {
  revalidatePath("/w", "layout");
  void workspaceId;
}

/**
 * R89.25 — Unique ID allocation for new rows.
 *
 * A database may carry several `UNIQUE_ID` columns and Notion numbers each of
 * them independently, so allocation is per property. The next number is
 * derived from the MAXIMUM id already stored for that property (`nextNumbers`),
 * never the row count, so deleting rows can never reuse an id.
 *
 * Each allocated cell stores both the numeric counter (`{ number }` — what the
 * read-only cell in `view-parts.tsx` formats with the property config) and the
 * human-readable id (`{ text }`). Existing cells are read back through the same
 * shapes, so pre-existing or hand-edited values keep allocating correctly.
 *
 * Out of scope for this slice: backfilling ids for rows that predate a Unique
 * ID property (a property added later only allocates on the next row created).
 */

/**
 * Does a stored property config carry an authored `default`? `initializeRowValues`
 * also yields empty container shapes for CHECKBOX, MULTI_SELECT, PEOPLE and FILES
 * even when no default was configured; a new row should only be seeded when
 * someone actually authored one, so this gates that call. Mirrors `readDefault`
 * in `property-options-editor.tsx` (`"default" in config`).
 */
function hasConfiguredDefault(config: Prisma.JsonValue | null): boolean {
  return (
    !!config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    "default" in config
  );
}

/** The `config.uniqueId` block of a property, or `{}` when absent/malformed. */
function readUniqueIdConfig(
  config: Prisma.JsonValue | null,
): Partial<UniqueIdConfig> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const uniqueId = (config as { uniqueId?: unknown }).uniqueId;
  if (!uniqueId || typeof uniqueId !== "object" || Array.isArray(uniqueId)) return {};
  return uniqueId as Partial<UniqueIdConfig>;
}

/**
 * Every id-shaped string a stored UNIQUE_ID cell contributes to `nextNumbers`.
 * Mirrors `uniqueIdNumber` in `view-parts.tsx`: the counter may live under any
 * of these keys, as a number or a digits-only string. Unparseable entries are
 * handed on unchanged — `nextNumbers` ignores them rather than throwing.
 */
function existingUniqueIds(
  values: (Prisma.JsonValue | null)[],
  config: UniqueIdConfig,
): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      out.push(value);
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    for (const key of ["number", "value", "text", "id"] as const) {
      const candidate = record[key];
      if (typeof candidate === "string") {
        out.push(candidate);
      } else if (
        typeof candidate === "number" &&
        Number.isInteger(candidate) &&
        candidate >= 1
      ) {
        out.push(formatUniqueId(config, candidate));
      }
    }
  }
  return out;
}

/** Allocate the next Unique ID for one property inside a row-create transaction. */
async function allocateUniqueIdValue(
  tx: Prisma.TransactionClient,
  propertyId: string,
  config: Partial<UniqueIdConfig>,
): Promise<Prisma.InputJsonValue> {
  const rows = await tx.propertyValue.findMany({
    where: { propertyId },
    select: { value: true },
  });
  // Resolve defaults exactly like the read-only cell so storage and display
  // never disagree; the engine sanitises any malformed optional field.
  const resolved: UniqueIdConfig = {
    prefix: typeof config.prefix === "string" ? config.prefix : "",
    ...(typeof config.zeroPad === "number" ? { zeroPad: config.zeroPad } : {}),
    ...(typeof config.startAt === "number" ? { startAt: config.startAt } : {}),
    ...(typeof config.separator === "string" ? { separator: config.separator } : {}),
  };
  const existing = existingUniqueIds(
    rows.map((row) => row.value),
    resolved,
  );
  const number = nextNumbers(resolved, existing, 1)[0];
  return { number, text: formatUniqueId(resolved, number) };
}

export async function createPropertyAction(
  databasePageId: string,
  name: string,
  type: PropertyType,
): Promise<Result<{ id: string }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

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
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

  // B98 — the relation target must be a database of this workspace.
  const target = relationTargetOf(patch.config);
  if (target !== undefined) {
    const allowed =
      target !== null && (await relationTargetAllowed(target, auth.page.workspaceId));
    if (!allowed) return { error: "Database not found." };
  }

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
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;
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
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

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

/**
 * Persist a manual row order: positions are rewritten from the client's visible
 * order on the same dense 1000-step `Page.position` scale `createRowAction`
 * and the row-order engine use (`ORDER_STEP`). `anchorRowId` is any row of the
 * target database — it only resolves the parent database and its permissions,
 * so the shared table/list renderer can persist without carrying the database
 * id. Ids the client does not know are kept and pushed to the end, so a stale
 * tab can never drop a row someone else added; unknown or soft-deleted ids are
 * ignored and duplicate ids are collapsed.
 */
export async function reorderRowsAction(
  anchorRowId: string,
  orderedRowIds: string[],
): Promise<Result> {
  const anchor = await prisma.page.findUnique({
    where: { id: anchorRowId },
    select: { parentId: true },
  });
  if (!anchor?.parentId) return { error: "Row not found." };
  const auth = await authorizeDatabase(anchor.parentId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };

  const existing = await prisma.page.findMany({
    // The rows belong to the database's workspace: a row that was linked across
    // the boundary before the fix (B08) is not this workspace's row, and
    // reordering must not write its `position` (a cross-tenant write).
    where: {
      parentId: anchor.parentId,
      workspaceId: auth.page.workspaceId,
      deletedAt: null,
    },
    orderBy: { position: "asc" },
    select: { id: true },
  });
  const known = new Set(existing.map((row) => row.id));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of orderedRowIds) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const row of existing) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      order.push(row.id);
    }
  }
  if (order.length === 0) return { ok: true };

  await prisma.$transaction(
    order.map((id, index) =>
      prisma.page.update({
        where: { id },
        data: { position: (index + 1) * ORDER_STEP },
      }),
    ),
  );
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true };
}

/**
 * Write one cell of a row.
 *
 * A FILES value may only point at the app's own uploaded assets, so every
 * stored file URL must be an app-owned `/api/files/...` path. A value that
 * carries any other URL (a `javascript:` one, an absolute `http(s)://` one,
 * a traversal attempt) is refused here, so a hostile URL never reaches the
 * table. Values without a `files` array are not FILES values and are left
 * untouched.
 */
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
  if (!fileUrlsAreAppOwned(value)) {
    return { error: "That file link is not allowed." };
  }

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

  // R89.25: the row, its primary cell and every UNIQUE_ID allocation commit or
  // roll back together, so a crash can never leave a row without its id.
  const rowId = await prisma.$transaction(async (tx) => {
    const last = await tx.page.findFirst({
      where: { parentId: databasePageId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const rowTitle = title || "Untitled";
    const row = await tx.page.create({
      data: {
        workspaceId: auth.page.workspaceId,
        // The parent is the database page `authorizeDatabase` just checked and
        // the row is written into that very page's workspace — parent and row
        // share one workspace by construction, so no second lookup is needed
        // (B08: `assertScopedParent` would be redundant here).
        parentId: databasePageId,
        title: rowTitle,
        createdById: auth.user.id,
        position: (last?.position ?? 0) + 1000,
        // Keep the search mirror in step from the first write, so a fresh row
        // is discoverable without waiting for a later save or `setup:search`.
        searchText: pageSearchText(rowTitle, null),
      },
      select: { id: true },
    });

    const properties = await tx.property.findMany({
      where: { databasePageId },
      orderBy: { position: "asc" },
      select: { id: true, type: true, config: true },
    });

    // One cell per property: the primary text cell yields to a Unique ID
    // allocation when the primary column is itself a UNIQUE_ID property, and
    // every UNIQUE_ID column gets a fresh id derived from its own stored
    // values (multiple Unique ID properties number independently).
    const values = new Map<string, Prisma.InputJsonValue>();
    const primary = properties[0];
    if (primary && primary.type !== "UNIQUE_ID") {
      values.set(primary.id, { text: title || "" });
    }
    for (const property of properties) {
      if (property.type !== "UNIQUE_ID") continue;
      values.set(
        property.id,
        await allocateUniqueIdValue(
          tx,
          property.id,
          readUniqueIdConfig(property.config),
        ),
      );
    }

    // An authored `config.default` seeds the fresh row (e.g. a Status, Number or
    // Date starting value), unless the primary text cell or a UNIQUE_ID
    // allocation already owns that column — the same override order the read-only
    // grid uses. `initializeRowValues` validates each stored config and omits
    // computed types, so a malformed config can never break row creation.
    for (const seeded of initializeRowValues(
      properties.filter(
        (property) =>
          !values.has(property.id) && hasConfiguredDefault(property.config),
      ),
    )) {
      values.set(seeded.propertyId, seeded.value as Prisma.InputJsonValue);
    }
    if (values.size > 0) {
      await tx.propertyValue.createMany({
        data: [...values].map(([propertyId, value]) => ({
          propertyId,
          pageId: row.id,
          value,
        })),
      });
    }
    return row.id;
  });

  await dispatchWebhooks(auth.page.workspaceId, "row.created", {
    rowId,
    databasePageId,
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, id: rowId };
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
    // The rows belong to the database's workspace: a row that was linked
    // across the boundary before the fix (B08) is not this workspace's row and
    // must not show its title in the "Deleted rows" panel.
    where: {
      parentId: databasePageId,
      workspaceId: auth.page.workspaceId,
      deletedAt: { not: null },
    },
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
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;
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
  if (!canEditContent(auth.access.role)) return { error: "No permission." };
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;
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
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

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

/**
 * Option ids a property config declares, in storage order. Mirrors the
 * `optionsOf` walk the copy planner uses, so pairing source and copy options by
 * index reconstructs the exact old→new ids for template cells.
 */
function configOptionIds(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const options = (config as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  const ids: string[] = [];
  for (const option of options) {
    if (
      option &&
      typeof option === "object" &&
      typeof (option as { id?: unknown }).id === "string"
    ) {
      ids.push((option as { id: string }).id);
    }
  }
  return ids;
}

/**
 * The old→new id map the copy planner applied. It remaps properties (and their
 * options), views and rows while preserving array order, so pairing the source
 * snapshot with its finished copy by index yields the same mapping — which lets
 * templates (entities the planner does not know about) follow their database.
 */
function copiedIdMap(
  source: DatabaseStructure,
  copy: DatabaseStructure,
): Map<string, string> {
  const map = new Map<string, string>();
  const pair = (before: unknown, after: unknown) => {
    if (
      typeof before === "string" &&
      before &&
      typeof after === "string" &&
      after
    ) {
      map.set(before, after);
    }
  };
  source.properties.forEach((property, index) => {
    const cloned = copy.properties[index];
    pair(property.id, cloned?.id);
    const options = configOptionIds(property.config);
    const clonedOptions = configOptionIds(cloned?.config);
    options.forEach((id, position) => pair(id, clonedOptions[position]));
  });
  source.views.forEach((view, index) => pair(view.id, copy.views[index]?.id));
  source.rows.forEach((row, index) => pair(row.id, copy.rows[index]?.id));
  return map;
}

/**
 * R89.22 — Duplicate a database "with structure".
 *
 * A fresh DATABASE page is appended under the same parent, then every property
 * (and each select/status option), view, row and saved template is cloned
 * through `src/lib/database-copy.ts`: fresh ids are allocated for all of them and
 * every reference *inside* the copied set — option ids in configs and cells,
 * property ids in views/cells/template values, relation targets pointing at a
 * copied row — is rewritten to the new id. References to entities outside the
 * database (other databases, rows they own, external relation targets) are
 * preserved verbatim, and `validateCopy` is the safety net before anything is
 * written.
 *
 * The new page, its properties, views, rows, their cell values and its templates
 * commit or roll back as one transaction; row bodies (`content`) and template
 * bodies, recurrence and schedule are carried over too.
 */
export async function duplicateDatabaseAction(
  databasePageId: string,
): Promise<Result<{ id: string }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

  const source = await prisma.page.findUnique({
    where: { id: databasePageId },
    select: { parentId: true, title: true, icon: true },
  });
  if (!source) return { error: "Database not found." };

  // The clone lands as a sibling of the source, so it keeps the source's own
  // parent. The source row proves that the *database* lives in this
  // workspace, not that its parent does — check that one link before the
  // clone is written (B08).
  const parent = await assertScopedParent({
    workspaceId: auth.page.workspaceId,
    parentId: source.parentId,
  });
  if ("error" in parent) return parent;

  const databaseTitle = `${source.title || "Untitled"} copy`.slice(0, 80);

  const [properties, views, rows, templates] = await Promise.all([
    prisma.property.findMany({
      where: { databasePageId },
      orderBy: { position: "asc" },
    }),
    prisma.databaseView.findMany({
      where: { databasePageId },
      orderBy: { position: "asc" },
    }),
    prisma.page.findMany({
      // The rows belong to the database's workspace. A row that was linked
      // across the boundary before the fix (B08) is still in the table — the
      // clone would copy its title, its body and its cell values into another
      // tenant, so the read is filtered by the workspace (B08).
      where: {
        parentId: databasePageId,
        workspaceId: auth.page.workspaceId,
        deletedAt: null,
      },
      orderBy: { position: "asc" },
      include: { propertyValues: { select: { propertyId: true, value: true } } },
    }),
    prisma.template.findMany({
      where: { databasePageId },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // The structural snapshot the copy planner works on: only what a faithful
  // clone needs, so the remap never touches unrelated page metadata.
  const structure: DatabaseStructure = {
    properties: properties.map((property) => ({
      id: property.id,
      name: property.name,
      type: property.type,
      config: (property.config ?? null) as Record<string, unknown> | null,
      position: property.position,
    })),
    views: views.map((view) => ({
      id: view.id,
      name: view.name,
      type: view.type,
      config: (view.config ?? null) as Record<string, unknown> | null,
      position: view.position,
    })),
    rows: rows.map((row) => ({
      id: row.id,
      title: row.title,
      icon: row.icon,
      content: row.content,
      position: row.position,
      propertyValues: row.propertyValues.map((value) => ({
        propertyId: value.propertyId,
        value: value.value,
      })),
    })),
  };

  const copy = duplicateDatabase(structure, () => randomUUID());
  const validation = validateCopy(structure, copy);
  if (!validation.ok) {
    return {
      error: `Could not duplicate database: ${validation.errors.join("; ")}`,
    };
  }

  // Ids are allocated before the transaction so every child row can be built
  // in one `createMany` per model. `null` JSON columns stay unset (their DB
  // default) instead of being written as a JSON `null`.
  const newPageId = randomUUID();
  const asJson = (value: unknown): Prisma.InputJsonValue | undefined =>
    value == null ? undefined : (value as Prisma.InputJsonValue);

  const propertyRows: Prisma.PropertyCreateManyInput[] = copy.properties.map(
    (property) => {
      const config = asJson(property.config);
      return {
        id: property.id,
        databasePageId: newPageId,
        name: typeof property.name === "string" ? property.name : "Property",
        type: property.type as PropertyType,
        position: typeof property.position === "number" ? property.position : 0,
        ...(config !== undefined ? { config } : {}),
      };
    },
  );

  const viewRows: Prisma.DatabaseViewCreateManyInput[] = copy.views.map((view) => {
    const config = asJson(view.config);
    return {
      id: view.id,
      databasePageId: newPageId,
      name: typeof view.name === "string" && view.name ? view.name : "View",
      type: view.type as Prisma.DatabaseViewCreateManyInput["type"],
      position: typeof view.position === "number" ? view.position : 0,
      ...(config !== undefined ? { config } : {}),
    };
  });

  const rowPages: Prisma.PageCreateManyInput[] = copy.rows.map((row) => {
    const content = asJson(row.content);
    const title = typeof row.title === "string" ? row.title : "Untitled";
    return {
      id: row.id,
      workspaceId: auth.page.workspaceId,
      // The parent is the clone's own database page, created in this same
      // transaction with the same workspace id — inside the workspace by
      // construction (B08: `assertScopedParent` would be redundant here).
      parentId: newPageId,
      title,
      icon: typeof row.icon === "string" ? row.icon : null,
      createdById: auth.user.id,
      position: typeof row.position === "number" ? row.position : 0,
      // The clone must be searchable the moment it lands, exactly like the
      // source it was copied from.
      searchText: pageSearchText(title, row.content),
      ...(content !== undefined ? { content } : {}),
    };
  });

  const cellRows: Prisma.PropertyValueCreateManyInput[] = copy.rows.flatMap((row) =>
    row.propertyValues.map((cell) => {
      const value = asJson(cell.value);
      return {
        propertyId: cell.propertyId,
        pageId: row.id,
        ...(value !== undefined ? { value } : {}),
      };
    }),
  );

  // Templates are outside the copy planner's `DatabaseStructure`, so their
  // property/option/row references are remapped through the ids the planner
  // assigned. Each copy gets a fresh id and lands under the new database; name,
  // icon, body, recurrence and schedule are carried over verbatim.
  const templateIdMap = copiedIdMap(structure, copy);
  const templateRows: Prisma.TemplateCreateManyInput[] = templates.map(
    (template) => {
      const config = asJson(remapReferences(template.config, templateIdMap));
      const content = asJson(template.content);
      return {
        id: randomUUID(),
        databasePageId: newPageId,
        name: template.name,
        icon: template.icon,
        recurrence: template.recurrence,
        nextRunAt: template.nextRunAt,
        ...(content !== undefined ? { content } : {}),
        ...(config !== undefined ? { config } : {}),
      };
    },
  );

  await prisma.$transaction(async (tx) => {
    const last = await tx.page.findFirst({
      where: { parentId: parent.parentId, deletedAt: null },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    await tx.page.create({
      data: {
        id: newPageId,
        workspaceId: auth.page.workspaceId,
        // The clone keeps the (validated) parent of the source database; the
        // clone's own rows hang under the clone (same workspace).
        parentId: parent.parentId,
        type: "DATABASE",
        title: databaseTitle,
        icon: source.icon,
        createdById: auth.user.id,
        position: (last?.position ?? 0) + 1000,
        searchText: pageSearchText(databaseTitle, null),
      },
    });
    if (propertyRows.length > 0) await tx.property.createMany({ data: propertyRows });
    if (viewRows.length > 0) await tx.databaseView.createMany({ data: viewRows });
    if (rowPages.length > 0) await tx.page.createMany({ data: rowPages });
    if (cellRows.length > 0) await tx.propertyValue.createMany({ data: cellRows });
    if (templateRows.length > 0) await tx.template.createMany({ data: templateRows });
  });

  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, id: newPageId };
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
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

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
      // The parent is the database page `authorizeDatabase` just checked and
      // the row is written into that very page's workspace — parent and row
      // share one workspace by construction (B08: `assertScopedParent` would
      // be redundant here).
      parentId: databasePageId,
      title: template.name,
      icon: template.icon,
      createdById: auth.user.id,
      position: (last?.position ?? 0) + 1000,
      content: (template.content ?? undefined) as Prisma.InputJsonValue | undefined,
      // A row materialized from a template carries that template's body, so
      // index title and body together from the first write.
      searchText: pageSearchText(template.name, template.content),
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
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;
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
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;
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

/**
 * R31.15 — mark one template as the database's default (or clear the default).
 *
 * `isDefault` is a single slot per database, so setting it clears every other
 * template in the same transaction: a half-written state where two templates
 * are default can never be observed. Passing `false` clears the slot without
 * naming a new holder. A structural edit, so `canEditSchema` gates it.
 */
export async function setDefaultTemplateAction(
  templateId: string,
  isDefault = true,
): Promise<Result> {
  const template = await prisma.template.findUnique({
    where: { id: templateId },
    select: { databasePageId: true },
  });
  if (!template) return { error: "Template not found." };
  const auth = await authorizeDatabase(template.databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

  await prisma.$transaction([
    prisma.template.updateMany({
      where: { databasePageId: template.databasePageId },
      data: { isDefault: false },
    }),
    ...(isDefault
      ? [
          prisma.template.update({
            where: { id: templateId },
            data: { isDefault: true },
          }),
        ]
      : []),
  ]);
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true };
}

/**
 * Persist a template order: positions are rewritten from the client's visible
 * order on the same dense 1000-step scale the property/view reorder actions
 * use. Ids the client does not know are kept and pushed to the end, so a stale
 * tab can never drop a template someone else added; unknown and duplicate ids
 * are ignored. A structural edit, so `canEditSchema` gates it.
 */
export async function reorderTemplatesAction(
  databasePageId: string,
  orderedIds: string[],
): Promise<Result> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

  const existing = await prisma.template.findMany({
    where: { databasePageId },
    select: { id: true },
  });
  const known = new Set(existing.map((template) => template.id));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of orderedIds) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const template of existing) {
    if (!seen.has(template.id)) {
      seen.add(template.id);
      order.push(template.id);
    }
  }
  if (order.length === 0) return { ok: true };

  await prisma.$transaction(
    order.map((id, index) =>
      prisma.template.update({
        where: { id },
        data: { position: (index + 1) * 1000 },
      }),
    ),
  );
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true };
}

/** Import rows into a database from CSV (first row = property names). */
export async function importCsvAction(
  databasePageId: string,
  csv: string,
): Promise<Result<{ created: number; counts: ImportCounts }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!canEditContent(auth.access.role)) return { error: "No permission." };
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

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

  // B71 / D23.1: honest counts — header cells that match no property are
  // skipped (counted once per column) and cells that fail coercion are
  // counted per cell. Both were silent drops before this change.
  const skippedColumns = columns.filter((property) => property === null).length;
  let skippedCells = 0;
  let created = 0;

  try {
    // R23.6: rows + values commit or roll back as one unit.
    await prisma.$transaction(async (tx) => {
      const last = await tx.page.findFirst({
        where: { parentId: databasePageId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      let position = (last?.position ?? 0) + 1000;

      for (const row of matrix.slice(1)) {
        if (row.every((cell) => cell.trim() === "")) continue;
        const title = (primaryIndex >= 0 ? row[primaryIndex] : row[0]) ?? "";
        const rowTitle = title.trim() || "Untitled";
        const page = await tx.page.create({
          data: {
            workspaceId: auth.page.workspaceId,
            // The parent is the database page `authorizeDatabase` just checked
            // and the row is written into that very page's workspace — parent
            // and row share one workspace by construction (B08:
            // `assertScopedParent` would be redundant here).
            parentId: databasePageId,
            title: rowTitle,
            createdById: auth.user.id,
            position,
            searchText: pageSearchText(rowTitle, null),
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
          const value = coerceCsvValue(
            raw,
            property.type,
            property.config as CsvPropertyConfig | null,
          );
          if (value === null) {
            skippedCells += 1;
            continue;
          }
          values.push({ propertyId: property.id, pageId: page.id, value });
        }
        if (values.length > 0) {
          await tx.propertyValue.createMany({ data: values });
        }
        created += 1;
      }
    });
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message ? error.message : "CSV import failed.",
    };
  }

  revalidateDatabase(auth.page.workspaceId);
  return {
    ok: true,
    created,
    counts: { imported: created, skippedColumns, skippedCells, failed: 0 },
  };
}
