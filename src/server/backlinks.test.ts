import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D7 / R80.13 — the linked-references scan reads at most 1000 pages and used
 * to cut the workspace off silently. Truncation is detected at the boundary
 * (a full page of rows triggers one count) and reported as
 * `PageReferences.truncated` so the panel can say so.
 */

const db = vi.hoisted(() => ({
  pageFindMany: vi.fn(),
  pageCount: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findMany: db.pageFindMany,
      count: db.pageCount,
    },
  },
}));

import { BACKLINK_SOURCE_CAP, getPageReferences } from "./backlinks";

const sourceAt = (index: number) => ({
  id: `src-${index}`,
  title: `Source ${index}`,
  icon: null,
  content: null,
});

describe("backlinks scan truncation (D7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not hit the count path when the scan returns a partial page", async () => {
    const sources = Array.from({ length: BACKLINK_SOURCE_CAP - 1 }, (_, i) => sourceAt(i));
    db.pageFindMany.mockResolvedValueOnce(sources);

    const result = await getPageReferences("ws-1", "target-1", "Target");

    expect(db.pageCount).not.toHaveBeenCalled();
    expect(result.truncated).toBe(false);
  });

  it("reports truncation when more sources exist beyond the cap", async () => {
    const sources = Array.from({ length: BACKLINK_SOURCE_CAP }, (_, i) => sourceAt(i));
    db.pageFindMany.mockResolvedValueOnce(sources);
    db.pageCount.mockResolvedValueOnce(BACKLINK_SOURCE_CAP + 1);

    const result = await getPageReferences("ws-1", "target-1", "Target");

    expect(db.pageCount).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", deletedAt: null, NOT: { id: "target-1" } },
    });
    expect(result.truncated).toBe(true);
  });

  it("does not report truncation at the boundary with exactly cap-many sources", async () => {
    const sources = Array.from({ length: BACKLINK_SOURCE_CAP }, (_, i) => sourceAt(i));
    db.pageFindMany.mockResolvedValueOnce(sources);
    db.pageCount.mockResolvedValueOnce(BACKLINK_SOURCE_CAP);

    const result = await getPageReferences("ws-1", "target-1", "Target");

    expect(result.truncated).toBe(false);
  });

  it("applies the guest scope to the count the same way as the scan", async () => {
    const sources = Array.from({ length: BACKLINK_SOURCE_CAP }, (_, i) => sourceAt(i));
    const visible = new Set(["target-1", ...sources.map((s) => s.id)]);
    db.pageFindMany.mockResolvedValueOnce(sources);
    db.pageCount.mockResolvedValueOnce(BACKLINK_SOURCE_CAP + 1);

    await getPageReferences("ws-1", "target-1", "Target", visible);

    expect(db.pageCount).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", deletedAt: null, NOT: { id: "target-1" }, id: { in: [...visible] } },
    });
  });
});
