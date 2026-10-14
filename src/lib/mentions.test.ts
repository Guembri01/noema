import { describe, expect, it } from "vitest";
import {
  collectMentionIds,
  dateMention,
  docMentionsPage,
  findUnlinkedMentions,
  mentionCandidates,
  pageMention,
  parseMentionQuery,
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

/**
 * B18 — live `@`-mention query parsing behind the mention menu.
 *
 * `parseMentionQuery` answers "is the caret inside an in-progress `@query`
 * token, and if so what does the picker need to replace?" The `kind` is
 * scoped by a prefix word (`@page ro`, `@person`, `@date`) or inferred
 * (an ISO date query implies dates, everything else searches all kinds).
 */
describe("parseMentionQuery", () => {
  it("detects an empty query right after the trigger", () => {
    expect(parseMentionQuery("@", 1)).toEqual({ from: 0, to: 1, query: "", kind: "any" });
    expect(parseMentionQuery("ping @", 6)).toEqual({ from: 5, to: 6, query: "", kind: "any" });
  });

  it("captures a token mid-word, ending at the caret", () => {
    expect(parseMentionQuery("ping @roadmap", 11)).toEqual({ from: 5, to: 11, query: "roadm", kind: "any" });
    expect(parseMentionQuery("ping @roadmap", 10)).toEqual({ from: 5, to: 10, query: "road", kind: "any" });
  });

  it("infers kind 'any' for a plain query", () => {
    expect(parseMentionQuery("@ada", 4)).toEqual({ from: 0, to: 4, query: "ada", kind: "any" });
  });

  it("scopes by a page/user/date prefix word", () => {
    expect(parseMentionQuery("@page ro", 8)).toEqual({ from: 0, to: 8, query: "ro", kind: "page" });
    expect(parseMentionQuery("@Page ", 6)).toEqual({ from: 0, to: 6, query: "", kind: "page" });
    expect(parseMentionQuery("@person ad", 10)).toEqual({ from: 0, to: 10, query: "ad", kind: "user" });
    expect(parseMentionQuery("@date", 5)).toEqual({ from: 0, to: 5, query: "", kind: "date" });
  });

  it("infers kind 'date' from an ISO date query", () => {
    expect(parseMentionQuery("@2026-03-04", 11)).toEqual({ from: 0, to: 11, query: "2026-03-04", kind: "date" });
  });

  it("finds the in-progress token after an adjacent existing mention", () => {
    const text = "see @Roadmap @proj";
    const caret = text.length;
    expect(parseMentionQuery(text, caret)).toEqual({ from: 13, to: caret, query: "proj", kind: "any" });
  });

  it("tolerates a new trigger directly after a completed mention", () => {
    expect(parseMentionQuery("@Roadmap@pro", 12)).toEqual({ from: 8, to: 12, query: "pro", kind: "any" });
  });

  it("does not trigger inside a word or an email address", () => {
    expect(parseMentionQuery("foo@bar", 7)).toBeNull();
    expect(parseMentionQuery("user@example.com", 16)).toBeNull();
    expect(parseMentionQuery("user@example.com", 12)).toBeNull(); // caret right after "user@example"
    expect(parseMentionQuery("hello@world", 5)).toBeNull(); // caret before the trigger
  });

  it("does not cross a newline or accept out-of-range carets", () => {
    expect(parseMentionQuery("@roc\nnext", 9)).toBeNull();
    expect(parseMentionQuery("@ada", -1)).toBeNull();
    expect(parseMentionQuery("@ada", 5)).toBeNull();
  });
});

/**
 * Unlinked mentions — the backlink-discovery pass: page titles typed as
 * plain text (no link/mention node) that should surface as candidate
 * references. Word-boundary aware, case-insensitive, and titles already
 * present as real mention/link nodes are excluded by the caller.
 */
describe("findUnlinkedMentions", () => {
  const titles = ["Roadmap", "Project Atlas", "2026 Plan"];

  it("finds an exact title with word boundaries", () => {
    expect(findUnlinkedMentions("See Roadmap today", titles)).toEqual([
      { title: "Roadmap", index: 4, matched: "Roadmap" },
    ]);
  });

  it("matches case-insensitively but reports the canonical title", () => {
    expect(findUnlinkedMentions("see the ROADMAP", titles)).toEqual([
      { title: "Roadmap", index: 8, matched: "ROADMAP" },
    ]);
  });

  it("respects word boundaries (no matches inside larger words)", () => {
    expect(findUnlinkedMentions("The Roadmap2 doc and xRoadmap", titles)).toEqual([]);
    expect(findUnlinkedMentions("in 12026 Plan territory", titles)).toEqual([]);
  });

  it("matches multi-word titles", () => {
    expect(findUnlinkedMentions("kickoff Project Atlas next week", titles)).toEqual([
      { title: "Project Atlas", index: 8, matched: "Project Atlas" },
    ]);
  });

  it("excludes titles already present as linked mention/link nodes", () => {
    expect(findUnlinkedMentions("Roadmap and Roadmap", titles, { exclude: ["Roadmap"] })).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    expect(findUnlinkedMentions("nothing here", titles)).toEqual([]);
    expect(findUnlinkedMentions("", titles)).toEqual([]);
  });

  it("skips blank and duplicate titles, and sorts matches by position", () => {
    expect(findUnlinkedMentions("Plan B then Roadmap", ["Roadmap", "", "  ", "roadmap"])).toEqual([
      { title: "Roadmap", index: 12, matched: "Roadmap" },
    ]);
  });
});

/**
 * B18 — ranked mention autocomplete, `emojiCandidates` semantics for
 * people/pages/dates: exact label, label prefix, word prefix, substring;
 * ties keep the caller's (server-curated) input order; capped at `limit`.
 */
describe("mentionCandidates", () => {
  const entities = [
    { id: "p1", label: "Roadmap", type: "page" as const },
    { id: "u1", label: "Ada Lovelace", type: "user" as const },
    { id: "d1", label: "Mar 4, 2026", type: "date" as const },
    { id: "p2", label: "Q3 Roadmap", type: "page" as const },
    { id: "u2", label: "Adam", type: "user" as const },
  ];

  it("ranks label-prefix matches before word-prefix matches", () => {
    expect(mentionCandidates("road", entities).map((c) => c.id)).toEqual(["p1", "p2"]);
  });

  it("prefers an exact label over prefix matches", () => {
    expect(mentionCandidates("Roadmap", entities).map((c) => c.id)).toEqual(["p1", "p2"]);
  });

  it("is case-insensitive and keeps input order on ties", () => {
    expect(mentionCandidates("ADA", entities).map((c) => c.id)).toEqual(["u1", "u2"]);
  });

  it("matches substrings only as a fallback", () => {
    expect(mentionCandidates("ovel", entities)).toEqual([{ id: "u1", label: "Ada Lovelace", type: "user" }]);
  });

  it("caps at limit, keeps input order for a blank query, and drops non-matches", () => {
    expect(mentionCandidates("", entities, 2).map((c) => c.id)).toEqual(["p1", "u1"]);
    expect(mentionCandidates("   ", entities, 2).map((c) => c.id)).toEqual(["p1", "u1"]);
    expect(mentionCandidates("ada", entities, 1).map((c) => c.id)).toEqual(["u1"]);
    expect(mentionCandidates("", entities, -1)).toEqual([]);
    expect(mentionCandidates("zzz", entities)).toEqual([]);
  });
});
