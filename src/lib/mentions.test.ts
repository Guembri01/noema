import { describe, expect, it } from "vitest";
import {
  collectMentionIds,
  dateMention,
  docMentionsPage,
  pageMention,
  scopeMentionSuggestions,
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

/**
 * B18 — @-mention menu scoping.
 *
 * `scopeMentionSuggestions` is the pure rule the server action applies: a
 * viewer with a page scope (a guest) only ever sees pages inside it, while
 * people and date entries stay (they are not page resources). A `null` scope
 * means "sees the whole workspace" and must not change the list.
 */
describe("scopeMentionSuggestions", () => {
  const items = [
    { id: "page-visible", label: "Visible", type: "page" as const },
    { id: "page-hidden", label: "Hidden", type: "page" as const },
    { id: "user-1", label: "Ada", type: "user" as const },
    { id: "2026-03-04", label: "Mar 4, 2026", type: "date" as const },
  ];

  it("drops pages outside the visible scope but keeps people and dates", () => {
    const scoped = scopeMentionSuggestions(items, new Set(["page-visible"]));
    expect(scoped.map((item) => item.id)).toEqual(["page-visible", "user-1", "2026-03-04"]);
  });

  it("keeps everything when the viewer sees the whole workspace", () => {
    expect(scopeMentionSuggestions(items, null)).toEqual(items);
  });

  it("drops every page for an empty scope", () => {
    const scoped = scopeMentionSuggestions(items, new Set());
    expect(scoped.some((item) => item.type === "page")).toBe(false);
    expect(scoped.some((item) => item.type === "user")).toBe(true);
  });
});

/**
 * B18 — date mention formatting options.
 */
describe("dateMention formatting", () => {
  const date = new Date(2026, 2, 4); // local midnight keeps label formatting deterministic

  it("keeps the short style as the default", () => {
    expect(dateMention(date).label).toBe(dateMention(date, { style: "short" }).label);
    expect(dateMention(date, { locale: "en-US" }).label).toBe("Mar 4, 2026");
  });

  it("supports long and weekday styles with an explicit locale", () => {
    expect(dateMention(date, { locale: "en-US", style: "long" }).label).toBe("March 4, 2026");
    expect(dateMention(date, { locale: "en-US", style: "weekday" }).label).toBe("Wed, Mar 4, 2026");
  });

  it("keeps the ISO id stable across styles", () => {
    const iso = new Date("2026-03-04T00:00:00Z");
    for (const style of ["short", "long", "weekday"] as const) {
      expect(dateMention(iso, { style }).id).toBe("2026-03-04");
    }
  });
});
