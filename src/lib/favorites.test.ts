import { describe, expect, it } from "vitest";
import {
  dedupeFavorites,
  favoritePositionMap,
  orderFavorites,
  renumberFavorites,
  reorderFavorites,
  sortFavoritesForDisplay,
} from "./favorites";

/**
 * B44 — sidebar favorites ordering/dedupe.
 *
 * Red-first: `src/lib/favorites.ts` did not exist when this file was written,
 * so the suite fails on the missing module until the helper lands. The helper
 * is the pure half of the Favorites sidebar section: it decides which rows are
 * rendered and in what sequence, so it must be provable without a DOM.
 */

type Row = { page: { id: string; title: string; icon: string | null } };
type PositionedRow = Row & { position?: number | null };

const row = (id: string): Row => ({ page: { id, title: id.toUpperCase(), icon: null } });
const prow = (id: string, position?: number | null): PositionedRow => ({
  page: { id, title: id.toUpperCase(), icon: null },
  position,
});
const ids = (rows: readonly { page: { id: string } }[]): string[] =>
  rows.map((r) => r.page.id);

describe("orderFavorites", () => {
  it("keeps the input order when no explicit order is given", () => {
    const rows = [row("a"), row("b"), row("c")];
    expect(orderFavorites(rows).map((r) => r.page.id)).toEqual(["a", "b", "c"]);
  });

  it("dedupes by page id, keeping the first occurrence", () => {
    const rows = [row("a"), row("b"), row("a"), row("c")];
    expect(orderFavorites(rows).map((r) => r.page.id)).toEqual(["a", "b", "c"]);
  });

  it("drops rows whose page id is empty (defensive against broken rows)", () => {
    const rows = [row("a"), row(""), row("b")];
    expect(orderFavorites(rows).map((r) => r.page.id)).toEqual(["a", "b"]);
  });

  it("applies an explicit order: ranked ids first, in that sequence", () => {
    const rows = [row("x"), row("y"), row("z")];
    expect(orderFavorites(rows, ["z", "x"]).map((r) => r.page.id)).toEqual([
      "z",
      "x",
      "y",
    ]);
  });

  it("keeps unlisted favorites after the ranked ones, in input order", () => {
    const rows = [row("u1"), row("r1"), row("u2"), row("r2")];
    expect(orderFavorites(rows, ["r2", "r1"]).map((r) => r.page.id)).toEqual([
      "r2",
      "r1",
      "u1",
      "u2",
    ]);
  });

  it("ignores order ids that are not present in the rows", () => {
    const rows = [row("a"), row("b")];
    expect(orderFavorites(rows, ["ghost", "b"]).map((r) => r.page.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("treats an empty order list as no order at all", () => {
    const rows = [row("a"), row("b")];
    expect(orderFavorites(rows, []).map((r) => r.page.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const rows = [row("a"), row("b"), row("a")];
    const snapshot = [...rows];
    orderFavorites(rows, ["b"]);
    expect(rows).toEqual(snapshot);
  });
});

/**
 * Favorites reorder & pin management (MISSING_FEATURES §9).
 *
 * Red-first again: the reorder/renumber/sort/map/dedupe helpers did not exist
 * when these describes were written. They are the pure core behind a future
 * drag-and-drop sidebar: the persisted order model is an id sequence (the
 * `order` argument of `orderFavorites`), whose positions are array indices,
 * so `renumberFavorites` compacts onto exactly that 0..n-1 index scale.
 */

describe("reorderFavorites", () => {
  it("moves an item down by one", () => {
    expect(reorderFavorites(["a", "b", "c", "d"], 0, 1)).toEqual(["b", "a", "c", "d"]);
  });

  it("moves an item up by one", () => {
    expect(reorderFavorites(["a", "b", "c", "d"], 2, 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("moves an item several positions at once", () => {
    expect(reorderFavorites(["a", "b", "c", "d", "e"], 1, 4)).toEqual([
      "a",
      "c",
      "d",
      "e",
      "b",
    ]);
  });

  it("moves the first item to the last position", () => {
    expect(reorderFavorites(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("moves the last item to the first position", () => {
    expect(reorderFavorites(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("clamps a toIndex past the end to move-to-back", () => {
    expect(reorderFavorites(["a", "b", "c"], 1, 99)).toEqual(["a", "c", "b"]);
  });

  it("returns an equal copy when fromIndex equals toIndex", () => {
    const list = ["a", "b", "c"];
    const moved = reorderFavorites(list, 1, 1);
    expect(moved).toEqual(list);
    expect(moved).not.toBe(list);
  });

  it("leaves the order unchanged when fromIndex is out of bounds", () => {
    expect(reorderFavorites(["a", "b"], 5, 0)).toEqual(["a", "b"]);
    expect(reorderFavorites(["a", "b"], -1, 1)).toEqual(["a", "b"]);
  });

  it("leaves the order unchanged when an index is not an integer or is NaN", () => {
    expect(reorderFavorites(["a", "b"], 0.5, 1)).toEqual(["a", "b"]);
    expect(reorderFavorites(["a", "b"], 0, Number.NaN)).toEqual(["a", "b"]);
  });

  it("handles empty and single-item lists", () => {
    expect(reorderFavorites([], 0, 0)).toEqual([]);
    const single = ["a"];
    const moved = reorderFavorites(single, 0, 0);
    expect(moved).toEqual(["a"]);
    expect(moved).not.toBe(single);
  });

  it("does not mutate the input array", () => {
    const list = [row("a"), row("b"), row("c")];
    const snapshot = [...list];
    reorderFavorites(list, 0, 2);
    expect(list).toEqual(snapshot);
  });
});

describe("renumberFavorites", () => {
  it("renumbers explicit positions into a gap-free 0..n-1 sequence", () => {
    const rows = [prow("c", 4), prow("a", 0), prow("b", 2)];
    expect(renumberFavorites(rows)).toEqual([prow("a", 0), prow("b", 1), prow("c", 2)]);
  });

  it("compacts the gap left by a removal", () => {
    const rows = [prow("a", 0), prow("c", 2), prow("d", 3)];
    expect(renumberFavorites(rows)).toEqual([prow("a", 0), prow("c", 1), prow("d", 2)]);
  });

  it("compacts the gap left by an insert with a far-future position", () => {
    const rows = [prow("a", 0), prow("b", 1), prow("new", 99)];
    expect(renumberFavorites(rows)).toEqual([prow("a", 0), prow("b", 1), prow("new", 2)]);
  });

  it("ranks rows without a position after positioned ones, then renumbers", () => {
    const rows = [prow("x"), prow("b", 1), prow("y"), prow("a", -3)];
    expect(renumberFavorites(rows)).toEqual([
      prow("a", 0),
      prow("b", 1),
      prow("x", 2),
      prow("y", 3),
    ]);
  });

  it("breaks position ties by page id ascending", () => {
    const rows = [prow("b", 5), prow("a", 5)];
    expect(renumberFavorites(rows)).toEqual([prow("a", 0), prow("b", 1)]);
  });

  it("treats a NaN position as unpositioned", () => {
    const rows = [prow("n", Number.NaN), prow("a", 1)];
    expect(renumberFavorites(rows)).toEqual([prow("a", 0), prow("n", 1)]);
  });

  it("dedupes by page id before renumbering", () => {
    const rows = [prow("a", 0), prow("a", 9), prow("b", 1)];
    expect(renumberFavorites(rows)).toEqual([prow("a", 0), prow("b", 1)]);
  });

  it("drops rows with an empty page id", () => {
    const rows = [prow("", 0), prow("a", 1)];
    expect(renumberFavorites(rows)).toEqual([prow("a", 0)]);
  });

  it("does not mutate its input or its rows", () => {
    const rows = [prow("b", 4), prow("a", 1)];
    const snapshot = rows.map((r) => ({ ...r, page: { ...r.page } }));
    const renumbered = renumberFavorites(rows);
    expect(rows).toEqual(snapshot);
    expect(renumbered).not.toBe(rows);
    expect(renumbered[0]).not.toBe(rows[1]);
  });
});

describe("sortFavoritesForDisplay", () => {
  it("sorts lower positions first", () => {
    const rows = [prow("c", 3), prow("a", 1), prow("b", 2)];
    expect(ids([...rows].sort(sortFavoritesForDisplay))).toEqual(["a", "b", "c"]);
  });

  it("ranks rows without a position after positioned ones", () => {
    const rows = [prow("x"), prow("b", 10), prow("y"), prow("a", 5)];
    expect(ids([...rows].sort(sortFavoritesForDisplay))).toEqual(["a", "b", "x", "y"]);
  });

  it("breaks unpositioned ties by page id ascending", () => {
    const rows = [prow("z"), prow("m"), prow("a")];
    expect(ids([...rows].sort(sortFavoritesForDisplay))).toEqual(["a", "m", "z"]);
  });

  it("breaks equal-position ties by page id ascending", () => {
    const rows = [prow("c", 7), prow("a", 7), prow("b", 7)];
    expect(ids([...rows].sort(sortFavoritesForDisplay))).toEqual(["a", "b", "c"]);
  });

  it("treats null and NaN positions as unpositioned", () => {
    const rows = [prow("a", null), prow("n", Number.NaN), prow("b", 1)];
    expect(ids([...rows].sort(sortFavoritesForDisplay))).toEqual(["b", "a", "n"]);
  });

  it("sorts any permutation of the same rows into the same sequence", () => {
    const a = prow("a", 2);
    const b = prow("b");
    const c = prow("c", 1);
    const first = [a, b, c].sort(sortFavoritesForDisplay);
    const second = [c, a, b].sort(sortFavoritesForDisplay);
    expect(ids(first)).toEqual(ids(second));
  });
});

describe("favoritePositionMap", () => {
  it("maps each page id to its index", () => {
    const map = favoritePositionMap([row("a"), row("b"), row("c")]);
    expect(map.get("a")).toBe(0);
    expect(map.get("b")).toBe(1);
    expect(map.get("c")).toBe(2);
    expect(map.size).toBe(3);
  });

  it("keeps the first occurrence of a duplicated page", () => {
    const map = favoritePositionMap([row("a"), row("b"), row("a")]);
    expect(map.get("a")).toBe(0);
    expect(map.get("b")).toBe(1);
    expect(map.size).toBe(2);
  });

  it("skips rows with an empty page id", () => {
    const map = favoritePositionMap([row("a"), row(""), row("b")]);
    expect(map.get("a")).toBe(0);
    expect(map.get("b")).toBe(1);
    expect(map.size).toBe(2);
  });

  it("returns an empty map for an empty list", () => {
    expect(favoritePositionMap([]).size).toBe(0);
  });

  it("reflects the display order when fed a sorted list", () => {
    const display = [prow("c", 3), prow("a", 1), prow("b", 2)].sort(
      sortFavoritesForDisplay,
    );
    const map = favoritePositionMap(display);
    expect(map.get("a")).toBe(0);
    expect(map.get("b")).toBe(1);
    expect(map.get("c")).toBe(2);
  });
});

describe("dedupeFavorites", () => {
  it("keeps the first occurrence of each page id", () => {
    const rows = [row("a"), row("b"), row("a"), row("c"), row("b")];
    expect(ids(dedupeFavorites(rows))).toEqual(["a", "b", "c"]);
  });

  it("drops rows with an empty page id", () => {
    const rows = [row("a"), row(""), row("b")];
    expect(ids(dedupeFavorites(rows))).toEqual(["a", "b"]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const rows = [row("a"), row("a"), row("b")];
    const snapshot = [...rows];
    const deduped = dedupeFavorites(rows);
    expect(deduped).not.toBe(rows);
    expect(rows).toEqual(snapshot);
  });

  it("returns equal content for an already-unique list", () => {
    const rows = [row("a"), row("b")];
    const deduped = dedupeFavorites(rows);
    expect(deduped).not.toBe(rows);
    expect(deduped).toEqual(rows);
  });
});
