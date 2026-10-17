import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B91 — `GET /api/files/**` must not hand a workspace asset to a guest.
 *
 * The route asked for workspace *membership* (`getWorkspaceAccess`) and
 * nothing else, so a `GUEST` could fetch any asset of the workspace by name.
 * The name is a random 12-character token, but the route was the only asset
 * surface that did not ask for the guest scope.
 *
 * An asset cannot be scoped to a page — the route serves it by its random
 * name and `Asset.pageId` is never populated — so the surface is reserved
 * for full members: a guest is refused before the storage driver is even
 * asked for the bytes. A member still gets the file.
 *
 * Two properties of that refusal are pinned below, because they are what
 * makes it more than a membership check: the refused answer carries no asset
 * headers (no asset `content-type`, no `etag`, no `cache-control`) and it is
 * the same answer for a missing asset, so the route is no existence oracle.
 *
 * Only the transport edges (auth, permissions, storage) are mocked; the role
 * predicates (`canEditContent`) and the path validation run for real.
 */

const edge = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  storageGet: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: edge.getCurrentUser }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
// Only the membership lookup is mocked — the role predicates (canEditContent
// and friends) run for real, so the guest-vs-member difference is exercised
// rather than asserted by the mock.
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: edge.getWorkspaceAccess };
});
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    storageDriver: () => ({
      name: "local" as const,
      put: vi.fn(),
      get: edge.storageGet,
      remove: vi.fn(),
    }),
  };
});

import { GET } from "./route";

const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const call = (path: string[]) =>
  GET(new Request("http://localhost/api/files/ws_1/asset.png"), {
    params: Promise.resolve({ path }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
  edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  edge.storageGet.mockResolvedValue({ body: BYTES, contentType: "image/png" });
});

describe("GET /api/files/[...path] — the guest scope (B91)", () => {
  it("refuses a guest before the storage driver is asked for the bytes", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });

    const res = await call(["ws_1", "asset.png"]);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    expect(edge.storageGet).not.toHaveBeenCalled();
  });

  it("gives a guest no existence oracle: a missing asset is refused like a present one", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
    // Nothing is stored under this key. Before the fix the route answered 404
    // here and 200 for a present asset — which told a guest which assets of
    // the workspace exist.
    edge.storageGet.mockResolvedValue(null);

    const missing = await call(["ws_1", "does-not-exist.png"]);
    const present = await call(["ws_1", "asset.png"]);

    expect(missing.status).toBe(403);
    expect(missing.status).toBe(present.status);
    await expect(missing.json()).resolves.toEqual({ error: "Forbidden" });
    expect(edge.storageGet).not.toHaveBeenCalled();
  });

  it("answers a refused guest without asset headers", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });

    const res = await call(["ws_1", "asset.png"]);

    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
    // Not the asset's content type — the refusal is a JSON error, not a
    // half-served image.
    expect(res.headers.get("content-type")).not.toBe("image/png");
    expect(res.headers.get("content-type")).toContain("application/json");
    // And no asset bytes behind the refusal.
    expect(new Uint8Array(await res.arrayBuffer())).not.toEqual(BYTES);
  });

  it("still serves a member the asset", async () => {
    const res = await call(["ws_1", "asset.png"]);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(edge.storageGet).toHaveBeenCalledWith("ws_1/asset.png");
  });

  it("serves the owner and an admin too", async () => {
    for (const role of ["OWNER", "ADMIN"]) {
      edge.getWorkspaceAccess.mockResolvedValue({ role });
      const res = await call(["ws_1", "asset.png"]);
      expect(res.status, role).toBe(200);
    }
  });

  it("401s without a session and 403s a non-member, touching no storage", async () => {
    edge.getCurrentUser.mockResolvedValue(null);
    expect((await call(["ws_1", "asset.png"])).status).toBe(401);

    edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
    edge.getWorkspaceAccess.mockResolvedValue(null);
    expect((await call(["ws_1", "asset.png"])).status).toBe(403);
    expect(edge.storageGet).not.toHaveBeenCalled();
  });
});
