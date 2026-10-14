import { describe, expect, it } from "vitest";
import {
  ACTIONS_MENU_ITEMS,
  filterMenuItems,
  formatEditedLabel,
  formatFooterTime,
  formatShortcut,
  formatWordStats,
  groupMenuItems,
  visibleMenuItems,
  type MenuItem,
} from "./actions-menu";

const ids = (items: MenuItem[]) => items.map((item) => item.id);

describe("ACTIONS_MENU_ITEMS — canonical Notion order", () => {
  it("lists the spec'd items in Notion order", () => {
    expect(ids(ACTIONS_MENU_ITEMS)).toEqual([
      "copy-link",
      "copy-contents",
      "duplicate",
      "move-to",
      "trash",
      "small-text",
      "full-width",
      "customize",
      "lock",
      "use-ai",
      "suggest",
      "translate",
      "undo",
      "import",
      "export",
      "wiki",
      "updates",
      "history",
      "notify",
      "connections",
      "workspace-move",
      "teamspace-move",
      "share-access",
    ]);
  });

  it("ships Turn into wiki disabled with the 'Wiki coming soon' hint", () => {
    const wiki = ACTIONS_MENU_ITEMS.find((item) => item.id === "wiki");
    expect(wiki).toBeDefined();
    expect(wiki!.kind).toBe("disabled");
    expect(wiki!.hint).toBe("Wiki coming soon");
  });

  it("shows the spec'd keyboard shortcuts on the right items", () => {
    const shortcutFor = (id: string) =>
      ACTIONS_MENU_ITEMS.find((item) => item.id === id)?.shortcut;
    expect(shortcutFor("copy-link")).toBe("ctrl+alt+l");
    expect(shortcutFor("duplicate")).toBe("ctrl+d");
    expect(shortcutFor("move-to")).toBe("ctrl+shift+p");
    expect(shortcutFor("undo")).toBe("ctrl+z");
  });

  it("marks editable-only entries so read-only viewers never see them", () => {
    const readOnly = visibleMenuItems({ editable: false });
    expect(ids(readOnly)).toContain("copy-link");
    expect(ids(readOnly)).not.toContain("duplicate");
    expect(ids(readOnly)).not.toContain("trash");
    expect(ids(readOnly)).not.toContain("lock");
    expect(ids(readOnly)).not.toContain("workspace-move");
    const editable = visibleMenuItems({ editable: true });
    expect(ids(editable)).toContain("duplicate");
    expect(ids(editable)).toContain("lock");
  });
});

describe("filterMenuItems", () => {
  it("returns every item for an empty query, in canonical order", () => {
    expect(ids(filterMenuItems("", ACTIONS_MENU_ITEMS))).toEqual(
      ids(ACTIONS_MENU_ITEMS),
    );
    expect(ids(filterMenuItems("   ", ACTIONS_MENU_ITEMS))).toEqual(
      ids(ACTIONS_MENU_ITEMS),
    );
  });

  it("matches labels case-insensitively and trims the query", () => {
    expect(ids(filterMenuItems("  DUPlicate ", ACTIONS_MENU_ITEMS))).toEqual([
      "duplicate",
    ]);
    expect(ids(filterMenuItems("MOVE TO TRASH", ACTIONS_MENU_ITEMS))).toEqual([
      "trash",
    ]);
  });

  it("ANDs whitespace-separated tokens so every token must match", () => {
    // "link copy" and "copy link" both narrow to exactly Copy link.
    expect(ids(filterMenuItems("copy link", ACTIONS_MENU_ITEMS))).toEqual([
      "copy-link",
    ]);
    expect(ids(filterMenuItems("link copy", ACTIONS_MENU_ITEMS))).toEqual([
      "copy-link",
    ]);
    // Keyword-only matches work too.
    expect(
      ids(filterMenuItems("clipboard markdown", ACTIONS_MENU_ITEMS)),
    ).toEqual(["copy-contents"]);
    expect(ids(filterMenuItems("xyzzy", ACTIONS_MENU_ITEMS))).toEqual([]);
  });

  it("keeps disabled items findable", () => {
    expect(ids(filterMenuItems("wiki", ACTIONS_MENU_ITEMS))).toEqual(["wiki"]);
    const [wiki] = filterMenuItems("wiki", ACTIONS_MENU_ITEMS);
    expect(wiki.kind).toBe("disabled");
  });

  it("preserves Notion order regardless of query token order", () => {
    const order = ids(ACTIONS_MENU_ITEMS);
    const filtered = ids(filterMenuItems("to", ACTIONS_MENU_ITEMS));
    expect(filtered.length).toBeGreaterThan(1);
    const positions = filtered.map((id) => order.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("groupMenuItems", () => {
  it("groups items by group id in first-appearance order", () => {
    const groups = groupMenuItems(ACTIONS_MENU_ITEMS);
    expect(groups.map((group) => group.group)).toEqual([
      "clipboard",
      "page",
      "style",
      "lock",
      "ai",
      "edit",
      "transfer",
      "insights",
      "alerts",
      "organize",
    ]);
    expect(ids(groups[0].items)).toEqual([
      "copy-link",
      "copy-contents",
    ]);
  });

  it("drops groups emptied by the search filter (no stray separators)", () => {
    const filtered = filterMenuItems("duplicate", ACTIONS_MENU_ITEMS);
    const groups = groupMenuItems(filtered);
    expect(groups).toHaveLength(1);
    expect(groups[0].group).toBe("page");
    expect(ids(groups[0].items)).toEqual(["duplicate"]);
  });
});

describe("formatShortcut", () => {
  it("renders human-readable shortcut labels", () => {
    expect(formatShortcut("ctrl+alt+l")).toBe("Ctrl+Alt+L");
    expect(formatShortcut("ctrl+d")).toBe("Ctrl+D");
    expect(formatShortcut("ctrl+shift+p")).toBe("Ctrl+Shift+P");
    expect(formatShortcut("ctrl+z")).toBe("Ctrl+Z");
  });

  it("returns an empty string for unknown/empty shortcuts", () => {
    expect(formatShortcut("")).toBe("");
    expect(formatShortcut(undefined)).toBe("");
  });
});

describe("formatEditedLabel — relative 'Edited … ago'", () => {
  const now = new Date(2026, 9, 15, 12, 0, 0); // Oct 15 2026, noon local
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("says 'just now' inside the first minute", () => {
    expect(formatEditedLabel(ago(30_000), now)).toBe("Edited just now");
    expect(formatEditedLabel(ago(59_999), now)).toBe("Edited just now");
  });

  it("uses 1m/h/d buckets after that", () => {
    expect(formatEditedLabel(ago(5 * 60_000), now)).toBe("Edited 5m ago");
    expect(formatEditedLabel(ago(3 * 3_600_000), now)).toBe("Edited 3h ago");
    expect(formatEditedLabel(ago(2 * 86_400_000), now)).toBe("Edited 2d ago");
  });

  it("falls back to an absolute date past a week", () => {
    expect(formatEditedLabel(ago(60 * 86_400_000), now)).toBe(
      "Edited Aug 16, 2026",
    );
  });

  it("accepts ISO strings as well as Date objects", () => {
    expect(
      formatEditedLabel(ago(5 * 60_000).toISOString(), now),
    ).toBe("Edited 5m ago");
  });
});

describe("formatWordStats — word count / reading time", () => {
  it("counts words, characters and a 200 wpm reading estimate", () => {
    expect(formatWordStats("one two three")).toEqual({
      words: 3,
      chars: 13,
      reading: "1 min read",
    });
  });

  it("collapses runs of whitespace", () => {
    expect(formatWordStats("alpha\n\n   bravo").words).toBe(2);
  });

  it("handles empty text", () => {
    expect(formatWordStats("")).toEqual({
      words: 0,
      chars: 0,
      reading: "0 min read",
    });
    expect(formatWordStats("   \n  ").words).toBe(0);
  });

  it("rounds reading time up, with 1 min for anything under 200 words", () => {
    const words = (n: number) => Array(n).fill("w").join(" ");
    expect(formatWordStats(words(150)).reading).toBe("1 min read");
    expect(formatWordStats(words(200)).reading).toBe("1 min read");
    expect(formatWordStats(words(201)).reading).toBe("2 min read");
    expect(formatWordStats(words(450)).reading).toBe("3 min read");
  });
});

describe("formatFooterTime — 'Today at h:mm AM'", () => {
  it("formats today's timestamps as 'Today at …'", () => {
    const now = new Date(2026, 9, 15, 15, 42, 0);
    expect(formatFooterTime(new Date(2026, 9, 15, 9, 5, 0), now)).toBe(
      "Today at 9:05 AM",
    );
    expect(formatFooterTime(new Date(2026, 9, 15, 15, 42, 0), now)).toBe(
      "Today at 3:42 PM",
    );
    expect(formatFooterTime(new Date(2026, 9, 15, 0, 0, 0), now)).toBe(
      "Today at 12:00 AM",
    );
  });

  it("formats earlier days with their date", () => {
    const now = new Date(2026, 9, 15, 15, 42, 0);
    expect(formatFooterTime(new Date(2026, 9, 14, 15, 42, 0), now)).toBe(
      "Oct 14 at 3:42 PM",
    );
    expect(formatFooterTime(new Date(2025, 0, 2, 8, 30, 0), now)).toBe(
      "Jan 2, 2025 at 8:30 AM",
    );
  });

  it("accepts ISO strings", () => {
    const now = new Date(2026, 9, 15, 15, 42, 0);
    const value = new Date(2026, 9, 15, 9, 5, 0).toISOString();
    expect(formatFooterTime(value, now)).toBe("Today at 9:05 AM");
  });
});
