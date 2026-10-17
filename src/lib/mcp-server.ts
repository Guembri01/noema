/**
 * MCP server descriptor engine (§13, read-first).
 *
 * The Model Context Protocol exposes a workspace to AI agents as a set of
 * *tools* (callable functions with a JSON-Schema-ish argument contract) and
 * *resources* (URI-addressable documents). This module is the pure descriptor
 * half: a frozen {@link TOOL_CATALOG} and {@link RESOURCE_CATALOG}, the
 * read/write gating that hides write tools until a caller opts in, argument
 * validation against each tool's schema, URI-template matching, the wire
 * descriptor serializer and the scope-based authorization gate.
 *
 * Everything here is pure and deterministic — no transport, no DB, no clock —
 * so the catalog and validators can be exercised exhaustively. Write tools are
 * marked `readOnly: false` and carry `write:*` scopes drawn from the shared
 * {@link ../api-token-scope} vocabulary, so an agent's credential and a tool's
 * requirements are checked against the same hierarchy.
 */

import { expandScopes } from "./api-token-scope";

/** The JSON-Schema types the tool contracts use. */
export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object";

/** The element contract of an array property. */
export interface JsonSchemaItem {
  readonly type: JsonSchemaType;
}

/** One property of a tool's argument object. */
export interface JsonSchemaProperty {
  readonly type: JsonSchemaType;
  readonly description?: string;
  /** Allowed values; membership is enforced when present. */
  readonly enum?: readonly (string | number)[];
  /** Element contract for `"array"` properties. */
  readonly items?: JsonSchemaItem;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
}

/** A tool's argument object schema (the JSON-Schema-ish shape we validate). */
export interface JsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required: readonly string[];
  /** When `false`, undeclared arguments are rejected. */
  readonly additionalProperties: boolean;
}

/** One callable MCP tool. */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** `true` for read tools, `false` for tools that mutate the workspace. */
  readonly readOnly: boolean;
  /** Scope ids a caller must hold, from the API scope catalogue. */
  readonly requiredScopes: readonly string[];
}

/** One URI-addressable MCP resource. */
export interface McpResource {
  /** RFC 6570-style template, e.g. `"notion://pages/{pageId}"`. */
  readonly uriTemplate: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

/**
 * A resource of the catalogue together with the scope a caller needs to read
 * it. The scope is the one the equivalent read tool requires — the templates
 * are the same reads in a different dress.
 */
interface McpResourceSpec extends McpResource {
  /** Scope ids a caller must hold to read the resource. */
  readonly requiredScopes: readonly string[];
}

const JSON_MIME = "application/json";

/**
 * The resources the server exposes, in presentation order, each with the scope
 * it needs. Every template uses a single `{var}` placeholder per path segment
 * so a concrete URI maps back to exactly one template.
 *
 * The scope lives *here*, next to the template, so the catalogue and the
 * authorization gate cannot drift apart: there is exactly one list, and a
 * template without a scope does not exist in it — {@link authCheckResource}
 * fails closed on a template it does not know.
 */
const RESOURCE_SPECS: readonly McpResourceSpec[] = [
  {
    uriTemplate: "notion://pages/{pageId}",
    name: "Page",
    description: "A page and its blocks.",
    mimeType: JSON_MIME,
    requiredScopes: ["read:pages"],
  },
  {
    uriTemplate: "notion://pages/{pageId}/comments",
    name: "Page comments",
    description: "The comment threads attached to a page.",
    mimeType: JSON_MIME,
    requiredScopes: ["read:comments"],
  },
  {
    uriTemplate: "notion://databases/{databaseId}",
    name: "Database",
    description: "A database and its property schema.",
    mimeType: JSON_MIME,
    requiredScopes: ["read:databases"],
  },
  {
    uriTemplate: "notion://databases/{databaseId}/rows",
    name: "Database rows",
    description: "The rows stored in a database.",
    mimeType: JSON_MIME,
    requiredScopes: ["read:databases"],
  },
];

/**
 * The resources the server exposes, in presentation order — the descriptor a
 * client sees.
 */
export const RESOURCE_CATALOG: readonly McpResource[] = RESOURCE_SPECS.map(
  ({ uriTemplate, name, description, mimeType }) => ({
    uriTemplate,
    name,
    description,
    mimeType,
  }),
);

/**
 * The scope a resource template needs — the same one its read tool needs.
 * `undefined` for a template the catalogue does not know.
 */
export function resourceScopes(template: string): readonly string[] | undefined {
  return RESOURCE_SPECS.find((spec) => spec.uriTemplate === template)?.requiredScopes;
}

/**
 * The tool catalogue, in presentation order: the read tools first, then the
 * write tools. `listTools` preserves this order and hides the write tail unless
 * a caller passes `allowWrite`.
 */
export const TOOL_CATALOG: readonly McpTool[] = [
  {
    name: "search_pages",
    description: "Search the workspace for pages matching a query.",
    readOnly: true,
    requiredScopes: ["read:pages"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Full-text query." },
        limit: {
          type: "integer",
          description: "Maximum number of results.",
          minimum: 1,
          maximum: 100,
        },
        sort: {
          type: "string",
          description: "Result ordering.",
          enum: ["relevance", "last_edited"],
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_page",
    description: "Fetch a single page and its blocks by id.",
    readOnly: true,
    requiredScopes: ["read:pages"],
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "Page id." },
      },
      required: ["pageId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_databases",
    description: "List the databases in the workspace.",
    readOnly: true,
    requiredScopes: ["read:databases"],
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "query_database_rows",
    description: "Query the rows of a database, optionally filtered.",
    readOnly: true,
    requiredScopes: ["read:databases"],
    inputSchema: {
      type: "object",
      properties: {
        databaseId: { type: "string", description: "Database id." },
        filter: { type: "object", description: "Property filter, as a JSON object." },
        pageSize: {
          type: "integer",
          description: "Rows per page.",
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["databaseId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_comments",
    description: "Read the comments attached to a page.",
    readOnly: true,
    requiredScopes: ["read:comments"],
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "Page id." },
        resolved: { type: "boolean", description: "Filter by resolved state." },
      },
      required: ["pageId"],
      additionalProperties: false,
    },
  },
  {
    name: "create_page",
    description: "Create a page, optionally beneath a parent.",
    readOnly: false,
    requiredScopes: ["write:pages"],
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Page title." },
        parentId: { type: "string", description: "Parent page or database id." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "append_blocks",
    description: "Append blocks to the end of a page.",
    readOnly: false,
    requiredScopes: ["write:pages"],
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "Page id." },
        blocks: {
          type: "array",
          description: "Blocks to append.",
          items: { type: "object" },
        },
      },
      required: ["pageId", "blocks"],
      additionalProperties: false,
    },
  },
  {
    name: "update_property_value",
    description: "Set a property value on a database row.",
    readOnly: false,
    requiredScopes: ["write:databases"],
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "Row id." },
        property: { type: "string", description: "Property id." },
        value: { type: "string", description: "New value, encoded as a string." },
      },
      required: ["pageId", "property", "value"],
      additionalProperties: false,
    },
  },
];

const BY_NAME = new Map<string, McpTool>(
  TOOL_CATALOG.map((entry) => [entry.name, entry]),
);

/** Look up a catalog tool by name; `undefined` when the name is unknown. */
export function getTool(name: string): McpTool | undefined {
  return BY_NAME.get(name);
}

/** Options for {@link listTools}. */
export interface ListToolsOptions {
  /** Include the write tools; defaults to `false` (read-only). */
  readonly allowWrite?: boolean;
}

/**
 * The tools a caller may see, in catalogue order. By default only read tools
 * are returned; `{ allowWrite: true }` reveals the write tools as well. Always
 * a fresh array, so callers cannot mutate the catalogue through it.
 */
export function listTools(options: ListToolsOptions = {}): McpTool[] {
  const allowWrite = options.allowWrite === true;
  return TOOL_CATALOG.filter((entry) => allowWrite || entry.readOnly);
}

/** Resolve a tool passed either as a catalogue object or by name. */
function resolveTool(tool: McpTool | string): McpTool {
  if (typeof tool !== "string") return tool;
  const found = BY_NAME.get(tool);
  if (!found) throw new Error(`unknown tool: ${tool}`);
  return found;
}

/** The wire shape an MCP client consumes for one tool. */
export interface McpWireTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: { readonly readOnlyHint: boolean };
}

/**
 * Escape the characters that are unsafe to embed a JSON payload in HTML/JS
 * contexts: `<`, `>`, `&` and the U+2028 / U+2029 line separators.
 */
function escapeJson(json: string): string {
  return json
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Serialize a tool to the MCP wire descriptor as an escaping-safe JSON string.
 * Accepts a catalog tool or a tool name; an unknown name throws. The output
 * still parses back with `JSON.parse` to the original values, but never emits a
 * raw `<`, `>` or `&`, so it is safe to inline in markup.
 */
export function toJsonSchema(tool: McpTool | string): string {
  const resolved = resolveTool(tool);
  const wire: McpWireTool = {
    name: resolved.name,
    description: resolved.description,
    inputSchema: resolved.inputSchema,
    annotations: { readOnlyHint: resolved.readOnly },
  };
  return escapeJson(JSON.stringify(wire));
}

/** A stable diagnostic code for one problem with a tool call. */
export type ToolCallIssueCode =
  | "unknown_tool"
  | "not_an_object"
  | "missing_arg"
  | "unexpected_arg"
  | "wrong_type"
  | "not_in_enum"
  | "below_minimum"
  | "above_maximum"
  | "too_short"
  | "too_long";

/** One problem found by {@link validateToolCall}. */
export interface ToolCallIssue {
  readonly code: ToolCallIssueCode;
  /** The offending argument (or `key[i]` for an array element), when relevant. */
  readonly arg?: string;
  readonly message: string;
}

/** The full result of validating a tool call. */
export interface ToolCallValidation {
  readonly ok: boolean;
  /** The resolved tool name, when the tool was known. */
  readonly tool?: string;
  readonly issues: ToolCallIssue[];
  /** The declared arguments, present only when `ok` is `true`. */
  readonly value?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` satisfies the declared JSON-Schema type. */
function typeMatches(expected: JsonSchemaType, value: unknown): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
  }
}

/** Check one present argument against its property contract. */
function checkProperty(
  key: string,
  prop: JsonSchemaProperty,
  value: unknown,
  issues: ToolCallIssue[],
): void {
  if (!typeMatches(prop.type, value)) {
    issues.push({
      code: "wrong_type",
      arg: key,
      message: `Argument "${key}" must be a ${prop.type}.`,
    });
    return;
  }

  if (prop.enum && !prop.enum.some((option) => option === value)) {
    issues.push({
      code: "not_in_enum",
      arg: key,
      message: `Argument "${key}" must be one of: ${prop.enum.join(", ")}.`,
    });
  }

  if (typeof value === "number") {
    if (prop.minimum !== undefined && value < prop.minimum) {
      issues.push({
        code: "below_minimum",
        arg: key,
        message: `Argument "${key}" must be at least ${prop.minimum}.`,
      });
    }
    if (prop.maximum !== undefined && value > prop.maximum) {
      issues.push({
        code: "above_maximum",
        arg: key,
        message: `Argument "${key}" must be at most ${prop.maximum}.`,
      });
    }
  }

  if (typeof value === "string") {
    if (prop.minLength !== undefined && value.length < prop.minLength) {
      issues.push({
        code: "too_short",
        arg: key,
        message: `Argument "${key}" must be at least ${prop.minLength} characters.`,
      });
    }
    if (prop.maxLength !== undefined && value.length > prop.maxLength) {
      issues.push({
        code: "too_long",
        arg: key,
        message: `Argument "${key}" must be at most ${prop.maxLength} characters.`,
      });
    }
  }

  const items = prop.items;
  if (items && Array.isArray(value)) {
    value.forEach((element, index) => {
      if (!typeMatches(items.type, element)) {
        issues.push({
          code: "wrong_type",
          arg: `${key}[${index}]`,
          message: `Argument "${key}[${index}]" must be a ${items.type}.`,
        });
      }
    });
  }
}

/**
 * Validate a tool call's arguments against the tool's schema. Resolves the tool
 * by name (or object), then reports every problem in one pass: `unknown_tool`,
 * `not_an_object`, `missing_arg`, `unexpected_arg` (when the schema forbids
 * additional properties), `wrong_type`, `not_in_enum`, and the numeric/string
 * bounds. On success `value` holds only the declared arguments.
 */
export function validateToolCall(
  tool: McpTool | string,
  args: unknown,
): ToolCallValidation {
  const resolved = typeof tool === "string" ? BY_NAME.get(tool) : tool;
  if (!resolved) {
    return {
      ok: false,
      issues: [{ code: "unknown_tool", message: `Unknown tool "${String(tool)}".` }],
    };
  }

  if (!isPlainObject(args)) {
    return {
      ok: false,
      tool: resolved.name,
      issues: [{ code: "not_an_object", message: "Arguments must be an object." }],
    };
  }

  const issues: ToolCallIssue[] = [];
  const schema = resolved.inputSchema;

  for (const key of schema.required) {
    if (!(key in args) || args[key] === undefined) {
      issues.push({
        code: "missing_arg",
        arg: key,
        message: `Missing required argument "${key}".`,
      });
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in schema.properties)) {
        issues.push({
          code: "unexpected_arg",
          arg: key,
          message: `Unexpected argument "${key}".`,
        });
      }
    }
  }

  const value: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in args) || args[key] === undefined) continue;
    value[key] = args[key];
    checkProperty(key, prop, args[key], issues);
  }

  return issues.length === 0
    ? { ok: true, tool: resolved.name, issues, value }
    : { ok: false, tool: resolved.name, issues };
}

/** A successful URI match against one resource template. */
export interface UriMatch {
  readonly ok: true;
  readonly template: string;
  readonly name: string;
  readonly mimeType: string;
  /** Decoded placeholder values, keyed by placeholder name. */
  readonly params: Readonly<Record<string, string>>;
}

/** A URI that matched no template. */
export interface UriMismatch {
  readonly ok: false;
  readonly code: "not_a_string" | "malformed_uri" | "no_match";
  readonly message: string;
}

/** The result of {@link validateUri}. */
export type UriValidation = UriMatch | UriMismatch;

const PLACEHOLDER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Match a concrete URI against a template segment-by-segment. Returns the raw
 * (still percent-encoded) placeholder values, or `null` when the segment count
 * or a literal segment differs, or a placeholder would capture nothing.
 */
function matchTemplate(
  template: string,
  uri: string,
): Record<string, string> | null {
  const templateParts = template.split("/");
  const uriParts = uri.split("/");
  if (templateParts.length !== uriParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < templateParts.length; i += 1) {
    const part = templateParts[i];
    const candidate = uriParts[i];
    const placeholder = PLACEHOLDER.exec(part);
    if (placeholder) {
      if (candidate === "") return null;
      params[placeholder[1]] = candidate;
    } else if (part !== candidate) {
      return null;
    }
  }
  return params;
}

/**
 * Validate a concrete resource URI against {@link RESOURCE_CATALOG}. On a match
 * returns the template, resource name, mime type and the decoded parameters; a
 * malformed percent-escape in a captured segment is reported as
 * `"malformed_uri"` rather than thrown.
 */
export function validateUri(uri: unknown): UriValidation {
  if (typeof uri !== "string") {
    return { ok: false, code: "not_a_string", message: "URI must be a string." };
  }

  for (const resource of RESOURCE_CATALOG) {
    const raw = matchTemplate(resource.uriTemplate, uri);
    if (raw === null) continue;

    const params: Record<string, string> = {};
    try {
      for (const [key, value] of Object.entries(raw)) {
        params[key] = decodeURIComponent(value);
      }
    } catch {
      return {
        ok: false,
        code: "malformed_uri",
        message: `Malformed percent-encoding in "${uri}".`,
      };
    }

    return {
      ok: true,
      template: resource.uriTemplate,
      name: resource.name,
      mimeType: resource.mimeType,
      params,
    };
  }

  return { ok: false, code: "no_match", message: `No resource template matches "${uri}".` };
}

/** The caller's granted scopes, for {@link authCheck}. */
export interface AuthContext {
  readonly scopes: readonly string[];
}

/** The outcome of an authorization check. */
export interface AuthDecision {
  readonly allowed: boolean;
  /** Required scopes the caller does not effectively hold. */
  readonly missing: string[];
  readonly reason?: "unknown_tool" | "unknown_resource" | "missing_scope";
}

/**
 * Authorize a tool call against the caller's granted scopes. The granted list is
 * expanded through the shared scope hierarchy first, so a `write:*` scope also
 * satisfies the matching `read:*` requirement and `admin:workspace` satisfies
 * everything. An unknown tool fails closed.
 */
export function authCheck(tool: McpTool | string, context: AuthContext): AuthDecision {
  const resolved = typeof tool === "string" ? BY_NAME.get(tool) : tool;
  if (!resolved) return { allowed: false, missing: [], reason: "unknown_tool" };

  const effective = new Set(expandScopes(context.scopes));
  const missing = resolved.requiredScopes.filter((scope) => !effective.has(scope));
  if (missing.length === 0) return { allowed: true, missing: [] };
  return { allowed: false, missing, reason: "missing_scope" };
}

/**
 * Authorize a resource read against the caller's granted scopes.
 *
 * A resource is a read path like a tool, so it needs the scope of the read
 * tool it mirrors — `notion://pages/{pageId}` needs `read:pages`,
 * `notion://pages/{pageId}/comments` needs `read:comments`, the two database
 * templates need `read:databases`. The granted list is expanded through the
 * shared scope hierarchy first, so a `write:pages` scope also satisfies
 * `read:pages`. An unknown template fails closed.
 */
export function authCheckResource(template: string, context: AuthContext): AuthDecision {
  const required = resourceScopes(template);
  // Fail closed: a template without a scope is readable by nobody — it is a
  // template the catalogue does not know.
  if (!required || required.length === 0) {
    return { allowed: false, missing: [], reason: "unknown_resource" };
  }

  const effective = new Set(expandScopes(context.scopes));
  const missing = required.filter((scope) => !effective.has(scope));
  if (missing.length === 0) return { allowed: true, missing: [] };
  return { allowed: false, missing, reason: "missing_scope" };
}

/**
 * A one-line, human-facing description of a tool: its name, read/write kind,
 * description and required scopes. Accepts a catalog tool or a tool name; an
 * unknown name renders defensively.
 */
export function describeTool(tool: McpTool | string): string {
  const resolved = typeof tool === "string" ? BY_NAME.get(tool) : tool;
  if (!resolved) return `Unknown MCP tool "${String(tool)}".`;

  const kind = resolved.readOnly ? "read-only" : "write";
  const scopes =
    resolved.requiredScopes.length > 0 ? resolved.requiredScopes.join(", ") : "none";
  return `${resolved.name} (${kind}) - ${resolved.description} [scopes: ${scopes}]`;
}
