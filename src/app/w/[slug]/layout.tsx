import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { resolveAiConfig } from "@/lib/ai-provider";
import { viewerScopeFor } from "@/lib/guest-access";
import { getWorkspaceAccess } from "@/lib/permissions";
import { chatModelInfo } from "@/lib/chat-model";
import {
  getFavorites,
  getPageTree,
  getUnreadNotificationCount,
  getUserWorkspaces,
  getWorkspaceBySlug,
} from "@/server/queries";
import { getWorkspaceShellDatasets } from "@/server/workspace-shell";
import { WorkspaceShell } from "@/components/workspace-shell";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const access = await getWorkspaceAccess(user.id, workspace.id);
  // Guests only see the pages that were shared with them.
  if (!access) notFound();
  // One scope for the whole shell: the pages the viewer may see and the
  // teamspaces whose names they may see (a guest's pages live in the
  // teamspaces the sidebar has to draw them under).
  const scope = await viewerScopeFor(user.id, workspace.id, access.role);
  const visiblePageIds = scope?.pageIds ?? null;
  const visibleTeamspaceIds = scope?.teamspaceIds ?? null;

  const [workspaces, tree, favorites, unreadCount, shell, aiConfig] = await Promise.all([
    getUserWorkspaces(user.id),
    getPageTree(workspace.id, visiblePageIds),
    getFavorites(user.id, workspace.id, visiblePageIds),
    getUnreadNotificationCount(user.id),
    // The chat log, the calendars, the projects and the ticket count are
    // workspace-scoped, not page-scoped: `getWorkspaceShellDatasets` hands a
    // guest none of them. The teamspaces follow the viewer's teamspace scope,
    // so a guest sees the teamspaces their own pages live in — and only those.
    getWorkspaceShellDatasets({
      workspaceId: workspace.id,
      role: access.role,
      visibleTeamspaceIds,
    }),
    resolveAiConfig(workspace.id),
  ]);

  return (
    <WorkspaceShell
      workspace={{
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        icon: workspace.icon,
        role: access.role,
      }}
      workspaces={workspaces}
      tree={tree}
      teamspaces={shell.teamspaces}
      chatThreads={shell.chatThreads}
      meetingEvents={shell.meetingEvents}
      calendarFeeds={shell.calendarFeeds}
      projects={shell.projects}
      aiModel={aiConfig ? aiConfig.model : "no model"}
      chatModel={chatModelInfo({
        provider: aiConfig?.provider,
        model: aiConfig?.model,
        // A deployment that names only a base URL resolves to `custom`; the host is
        // what lets the picker offer that provider's models.
        baseUrl: aiConfig?.baseUrl,
        // `resolveAiConfig` falls back to the environment, and returns null when
        // nothing is configured at all - the picker tells those apart.
        source: aiConfig?.source ?? "none",
      })}
      openTickets={shell.openTickets}
      favorites={favorites}
      user={{ name: user.name, email: user.email }}
      unreadCount={unreadCount}
      locale={user.locale}
    >
      {children}
    </WorkspaceShell>
  );
}
