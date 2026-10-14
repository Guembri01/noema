import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * B55 — export route hardening (spec R23.16 + R23.22):
 * - unknown `?format` → 400 with the allowlist, never a silent fallback
 * - `rateLimit()` wired like `import/notion/route.ts`: page/database 30/min,
 *   workspace 5/min, checked before auth (same ordering as the other routes)
 *
 * B91 — database `?format=json` (R23.16) + fidelity pins:
 * - database JSON: array of N row objects keyed by property name, primary key
 *   first, values = computed cell values (same `formatCell` output as CSV)
 * - fidelity pins: the md/html/pdf/csv outputs must not change byte-wise
 *   (red evidence incl. a deliberate control mismatch: `scripts/_logs/b91-red.log`)
 *
 * Only transport edges (auth, db, permissions, queries, pdf) are mocked; the
 * rate limiter, the format validation and the response shaping run for real.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  propertyFindMany: vi.fn(),
}));
const edge = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  getWorkspaceBySlug: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique, findMany: db.pageFindMany },
    property: { findMany: db.propertyFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: edge.getCurrentUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: edge.getWorkspaceAccess,
}));
vi.mock("@/server/queries", () => ({ getWorkspaceBySlug: edge.getWorkspaceBySlug }));
vi.mock("@/lib/pdf", () => ({
  docToPdf: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
}));

import { GET as exportPage } from "./page/[pageId]/route";
import { GET as exportDatabase } from "./database/[pageId]/route";
import { GET as exportWorkspace } from "./workspace/[slug]/route";

const req = (url: string, ip: string) =>
  new Request(url, { headers: { "x-forwarded-for": ip } });
const pageCall = (query: string, ip: string) =>
  exportPage(req(`http://localhost/api/export/page/page-1${query}`, ip), {
    params: Promise.resolve({ pageId: "page-1" }),
  });

const databaseCall = (query: string, ip: string) =>
  exportDatabase(req(`http://localhost/api/export/database/db-1${query}`, ip), {
    params: Promise.resolve({ pageId: "db-1" }),
  });

const workspaceCall = (query: string, ip: string) =>
  exportWorkspace(req(`http://localhost/api/export/workspace/acme${query}`, ip), {
    params: Promise.resolve({ slug: "acme" }),
  });

const DATABASE = {
  id: "db-1",
  workspaceId: "ws-1",
  title: "Rows",
  type: "DATABASE",
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
  edge.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });
  edge.getWorkspaceBySlug.mockResolvedValue({ id: "ws-1", slug: "acme", name: "Acme" });
  db.pageFindUnique.mockResolvedValue({
    id: "page-1",
    workspaceId: "ws-1",
    title: "Fixture",
    type: "PAGE",
    content: { type: "doc", content: [] },
  });
  db.pageFindMany.mockResolvedValue([]);
  db.propertyFindMany.mockResolvedValue([]);
});

describe("format validation (R23.16)", () => {
  it("page export: unknown format → 400 with the allowlist", async () => {
    const res = await pageCall("?format=docx", "10.1.0.1");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining("docx"),
      valid: ["md", "json", "html", "pdf"],
    });
  });

  it("page export: ?format=json still downloads JSON", async () => {
    const res = await pageCall("?format=json", "10.1.0.2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain(".json");
    await expect(res.json()).resolves.toMatchObject({ title: "Fixture" });
  });

  it("page export: default stays Markdown", async () => {
    const res = await pageCall("", "10.1.0.3");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
  });

  it("database export: unknown format → 400 (was a silent CSV)", async () => {
    db.pageFindUnique.mockResolvedValue(DATABASE);
    const res = await databaseCall("?format=xlsx", "10.1.0.4");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ valid: ["csv", "json"] });
  });

  it("database export: default stays CSV", async () => {
    db.pageFindUnique.mockResolvedValue(DATABASE);
    const res = await databaseCall("", "10.1.0.5");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
  });

  it("workspace export: unknown format → 400 before the zip work", async () => {
    const res = await workspaceCall("?format=pdf", "10.1.0.6");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ valid: ["zip"] });
    expect(db.pageFindMany).not.toHaveBeenCalled();
  });

  it("workspace export: default stays the zip", async () => {
    const res = await workspaceCall("", "10.1.0.7");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
  });
});

describe("rate limits (R23.22)", () => {
  it("page export: 30/min then 429 with retry-after", async () => {
    const ip = "10.2.0.1";
    for (let i = 0; i < 30; i += 1) {
      const res = await pageCall("?format=md", ip);
      expect(res.status).toBe(200);
    }
    const limited = await pageCall("?format=md", ip);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: "Rate limit exceeded" });
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("database export: 30/min then 429", async () => {
    db.pageFindUnique.mockResolvedValue(DATABASE);
    const ip = "10.2.0.2";
    for (let i = 0; i < 30; i += 1) {
      const res = await databaseCall("", ip);
      expect(res.status).toBe(200);
    }
    const limited = await databaseCall("", ip);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: "Rate limit exceeded" });
  });

  it("workspace export: 5/min then 429", async () => {
    const ip = "10.2.0.3";
    for (let i = 0; i < 5; i += 1) {
      const res = await workspaceCall("", ip);
      expect(res.status).toBe(200);
    }
    const limited = await workspaceCall("", ip);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: "Rate limit exceeded" });
  });

  it("budgets are per-route: a throttled workspace export does not block page export", async () => {
    const ip = "10.2.0.4";
    for (let i = 0; i < 5; i += 1) await workspaceCall("", ip);
    const over = await workspaceCall("", ip);
    expect(over.status).toBe(429);
    const page = await pageCall("?format=md", ip);
    expect(page.status).toBe(200);
  });
});
