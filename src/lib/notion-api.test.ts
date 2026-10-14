import { describe, expect, it } from "vitest";
import { notionBlocksToDoc, notionPageTitle, notionRichTextToNodes } from "./notion-api";

describe("notionRichTextToNodes", () => {
  it("maps annotations and links to marks", () => {
    const nodes = notionRichTextToNodes([
      { plain_text: "Bold", annotations: { bold: true } },
      { plain_text: " link", href: "https://example.com", annotations: {} },
    ]);
    expect(nodes[0]).toEqual({ type: "text", text: "Bold", marks: [{ type: "bold" }] });
    expect(nodes[1].marks?.[0]).toEqual({
      type: "link",
      attrs: { href: "https://example.com" },
    });
  });

  it("ignores empty runs", () => {
    expect(notionRichTextToNodes([{ plain_text: "" }])).toHaveLength(0);
  });
});

describe("notionBlocksToDoc", () => {
  it("groups consecutive list items", () => {
    const doc = notionBlocksToDoc([
      { id: "1", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "one" }] } },
      { id: "2", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "two" }] } },
      { id: "3", type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "first" }] } },
    ]);
    expect(doc.content[0]).toMatchObject({ type: "bulletList" });
    expect(doc.content[0].content).toHaveLength(2);
    expect(doc.content[1]).toMatchObject({ type: "orderedList" });
  });

  it("maps headings, todos, callouts and dividers", () => {
    const doc = notionBlocksToDoc([
      { id: "1", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Title" }] } },
      { id: "2", type: "to_do", to_do: { rich_text: [{ plain_text: "job" }], checked: true } },
      { id: "3", type: "divider", divider: {} },
      { id: "4", type: "callout", callout: { rich_text: [{ plain_text: "note" }], icon: { emoji: "🔥" } } },
    ]);
    expect(doc.content[0]).toMatchObject({ type: "heading", attrs: { level: 2 } });
    expect(doc.content[1]).toMatchObject({ type: "taskList" });
    expect(doc.content[1].content?.[0].attrs).toEqual({ checked: true });
    expect(doc.content[2]).toMatchObject({ type: "horizontalRule" });
    expect(doc.content[3]).toMatchObject({ type: "callout", attrs: { emoji: "🔥" } });
  });

  it("maps code blocks with their language", () => {
    const doc = notionBlocksToDoc([
      { id: "1", type: "code", code: { rich_text: [{ plain_text: "const a = 1;" }], language: "typescript" } },
    ]);
    expect(doc.content[0]).toMatchObject({
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [{ type: "text", text: "const a = 1;" }],
    });
  });

  it("never returns an empty document", () => {
    const doc = notionBlocksToDoc([{ id: "1", type: "unsupported" }]);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toMatchObject({ type: "paragraph" });
  });
});

describe("notionPageTitle", () => {
  it("reads the title property", () => {
    expect(
      notionPageTitle({
        Name: { type: "title", title: [{ plain_text: "My page" }] },
      }),
    ).toBe("My page");
  });

  it("falls back to Untitled", () => {
    expect(notionPageTitle({ Other: { type: "rich_text" } })).toBe("Untitled");
    expect(notionPageTitle(null)).toBe("Untitled");
  });
});
