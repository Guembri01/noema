import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Suggestions persistence contract: one base snapshot per page, guarded by the
 * page's read/edit capabilities. Pending suggestions stay derived, so a reload
 * recomputes them rather than trusting a stored edit list.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  sessionFindUnique: vi.fn(),
  sessionUpsert: vi.fn(),
  sessionDeleteMany: vi.fn(),
}));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique },
    pageSuggestionSession: {
      findUnique: db.sessionFindUnique,
      upsert: db.sessionUpsert,
      deleteMany: db.sessionDeleteMany,
    },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: perms.getWorkspaceAccess,
}));

import {
  loadSuggestionSessionAction,
  saveSuggestionSessionAction,
} from "./suggestions";

const PAGE_ID = "clzzzzzzzzzzzzzzzzzzzzzzz";
const BASE = [
  { id: "sug-0", type: "paragraph", text: "one" },
  { id: "sug-1", type: "heading", text: "two" },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "u1" });
  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  db.pageFindUnique.mockResolvedValue({
    workspaceId: "ws1",
    deletedAt: null,
    permissions: [],
  });
  db.sessionFindUnique.mockResolvedValue(null);
  db.sessionUpsert.mockResolvedValue({});
  db.sessionDeleteMany.mockResolvedValue({ count: 0 });
});

describe("loadSuggestionSessionAction", () => {
  it("reports an inactive session when none is stored", async () => {
    await expect(loadSuggestionSessionAction(PAGE_ID)).resolves.toEqual({
      ok: true,
      active: false,
      base: null,
      authorId: null,
    });
  });

  it("returns a validated base and its author", async () => {
    db.sessionFindUnique.mockResolvedValue({ base: BASE });
    await expect(loadSuggestionSessionAction(PAGE_ID)).resolves.toEqual({
      ok: true,
      active: true,
      base: BASE,
      authorId: null,
    });
  });

  it("degrades a malformed stored base to inactive", async () => {
    db.sessionFindUnique.mockResolvedValue({
      base: [{ id: "" }],
    });
    await expect(loadSuggestionSessionAction(PAGE_ID)).resolves.toEqual({
      ok: true,
      active: false,
      base: null,
      authorId: null,
    });
  });

  it("hides a trashed page", async () => {
    db.pageFindUnique.mockResolvedValue({
      workspaceId: "ws1",
      deletedAt: new Date(),
      permissions: [],
    });
    await expect(loadSuggestionSessionAction(PAGE_ID)).resolves.toEqual({
      error: "Page not found.",
    });
  });
});

describe("saveSuggestionSessionAction", () => {
  it("upserts the current user and base for an active session", async () => {
    await expect(
      saveSuggestionSessionAction(PAGE_ID, { active: true, base: BASE }),
    ).resolves.toEqual({ ok: true });

    expect(db.sessionUpsert).toHaveBeenCalledWith({
      where: { pageId: PAGE_ID },
      create: { pageId: PAGE_ID, base: BASE },
      update: { base: BASE },
    });
  });

  it("deletes the row when suggesting is switched off", async () => {
    await expect(
      saveSuggestionSessionAction(PAGE_ID, { active: false }),
    ).resolves.toEqual({ ok: true });
    expect(db.sessionDeleteMany).toHaveBeenCalledWith({
      where: { pageId: PAGE_ID },
    });
    expect(db.sessionUpsert).not.toHaveBeenCalled();
  });

  it("refuses a malformed base without writing", async () => {
    await expect(
      saveSuggestionSessionAction(PAGE_ID, {
        active: true,
        base: [{ id: "", text: "x" }],
      }),
    ).resolves.toEqual({ error: "Invalid suggestion snapshot." });
    expect(db.sessionUpsert).not.toHaveBeenCalled();
  });

  it("refuses writes on a page the user may only read", async () => {
    db.pageFindUnique.mockResolvedValue({
      workspaceId: "ws1",
      deletedAt: null,
      permissions: [{ level: "READ" }],
    });
    await expect(
      saveSuggestionSessionAction(PAGE_ID, { active: true, base: BASE }),
    ).resolves.toEqual({ error: "No permission." });
    expect(db.sessionUpsert).not.toHaveBeenCalled();
  });
});
