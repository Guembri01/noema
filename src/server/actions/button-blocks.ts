"use server";

import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess } from "@/lib/permissions";
import { pageCapabilitiesFromRelation } from "@/lib/page-access";
import { canEditSchema } from "@/lib/database-lock";
import type { RichNode } from "@/lib/blocks";
import { validateButton, type ButtonAction } from "@/lib/row-buttons";
import { templateContent, TEMPLATES, type TemplateId } from "@/lib/templates";
import { interpolateBlocks, renderBuiltins } from "@/lib/template-variables";
import { BUTTON_NOTIFY_REASON } from "@/lib/template-blocks";
import { setPropertyValueAction } from "@/server/actions/database";

/**
 * Server execution for the editor's Template button and Button block.
 *
 * These are `"use server"` endpoints: every input is re-derived from the
 * session and the database, never trusted from the client.
 *
 * - `resolveTemplateInsertAction` is the Template button's insert path. It
 *   re-checks that the caller may edit the target page and that the template
 *   belongs to the page's workspace (a deleted/foreign id is reported as
 *   "Template not found." — no existence oracle). Text variables (`{{date}}`,
 *   `{{user}}`) resolve at click time.
 * - `executeButtonBlockAction` runs the shared `ButtonAction` vocabulary from
 *   `src/lib/row-buttons.ts` — the same actions automations use. The page edit
 *   capability, the workspace binding, the row/database context and the target
 *   template are all checked before any write. Unsupported actions (a
 *   notification without a recipient list, a link which is a browser
 *   navigation) return an explicit error instead of silently doing nothing.
 *
 * The UI performs the final editor insertion for `insert_template` (a page's
 * live document belongs to the editor / collaboration layer), but only after
 * this action has authorized it and returned the materialized blocks.
 */

export type TemplateInsertActionResult =
  | { ok: true; templateId: string; blocks: RichNode[] }
  | { error: string };

export type ButtonBlockActionResult =
  | { ok: true; kind: "insert_template"; templateId: string; blocks: RichNode[] }
  | { ok: true; kind: "set_property"; propertyId: string; value: unknown }
  | { error: string };

type Authorized = {
  userId: string;
  role: WorkspaceRole;
  page: {
    id: string;
    workspaceId: string;
    parentId: string | null;
    locked: boolean;
  };
};

/** Read a stored template `content` as top-level blocks (array or doc). */
function templateBlocks(content: unknown): RichNode[] {
  if (Array.isArray(content)) return content as RichNode[];
  if (content && typeof content === "object") {
    const nested = (content as { content?: unknown }).content;
    if (Array.isArray(nested)) return nested as RichNode[];
  }
  return [];
}

/**
 * Authorize a button/template action on one page:
 * workspace membership, page edit capability, and the page lock policy.
 * Every failure is a user-facing error, not a thrown exception.
 */
async function authorizePage(
  workspaceId: string,
  pageId: string,
): Promise<Authorized | { error: string }> {
  const user = await requireUser();
  const access = await getWorkspaceAccess(user.id, workspaceId);
  if (!access) return { error: "You do not have access to this workspace." };

  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId, deletedAt: null },
    select: {
      id: true,
      workspaceId: true,
      parentId: true,
      locked: true,
      permissions: {
        where: { userId: user.id },
        select: { level: true },
        take: 1,
      },
    },
  });
  if (!page) return { error: "Page not found." };

  const capabilities = pageCapabilitiesFromRelation(access.role, page.permissions);
  if (!capabilities.edit) {
    return { error: "You do not have permission to run this button." };
  }
  if (
    !canEditSchema(
      { locked: page.locked },
      {
        isOwner: access.role === "OWNER",
        isMember: access.role === "ADMIN" || access.role === "MEMBER",
      },
    )
  ) {
    return { error: "This page is locked. Unlock it to run this button." };
  }

  return {
    userId: user.id,
    role: access.role,
    page: {
      id: page.id,
      workspaceId: page.workspaceId,
      parentId: page.parentId,
      locked: page.locked,
    },
  };
}

/**
 * Resolve a template id within one workspace. Built-ins are code-defined; saved
 * templates are row templates of the workspace's databases. A template of
 * another workspace (or a deleted database) resolves to `null`, which the
 * callers surface as "Template not found.".
 */
async function readTemplateBlocks(input: {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  templateId: string;
}): Promise<RichNode[] | null> {
  const builtin = TEMPLATES.find((template) => template.id === input.templateId);
  if (builtin) return templateContent(builtin.id as TemplateId);

  const template = await prisma.template.findUnique({
    where: { id: input.templateId },
    select: {
      id: true,
      content: true,
      databasePage: {
        select: {
          workspaceId: true,
          deletedAt: true,
          permissions: {
            where: { userId: input.userId },
            select: { level: true },
            take: 1,
          },
        },
      },
    },
  });
  if (!template || !template.databasePage) return null;

  const database = template.databasePage;
  if (database.workspaceId !== input.workspaceId || database.deletedAt !== null) {
    return null;
  }
  if (!pageCapabilitiesFromRelation(input.role, database.permissions).read) {
    return null;
  }
  return templateBlocks(template.content);
}

/** Materialize template variables against the run time and the caller. */
function materialize(blocks: readonly RichNode[], userName: string): RichNode[] {
  const now = new Date();
  return interpolateBlocks(blocks, renderBuiltins({ today: now, now, user: userName }));
}

/**
 * Template button click: authorize the page, resolve the template within the
 * workspace and return materialized blocks for the editor to insert.
 */
export async function resolveTemplateInsertAction(input: {
  workspaceId: string;
  pageId: string;
  templateId: string;
}): Promise<TemplateInsertActionResult> {
  const templateId = input.templateId.trim();
  if (!templateId) return { error: "Template not found." };

  const auth = await authorizePage(input.workspaceId, input.pageId);
  if ("error" in auth) return auth;

  const user = await requireUser();
  const blocks = await readTemplateBlocks({
    workspaceId: input.workspaceId,
    userId: auth.userId,
    role: auth.role,
    templateId,
  });
  if (blocks === null) return { error: "Template not found." };

  return {
    ok: true,
    templateId,
    blocks: materialize(blocks, user.name),
  };
}

/**
 * Execute one Button block action on a page. The action is the shared
 * `ButtonAction` shape (`open_url | set_property | insert_template | notify`);
 * only the action's own arguments are accepted from the client, never a page id
 * or workspace id trusted out of band.
 */
export async function executeButtonBlockAction(input: {
  workspaceId: string;
  pageId: string;
  action: unknown;
}): Promise<ButtonBlockActionResult> {
  const auth = await authorizePage(input.workspaceId, input.pageId);
  if ("error" in auth) return auth;

  const issues = validateButton({ id: "button", label: "Button", action: input.action });
  if (issues.length > 0) {
    return { error: issues[0]?.message ?? "This button is not valid." };
  }
  const action = input.action as ButtonAction;

  switch (action.kind) {
    case "open_url":
      // A link is a browser navigation, not a server side effect. The editor
      // runs it locally after re-checking the shared URL allowlist.
      return { error: "Links open in the browser and are not sent to the server." };

    case "notify":
      // The shared ButtonAction notification has no recipient list. Fail
      // explicitly instead of writing an unscoped notification.
      return { error: BUTTON_NOTIFY_REASON };

    case "insert_template": {
      const user = await requireUser();
      const blocks = await readTemplateBlocks({
        workspaceId: input.workspaceId,
        userId: auth.userId,
        role: auth.role,
        templateId: action.templateId,
      });
      if (blocks === null) return { error: "Template not found." };
      return {
        ok: true,
        kind: "insert_template",
        templateId: action.templateId,
        blocks: materialize(blocks, user.name),
      };
    }

    case "set_property": {
      if (!auth.page.parentId) {
        return {
          error: "Property writes need a database row with that property.",
        };
      }
      const database = await prisma.page.findFirst({
        where: {
          id: auth.page.parentId,
          workspaceId: input.workspaceId,
          deletedAt: null,
        },
        select: {
          id: true,
          type: true,
          permissions: {
            where: { userId: auth.userId },
            select: { level: true },
            take: 1,
          },
        },
      });
      if (!database || database.type !== "DATABASE") {
        return {
          error: "Property writes need a database row with that property.",
        };
      }
      if (!pageCapabilitiesFromRelation(auth.role, database.permissions).edit) {
        return { error: "You do not have permission to write this row." };
      }
      const property = await prisma.property.findFirst({
        where: { id: action.propertyId, databasePageId: database.id },
        select: { id: true },
      });
      if (!property) {
        return { error: "That property does not belong to this row's database." };
      }

      // Use the canonical property write path: it re-checks the row/database
      // binding, validates the value against the property type, handles
      // relations and UNIQUE_ID allocation, and writes the activity entry.
      const written = await setPropertyValueAction(
        auth.page.id,
        property.id,
        action.value,
      );
      if ("error" in written) return { error: written.error };

      return {
        ok: true,
        kind: "set_property",
        propertyId: property.id,
        value: action.value,
      };
    }

    default:
      return { error: "This action is not supported." };
  }
}
