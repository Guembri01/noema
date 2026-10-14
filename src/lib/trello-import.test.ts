import { describe, expect, it } from "vitest";
import type { DBProperty, DBRow } from "@/components/database/database-types";
import { parseTrelloBoard, type TrelloImportMeta } from "@/lib/trello-import";

/** Small board: 2 open lists + 1 archived list, 4 cards (one closed, one archived-list). */
const board = {
  name: "Roadmap",
  lists: [
    { id: "l1", name: "To Do", closed: false, pos: 1 },
    { id: "l2", name: "Doing", closed: false, pos: 2 },
    { id: "l3", name: "Old", closed: true, pos: 3 },
  ],
  cards: [
    {
      id: "c1",
      name: "Design spec",
      desc: "Draft the spec",
      idList: "l1",
      labels: [{ id: "lab-red", name: "Urgent", color: "red" }],
      idMembers: ["m1"],
      due: "2026-03-01T09:00:00.000Z",
      shortUrl: "https://trello.com/c/abc",
      closed: false,
    },
    {
      id: "c2",
      name: "Ship it",
      desc: "",
      idList: "l2",
      labels: [{ id: "lab-blue", name: "", color: "blue" }],
      idMembers: ["m1", "m2"],
      due: null,
      shortUrl: "",
      closed: false,
    },
    // Closed card: must be skipped.
    { id: "c3", name: "Old idea", desc: "", idList: "l1", closed: true },
    // Card on an archived list: must be skipped (list is closed).
    { id: "c4", name: "Stale", desc: "", idList: "l3", closed: false },
  ],
  labels: [
    { id: "lab-red", name: "Urgent", color: "red" },
    { id: "lab-blue", name: "", color: "blue" },
  ],
  members: [{ id: "m1", fullName: "Ada Lovelace" }],
};

function propertyOf(result: { properties: DBProperty[] }, name: string): DBProperty {
  const found = result.properties.find((property) => property.name === name);
  if (!found) throw new Error(`missing property ${name}`);
  return found;
}

function valueOf(row: DBRow, propertyId: string): unknown {
  return row.propertyValues.find((entry) => entry.propertyId === propertyId)?.value;
}

describe("parseTrelloBoard (Trello board JSON → database shape)", () => {
  it("derives the properties with the expected types and option order", () => {
    const result = parseTrelloBoard(board);

    // Output-shape alignment: the parser emits the app's own database model.
    const properties: DBProperty[] = result.properties;
    const rows: DBRow[] = result.rows;

    expect(properties.map((property) => property.type)).toEqual([
      "TEXT", // Name (primary, title column)
      "STATUS", // lists, in list order
      "MULTI_SELECT", // labels, in label order
      "URL", // shortUrl
      "DATE", // due
      "PEOPLE", // idMembers → member names (assignee mapping)
      "TEXT", // description (desc)
    ]);
    expect(rows.length).toBeGreaterThan(0);

    expect(propertyOf(result, "Name").config?.primary).toBe(true);

    const status = propertyOf(result, "List");
    expect(status.config?.options?.map((option) => option.name)).toEqual([
      "To Do",
      "Doing",
    ]);

    const labels = propertyOf(result, "Labels");
    expect(labels.config?.options?.map((option) => option.id)).toEqual([
      "lab-red",
      "lab-blue",
    ]);
    // Empty Trello label name falls back to its colour, order preserved.
    expect(labels.config?.options?.[1]).toMatchObject({ name: "Blue", color: "blue" });
  });

  it("maps cards to rows with status, labels, due date, url, members and description", () => {
    const result = parseTrelloBoard(board);
    const row = result.rows.find((entry) => entry.title === "Design spec");
    expect(row).toBeDefined();
    if (!row) return;

    expect(valueOf(row, "list")).toEqual({ optionId: "l1" });
    expect(valueOf(row, "labels")).toEqual({ optionIds: ["lab-red"] });
    expect(valueOf(row, "due")).toEqual({ start: "2026-03-01T09:00:00.000Z" });
    expect(valueOf(row, "url")).toEqual({ text: "https://trello.com/c/abc" });
    expect(valueOf(row, "members")).toEqual({ names: ["Ada Lovelace"] });
    expect(valueOf(row, "description")).toEqual({ text: "Draft the spec" });
    expect(valueOf(row, "name")).toEqual({ text: "Design spec" });
  });

  it("skips closed cards and cards on closed lists, keeping the rest", () => {
    const result = parseTrelloBoard(board);

    expect(result.rows.map((row) => row.title)).toEqual(["Design spec", "Ship it"]);
    expect(result.meta.skippedClosedCards).toBe(1);
    expect(result.meta.skippedOrphanCards).toBe(1); // c4 sits on the archived list
    expect(result.meta.skippedClosedLists).toBe(1);
    expect(result.meta.lists).toBe(2);
    expect(result.meta.cards).toBe(2);
  });

  it("tolerates missing fields without throwing", () => {
    const bare = parseTrelloBoard({
      lists: [{ id: "l1", name: "  " }],
      cards: [{ name: "Bare", idList: "l1" }, "not-a-card", { idList: "nope" }],
    });

    expect(bare.properties.find((property) => property.name === "List")?.config?.options).toEqual([
      { id: "l1", name: "List 1", color: "gray" },
    ]);
    expect(bare.rows).toHaveLength(1);
    expect(bare.rows[0].title).toBe("Bare");
    expect(bare.rows[0].propertyValues.map((entry) => entry.propertyId)).toEqual([
      "name",
      "list",
    ]);
    expect(bare.meta.skippedMalformedCards).toBe(1);
    expect(bare.meta.skippedOrphanCards).toBe(1);

    // Non-board input: fail-safe empty result, never a throw.
    for (const junk of [null, undefined, "nope", 42, [], { lists: [] }]) {
      const failedSafe = parseTrelloBoard(junk);
      expect(failedSafe.properties).toEqual([]);
      expect(failedSafe.rows).toEqual([]);
      expect(failedSafe.meta.cards).toBe(0);
    }
  });

  it("reports unmapped member ids and resolves known members to names", () => {
    const result = parseTrelloBoard(board);

    expect(result.meta.unmappedMemberIds).toEqual(["m2"]);
    const shipIt = result.rows.find((entry) => entry.title === "Ship it");
    expect(shipIt && valueOf(shipIt, "members")).toEqual({ names: ["Ada Lovelace"] });
    // No members array at all: every referenced id is unmapped, nothing throws.
    const withoutMembers = parseTrelloBoard({
      lists: [{ id: "l1", name: "Todo" }],
      cards: [{ name: "A", idList: "l1", idMembers: ["m9", "m9"] }],
    });
    expect(withoutMembers.meta.unmappedMemberIds).toEqual(["m9"]);
    expect(withoutMembers.rows[0].propertyValues.map((entry) => entry.propertyId)).toEqual([
      "name",
      "list",
    ]);
  });

  it("keeps the board name in meta and defaults it when absent", () => {
    const named = parseTrelloBoard(board);
    const meta: TrelloImportMeta = named.meta;
    expect(meta.boardName).toBe("Roadmap");
    expect(meta.labels).toBe(2);
    expect(parseTrelloBoard({ lists: [{ id: "l", name: "X" }] }).meta.boardName).toBe(
      "Trello board",
    );
  });
});
