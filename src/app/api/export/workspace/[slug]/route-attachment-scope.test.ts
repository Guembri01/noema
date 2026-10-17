import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * B38 — the workspace export must not hand out uploads of another workspace.
 *
 * A page may reference an upload of a *foreign* workspace (a URL that leaked
 * through a share link). The export bundles every `/api/files/...` reference
 * it finds, so without a workspace check the foreign tenant's bytes end up in
 * this workspace's zip.
 *
 * Only the transport edges (db, auth, permissions, queries, the storage
 * driver) are mocked; the route, the attachment collection and the zip
 * assembly run for real.
 */

const db = vi.hoisted(() => ({
  pageFindMany: vi.fn(),
  propertyFindMany: vi.fn(),
}));
const edge = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  getWorkspaceBySlug: vi.fn(),
}));
const store = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findMany: db.pageFindMany },
    property: { findMany: db.propertyFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: edge.getCurrentUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: edge.getWorkspaceAccess,
}));
vi.mock("@/server/queries", () => ({ getWorkspaceBySlug: edge.getWorkspaceBySlug }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    storageDriver: () => ({
      name: "local" as const,
      put: store.put,
      get: store.get,
      remove: store.remove,
    }),
  };
});

import { GET as exportWorkspace } from "./route";

const call = (ip: string) =>
  exportWorkspace(new Request("http://localhost/api/export/workspace/acme", {
    headers: { "x-forwarded-for": ip },
  }), { params: Promise.resolve({ slug: "acme" }) });

/** A page that references one upload of its own workspace and two of another. */
const PAGE = {
  id: "page-1",
  parentId: null,
  title: "Notes",
  type: "PAGE",
  content: {
    type: "doc",
    content: [
      { type: "image", attrs: { src: "/api/files/ws-1/own.png" } },
      { type: "image", attrs: { src: "/api/files/ws-2/foreign.png" } },
    ],
  },
  coverUrl: "/api/files/ws-2/cover.png",
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
  edge.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });
  edge.getWorkspaceBySlug.mockResolvedValue({ id: "ws-1", slug: "acme", name: "Acme" });
  db.pageFindMany.mockResolvedValue([PAGE]);
  db.propertyFindMany.mockResolvedValue([]);
  // Every key resolves — the driver does not know about workspaces, the route
  // does. Without the workspace check the foreign blobs would be bundled.
  store.get.mockImplementation(async (key: string) => ({
    body: new Uint8Array([key.length]),
    contentType: "image/png",
  }));
});

describe("workspace export — attachment scope (B38)", () => {
  it("bundles the workspace's own upload and never a foreign one", async () => {
    const res = await call("10.9.0.1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");

    const readKeys = store.get.mock.calls.map((callArgs) => callArgs[0] as string);
    expect(readKeys).toContain("ws-1/own.png");
    expect(readKeys).not.toContain("ws-2/foreign.png");
    expect(readKeys).not.toContain("ws-2/cover.png");

    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const entries = Object.keys(zip.files);
    expect(entries).toContain("attachments/own.png");
    expect(entries).not.toContain("attachments/foreign.png");
    expect(entries).not.toContain("attachments/cover.png");
  });

  it("still exports the page itself, foreign references and all", async () => {
    const res = await call("10.9.0.2");
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    // The archive path is slugged by `buildZipPlan`: "Notes" → `notes.md`.
    expect(Object.keys(zip.files)).toContain("notes.md");
  });
});
