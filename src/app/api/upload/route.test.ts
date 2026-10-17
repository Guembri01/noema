import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * B56 — `POST /api/upload` must apply the same SVG safety rule the clipboard
 * path applies.
 *
 * The upload route stored the bytes of an `image/svg+xml` file unexamined and
 * served them inline from the app origin, so a member who could reach the
 * endpoint could store a script-carrying SVG and have it run in the app's own
 * origin — with the desktop shell's IPC access behind it. The clipboard path
 * already refused such a file; the upload path did not.
 *
 * The contract under test:
 *
 *  - an SVG that breaks the rule is refused with 415 and *nothing* is stored:
 *    no bytes in the storage driver, no Asset row, no URL in the answer;
 *  - the refusal names the rule, not the place in the file that broke it, so
 *    two different unsafe SVGs get the very same answer (no oracle);
 *  - a safe SVG is still stored and served;
 *  - the rule is the same one the clipboard path runs — the same file is
 *    refused there too.
 *
 * Only the transport edges (auth, permissions, database, storage) are
 * mocked; the type allow-list, the SVG rule and the response shaping run for
 * real.
 */

const edge = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  assetCreate: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: edge.getCurrentUser }));
vi.mock("@/lib/permissions", () => ({ getWorkspaceAccess: edge.getWorkspaceAccess }));
vi.mock("@/lib/db", () => ({ prisma: { asset: { create: edge.assetCreate } } }));
vi.mock("@/lib/storage", () => ({
  storageDriver: () => ({
    name: "local" as const,
    put: edge.put,
    get: vi.fn(),
    remove: vi.fn(),
  }),
}));

import { POST } from "./route";
import { inspectClipboardItem } from "@/lib/clipboard-image";

/** An SVG that carries a script. */
const SCRIPT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

/** The payload from the issue: a script URL smuggled through a SMIL animation. */
const SMIL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><a>' +
  '<animate attributeName="href" values="&#106;avascript:alert(1)"/>' +
  "<text>go</text></a></svg>";

/** A stylesheet that pulls in a remote document. */
const IMPORT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://evil.test/x.css";</style></svg>';

/** A harmless vector. */
const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="#f00"/></svg>';

const uploadRequest = (file: File, workspaceId = "ws-1") => {
  const form = new FormData();
  form.set("workspaceId", workspaceId);
  form.set("file", file);
  return new Request("http://localhost/api/upload", { method: "POST", body: form });
};

/**
 * A multipart body written by hand, so a file part can declare *no* type —
 * the case the route has to resolve from the file name's extension.
 */
const rawUploadRequest = (
  parts: { name: string; filename?: string; type?: string; body: string }[],
  workspaceId = "ws-1",
) => {
  const boundary = "----b56boundary";
  let body = "";
  for (const part of parts) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${part.name}"${
      part.filename ? `; filename="${part.filename}"` : ""
    }\r\n`;
    if (part.type !== undefined) body += `Content-Type: ${part.type}\r\n`;
    body += `\r\n${part.body}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return new Request("http://localhost/api/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
};

const svgFile = (svg: string, name = "payload.svg") =>
  new File([svg], name, { type: "image/svg+xml" });

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  edge.getCurrentUser.mockResolvedValue({ id: "user-1" });
  edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  edge.assetCreate.mockResolvedValue({ id: "asset-1" });
  edge.put.mockResolvedValue(undefined);
});

describe("POST /api/upload — the SVG safety rule (B56)", () => {
  it("refuses an SVG with a script and stores nothing", async () => {
    const res = await POST(uploadRequest(svgFile(SCRIPT_SVG)));

    expect(res.status).toBe(415);
    await expect(res.json()).resolves.toEqual({
      error: "File rejected by the image safety policy",
    });
    // Fail closed: no bytes on the disk, no Asset row, no URL in the answer.
    expect(edge.put).not.toHaveBeenCalled();
    expect(edge.assetCreate).not.toHaveBeenCalled();
  });

  it("refuses the SMIL animation payload of the issue", async () => {
    const res = await POST(uploadRequest(svgFile(SMIL_SVG)));

    expect(res.status).toBe(415);
    expect(edge.put).not.toHaveBeenCalled();
    expect(edge.assetCreate).not.toHaveBeenCalled();
  });

  it("refuses a stylesheet that imports a remote document", async () => {
    const res = await POST(uploadRequest(svgFile(IMPORT_SVG)));

    expect(res.status).toBe(415);
    expect(edge.put).not.toHaveBeenCalled();
  });

  it("gives no oracle: two different unsafe SVGs get the same answer", async () => {
    const script = await POST(uploadRequest(svgFile(SCRIPT_SVG, "script.svg")));
    const importCss = await POST(uploadRequest(svgFile(IMPORT_SVG, "import.svg")));

    expect(script.status).toBe(importCss.status);
    await expect(script.json()).resolves.toEqual(await importCss.json());
  });

  it("checks an SVG whose type comes from the file name", async () => {
    // The part declares no type, so the route has to resolve the MIME from
    // the file name's extension — and the rule has to run on that path too.
    const res = await POST(
      rawUploadRequest([
        { name: "workspaceId", body: "ws-1" },
        { name: "file", filename: "payload.svg", type: "", body: SCRIPT_SVG },
      ]),
    );

    expect(res.status).toBe(415);
    await expect(res.json()).resolves.toEqual({
      error: "File rejected by the image safety policy",
    });
    expect(edge.put).not.toHaveBeenCalled();
  });

  it("still stores a safe SVG", async () => {
    const res = await POST(uploadRequest(svgFile(SAFE_SVG, "safe.svg")));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; mimeType: string };
    expect(body.url).toMatch(/^\/api\/files\/ws-1\/.+\.svg$/);
    expect(body.mimeType).toBe("image/svg+xml");
    expect(edge.put).toHaveBeenCalledTimes(1);
    expect(edge.assetCreate).toHaveBeenCalledTimes(1);
  });

  it("leaves a raster upload alone", async () => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", {
      type: "image/png",
    });

    const res = await POST(uploadRequest(png));

    expect(res.status).toBe(200);
    expect(edge.put).toHaveBeenCalledTimes(1);
  });

  it("runs the same rule as the clipboard path", async () => {
    // The neighbour: the clipboard path refused this file all along, and it
    // still does — both paths share one policy, not two similar filters.
    const verdict = inspectClipboardItem(
      { mimeType: "image/svg+xml", data: SCRIPT_SVG },
      {},
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toBe("unsafe-svg");

    const smil = inspectClipboardItem({ mimeType: "image/svg+xml", data: SMIL_SVG }, {});
    expect(smil.accept).toBe(false);
    expect(smil.reason).toBe("unsafe-svg");
  });
});
