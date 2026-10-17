import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * Wiring test for the page export route (this slice): `?format=md` must run the
 * fidelity serializer (not the lossy `blocks.ts#docToMarkdown`) and `?format=pdf`
 * must run the print-plan engine, and both must surface fidelity findings.
 *
 * Only transport edges (db, auth, permissions, the pdfkit renderer) are mocked;
 * the engines, the format validation and the response shaping run for real.
 */

const db = vi.hoisted(() => ({ pageFindUnique: vi.fn() }));
const edge = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
}));
const pdf = vi.hoisted(() => ({ docToPdf: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { page: { findUnique: db.pageFindUnique } } }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: edge.getCurrentUser }));
// Only the membership lookup is mocked — the role predicates run for real, so
// a guest-vs-member difference in the export route is exercised rather than
// asserted by the mock.
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: edge.getWorkspaceAccess };
});
vi.mock("@/lib/pdf", () => ({ docToPdf: pdf.docToPdf }));

import { GET as exportPage } from "./[pageId]/route";

const req = (query: string, ip: string) =>
  new Request(`http://localhost/api/export/page/page-1${query}`, {
    headers: { "x-forwarded-for": ip },
  });
const call = (query: string, ip: string) =>
  exportPage(req(query, ip), { params: Promise.resolve({ pageId: "page-1" }) });

const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

/** A bullet with a nested bullet — `blocks.ts#docToMarkdown` flattens it. */
const NESTED = {
  type: "doc",
  content: [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            para("alpha"),
            {
              type: "bulletList",
              content: [{ type: "listItem", content: [para("beta")] }],
            },
          ],
        },
      ],
    },
  ],
};

/** A colored run + an unknown block — two things Markdown cannot preserve. */
const LOSSY = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "hi", marks: [{ type: "color", attrs: { color: "#f00" } }] },
      ],
    },
    { type: "mysteryBlock", content: [para("?")] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
  edge.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });
  pdf.docToPdf.mockResolvedValue(Buffer.from("%PDF-1.7\n"));
  db.pageFindUnique.mockResolvedValue({
    id: "page-1",
    workspaceId: "ws-1",
    title: "Fixture",
    content: NESTED,
  });
});

describe("page export route — md routes through the fidelity serializer", () => {
  it("serializes nested content (the lossy serializer would flatten it)", async () => {
    const res = await call("?format=md", "10.7.0.1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("- alpha\n  - beta");
    expect(body).toContain("title: Fixture");
    expect(res.headers.get("x-export-engine")).toBe("markdown-fidelity");
  });

  it("defaults to Markdown", async () => {
    const res = await call("", "10.7.0.2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("x-export-engine")).toBe("markdown-fidelity");
  });

  it("surfaces the fidelity loss report as headers", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "page-1",
      workspaceId: "ws-1",
      title: "Lossy",
      content: LOSSY,
    });
    const res = await call("?format=md", "10.7.0.3");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-export-fidelity-losses")).toBe("2");
    const decoded = JSON.parse(
      decodeURIComponent(res.headers.get("x-export-fidelity") as string),
    );
    expect(decoded.lost.map((loss: { kind: string }) => loss.kind)).toContain("mysteryBlock");
  });

  it("honours ?imageBase for relative image sources", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "page-1",
      workspaceId: "ws-1",
      title: "Img",
      content: { type: "doc", content: [{ type: "image", attrs: { src: "p.png", alt: "a" } }] },
    });
    const res = await call("?format=md&imageBase=https%3A%2F%2Fcdn.test%2Fa", "10.7.0.4");
    expect(await res.text()).toContain("(https://cdn.test/a/p.png)");
  });
});

describe("page export route — pdf routes through the print-plan engine", () => {
  it("returns the planned PDF with engine-derived filename and plan headers", async () => {
    const res = await call("?format=pdf", "10.7.1.1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-export-engine")).toBe("print-plan");
    expect(res.headers.get("x-export-plan-pages")).toBe("1");
    expect(res.headers.get("x-export-plan-blocks")).toBe("1");
    const disposition = res.headers.get("content-disposition") as string;
    expect(disposition).toContain('filename="fixture-');
    expect(disposition).toContain(".pdf");
    expect(disposition).toContain("filename*=UTF-8''");
    expect(pdf.docToPdf).toHaveBeenCalledOnce();
  });

  it("?print=1 returns the print-ready HTML built from printStyles + the plan", async () => {
    const res = await call("?format=pdf&print=1", "10.7.1.2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-export-engine")).toBe("print-plan");
    const html = await res.text();
    expect(html).toContain("@page { size: A4 portrait;");
    expect(html).toContain('<section class="print-page" data-page="1">');
    expect(html).toContain("<h1>Fixture</h1>");
    expect(pdf.docToPdf).not.toHaveBeenCalled();
  });

  it("reports nested-content warnings the plan cannot print faithfully", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "page-1",
      workspaceId: "ws-1",
      title: "Cols",
      content: {
        type: "doc",
        content: [
          {
            type: "columns",
            content: [
              { type: "column", content: [para("l")] },
              { type: "column", content: [para("r")] },
            ],
          },
        ],
      },
    });
    const res = await call("?format=pdf", "10.7.1.3");
    expect(res.headers.get("x-export-plan-warnings")).toBe("1");
  });
});

describe("page export route — the other formats are unchanged", () => {
  it("?format=html stays the plain HTML document (no print styles)", async () => {
    const res = await call("?format=html", "10.7.2.1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1>Fixture</h1>");
    expect(html).not.toContain("@page {");
  });

  it("?format=html&print=1 becomes the print-ready document", async () => {
    const res = await call("?format=html&print=1", "10.7.2.2");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("@page { size: A4 portrait;");
  });

  it("?format=json still downloads the raw document", async () => {
    const res = await call("?format=json", "10.7.2.3");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toMatchObject({ title: "Fixture" });
  });

  it("an unknown format is still a 400 with the allowlist", async () => {
    const res = await call("?format=docx", "10.7.2.4");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ valid: ["md", "json", "html", "pdf"] });
  });

  it("still enforces auth and workspace access", async () => {
    edge.getCurrentUser.mockResolvedValue(null);
    expect((await call("?format=md", "10.7.2.5")).status).toBe(401);

    edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
    edge.getWorkspaceAccess.mockResolvedValue(null);
    expect((await call("?format=md", "10.7.2.6")).status).toBe(403);
  });

  it("still 404s a missing page", async () => {
    db.pageFindUnique.mockResolvedValue(null);
    expect((await call("?format=md", "10.7.2.7")).status).toBe(404);
  });
});
