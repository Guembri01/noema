import { NextResponse } from "next/server";
import { Prisma, type WorkspaceRole } from "@prisma/client";
import { authenticateApiRequest } from "@/lib/api-auth";
import { rateLimit } from "@/lib/api-guard";
import {
  bodyReadError,
  MAX_CONTENT_BODY_BYTES,
  readJsonBody,
} from "@/lib/body-limit";
import { intersectScopes } from "@/lib/api-token-scope";
import { prisma } from "@/lib/db";
import { guestReadablePageIds } from "@/lib/guest-access";
import {
  RESOURCE_CATALOG,
  authCheck,
  authCheckResource,
  getTool,
  listTools,
  toJsonSchema,
  validateToolCall,
  validateUri,
  type McpTool,
} from "@/lib/mcp-server";
import { apiScopesForRole, canEditContent, getWorkspaceAccess } from "@/lib/permissions";
import { assertEditableParent } from "@/lib/page-parent";
import { pageCapabilitiesFromRelation } from "@/lib/page-access";
import { canEditSchema, type LockRole } from "@/lib/database-lock";
import { MAX_PAGE_CONTENT_BYTES, parsePageContent } from "@/lib/validation";
import { searchPagesPage } from "@/server/queries";

export const runtime = "nodejs";

const SERVER_INFO = { name: "noema-mcp", version: "1.0.0" } as const;
const PROTOCOL_VERSION = "2024-11-05";

type RpcId = string | number | null;
type RpcParams = Record<string, unknown>;

/** A tool descriptor in the wire shape MCP clients consume. */
function toolDescriptor(tool: McpTool): unknown {
  return JSON.parse(toJsonSchema(tool)) as unknown;
}

function rpcOk(id: RpcId, result: unknown): NextResponse {
  return NextResponse.json({ jsonrpc: "2.0", id, result });
}

function rpcFail(id: RpcId, code: number, message: string, data?: unknown): NextResponse {
  return NextResponse.json({
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  });
}

function textResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError,
  };
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/* ------------------------------------------------------------------ */
/* Read tools                                                          */
/* ------------------------------------------------------------------ */

type ExecContext = {
  workspaceId: string;
  userId: string;
  /** The workspace role, used for page-level `PagePermission` checks. */
  role: WorkspaceRole;
  /**
   * The pages the caller may read in this workspace; `null` means "all of them"
   * (every role but `GUEST`).
   */
  visiblePageIds: Set<string> | null;
};

/**
 * Whether a page is inside the caller's scope. A page outside the scope is
 * reported as *missing* rather than forbidden: "exists but not visible" would
 * confirm the page's existence.
 *
 * The check short-circuits before the query, so an out-of-scope page costs no
 * database round trip while a page that does not exist costs one — the
 * response bodies are byte-identical but the timings are not. That side
 * channel is accepted on purpose: latency is not treated as a confidentiality
 * boundary here, because the answer a caller gets is the same either way and
 * a scope-checked query would only hide the difference behind a similar
 * constant.
 */
function inScope(visiblePageIds: Set<string> | null, pageId: string): boolean {
  return visiblePageIds === null || visiblePageIds.has(pageId);
}

async function loadPage(
  pageId: string,
  workspaceId: string,
  visiblePageIds: Set<string> | null,
) {
  if (!inScope(visiblePageIds, pageId)) return null;
  return prisma.page.findFirst({
    where: { id: pageId, workspaceId },
    select: {
      id: true,
      title: true,
      icon: true,
      type: true,
      content: true,
      updatedAt: true,
    },
  });
}

async function loadComments(
  pageId: string,
  workspaceId: string,
  resolved: boolean | undefined,
  visiblePageIds: Set<string> | null,
) {
  if (!inScope(visiblePageIds, pageId)) return null;
  const page = await prisma.page.findFirst({ where: { id: pageId, workspaceId }, select: { id: true } });
  if (!page) return null;
  return prisma.comment.findMany({
    where: { pageId, ...(typeof resolved === "boolean" ? { resolved } : {}) },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      body: true,
      resolved: true,
      createdAt: true,
      author: { select: { id: true, name: true } },
    },
  });
}

async function loadDatabase(
  databaseId: string,
  workspaceId: string,
  visiblePageIds: Set<string> | null,
) {
  if (!inScope(visiblePageIds, databaseId)) return null;
  const database = await prisma.page.findFirst({
    where: { id: databaseId, workspaceId, type: "DATABASE" },
    select: { id: true, title: true, icon: true, updatedAt: true },
  });
  if (!database) return null;
  const properties = await prisma.property.findMany({
    where: { databasePageId: databaseId },
    orderBy: { position: "asc" },
    select: { id: true, name: true, type: true, config: true, position: true },
  });
  return { database, properties };
}

async function loadRows(
  databaseId: string,
  workspaceId: string,
  take: number,
  visiblePageIds: Set<string> | null,
) {
  // The rows *are* the database's content, so a caller who may open the
  // database may read its rows — the database itself has to be in scope, so no
  // other database's rows are reachable.
  if (!inScope(visiblePageIds, databaseId)) return null;
  const database = await prisma.page.findFirst({
    where: { id: databaseId, workspaceId, type: "DATABASE" },
    select: { id: true },
  });
  if (!database) return null;
  const rows = await prisma.page.findMany({
    where: { parentId: databaseId, workspaceId, deletedAt: null },
    orderBy: { position: "asc" },
    take,
    select: {
      id: true,
      title: true,
      icon: true,
      updatedAt: true,
      propertyValues: { select: { propertyId: true, value: true } },
    },
  });
  return rows;
}

async function runReadTool(name: string, args: RpcParams, ctx: ExecContext): Promise<unknown> {
  switch (name) {
    case "search_pages": {
      const limit = asNumber(args.limit) ?? 20;
      // `null` means "sees everything" — only a caller whose role covers the
      // whole workspace gets it, a guest's search is narrowed to their pages.
      const page = await searchPagesPage(ctx.workspaceId, asString(args.query), ctx.visiblePageIds, {
        limit,
        cursor: null,
      });
      return {
        pages: page.items.map((row) => ({
          id: row.id,
          title: row.title,
          type: row.type,
          snippet: row.snippet,
        })),
        has_more: page.hasMore,
      };
    }
    case "get_page": {
      const page = await loadPage(asString(args.pageId), ctx.workspaceId, ctx.visiblePageIds);
      if (!page) throw new Error("Page not found.");
      return page;
    }
    case "list_databases": {
      const databases = await prisma.page.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          type: "DATABASE",
          deletedAt: null,
          ...(ctx.visiblePageIds ? { id: { in: [...ctx.visiblePageIds] } } : {}),
        },
        orderBy: { position: "asc" },
        select: { id: true, title: true, icon: true, updatedAt: true },
      });
      return { databases };
    }
    case "query_database_rows": {
      const rows = await loadRows(
        asString(args.databaseId),
        ctx.workspaceId,
        asNumber(args.pageSize) ?? 50,
        ctx.visiblePageIds,
      );
      if (rows === null) throw new Error("Database not found.");
      return { rows };
    }
    case "get_comments": {
      const resolved = typeof args.resolved === "boolean" ? args.resolved : undefined;
      const comments = await loadComments(
        asString(args.pageId),
        ctx.workspaceId,
        resolved,
        ctx.visiblePageIds,
      );
      if (comments === null) throw new Error("Page not found.");
      return { comments };
    }
    default:
      throw new Error(`Unknown read tool "${name}".`);
  }
}

/* ------------------------------------------------------------------ */
/* Write tools (allowWrite + authCheck + role + PagePermission)        */
/* ------------------------------------------------------------------ */

/**
 * The page a write tool acts on.
 *
 * The workspace role is checked at the transport edge; this helper applies the
 * per-page restriction as well. A page the caller may only read or comment on
 * is reported exactly like a page outside their scope: a write tool never
 * learns that the restriction exists or targets the page anyway.
 */
async function loadPageForWrite(pageId: string, ctx: ExecContext) {
  if (!inScope(ctx.visiblePageIds, pageId)) return null;
  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId: ctx.workspaceId },
    select: {
      id: true,
      content: true,
      parentId: true,
      type: true,
      locked: true,
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

/** The lock policy's role shape; only the owner keeps the locked-page override. */
function lockRoleFor(role: WorkspaceRole): LockRole {
  return {
    isOwner: role === "OWNER",
    isMember: role === "ADMIN" || role === "MEMBER",
  };
}

async function runWriteTool(name: string, args: RpcParams, ctx: ExecContext): Promise<unknown> {
  switch (name) {
    case "create_page": {
      const requestedParentId = asString(args.parentId) || null;
      // The parent must live in the tool's workspace - `Page.parentId` is a
      // plain foreign key, so a foreign parent would link the page into another
      // tenant's tree (B08) - and the caller must be allowed to edit it. A
      // `READ`/`COMMENT` row on the parent must not become a writable branch
      // just because the workspace role is `MEMBER`.
      const parent = await assertEditableParent({
        workspaceId: ctx.workspaceId,
        parentId: requestedParentId,
        userId: ctx.userId,
        role: ctx.role,
      });
      if ("error" in parent) throw new Error(parent.error);
      const parentId = parent.parentId;
      const last = await prisma.page.findFirst({
        where: { workspaceId: ctx.workspaceId, parentId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      const page = await prisma.page.create({
        data: {
          workspaceId: ctx.workspaceId,
          parentId,
          type: "PAGE",
          title: (asString(args.title) || "Untitled").slice(0, 500),
          createdById: ctx.userId,
          position: (last?.position ?? 0) + 1000,
          content: { type: "doc", content: [{ type: "paragraph" }] },
        },
        select: { id: true, title: true, type: true },
      });
      return { page };
    }
    case "append_blocks": {
      const pageId = asString(args.pageId);
      const page = await loadPageForWrite(pageId, ctx);
      if (!page) throw new Error("Page not found.");
      // The page lock freezes content for every surface, not only the editor's
      // save action; the MCP tool is another content writer.
      if (!canEditSchema({ locked: Boolean(page.locked) }, lockRoleFor(ctx.role))) {
        throw new Error("This page is locked. Unlock it to edit its content.");
      }
      const blocks = Array.isArray(args.blocks) ? args.blocks : [];
      const doc =
        typeof page.content === "object" && page.content !== null && !Array.isArray(page.content)
          ? (page.content as Record<string, unknown>)
          : {};
      const existing = Array.isArray(doc.content) ? doc.content : [];
      const content = { ...doc, type: "doc", content: [...existing, ...blocks] };
      // B137: the blocks go through the same gate as the content of every
      // other write path — the editor's save (the schema of the document, the
      // size limit and the href allowlist) and the import (B110). Without it
      // the tool stores what the caller sent: an `attrs.href` with a scheme
      // outside the allowlist, a document that is bigger than the editor's
      // limit, a block of a shape the editor never produces.
      if (JSON.stringify(content).length > MAX_PAGE_CONTENT_BYTES) {
        throw new Error("That page is too large to save (2 MB limit).");
      }
      const parsed = parsePageContent(content);
      if (!parsed.ok) throw new Error(parsed.error);
      await prisma.page.update({
        where: { id: page.id },
        data: { content: parsed.doc as unknown as Prisma.InputJsonValue },
      });
      return { pageId: page.id, appended: blocks.length };
    }
    case "update_property_value": {
      const pageId = asString(args.pageId);
      const propertyId = asString(args.property);
      const page = await loadPageForWrite(pageId, ctx);
      if (!page) throw new Error("Row not found.");
      // The property has to belong to the row's *own* database, so a property
      // of another database cannot be attached to this row. A row without a
      // database has no property at all. The database is also a page: a
      // `READ`/`COMMENT` restriction on it blocks every cell write, even when
      // the row itself carries no restriction.
      const databasePageId = page.parentId;
      const database = databasePageId ? await loadPageForWrite(databasePageId, ctx) : null;
      if (!database || database.type !== "DATABASE") throw new Error("Property not found.");
      const property = databasePageId
        ? await prisma.property.findFirst({
            where: {
              id: propertyId,
              databasePageId,
              databasePage: { workspaceId: ctx.workspaceId },
            },
            select: { id: true },
          })
        : null;
      if (!property) throw new Error("Property not found.");
      const raw = asString(args.value);
      let value: unknown = raw;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      // No URL gate on this path. The MCP surface has no upload tool and the
      // upload file name is a random token, so a client cannot produce an
      // app-owned `/api/files/...` URL: a write gate on that basis refused
      // every FILES value and made the tool useless for FILES (B52, finding
      // L2). The security boundary is the render gate instead - a stored URL
      // only becomes a link after it passes the shared href allowlist
      // (`sanitizeHref`), which drops `javascript:`, `data:` and every other
      // script-bearing scheme before the value reaches an `href`.
      const saved = await prisma.propertyValue.upsert({
        where: { propertyId_pageId: { propertyId, pageId } },
        create: { propertyId, pageId, value: value as Prisma.InputJsonValue },
        update: { value: value as Prisma.InputJsonValue },
        select: { id: true, propertyId: true, pageId: true, value: true },
      });
      return { value: saved };
    }
    default:
      throw new Error(`Unknown write tool "${name}".`);
  }
}

/* ------------------------------------------------------------------ */
/* Resource reads                                                      */
/* ------------------------------------------------------------------ */

async function runResource(template: string, params: Record<string, string>, ctx: ExecContext): Promise<unknown> {
  switch (template) {
    case "notion://pages/{pageId}": {
      const page = await loadPage(params.pageId, ctx.workspaceId, ctx.visiblePageIds);
      if (!page) throw new Error("Page not found.");
      return page;
    }
    case "notion://pages/{pageId}/comments": {
      const comments = await loadComments(params.pageId, ctx.workspaceId, undefined, ctx.visiblePageIds);
      if (comments === null) throw new Error("Page not found.");
      return { comments };
    }
    case "notion://databases/{databaseId}": {
      const database = await loadDatabase(params.databaseId, ctx.workspaceId, ctx.visiblePageIds);
      if (!database) throw new Error("Database not found.");
      return database;
    }
    case "notion://databases/{databaseId}/rows": {
      const rows = await loadRows(params.databaseId, ctx.workspaceId, 100, ctx.visiblePageIds);
      if (rows === null) throw new Error("Database not found.");
      return { rows };
    }
    default:
      throw new Error("Unknown resource.");
  }
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

/**
 * GET /api/mcp?workspaceId=…&allowWrite=true — a discovery descriptor for the
 * read-first catalog. Bearer-authenticated; unknown callers get a 401.
 */
export async function GET(request: Request) {
  const pre = rateLimit(request, "mcp-pre", 120, 60_000);
  if (pre) return pre;
  const auth = await authenticateApiRequest(request);
  const limited = rateLimit(request, "mcp", 120, 60_000, { userId: auth?.userId });
  if (limited) return limited;
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allowWrite = new URL(request.url).searchParams.get("allowWrite") === "true";
  return NextResponse.json({
    ...SERVER_INFO,
    protocolVersion: PROTOCOL_VERSION,
    tools: listTools({ allowWrite }).map(toolDescriptor),
    resources: RESOURCE_CATALOG,
  });
}

/**
 * POST /api/mcp?workspaceId=… — JSON-RPC 2.0 over HTTP.
 *
 * Read-first and fail-closed: the caller must present a bearer token and, for
 * every tool/resource, a workspace they can access. `tools/list` hides the
 * write tail unless `?allowWrite=true`; a write call is additionally refused
 * unless the caller opts in and `authCheck` confirms the `write:*` scope, and
 * `canEditContent` confirms their workspace role. Arguments are validated with
 * `validateToolCall` and resource URIs with `validateUri` before any query.
 *
 * The token's scopes choose the *tools* a `tools/call` may invoke and the
 * *resources* a `resources/read` may read, never the *pages*: every read —
 * tool or resource — is narrowed by the page scope the caller's role carries,
 * so a guest sees the pages shared with them and nothing else — and a page
 * outside that scope answers "not found", not "forbidden".
 */
export async function POST(request: Request) {
  const pre = rateLimit(request, "mcp-pre", 120, 60_000);
  if (pre) return pre;
  const auth = await authenticateApiRequest(request);
  const limited = rateLimit(request, "mcp", 120, 60_000, { userId: auth?.userId });
  if (limited) return limited;
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await readJsonBody<unknown>(request, MAX_CONTENT_BODY_BYTES);
  } catch (error) {
    return bodyReadError(error, "Invalid JSON body.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const envelope = body as Record<string, unknown>;
  const id: RpcId =
    typeof envelope.id === "string" || typeof envelope.id === "number" ? envelope.id : null;
  const method = asString(envelope.method);
  const params: RpcParams =
    typeof envelope.params === "object" && envelope.params !== null && !Array.isArray(envelope.params)
      ? (envelope.params as RpcParams)
      : {};

  const url = new URL(request.url);
  const allowWrite = url.searchParams.get("allowWrite") === "true";
  const workspaceId = url.searchParams.get("workspaceId") ?? asString(params.workspaceId);
  // `authenticateApiRequest` resolves the token row once and hands over the
  // granted scopes with it, so the grant is read from the same row the token
  // was verified against — no second lookup, no second query.
  const scopes = auth.scopes;

  if (method === "initialize") {
    return rpcOk(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
      },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === "notifications/initialized") {
    return new NextResponse(null, { status: 202 });
  }

  if (method === "tools/list") {
    return rpcOk(id, { tools: listTools({ allowWrite }).map(toolDescriptor) });
  }

  if (method === "resources/list") {
    return rpcOk(id, { resources: RESOURCE_CATALOG });
  }

  const access = workspaceId ? await getWorkspaceAccess(auth.userId, workspaceId) : null;
  if (!access) {
    return rpcFail(id, -32001, "A workspace the caller can access is required.");
  }
  // Membership is not visibility: a guest is a member of the workspace, so the
  // role decides which pages a read may return. Use the READ scope, not the
  // display scope: a shared row puts its database in the display scope (the
  // breadcrumb), but it does not grant every row of that database.
  const visiblePageIds =
    access.role === "GUEST"
      ? await guestReadablePageIds(auth.userId, workspaceId)
      : null;
  const ctx: ExecContext = {
    workspaceId,
    userId: auth.userId,
    role: access.role,
    visiblePageIds,
  };
  // The token says which tools may be called; the role says which of them the
  // caller may use. The role therefore caps the token — a token can never
  // widen the role that owns it.
  const effectiveScopes = intersectScopes(scopes, apiScopesForRole(access.role));

  if (method === "tools/call") {
    const tool = getTool(asString(params.name));
    const validation = validateToolCall(asString(params.name), params.arguments);
    if (!validation.ok) {
      return rpcFail(id, -32602, "Invalid tool call.", validation.issues);
    }
    if (!tool) {
      return rpcFail(id, -32601, "Unknown tool.");
    }

    const decision = authCheck(tool, { scopes: effectiveScopes });
    if (!decision.allowed) {
      return rpcFail(id, -32003, "Insufficient scope.", { missing: decision.missing });
    }

    try {
      if (tool.readOnly) {
        return rpcOk(id, textResult(await runReadTool(tool.name, validation.value ?? {}, ctx)));
      }
      if (!allowWrite) {
        return rpcFail(id, -32004, "Write tools require allowWrite.");
      }
      if (!canEditContent(access.role)) {
        return rpcFail(id, -32003, "Insufficient workspace role for a write.");
      }
      return rpcOk(id, textResult(await runWriteTool(tool.name, validation.value ?? {}, ctx)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed.";
      return rpcOk(id, textResult({ error: message }, true));
    }
  }

  if (method === "resources/read") {
    const match = validateUri(params.uri);
    if (!match.ok) {
      return rpcFail(id, -32602, match.message);
    }
    // A resource is a read path like a tool: the token has to carry the scope
    // of the read tool the template mirrors, or nothing is read. The check
    // comes before the read, so a missing scope costs no database round trip.
    const decision = authCheckResource(match.template, { scopes: effectiveScopes });
    if (!decision.allowed) {
      return rpcFail(id, -32003, "Insufficient scope.", { missing: decision.missing });
    }
    try {
      return rpcOk(id, {
        contents: [
          {
            uri: asString(params.uri),
            mimeType: match.mimeType,
            text: JSON.stringify(await runResource(match.template, match.params, ctx)),
          },
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Resource read failed.";
      return rpcFail(id, -32000, message);
    }
  }

  return rpcFail(id, -32601, "Method not found.");
}
