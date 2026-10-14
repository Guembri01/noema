import type { RichNode } from "./blocks";

/**
 * Import adapters. `parseTrelloBoard` is pure and unit-tested; ZIP/Markdown
 * traversal happens in the server action (needs JSZip + fs).
 */

export type TrelloCard = { title: string; description: string };
export type TrelloList = { id: string; name: string; cards: TrelloCard[] };
export type TrelloBoard = { name: string; lists: TrelloList[] };

type RawTrello = {
  name?: unknown;
  lists?: { id?: unknown; name?: unknown }[];
  cards?: { name?: unknown; desc?: unknown; idList?: unknown }[];
};

/** Parse a Trello board JSON export into lists with their cards. */
export function parseTrelloBoard(json: unknown): TrelloBoard | { error: string } {
  if (typeof json !== "object" || json === null) {
    return { error: "Not a Trello board." };
  }
  const board = json as RawTrello;
  const rawLists = Array.isArray(board.lists) ? board.lists : [];
  const rawCards = Array.isArray(board.cards) ? board.cards : [];
  if (rawLists.length === 0) {
    return { error: "No lists found — is this a Trello board export?" };
  }

  const lists: TrelloList[] = rawLists.map((list, index) => ({
    id: typeof list.id === "string" ? list.id : `list-${index}`,
    name: typeof list.name === "string" && list.name.trim() ? list.name.trim() : `List ${index + 1}`,
    cards: [],
  }));
  const byId = new Map(lists.map((list) => [list.id, list]));

  for (const card of rawCards) {
    const list = typeof card.idList === "string" ? byId.get(card.idList) : undefined;
    if (!list) continue;
    list.cards.push({
      title: typeof card.name === "string" ? card.name : "Untitled card",
      description: typeof card.desc === "string" ? card.desc : "",
    });
  }

  return {
    name: typeof board.name === "string" && board.name.trim() ? board.name.trim() : "Trello board",
    lists,
  };
}

/** Split a ZIP entry path into nested page titles (drops the file extension). */
export function pathToTitles(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment, index, all) =>
      index === all.length - 1 ? segment.replace(/\.[^.]+$/, "") : segment,
    )
    .filter((segment) => segment.length > 0);
}

/** Build heading/markdown blocks for a Trello card description. */
export function cardDescriptionBlocks(description: string): RichNode[] {
  if (!description.trim()) return [];
  return description
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({
      type: "paragraph",
      content: [{ type: "text", text: line }],
    }));
}
