import type { PropertyType, WorkspaceRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { runAsActor } from "@/lib/actor-context";
import { canPerformWorkspaceAction } from "@/lib/permissions";
import { pageCapabilitiesFromRelation } from "@/lib/page-access";
import { parsePageContent } from "@/lib/validation";
import { matrixToCsv, pageToHtml, pageToMarkdown } from "@/lib/serialize";
import { formatCell } from "@/lib/database-query";
import { getBacklinks } from "@/server/queries/database";
import {
  archivePageAction,
  createPageAction,
  toggleFavoriteAction,
  toggleFollowAction,
  deletePageAction,
  emptyTrashAction,
  movePageAction,
  restorePageAction,
  updatePageAction,
} from "@/server/actions/pages";
import { duplicatePageAction } from "@/server/actions/page-menu";
import { restorePageVersionAction } from "@/server/actions/page-versions";
import {
  createPropertyAction,
  createRowAction,
  createRowFromTemplateAction,
  createViewAction,
  deletePropertyAction,
  deleteRowAction,
  deleteTemplateAction,
  duplicateViewAction,
  reorderPropertiesAction,
  reorderRowsAction,
  saveRowAsTemplateAction,
  setPropertyValueAction,
  updatePropertyAction,
  updateViewAction,
} from "@/server/actions/database";
import {
  addCommentAction,
  deleteCommentAction,
  editCommentAction,
  resolveCommentAction,
  toggleCommentReactionAction,
} from "@/server/actions/comments";
import {
  addTicketCommentAction,
  archiveTicketAction,
  bulkUpdateTicketsAction,
  createLabelAction,
  createTicketAction,
  deleteLabelAction,
  deleteTicketAction,
  linkTicketsAction,
  restoreTicketAction,
  toggleTicketLabelAction,
  unlinkTicketAction,
  updateLabelAction,
  updateTicketAction,
} from "@/server/actions/tickets";
import {
  addMilestoneAction,
  createProjectAction,
  deleteMilestoneAction,
  deleteProjectAction,
  updateMilestoneAction,
  updateProjectAction,
} from "@/server/actions/projects";
import {
  assignTicketToCycleAction,
  createCycleAction,
  deleteCycleAction,
  updateCycleAction,
} from "@/server/actions/cycles";
import {
  createShareLinkAction,
  revokeShareLinkAction,
} from "@/server/actions/share";
import {
  listPagePermissionsAction,
  setPagePermissionAction,
} from "@/server/actions/page-permissions";
import {
  removeMemberAction,
  setMemberRoleAction,
} from "@/server/actions/workspaces";
import { sendWorkspaceInviteAction } from "@/server/actions/email";
import { importMarkdownAction } from "@/server/actions/import";
import {
  addTeamspaceMemberAction,
  createTeamspaceAction,
  deleteTeamspaceAction,
  removeTeamspaceMemberAction,
} from "@/server/actions/teamspaces";
import { createWebhookAction, deleteWebhookAction } from "@/server/actions/webhooks";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/server/actions/notifications";
import { EXTRA_TOOLS } from "@/lib/mcp-extra-catalog";

export type ExtraContext = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  visiblePageIds: Set<string> | null;
};

export const EXTRA_TOOL_NAMES: ReadonlySet<string> = new Set(
  EXTRA_TOOLS.map((entry) => entry.name),
);

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function inScope(ctx: ExtraContext, pageId: string): boolean {
  return ctx.visiblePageIds === null || ctx.visiblePageIds.has(pageId);
}

/** Tickets, projects and cycles are full-member surfaces, never guest surfaces. */
function denyGuest(ctx: ExtraContext): void {
  if (ctx.role === "GUEST") {
    throw new Error("Guests cannot access the workspace tracker.");
  }
}

function errorOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

/**
 * Turn an ergonomic scalar/array into the JSON cell shape the database stores.
 * Existing object values are left untouched, so callers that already know the
 * wire shape keep working.
 */
export function encodePropertyValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    if (type === "MULTI_SELECT") return { optionIds: value.map(String) };
    if (type === "PEOPLE") return { names: value.map(String) };
    if (type === "FILES") return { files: value };
    return value;
  }
  if (typeof value === "object") return value;
  switch (type) {
    case "TEXT":
      return typeof value === "string" ? { text: value } : value;
    case "NUMBER": {
      const number = typeof value === "number" ? value : Number(value);
      return Number.isFinite(number) ? { number } : value;
    }
    case "CHECKBOX":
      return typeof value === "boolean" ? { checked: value } : value;
    case "SELECT":
    case "STATUS":
      return typeof value === "string" ? { optionId: value } : value;
    case "MULTI_SELECT":
      return Array.isArray(value) ? { optionIds: value.map(String) } : value;
    case "DATE":
      return typeof value === "string" ? { start: value } : value;
    case "PEOPLE":
      return Array.isArray(value) ? { names: value.map(String) } : value;
    case "FILES":
      return Array.isArray(value) ? { files: value } : value;
    default:
      return value;
  }
}

/** Run a server action as the API-token actor and turn `{ error }` into a throw. */
async function action<T>(ctx: ExtraContext, fn: () => Promise<T>): Promise<T> {
  const result = await runAsActor(ctx.userId, fn);
  const error = errorOf(result);
  if (error) throw new Error(error);
  return result;
}

async function readablePage(ctx: ExtraContext, pageId: string) {
  if (!inScope(ctx, pageId)) return null;
  return prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspaceId, deletedAt: null },
    select: { id: true, title: true, icon: true, type: true, content: true, updatedAt: true },
  });
}

async function editablePage(ctx: ExtraContext, pageId: string) {
  if (!inScope(ctx, pageId)) return null;
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspaceId },
    select: {
      id: true,
      title: true,
      icon: true,
      content: true,
      type: true,
      parentId: true,
      locked: true,
      updatedAt: true,
      permissions: {
        where: { userId: ctx.userId },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!page) return null;
  if (!pageCapabilitiesFromRelation(ctx.role, page.permissions).edit) return null;
  return page;
}

function blocksOf(page: { content: unknown }): Record<string, unknown>[] {
  const doc = object(page.content);
  return array(doc?.content).filter(
    (block): block is Record<string, unknown> => object(block) !== undefined,
  );
}

function blockIdentifier(block: Record<string, unknown>): string {
  const attrs = object(block.attrs);
  return str(attrs?.id) || str(block.id);
}

/** Give every new block a stable editor-compatible id. */
export function ensureBlockIds(block: Record<string, unknown>): Record<string, unknown> {
  const attrs = object(block.attrs) ?? {};
  const id = str(attrs.id) || str(block.id) || `blk_${randomUUID()}`;
  const children = array(block.content).map((child) => {
    const childObject = object(child);
    if (!childObject || childObject.type === "text" || childObject.type === "hardBreak") {
      return child;
    }
    return ensureBlockIds(childObject);
  });
  return {
    ...block,
    attrs: { ...attrs, id },
    ...(children.length ? { content: children } : {}),
  };
}

function replaceBlock(
  block: Record<string, unknown>,
  blockId: string,
  replacement?: Record<string, unknown>,
): { block: Record<string, unknown> | null; changed: boolean } {
  if (blockIdentifier(block) === blockId) {
    return { block: replacement ? ensureBlockIds({ ...replacement, attrs: { ...(object(replacement.attrs) ?? {}), id: blockId } }) : null, changed: true };
  }
  const children = array(block.content);
  if (children.length === 0) return { block, changed: false };
  const next: unknown[] = [];
  let changed = false;
  for (const child of children) {
    const childObject = object(child);
    if (!childObject) {
      next.push(child);
      continue;
    }
    const result = replaceBlock(childObject, blockId, replacement);
    changed ||= result.changed;
    if (result.block) next.push(result.block);
  }
  return {
    block: changed ? { ...block, content: next } : block,
    changed,
  };
}

async function savePageContent(
  ctx: ExtraContext,
  pageId: string,
  content: Record<string, unknown>,
): Promise<unknown> {
  const parsed = parsePageContent(content);
  if (!parsed.ok) throw new Error(parsed.error);
  return action(ctx, () => updatePageAction(pageId, { content: parsed.doc }));
}

function patchOf(args: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  if ("title" in args) patch.title = str(args.title);
  if ("icon" in args) patch.icon = str(args.icon) || null;
  if ("coverUrl" in args) patch.coverUrl = str(args.coverUrl) || null;
  if ("fullWidth" in args) patch.fullWidth = bool(args.fullWidth);
  if ("smallText" in args) patch.smallText = bool(args.smallText);
  if ("font" in args) patch.font = str(args.font);
  if ("lineSpacing" in args) patch.lineSpacing = str(args.lineSpacing);
  if ("locked" in args) patch.locked = bool(args.locked);
  if ("content" in args) {
    const content = object(args.content);
    patch.content = content
      ? {
          ...content,
          content: array(content.content).map((block) => {
            const blockObject = object(block);
            return blockObject ? ensureBlockIds(blockObject) : block;
          }),
        }
      : args.content;
  }
  return patch;
}

async function runRead(name: string, args: Record<string, unknown>, ctx: ExtraContext) {
  switch (name) {
    case "get_page_tree": {
      const rootId = str(args.pageId) || null;
      const depth = Math.min(8, Math.max(1, num(args.depth) ?? 3));
      if (rootId && !inScope(ctx, rootId)) throw new Error("Page not found.");
      const pages = await prisma.page.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          ...(ctx.visiblePageIds ? { id: { in: [...ctx.visiblePageIds] } } : {}),
        },
        orderBy: [{ position: "asc" }, { title: "asc" }],
        take: 5000,
        select: { id: true, parentId: true, title: true, type: true, icon: true, updatedAt: true },
      });
      const byParent = new Map<string | null, typeof pages>();
      for (const page of pages) {
        const list = byParent.get(page.parentId) ?? [];
        list.push(page);
        byParent.set(page.parentId, list);
      }
      const build = (parentId: string | null, level: number): unknown[] =>
        level > depth
          ? []
          : (byParent.get(parentId) ?? []).map((page) => ({
              ...page,
              children: build(page.id, level + 1),
            }));
      if (rootId) {
        const root = pages.find((page) => page.id === rootId);
        if (!root) throw new Error("Page not found.");
        return { root: { ...root, children: build(rootId, 1) } };
      }
      return { pages: build(null, 1) };
    }
    case "get_backlinks": {
      const pageId = str(args.pageId);
      if (!inScope(ctx, pageId)) throw new Error("Page not found.");
      const pages = await getBacklinks(ctx.workspaceId, pageId, ctx.visiblePageIds);
      return { pages };
    }
    case "list_page_versions": {
      const pageId = str(args.pageId);
      if (!inScope(ctx, pageId)) throw new Error("Page not found.");
      const page = await prisma.page.findFirst({
        where: { id: pageId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!page) throw new Error("Page not found.");
      const versions = await prisma.pageVersion.findMany({
        where: { pageId },
        orderBy: { createdAt: "desc" },
        take: Math.min(100, Math.max(1, num(args.limit) ?? 20)),
        select: {
          id: true,
          title: true,
          summary: true,
          label: true,
          charDelta: true,
          createdById: true,
          createdAt: true,
        },
      });
      return { versions };
    }
    case "get_page_version": {
      const version = await prisma.pageVersion.findUnique({
        where: { id: str(args.versionId) },
        select: {
          id: true,
          pageId: true,
          title: true,
          content: true,
          summary: true,
          label: true,
          charDelta: true,
          createdById: true,
          createdAt: true,
          page: { select: { workspaceId: true } },
        },
      });
      if (!version || version.page.workspaceId !== ctx.workspaceId || !inScope(ctx, version.pageId)) {
        throw new Error("Version not found.");
      }
      const { page: _page, ...rest } = version;
      return rest;
    }
    case "get_database_schema": {
      const databaseId = str(args.databaseId);
      if (!inScope(ctx, databaseId)) throw new Error("Database not found.");
      const database = await prisma.page.findFirst({
        where: { id: databaseId, workspaceId: ctx.workspaceId, type: "DATABASE", deletedAt: null },
        select: { id: true, title: true, icon: true, updatedAt: true },
      });
      if (!database) throw new Error("Database not found.");
      const [properties, views] = await Promise.all([
        prisma.property.findMany({
          where: { databasePageId: databaseId },
          orderBy: { position: "asc" },
          select: { id: true, name: true, type: true, config: true, position: true },
        }),
        prisma.databaseView.findMany({
          where: { databasePageId: databaseId },
          orderBy: { position: "asc" },
          select: { id: true, name: true, type: true, config: true, position: true },
        }),
      ]);
      return { database, properties, views };
    }
    case "list_templates": {
      const databaseId = str(args.databaseId);
      if (databaseId && !inScope(ctx, databaseId)) throw new Error("Database not found.");
      const templates = await prisma.template.findMany({
        where: {
          ...(databaseId ? { databasePageId: databaseId } : {}),
          databasePage: {
            workspaceId: ctx.workspaceId,
            ...(ctx.visiblePageIds ? { id: { in: [...ctx.visiblePageIds] } } : {}),
          },
        },
        orderBy: [{ databasePageId: "asc" }, { position: "asc" }],
        select: {
          id: true,
          databasePageId: true,
          name: true,
          icon: true,
          isDefault: true,
          recurrence: true,
          nextRunAt: true,
        },
      });
      return { templates };
    }
    case "list_tickets": {
      denyGuest(ctx);
      const limit = Math.min(100, Math.max(1, num(args.limit) ?? 50));
      const tickets = await prisma.ticket.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          archived: bool(args.archived) ?? false,
          ...(str(args.status) ? { status: str(args.status) } : {}),
          ...(str(args.priority) ? { priority: str(args.priority) } : {}),
          ...(str(args.projectId) ? { projectId: str(args.projectId) } : {}),
          ...(str(args.assigneeId) ? { assigneeId: str(args.assigneeId) } : {}),
        },
        orderBy: [{ position: "asc" }, { updatedAt: "desc" }],
        take: limit,
        select: {
          id: true,
          key: true,
          title: true,
          type: true,
          status: true,
          priority: true,
          estimate: true,
          estimateUnit: true,
          projectId: true,
          assigneeId: true,
          dueDate: true,
          archived: true,
          updatedAt: true,
          labels: { select: { label: { select: { id: true, name: true, color: true } } } },
        },
      });
      return { tickets };
    }
    case "get_ticket": {
      denyGuest(ctx);
      const idOrKey = str(args.ticketId);
      const ticket = await prisma.ticket.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          OR: [{ id: idOrKey }, { key: idOrKey }],
        },
        include: {
          labels: { select: { label: { select: { id: true, name: true, color: true } } } },
          comments: {
            orderBy: { createdAt: "asc" },
            take: 100,
            select: {
              id: true,
              body: true,
              createdAt: true,
              author: { select: { id: true, name: true, email: true } },
            },
          },
          relations: {
            select: {
              id: true,
              type: true,
              to: { select: { id: true, key: true, title: true, status: true } },
            },
          },
          relatedBy: {
            select: {
              id: true,
              type: true,
              from: { select: { id: true, key: true, title: true, status: true } },
            },
          },
        },
      });
      if (!ticket) throw new Error("Ticket not found.");
      return { ticket };
    }
    case "list_projects": {
      denyGuest(ctx);
      const projects = await prisma.project.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(str(args.status) ? { status: str(args.status) } : {}),
        },
        orderBy: { position: "asc" },
        take: Math.min(100, Math.max(1, num(args.limit) ?? 50)),
        select: {
          id: true,
          name: true,
          summary: true,
          status: true,
          color: true,
          icon: true,
          startDate: true,
          dueDate: true,
          updatedAt: true,
          _count: { select: { milestones: true, tickets: true, pages: true } },
        },
      });
      return { projects };
    }
    case "get_project": {
      denyGuest(ctx);
      const project = await prisma.project.findFirst({
        where: { id: str(args.projectId), workspaceId: ctx.workspaceId },
        include: {
          milestones: { orderBy: { position: "asc" } },
          _count: { select: { tickets: true, pages: true, members: true } },
        },
      });
      if (!project) throw new Error("Project not found.");
      return { project };
    }
    case "list_cycles": {
      denyGuest(ctx);
      const cycles = await prisma.cycle.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { startDate: "desc" },
        take: Math.min(100, Math.max(1, num(args.limit) ?? 50)),
        select: {
          id: true,
          name: true,
          startDate: true,
          endDate: true,
          goal: true,
          _count: { select: { tickets: true } },
        },
      });
      return { cycles };
    }
    case "list_labels": {
      denyGuest(ctx);
      const labels = await prisma.label.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, color: true, description: true },
      });
      return { labels };
    }
    case "get_workspace_info": {
      const workspace = await prisma.workspace.findUnique({
        where: { id: ctx.workspaceId },
        select: {
          id: true,
          name: true,
          slug: true,
          icon: true,
          ownerId: true,
          createdAt: true,
          ...(ctx.role === "GUEST"
            ? {}
            : { _count: { select: { members: true, pages: true, tickets: true, projects: true } } }),
        },
      });
      if (!workspace) throw new Error("Workspace not found.");
      return { workspace, role: ctx.role };
    }
    case "list_members": {
      if (!canPerformWorkspaceAction(ctx.role, "viewMemberDirectory")) {
        throw new Error("You do not have permission to view members.");
      }
      const members = await prisma.workspaceMember.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          role: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true, avatarUrl: true } },
        },
      });
      return { members };
    }
    case "list_page_permissions": {
      const rows = await action(ctx, () => listPagePermissionsAction(str(args.pageId)));
      return { members: rows };
    }
    case "list_attachments": {
      const pageId = str(args.pageId);
      if (pageId && !inScope(ctx, pageId)) throw new Error("Page not found.");
      const assets = await prisma.asset.findMany({
        where: {
          ...(pageId
            ? { pageId }
            : {
                page: {
                  workspaceId: ctx.workspaceId,
                  ...(ctx.visiblePageIds ? { id: { in: [...ctx.visiblePageIds] } } : {}),
                },
              }),
        },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true,
          pageId: true,
          name: true,
          url: true,
          mimeType: true,
          size: true,
          createdAt: true,
          page: { select: { title: true } },
        },
      });
      return { assets };
    }
    case "export_page": {
      const page = await readablePage(ctx, str(args.pageId));
      if (!page) throw new Error("Page not found.");
      const format = str(args.format) || "markdown";
      if (format === "json") return { format, title: page.title, content: page.content };
      if (format === "html") return { format, title: page.title, content: pageToHtml(page.title, page.content) };
      return { format: "markdown", title: page.title, content: pageToMarkdown(page.title, page.content) };
    }
    case "export_database": {
      const databaseId = str(args.databaseId);
      if (!inScope(ctx, databaseId)) throw new Error("Database not found.");
      const database = await prisma.page.findFirst({
        where: { id: databaseId, workspaceId: ctx.workspaceId, type: "DATABASE", deletedAt: null },
        select: { id: true, title: true },
      });
      if (!database) throw new Error("Database not found.");
      const [properties, rows] = await Promise.all([
        prisma.property.findMany({
          where: { databasePageId: databaseId },
          orderBy: { position: "asc" },
          select: { id: true, name: true, type: true, config: true },
        }),
        prisma.page.findMany({
          where: { parentId: databaseId, workspaceId: ctx.workspaceId, deletedAt: null },
          orderBy: { position: "asc" },
          take: 1000,
          select: { id: true, title: true, icon: true, propertyValues: { select: { propertyId: true, value: true } } },
        }),
      ]);
      const matrix = rows.map((row) =>
        properties.map((property) => {
          const value = row.propertyValues.find((cell) => cell.propertyId === property.id)?.value ??
            (property.config && object(property.config)?.primary ? { text: row.title } : undefined);
          return formatCell(value, property as never);
        }),
      );
      return {
        title: database.title,
        csv: matrixToCsv(properties.map((property) => property.name), matrix),
        rows: rows.length,
      };
    }
    case "list_notifications": {
      const notifications = await prisma.notification.findMany({
        where: {
          userId: ctx.userId,
          ...(bool(args.unreadOnly) ? { read: false } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(100, Math.max(1, num(args.limit) ?? 50)),
        select: { id: true, type: true, payload: true, read: true, createdAt: true },
      });
      return { notifications };
    }
    default:
      throw new Error(`Unknown read tool "${name}".`);
  }
}

async function runWrite(name: string, args: Record<string, unknown>, ctx: ExtraContext) {
  switch (name) {
    case "update_page": {
      const pageId = str(args.pageId);
      const patch = patchOf(args);
      if (Object.keys(patch).length === 0) throw new Error("Nothing to update.");
      return action(ctx, () => updatePageAction(pageId, patch));
    }
    case "block_manage": {
      const op = str(args.action);
      const pageId = str(args.pageId);
      const page = await editablePage(ctx, pageId);
      if (!page) throw new Error("Page not found.");
      if (op === "replace") {
        const content = object(args.content);
        if (!content) throw new Error("content is required.");
        return savePageContent(ctx, pageId, {
          ...content,
          content: array(content.content).map((block) => {
            const blockObject = object(block);
            return blockObject ? ensureBlockIds(blockObject) : block;
          }),
        });
      }
      if (op === "insert") {
        const block = object(args.block);
        if (!block) throw new Error("block is required.");
        const blocks = blocksOf(page);
        const index = num(args.index);
        const at = index === undefined ? blocks.length : Math.max(0, Math.min(blocks.length, index));
        blocks.splice(at, 0, ensureBlockIds(block));
        return savePageContent(ctx, pageId, { type: "doc", content: blocks });
      }
      const blockId = str(args.blockId);
      if (!blockId) throw new Error("blockId is required.");
      const blocks = blocksOf(page);
      if (op === "update") {
        const block = object(args.block);
        if (!block) throw new Error("block is required.");
        let changed = false;
        const next = blocks.map((candidate) => {
          const result = replaceBlock(candidate, blockId, block);
          changed ||= result.changed;
          return result.block ?? candidate;
        });
        if (!changed) throw new Error("Block not found.");
        return savePageContent(ctx, pageId, { type: "doc", content: next });
      }
      if (op === "delete") {
        let changed = false;
        const next = blocks.flatMap((candidate) => {
          const result = replaceBlock(candidate, blockId);
          changed ||= result.changed;
          return result.block ? [result.block] : [];
        });
        if (!changed) throw new Error("Block not found.");
        return savePageContent(ctx, pageId, { type: "doc", content: next });
      }
      throw new Error("Unknown block action.");
    }
    case "page_lifecycle": {
      const pageId = str(args.pageId);
      switch (str(args.action)) {
        case "move":
          return action(ctx, () => movePageAction(pageId, str(args.parentId) || null));
        case "archive":
          return action(ctx, () => archivePageAction(pageId));
        case "restore":
          return action(ctx, () => restorePageAction(pageId));
        case "duplicate":
          return action(ctx, () => duplicatePageAction(pageId));
        default:
          throw new Error("Unknown page action.");
      }
    }
    case "database_manage": {
      const op = str(args.action);
      const databaseId = str(args.databaseId);
      switch (op) {
        case "create":
          return action(ctx, () =>
            createPageAction({
              workspaceId: ctx.workspaceId,
              parentId: str(args.parentId) || null,
              type: "DATABASE",
              title: str(args.title) || "Untitled database",
            }),
          );
        case "create_row": {
          const row = await action(ctx, () => createRowAction(databaseId, str(args.title)));
          const rowId = (row as { id?: string }).id;
          const properties = object(args.properties);
          if (rowId && properties) {
            const specs = await prisma.property.findMany({
              where: { databasePageId: databaseId },
              select: { id: true, type: true },
            });
            const byId = new Map(specs.map((property) => [property.id, property.type]));
            for (const [propertyId, value] of Object.entries(properties)) {
              const result = await action(ctx, () =>
                setPropertyValueAction(
                  rowId,
                  propertyId,
                  encodePropertyValue(byId.get(propertyId) ?? "", value),
                ),
              );
              void result;
            }
          }
          return row;
        }
        case "delete_row":
          return action(ctx, () => deleteRowAction(str(args.rowId)));
        case "batch_values": {
          const updates = array(args.updates).filter(
            (entry): entry is Record<string, unknown> => object(entry) !== undefined,
          );
          let updated = 0;
          const propertyIds = [...new Set(updates.map((update) => str(update.propertyId)).filter(Boolean))];
          const specs = await prisma.property.findMany({
            where: { id: { in: propertyIds } },
            select: { id: true, type: true },
          });
          const byId = new Map(specs.map((property) => [property.id, property.type]));
          for (const update of updates) {
            const rowId = str(update.rowId);
            const propertyId = str(update.propertyId);
            if (!rowId || !propertyId) continue;
            await action(ctx, () =>
              setPropertyValueAction(
                rowId,
                propertyId,
                encodePropertyValue(byId.get(propertyId) ?? "", update.value),
              ),
            );
            updated += 1;
          }
          return { updated };
        }
        case "add_property":
          return action(ctx, () =>
            createPropertyAction(databaseId, str(args.name), str(args.type) as PropertyType),
          );
        case "update_property":
          return action(ctx, () =>
            updatePropertyAction(str(args.propertyId), {
              ...(str(args.name) ? { name: str(args.name) } : {}),
              ...(args.config !== undefined ? { config: args.config } : {}),
            }),
          );
        case "delete_property":
          if (args.confirm !== true) throw new Error("Set confirm=true to delete a property.");
          return action(ctx, () => deletePropertyAction(str(args.propertyId)));
        case "reorder_properties":
          return action(ctx, () =>
            reorderPropertiesAction(databaseId, array(args.order).map(String)),
          );
        case "reorder_rows":
          return action(ctx, () =>
            reorderRowsAction(str(args.rowId), array(args.order).map(String)),
          );
        case "create_view":
          return action(ctx, () =>
            createViewAction(
              databaseId,
              str(args.viewType) as "TABLE" | "BOARD" | "LIST" | "GALLERY" | "CALENDAR" | "TIMELINE" | "CHART",
              str(args.name) || "View",
            ),
          );
        case "update_view":
          return action(ctx, () =>
            updateViewAction(str(args.viewId), {
              ...(str(args.name) ? { name: str(args.name) } : {}),
              ...(str(args.viewType) ? { type: str(args.viewType) } : {}),
              ...(args.viewConfig !== undefined ? { config: args.viewConfig } : {}),
            }),
          );
        case "duplicate_view":
          return action(ctx, () => duplicateViewAction(str(args.viewId)));
        default:
          throw new Error("Unknown database action.");
      }
    }
    case "comment_manage": {
      const op = str(args.action);
      switch (op) {
        case "create":
          return action(ctx, () =>
            addCommentAction({
              pageId: str(args.pageId),
              body: str(args.body),
              parentId: str(args.parentId) || null,
              blockId: str(args.blockId) || undefined,
              quote: str(args.quote) || undefined,
            }),
          );
        case "edit":
          return action(ctx, () => editCommentAction(str(args.commentId), str(args.body)));
        case "resolve":
          return action(ctx, () =>
            resolveCommentAction(str(args.commentId), bool(args.resolved) ?? true),
          );
        case "delete":
          if (args.confirm !== true) throw new Error("Set confirm=true to delete a comment.");
          return action(ctx, () => deleteCommentAction(str(args.commentId)));
        case "react":
          return action(ctx, () =>
            toggleCommentReactionAction(str(args.commentId), str(args.emoji)),
          );
        default:
          throw new Error("Unknown comment action.");
      }
    }
    case "ticket_manage": {
      const op = str(args.action);
      const ticketId = str(args.ticketId);
      switch (op) {
        case "create":
          return action(ctx, () =>
            createTicketAction({
              workspaceId: ctx.workspaceId,
              title: str(args.title),
              description: str(args.description),
              type: str(args.type) || undefined,
              status: str(args.status) || undefined,
              priority: str(args.priority) || undefined,
              estimate: num(args.estimate) ?? null,
              estimateUnit: str(args.estimateUnit) || undefined,
              projectId: str(args.projectId) || null,
              milestoneId: str(args.milestoneId) || null,
              assigneeId: str(args.assigneeId) || null,
              parentId: str(args.parentId) || null,
              labelIds: array(args.labelIds).map(String),
            }),
          );
        case "update":
          return action(ctx, () =>
            updateTicketAction({
              ticketId,
              ...(str(args.title) ? { title: str(args.title) } : {}),
              ...(args.description !== undefined ? { description: str(args.description) } : {}),
              ...(str(args.type) ? { type: str(args.type) } : {}),
              ...(str(args.status) ? { status: str(args.status) } : {}),
              ...(str(args.priority) ? { priority: str(args.priority) } : {}),
              ...(args.estimate !== undefined ? { estimate: num(args.estimate) ?? null } : {}),
              ...(str(args.estimateUnit) ? { estimateUnit: str(args.estimateUnit) } : {}),
              ...(args.projectId !== undefined ? { projectId: str(args.projectId) || null } : {}),
              ...(args.milestoneId !== undefined ? { milestoneId: str(args.milestoneId) || null } : {}),
              ...(args.assigneeId !== undefined ? { assigneeId: str(args.assigneeId) || null } : {}),
            }),
          );
        case "archive":
          return action(ctx, () => archiveTicketAction(ticketId, bool(args.archived) ?? true));
        case "restore":
          return action(ctx, () => restoreTicketAction(ticketId));
        case "delete":
          if (args.confirm !== true) throw new Error("Set confirm=true to delete a ticket.");
          return action(ctx, () => deleteTicketAction(ticketId));
        case "comment":
          return action(ctx, () => addTicketCommentAction(ticketId, str(args.body)));
        case "link":
          return action(ctx, () =>
            linkTicketsAction({
              fromId: str(args.fromId),
              toId: str(args.toId),
              type: str(args.relationType) || undefined,
            }),
          );
        case "unlink":
          return action(ctx, () => unlinkTicketAction(str(args.relationId)));
        case "bulk_update":
          return action(ctx, () =>
            bulkUpdateTicketsAction({
              ticketIds: array(args.ticketIds).map(String),
              ...(str(args.status) ? { status: str(args.status) } : {}),
              ...(str(args.priority) ? { priority: str(args.priority) } : {}),
              ...(args.assigneeId !== undefined ? { assigneeId: str(args.assigneeId) || null } : {}),
              ...(args.projectId !== undefined ? { projectId: str(args.projectId) || null } : {}),
              ...(args.estimate !== undefined ? { estimate: num(args.estimate) ?? null } : {}),
              ...(str(args.estimateUnit) ? { estimateUnit: str(args.estimateUnit) } : {}),
              ...(array(args.addLabelIds).length ? { addLabelIds: array(args.addLabelIds).map(String) } : {}),
              ...(array(args.removeLabelIds).length ? { removeLabelIds: array(args.removeLabelIds).map(String) } : {}),
            }),
          );
        case "toggle_label":
          return action(ctx, () => toggleTicketLabelAction(ticketId, str(args.labelId)));
        case "create_label":
          return action(ctx, () =>
            createLabelAction({
              workspaceId: ctx.workspaceId,
              name: str(args.name),
              color: str(args.color) || undefined,
            }),
          );
        case "update_label":
          return action(ctx, () =>
            updateLabelAction({
              labelId: str(args.labelId),
              ...(str(args.name) ? { name: str(args.name) } : {}),
              ...(str(args.color) ? { color: str(args.color) } : {}),
            }),
          );
        case "delete_label":
          if (args.confirm !== true) throw new Error("Set confirm=true to delete a label.");
          return action(ctx, () => deleteLabelAction(str(args.labelId)));
        default:
          throw new Error("Unknown ticket action.");
      }
    }
    case "project_manage": {
      const op = str(args.action);
      const projectId = str(args.projectId);
      switch (op) {
        case "create":
          return action(ctx, () =>
            createProjectAction({
              workspaceId: ctx.workspaceId,
              name: str(args.name),
              summary: str(args.summary) || undefined,
              description: str(args.description) || undefined,
              color: str(args.color) || undefined,
              icon: str(args.icon) || undefined,
              dueDate: str(args.dueDate) || null,
            }),
          );
        case "update":
          return action(ctx, () =>
            updateProjectAction({
              projectId,
              ...(str(args.name) ? { name: str(args.name) } : {}),
              ...(args.summary !== undefined ? { summary: str(args.summary) || null } : {}),
              ...(args.description !== undefined ? { description: str(args.description) || null } : {}),
              ...(str(args.status) ? { status: str(args.status) as never } : {}),
              ...(str(args.color) ? { color: str(args.color) } : {}),
              ...(args.dueDate !== undefined ? { dueDate: str(args.dueDate) || null } : {}),
              ...(args.startDate !== undefined ? { startDate: str(args.startDate) || null } : {}),
            }),
          );
        case "delete":
          if (args.confirm !== true) throw new Error("Set confirm=true to delete a project.");
          return action(ctx, () => deleteProjectAction(projectId));
        case "add_milestone":
          return action(ctx, () =>
            addMilestoneAction({
              projectId,
              name: str(args.name),
              description: str(args.description) || undefined,
              dueDate: str(args.dueDate) || null,
            }),
          );
        case "update_milestone":
          return action(ctx, () =>
            updateMilestoneAction({
              milestoneId: str(args.milestoneId),
              ...(str(args.name) ? { name: str(args.name) } : {}),
              ...(str(args.status) ? { status: str(args.status) as never } : {}),
              ...(args.dueDate !== undefined ? { dueDate: str(args.dueDate) || null } : {}),
              ...(args.description !== undefined ? { description: str(args.description) || null } : {}),
            }),
          );
        case "delete_milestone":
          if (args.confirm !== true) throw new Error("Set confirm=true to delete a milestone.");
          return action(ctx, () => deleteMilestoneAction(str(args.milestoneId)));
        default:
          throw new Error("Unknown project action.");
      }
    }
    case "cycle_manage": {
      const op = str(args.action);
      switch (op) {
        case "create":
          return action(ctx, () =>
            createCycleAction({
              workspaceId: ctx.workspaceId,
              name: str(args.name),
              startDate: str(args.startDate),
              endDate: str(args.endDate),
              goal: str(args.goal) || undefined,
            }),
          );
        case "update":
          return action(ctx, () =>
            updateCycleAction({
              cycleId: str(args.cycleId),
              ...(str(args.name) ? { name: str(args.name) } : {}),
              ...(str(args.startDate) ? { startDate: str(args.startDate) } : {}),
              ...(str(args.endDate) ? { endDate: str(args.endDate) } : {}),
              ...(args.goal !== undefined ? { goal: str(args.goal) || null } : {}),
            }),
          );
        case "delete":
          if (args.confirm !== true) throw new Error("Set confirm=true to delete a cycle.");
          return action(ctx, () => deleteCycleAction(str(args.cycleId)));
        case "assign":
          return action(ctx, () =>
            assignTicketToCycleAction(str(args.ticketId), str(args.cycleId) || null),
          );
        default:
          throw new Error("Unknown cycle action.");
      }
    }
    case "template_manage": {
      const op = str(args.action);
      switch (op) {
        case "save_row":
          return action(ctx, () =>
            saveRowAsTemplateAction(str(args.databaseId), str(args.rowId), str(args.name)),
          );
        case "create_row":
          return action(ctx, () =>
            createRowFromTemplateAction(str(args.databaseId), str(args.templateId)),
          );
        case "delete":
          if (args.confirm !== true) throw new Error("Set confirm=true to delete a template.");
          return action(ctx, () => deleteTemplateAction(str(args.templateId)));
        default:
          throw new Error("Unknown template action.");
      }
    }
    case "favorite_manage": {
      const pageId = str(args.pageId);
      return str(args.action) === "follow"
        ? action(ctx, () => toggleFollowAction(ctx.workspaceId, pageId))
        : action(ctx, () => toggleFavoriteAction(ctx.workspaceId, pageId));
    }
    case "notification_manage": {
      if (str(args.action) === "mark_all_read") {
        await action(ctx, () => markAllNotificationsRead());
      } else {
        await action(ctx, () => markNotificationRead(str(args.notificationId)));
      }
      return { ok: true };
    }
    case "import_markdown": {
      return action(ctx, () =>
        importMarkdownAction({
          workspaceId: ctx.workspaceId,
          parentId: str(args.parentId) || null,
          filename: str(args.filename) || "import.md",
          markdown: str(args.markdown),
        }),
      );
    }
    case "teamspace_manage": {
      const op = str(args.action);
      if (op === "list") {
        const teamspaces = await prisma.teamspace.findMany({
          where: { workspaceId: ctx.workspaceId },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            icon: true,
            createdAt: true,
            _count: { select: { members: true, pages: true } },
          },
        });
        return { teamspaces };
      }
      if (op === "create") {
        return action(ctx, () =>
          createTeamspaceAction(ctx.workspaceId, str(args.name), str(args.icon) || undefined),
        );
      }
      if (op === "delete") {
        if (args.confirm !== true) throw new Error("Set confirm=true to delete a teamspace.");
        return action(ctx, () => deleteTeamspaceAction(str(args.teamspaceId)));
      }
      if (op === "add_member") {
        return action(ctx, () =>
          addTeamspaceMemberAction(str(args.teamspaceId), str(args.userId)),
        );
      }
      if (op === "remove_member") {
        return action(ctx, () =>
          removeTeamspaceMemberAction(str(args.teamspaceId), str(args.userId)),
        );
      }
      throw new Error("Unknown teamspace action.");
    }
    case "webhook_manage": {
      const op = str(args.action);
      if (op === "list") {
        const webhooks = await prisma.webhook.findMany({
          where: { workspaceId: ctx.workspaceId },
          orderBy: { createdAt: "asc" },
          select: { id: true, url: true, events: true, createdAt: true },
        });
        return { webhooks };
      }
      if (op === "create") {
        const result = await action(ctx, () =>
          createWebhookAction({
            workspaceId: ctx.workspaceId,
            url: str(args.url),
            events: array(args.events).map(String),
            secret: str(args.secret) || undefined,
          }),
        );
        const webhook = await prisma.webhook.findFirst({
          where: { workspaceId: ctx.workspaceId, url: str(args.url) },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        return { ...result, id: webhook?.id ?? null };
      }
      if (op === "delete") {
        if (args.confirm !== true) throw new Error("Set confirm=true to delete a webhook.");
        return action(ctx, () => deleteWebhookAction(str(args.webhookId)));
      }
      throw new Error("Unknown webhook action.");
    }
    case "share_manage": {
      const op = str(args.action);
      const pageId = str(args.pageId);
      switch (op) {
        case "create_link":
          return action(ctx, () =>
            createShareLinkAction(pageId, {
              password: str(args.password) || undefined,
              expiresInDays: num(args.expiresInDays),
              indexing: bool(args.indexing),
            }),
          );
        case "revoke_link":
          return action(ctx, () => revokeShareLinkAction(pageId));
        case "set_permission": {
          const level = str(args.level);
          return action(ctx, () =>
            setPagePermissionAction(
              pageId,
              str(args.userId),
              (level === "INHERIT" ? "NONE" : level) as never,
            ),
          );
        }
        default:
          throw new Error("Unknown share action.");
      }
    }
    case "workspace_manage": {
      const op = str(args.action);
      if (
        (op === "delete_page" || op === "empty_trash" || op === "remove_member") &&
        args.confirm !== true
      ) {
        throw new Error("Set confirm=true for this destructive action.");
      }
      switch (op) {
        case "invite_member":
          return action(ctx, () =>
            sendWorkspaceInviteAction({
              workspaceId: ctx.workspaceId,
              email: str(args.email),
              role: str(args.role) || "MEMBER",
            }),
          );
        case "set_member_role":
          return action(ctx, () =>
            setMemberRoleAction(ctx.workspaceId, str(args.userId), str(args.role)),
          );
        case "remove_member":
          return action(ctx, () => removeMemberAction(ctx.workspaceId, str(args.userId)));
        case "empty_trash":
          return action(ctx, () => emptyTrashAction(ctx.workspaceId));
        case "delete_page":
          return action(ctx, () => deletePageAction(str(args.pageId), ctx.workspaceId));
        default:
          throw new Error("Unknown workspace action.");
      }
    }
    default:
      throw new Error(`Unknown write tool "${name}".`);
  }
}

/** Execute one extended tool after the route has authenticated and authorized it. */
export async function runExtraTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ExtraContext,
): Promise<unknown> {
  const definition = EXTRA_TOOLS.find((entry) => entry.name === name);
  if (!definition) throw new Error(`Unknown extended tool "${name}".`);
  return definition.readOnly ? runRead(name, args, ctx) : runWrite(name, args, ctx);
}

/** Used by the transport to distinguish core handlers from the extended catalogue. */
export function isExtraTool(name: string): boolean {
  return EXTRA_TOOL_NAMES.has(name);
}
