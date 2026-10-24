import { describe, expect, it } from "vitest";
import {
  inlineDisplayFor,
  linkedEmbedModel,
  linkedRowsForView,
  toggleLinkedMode,
} from "./linked-database";
import type { ViewConfig } from "@/lib/database-query";
import { DEFAULT_ROW_HEIGHT } from "@/lib/inline-database";

/**
 * fix04 — the linked-database node now resolves its identity/config through
 * `@/lib/linked-view` (per-instance overrides + synced/detached) and its shell
 * height + row window through `@/lib/inline-database`. Those mappings are pure
 * and exported, so they are pinned here without rendering the Tiptap node view.
 */

const source: ViewConfig = {
  filters: [{ propertyId: "status", operator: "is", value: "todo" }],
  sorts: [{ propertyId: "due", direction: "asc" }],
  groupByPropertyId: "status",
  description: "Source view",
};

const base = {
  instanceId: "i1",
  databaseId: "db1",
  sourceViewId: "v1",
  sourceConfig: source,
  contentHeight: 100,
  viewportHeight: 0,
} as const;

describe("inlineDisplayFor — source view type → inline display", () => {
  it("maps the row/card/board view types", () => {
    expect(inlineDisplayFor("TABLE")).toBe("table");
    expect(inlineDisplayFor("gallery")).toBe("gallery");
    expect(inlineDisplayFor("Board")).toBe("board");
    expect(inlineDisplayFor("CHART")).toBe("chart");
  });

  it("falls back to table for an absent/unknown type", () => {
    expect(inlineDisplayFor(null)).toBe("table");
    expect(inlineDisplayFor(undefined)).toBe("table");
    expect(inlineDisplayFor("mosaic")).toBe("table");
  });
});

describe("linkedEmbedModel — linked-view merge", () => {
  it("merges display overrides over the source in synced mode", () => {
    const embed = linkedEmbedModel({
      ...base,
      mode: "synced",
      overrides: { description: "Instance", groupByPropertyId: "owner" },
      sourceViewType: "TABLE",
    });
    expect(embed.effective.description).toBe("Instance");
    expect(embed.effective.groupByPropertyId).toBe("owner");
    expect(embed.valid).toBe(true);
  });

  it("keeps the source filters/sorts in synced mode even when overridden", () => {
    const embed = linkedEmbedModel({
      ...base,
      mode: "synced",
      overrides: {
        filters: [{ propertyId: "status", operator: "is", value: "done" }],
        sorts: [{ propertyId: "status", direction: "desc" }],
      },
      sourceViewType: "TABLE",
    });
    expect(embed.effective.filters).toEqual(source.filters);
    expect(embed.effective.sorts).toEqual(source.sorts);
  });

  it("lets detached overrides win, including filters and sorts", () => {
    const embed = linkedEmbedModel({
      ...base,
      mode: "detached",
      overrides: { filters: [{ propertyId: "status", operator: "is", value: "done" }] },
      sourceViewType: "TABLE",
    });
    expect(embed.effective.filters).toEqual([
      { propertyId: "status", operator: "is", value: "done" },
    ]);
    expect(embed.effective.sorts).toEqual(source.sorts);
  });

  it("drops unknown override keys", () => {
    const embed = linkedEmbedModel({
      ...base,
      mode: "detached",
      overrides: { bogus: "nope", description: "ok" },
      sourceViewType: "TABLE",
    });
    expect(embed.effective.description).toBe("ok");
    expect("bogus" in (embed.effective as Record<string, unknown>)).toBe(false);
  });
});

describe("linkedEmbedModel — inline shell + row window", () => {
  it("auto-grows while the content is under the maxRows cap", () => {
    const embed = linkedEmbedModel({
      ...base,
      maxRows: 10,
      sourceViewType: "TABLE",
      contentHeight: 100,
    });
    expect(embed.shell.heightCss).toBe("auto");
    expect(embed.shell.scroll).toBe(false);
    expect(embed.block.maxRows).toBe(10);
  });

  it("clamps auto height to maxRows and scrolls past it", () => {
    const embed = linkedEmbedModel({
      ...base,
      maxRows: 10,
      sourceViewType: "TABLE",
      contentHeight: 800,
    });
    expect(embed.shell.heightCss).toBe(`${10 * DEFAULT_ROW_HEIGHT}px`);
    expect(embed.shell.scroll).toBe(true);
  });

  it("offsets the window by scrollTop and pads by overscan", () => {
    const embed = linkedEmbedModel({
      ...base,
      maxRows: 10,
      sourceViewType: "TABLE",
      contentHeight: 800,
      scrollTop: 320,
      rowHeight: 32,
      overscan: 2,
    });
    expect(embed.window).toEqual({ start: 8, end: 22, count: 14, overscan: 2 });
  });

  it("uses the source view type for the block display unless overridden", () => {
    const bySource = linkedEmbedModel({ ...base, sourceViewType: "GALLERY" });
    expect(bySource.display).toBe("gallery");
    expect(bySource.block.display).toBe("gallery");
    const overridden = linkedEmbedModel({
      ...base,
      sourceViewType: "GALLERY",
      display: "board",
    });
    expect(overridden.display).toBe("board");
  });
});

describe("toggleLinkedMode — synced ⇄ detached", () => {
  it("snapshots the effective config when detaching, then drops it on re-sync", () => {
    const embed = linkedEmbedModel({
      ...base,
      mode: "synced",
      overrides: { description: "Instance" },
      sourceViewType: "TABLE",
    });
    const detached = toggleLinkedMode(embed.linked, source);
    expect(detached.mode).toBe("detached");
    expect(detached.overrides.description).toBe("Instance");
    expect(detached.overrides.filters).toEqual(source.filters);

    const syncedAgain = toggleLinkedMode(detached, source);
    expect(syncedAgain.mode).toBe("synced");
    expect(syncedAgain.overrides).toEqual({});
  });

  it("never mutates the instance it flips", () => {
    const embed = linkedEmbedModel({ ...base, mode: "synced", sourceViewType: "TABLE" });
    toggleLinkedMode(embed.linked, source);
    expect(embed.linked.mode).toBe("synced");
  });
});

describe("linkedRowsForView - source view filters/sorts", () => {
  const rows = [
    {
      id: "r1",
      title: "Alpha",
      icon: null,
      values: { status: { optionId: "todo" }, estimate: { number: 5 } },
    },
    {
      id: "r2",
      title: "Beta",
      icon: null,
      values: { status: { optionId: "done" }, estimate: { number: 2 } },
    },
    {
      id: "r3",
      title: "Gamma",
      icon: null,
      values: { status: { optionId: "todo" }, estimate: { number: 9 } },
    },
  ];

  const properties = [
    {
      id: "status",
      name: "Status",
      type: "STATUS",
      config: {
        options: [
          { id: "todo", name: "To-do", color: "gray" },
          { id: "done", name: "Done", color: "green" },
        ],
      },
    },
    { id: "estimate", name: "Estimate", type: "NUMBER", config: null },
  ];

  it("applies the chosen view's filter and sort to the embedded rows", () => {
    const out = linkedRowsForView(rows, properties, {
      filters: [{ propertyId: "estimate", operator: "gt", value: "4" }],
      sorts: [{ propertyId: "estimate", direction: "desc" }],
    });
    expect(out.map((row) => row.id)).toEqual(["r3", "r1"]);
  });

  it("returns the original row objects (values map preserved) in view order", () => {
    const out = linkedRowsForView(rows, properties, {
      sorts: [{ propertyId: "estimate", direction: "asc" }],
    });
    expect(out.map((row) => row.id)).toEqual(["r2", "r1", "r3"]);
    expect(out[0]).toBe(rows[1]);
  });

  it("is a no-op when the source has no config", () => {
    expect(linkedRowsForView(rows, properties, null)).toBe(rows);
  });
});
