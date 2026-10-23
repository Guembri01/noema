import type { JsonSchema, JsonSchemaProperty, McpTool } from "./mcp-server";

/**
 * Extended MCP catalogue.
 *
 * The original eight tools stay in `mcp-server.ts`; this file adds the
 * read/collaboration/database/ticket/project surface around them. Tool
 * definitions are deliberately pure (no Prisma, no React), so they can be
 * discovered and validated without a database. Execution lives in
 * `mcp-extra-exec.ts`.
 */

type ExtraTool = McpTool & {
  /** Hidden unless the endpoint opts in with `allowAdmin=true`. */
  adminOnly?: boolean;
};

const str = (description: string): JsonSchemaProperty => ({ type: "string", description });
const num = (description: string, minimum?: number, maximum?: number): JsonSchemaProperty => ({
  type: "integer",
  description,
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
const bool = (description: string): JsonSchemaProperty => ({ type: "boolean", description });
const obj = (description: string): JsonSchemaProperty => ({ type: "object", description });
const arr = (description: string, itemType: "string" | "number" | "object" = "string"): JsonSchemaProperty => ({
  type: "array",
  description,
  items: { type: itemType },
});
const oneOf = (description: string, values: readonly string[]): JsonSchemaProperty => ({
  type: "string",
  description,
  enum: values,
});

function schema(
  properties: Record<string, JsonSchemaProperty>,
  required: readonly string[] = [],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function tool(
  name: string,
  description: string,
  requiredScopes: readonly string[],
  inputSchema: JsonSchema,
  options: { readOnly?: boolean; adminOnly?: boolean } = {},
): ExtraTool {
  return {
    name,
    description,
    requiredScopes,
    inputSchema,
    readOnly: options.readOnly ?? true,
    ...(options.adminOnly ? { adminOnly: true } : {}),
  };
}

const PAGE = "read:pages";
const DATABASE = "read:databases";
const TICKETS = "read:tickets";
const MEMBERS = "read:members";
const FILES = "read:files";
const WRITE_PAGE = "write:pages";
const WRITE_DATABASE = "write:databases";
const WRITE_COMMENT = "write:comments";
const WRITE_TICKET = "write:tickets";

export const EXTRA_TOOLS: readonly ExtraTool[] = [
  /* ------------------------------------------------------------------ */
  /* Read: pages, navigation, history                                   */
  /* ------------------------------------------------------------------ */
  tool("get_page_tree", "Read a page tree: children and descendants, with titles and ids.", [PAGE], schema({
    pageId: str("Optional root page id. Omit for workspace roots."),
    depth: num("Maximum depth, 1–8. Default 3.", 1, 8),
  })),
  tool("get_backlinks", "List pages that link to a page (explicit links and @-mentions).", [PAGE], schema({
    pageId: str("Target page id."),
  }, ["pageId"])),
  tool("list_page_versions", "List saved revisions of a page, newest first.", [PAGE], schema({
    pageId: str("Page id."),
    limit: num("Maximum revisions, 1–100. Default 20.", 1, 100),
  }, ["pageId"])),
  tool("get_page_version", "Read one saved page revision, including its content.", [PAGE], schema({
    versionId: str("Page version id."),
  }, ["versionId"])),
  tool("export_page", "Export a page as markdown, JSON or HTML.", [PAGE], schema({
    pageId: str("Page id."),
    format: oneOf("Output format. Default markdown.", ["markdown", "json", "html"]),
  }, ["pageId"])),
  tool("get_database_schema", "Read a database's properties and views.", [DATABASE], schema({
    databaseId: str("Database page id."),
  }, ["databaseId"])),
  tool("list_templates", "List database row templates.", [DATABASE], schema({
    databaseId: str("Optional database id. Omit to list templates across the workspace."),
  })),

  /* ------------------------------------------------------------------ */
  /* Read: tickets, projects, cycles, membership                        */
  /* ------------------------------------------------------------------ */
  tool("list_tickets", "List tickets with optional status/project/assignee filters.", [TICKETS], schema({
    status: str("Optional status id."),
    priority: str("Optional priority id."),
    projectId: str("Optional project id."),
    assigneeId: str("Optional assignee user id."),
    archived: bool("Read archived tickets instead of live tickets."),
    limit: num("Maximum tickets, 1–100. Default 50.", 1, 100),
  })),
  tool("get_ticket", "Read one ticket with labels, relations and comments.", [TICKETS], schema({
    ticketId: str("Ticket id or key."),
  }, ["ticketId"])),
  tool("list_projects", "List projects in the workspace.", [PAGE], schema({
    status: str("Optional project status."),
    limit: num("Maximum projects, 1–100. Default 50.", 1, 100),
  })),
  tool("get_project", "Read one project with milestones and counts.", [PAGE], schema({
    projectId: str("Project id."),
  }, ["projectId"])),
  tool("list_cycles", "List cycles in the workspace.", [TICKETS], schema({
    limit: num("Maximum cycles, 1–100. Default 50.", 1, 100),
  })),
  tool("list_labels", "List workspace ticket labels.", [TICKETS], schema({})),
  tool("get_workspace_info", "Read workspace identity, role and member count.", [PAGE], schema({})),
  tool("list_members", "List workspace members. Requires member-directory access.", [MEMBERS], schema({})),
  tool("list_page_permissions", "List workspace members and their page-level access overrides.", [MEMBERS], schema({
    pageId: str("Page id."),
  }, ["pageId"])),
  tool("list_attachments", "List uploaded attachments, optionally for one page.", [FILES], schema({
    pageId: str("Optional page id."),
  })),
  tool("list_notifications", "List the caller's notifications.", [PAGE], schema({
    unreadOnly: bool("Only unread notifications."),
    limit: num("Maximum notifications, 1–100. Default 50.", 1, 100),
  })),

  /* ------------------------------------------------------------------ */
  /* Page editing                                                       */
  /* ------------------------------------------------------------------ */
  tool("update_page", "Update page title, icon, cover, layout, lock or full content. Snapshots the previous revision.", [WRITE_PAGE], schema({
    pageId: str("Page id."),
    title: str("New title."),
    icon: str("Emoji/icon; empty string clears it."),
    coverUrl: str("Cover URL; empty string clears it."),
    fullWidth: bool("Use full-width layout."),
    smallText: bool("Use small text."),
    font: oneOf("Page font.", ["default", "serif", "mono"]),
    lineSpacing: oneOf("Line spacing.", ["tight", "normal", "loose"]),
    locked: bool("Lock or unlock page content."),
    content: obj("Optional full page document (replaces content)."),
  }, ["pageId"]), { readOnly: false }),
  tool("block_manage", "Insert, update, delete or replace blocks on a page.", [WRITE_PAGE], schema({
    action: oneOf("Operation.", ["insert", "update", "delete", "replace"]),
    pageId: str("Page id."),
    blockId: str("Block id (update/delete)."),
    index: num("Insertion index. Omit to append."),
    block: obj("Block JSON (insert/update)."),
    content: obj("Full document (replace)."),
  }, ["action", "pageId"]), { readOnly: false }),
  tool("page_lifecycle", "Move, archive, restore or duplicate a page.", [WRITE_PAGE], schema({
    action: oneOf("Operation.", ["move", "archive", "restore", "duplicate"]),
    pageId: str("Page id."),
    parentId: str("Destination parent id for move; empty string means workspace root."),
  }, ["action", "pageId"]), { readOnly: false }),

  /* ------------------------------------------------------------------ */
  /* Database editing                                                   */
  /* ------------------------------------------------------------------ */
  tool("database_manage", "Create databases/rows, edit properties and views, and update cells in bulk.", [WRITE_DATABASE], schema({
    action: oneOf("Operation.", [
      "create",
      "create_row",
      "delete_row",
      "batch_values",
      "add_property",
      "update_property",
      "delete_property",
      "reorder_properties",
      "reorder_rows",
      "create_view",
      "update_view",
      "duplicate_view",
    ]),
    databaseId: str("Database page id."),
    parentId: str("Parent id for a new database."),
    title: str("New database or row title."),
    properties: obj("Row property values keyed by property id."),
    rowId: str("Row page id."),
    updates: arr("Batch cell updates: { rowId, propertyId, value }.", "object"),
    propertyId: str("Property id."),
    name: str("Property/view name."),
    type: str("Property type."),
    config: obj("Property/view config."),
    confirm: bool("Must be true for delete_property."),
    order: arr("Ordered ids."),
    viewId: str("View id."),
    viewType: str("View type."),
    viewConfig: obj("View config."),
  }, ["action"]), { readOnly: false }),

  /* ------------------------------------------------------------------ */
  /* Collaboration                                                      */
  /* ------------------------------------------------------------------ */
  tool("comment_manage", "Create, edit, resolve, delete or react to page comments.", [WRITE_COMMENT], schema({
    action: oneOf("Operation.", ["create", "edit", "resolve", "delete", "react"]),
    pageId: str("Page id (create)."),
    commentId: str("Comment id (edit/resolve/delete/react)."),
    body: str("Comment body."),
    parentId: str("Optional parent comment id."),
    blockId: str("Optional block id."),
    quote: str("Optional quoted text."),
    resolved: bool("Resolve (true) or reopen (false)."),
    emoji: str("Reaction emoji."),
    confirm: bool("Must be true for delete."),
  }, ["action"]), { readOnly: false }),

  /* ------------------------------------------------------------------ */
  /* Tickets                                                            */
  /* ------------------------------------------------------------------ */
  tool("ticket_manage", "Create, update, archive, link, comment on, label and bulk-edit tickets.", [WRITE_TICKET], schema({
    action: oneOf("Operation.", [
      "create",
      "update",
      "archive",
      "restore",
      "delete",
      "comment",
      "link",
      "unlink",
      "bulk_update",
      "toggle_label",
      "create_label",
      "update_label",
      "delete_label",
    ]),
    ticketId: str("Ticket id."),
    title: str("Ticket title."),
    description: str("Plain-text description."),
    status: str("Status id."),
    priority: str("Priority id."),
    type: str("Ticket type."),
    estimate: num("Estimate.", 0),
    estimateUnit: str("Estimate unit."),
    projectId: str("Project id."),
    milestoneId: str("Milestone id."),
    assigneeId: str("Assignee user id."),
    parentId: str("Parent ticket id."),
    labelIds: arr("Label ids."),
    body: str("Ticket comment body."),
    fromId: str("Relation source ticket id."),
    toId: str("Relation target ticket id."),
    relationType: oneOf("Relation type.", ["relates", "blocks", "blocked_by", "duplicates"]),
    relationId: str("Relation id to remove."),
    ticketIds: arr("Ticket ids for a bulk operation."),
    addLabelIds: arr("Labels to add."),
    removeLabelIds: arr("Labels to remove."),
    labelId: str("Label id."),
    name: str("Label name."),
    color: str("Label colour."),
    archived: bool("Archive (true) or restore (false)."),
    confirm: bool("Must be true for delete."),
  }, ["action"]), { readOnly: false }),

  /* ------------------------------------------------------------------ */
  /* Projects and cycles                                                */
  /* ------------------------------------------------------------------ */
  tool("project_manage", "Create/update/delete projects and their milestones.", [WRITE_PAGE], schema({
    action: oneOf("Operation.", ["create", "update", "delete", "add_milestone", "update_milestone", "delete_milestone"]),
    projectId: str("Project id."),
    milestoneId: str("Milestone id."),
    name: str("Project or milestone name."),
    summary: str("Project summary."),
    description: str("Description."),
    status: str("Status."),
    color: str("Colour."),
    icon: str("Icon."),
    dueDate: str("ISO due date."),
    startDate: str("ISO start date."),
    completedAt: str("ISO completion date."),
    confirm: bool("Must be true for delete/delete_milestone."),
  }, ["action"]), { readOnly: false }),
  tool("cycle_manage", "Create, update, delete cycles and assign tickets.", [WRITE_TICKET], schema({
    action: oneOf("Operation.", ["create", "update", "delete", "assign"]),
    cycleId: str("Cycle id."),
    ticketId: str("Ticket id."),
    name: str("Cycle name."),
    startDate: str("ISO start date."),
    endDate: str("ISO end date."),
    goal: str("Cycle goal."),
    confirm: bool("Must be true for delete."),
  }, ["action"]), { readOnly: false }),

  /* ------------------------------------------------------------------ */
  /* Templates                                                          */
  /* ------------------------------------------------------------------ */
  tool("template_manage", "Save a row as a template, create a row from a template, or delete a template.", [WRITE_DATABASE], schema({
    action: oneOf("Operation.", ["save_row", "create_row", "delete"]),
    databaseId: str("Database id."),
    rowId: str("Source row id."),
    templateId: str("Template id."),
    name: str("Template name."),
    confirm: bool("Must be true for delete."),
  }, ["action"]), { readOnly: false }),

  /* ------------------------------------------------------------------ */
  /* Admin / sharing                                                    */
  /* ------------------------------------------------------------------ */
  tool("share_manage", "Create/revoke share links and override page access. Requires allowAdmin.", [WRITE_PAGE], schema({
    action: oneOf("Operation.", ["create_link", "revoke_link", "set_permission"]),
    pageId: str("Page id."),
    userId: str("Member user id for set_permission."),
    level: oneOf("Access level, or INHERIT to remove the override.", ["READ", "COMMENT", "EDIT", "FULL", "INHERIT"]),
    password: str("Optional share password."),
    expiresInDays: num("Optional expiry in days.", 1, 3650),
    indexing: bool("Allow search-engine indexing."),
  }, ["action", "pageId"]), { readOnly: false, adminOnly: true }),
  tool("workspace_manage", "Invite/remove members, change roles, empty trash, or delete a page. Requires allowAdmin.", ["admin:workspace"], schema({
    action: oneOf("Operation.", ["invite_member", "set_member_role", "remove_member", "empty_trash", "delete_page"]),
    email: str("Invite email."),
    role: oneOf("Workspace role.", ["GUEST", "MEMBER", "ADMIN"]),
    userId: str("Member user id."),
    pageId: str("Page id for delete_page."),
    confirm: bool("Must be true for delete_page/empty_trash."),
  }, ["action"]), { readOnly: false, adminOnly: true }),

  /* ------------------------------------------------------------------ */
  /* Personal state, teamspaces, webhooks, import/export                */
  /* ------------------------------------------------------------------ */
  tool("favorite_manage", "Favorite/unfavorite or follow/unfollow a page.", [WRITE_PAGE], schema({
    action: oneOf("Operation.", ["favorite", "follow"]),
    pageId: str("Page id."),
  }, ["action", "pageId"]), { readOnly: false }),
  tool("notification_manage", "Mark one notification or all notifications as read.", [WRITE_PAGE], schema({
    action: oneOf("Operation.", ["mark_read", "mark_all_read"]),
    notificationId: str("Notification id for mark_read."),
  }, ["action"]), { readOnly: false }),
  tool("export_database", "Export a database as CSV.", [DATABASE], schema({
    databaseId: str("Database page id."),
  }, ["databaseId"])),
  tool("import_markdown", "Import a Markdown document as a page.", [WRITE_PAGE], schema({
    filename: str("Filename, e.g. notes.md."),
    markdown: str("Markdown body."),
    parentId: str("Optional parent page id."),
  }, ["filename", "markdown"]), { readOnly: false }),
  tool("teamspace_manage", "List/create/delete teamspaces and add/remove members. Requires allowAdmin.", ["admin:workspace"], schema({
    action: oneOf("Operation.", ["list", "create", "delete", "add_member", "remove_member"]),
    teamspaceId: str("Teamspace id."),
    userId: str("Member user id."),
    name: str("Teamspace name."),
    icon: str("Teamspace icon."),
    confirm: bool("Must be true for delete."),
  }, ["action"]), { readOnly: false, adminOnly: true }),
  tool("webhook_manage", "List/create/delete outbound webhooks. Requires allowAdmin.", ["admin:workspace"], schema({
    action: oneOf("Operation.", ["list", "create", "delete"]),
    webhookId: str("Webhook id."),
    url: str("HTTPS endpoint URL."),
    events: arr("Subscribed event names."),
    secret: str("Signing secret (required for create)."),
    confirm: bool("Must be true for delete."),
  }, ["action"]), { readOnly: false, adminOnly: true }),
];
