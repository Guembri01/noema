import { describe, expect, it } from "vitest";
import {
  filterCommands,
  groupCommands,
  rankCommands,
  topMatch,
  type SlashCommand,
} from "./slash-commands";

const ids = (items: SlashCommand[]) => items.map((item) => item.id);

const catalog: SlashCommand[] = [
  { id: "text", title: "Text", keywords: ["paragraph", "body"], group: "basic" },
  { id: "h1", title: "Heading 1", keywords: ["h1", "title"], group: "basic" },
  { id: "h2", title: "Heading 2", keywords: ["h2", "subtitle"], group: "basic" },
  { id: "todo", title: "To-do list", keywords: ["todo", "task", "checkbox"], group: "basic" },
  { id: "bullet", title: "Bulleted list", keywords: ["bullet", "ul", "list"], group: "basic" },
  { id: "numbered", title: "Numbered list", keywords: ["number", "ol", "list"], group: "basic" },
  { id: "code", title: "Code", keywords: ["snippet"], group: "media" },
  { id: "image", title: "Image", keywords: ["picture", "photo"], group: "media", enabled: false },
  { id: "table", title: "Table", keywords: ["grid", "rows"], group: "database" },
  { id: "ai", title: "Ask AI", keywords: ["assistant", "prompt"], group: "ai" },
];

/** Input order is deliberately worst-first so a passing sort must do real work. */
const tierCatalog: SlashCommand[] = [
  { id: "datatable", title: "Datatable", keywords: [], group: "x" },
  { id: "add-table", title: "Add table", keywords: [], group: "x" },
  { id: "table", title: "Table", keywords: [], group: "x" },
];

describe("rankCommands — match tiers", () => {
  it("returns every command in catalog order for an empty (or slash-only) query", () => {
    expect(ids(rankCommands(catalog, ""))).toEqual(ids(catalog));
    expect(ids(rankCommands(catalog, "   "))).toEqual(ids(catalog));
    expect(ids(rankCommands(catalog, "/"))).toEqual(ids(catalog));
  });

  it("orders title-prefix before word-prefix before substring", () => {
    expect(ids(rankCommands(tierCatalog, "tab"))).toEqual([
      "table",
      "add-table",
      "datatable",
    ]);
  });

  it("matches keyword words and whole keywords case-insensitively", () => {
    expect(ids(rankCommands(catalog, "H1"))).toEqual(["h1"]);
    expect(ids(rankCommands(catalog, "ARAG"))).toEqual(["text"]);
  });

  it("matches multi-word queries against the full title", () => {
    expect(ids(rankCommands(catalog, "heading 1"))).toEqual(["h1"]);
  });

  it("strips a leading slash and surrounding whitespace", () => {
    expect(ids(rankCommands(catalog, "/head"))).toEqual(["h1", "h2"]);
    expect(ids(rankCommands(catalog, "  HEADING "))).toEqual(["h1", "h2"]);
  });

  it("returns [] when nothing matches", () => {
    expect(ids(rankCommands(catalog, "zzzzz"))).toEqual([]);
  });
});

describe("rankCommands — recent boost and tiebreak", () => {
  it("floats recently used commands above otherwise-tied matches", () => {
    expect(ids(rankCommands(catalog, "list"))).toEqual([
      "bullet",
      "numbered",
      "todo",
    ]);
    expect(
      ids(rankCommands(catalog, "list", { recentIds: ["todo", "numbered"] })),
    ).toEqual(["todo", "numbered", "bullet"]);
  });

  it("keeps tier priority above recency", () => {
    expect(
      ids(rankCommands(tierCatalog, "tab", { recentIds: ["datatable", "add-table"] })),
    ).toEqual(["table", "add-table", "datatable"]);
  });

  it("prefers the more recent id when several are listed", () => {
    expect(ids(rankCommands(catalog, "heading", { recentIds: ["h2", "h1"] }))).toEqual([
      "h2",
      "h1",
    ]);
  });

  it("breaks remaining ties by title", () => {
    expect(ids(rankCommands(catalog, "heading"))).toEqual(["h1", "h2"]);
  });

  it("ignores an unknown recent id", () => {
    expect(ids(rankCommands(catalog, "heading", { recentIds: ["nope"] }))).toEqual([
      "h1",
      "h2",
    ]);
  });
});

describe("rankCommands — limit", () => {
  it("caps the result to `limit`", () => {
    expect(ids(rankCommands(catalog, "heading", { limit: 1 }))).toEqual(["h1"]);
    expect(rankCommands(catalog, "", { limit: 3 })).toHaveLength(3);
  });

  it("treats a non-positive limit as no results", () => {
    expect(ids(rankCommands(catalog, "heading", { limit: 0 }))).toEqual([]);
    expect(ids(rankCommands(catalog, "heading", { limit: -5 }))).toEqual([]);
  });

  it("returns the whole catalog when no limit is given", () => {
    expect(rankCommands(catalog, "")).toHaveLength(catalog.length);
  });
});

describe("rankCommands — purity", () => {
  it("does not mutate the input catalog", () => {
    const before = ids(catalog);
    rankCommands(catalog, "list", { recentIds: ["todo"] });
    expect(ids(catalog)).toEqual(before);
  });

  it("still ranks disabled commands — filtering is a separate step", () => {
    expect(ids(rankCommands(catalog, "image"))).toEqual(["image"]);
    expect(ids(rankCommands(filterCommands(catalog), "image"))).toEqual([]);
  });
});

describe("filterCommands — enable/disable rules", () => {
  it("hides catalog entries marked enabled:false", () => {
    const visible = filterCommands(catalog);
    expect(ids(visible)).not.toContain("image");
    expect(ids(visible)).toEqual(ids(catalog).filter((id) => id !== "image"));
  });

  it("honours a context.disabled override", () => {
    expect(
      ids(filterCommands(catalog, { context: { disabled: ["text"] } })),
    ).not.toContain("text");
  });

  it("honours a context.enabled override to re-enable a disabled command", () => {
    expect(
      ids(filterCommands(catalog, { context: { enabled: ["image"] } })),
    ).toContain("image");
  });

  it("lets an explicit disable win over an explicit enable", () => {
    expect(
      ids(
        filterCommands(catalog, {
          context: { enabled: ["image"], disabled: ["image"] },
        }),
      ),
    ).not.toContain("image");
  });

  it("keeps catalog order", () => {
    const filtered = filterCommands(catalog, {
      context: { disabled: ["text", "ai"] },
    });
    expect(ids(filtered)).toEqual(
      ids(catalog).filter((id) => id !== "image" && id !== "text" && id !== "ai"),
    );
  });
});

describe("groupCommands", () => {
  it("buckets by group in first-appearance order", () => {
    const groups = groupCommands(catalog);
    expect(groups.map((entry) => entry.group)).toEqual([
      "basic",
      "media",
      "database",
      "ai",
    ]);
    expect(ids(groups[0].items)).toEqual([
      "text",
      "h1",
      "h2",
      "todo",
      "bullet",
      "numbered",
    ]);
    expect(ids(groups[1].items)).toEqual(["code", "image"]);
    expect(ids(groups[3].items)).toEqual(["ai"]);
  });

  it("reflects the incoming (ranked) order, not catalog order", () => {
    const groups = groupCommands(rankCommands(catalog, "list"));
    expect(groups).toHaveLength(1);
    expect(groups[0].group).toBe("basic");
    expect(ids(groups[0].items)).toEqual(["bullet", "numbered", "todo"]);
  });

  it("returns [] for no input", () => {
    expect(groupCommands([])).toEqual([]);
  });

  it("regroups interleaved groups without duplicate buckets", () => {
    const mixed: SlashCommand[] = [
      { id: "a", title: "A", keywords: [], group: "x" },
      { id: "b", title: "B", keywords: [], group: "y" },
      { id: "c", title: "C", keywords: [], group: "x" },
    ];
    const groups = groupCommands(mixed);
    expect(groups.map((entry) => entry.group)).toEqual(["x", "y"]);
    expect(ids(groups[0].items)).toEqual(["a", "c"]);
    expect(ids(groups[1].items)).toEqual(["b"]);
  });
});

describe("topMatch", () => {
  it("returns the best-ranked command", () => {
    expect(topMatch(catalog, "code")?.id).toBe("code");
    expect(topMatch(tierCatalog, "tab")?.id).toBe("table");
  });

  it("returns undefined when nothing matches", () => {
    expect(topMatch(catalog, "zzzzz")).toBeUndefined();
  });

  it("respects the recentIds boost", () => {
    expect(topMatch(catalog, "heading", { recentIds: ["h2"] })?.id).toBe("h2");
  });
});
