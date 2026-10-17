"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { getWorkspaceBySlug } from "@/server/queries";
import {
  anonymizeValue,
  buildErasurePlan,
  buildExportPlan,
  redactExport,
  summarizePlan,
  validateErasurePlan,
  type DataSubjectRecord,
  type EntityKind,
  type ErasureOperation,
  type ErasurePlan,
  type ErasureSummary,
  type ErasureValidation,
  type ExportBundle,
} from "@/lib/gdpr";

/**
 * GDPR data controls (Art. 15 access/export, Art. 17 erasure) — the request
 * layer over the pure `@/lib/gdpr` engine.
 *
 * The signed-in user is the data subject. `loadDataControlsAction` loads the
 * subject's rows from the six personal-data entities, hands them to
 * `buildExportPlan`/`buildErasurePlan`, and returns the export bundle (with a
 * `redactExport` preview) plus the erasure plan and its `validateErasurePlan`
 * audit. `eraseSubjectDataAction` re-loads, refuses unless the plan validates,
 * and applies it in one transaction — never touching a record under legal hold
 * (those are retained with the hold's reason, exactly as the plan states).
 *
 * Execution mapping (documented because the pure registry is field-level while
 * the database is not):
 *  - a `delete` on a NULLABLE column writes SQL NULL; on a required column
 *    (only `User.passwordHash`) it writes an unusable tombstone, so the row
 *    stays valid but the value can never match again;
 *  - an `anonymize` writes the deterministic `anonymizeValue` pseudonym, except
 *    for JSON columns, which are erased to NULL (a pseudonymous JSON document
 *    is meaningless);
 *  - a foreign-key owner column (`Page.createdById`, `Comment.authorId`,
 *    `Reaction.userId`, `Version.createdById`) is left in place: it points at
 *    the subject row, which is itself pseudonymised, so the reference is no
 *    longer personal. Every other personal field is written or explicitly
 *    retained per the plan.
 */

/** Written to required columns whose strategy is `delete` (never a match). */
const ERASED_TOMBSTONE = "[erased]";

/** Context a data-controls action needs after auth + membership. */
type ControlsContext = {
  userId: string;
  userName: string;
  locale: string;
  workspaceId: string;
  workspaceName: string;
  slug: string;
};

/** One record shown in the legal-hold picker. */
export type SubjectRecordRow = {
  key: string;
  entity: EntityKind;
  id: string;
  label: string;
  held: boolean;
};

/** A full read-only view of the subject's data controls. */
export type DataControlsSnapshot = {
  ok: true;
  slug: string;
  locale: string;
  workspaceName: string;
  subjectName: string;
  exportFileName: string;
  exportJson: string;
  exportCounts: ExportBundle["counts"];
  redacted: ExportBundle;
  records: SubjectRecordRow[];
  plan: ErasurePlan;
  validation: ErasureValidation;
  summary: ErasureSummary;
};

/** Result of {@link loadDataControlsAction}. */
export type DataControlsResult = DataControlsSnapshot | { ok: false; error: string };

/** Result of {@link eraseSubjectDataAction}. */
export type EraseResult =
  | { ok: true; summary: ErasureSummary; erased: number; retained: number }
  | { ok: false; error: string; validation?: ErasureValidation };

/** Resolve the caller, the workspace and their membership — or `null`. */
async function requireControlsContext(slug: string): Promise<ControlsContext | null> {
  const user = await requireUser();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) return null;
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) return null;
  return {
    userId: user.id,
    userName: user.name,
    locale: user.locale ?? "en",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    slug: workspace.slug,
  };
}

/** A short, human label for a record, read from its loaded fields. */
function recordLabel(record: DataSubjectRecord): string {
  const fields = record.fields ?? {};
  const text = (name: string): string =>
    typeof fields[name] === "string" ? (fields[name] as string) : "";
  switch (record.entity) {
    case "user":
      return text("email") || text("name") || record.id;
    case "page":
      return text("title") || record.id;
    case "comment":
      return text("body").slice(0, 60) || record.id;
    case "version":
      return text("title") || record.id;
    case "reaction":
      return text("emoji") || record.id;
    case "shareLink":
      return text("token").slice(0, 10) || record.id;
    default:
      return record.id;
  }
}

/**
 * Load every personal-data record belonging to `subjectId`, marking the ones in
 * `heldKeys` (canonical `entity:id`) as under legal hold. Dates are serialised
 * to ISO strings so the export bundle is fully JSON-safe.
 */
async function loadSubjectRecords(
  subjectId: string,
  heldKeys: ReadonlySet<string>,
): Promise<DataSubjectRecord[]> {
  const [user, pages, comments, reactions, versions, shareLinks] = await Promise.all([
    prisma.user.findUnique({
      where: { id: subjectId },
      select: {
        email: true,
        name: true,
        avatarUrl: true,
        locale: true,
        theme: true,
        passwordHash: true,
        notificationPrefs: true,
        // B05: what the column holds is the SEALED envelope
        // (`v1:iv:tag:payload`), never the raw base32 seed. The field is
        // `exportable: false` in the registry, so it is used for the erasure
        // plan only and never reaches the export bundle.
        twoFactorSecret: true,
        twoFactorEnabled: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.page.findMany({
      where: { createdById: subjectId },
      select: { id: true, title: true, content: true, createdById: true, parentId: true, workspaceId: true },
    }),
    prisma.comment.findMany({
      where: { authorId: subjectId },
      select: { id: true, body: true, authorId: true, quote: true, blockId: true, pageId: true, resolved: true },
    }),
    prisma.commentReaction.findMany({
      where: { userId: subjectId },
      select: { id: true, userId: true, emoji: true, commentId: true },
    }),
    prisma.pageVersion.findMany({
      where: { createdById: subjectId },
      select: { id: true, title: true, content: true, createdById: true, summary: true, label: true, charDelta: true },
    }),
    prisma.shareLink.findMany({
      where: { page: { createdById: subjectId } },
      select: { id: true, token: true, passwordHash: true, pageId: true, permission: true, expiresAt: true },
    }),
  ]);

  const records: DataSubjectRecord[] = [];
  const held = (entity: EntityKind, id: string): boolean => heldKeys.has(`${entity}:${id}`);

  if (user) {
    records.push({
      entity: "user",
      id: subjectId,
      subjectId,
      legalHold: held("user", subjectId),
      fields: {
        id: subjectId,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        locale: user.locale,
        theme: user.theme,
        passwordHash: user.passwordHash,
        notificationPrefs: user.notificationPrefs,
        // The sealed envelope (B05) — not the seed. It is not exportable, so
        // it is only ever read to plan the erasure of the column.
        twoFactorSecret: user.twoFactorSecret,
        twoFactorEnabled: user.twoFactorEnabled,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      },
    });
  }
  for (const page of pages) {
    records.push({
      entity: "page",
      id: page.id,
      subjectId,
      legalHold: held("page", page.id),
      fields: { ...page },
    });
  }
  for (const comment of comments) {
    records.push({
      entity: "comment",
      id: comment.id,
      subjectId,
      legalHold: held("comment", comment.id),
      fields: { ...comment },
    });
  }
  for (const reaction of reactions) {
    records.push({
      entity: "reaction",
      id: reaction.id,
      subjectId,
      legalHold: held("reaction", reaction.id),
      fields: { ...reaction },
    });
  }
  for (const version of versions) {
    records.push({
      entity: "version",
      id: version.id,
      subjectId,
      legalHold: held("version", version.id),
      fields: { ...version },
    });
  }
  for (const shareLink of shareLinks) {
    records.push({
      entity: "shareLink",
      id: shareLink.id,
      subjectId,
      legalHold: held("shareLink", shareLink.id),
      fields: { ...shareLink, expiresAt: shareLink.expiresAt?.toISOString() ?? null },
    });
  }
  return records;
}

/** Group a plan's operations by `entity:id` for a single pass of writes. */
function groupOperations(plan: ErasurePlan): Map<string, ErasureOperation[]> {
  const grouped = new Map<string, ErasureOperation[]>();
  for (const op of plan.operations) {
    const key = `${op.entity}:${op.id}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(op);
    else grouped.set(key, [op]);
  }
  return grouped;
}

/** The pseudonym for a field's current value (deterministic, non-reversible). */
function pseudonym(field: string, fields: Record<string, unknown>): string {
  return anonymizeValue(field, fields[field]);
}

/** Apply the writable personal fields of one `user` record. */
async function applyUser(
  tx: Prisma.TransactionClient,
  id: string,
  operations: readonly ErasureOperation[],
  fields: Record<string, unknown>,
): Promise<void> {
  const data: Prisma.UserUpdateInput = {};
  for (const op of operations) {
    if (op.action === "retain-legal") continue;
    switch (op.field) {
      case "email":
        data.email = pseudonym("email", fields);
        break;
      case "name":
        data.name = pseudonym("name", fields);
        break;
      case "avatarUrl":
        data.avatarUrl = pseudonym("avatarUrl", fields);
        break;
      case "passwordHash":
        data.passwordHash = ERASED_TOMBSTONE;
        break;
      case "notificationPrefs":
        data.notificationPrefs = Prisma.DbNull;
        break;
      case "twoFactorSecret":
        data.twoFactorSecret = null;
        break;
      default:
        break;
    }
  }
  if (Object.keys(data).length > 0) await tx.user.update({ where: { id }, data });
}

/** Apply the writable personal fields of one `page` record. */
async function applyPage(
  tx: Prisma.TransactionClient,
  id: string,
  operations: readonly ErasureOperation[],
  fields: Record<string, unknown>,
): Promise<void> {
  const data: Prisma.PageUpdateInput = {};
  for (const op of operations) {
    if (op.action === "retain-legal") continue;
    if (op.field === "title") data.title = pseudonym("title", fields);
    else if (op.field === "content") data.content = Prisma.DbNull;
    // `createdById` is a required FK to the subject row (itself pseudonymised).
  }
  if (Object.keys(data).length > 0) await tx.page.update({ where: { id }, data });
}

/** Apply the writable personal fields of one `comment` record. */
async function applyComment(
  tx: Prisma.TransactionClient,
  id: string,
  operations: readonly ErasureOperation[],
  fields: Record<string, unknown>,
): Promise<void> {
  const data: Prisma.CommentUpdateInput = {};
  for (const op of operations) {
    if (op.action === "retain-legal") continue;
    if (op.field === "body") data.body = pseudonym("body", fields);
    else if (op.field === "quote") data.quote = pseudonym("quote", fields);
    // `authorId` is a FK to the pseudonymised subject row.
  }
  if (Object.keys(data).length > 0) await tx.comment.update({ where: { id }, data });
}

/** Apply the writable personal fields of one `version` record. */
async function applyVersion(
  tx: Prisma.TransactionClient,
  id: string,
  operations: readonly ErasureOperation[],
  fields: Record<string, unknown>,
): Promise<void> {
  const data: Prisma.PageVersionUpdateInput = {};
  for (const op of operations) {
    if (op.action === "retain-legal") continue;
    if (op.field === "title") data.title = pseudonym("title", fields);
    else if (op.field === "content") data.content = Prisma.DbNull;
    else if (op.field === "summary") data.summary = pseudonym("summary", fields);
  }
  if (Object.keys(data).length > 0) await tx.pageVersion.update({ where: { id }, data });
}

/** Apply the writable personal fields of one `shareLink` record. */
async function applyShareLink(
  tx: Prisma.TransactionClient,
  id: string,
  operations: readonly ErasureOperation[],
): Promise<void> {
  const data: Prisma.ShareLinkUpdateInput = {};
  for (const op of operations) {
    if (op.action === "retain-legal") continue;
    if (op.field === "passwordHash") data.passwordHash = null;
    // `token` is `retain-legal` and never touched.
  }
  if (Object.keys(data).length > 0) await tx.shareLink.update({ where: { id }, data });
}

/**
 * Apply a validated erasure plan in one transaction. Held records are skipped
 * entirely (the hold wins). Returns the count of records written and retained.
 */
async function applyErasurePlan(
  tx: Prisma.TransactionClient,
  plan: ErasurePlan,
  fieldsByKey: ReadonlyMap<string, Record<string, unknown>>,
): Promise<{ erased: number; retained: number }> {
  const grouped = groupOperations(plan);
  let erased = 0;
  let retained = 0;

  for (const record of plan.records) {
    const key = `${record.entity}:${record.id}`;
    if (record.held) {
      retained += 1;
      continue;
    }
    const operations = grouped.get(key) ?? [];
    const fields = fieldsByKey.get(key) ?? {};
    switch (record.entity) {
      case "user":
        await applyUser(tx, record.id, operations, fields);
        break;
      case "page":
        await applyPage(tx, record.id, operations, fields);
        break;
      case "comment":
        await applyComment(tx, record.id, operations, fields);
        break;
      case "version":
        await applyVersion(tx, record.id, operations, fields);
        break;
      case "reaction":
        // Only the owner FK is personal; it points at the pseudonymised row.
        break;
      case "shareLink":
        await applyShareLink(tx, record.id, operations);
        break;
      default:
        break;
    }
    erased += 1;
  }
  return { erased, retained };
}

/**
 * Load the subject's data controls: the export bundle (Art. 15) plus the
 * erasure plan and its validation audit (Art. 17). `holdKeys` are the canonical
 * `entity:id` records the caller wants treated as under legal hold.
 */
export async function loadDataControlsAction(
  slug: string,
  holdKeys: readonly string[] = [],
): Promise<DataControlsResult> {
  const context = await requireControlsContext(slug);
  if (!context) return { ok: false, error: "Workspace not found or access denied." };

  const records = await loadSubjectRecords(context.userId, new Set(holdKeys));
  const bundle = buildExportPlan(records, context.userId);
  const plan = buildErasurePlan(records, context.userId);

  // A redacted copy is safe to log/hand to a reviewer; the real bundle is only
  // returned to the subject for download.
  const redacted = redactExport(bundle);
  console.info(
    `[gdpr/export] subject ${context.userId}: ${bundle.total} records (${JSON.stringify(redacted.counts)})`,
  );

  return {
    ok: true,
    slug: context.slug,
    locale: context.locale,
    workspaceName: context.workspaceName,
    subjectName: context.userName,
    exportFileName: `gdpr-export-${context.userId}.json`,
    exportJson: JSON.stringify(bundle, null, 2),
    exportCounts: bundle.counts,
    redacted,
    records: records.map((record) => ({
      key: `${record.entity}:${record.id}`,
      entity: record.entity,
      id: record.id,
      label: recordLabel(record),
      held: record.legalHold === true,
    })),
    plan,
    validation: validateErasurePlan(plan),
    summary: summarizePlan(plan),
  };
}

/**
 * Execute the subject's erasure (Art. 17). The plan is rebuilt from the live
 * rows and must pass `validateErasurePlan` first — a plan that does not cover
 * every personal field, or that tries to erase a held record, is refused whole.
 * Records under legal hold are retained with their reason. Runs as one
 * transaction so a partial erasure can never be recorded as complete.
 */
export async function eraseSubjectDataAction(
  slug: string,
  holdKeys: readonly string[] = [],
): Promise<EraseResult> {
  const context = await requireControlsContext(slug);
  if (!context) return { ok: false, error: "Workspace not found or access denied." };

  const records = await loadSubjectRecords(context.userId, new Set(holdKeys));
  const plan = buildErasurePlan(records, context.userId);
  const validation = validateErasurePlan(plan);
  if (!validation.ok) {
    return {
      ok: false,
      error: "Refused: the erasure plan failed validation.",
      validation,
    };
  }

  const fieldsByKey = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    fieldsByKey.set(`${record.entity}:${record.id}`, record.fields ?? {});
  }

  const { erased, retained } = await prisma.$transaction((tx) =>
    applyErasurePlan(tx, plan, fieldsByKey),
  );

  revalidatePath(`/w/${context.slug}/settings/data`);
  revalidatePath("/w", "layout");
  console.info(
    `[gdpr/erase] subject ${context.userId}: erased ${erased} record(s), retained ${retained} under legal hold`,
  );
  return { ok: true, summary: summarizePlan(plan), erased, retained };
}
