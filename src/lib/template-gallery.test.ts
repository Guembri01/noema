import { describe, expect, it } from "vitest";
import type { RichNode } from "@/lib/blocks";
import type { PageTemplate } from "@/lib/template-gallery";
import {
  createFromPage,
  describeTemplate,
  duplicateTemplate,
  groupByScope,
  isValidTag,
  listTemplates,
  previewTemplate,
  recordUsage,
  validateTemplateMeta,
} from "@/lib/template-gallery";

/**
 * Unit coverage for the page-template gallery model
 * (docs/specs/templates.md §6 "Page templates" + "Template duplication").
 * Requirement anchors are cited per group: R31.8 (gallery CRUD: duplicate),
 * R31.9 (save page as template), R31.10 (apply is a copy), R31.12/R31.15
 * (picker listing + preview line).
 */

const heading = (text: string, level = 2): RichNode => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});

const paragraph = (text: string): RichNode => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});

const bulletList = (items: string[]): RichNode => ({
  type: "bulletList",
  content: items.map((item) => ({
    type: "listItem",
    content: [paragraph(item)],
  })),
});

function template(overrides: Partial<PageTemplate> = {}): PageTemplate {
  return {
    id: "tpl-1",
    name: "Weekly report",
    scope: "workspace",
    sourcePageId: "page-1",
    blockCount: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    usageCount: 0,
    blocks: [heading("Weekly report"), paragraph("This week"), bulletList(["Shipped"])],
    ...overrides,
  };
}

describe("listTemplates ranking [R31.12, R31.15]", () => {
  const exact = template({ id: "exact", name: "report" });
  const prefix = template({ id: "prefix", name: "reports archive" });
  const tag = template({ id: "tag", name: "Weekly", tags: ["report"] });
  const description = template({ id: "desc", name: "Random", description: "a report about things" });
  const none = template({ id: "none", name: "Nothing", description: "unrelated" });

  it("ranks exact name > prefix > tag > description", () => {
    const ranked = listTemplates([description, prefix, tag, exact], { query: "report" });
    expect(ranked.map((t) => t.id)).toEqual(["exact", "prefix", "tag", "desc"]);
  });

  it("drops templates that match no tier", () => {
    const ranked = listTemplates([exact, none], { query: "report" });
    expect(ranked.map((t) => t.id)).toEqual(["exact"]);
  });

  it("is case-insensitive on the query", () => {
    const ranked = listTemplates([exact, prefix], { query: "REPORT" });
    expect(ranked.map((t) => t.id)).toEqual(["exact", "prefix"]);
  });

  it("returns every template for an empty query", () => {
    expect(listTemplates([exact, none], { query: "   " })).toHaveLength(2);
  });

  it("breaks ties deterministically by name then id", () => {
    const b = template({ id: "b", name: "report beta" });
    const a = template({ id: "a", name: "report beta" });
    const c = template({ id: "c", name: "report alpha" });
    expect(listTemplates([b, a, c], { query: "report" }).map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("filters by scope", () => {
    const ws = template({ id: "ws", scope: "workspace" });
    const personal = template({ id: "p", scope: "personal" });
    expect(listTemplates([ws, personal], { scope: "personal" }).map((t) => t.id)).toEqual(["p"]);
  });

  it("filters by tag case-insensitively", () => {
    const tagged = template({ id: "tagged", tags: ["Weekly", "Team"] });
    const other = template({ id: "other" });
    expect(listTemplates([tagged, other], { tag: "weekly" }).map((t) => t.id)).toEqual(["tagged"]);
  });

  it("sorts by name ascending", () => {
    const a = template({ id: "a", name: "Alpha" });
    const z = template({ id: "z", name: "Zeta" });
    expect(listTemplates([z, a], { sort: "name" }).map((t) => t.id)).toEqual(["a", "z"]);
  });

  it("sorts by created/updated newest first", () => {
    const old = template({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" });
    const recent = template({ id: "recent", createdAt: "2026-06-01T00:00:00.000Z" });
    expect(listTemplates([old, recent], { sort: "created" }).map((t) => t.id)).toEqual([
      "recent",
      "old",
    ]);
    expect(
      listTemplates([{ ...old, updatedAt: "2026-07-01T00:00:00.000Z" }, recent], { sort: "updated" })
        .map((t) => t.id),
    ).toEqual(["old", "recent"]);
  });

  it("sorts by usage count descending", () => {
    const low = template({ id: "low", usageCount: 1 });
    const high = template({ id: "high", usageCount: 9 });
    expect(listTemplates([low, high], { sort: "usage" }).map((t) => t.id)).toEqual(["high", "low"]);
  });

  it("does not mutate the input array", () => {
    const input = [template({ id: "a", name: "B" }), template({ id: "b", name: "A" })];
    listTemplates(input, { sort: "name" });
    expect(input.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("validateTemplateMeta [R31.8, R31.9]", () => {
  const existing = [
    template({ id: "ws-1", name: "Weekly report", scope: "workspace" }),
    template({ id: "p-1", name: "Weekly report", scope: "personal" }),
  ];

  it("accepts a fresh, well-formed name", () => {
    expect(validateTemplateMeta({ name: "Sprint retro", scope: "workspace" }, existing)).toEqual({
      ok: true,
    });
  });

  it("rejects an empty or whitespace name", () => {
    expect(validateTemplateMeta({ name: "   ", scope: "workspace" }, existing)).toEqual({
      ok: false,
      errors: ["empty_name"],
    });
  });

  it("rejects a duplicate name within the same scope (case-insensitive)", () => {
    expect(
      validateTemplateMeta({ name: "weekly REPORT", scope: "workspace" }, existing),
    ).toEqual({ ok: false, errors: ["duplicate_name"] });
  });

  it("allows the same name in a different scope", () => {
    expect(validateTemplateMeta({ name: "Weekly report", scope: "personal" }, [existing[0]])).toEqual(
      { ok: true },
    );
  });

  it("allows renaming a template to its own name", () => {
    expect(
      validateTemplateMeta({ id: "ws-1", name: "Weekly report", scope: "workspace" }, existing),
    ).toEqual({ ok: true });
  });

  it("reports an invalid scope", () => {
    const result = validateTemplateMeta(
      { name: "Fine", scope: "global" as unknown as PageTemplate["scope"] },
      [],
    );
    expect(result).toEqual({ ok: false, errors: ["invalid_scope"] });
  });

  it("accepts lowercase kebab-case tags", () => {
    expect(isValidTag("weekly-report")).toBe(true);
    expect(isValidTag("v2")).toBe(true);
    expect(validateTemplateMeta({ name: "X", scope: "workspace", tags: ["a-b", "c"] }, [])).toEqual({
      ok: true,
    });
  });

  it("rejects tags with invalid characters", () => {
    expect(isValidTag("Weekly")).toBe(false);
    expect(isValidTag("has space")).toBe(false);
    expect(isValidTag("-leading")).toBe(false);
    expect(isValidTag("under_score")).toBe(false);
    expect(
      validateTemplateMeta({ name: "X", scope: "workspace", tags: ["ok", "Bad Tag"] }, []),
    ).toEqual({ ok: false, errors: ["invalid_tag:Bad Tag"] });
  });

  it("reports every problem in one pass", () => {
    const result = validateTemplateMeta(
      { name: "", scope: "workspace", tags: ["NOPE"] },
      existing,
    );
    expect(result).toEqual({ ok: false, errors: ["empty_name", "invalid_tag:NOPE"] });
  });
});

describe("previewTemplate [R31.15]", () => {
  const blocks = [
    heading("Report"),
    paragraph("First line here"),
    bulletList(["One", "Two"]),
    { type: "horizontalRule" } as RichNode,
  ];

  it("outlines the first blocks with their type and first text line", () => {
    const preview = previewTemplate(template({ blocks, blockCount: blocks.length }), {
      maxBlocks: 2,
    });
    expect(preview.entries).toEqual([
      { type: "heading", text: "Report" },
      { type: "paragraph", text: "First line here" },
    ]);
  });

  it("marks a truncated preview and reports the counts", () => {
    const preview = previewTemplate(template({ blocks, blockCount: blocks.length }), {
      maxBlocks: 2,
    });
    expect(preview.shown).toBe(2);
    expect(preview.blockCount).toBe(4);
    expect(preview.truncated).toBe(true);
  });

  it("is not truncated when every block fits", () => {
    const preview = previewTemplate(template({ blocks, blockCount: blocks.length }), {
      maxBlocks: 5,
    });
    expect(preview.entries).toHaveLength(4);
    expect(preview.truncated).toBe(false);
  });

  it("uses a first-list-item line and an empty string for textless blocks", () => {
    const preview = previewTemplate(template({ blocks, blockCount: blocks.length }), {
      maxBlocks: 4,
    });
    expect(preview.entries[2]).toEqual({ type: "bulletList", text: "One" });
    expect(preview.entries[3]).toEqual({ type: "horizontalRule", text: "" });
  });

  it("clamps a zero or negative maxBlocks to an empty outline", () => {
    expect(previewTemplate(template({ blocks, blockCount: blocks.length }), { maxBlocks: 0 }).entries)
      .toEqual([]);
    expect(previewTemplate(template({ blocks, blockCount: blocks.length }), { maxBlocks: -3 }).entries)
      .toEqual([]);
  });

  it("handles a template with no snapshotted blocks", () => {
    const preview = previewTemplate(template({ blocks: undefined, blockCount: 0 }), { maxBlocks: 3 });
    expect(preview).toEqual({ entries: [], shown: 0, blockCount: 0, truncated: false });
  });
});

describe("recordUsage [R31.10]", () => {
  const now = new Date("2026-03-04T09:00:00.000Z");

  it("increments the usage count and stamps updatedAt", () => {
    const used = recordUsage(template({ usageCount: 2 }), { now });
    expect(used.usageCount).toBe(3);
    expect(used.updatedAt).toBe("2026-03-04T09:00:00.000Z");
  });

  it("leaves the original template untouched (immutability)", () => {
    const source = template({ usageCount: 2 });
    const used = recordUsage(source, { now });
    expect(source.usageCount).toBe(2);
    expect(source.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(used).not.toBe(source);
  });

  it("preserves every other field", () => {
    const source = template({ icon: "📈", tags: ["a"] });
    const used = recordUsage(source, { now });
    expect(used.id).toBe(source.id);
    expect(used.name).toBe(source.name);
    expect(used.icon).toBe("📈");
    expect(used.tags).toEqual(["a"]);
    expect(used.createdAt).toBe(source.createdAt);
    expect(used.blockCount).toBe(source.blockCount);
  });

  it("is deterministic for the same now", () => {
    expect(recordUsage(template(), { now })).toEqual(recordUsage(template(), { now }));
  });
});

describe("createFromPage [R31.9]", () => {
  const now = new Date("2026-05-05T08:30:00.000Z");
  const page = {
    id: "page-9",
    title: "Notes",
    icon: "📝",
    cover: "cover.png",
    description: "Team notes",
    tags: ["team", "notes"],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { id: "b1" }, content: [{ type: "text", text: "One" }] },
        { type: "paragraph", attrs: { id: "b2" }, content: [{ type: "text", text: "Two" }] },
        { type: "paragraph", attrs: { id: "b3" }, content: [{ type: "text", text: "Three" }] },
      ] as RichNode[],
    },
  };

  it("snapshots page metadata into a new template", () => {
    const tpl = createFromPage(page, { name: "Note template", scope: "personal", now });
    expect(tpl.name).toBe("Note template");
    expect(tpl.scope).toBe("personal");
    expect(tpl.sourcePageId).toBe("page-9");
    expect(tpl.icon).toBe("📝");
    expect(tpl.cover).toBe("cover.png");
    expect(tpl.description).toBe("Team notes");
    expect(tpl.tags).toEqual(["team", "notes"]);
    expect(tpl.blockCount).toBe(3);
    expect(tpl.usageCount).toBe(0);
    expect(tpl.createdAt).toBe("2026-05-05T08:30:00.000Z");
    expect(tpl.updatedAt).toBe("2026-05-05T08:30:00.000Z");
  });

  it("snapshots only the requested block ids, in page order", () => {
    const tpl = createFromPage(page, {
      name: "Subset",
      scope: "workspace",
      blockIds: ["b3", "b1"],
      now,
    });
    expect(tpl.blockCount).toBe(2);
    expect(tpl.blocks?.map((node) => node.attrs?.id)).toEqual(["b1", "b3"]);
  });

  it("deep-copies the block snapshot so later edits cannot leak", () => {
    const tpl = createFromPage(page, { name: "Copied", scope: "workspace", now });
    (tpl.blocks?.[0] as RichNode).text = "changed";
    expect(page.content.content[0].text).toBeUndefined();
    expect(tpl.blocks).not.toBe(page.content.content);
  });

  it("is deterministic for identical inputs", () => {
    expect(createFromPage(page, { name: "X", scope: "workspace", now })).toEqual(
      createFromPage(page, { name: "X", scope: "workspace", now }),
    );
  });

  it("accepts a flat blocks array instead of a doc", () => {
    const tpl = createFromPage(
      { id: "page-2", blocks: [heading("Hi"), paragraph("Body")] },
      { name: "Flat", scope: "workspace", now },
    );
    expect(tpl.blockCount).toBe(2);
  });
});

describe("duplicateTemplate [R31.8]", () => {
  it("assigns the new id, name and scope", () => {
    const copy = duplicateTemplate(template(), {
      newId: "tpl-2",
      name: "Quarterly",
      scope: "personal",
    });
    expect(copy.id).toBe("tpl-2");
    expect(copy.name).toBe("Quarterly");
    expect(copy.scope).toBe("personal");
  });

  it("defaults the name to the source name plus 'copy' and keeps the scope", () => {
    const copy = duplicateTemplate(template({ name: "Weekly report", scope: "personal" }), {
      newId: "tpl-2",
    });
    expect(copy.name).toBe("Weekly report copy");
    expect(copy.scope).toBe("personal");
  });

  it("requires a new id", () => {
    expect(() => duplicateTemplate(template(), { newId: "" })).toThrow(/new template id/i);
  });

  it("resets the usage count and keeps timestamps", () => {
    const copy = duplicateTemplate(template({ usageCount: 7 }), { newId: "tpl-2" });
    expect(copy.usageCount).toBe(0);
    expect(copy.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(copy.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("deep-copies blocks independently of the source", () => {
    const source = template();
    const copy = duplicateTemplate(source, { newId: "tpl-2" });
    expect(copy.blocks).toEqual(source.blocks);
    expect(copy.blocks).not.toBe(source.blocks);
    (copy.blocks?.[0] as RichNode).text = "changed";
    expect((source.blocks?.[0] as RichNode).text).toBeUndefined();
  });

  it("leaves the source template untouched", () => {
    const source = template();
    duplicateTemplate(source, { newId: "tpl-2", name: "Renamed" });
    expect(source.id).toBe("tpl-1");
    expect(source.name).toBe("Weekly report");
  });
});

describe("describeTemplate [R31.15]", () => {
  it("summarizes scope and block count", () => {
    expect(describeTemplate(template({ name: "Report", scope: "workspace", blockCount: 1 }))).toBe(
      "Report (workspace, 1 block)",
    );
  });

  it("pluralises the block count", () => {
    expect(describeTemplate(template({ name: "Report", blockCount: 3 }))).toBe(
      "Report (workspace, 3 blocks)",
    );
  });

  it("lists tags and usage when present", () => {
    expect(
      describeTemplate(template({ name: "Report", tags: ["a", "b"], usageCount: 4, blockCount: 0 })),
    ).toBe("Report (workspace, 0 blocks, tags: a, b, used 4×)");
  });

  it("falls back to an untitled label", () => {
    expect(describeTemplate(template({ name: "  " }))).toBe("Untitled template (workspace, 3 blocks)");
  });
});

describe("groupByScope [R31.7]", () => {
  it("groups templates by scope, preserving input order", () => {
    const a = template({ id: "a", scope: "workspace" });
    const b = template({ id: "b", scope: "personal" });
    const c = template({ id: "c", scope: "workspace" });
    const groups = groupByScope([a, b, c]);
    expect(groups.workspace.map((t) => t.id)).toEqual(["a", "c"]);
    expect(groups.personal.map((t) => t.id)).toEqual(["b"]);
  });

  it("returns empty buckets for no templates", () => {
    expect(groupByScope([])).toEqual({ workspace: [], personal: [] });
  });
});
