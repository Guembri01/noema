import { describe, expect, it } from "vitest";
import { ALL_TOOLS, listTools, toJsonSchema } from "./mcp-server";
import { EXTRA_TOOLS } from "./mcp-extra-catalog";
import { isKnownScope } from "./api-token-scope";

describe("extended MCP catalogue", () => {
  it("contains every extended tool exactly once", () => {
    const names = ALL_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(EXTRA_TOOLS.length).toBeGreaterThanOrEqual(35);
    expect(ALL_TOOLS.length).toBe(8 + EXTRA_TOOLS.length);
  });

  it("uses only known scopes and well-formed schemas", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.trim().length).toBeGreaterThan(10);
      expect(tool.requiredScopes.length).toBeGreaterThan(0);
      for (const scope of tool.requiredScopes) expect(isKnownScope(scope)).toBe(true);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("hides admin tools unless allowAdmin is set", () => {
    const adminNames = EXTRA_TOOLS.filter((tool) => tool.adminOnly).map((tool) => tool.name);
    expect(adminNames).toContain("share_manage");
    expect(adminNames).toContain("workspace_manage");
    expect(adminNames).toContain("teamspace_manage");
    expect(adminNames).toContain("webhook_manage");

    const visible = listTools({ includeExtended: true, allowWrite: true }).map((tool) => tool.name);
    for (const name of adminNames) expect(visible).not.toContain(name);

    const withAdmin = listTools({
      includeExtended: true,
      allowWrite: true,
      allowAdmin: true,
    }).map((tool) => tool.name);
    for (const name of adminNames) expect(withAdmin).toContain(name);
  });

  it("keeps reads available without allowWrite and hides writes", () => {
    const reads = listTools({ includeExtended: true }).map((tool) => tool.name);
    expect(reads).toContain("get_page_tree");
    expect(reads).toContain("export_database");
    expect(reads).not.toContain("update_page");
    expect(reads).not.toContain("block_manage");
  });

  it("marks write tools as destructive in the wire annotations", () => {
    const descriptor = JSON.parse(toJsonSchema("update_page")) as {
      annotations: { readOnlyHint: boolean; destructiveHint: boolean };
    };
    expect(descriptor.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("requires an action argument on the management tools", () => {
    for (const name of [
      "block_manage",
      "page_lifecycle",
      "database_manage",
      "comment_manage",
      "ticket_manage",
      "project_manage",
      "cycle_manage",
      "template_manage",
      "share_manage",
      "workspace_manage",
      "teamspace_manage",
      "webhook_manage",
    ]) {
      const tool = ALL_TOOLS.find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.inputSchema.properties.action).toBeDefined();
      expect(tool?.inputSchema.required).toContain("action");
    }
  });
});
