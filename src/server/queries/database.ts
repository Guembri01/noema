/**
 * Database reads: properties, views, rows, templates and relation resolution.
 *
 * Extracted from src/server/queries.ts; callers keep importing from
 * @/server/queries through the re-export barrel.
 */
import { prisma } from "@/lib/db";
import { docMentionsPage } from "@/lib/mentions";

export type RelationData = {
  options: { id: string; title: string; icon: string | null }[];
  valuesByRow: Record<string, Record<string, unknown>>;
  properties: { id: string; name: string; type: string }[];
};

/**
 * Read a database: its schema, its views, its rows, its templates and the
 * data of the databases its relations point at.
 *
 * `readablePageIds` is the **read scope** of the viewer - the pages they may
 * read (the pages shared with them plus their whole subtree, never an
 * ancestor; `lib/guest-access.ts` -> `guestReadablePageIds`). `null` means
 * "no scope": the viewer may read the whole workspace (every role but
 * `GUEST`), so nothing is filtered.
 *
 * A relation target outside the scope delivers nothing - no rows, no cell
 * values and no schema - the same empty answer a target outside the
 * workspace gets. The check stands in front of the target's content query,
 * so a target the viewer may not read is never read at all.
 */
export async function getDatabase(
  databasePageId: string,
  readablePageIds: ReadonlySet<string> | null = null,
) {
  // A database's rows are the pages that hang under it, and they belong to the
  // database's own workspace. `Page.parentId` is a plain foreign key, so a row
  // that was linked across workspaces (the unchecked `parentId` hole, B08)
  // would otherwise show up in this view and in the database exports. The rows
  // are therefore filtered by the database's workspace; an unknown database
  // resolves to a blank workspace, which matches no row.
  const database = await prisma.page.findUnique({
    where: { id: databasePageId },
    select: { workspaceId: true },
  });
  const workspaceId = database?.workspaceId ?? "";
  const [properties, views, rows, templateRows] = await Promise.all([
    prisma.property.findMany({
      where: { databasePageId },
      orderBy: { position: "asc" },
    }),
    prisma.databaseView.findMany({
      where: { databasePageId },
      orderBy: { position: "asc" },
    }),
    prisma.page.findMany({
      where: { parentId: databasePageId, workspaceId, deletedAt: null },
      orderBy: { position: "asc" },
      include: {
        propertyValues: true,
        createdBy: { select: { name: true } },
      },
    }),
    prisma.template.findMany({
      where: { databasePageId },
      orderBy: { createdAt: "asc" },
      // R31.15 — expose the planner inputs so `database-view`'s template engine
      // can read a template's property defaults (`config.values`) and body
      // (`content`) instead of showing display-only rows. `isDefault` (the
      // planner's default pick, `resolveDefaultTemplate`) and `position` (the
      // authored order, templates.md §5) are now columns on `Template`, so they
      // are projected additively for the UI/actions to consume.
      select: {
        id: true,
        name: true,
        icon: true,
        recurrence: true,
        config: true,
        content: true,
        isDefault: true,
        position: true,
      },
    }),
  ]);

  // Resolve related-database rows/values for relation + rollup properties.
  const relationData: Record<string, RelationData> = {};

  // Latest recorded editor per row, newest first, for the LAST_EDITED_BY
  // property. Rows without an activity line fall back to their creator.
  const rowIds = rows.map((row) => row.id);
  const lastEditedBy: Record<string, string> = {};
  if (rowIds.length > 0) {
    const edits = await prisma.activity.findMany({
      where: { targetType: "page", targetId: { in: rowIds }, action: "row.edited" },
      orderBy: { createdAt: "desc" },
      select: { targetId: true, actor: { select: { name: true } } },
      take: 1000,
    });
    for (const edit of edits) {
      if (edit.targetId && edit.actor && !(edit.targetId in lastEditedBy)) {
        lastEditedBy[edit.targetId] = edit.actor.name;
      }
    }
  }
  const relationProperties = properties.filter((property) => {
    if (property.type !== "RELATION") return false;
    const config = property.config as { targetDatabaseId?: string } | null;
    return Boolean(config?.targetDatabaseId);
  });
  await Promise.all(
    relationProperties.map(async (property) => {
      const targetDatabaseId = (property.config as { targetDatabaseId: string })
        .targetDatabaseId;
      /**
       * B100 - the relation target must lie inside the viewer's **read**
       * scope.
       *
       * The read scope is the set of pages the viewer may read: the pages
       * shared with them plus their whole subtree, never an ancestor — the
       * guest read scope of `lib/guest-access.ts`. So a guest
       * who was given a single row of the target database does **not** get the
       * database above it, while a guest who was given a parent page does get
       * the database below it.
       *
       * The scope is checked **before** the target is resolved, so a target
       * the viewer may not read is not read at all, and the answer is the same
       * empty one a target outside the workspace gets - a refusal must not
       * confirm that the target exists (no existence oracle).
       */
      if (readablePageIds && !readablePageIds.has(targetDatabaseId)) {
        relationData[property.id] = { options: [], valuesByRow: {}, properties: [] };
        return;
      }
      // B98 - the target of a relation must be a database of the *same*
      // workspace as the database being read. Filtering the target's rows by
      // the target's own workspace would be tautological (a foreign target's
      // rows all carry the foreign workspace id and would pass), so the two
      // workspaces are compared explicitly. A relation that points outside the
      // workspace - from an old revision, an import or a direct database edit
      // - yields no options, no cell values and no schema.
      const target = await prisma.page.findFirst({
        where: { id: targetDatabaseId, type: "DATABASE", deletedAt: null },
        select: { id: true, workspaceId: true },
      });
      if (!target || target.workspaceId !== workspaceId) {
        relationData[property.id] = { options: [], valuesByRow: {}, properties: [] };
        return;
      }
      const [targetProperties, targetRows] = await Promise.all([
        prisma.property.findMany({
          where: {
            databasePageId: targetDatabaseId,
            databasePage: { workspaceId: target.workspaceId },
          },
          orderBy: { position: "asc" },
          select: { id: true, name: true, type: true },
        }),
        prisma.page.findMany({
          where: {
            parentId: targetDatabaseId,
            workspaceId: target.workspaceId,
            deletedAt: null,
          },
          orderBy: { position: "asc" },
          include: { propertyValues: true },
        }),
      ]);
      relationData[property.id] = {
        options: targetRows.map((row) => ({
          id: row.id,
          title: row.title,
          icon: row.icon,
        })),
        valuesByRow: Object.fromEntries(
          targetRows.map((row) => [
            row.id,
            Object.fromEntries(row.propertyValues.map((v) => [v.propertyId, v.value])),
          ]),
        ),
        properties: targetProperties,
      };
    }),
  );

  // Narrow each template's `config` (a Prisma `JsonValue`) to the shape
  // `database-view`'s template engine reads (`config.values` = property
  // defaults); `content` passes through untouched. Purely a type projection —
  // the stored JSON is unchanged.
  const templates = templateRows.map((template) => ({
    ...template,
    config: (template.config ?? null) as unknown as {
      values?: { propertyId: string; value: unknown }[];
    } | null,
  }));

  return { properties, views, rows, templates, relationData, lastEditedBy };
}

export type DatabaseData = Awaited<ReturnType<typeof getDatabase>>;

/** Pages in the workspace that @-mention the given page (linked references). */
export async function getBacklinks(
  workspaceId: string,
  pageId: string,
  visiblePageIds: Set<string> | null = null,
) {
  const pages = await prisma.page.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      NOT: { id: pageId },
      ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 1000,
    select: { id: true, title: true, icon: true, content: true },
  });
  return pages
    .filter((page) => docMentionsPage(page.content, pageId))
    .map(({ id, title, icon }) => ({ id, title, icon }));
}

