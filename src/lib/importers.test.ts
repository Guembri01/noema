import { describe, expect, it } from "vitest";
import {
  cardDescriptionBlocks,
  parseTrelloBoard,
  pathToTitles,
} from "@/lib/importers";

const board = {
  name: "Product",
  lists: [
    { id: "l1", name: "To Do" },
    { id: "l2", name: "Done" },
  ],
  cards: [
    { name: "Write spec", desc: "Draft it", idList: "l1" },
    { name: "Ship", desc: "", idList: "l2" },
    { name: "Orphan", desc: "", idList: "nope" },
  ],
};

describe("parseTrelloBoard", () => {
  it("groups cards under their lists", () => {
    const parsed = parseTrelloBoard(board);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.name).toBe("Product");
    expect(parsed.lists.map((l) => l.name)).toEqual(["To Do", "Done"]);
    expect(parsed.lists[0].cards[0]).toEqual({ title: "Write spec", description: "Draft it" });
    expect(parsed.lists[1].cards[0].title).toBe("Ship");
  });

  it("rejects non-board input", () => {
    expect(parseTrelloBoard(null)).toHaveProperty("error");
    expect(parseTrelloBoard({ lists: [] })).toHaveProperty("error");
    expect(parseTrelloBoard("nope")).toHaveProperty("error");
  });
});

describe("pathToTitles", () => {
  it("strips extensions and keeps folder nesting", () => {
    expect(pathToTitles("Projects/Roadmap/Q1 Plan.md")).toEqual([
      "Projects",
      "Roadmap",
      "Q1 Plan",
    ]);
    expect(pathToTitles("Note.md")).toEqual(["Note"]);
  });
});

describe("cardDescriptionBlocks", () => {
  it("turns a description into paragraph blocks", () => {
    expect(cardDescriptionBlocks("one\n\ntwo")).toHaveLength(2);
    expect(cardDescriptionBlocks("")).toEqual([]);
  });
});
