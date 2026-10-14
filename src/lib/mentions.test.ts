import { describe, expect, it } from "vitest";
import {
  collectMentionIds,
  dateMention,
  docMentionsPage,
  pageMention,
  userMention,
} from "@/lib/mentions";

const doc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "See " },
        { type: "mention", attrs: { id: "page-1", label: "Roadmap", type: "page" } },
        { type: "text", text: " and " },
        { type: "mention", attrs: { id: "user-9", label: "Ada", type: "user" } },
      ],
    },
    {
      type: "callout",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "page-1", label: "Roadmap", type: "page" } },
          ],
        },
      ],
    },
  ],
};

describe("mentions", () => {
  it("collects distinct page mention ids (deduped, nested)", () => {
    expect(collectMentionIds(doc, "page")).toEqual(["page-1"]);
  });

  it("collects all mention ids regardless of type", () => {
    expect(collectMentionIds(doc).sort()).toEqual(["page-1", "user-9"]);
  });

  it("detects whether a document references a page", () => {
    expect(docMentionsPage(doc, "page-1")).toBe(true);
    expect(docMentionsPage(doc, "page-2")).toBe(false);
  });

  it("builds mention attrs", () => {
    expect(pageMention({ id: "p", title: "" })).toEqual({ id: "p", label: "Untitled", type: "page" });
    expect(userMention({ id: "u", name: "Ada" })).toEqual({ id: "u", label: "Ada", type: "user" });
    expect(dateMention(new Date("2026-03-04T00:00:00Z")).id).toBe("2026-03-04");
  });
});
