import { describe, expect, it } from "vitest";
import {
  backlinksFor,
  buildBacklinkIndex,
  countIncoming,
  extractPageLinks,
  linkifyableTargets,
  unlinkedMentions,
  type BacklinkIndex,
  type Block,
  type LinkablePage,
} from "./backlinks";

/** A minimal block; every field except `id`/`type` is optional. */
const block = (id: string, extra: Partial<Block> = {}): Block => ({
  id,
  type: "paragraph",
  ...extra,
});

const ref = (sourcePageId: string, blockId: string) => ({ sourcePageId, blockId });

describe("extractPageLinks", () => {
  it("extracts explicit pageLinkId targets in document order", () => {
    const result = extractPageLinks("p1", [
      block("b1", { pageLinkId: "p2" }),
      block("b2", { pageLinkId: "p3" }),
    ]);
    expect(result.pageId).toBe("p1");
    expect(result.links).toEqual([
      { targetPageId: "p2", blockId: "b1" },
      { targetPageId: "p3", blockId: "b2" },
    ]);
  });

  it("parses internal /page/<id> hrefs, stripping query, hash and foreign hosts", () => {
    const result = extractPageLinks("p1", [
      block("b1", { href: "/page/p2" }),
      block("b2", { href: "/page/p3?tab=comments#c1" }),
      block("b3", { href: "https://noema.example.com/page/p4" }),
      block("b4", { href: "https://example.com/other" }),
      block("b5", { href: "/page/p6/extra" }),
    ]);
    expect(result.links).toEqual([
      { targetPageId: "p2", blockId: "b1" },
      { targetPageId: "p3", blockId: "b2" },
      { targetPageId: "p4", blockId: "b3" },
      { targetPageId: "p6", blockId: "b5" },
    ]);
  });

  it("walks nested children depth-first", () => {
    const result = extractPageLinks("p1", [
      block("b1", { children: [block("b1a", { pageLinkId: "p9" })] }),
      block("b2", { href: "/page/p8" }),
    ]);
    expect(result.links).toEqual([
      { targetPageId: "p9", blockId: "b1a" },
      { targetPageId: "p8", blockId: "b2" },
    ]);
  });

  it("dedupes repeats within one block but keeps distinct blocks", () => {
    const result = extractPageLinks("p1", [
      block("b1", { pageLinkId: "p2", href: "/page/p2" }),
      block("b2", { pageLinkId: "p2" }),
    ]);
    expect(result.links).toEqual([
      { targetPageId: "p2", blockId: "b1" },
      { targetPageId: "p2", blockId: "b2" },
    ]);
    expect(result.links).toHaveLength(2);
  });

  it("returns no links for plain text or empty pages", () => {
    expect(extractPageLinks("p1", [block("b1", { text: "just text" })]).links).toEqual([]);
    expect(extractPageLinks("p1", []).links).toEqual([]);
  });
});

describe("buildBacklinkIndex", () => {
  const pages: LinkablePage[] = [
    { id: "p1", blocks: [block("b1", { pageLinkId: "p3" }), block("b2", { href: "/page/p2" })] },
    { id: "p2", blocks: [block("b1", { pageLinkId: "p3" })] },
    { id: "p3", blocks: [block("b1", { pageLinkId: "p1" })] },
  ];

  it("aggregates refs per target across every page", () => {
    const index = buildBacklinkIndex(pages);
    expect(index.get("p3")).toEqual([ref("p1", "b1"), ref("p2", "b1")]);
    expect(index.get("p2")).toEqual([ref("p1", "b2")]);
    expect(index.get("p1")).toEqual([ref("p3", "b1")]);
  });

  it("dedupes a target repeated within a single block", () => {
    const index = buildBacklinkIndex([
      { id: "src", blocks: [block("b1", { pageLinkId: "t", href: "/page/t" })] },
    ]);
    expect(index.get("t")).toHaveLength(1);
    expect(index.get("t")).toEqual([ref("src", "b1")]);
  });

  it("omits targets that are never linked", () => {
    expect(buildBacklinkIndex(pages).has("missing")).toBe(false);
    expect(buildBacklinkIndex([]).size).toBe(0);
  });
});

describe("backlinksFor", () => {
  it("returns refs sorted by source page then block", () => {
    const index: BacklinkIndex = new Map([
      [
        "t",
        [ref("p2", "a"), ref("p1", "b"), ref("p1", "a")],
      ],
    ]);
    expect(backlinksFor(index, "t")).toEqual([
      ref("p1", "a"),
      ref("p1", "b"),
      ref("p2", "a"),
    ]);
  });

  it("does not mutate the stored list", () => {
    const stored = [ref("p2", "a"), ref("p1", "a")];
    const index: BacklinkIndex = new Map([["t", stored]]);
    backlinksFor(index, "t");
    expect(stored).toEqual([ref("p2", "a"), ref("p1", "a")]);
  });

  it("answers [] for unresolved and empty indexes", () => {
    const pages: LinkablePage[] = [{ id: "p1", blocks: [block("b1", { pageLinkId: "p2" })] }];
    expect(backlinksFor(buildBacklinkIndex(pages), "nope")).toEqual([]);
    expect(backlinksFor(buildBacklinkIndex([]), "p1")).toEqual([]);
  });
});

describe("unlinkedMentions", () => {
  const mentionPages: LinkablePage[] = [
    { id: "p1", blocks: [block("b1", { text: "notes on project ALPHA today" })] },
    {
      id: "p2",
      blocks: [
        block("b1", { text: "Project Alpha once" }),
        block("b2", { text: "Project Alpha twice" }),
      ],
    },
    { id: "p3", blocks: [block("b1", { pageLinkId: "t", text: "Project Alpha linked here" })] },
    { id: "p4", blocks: [block("b1", { text: "Project Alphabet soup" })] },
    { id: "p5", blocks: [block("b1", { text: "unrelated wording" })] },
    { id: "t", blocks: [block("b1", { text: "Project Alpha" })] },
  ];
  const titleOf = (id: string) => (id === "t" ? "Project Alpha" : undefined);
  const mentionIndex = buildBacklinkIndex(mentionPages);

  it("finds case-insensitive, word-bounded mentions once per source page", () => {
    const mentions = unlinkedMentions(mentionIndex, "t", mentionPages, { titleOf });
    expect(mentions).toEqual([ref("p1", "b1"), ref("p2", "b1")]);
    expect(mentions).toHaveLength(2);
  });

  it("excludes already-linked pages, self-mentions and partial-word matches", () => {
    const ids = unlinkedMentions(mentionIndex, "t", mentionPages, { titleOf }).map(
      (m) => m.sourcePageId,
    );
    expect(ids).not.toContain("p3");
    expect(ids).not.toContain("t");
    expect(ids).not.toContain("p4");
    expect(ids).not.toContain("p5");
  });

  it("detects mentions inside nested children", () => {
    const pages: LinkablePage[] = [
      { id: "a", blocks: [block("b1", { children: [block("b1a", { text: "see Project Alpha" })] })] },
      { id: "z", blocks: [] },
    ];
    const out = unlinkedMentions(buildBacklinkIndex(pages), "z", pages, {
      titleOf: (id) => (id === "z" ? "Project Alpha" : undefined),
    });
    expect(out).toEqual([ref("a", "b1")]);
  });

  it("escapes regex metacharacters in the title", () => {
    const pages: LinkablePage[] = [
      { id: "a", blocks: [block("b1", { text: "status: Q3 (draft) is ready" })] },
      { id: "z", blocks: [] },
    ];
    const out = unlinkedMentions(buildBacklinkIndex(pages), "z", pages, {
      titleOf: (id) => (id === "z" ? "Q3 (draft)" : undefined),
    });
    expect(out).toEqual([ref("a", "b1")]);
  });

  it("answers [] when the title is unknown and returns them sorted", () => {
    expect(unlinkedMentions(mentionIndex, "t", mentionPages, { titleOf: () => undefined })).toEqual(
      [],
    );
    const many: LinkablePage[] = [
      { id: "z", blocks: [] },
      { id: "b", blocks: [block("b1", { text: "Alpha" })] },
      { id: "a", blocks: [block("b1", { text: "Alpha" })] },
    ];
    const out = unlinkedMentions(buildBacklinkIndex(many), "z", many, {
      titleOf: (id) => (id === "z" ? "Alpha" : undefined),
    });
    expect(out).toEqual([ref("a", "b1"), ref("b", "b1")]);
  });
});

describe("linkifyableTargets", () => {
  it("keeps known targets while excluding self and already-linked pages", () => {
    const blocks = [block("b1", { pageLinkId: "p2" })];
    expect(linkifyableTargets("p1", blocks, ["p1", "p2", "p3", "p4"])).toEqual(["p3", "p4"]);
  });

  it("dedupes the known ids and sorts the result", () => {
    expect(linkifyableTargets("p1", [], ["p3", "p2", "p3", "p1"])).toEqual(["p2", "p3"]);
  });

  it("never proposes unknown or merely-referenced page ids", () => {
    expect(linkifyableTargets("p1", [block("b1", { href: "/page/ghost" })], ["p2", "p3"])).toEqual([
      "p2",
      "p3",
    ]);
  });
});

describe("countIncoming", () => {
  it("counts the stored refs for a target", () => {
    const pages: LinkablePage[] = [
      { id: "p1", blocks: [block("b1", { pageLinkId: "p3" })] },
      { id: "p2", blocks: [block("b1", { pageLinkId: "p3" })] },
      { id: "p3", blocks: [block("b1", { pageLinkId: "p1" })] },
    ];
    const index = buildBacklinkIndex(pages);
    expect(countIncoming(index, "p3")).toBe(2);
    expect(countIncoming(index, "p1")).toBe(1);
    expect(countIncoming(index, "nope")).toBe(0);
    expect(countIncoming(buildBacklinkIndex([]), "p1")).toBe(0);
  });
});
