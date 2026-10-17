import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { resolveAiConfig } from "@/lib/ai-provider";
import { prisma } from "@/lib/db";
import { pageScopeFor } from "@/lib/guest-access";
import { getWorkspaceAccess } from "@/lib/permissions";
import { chatModelInfo } from "@/lib/chat-model";
import {
  getCalendarFeeds,
  getChatThreadsWithMessages,
  getFavorites,
  getPageTree,
  getTeamspaces,
  getProjects,
  getUnreadNotificationCount,
  getUpcomingEvents,
  getUserWorkspaces,
  getWorkspaceBySlug,
} from "@/server/queries";
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
  const visiblePageIds = await pageScopeFor(user.id, workspace.id, access.role);


  const [
    workspaces,
    tree,
    favorites,
    unreadCount,
    teamspaces,
    chatThreads,
    meetingEvents,
    calendarFeeds,
    projects,
    aiConfig,
    openTickets,
  ] = await Promise.all([
    getUserWorkspaces(user.id),
    getPageTree(workspace.id, visiblePageIds),
    getFavorites(user.id, workspace.id),
    getUnreadNotificationCount(user.id),
    getTeamspaces(workspace.id),
    getChatThreadsWithMessages(workspace.id),
    getUpcomingEvents(workspace.id),
    getCalendarFeeds(workspace.id),
    getProjects(workspace.id),
    resolveAiConfig(workspace.id),
    prisma.ticket.count({ where: { workspaceId: workspace.id, archived: false, status: { notIn: ["done", "cancelled"] } } }),
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
      teamspaces={teamspaces.map((teamspace) => ({ id: teamspace.id, name: teamspace.name, icon: teamspace.icon }))}
      chatThreads={chatThreads}
      meetingEvents={meetingEvents}
      calendarFeeds={calendarFeeds}
      projects={projects.map((project) => ({ id: project.id, name: project.name, icon: project.icon }))}
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
      openTickets={openTickets}
      favorites={favorites}
      user={{ name: user.name, email: user.email }}
      unreadCount={unreadCount}
      locale={user.locale}
    >
      {children}
    </WorkspaceShell>
  );
}
