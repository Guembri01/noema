import { describe, expect, it } from "vitest";
import {
  NOTION_BLOCK_MAP,
  NOEMA_BLOCK_TYPES,
  PROPERTY_MAP,
  mapNotionBlockType,
  mapNotionColor,
  mapNotionPropertyType,
  unmappedBlocks,
} from "./import-notion-map";

describe("mapNotionBlockType", () => {
  it("maps text and heading blocks onto one heading node", () => {
    expect({
      paragraph: mapNotionBlockType("paragraph"),
      heading_1: mapNotionBlockType("heading_1"),
      heading_2: mapNotionBlockType("heading_2"),
      heading_3: mapNotionBlockType("heading_3"),
    }).toEqual({
      paragraph: "paragraph",
      heading_1: "heading",
      heading_2: "heading",
      heading_3: "heading",
    });
  });

  it("maps list and task blocks to their per-item nodes", () => {
    expect({
      bulleted: mapNotionBlockType("bulleted_list_item"),
      numbered: mapNotionBlockType("numbered_list_item"),
      todo: mapNotionBlockType("to_do"),
    }).toEqual({ bulleted: "listItem", numbered: "listItem", todo: "taskItem" });
  });

  it("maps container and emphasis blocks", () => {
    expect({
      toggle: mapNotionBlockType("toggle"),
      quote: mapNotionBlockType("quote"),
      callout: mapNotionBlockType("callout"),
      code: mapNotionBlockType("code"),
      divider: mapNotionBlockType("divider"),
    }).toEqual({
      toggle: "toggle",
      quote: "blockquote",
      callout: "callout",
      code: "codeBlock",
      divider: "horizontalRule",
    });
  });

  it("maps structural, media and link blocks", () => {
    expect({
      table: mapNotionBlockType("table"),
      tableRow: mapNotionBlockType("table_row"),
      columnList: mapNotionBlockType("column_list"),
      column: mapNotionBlockType("column"),
      image: mapNotionBlockType("image"),
      bookmark: mapNotionBlockType("bookmark"),
      linkPreview: mapNotionBlockType("link_preview"),
      embed: mapNotionBlockType("embed"),
      equation: mapNotionBlockType("equation"),
      toc: mapNotionBlockType("table_of_contents"),
      breadcrumb: mapNotionBlockType("breadcrumb"),
    }).toEqual({
      table: "table",
      tableRow: "tableRow",
      columnList: "columns",
      column: "column",
      image: "image",
      bookmark: "bookmark",
      linkPreview: "bookmark",
      embed: "embed",
      equation: "blockMath",
      toc: "tableOfContents",
      breadcrumb: "breadcrumb",
    });
  });

  it("returns null for Notion blocks Noema handles elsewhere or has no node for", () => {
    expect({
      childPage: mapNotionBlockType("child_page"),
      childDatabase: mapNotionBlockType("child_database"),
      synced: mapNotionBlockType("synced_block"),
      video: mapNotionBlockType("video"),
      audio: mapNotionBlockType("audio"),
      file: mapNotionBlockType("file"),
      pdf: mapNotionBlockType("pdf"),
      unsupported: mapNotionBlockType("unsupported"),
    }).toEqual({
      childPage: null,
      childDatabase: null,
      synced: null,
      video: null,
      audio: null,
      file: null,
      pdf: null,
      unsupported: null,
    });
  });

  it("is exact and total: case, padding and non-strings never map or throw", () => {
    expect([
      mapNotionBlockType("paragraph "),
      mapNotionBlockType("PARAGRAPH"),
      mapNotionBlockType(""),
      mapNotionBlockType(undefined),
      mapNotionBlockType(null),
      mapNotionBlockType(42),
    ]).toEqual([null, null, null, null, null, null]);
  });
});

describe("NOTION_BLOCK_MAP", () => {
  it("only ever points at Noema block types", () => {
    const allowed = new Set<string>(NOEMA_BLOCK_TYPES);
    const invalid = Object.values(NOTION_BLOCK_MAP).filter((value) => !allowed.has(value));
    expect(invalid).toEqual([]);
  });
});

describe("mapNotionPropertyType", () => {
  it("maps the primitive Notion property types", () => {
    expect({
      title: mapNotionPropertyType("title"),
      richText: mapNotionPropertyType("rich_text"),
      number: mapNotionPropertyType("number"),
      select: mapNotionPropertyType("select"),
      multiSelect: mapNotionPropertyType("multi_select"),
      status: mapNotionPropertyType("status"),
      date: mapNotionPropertyType("date"),
      checkbox: mapNotionPropertyType("checkbox"),
    }).toEqual({
      title: "TEXT",
      richText: "TEXT",
      number: "NUMBER",
      select: "SELECT",
      multiSelect: "MULTI_SELECT",
      status: "STATUS",
      date: "DATE",
      checkbox: "CHECKBOX",
    });
  });

  it("maps the link, contact and media property types", () => {
    expect({
      url: mapNotionPropertyType("url"),
      email: mapNotionPropertyType("email"),
      phone: mapNotionPropertyType("phone_number"),
      people: mapNotionPropertyType("people"),
      files: mapNotionPropertyType("files"),
      place: mapNotionPropertyType("place"),
    }).toEqual({
      url: "URL",
      email: "EMAIL",
      phone: "PHONE",
      people: "PEOPLE",
      files: "FILES",
      place: "PLACE",
    });
  });

  it("maps the computed and audit property types", () => {
    expect({
      formula: mapNotionPropertyType("formula"),
      relation: mapNotionPropertyType("relation"),
      rollup: mapNotionPropertyType("rollup"),
      createdTime: mapNotionPropertyType("created_time"),
      createdBy: mapNotionPropertyType("created_by"),
      lastEditedTime: mapNotionPropertyType("last_edited_time"),
      lastEditedBy: mapNotionPropertyType("last_edited_by"),
      uniqueId: mapNotionPropertyType("unique_id"),
      button: mapNotionPropertyType("button"),
    }).toEqual({
      formula: "FORMULA",
      relation: "RELATION",
      rollup: "ROLLUP",
      createdTime: "CREATED_TIME",
      createdBy: "CREATED_BY",
      lastEditedTime: "LAST_EDITED_TIME",
      lastEditedBy: "LAST_EDITED_BY",
      uniqueId: "UNIQUE_ID",
      button: "BUTTON",
    });
  });

  it("returns null for verification and unknown types", () => {
    expect([
      mapNotionPropertyType("verification"),
      mapNotionPropertyType("formula2"),
      mapNotionPropertyType(""),
      mapNotionPropertyType(undefined),
    ]).toEqual([null, null, null, null]);
  });

  it("exposes the same mapping through PROPERTY_MAP", () => {
    expect({ title: PROPERTY_MAP.title, button: PROPERTY_MAP.button }).toEqual({
      title: "TEXT",
      button: "BUTTON",
    });
  });
});

describe("mapNotionColor", () => {
  it("maps the shared palette directly", () => {
    expect([
      mapNotionColor("gray"),
      mapNotionColor("brown"),
      mapNotionColor("blue"),
      mapNotionColor("red"),
    ]).toEqual(["gray", "brown", "blue", "red"]);
  });

  it("strips the `_background` suffix", () => {
    expect([mapNotionColor("blue_background"), mapNotionColor("yellow_background")]).toEqual([
      "blue",
      "yellow",
    ]);
  });

  it("returns null for default, unknown and non-string values", () => {
    expect([
      mapNotionColor("default"),
      mapNotionColor("default_background"),
      mapNotionColor("teal"),
      mapNotionColor("BLUE"),
      mapNotionColor(""),
      mapNotionColor(null),
      mapNotionColor(7),
    ]).toEqual([null, null, null, null, null, null, null]);
  });
});

describe("unmappedBlocks", () => {
  it("reports deduped, first-seen types with no mapping", () => {
    expect(
      unmappedBlocks(["video", "paragraph", "video", "synced_block", "unknown", "paragraph"]),
    ).toEqual(["video", "synced_block", "unknown"]);
  });

  it("is empty when every type maps", () => {
    expect(unmappedBlocks(["paragraph", "heading_1", "image", "to_do"])).toEqual([]);
  });

  it("ignores empty, whitespace-only and non-string entries", () => {
    expect(unmappedBlocks(["", "   ", undefined, null, 3, "video"])).toEqual(["video"]);
  });
});
