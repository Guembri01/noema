import { describe, expect, it } from "vitest";

import {
  RESOURCE_CATALOG,
  TOOL_CATALOG,
  authCheck,
  describeTool,
  getTool,
  listTools,
  toJsonSchema,
  validateToolCall,
  validateUri,
} from "./mcp-server";
import type { McpTool } from "./mcp-server";

/**
 * §13 MCP server — the descriptor engine's *behaviour*: the tool catalog, its
 * read/write gating, JSON-Schema-ish argument validation, URI-template matching
 * for resources, wire-schema serialization and scope-based authorization.
 *
 * Red-first: `src/lib/mcp-server.ts` did not exist when this file was written.
 * This is the pure descriptor half — no transport, no DB, no requests — so the
 * catalog, filters and validators can be tested exhaustively.
 */

const READ_TOOLS = [
  "search_pages",
  "get_page",
  "list_databases",
  "query_database_rows",
  "get_comments",
] as const;

const WRITE_TOOLS = ["create_page", "append_blocks", "update_property_value"] as const;

/** Resolve a catalog tool or fail loudly, without a non-null assertion. */
function tool(name: string): McpTool {
  const found = getTool(name);
  if (!found) throw new Error(`test fixture: unknown tool ${name}`);
  return found;
}

describe("TOOL_CATALOG (§13)", () => {
  it("lists the five read tools then the three write tools, in order", () => {
    expect(TOOL_CATALOG.map((entry) => entry.name)).toEqual([
      ...READ_TOOLS,
      ...WRITE_TOOLS,
    ]);
  });

  it("marks every read tool readOnly and every write tool not", () => {
    for (const name of READ_TOOLS) expect(tool(name).readOnly, name).toBe(true);
    for (const name of WRITE_TOOLS) expect(tool(name).readOnly, name).toBe(false);
  });

  it("gives every tool a non-empty name, description and at least one scope", () => {
    for (const entry of TOOL_CATALOG) {
      expect(entry.name.trim().length, entry.name).toBeGreaterThan(0);
      expect(entry.description.trim().length, entry.name).toBeGreaterThan(0);
      expect(entry.requiredScopes.length, entry.name).toBeGreaterThan(0);
    }
  });

  it("uses unique tool names", () => {
    const names = TOOL_CATALOG.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares an object inputSchema that rejects additional properties", () => {
    for (const entry of TOOL_CATALOG) {
      expect(entry.inputSchema.type, entry.name).toBe("object");
      expect(entry.inputSchema.additionalProperties, entry.name).toBe(false);
    }
  });

  it("requires a write scope on write tools and never on read tools", () => {
    for (const name of WRITE_TOOLS) {
      expect(tool(name).requiredScopes.some((scope) => scope.startsWith("write:"))).toBe(
        true,
      );
    }
    for (const name of READ_TOOLS) {
      expect(tool(name).requiredScopes.some((scope) => scope.startsWith("write:"))).toBe(
        false,
      );
    }
  });
});

describe("getTool (§13)", () => {
  it("resolves a catalog tool by name", () => {
    expect(getTool("get_page")?.name).toBe("get_page");
  });

  it("returns undefined for an unknown name", () => {
    expect(getTool("nope")).toBeUndefined();
    expect(getTool("")).toBeUndefined();
  });
});

describe("RESOURCE_CATALOG (§13)", () => {
  it("exposes a non-empty name, description and mimeType per template", () => {
    expect(RESOURCE_CATALOG.length).toBeGreaterThan(0);
    for (const resource of RESOURCE_CATALOG) {
      expect(resource.name.trim().length, resource.uriTemplate).toBeGreaterThan(0);
      expect(resource.description.trim().length, resource.uriTemplate).toBeGreaterThan(0);
      expect(resource.mimeType.trim().length, resource.uriTemplate).toBeGreaterThan(0);
    }
  });

  it("uses unique uriTemplates with a scheme and a `{var}` placeholder", () => {
    const seen = new Set<string>();
    for (const resource of RESOURCE_CATALOG) {
      expect(seen.has(resource.uriTemplate), resource.uriTemplate).toBe(false);
      seen.add(resource.uriTemplate);
      expect(resource.uriTemplate).toMatch(/^[a-z]+:\/\//);
      expect(resource.uriTemplate).toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
    }
  });
});

describe("listTools (§13)", () => {
  it("returns only read tools by default", () => {
    expect(listTools().map((entry) => entry.name)).toEqual([...READ_TOOLS]);
  });

  it("returns only read tools when allowWrite is false", () => {
    expect(listTools({ allowWrite: false }).map((entry) => entry.name)).toEqual([
      ...READ_TOOLS,
    ]);
  });

  it("includes write tools when allowWrite is true, in catalog order", () => {
    expect(listTools({ allowWrite: true }).map((entry) => entry.name)).toEqual([
      ...READ_TOOLS,
      ...WRITE_TOOLS,
    ]);
  });

  it("returns a fresh array that callers cannot use to mutate the catalog", () => {
    const first = listTools();
    const second = listTools();
    expect(first).not.toBe(second);
    first.pop();
    expect(listTools().map((entry) => entry.name)).toEqual([...READ_TOOLS]);
  });
});

describe("validateToolCall — arguments (§13)", () => {
  it("accepts a call with every required argument", () => {
    const result = validateToolCall("get_page", { pageId: "p1" });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.value).toEqual({ pageId: "p1" });
  });

  it("accepts omitted optional arguments and an empty schema", () => {
    expect(validateToolCall("search_pages", { query: "x" }).ok).toBe(true);
    expect(validateToolCall("list_databases", {}).ok).toBe(true);
  });

  it("reports an unknown tool", () => {
    const result = validateToolCall("nope", {});
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: "unknown_tool" });
  });

  it("flags a missing required argument", () => {
    const result = validateToolCall("get_page", {});
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "missing_arg", arg: "pageId" }),
    ]);
  });

  it("flags every missing required argument", () => {
    const result = validateToolCall("append_blocks", {});
    expect(result.issues.map((issue) => issue.arg).sort()).toEqual(["blocks", "pageId"]);
  });

  it("rejects a non-object argument bag", () => {
    for (const value of [null, undefined, "p1", 42, true]) {
      expect(validateToolCall("get_page", value).issues[0]).toMatchObject({
        code: "not_an_object",
      });
    }
    expect(validateToolCall("get_page", []).issues[0]).toMatchObject({
      code: "not_an_object",
    });
  });

  it("flags a mis-typed required argument", () => {
    const result = validateToolCall("get_page", { pageId: 42 });
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "wrong_type", arg: "pageId" }),
    ]);
  });

  it("flags a mis-typed optional argument", () => {
    const result = validateToolCall("search_pages", { query: "x", limit: "5" });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: "wrong_type", arg: "limit" });
  });

  it("rejects additional properties not declared by the schema", () => {
    const result = validateToolCall("get_page", { pageId: "p1", extra: 1 });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "unexpected_arg", arg: "extra" }),
    ]);
  });

  it("rejects any argument for a zero-argument tool", () => {
    const result = validateToolCall("list_databases", { foo: 1 });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: "unexpected_arg", arg: "foo" });
  });

  it("enforces numeric bounds", () => {
    expect(validateToolCall("search_pages", { query: "x", limit: 0 }).issues[0]).toMatchObject(
      { code: "below_minimum", arg: "limit" },
    );
    expect(
      validateToolCall("search_pages", { query: "x", limit: 999 }).issues[0],
    ).toMatchObject({ code: "above_maximum", arg: "limit" });
  });

  it("enforces enum membership", () => {
    expect(
      validateToolCall("search_pages", { query: "x", sort: "nope" }).issues[0],
    ).toMatchObject({ code: "not_in_enum", arg: "sort" });
    expect(
      validateToolCall("search_pages", { query: "x", sort: "relevance" }).ok,
    ).toBe(true);
  });

  it("type-checks array items", () => {
    const good = validateToolCall("append_blocks", { pageId: "p1", blocks: [{}] });
    expect(good.ok).toBe(true);
    const bad = validateToolCall("append_blocks", { pageId: "p1", blocks: [1] });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]).toMatchObject({ code: "wrong_type", arg: "blocks[0]" });
  });

  it("rejects a non-array where an array is required", () => {
    const result = validateToolCall("append_blocks", { pageId: "p1", blocks: {} });
    expect(result.issues[0]).toMatchObject({ code: "wrong_type", arg: "blocks" });
  });

  it("accepts a catalog tool object as well as a name", () => {
    expect(validateToolCall(tool("get_page"), { pageId: "p1" }).ok).toBe(true);
  });

  it("omits unknown keys from the sanitized value on success", () => {
    const result = validateToolCall(tool("search_pages"), { query: "x" });
    expect(result.value).toEqual({ query: "x" });
  });
});

describe("validateUri (§13)", () => {
  it("matches a page template and extracts the parameter", () => {
    const result = validateUri("notion://pages/abc");
    expect(result).toMatchObject({
      ok: true,
      template: "notion://pages/{pageId}",
      name: "Page",
      params: { pageId: "abc" },
    });
  });

  it("matches the more specific rows template over the database template", () => {
    const result = validateUri("notion://databases/db1/rows");
    expect(result).toMatchObject({
      ok: true,
      template: "notion://databases/{databaseId}/rows",
      params: { databaseId: "db1" },
    });
  });

  it("matches the comments template", () => {
    const result = validateUri("notion://pages/p1/comments");
    expect(result).toMatchObject({
      ok: true,
      template: "notion://pages/{pageId}/comments",
    });
  });

  it("percent-decodes captured parameters", () => {
    const result = validateUri("notion://pages/a%20b");
    expect(result.ok && result.params.pageId).toBe("a b");
  });

  it("rejects an unknown scheme", () => {
    expect(validateUri("http://pages/abc")).toMatchObject({
      ok: false,
      code: "no_match",
    });
  });

  it("rejects a URI with an extra trailing segment", () => {
    expect(validateUri("notion://pages/abc/extra")).toMatchObject({
      ok: false,
      code: "no_match",
    });
  });

  it("rejects an empty placeholder value", () => {
    expect(validateUri("notion://pages/")).toMatchObject({ ok: false, code: "no_match" });
  });

  it("rejects non-string input", () => {
    expect(validateUri(42)).toMatchObject({ ok: false, code: "not_a_string" });
    expect(validateUri(null)).toMatchObject({ ok: false, code: "not_a_string" });
  });

  it("rejects a malformed percent-escape", () => {
    expect(validateUri("notion://pages/%E0%A4%A")).toMatchObject({
      ok: false,
      code: "malformed_uri",
    });
  });
});

describe("toJsonSchema (§13)", () => {
  it("serializes a wire tool that parses back to the catalog shape", () => {
    const wire = toJsonSchema(tool("get_page"));
    const parsed = JSON.parse(wire) as {
      name: string;
      description: string;
      inputSchema: { type: string; additionalProperties: boolean };
      annotations: { readOnlyHint: boolean };
    };
    expect(parsed.name).toBe("get_page");
    expect(parsed.description).toBe(tool("get_page").description);
    expect(parsed.inputSchema.type).toBe("object");
    expect(parsed.inputSchema.additionalProperties).toBe(false);
    expect(parsed.annotations.readOnlyHint).toBe(true);
  });

  it("marks write tools with readOnlyHint false", () => {
    const parsed = JSON.parse(toJsonSchema(tool("create_page"))) as {
      annotations: { readOnlyHint: boolean };
    };
    expect(parsed.annotations.readOnlyHint).toBe(false);
  });

  it("escapes HTML-sensitive characters so the payload is embedding-safe", () => {
    const risky: McpTool = {
      name: "escape_probe",
      description: "</script><script>alert('x')</script> & <b>bold</b>",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      readOnly: true,
      requiredScopes: ["read:pages"],
    };
    const wire = toJsonSchema(risky);
    expect(wire).not.toMatch(/[<>&]/);
    const parsed = JSON.parse(wire) as { description: string };
    expect(parsed.description).toBe(risky.description);
  });

  it("escapes the U+2028 and U+2029 line separators", () => {
    const risky: McpTool = {
      name: "separator_probe",
      description: "line\u2028sep\u2029para",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      readOnly: true,
      requiredScopes: ["read:pages"],
    };
    const wire = toJsonSchema(risky);
    expect(wire).not.toContain("\u2028");
    expect(wire).not.toContain("\u2029");
    expect(wire).toContain("\\u2028");
    expect(wire).toContain("\\u2029");
    expect((JSON.parse(wire) as { description: string }).description).toBe(risky.description);
  });

  it("resolves a tool by name and reports an unknown one", () => {
    expect(JSON.parse(toJsonSchema("get_page"))).toMatchObject({ name: "get_page" });
    expect(() => toJsonSchema("nope")).toThrow(/unknown tool/i);
  });
});

describe("authCheck (§13)", () => {
  it("allows a call when the caller holds the required scope", () => {
    expect(authCheck("get_page", { scopes: ["read:pages"] })).toMatchObject({
      allowed: true,
      missing: [],
    });
  });

  it("refuses a call and names the missing scope", () => {
    const result = authCheck("get_page", { scopes: [] });
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual(["read:pages"]);
    expect(result.reason).toBe("missing_scope");
  });

  it("treats a write scope as implying the matching read scope", () => {
    expect(authCheck("get_page", { scopes: ["write:pages"] }).allowed).toBe(true);
  });

  it("lets admin:workspace satisfy every tool", () => {
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(authCheck(name, { scopes: ["admin:workspace"] }).allowed, name).toBe(true);
    }
  });

  it("refuses a write tool when only read scopes are granted", () => {
    const result = authCheck("create_page", { scopes: ["read:pages", "write:databases"] });
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual(["write:pages"]);
  });

  it("fails an unknown tool closed", () => {
    const result = authCheck("nope", { scopes: ["admin:workspace"] });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("unknown_tool");
  });

  it("accepts a catalog tool object", () => {
    expect(authCheck(tool("query_database_rows"), { scopes: ["read:databases"] }).allowed).toBe(
      true,
    );
  });
});

describe("describeTool (§13)", () => {
  it("includes the tool name, description and read-only label", () => {
    const text = describeTool(tool("get_page"));
    expect(text).toContain("get_page");
    expect(text).toContain(tool("get_page").description);
    expect(text).toContain("read-only");
  });

  it("labels write tools and lists their scopes", () => {
    const text = describeTool(tool("create_page"));
    expect(text).toContain("write");
    expect(text).not.toContain("read-only");
    expect(text).toContain("write:pages");
  });

  it("renders an unknown name defensively", () => {
    expect(describeTool("nope")).toMatch(/unknown/i);
  });
});
