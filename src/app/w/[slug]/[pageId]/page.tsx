import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { PropertyType } from "@prisma/client";
import { cn } from "@/lib/utils";
import { prosemirrorToText } from "@/lib/blocks";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { groupReactions } from "@/lib/comments";
import { getWorkspaceAccess, canPerformWorkspaceAction } from "@/lib/permissions";
import { viewerScopeFor } from "@/lib/guest-access";
import { buildVersionRecord } from "@/lib/version-history";
import {
  getAncestorTrail,
  getDatabase,
  getPageDetail,
  getTeamspaces,
  getUserWorkspaces,
  getWorkspaceBySlug,
  getWorkspaceMembers,
} from "@/server/queries";
import { getPageReferences, type PageReferences } from "@/server/backlinks";
import { PageEditor } from "@/components/editor/page-editor";
import { PageTitle } from "@/components/page-title";
import { CommentPanel, type CommentNode } from "@/components/comment-panel";
import { Backlinks } from "@/components/backlinks";
import { VersionHistory } from "@/components/version-history";
import { loadVersionAuthors } from "@/server/version-authors";
import {
  DatabaseView,
  type DBProperty,
  type DBRow,
  type DBView,
} from "@/components/database/database-view";

export default async function PageRoute({
  params,
}: {
  params: Promise<{ slug: string; pageId: string }>;
}) {
  const { slug, pageId } = await params;
  const user = await requireUser();
  const locale = user.locale ?? "en";
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();
  // Guests may only open pages that were shared with them (or their own).
  // The scope also names the teamspaces whose names the viewer may see: a
  // guest must not receive the workspace's teamspace names.
  const scope = await viewerScopeFor(user.id, workspace.id, access.role);
  const visiblePageIds = scope?.pageIds ?? null;
  const visibleTeamspaceIds = scope?.teamspaceIds ?? null;
  if (visiblePageIds && !visiblePageIds.has(pageId)) notFound();
  // The roster carries every member's name: it needs its own permission, so a
  // guest never receives it — not even in the RSC payload.
  const directory = canPerformWorkspaceAction(access.role, "viewMemberDirectory");

  const page = await getPageDetail(pageId);
  if (!page || page.workspaceId !== workspace.id || page.deletedAt) {
    notFound();
  }

  // The reference scan walks the workspace's link graph (up to 1000 pages), so
  // it is started alongside the other reads but deliberately NOT awaited here:
  // it streams into the `Backlinks` panel below (same query, same guest-scoping
  // guard) so the editor paints first while the panel shows its own skeleton.
  const referencesPromise = getPageReferences(
    workspace.id,
    page.id,
    page.title,
    visiblePageIds,
  );

  const [database, breadcrumbTrail, following, databases, userWorkspaces, members, pagePermissions, teamspaces, versionLabels] = await Promise.all([
    page.type === "DATABASE" ? getDatabase(page.id) : Promise.resolve(null),
    getAncestorTrail(workspace.id, page.id),
    prisma.pageFollow.findUnique({
      where: { userId_pageId: { userId: user.id, pageId: page.id } },
      select: { id: true },
    }),
    prisma.page.findMany({
      // The database list is a page list, so it carries the guest scope: a
      // guest never receives the title of a database they cannot open.
      where: {
        workspaceId: workspace.id,
        type: "DATABASE",
        deletedAt: null,
        ...(visiblePageIds ? { id: { in: [...visiblePageIds] } } : {}),
      },
      orderBy: { position: "asc" },
      select: { id: true, title: true, icon: true },
    }),
    getUserWorkspaces(user.id),
    directory
      ? getWorkspaceMembers(workspace.id)
      : Promise.resolve([] as Awaited<ReturnType<typeof getWorkspaceMembers>>),
    prisma.pagePermission.findMany({
      where: { pageId: page.id, userId: user.id },
      select: { level: true },
      take: 1,
    }),
    getTeamspaces(workspace.id, visibleTeamspaceIds),
    // `PageVersion.label` (R30.10 named versions) is not part of
    // `getPageDetail`'s snapshot select, so read it here (same newest-first
    // window) and join it back onto the rows below by id.
    prisma.pageVersion.findMany({
      where: { pageId: page.id },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, label: true },
    }),
  ]);

  /**
   * Stored snapshot labels by version id (blank/`null` = an ordinary auto
   * snapshot). The history panel renders each row's `summary`, so a named
   * snapshot surfaces through `buildVersionRecord` - the pure R30.10 helper
   * folds the label and the snapshot's own date into that line.
   */
  const versionLabelById = new Map(
    versionLabels.map((version) => [version.id, version.label]),
  );

  /**
   * Stored ProseMirror doc → plain-text preview for the inline diff (F7 reads
   * raw strings). A snapshot that carried no body returns `null` so the
   * component keeps its documented fallback to the row title.
   */
  const previewText = (doc: unknown): string | null =>
    doc === null || doc === undefined ? null : prosemirrorToText(doc);

  // One shared authorship resolver for BOTH history surfaces (R30.11 of
  // docs/specs/version-history-v2.md): the User row is looked up by
  // `createdById` regardless of current membership, so a departed member
  // renders here exactly as in the ...-menu timeline - the old
  // `members.find(...)` made them surface-dependent "Unknown".
  const resolveVersionAuthor = await loadVersionAuthors(
    page.versions.map((version) => version.createdById),
  );

  const editable =
    access.role !== "GUEST" &&
    !page.locked &&
    (pagePermissions[0] === undefined ||
      pagePermissions[0].level === "EDIT" ||
      pagePermissions[0].level === "FULL");

  const comments: CommentNode[] = page.comments.map((c) => ({
    id: c.id,
    body: c.body,
    quote: c.quote,
    resolved: c.resolved,
    createdAt: c.createdAt.toISOString(),
    author: c.author,
    reactions: groupReactions(c.reactions, user.id),
    replies: c.replies.map((r) => ({
      id: r.id,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      author: r.author,
      reactions: groupReactions(r.reactions, user.id),
    })),
  }));

  return (
    <div
      className={cn(
        "mx-auto px-12 py-12",
        // Full-bleed by default: databases use the whole width, pages get a
        // generous cap (the per-page "Full width" toggle removes it entirely).
        page.fullWidth ? "max-w-none" : database ? "max-w-none" : "max-w-[1100px]",
        page.smallText && "noema-page-small",
        page.font === "serif" && "noema-font-serif",
        page.font === "mono" && "noema-font-mono",
      )}
    >
      <PageTitle
        pageId={page.id}
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        workspaceName={workspace.name}
        initialTitle={page.title}
        initialIcon={page.icon}
        initialCover={page.coverUrl}
        initialFavorite={page.isFavorite}
        initialFullWidth={page.fullWidth}
        initialSmallText={page.smallText}
        initialFont={page.font}
        initialLineSpacing={page.lineSpacing}
        initialSharedToken={page.shareLinks[0]?.token ?? null}
        initialFollowing={Boolean(following)}
        initialLocked={page.locked}
        breadcrumbTrail={breadcrumbTrail}
        workspaces={userWorkspaces
          .filter((candidate) => candidate.id !== workspace.id)
          .map((candidate) => ({ id: candidate.id, name: candidate.name, slug: candidate.slug }))}
        members={members.map((member) => ({ id: member.id, name: member.name }))}
        teamspaces={teamspaces.map((teamspace) => ({ id: teamspace.id, name: teamspace.name, icon: teamspace.icon }))}
        editable={editable}
        locale={locale}
      />

      {database ? (
        <DatabaseView
          locale={locale}
          databasePageId={page.id}
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          templates={database.templates}
          relationData={database.relationData}
          databases={databases}
          properties={
            database.properties.map((p) => ({
              ...p,
              type: p.type as PropertyType,
              config: (p.config ?? null) as DBProperty["config"],
            })) as DBProperty[]
          }
          views={database.views.map((v) => ({
            id: v.id,
            name: v.name,
            type: v.type,
            config: (v.config ?? null) as DBView["config"],
          }))}
          rows={
            database.rows.map((r) => ({
              id: r.id,
              title: r.title,
              icon: r.icon,
              createdAt: r.createdAt.toISOString(),
              updatedAt: r.updatedAt.toISOString(),
              createdByName: r.createdBy?.name ?? null,
              lastEditedByName: database.lastEditedBy[r.id] ?? r.createdBy?.name ?? null,
              propertyValues: r.propertyValues.map((pv) => ({
                propertyId: pv.propertyId,
                value: pv.value,
              })),
            })) as DBRow[]
          }
          members={members.map((member) => ({ id: member.id, name: member.name }))}
          editable={editable}
          schemaLocked={page.schemaLocked}
        />
      ) : (
        <PageEditor
            locale={locale}
            editorPlaceholder={t(locale, "editorPlaceholder")}
          pageId={page.id}
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          breadcrumbTrail={breadcrumbTrail}
          initialContent={page.content}
          editable={editable}
        />
      )}

      <Suspense
        fallback={
          <Backlinks
            items={[]}
            workspaceSlug={workspace.slug}
            locale={locale}
            loading
          />
        }
      >
        <PageReferencesPanel
          references={referencesPromise}
          workspaceSlug={workspace.slug}
          locale={locale}
        />
      </Suspense>

      <section className="mt-12 border-t border-border pt-6">
        <VersionHistory
          pageId={page.id}
          locale={locale}
          current={{
            title: page.title,
            updatedAt: page.updatedAt.toISOString(),
            content: previewText(page.content),
          }}
          versions={page.versions.map((version) => {
            const label = versionLabelById.get(version.id) ?? null;
            return {
              id: version.id,
              title: version.title,
              content: previewText(version.content),
              // A named snapshot (R30.10) names its row via the shared
              // `buildVersionRecord` summary; an unnamed one keeps the existing
              // stored summary, so the change stays additive.
              summary:
                label !== null
                  ? buildVersionRecord({
                      id: version.id,
                      createdAt: version.createdAt,
                      label,
                    }).summary
                  : version.summary,
              charDelta: version.charDelta,
              createdAt: version.createdAt.toISOString(),
              author: resolveVersionAuthor(version.createdById),
            };
          })}
        />
      </section>

      <CommentPanel
          locale={locale}
        pageId={page.id}
        comments={comments}
        currentUserId={user.id}
        canComment={editable}
      />
    </div>
  );
}

/**
 * The reference lists stream in after the page shell. `getPageReferences` walks
 * the workspace's link graph, so awaiting it inside the `<Suspense>` boundary
 * above lets the editor paint first while `Backlinks` shows its skeleton; a
 * failed scan renders the panel's own error + retry state (docs/DESIGN_SYSTEM.md
 * §8) rather than taking the whole route down, and `showEmpty` surfaces the
 * actionable empty state when a page genuinely has no references yet.
 */
async function PageReferencesPanel({
  references,
  workspaceSlug,
  locale,
}: {
  references: Promise<PageReferences>;
  workspaceSlug: string;
  locale: string;
}) {
  // `references` is the route's own scan (started with the other reads above);
  // a rejected scan resolves to `null` here so the panel can retry in place.
  const data = await references.catch(() => null);
  if (data === null) {
    return (
      <Backlinks
        items={[]}
        workspaceSlug={workspaceSlug}
        locale={locale}
        error={t(locale, "somethingWentWrong")}
        showEmpty
      />
    );
  }
  return (
    <Backlinks
      items={data.linked}
      unlinked={data.unlinked}
      workspaceSlug={workspaceSlug}
      locale={locale}
      showEmpty
    />
  );
}
