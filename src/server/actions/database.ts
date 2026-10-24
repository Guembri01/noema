"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import type { Prisma, PropertyType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/activity";
import { pageSearchText } from "@/lib/search";
import { requireUser, type SessionUser } from "@/lib/auth";
import {
  getWorkspaceAccess,
  type WorkspaceAccess,
} from "@/lib/permissions";
import { pageCapabilitiesFromRelation, type PageCapabilities } from "@/lib/page-access";
import { guestReadablePageIds } from "@/lib/guest-access";
import { canEditSchema, type LockRole } from "@/lib/database-lock";
import { wouldCreateCycle, type DependencyEdge } from "@/lib/dependencies";
import { assertEditableParent } from "@/lib/page-parent";
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
import { dispatchWebhooks } from "@/lib/webhooks";
import { nextRunFor } from "@/lib/recurrence";
import { ORDER_STEP } from "@/lib/row-order";
import { createRowCellsInTransaction } from "@/server/row-cells";
import { fileUrlsAreAppOwned } from "@/lib/validation";
import { validateCell } from "@/lib/cell-validation";
import {
  buildInverseBackfill,
  normalizeRelationConfig,
  normalizeRelationPageIds,
  nextInversePageIds,
} from "@/lib/relation-config";
import { normalizeRollupConfig, validateRollupConfig } from "@/lib/rollup-config";
import { parseFormula } from "@/lib/formula";
import {
  buildFormSchema,
  isAnswerablePropertyType,
  parseFormSchema,
  toRowValues,
  validateFormSchema,
  validateSubmission,
  type FormSchema,
} from "@/lib/form-view";
import {
  checkRateLimit,
  checkUserRateLimit,
  clientKeyFromHeaders,
  userKey,
} from "@/lib/rate-limit";

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
      /** Effective page rights after the page-level restriction row. */
      capabilities: PageCapabilities;
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
    select: {
      id: true,
      workspaceId: true,
      type: true,
      schemaLocked: true,
      permissions: {
        where: { userId: user.id },
        select: { level: true },
        take: 1,
      },
    },
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
   * down to a shared child. The read scope is the guest rule of
   * `src/lib/guest-access.ts` — a grant covers the page itself and its
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
  return {
    page,
    access,
    user,
    capabilities: pageCapabilitiesFromRelation(access.role, page.permissions),
  };
}

/**
 * The relation target named by an untrusted property config — and the config
 * as it has to be stored.
 *
 * `target` —
 * `undefined`: the config names no target at all (`targetDatabaseId` absent,
 *   `null` or blank: the relation is empty and nothing has to be resolved);
 * `null`: the config names a target that is not a database id (a number, an
 *   object, …); it can never be resolved, so it is refused like a missing one;
 * otherwise the trimmed id of the target.
 *
 * `config` — the config with its `targetDatabaseId` normalized: the **trimmed**
 * id (a blank id becomes `null`, an id that is not an id becomes `null` too).
 *
 * This is the one place the id is normalized. The target that is checked and
 * the target that is stored are the same string, so a configuration can never
 * be checked against one id and stored with another — the read path resolves
 * exactly the id the write path checked.
 */
function relationTargetOf(config: unknown): {
  target: string | null | undefined;
  config: unknown;
} {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return { target: undefined, config };
  }
  const record = config as Record<string, unknown>;
  const raw = record.targetDatabaseId;
  if (raw === undefined || raw === null) return { target: undefined, config };
  if (typeof raw !== "string") {
    // Not a database id — it can never be resolved.
    return { target: null, config: { ...record, targetDatabaseId: null } };
  }
  const id = raw.trim();
  if (id === "") {
    // A blank id names no target.
    return { target: undefined, config: { ...record, targetDatabaseId: null } };
  }
  return { target: id, config: { ...record, targetDatabaseId: id } };
}

/**
 * B98 — a relation property may only point at a database of the *same*
 * workspace. `Property.config` is untrusted stored JSON, so a
 * `config.targetDatabaseId` is resolved before it is written: the target must
 * be a live (`deletedAt: null`) database of the property's own workspace. A
 * target that is missing, deleted, not a database or belongs to another
 * workspace is answered with the module's own "Database not found." — the same
 * answer for a foreign and for a missing target, so the response is no
 * existence oracle.
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
 * B98 — the relation target a **copied** property may carry.
 *
 * A copy lives in the workspace of its source, so a target of that workspace
 * stays valid and is carried over. A target that does not pass the check — a
 * foreign database, a deleted one, a missing one, an id that is not an id — is
 * **cleared**: the copy must not carry a relation that the write side would
 * refuse.
 *
 * Cleared means `targetDatabaseId: null`, the module's own wording for "a
 * relation without a target" (`createPropertyAction` writes exactly that) and
 * the value the spec gives the field (`relations-rollups.md` R21.1): the key
 * stays in the config, the relation is empty and can be pointed at a target of
 * this workspace again.
 */
async function relationConfigForWorkspace(
  config: unknown,
  workspaceId: string,
): Promise<unknown> {
  const { target, config: normalized } = relationTargetOf(config);
  if (target === undefined || target === null) return normalized;
  if (await relationTargetAllowed(target, workspaceId)) return normalized;
  return { ...(normalized as Record<string, unknown>), targetDatabaseId: null };
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
 * Callers perform the page capability check first (`auth.capabilities.edit`),
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

export async function createPropertyAction(
  databasePageId: string,
  name: string,
  type: PropertyType,
): Promise<Result<{ id: string }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!auth.capabilities.edit) return { error: "No permission." };
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
            ? { targetDatabaseId: null, multi: true, inversePropertyId: null }
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
    select: { databasePageId: true, type: true, config: true },
  });
  if (!property) return { error: "Property not found." };
  const auth = await authorizeDatabase(property.databasePageId);
  if ("error" in auth) return auth;
  if (!auth.capabilities.edit) return { error: "No permission." };
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

  let nextConfig = patch.config;
  let inverseSync: { id: string; config: Prisma.InputJsonValue } | null = null;

  if (patch.config !== undefined) {
    if (property.type === "RELATION") {
      // R21.1/R21.2 - store the canonical relation shape and refuse a target
      // that is not a live database of this workspace. The trimmed id that is
      // checked is the id that is stored.
      const normalized = normalizeRelationConfig(patch.config);
      if (normalized.targetDatabaseId !== null) {
        const allowed = await relationTargetAllowed(
          normalized.targetDatabaseId,
          auth.page.workspaceId,
        );
        if (!allowed) return { error: "Database not found." };
      }

      // A reciprocal id is only meaningful while it names a RELATION property
      // of this relation's target database that points back here. A stale id
      // is refused rather than persisted (the pair action clears/creates it).
      if (normalized.inversePropertyId !== null) {
        const target = normalized.targetDatabaseId;
        if (target === null) return { error: "Configure the relation first." };
        const inverse = await prisma.property.findFirst({
          where: {
            id: normalized.inversePropertyId,
            databasePageId: target,
            type: "RELATION",
          },
          select: { id: true, config: true },
        });
        const inverseConfig = normalizeRelationConfig(inverse?.config);
        if (!inverse || inverseConfig.targetDatabaseId !== property.databasePageId) {
          return { error: "Relation pair not found." };
        }
        if (
          inverseConfig.inversePropertyId !== null &&
          inverseConfig.inversePropertyId !== propertyId
        ) {
          return { error: "Relation pair not found." };
        }
        // Repair a half-pair and keep cardinality coherent: changing one side
        // must not leave the reciprocal column pointing elsewhere or on a
        // different setting.
        if (
          inverseConfig.inversePropertyId !== propertyId ||
          inverseConfig.multi !== normalized.multi
        ) {
          inverseSync = {
            id: inverse.id,
            config: {
              ...inverseConfig,
              inversePropertyId: propertyId,
              multi: normalized.multi,
            } as Prisma.InputJsonValue,
          };
        }
      }
      nextConfig = normalized;
    } else if (property.type === "ROLLUP") {
      // R21.10 - validate the triple against the live schema before storing it.
      const normalized = normalizeRollupConfig(patch.config);
      const relation = normalized.relationPropertyId
        ? await prisma.property.findFirst({
            where: {
              id: normalized.relationPropertyId,
              databasePageId: property.databasePageId,
              type: "RELATION",
            },
            select: { id: true, name: true, type: true, config: true },
          })
        : null;
      const targetDatabaseId = normalizeRelationConfig(relation?.config)
        .targetDatabaseId;
      if (targetDatabaseId) {
        const targetDatabase = await prisma.page.findFirst({
          where: {
            id: targetDatabaseId,
            workspaceId: auth.page.workspaceId,
            type: "DATABASE",
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!targetDatabase) return { error: "Database not found." };
      }
      const targetProperties = targetDatabaseId
        ? await prisma.property.findMany({
            where: { databasePageId: targetDatabaseId },
            select: { id: true, name: true, type: true, config: true },
          })
        : [];
      const properties = [
        ...(relation
          ? [{ ...relation, databaseId: property.databasePageId }]
          : []),
        ...targetProperties.map((candidate) => ({
          ...candidate,
          databaseId: targetDatabaseId ?? undefined,
        })),
      ];
      const issues = validateRollupConfig(normalized, properties);
      if (issues.length > 0) return { error: issues[0].message };
      const raw = (patch.config ?? {}) as Record<string, unknown>;
      nextConfig = {
        relationPropertyId: normalized.relationPropertyId,
        targetPropertyId: normalized.targetPropertyId,
        function: normalized.aggregateFn,
        ...(typeof raw.separator === "string" ? { separator: raw.separator } : {}),
      };
    } else if (property.type === "FORMULA") {
      // R21.15 - an unparseable expression is never persisted. The editor uses
      // the same parser for its live error line.
      const raw = (patch.config ?? {}) as Record<string, unknown>;
      const expression = typeof raw.expression === "string" ? raw.expression : "";
      const parsed = parseFormula(expression);
      if (!parsed.ok) return { error: parsed.error };
      nextConfig = { ...raw, expression };
    }
  }

  if (inverseSync) {
    await prisma.$transaction(async (tx) => {
      await tx.property.update({
        where: { id: propertyId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name.slice(0, 80) } : {}),
          ...(nextConfig !== undefined
            ? { config: nextConfig as Prisma.InputJsonValue }
            : {}),
        },
      });
      await tx.property.update({
        where: { id: inverseSync.id },
        data: { config: inverseSync.config },
      });
    });
  } else {
    await prisma.property.update({
      where: { id: propertyId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.slice(0, 80) } : {}),
        ...(nextConfig !== undefined
          ? { config: nextConfig as Prisma.InputJsonValue }
          : {}),
      },
    });
  }
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
  if (!auth.capabilities.edit) return { error: "No permission." };
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
  if (!auth.capabilities.edit) return { error: "No permission." };
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
  if (!auth.capabilities.edit) return { error: "No permission." };

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
    select: {
      workspaceId: true,
      parentId: true,
      permissions: { select: { userId: true, level: true } },
    },
  });
  if (!row) return { error: "Row not found." };
  const auth = await authorizeDatabase(row.parentId ?? "");
  if ("error" in auth) return auth;
  // B96: the row has to belong into the same workspace as the database it
  // hangs under. A row that was linked across the boundary before the
  // workspace check existed keeps a foreign `workspaceId`; the read side
  // filters such a row out of every view, so it must not be written either —
  // otherwise a member of the database's workspace writes a cell value into
  // another workspace's row and the activity entry is filed under that
  // foreign workspace.
  //
  // The check runs *before* the role check so the answer for such a row is
  // character-for-character the answer for a row that does not exist
  // ("Row not found."): the caller must not learn that the row is there —
  // neither as a member nor as a guest.
  if (row.workspaceId !== auth.page.workspaceId) {
    return { error: "Row not found." };
  }
  if (!auth.capabilities.edit) return { error: "No permission." };
  // A page-level restriction may also sit on the row itself: the database may
  // be editable while this one row is READ/COMMENT. The row check runs after
  // the workspace check so a foreign row still answers "Row not found.".
  const rowPermissions = (row.permissions ?? []).filter(
    (permission) => permission.userId === auth.user.id,
  );
  if (!pageCapabilitiesFromRelation(auth.access.role, rowPermissions).edit) {
    return { error: "No permission." };
  }
  if (!fileUrlsAreAppOwned(value)) {
    return { error: "That file link is not allowed." };
  }

  // B99: the cell belongs to a column of the row's **own** database — the
  // same database the call was authorised against (`auth.page` is the
  // database of `row.parentId`). The property id arrives from the client and
  // used to be written into the table unchecked, so a member of workspace A
  // could file a value under a column of a database in workspace B: the
  // value is invisible in B (B reads its rows by `pageId`), but it hijacks
  // the UNIQUE_ID counter of that foreign column.
  //
  // The refusal is the same as for a property id that does not exist
  // ("Property not found."), so the caller learns nothing about the foreign
  // id — no existence oracle.
  const property = await prisma.property.findFirst({
    where: { id: propertyId, databasePageId: auth.page.id },
    select: { id: true, type: true, config: true },
  });
  if (!property) return { error: "Property not found." };

  if (property.type === "RELATION") {
    // R21.3 - a relation value is not an arbitrary id list. The target must be
    // configured, every id must resolve to a live row of that target database
    // in this workspace, and a single relation is clamped to its first id.
    const config = normalizeRelationConfig(property.config);
    if (!config.targetDatabaseId) return { error: "Configure the relation first." };
    const target = await prisma.page.findFirst({
      where: {
        id: config.targetDatabaseId,
        workspaceId: row.workspaceId,
        type: "DATABASE",
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!target) return { error: "Database not found." };

    const requested = normalizeRelationPageIds(value, true);
    if (requested === null) return { error: "Relation value is not valid." };
    // A row can never link itself, even in a self-relation.
    const candidates = requested.filter((id) => id !== rowPageId);
    const rows = candidates.length
      ? await prisma.page.findMany({
          where: {
            id: { in: candidates },
            parentId: target.id,
            workspaceId: row.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        })
      : [];
    const valid = new Set(rows.map((entry) => entry.id));
    const nextIds = candidates.filter((id) => valid.has(id));
    const clamped = config.multi ? nextIds : nextIds.slice(0, 1);

    const touched = await prisma.$transaction(async (tx) => {
      const current = await tx.propertyValue.findUnique({
        where: { propertyId_pageId: { propertyId, pageId: rowPageId } },
        select: { value: true },
      });
      const currentIds = normalizeRelationPageIds(current?.value, true) ?? [];
      await tx.propertyValue.upsert({
        where: { propertyId_pageId: { propertyId, pageId: rowPageId } },
        create: {
          propertyId,
          pageId: rowPageId,
          value: { pageIds: clamped } as Prisma.InputJsonValue,
        },
        update: { value: { pageIds: clamped } as Prisma.InputJsonValue },
      });

      const affected = new Set<string>([rowPageId]);
      if (config.inversePropertyId) {
        const inverse = await tx.property.findFirst({
          where: {
            id: config.inversePropertyId,
            databasePageId: target.id,
            type: "RELATION",
          },
          select: { id: true, config: true },
        });
        if (inverse) {
          const inverseConfig = normalizeRelationConfig(inverse.config);
          if (
            inverseConfig.targetDatabaseId !== auth.page.id ||
            (inverseConfig.inversePropertyId !== null &&
              inverseConfig.inversePropertyId !== property.id)
          ) {
            // A stale half-pair must not receive reciprocal writes. The source
            // write still lands; the pair can be repaired from the header.
            return [...affected];
          }
          const inverseMulti = inverseConfig.multi;
          const added = clamped.filter((id) => !currentIds.includes(id));
          const removed = currentIds.filter((id) => !clamped.includes(id));

          for (const targetRowId of added) {
            const existing = await tx.propertyValue.findUnique({
              where: {
                propertyId_pageId: { propertyId: inverse.id, pageId: targetRowId },
              },
              select: { value: true },
            });
            const previousSources =
              normalizeRelationPageIds(existing?.value, true) ?? [];

            // A single reciprocal keeps one source. Detach the target from any
            // other source row first, so both stored sides stay symmetric.
            if (!inverseMulti) {
              for (const otherSource of previousSources) {
                if (otherSource === rowPageId || otherSource === targetRowId) continue;
                const otherRow = await tx.page.findFirst({
                  where: {
                    id: otherSource,
                    parentId: auth.page.id,
                    workspaceId: row.workspaceId,
                    deletedAt: null,
                  },
                  select: { id: true },
                });
                if (!otherRow) continue;
                const otherCell = await tx.propertyValue.findUnique({
                  where: {
                    propertyId_pageId: { propertyId, pageId: otherSource },
                  },
                  select: { value: true },
                });
                if (!otherCell) continue;
                const otherIds = normalizeRelationPageIds(otherCell.value, true) ?? [];
                await tx.propertyValue.upsert({
                  where: {
                    propertyId_pageId: { propertyId, pageId: otherSource },
                  },
                  create: {
                    propertyId,
                    pageId: otherSource,
                    value: { pageIds: otherIds } as Prisma.InputJsonValue,
                  },
                  update: {
                    value: {
                      pageIds: otherIds.filter((id) => id !== targetRowId),
                    } as Prisma.InputJsonValue,
                  },
                });
                affected.add(otherSource);
              }
            }

            const inverseNext = nextInversePageIds(
              existing?.value,
              rowPageId,
              "add",
              inverseMulti,
            );
            await tx.propertyValue.upsert({
              where: {
                propertyId_pageId: { propertyId: inverse.id, pageId: targetRowId },
              },
              create: {
                propertyId: inverse.id,
                pageId: targetRowId,
                value: { pageIds: inverseNext } as Prisma.InputJsonValue,
              },
              update: { value: { pageIds: inverseNext } as Prisma.InputJsonValue },
            });
            affected.add(targetRowId);
          }

          for (const targetRowId of removed) {
            const existing = await tx.propertyValue.findUnique({
              where: {
                propertyId_pageId: { propertyId: inverse.id, pageId: targetRowId },
              },
              select: { value: true },
            });
            if (!existing) continue;
            const inverseNext = nextInversePageIds(
              existing.value,
              rowPageId,
              "remove",
              inverseMulti,
            );
            await tx.propertyValue.upsert({
              where: {
                propertyId_pageId: { propertyId: inverse.id, pageId: targetRowId },
              },
              create: {
                propertyId: inverse.id,
                pageId: targetRowId,
                value: { pageIds: inverseNext } as Prisma.InputJsonValue,
              },
              update: { value: { pageIds: inverseNext } as Prisma.InputJsonValue },
            });
            affected.add(targetRowId);
          }
        }
      }
      return [...affected];
    });

    // One activity line per row a two-way write changed, so both sides surface
    // the edit in LAST_EDITED_BY. The write above is already atomic.
    for (const targetId of touched) {
      await logActivity({
        workspaceId: row.workspaceId,
        actorId: auth.user.id,
        action: "row.edited",
        targetType: "page",
        targetId,
      });
    }
    revalidateDatabase(row.workspaceId);
    return { ok: true };
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
  // property surfaces as the row's last editor. `logActivity` already swallows
  // transport failures, so an audit line can never break the write it records.
  await logActivity({
    workspaceId: row.workspaceId,
    actorId: auth.user.id,
    action: "row.edited",
    targetType: "page",
    targetId: rowPageId,
  });

  revalidateDatabase(row.workspaceId);
  return { ok: true };
}

/**
 * Cursor-paginated page search for a relation cell (R21.5).
 *
 * The picker no longer has to receive every target row: 20 rows are returned
 * per call, ordered by id, with `nextCursor` pointing at the last id. The
 * property id is the authorization anchor - the viewer must be able to read the
 * source database, the target must be a live database of the same workspace,
 * and a guest's row results are further limited to their read scope.
 */
export async function searchRelationTargetsAction(
  propertyId: string,
  query = "",
  cursor: string | null = null,
): Promise<
  Result<{
    items: { id: string; title: string; icon: string | null }[];
    nextCursor: string | null;
  }>
> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { databasePageId: true, type: true, config: true },
  });
  if (!property || property.type !== "RELATION") {
    return { error: "Property not found." };
  }
  const auth = await authorizeDatabase(property.databasePageId);
  if ("error" in auth) return auth;

  const config = normalizeRelationConfig(property.config);
  if (!config.targetDatabaseId) return { error: "Configure the relation first." };
  const target = await prisma.page.findFirst({
    where: {
      id: config.targetDatabaseId,
      workspaceId: auth.page.workspaceId,
      type: "DATABASE",
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!target) return { error: "Database not found." };

  let readable: Set<string> | null = null;
  if (auth.access.role === "GUEST") {
    readable = await guestReadablePageIds(auth.user.id, auth.page.workspaceId);
    // A guest outside the target's read scope gets the same empty answer as a
    // search with no matches: a refusal must not confirm the target exists.
    if (!readable.has(target.id)) {
      return { ok: true, items: [], nextCursor: null };
    }
  }

  const search = query.trim().slice(0, 80);
  const after = typeof cursor === "string" ? cursor.trim() : "";
  const conditions: Prisma.PageWhereInput[] = [
    { parentId: target.id },
    { workspaceId: auth.page.workspaceId },
    { deletedAt: null },
  ];
  if (search) {
    conditions.push({ title: { contains: search, mode: "insensitive" } });
  }
  if (after) conditions.push({ id: { gt: after } });
  if (readable) conditions.push({ id: { in: [...readable] } });

  const rows = await prisma.page.findMany({
    where: { AND: conditions },
    orderBy: { id: "asc" },
    take: 21,
    select: { id: true, title: true, icon: true },
  });
  const items = rows.slice(0, 20);
  return {
    ok: true,
    items,
    nextCursor: rows.length > 20 ? items[items.length - 1].id : null,
  };
}

/**
 * Enable or disable the reciprocal half of a relation (R21.7).
 *
 * Enabling creates (or reuses) a RELATION property on the target database in
 * one transaction, cross-references both configs and backfills every existing
 * link. A self-relation uses the same property on both sides. Disabling clears
 * the `inversePropertyId` on both properties and leaves the columns (and their
 * values) in place, so no data disappears by toggling a setting.
 */
export async function setRelationTwoWayAction(
  propertyId: string,
  enabled: boolean,
): Promise<Result<{ inversePropertyId: string | null }>> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      databasePageId: true,
      name: true,
      type: true,
      config: true,
    },
  });
  if (!property || property.type !== "RELATION") {
    return { error: "Property not found." };
  }
  const auth = await authorizeDatabase(property.databasePageId);
  if ("error" in auth) return auth;
  if (!auth.capabilities.edit) return { error: "No permission." };
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

  const config = normalizeRelationConfig(property.config);
  if (!enabled) {
    const inverseId = config.inversePropertyId;
    await prisma.$transaction(async (tx) => {
      await tx.property.update({
        where: { id: property.id },
        data: {
          config: {
            ...config,
            inversePropertyId: null,
          } as Prisma.InputJsonValue,
        },
      });
      if (!inverseId || !config.targetDatabaseId) return;
      const inverse = await tx.property.findFirst({
        where: {
          id: inverseId,
          databasePageId: config.targetDatabaseId,
          type: "RELATION",
        },
        select: { id: true, config: true },
      });
      if (!inverse) return;
      await tx.property.update({
        where: { id: inverse.id },
        data: {
          config: {
            ...normalizeRelationConfig(inverse.config),
            inversePropertyId: null,
          } as Prisma.InputJsonValue,
        },
      });
    });
    revalidateDatabase(auth.page.workspaceId);
    return { ok: true, inversePropertyId: null };
  }

  if (!config.targetDatabaseId) return { error: "Configure the relation first." };
  const target = await prisma.page.findFirst({
    where: {
      id: config.targetDatabaseId,
      workspaceId: auth.page.workspaceId,
      type: "DATABASE",
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!target) return { error: "Database not found." };

  const inversePropertyId = await prisma.$transaction(async (tx) => {
    let inverseId: string;

    if (target.id === property.databasePageId) {
      // A self-relation can be its own inverse: a link stored on one row is
      // the reciprocal link stored on the other row of the same column.
      inverseId = property.id;
    } else {
      const existing = await tx.property.findFirst({
        where: {
          id: config.inversePropertyId ?? "",
          databasePageId: target.id,
          type: "RELATION",
        },
        select: { id: true, config: true },
      });
      const existingConfig = normalizeRelationConfig(existing?.config);
      const existingPointsBack =
        existingConfig.targetDatabaseId === property.databasePageId &&
        (existingConfig.inversePropertyId === null ||
          existingConfig.inversePropertyId === property.id);
      if (existing && existingPointsBack) {
        inverseId = existing.id;
      } else {
        // Reuse an unpaired relation that already points back at this database
        // (a previous toggle-off followed by a toggle-on), so repeated toggles
        // do not multiply columns.
        const candidates = await tx.property.findMany({
          where: { databasePageId: target.id, type: "RELATION" },
          orderBy: { position: "asc" },
          select: { id: true, name: true, config: true },
        });
        const reusable = candidates.find((candidate) => {
          const candidateConfig = normalizeRelationConfig(candidate.config);
          return (
            candidateConfig.targetDatabaseId === property.databasePageId &&
            candidateConfig.inversePropertyId === null &&
            candidate.name === property.name
          );
        });
        if (reusable) {
          inverseId = reusable.id;
        } else {
          const last = await tx.property.findFirst({
            where: { databasePageId: target.id },
            orderBy: { position: "desc" },
            select: { position: true },
          });
          const created = await tx.property.create({
            data: {
              databasePageId: target.id,
              name: property.name,
              type: "RELATION",
              position: (last?.position ?? 0) + 1000,
              config: {
                targetDatabaseId: property.databasePageId,
                multi: config.multi,
                inversePropertyId: property.id,
              } as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
          inverseId = created.id;
        }
      }
    }

    await tx.property.update({
      where: { id: property.id },
      data: {
        config: {
          targetDatabaseId: target.id,
          multi: config.multi,
          inversePropertyId: inverseId,
        } as Prisma.InputJsonValue,
      },
    });
    if (inverseId !== property.id) {
      await tx.property.update({
        where: { id: inverseId },
        data: {
          config: {
            targetDatabaseId: property.databasePageId,
            multi: config.multi,
            inversePropertyId: property.id,
          } as Prisma.InputJsonValue,
        },
      });
    }

    // Backfill every existing source link. Only target rows that still resolve
    // inside the configured target database are written.
    const sourceValues = await tx.propertyValue.findMany({
      where: { propertyId: property.id },
      select: { pageId: true, value: true },
    });
    const links: { sourceRowId: string; targetRowId: string }[] = [];
    const sourceById = new Map<string, string[]>();
    for (const entry of sourceValues) {
      const ids = normalizeRelationPageIds(entry.value, true) ?? [];
      sourceById.set(entry.pageId, ids);
      for (const targetRowId of ids) {
        links.push({ sourceRowId: entry.pageId, targetRowId });
      }
    }
    const targetIds = [...new Set(links.map((link) => link.targetRowId))];
    const targetRows = targetIds.length
      ? await tx.page.findMany({
          where: {
            id: { in: targetIds },
            parentId: target.id,
            workspaceId: auth.page.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        })
      : [];
    const validTargets = new Set(targetRows.map((row) => row.id));
    const validLinks = links.filter((link) => validTargets.has(link.targetRowId));

    const existingValues = await tx.propertyValue.findMany({
      where: { propertyId: inverseId },
      select: { pageId: true, value: true },
    });
    const existingByTarget: Record<string, string[]> = {};
    for (const entry of existingValues) {
      if (!validTargets.has(entry.pageId) && inverseId === property.id) continue;
      const ids = normalizeRelationPageIds(entry.value, true) ?? [];
      if (ids.length > 0) existingByTarget[entry.pageId] = ids;
    }
    const backfill = buildInverseBackfill({
      links: validLinks,
      existing: existingByTarget,
      multi: config.multi,
    });
    for (const [targetRowId, pageIds] of Object.entries(backfill)) {
      await tx.propertyValue.upsert({
        where: {
          propertyId_pageId: { propertyId: inverseId, pageId: targetRowId },
        },
        create: {
          propertyId: inverseId,
          pageId: targetRowId,
          value: { pageIds } as Prisma.InputJsonValue,
        },
        update: { value: { pageIds } as Prisma.InputJsonValue },
      });
    }

    // A single reciprocal can keep only one source per target. Make the source
    // cells agree with the chosen backfill instead of storing asymmetry.
    if (!config.multi) {
      for (const [targetRowId, pageIds] of Object.entries(backfill)) {
        const chosen = pageIds[0];
        for (const [sourceRowId, ids] of sourceById) {
          if (sourceRowId === chosen || !ids.includes(targetRowId)) continue;
          await tx.propertyValue.upsert({
            where: {
              propertyId_pageId: { propertyId: property.id, pageId: sourceRowId },
            },
            create: {
              propertyId: property.id,
              pageId: sourceRowId,
              value: {
                pageIds: ids.filter((id) => id !== targetRowId),
              } as Prisma.InputJsonValue,
            },
            update: {
              value: {
                pageIds: ids.filter((id) => id !== targetRowId),
              } as Prisma.InputJsonValue,
            },
          });
        }
      }
    }

    return inverseId;
  });

  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, inversePropertyId };
}

export async function createRowAction(
  databasePageId: string,
  title = "",
): Promise<Result<{ id: string }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!auth.capabilities.edit) return { error: "No permission." };

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
        // the row is written into that very page's workspace - parent and row
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
    await createRowCellsInTransaction(tx, databasePageId, row.id, title);
    return row.id;
  });

  await dispatchWebhooks(auth.page.workspaceId, "row.created", {
    rowId,
    databasePageId,
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, id: rowId };
}

/**
 * Submit an internal FORM view.
 *
 * The browser validates the same schema before it calls this action, but that
 * is only a UX shortcut: this action re-authorizes the view's database, reads
 * the view's *stored* `config.form`, re-validates every answer with the shared
 * cell rules, and creates the row plus all cells in one transaction. A
 * hand-crafted client call therefore cannot write an unknown column, a computed
 * cell, an unowned file URL, or a row that only partially commits.
 */
export async function submitFormAction(
  viewId: string,
  answers: unknown,
): Promise<Result<{ id: string }>> {
  const view = await prisma.databaseView.findUnique({
    where: { id: viewId },
    select: {
      id: true,
      databasePageId: true,
      name: true,
      type: true,
      config: true,
    },
  });
  if (!view || view.type !== "FORM") return { error: "Form not found." };

  const auth = await authorizeDatabase(view.databasePageId);
  if ("error" in auth) return auth;
  if (!auth.capabilities.edit) return { error: "No permission." };

  const config = (view.config ?? {}) as { form?: unknown };
  const parsed = parseFormSchema(config.form);
  const properties = await prisma.property.findMany({
    where: { databasePageId: view.databasePageId },
    orderBy: { position: "asc" },
    select: { id: true, name: true, type: true, config: true },
  });
  const propertyById = new Map(properties.map((property) => [property.id, property]));

  // A stored FormSchema is authoritative. A legacy `fieldIds` config (or no
  // config at all) is resolved against the live properties exactly like the
  // renderer does, so an old form keeps accepting its answers.
  const storedFields =
    parsed.fields.length > 0
      ? parsed.fields
      : buildFormSchema(properties, config.form);
  const schema: FormSchema = {
    ...parsed,
    id: view.id,
    databaseId: view.databasePageId,
    title: parsed.title.trim() || view.name || "Form",
    fields: storedFields.map((field) => {
      const property = propertyById.get(field.propertyId);
      return property
        ? {
            ...field,
            type: property.type,
            config: (property.config ?? {}) as Record<string, unknown>,
          }
        : field;
    }),
  };

  const formCheck = validateFormSchema(schema, { properties });
  if (!formCheck.ok) return { error: "This form has an invalid configuration." };
  if (schema.accepting !== true) {
    return { error: "This form is not accepting responses." };
  }

  // Per-user fixed window. It is deliberately charged before the row write, so
  // even a script that keeps malformed submissions coming cannot use this
  // action as an unthrottled database writer.
  const userLimit = checkUserRateLimit(
    userKey(`form-submit:${view.id}`, auth.user.id),
    20,
    60_000,
  );
  const addressLimit = checkRateLimit(
    clientKeyFromHeaders(await headers(), `form-submit:${view.id}`),
    60,
    60_000,
  );
  if (!userLimit.ok || !addressLimit.ok) {
    return { error: "Too many submissions. Try again shortly." };
  }

  const validation = validateSubmission(schema, answers);
  if (!validation.ok) {
    return { error: "Please check the answers and try again." };
  }
  const cells = toRowValues(schema, answers);
  const submitted = new Map<string, Prisma.InputJsonValue>();
  for (const cell of cells) {
    const property = propertyById.get(cell.propertyId);
    if (!property || !isAnswerablePropertyType(property.type)) {
      return { error: "This form has an invalid question." };
    }
    if (!fileUrlsAreAppOwned(cell.value)) {
      return { error: "That file link is not allowed." };
    }
    submitted.set(cell.propertyId, cell.value as Prisma.InputJsonValue);
  }

  // Re-check the *mapped* cells, including defaults that were never in the
  // answer map. `validateSubmission` already checks the answers, but validating
  // the final values here means a stored default cannot bypass the shared cell
  // rules and a fail-open validation edge cannot reach the writer.
  for (const field of schema.fields) {
    if (field.hidden === true) continue;
    const property = propertyById.get(field.propertyId);
    if (!property || !isAnswerablePropertyType(property.type)) {
      return { error: "This form has an invalid question." };
    }
    const result = validateCell(
      {
        id: property.id,
        name: field.label,
        type: property.type,
        required: field.required === true,
        config: (property.config ?? {}) as Record<string, unknown>,
      },
      submitted.get(field.propertyId),
    );
    if (!result.ok) {
      return { error: "Please check the answers and try again." };
    }
  }

  // The primary text answer also becomes the row title, matching the table's
  // blank-row path. `createRowCellsInTransaction` seeds that same cell from the
  // title, so the answer is written once.
  const primary = properties[0];
  const primaryCell = primary
    ? cells.find((cell) => cell.propertyId === primary.id)
    : undefined;
  const primaryText =
    primaryCell && primaryCell.value && typeof primaryCell.value === "object"
      ? (primaryCell.value as { text?: unknown }).text
      : undefined;
  const title = typeof primaryText === "string" ? primaryText : "";

  const rowId = await prisma.$transaction(async (tx) => {
    const last = await tx.page.findFirst({
      where: { parentId: view.databasePageId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const rowTitle = title || "Untitled";
    const row = await tx.page.create({
      data: {
        workspaceId: auth.page.workspaceId,
        // `authorizeDatabase(view.databasePageId)` proved this parent above and
        // the row is written into that very page's workspace.
        parentId: view.databasePageId,
        title: rowTitle,
        createdById: auth.user.id,
        position: (last?.position ?? 0) + 1000,
        searchText: pageSearchText(rowTitle, null),
      },
      select: { id: true },
    });
    await createRowCellsInTransaction(
      tx,
      view.databasePageId,
      row.id,
      title,
      submitted,
    );
    return row.id;
  });

  await dispatchWebhooks(auth.page.workspaceId, "row.created", {
    rowId,
    databasePageId: view.databasePageId,
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true, id: rowId };
}

export async function deleteRowAction(rowId: string): Promise<Result> {
  const row = await prisma.page.findUnique({
    where: { id: rowId },
    select: {
      parentId: true,
      workspaceId: true,
      permissions: { select: { userId: true, level: true } },
    },
  });
  if (!row?.parentId) return { error: "Row not found." };
  const auth = await authorizeDatabase(row.parentId);
  if ("error" in auth) return auth;
  // B96: same scope rule as `setPropertyValueAction` — a legacy row whose
  // `workspaceId` differs from the workspace of its database is filtered out
  // of every read path, so it must not be soft-deleted either. The answer is
  // the same as for a row that does not exist (no existence oracle), and it
  // comes before the role check so it is the same for every caller.
  if (row.workspaceId !== auth.page.workspaceId) {
    return { error: "Row not found." };
  }
  if (!auth.capabilities.edit) return { error: "No permission." };
  const rowPermissions = (row.permissions ?? []).filter(
    (permission) => permission.userId === auth.user.id,
  );
  if (!pageCapabilitiesFromRelation(auth.access.role, rowPermissions).edit) {
    return { error: "No permission." };
  }
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

/**
 * Nest a row under another row of the same database, or promote it back to the
 * top level with `parentRowId = null`.
 *
 * `Page.parentId` is the database itself and never changes here; the optional
 * `Page.subOfId` is the sub-item edge. The tree is deliberately one level deep:
 * a parent that is itself nested and a row that already has children are both
 * rejected, so a malformed client cannot build an unbounded chain (and the
 * read/query path never needs a recursive walk). A row carries its own
 * page-level restriction, so the same workspace/row edit checks as a property
 * write apply before the move is committed.
 */
export async function setSubItemParentAction(
  rowId: string,
  parentRowId: string | null,
): Promise<Result> {
  const row = await prisma.page.findUnique({
    where: { id: rowId },
    select: {
      parentId: true,
      workspaceId: true,
      permissions: { select: { userId: true, level: true } },
    },
  });
  if (!row?.parentId) return { error: "Row not found." };
  const auth = await authorizeDatabase(row.parentId);
  if ("error" in auth) return auth;
  if (row.workspaceId !== auth.page.workspaceId) {
    return { error: "Row not found." };
  }
  if (!auth.capabilities.edit) return { error: "No permission." };
  const rowPermissions = (row.permissions ?? []).filter(
    (permission) => permission.userId === auth.user.id,
  );
  if (!pageCapabilitiesFromRelation(auth.access.role, rowPermissions).edit) {
    return { error: "No permission." };
  }
  if (parentRowId === rowId) return { error: "A row cannot be its own parent." };

  if (parentRowId !== null) {
    const parent = await prisma.page.findUnique({
      where: { id: parentRowId },
      select: {
        parentId: true,
        workspaceId: true,
        subOfId: true,
        deletedAt: true,
      },
    });
    if (
      !parent ||
      parent.parentId !== auth.page.id ||
      parent.workspaceId !== auth.page.workspaceId ||
      parent.deletedAt !== null
    ) {
      return { error: "Parent row not found." };
    }
    if (parent.subOfId !== null) {
      return { error: "Sub-items can only be one level deep." };
    }
    const childCount = await prisma.page.count({
      where: {
        subOfId: rowId,
        workspaceId: auth.page.workspaceId,
        deletedAt: null,
      },
    });
    if (childCount > 0) {
      return { error: "Move this row's sub-items out first." };
    }
  }

  await prisma.page.update({
    where: { id: rowId },
    data: { subOfId: parentRowId },
  });
  await logActivity({
    workspaceId: auth.page.workspaceId,
    actorId: auth.user.id,
    action: "row.edited",
    targetType: "page",
    targetId: rowId,
    meta: { subOfId: parentRowId },
  });
  revalidateDatabase(auth.page.workspaceId);
  return { ok: true };
}

/** The write-time cap on blocking edges in one database (R89.31). */
const DEPENDENCY_EDGE_LIMIT = 500;

/**
 * Add or remove one blocking edge between two rows of a database.
 *
 * `blockerId` must finish before `blockedId` can start. Both rows have to be
 * live pages of `databasePageId` in the database's workspace, and the caller
 * needs edit rights on the database **and** on both rows. The write-time graph
 * check rejects self-edges and any edge that would close a loop, and the
 * per-database edge cap keeps `wouldCreateCycle`'s DFS bounded. The operation
 * is idempotent: adding an existing edge and removing a missing one both
 * succeed, so a stale client can safely replay it.
 */
export async function setRowDependencyAction(
  databasePageId: string,
  blockerId: string,
  blockedId: string,
  linked: boolean,
): Promise<Result> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!auth.capabilities.edit) return { error: "No permission." };
  if (blockerId === blockedId) return { error: "A row cannot depend on itself." };

  const rows = await prisma.page.findMany({
    where: {
      parentId: databasePageId,
      workspaceId: auth.page.workspaceId,
      deletedAt: null,
    },
    select: {
      id: true,
      permissions: {
        where: { userId: auth.user.id },
        select: { level: true },
      },
    },
  });
  const blocker = rows.find((row) => row.id === blockerId);
  const blocked = rows.find((row) => row.id === blockedId);
  if (!blocker || !blocked) return { error: "Row not found." };
  const canEditRow = (row: (typeof rows)[number]) =>
    pageCapabilitiesFromRelation(auth.access.role, row.permissions).edit;
  if (!canEditRow(blocker) || !canEditRow(blocked)) return { error: "No permission." };

  if (!linked) {
    const removed = await prisma.rowDependency.deleteMany({
      where: { blockerId, blockedId },
    });
    if (removed.count > 0) {
      await logActivity({
        workspaceId: auth.page.workspaceId,
        actorId: auth.user.id,
        action: "row.edited",
        targetType: "page",
        targetId: blockedId,
        meta: { dependency: "removed", blockerId },
      });
    }
    revalidateDatabase(auth.page.workspaceId);
    return { ok: true };
  }

  const existing = await prisma.rowDependency.findMany({
    where: {
      blockerId: { in: rows.map((row) => row.id) },
      blockedId: { in: rows.map((row) => row.id) },
    },
    select: { blockerId: true, blockedId: true },
  });
  const alreadyLinked = existing.some(
    (edge) => edge.blockerId === blockerId && edge.blockedId === blockedId,
  );
  if (!alreadyLinked) {
    if (existing.length >= DEPENDENCY_EDGE_LIMIT) {
      return { error: "This database has too many dependencies." };
    }
    const edges: DependencyEdge[] = existing.map((edge) => ({
      from: edge.blockerId,
      to: edge.blockedId,
    }));
    if (wouldCreateCycle(edges, { from: blockerId, to: blockedId })) {
      return { error: "That would create a dependency cycle." };
    }
  }

  await prisma.rowDependency.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    create: { blockerId, blockedId },
    update: {},
  });
  if (!alreadyLinked) {
    await logActivity({
      workspaceId: auth.page.workspaceId,
      actorId: auth.user.id,
      action: "row.edited",
      targetType: "page",
      targetId: blockedId,
      meta: { dependency: "added", blockerId },
    });
  }
  revalidateDatabase(auth.page.workspaceId);
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
  "FORM",
] as const;
type ViewType = (typeof VIEW_TYPES)[number];

function isViewType(value: unknown): value is ViewType {
  return typeof value === "string" && (VIEW_TYPES as readonly string[]).includes(value);
}

export async function createViewAction(
  databasePageId: string,
  type:
    | "TABLE"
    | "BOARD"
    | "LIST"
    | "GALLERY"
    | "CALENDAR"
    | "TIMELINE"
    | "CHART"
    | "FORM",
  name: string,
): Promise<Result<{ id: string }>> {
  const auth = await authorizeDatabase(databasePageId);
  if ("error" in auth) return auth;
  if (!auth.capabilities.edit) return { error: "No permission." };
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
  if (!auth.capabilities.edit) return { error: "No permission." };
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
  if (!auth.capabilities.edit) return { error: "No permission." };
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
 * B98 — one exception: a **relation target** is only carried over when it still
 * passes the target check (`relationConfigForWorkspace`). The copy lives in the
 * workspace of its source, so a target of that workspace is kept; a target of
 * another workspace (or a deleted or missing one) is cleared instead of copied,
 * so a copy never stores a relation that the write side would refuse.
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
  if (!auth.capabilities.edit) return { error: "No permission." };
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
  const parent = await assertEditableParent({
    workspaceId: auth.page.workspaceId,
    parentId: source.parentId,
    userId: auth.user.id,
    role: auth.access.role,
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

  const propertyRows: Prisma.PropertyCreateManyInput[] = await Promise.all(
    copy.properties.map(async (property) => {
      // B98 — the copy may only carry a relation target that passes the same
      // check as a written one. The copy lives in the workspace of its
      // source, so a target of that workspace stays valid; a foreign (or
      // deleted, or missing) target is cleared instead of copied over.
      const config = asJson(
        await relationConfigForWorkspace(property.config, auth.page.workspaceId),
      );
      return {
        id: property.id,
        databasePageId: newPageId,
        name: typeof property.name === "string" ? property.name : "Property",
        type: property.type as PropertyType,
        position: typeof property.position === "number" ? property.position : 0,
        ...(config !== undefined ? { config } : {}),
      };
    }),
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
  if (!auth.capabilities.edit) return { error: "No permission." };
  const schemaDenied = schemaLockDenied(auth);
  if (schemaDenied) return schemaDenied;

  // The row is bound to the **authorized database**: it must be filed under
  // it (`parentId`) and live in the same workspace. A row of another
  // workspace (or of another database of this workspace) is not copied — its
  // body and cell values would end up in the caller's own template. The
  // answer is the same as for an unknown id, so the error is no oracle for
  // the existence of a foreign row.
  const row = await prisma.page.findUnique({
    where: {
      id: rowId,
      parentId: databasePageId,
      workspaceId: auth.page.workspaceId,
    },
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
  if (!auth.capabilities.edit) return { error: "No permission." };

  // The template is bound to the **authorized database** — the same way a
  // template of another workspace is resolved through its database in
  // `home-templates.ts`. A template of a foreign database is not
  // materialized, and the answer is the same as for an unknown id.
  const template = await prisma.template.findUnique({
    where: { id: templateId },
    select: {
      databasePageId: true,
      content: true,
      config: true,
      name: true,
      icon: true,
    },
  });
  if (!template || template.databasePageId !== databasePageId) {
    return { error: "Template not found." };
  }

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
  if (!auth.capabilities.edit) return { error: "No permission." };
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
  if (!auth.capabilities.edit) return { error: "No permission." };
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
  if (!auth.capabilities.edit) return { error: "No permission." };
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
  if (!auth.capabilities.edit) return { error: "No permission." };
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
  if (!auth.capabilities.edit) return { error: "No permission." };
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
