import { describe, expect, test } from "vitest";
import {
  collectFileUrls,
  fileKeyFromUrl,
  purgeableError,
  staleFileUrls,
  subtreeClosure,
} from "@/lib/trash";

/**
 * B42 — purge guards for the trash restore/permanent-delete feature.
 *
 * These are the pure rules behind `deletePageAction` / `emptyTrashAction`:
 * only trashed pages inside the given workspace may be purged, the purge walks
 * the subtree explicitly (children follow their parent), and uploads referenced
 * by the purged pages are dropped only when nothing that survives still points
 * at them.
 */

describe("purgeableError", () => {
  test("rejects a page that does not exist", () => {
    expect(purgeableError(null, "ws_1")).toBe("Page not found.");
  });

  test("rejects a page from another workspace (scoping)", () => {
    const page = { workspaceId: "ws_other", deletedAt: new Date() };
    expect(purgeableError(page, "ws_1")).toBe(
      "That page is not in this workspace's trash.",
    );
  });

  test("rejects a page that is not in the trash", () => {
    const page = { workspaceId: "ws_1", deletedAt: null };
    expect(purgeableError(page, "ws_1")).toBe(
      "Only pages in the trash can be deleted forever.",
    );
  });

  test("accepts a trashed page in the expected workspace", () => {
    const page = { workspaceId: "ws_1", deletedAt: new Date("2026-01-01") };
    expect(purgeableError(page, "ws_1")).toBeNull();
  });
});

describe("subtreeClosure", () => {
  const nodes = [
    { id: "root", parentId: null },
    { id: "child", parentId: "root" },
    { id: "grandchild", parentId: "child" },
    { id: "sibling", parentId: null },
    { id: "sibling-child", parentId: "sibling" },
  ];

  test("collects every descendant of the seed, nothing else", () => {
    expect(subtreeClosure(nodes, ["root"])).toEqual(["root", "child", "grandchild"]);
  });

  test("keeps seeds that have no entry in the node list", () => {
    expect(subtreeClosure(nodes, ["orphan-seed"])).toEqual(["orphan-seed"]);
  });

  test("survives a parent cycle without duplicating or hanging", () => {
    const cyclic = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ];
    const result = subtreeClosure(cyclic, ["a"]);
    expect(result).toHaveLength(2);
    expect(new Set(result)).toEqual(new Set(["a", "b"]));
  });

  test("deduplicates overlapping seeds", () => {
    expect(subtreeClosure(nodes, ["root", "child"])).toEqual([
      "root",
      "child",
      "grandchild",
    ]);
  });
});

describe("collectFileUrls", () => {
  test("finds upload urls nested anywhere in page JSON", () => {
    const content = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "/api/files/ws_1/abc.png" } },
        {
          type: "paragraph",
          content: [{ type: "text", text: "see /api/files/ws_1/def.pdf) too" }],
        },
      ],
    };
    expect(collectFileUrls(content).sort()).toEqual([
      "/api/files/ws_1/abc.png",
      "/api/files/ws_1/def.pdf",
    ]);
  });

  test("deduplicates repeated urls and ignores foreign urls", () => {
    const value = [
      { coverUrl: "/api/files/ws_1/abc.png" },
      { src: "/api/files/ws_1/abc.png" },
      { src: "https://example.com/pic.png" },
      { src: "data:image/png;base64,AAAA" },
      null,
    ];
    expect(collectFileUrls(value)).toEqual(["/api/files/ws_1/abc.png"]);
  });
});

describe("fileKeyFromUrl", () => {
  test("maps a file route onto its storage key", () => {
    expect(fileKeyFromUrl("/api/files/ws_1/abc.png")).toBe("ws_1/abc.png");
  });

  test("rejects traversal, partial and foreign urls", () => {
    expect(fileKeyFromUrl("/api/files/ws_1/../evil.png")).toBeNull();
    expect(fileKeyFromUrl("/api/files/ws_1")).toBeNull();
    expect(fileKeyFromUrl("https://example.com/pic.png")).toBeNull();
  });
});

describe("staleFileUrls", () => {
  test("drops urls only the purged pages still referenced", () => {
    const purged = [{ src: "/api/files/ws_1/dead.png" }, { src: "/api/files/ws_1/shared.png" }];
    const kept = [{ src: "/api/files/ws_1/shared.png" }];
    expect(staleFileUrls(purged, kept)).toEqual(["/api/files/ws_1/dead.png"]);
  });

  test("keeps nothing when no upload is referenced at all", () => {
    expect(staleFileUrls([{ text: "hello" }], [])).toEqual([]);
  });
});
