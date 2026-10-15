import { notFound } from "next/navigation";
import type { PropertyType } from "@prisma/client";
import { cn } from "@/lib/utils";
import { prosemirrorToText } from "@/lib/blocks";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { groupReactions } from "@/lib/comments";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageScopeFor } from "@/lib/guest-access";
import {
  getAncestorTrail,
  getDatabase,
  getPageDetail,
  getTeamspaces,
  getUserWorkspaces,
  getWorkspaceBySlug,
  getWorkspaceMembers,
} from "@/server/queries";
import { getPageReferences } from "@/server/backlinks";
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
  const visiblePageIds = await pageScopeFor(user.id, workspace.id, access.role);
  if (visiblePageIds && !visiblePageIds.has(pageId)) notFound();

  const page = await getPageDetail(pageId);
  if (!page || page.workspaceId !== workspace.id || page.deletedAt) {
    notFound();
  }

  const [database, references, breadcrumbTrail, following, databases, userWorkspaces, members, pagePermissions, teamspaces] = await Promise.all([
    page.type === "DATABASE" ? getDatabase(page.id) : Promise.resolve(null),
    getPageReferences(workspace.id, page.id, page.title, visiblePageIds),
    getAncestorTrail(workspace.id, page.id),
    prisma.pageFollow.findUnique({
      where: { userId_pageId: { userId: user.id, pageId: page.id } },
      select: { id: true },
    }),
    prisma.page.findMany({
      where: { workspaceId: workspace.id, type: "DATABASE", deletedAt: null },
      orderBy: { position: "asc" },
      select: { id: true, title: true, icon: true },
    }),
    getUserWorkspaces(user.id),
    getWorkspaceMembers(workspace.id),
    prisma.pagePermission.findMany({
      where: { pageId: page.id, userId: user.id },
      select: { level: true },
      take: 1,
    }),
    getTeamspaces(workspace.id),
  ]);

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
        page.fullWidth ? "max-w-none" : database ? "max-w-5xl" : "max-w-[720px]",
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

      <Backlinks
        items={references.linked}
        unlinked={references.unlinked}
        workspaceSlug={workspace.slug}
        locale={locale}
      />

      <section className="mt-12 border-t border-border pt-6">
        <VersionHistory
          pageId={page.id}
          locale={locale}
          current={{
            title: page.title,
            updatedAt: page.updatedAt.toISOString(),
            content: previewText(page.content),
          }}
          versions={page.versions.map((version) => ({
            id: version.id,
            title: version.title,
            content: previewText(version.content),
            summary: version.summary,
            charDelta: version.charDelta,
            createdAt: version.createdAt.toISOString(),
            author: resolveVersionAuthor(version.createdById),
          }))}
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
