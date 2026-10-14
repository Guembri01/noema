import { describe, expect, it } from "vitest";
import { orderFavorites } from "./favorites";

/**
 * B44 — sidebar favorites ordering/dedupe.
 *
 * Red-first: `src/lib/favorites.ts` did not exist when this file was written,
 * so the suite fails on the missing module until the helper lands. The helper
 * is the pure half of the Favorites sidebar section: it decides which rows are
 * rendered and in what sequence, so it must be provable without a DOM.
 */

type Row = { page: { id: string; title: string; icon: string | null } };

const row = (id: string): Row => ({ page: { id, title: id.toUpperCase(), icon: null } });

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
