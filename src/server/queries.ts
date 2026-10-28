/**
 * Server read surface.
 *
 * Each domain keeps its queries beside its actions under `src/server/queries/`.
 * This barrel preserves the long-standing `@/server/queries` import path while
 * the screen/action code migrates to the domain modules.
 */
export {
  searchPages,
  searchPagesPaged,
  searchPagesPage,
  searchPagesForPrompt,
} from "@/server/queries/search";
export type { ApiSearchRow } from "@/server/queries/search";

export {
  getDatabase,
  getBacklinks,
  type RelationData,
  type DatabaseData,
} from "@/server/queries/database";

export {
  getLabels,
  getTickets,
  getTicketViews,
  getCycles,
  getRecentActivity,
  getActivityPage,
  type ActivityPageFilters,
  getTicketsPage,
  type ApiTicketRow,
  getTicketsCursorPage,
  getTicketListRow,
  getProjectTickets,
  getTicketDetail,
  getProjectTicketSummary,
} from "@/server/queries/tickets";

export {
  getNotifications,
  getUnreadNotificationCount,
  getRecentWebhookDeliveries,
  getChatThreads,
  getChatThread,
  getCalendarFeeds,
  getUpcomingEvents,
  getChatThreadsWithMessages,
} from "@/server/queries/notifications";

export {
  getUserWorkspaces,
  getWorkspacesPage,
  getWorkspaceBySlug,
  getPageTree,
  getPagesPage,
  getTeamspaces,
  rootPages,
  childrenOf,
  getTrash,
  getFavorites,
  getPageDetail,
  getAncestorTrail,
  getWorkspaceMembers,
  getProjects,
  getProjectDetail,
  getAttachablePages,
  type PageTreeNode,
  type ApiWorkspaceRow,
  type ApiPageRow,
  type TeamspaceView,
} from "@/server/queries/workspaces";
