import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ds14 — trash polish.
 *
 * Two proofs live here:
 *  1. the *pure* presentation mappings (retention → badge tone, nested indent /
 *     guide, muted deleted-by/age metadata, delete-impact copy) — no DOM; and
 *  2. `renderToStaticMarkup` of a fresh / expiring / expired row, a nested row,
 *     the loading skeleton and the empty state, so the classes and token-backed
 *     primitives actually reach the markup.
 *
 * The component is a client shell over server actions and `next/navigation`;
 * both are stubbed here (there is no Next/Radix runtime in node).
 */

vi.mock("@/server/actions/pages", () => ({
  archivePageAction: vi.fn(async () => ({ ok: true })),
  deletePageAction: vi.fn(async () => ({ ok: true })),
  emptyTrashAction: vi.fn(async () => ({ ok: true, deleted: 0 })),
  restorePageAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({
      href,
      children,
      className,
    }: {
      href: string;
      children?: unknown;
      className?: string;
    }) => h("a", { href, className }, children as never),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const {
  INDENT_GUIDE_CLASS,
  NESTED_INDENT_CLASS,
  RETENTION_WARN_DAYS,
  TrashList,
  deleteImpactCopy,
  deletedMetaText,
  indentGuideClass,
  nestedIndentClass,
  retentionBadge,
} = await import("./trash-list");
type TrashRow = import("./trash-list").TrashRow;

const { buildTrashView } = await import("@/lib/trash-view");
type TrashItem = import("@/lib/trash-view").TrashItem;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-04-15T12:00:00.000Z");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

/** A view item with sensible defaults; override per test. */
const item = (over: Partial<TrashItem> = {}): TrashItem => ({
  id: "a",
  title: "Alpha",
  parentId: null,
  deletedAt: daysAgo(1),
  deletedBy: null,
  ageLabel: "1 day ago",
  daysLeft: 29,
  restorable: true,
  nested: false,
  ...over,
});

/* -------------------------------------------------------------------------- */
/* 1. Pure mappings                                                           */
/* -------------------------------------------------------------------------- */

describe("retentionBadge — retention → badge tone", () => {
  it("stays neutral while there is plenty of runway", () => {
    expect(retentionBadge({ daysLeft: 29, restorable: true })).toEqual({
      tone: "neutral",
      label: "Auto-deletes in 29 days",
    });
    expect(retentionBadge({ daysLeft: RETENTION_WARN_DAYS + 1, restorable: true }).tone).toBe(
      "neutral",
    );
  });

  it("steps up to warning as the window shrinks", () => {
    expect(retentionBadge({ daysLeft: RETENTION_WARN_DAYS, restorable: true }).tone).toBe(
      "warning",
    );
    expect(retentionBadge({ daysLeft: 2, restorable: true })).toEqual({
      tone: "warning",
      label: "Auto-deletes in 2 days",
    });
    expect(retentionBadge({ daysLeft: 1, restorable: true })).toEqual({
      tone: "warning",
      label: "Auto-deletes in 1 day",
    });
  });

  it("goes danger at the boundary and past it", () => {
    expect(retentionBadge({ daysLeft: 0, restorable: true })).toEqual({
      tone: "danger",
      label: "Auto-deletes soon",
    });
    expect(retentionBadge({ daysLeft: -4, restorable: false })).toEqual({
      tone: "danger",
      label: "Expired",
    });
  });

  it("reads neutral when purging is disabled", () => {
    expect(retentionBadge({ daysLeft: null, restorable: true })).toEqual({
      tone: "neutral",
      label: "Kept indefinitely",
    });
  });

  it("tones only ever come from the badge vocabulary", () => {
    for (const daysLeft of [null, 40, 3, 1, 0, -10]) {
      for (const restorable of [true, false]) {
        const tone = retentionBadge({ daysLeft, restorable }).tone;
        expect(["neutral", "warning", "danger"]).toContain(tone);
      }
    }
  });
});

describe("nested indentation", () => {
  it("indents a nested row and leaves a root flush", () => {
    expect(nestedIndentClass(true)).toBe(NESTED_INDENT_CLASS);
    expect(nestedIndentClass(true)).toBe("ps-8");
    expect(nestedIndentClass(false)).toBe("");
  });

  it("draws the guide with the --border-strong token only for a nested row", () => {
    expect(indentGuideClass(true)).toBe(INDENT_GUIDE_CLASS);
    expect(indentGuideClass(true)).toContain("bg-border-strong");
    expect(indentGuideClass(true)).toMatch(/\bstart-4\b/);
    expect(indentGuideClass(true)).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(indentGuideClass(false)).toBe("");
  });
});

describe("deletedMetaText — muted deleted-by / age", () => {
  it("leads with the age and appends the acting user when known", () => {
    expect(deletedMetaText({ ageLabel: "2 days ago", deletedBy: null })).toBe("Deleted 2 days ago");
    expect(deletedMetaText({ ageLabel: "2 days ago", deletedBy: "u9" })).toBe(
      "Deleted 2 days ago · by u9",
    );
  });

  it("degrades gracefully when the age is empty", () => {
    expect(deletedMetaText({ ageLabel: "", deletedBy: "u9" })).toBe("Deleted · by u9");
    expect(deletedMetaText({ ageLabel: "", deletedBy: null })).toBe("Deleted");
  });
});

describe("deleteImpactCopy — cascade size from the view model", () => {
  const items = buildTrashView(
    [
      { id: "root", title: "Root", deletedAt: daysAgo(1) },
      { id: "childA", title: "A", parentId: "root", deletedAt: daysAgo(2) },
      { id: "grand", title: "G", parentId: "childA", deletedAt: daysAgo(3) },
      { id: "childB", title: "B", parentId: "root", deletedAt: daysAgo(4) },
      { id: "leaf", title: "Leaf", deletedAt: daysAgo(5) },
    ],
    { now: NOW },
  ).items;

  it("counts every trashed sub-page", () => {
    expect(deleteImpactCopy(items, { id: "root" })).toBe("This will also delete 3 sub-pages");
  });

  it("uses the singular for exactly one sub-page", () => {
    expect(deleteImpactCopy(items, { id: "childA" })).toBe("This will also delete 1 sub-page");
  });

  it("says nothing extra for a leaf and is empty for an unknown id", () => {
    expect(deleteImpactCopy(items, { id: "leaf" })).toBe("This will only delete this page");
    expect(deleteImpactCopy(items, { id: "ghost" })).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Rendered rows / states                                                  */
/* -------------------------------------------------------------------------- */

const row = (days: number, over: Partial<TrashRow> = {}): TrashRow => ({
  id: "p1",
  title: "Alpha",
  icon: "📄",
  deletedAt: new Date(Date.now() - days * DAY_MS).toISOString(),
  ...over,
});

const renderList = (pages: TrashRow[], canEdit = true, loading = false): string =>
  renderToStaticMarkup(
    createElement(TrashList, { workspaceId: "ws", locale: "en", pages, canEdit, loading }),
  );

/** Token discipline shared by every rendered snapshot. */
function expectTokensOnly(html: string): void {
  expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  expect(html).not.toMatch(/\b(?:red|green|amber|blue|yellow|orange|purple|pink)-\d{2,3}\b/);
  expect(html).not.toMatch(/z-\[\d+\]/);
}

describe("TrashList — row states", () => {
  it("fresh: neutral retention badge, muted metadata, hover tint and rise", () => {
    const html = renderList([row(2)]);
    expect(html).toContain('data-trash-row=""');
    expect(html).toContain('data-tone="neutral"');
    expect(html).toContain("Auto-deletes in 28 days");
    expect(html).toContain("Deleted 2 days ago");
    expect(html).toContain("hover:bg-surface-2");
    expect(html).toContain("u-colors");
    expect(html).toContain("animate-rise");
    // Restore is a real secondary Button; delete is a soft danger icon Button.
    expect(html).toContain("focus-ring");
    expect(html).toMatch(/<button[^>]*>[\s\S]*?Restore[\s\S]*?<\/button>/);
    expect(html).toContain('aria-label="Delete Alpha forever"');
    expectTokensOnly(html);
  });

  it("expiring: retention badge steps up to warning", () => {
    const html = renderList([row(28)]);
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain("Auto-deletes in 2 days");
    expect(html).not.toContain('data-tone="danger"');
    expectTokensOnly(html);
  });

  it("expired: retention badge goes danger and reads Expired", () => {
    const html = renderList([row(40)]);
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain("Expired");
    // 40 days crosses the month bucket, so the muted age reads "1 month ago".
    expect(html).toContain("Deleted 1 month ago");
    expectTokensOnly(html);
  });

  it("nested: indents under the ancestor behind a --border-strong guide", () => {
    const html = renderList([
      row(1, { id: "root", title: "Root" }),
      row(2, { id: "child", title: "Child", parentId: "root" }),
    ]);
    expect(html).toContain("ps-8");
    expect(html).toContain("data-indent-guide");
    expect(html).toContain("bg-border-strong");
    expectTokensOnly(html);
  });

  it("hides every destructive control for a guest", () => {
    const html = renderList([row(2)], false);
    expect(html).not.toContain("Restore");
    expect(html).not.toContain("Delete Alpha forever");
    expect(html).not.toContain("Empty trash");
    // The row and its retention badge still render.
    expect(html).toContain('data-tone="neutral"');
    expectTokensOnly(html);
  });
});

describe("TrashList — loading and empty states", () => {
  it("loading: renders skeleton rows instead of the list", () => {
    const html = renderList([row(2)], true, true);
    expect(html).toContain('data-testid="trash-loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("notion-skeleton");
    expect(html).not.toContain('data-trash-row=""');
    expectTokensOnly(html);
  });

  it("empty: renders the actionable EmptyState", () => {
    const html = renderList([]);
    expect(html).toContain('data-empty-state="full"');
    expect(html).toContain("Nothing in the trash");
    expect(html).toContain("Deleted pages will show up here");
    // Actionable: the primary action leads back into the workspace.
    expect(html).toContain('href="/app"');
    expect(html).toContain("Go to workspace");
    expect(html).toContain("animate-fade");
    expect(html).not.toContain('data-trash-row=""');
    expectTokensOnly(html);
  });
});
