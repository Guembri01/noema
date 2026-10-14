import { describe, expect, it } from "vitest";
import {
  BREADCRUMB_ELLIPSIS_ID,
  UNTITLED_LABEL,
  breadcrumbLabel,
  buildBreadcrumb,
  isSameChain,
  truncateBreadcrumb,
  type BreadcrumbItem,
  type BreadcrumbPage,
} from "./breadcrumb";

/**
 * F5 — page breadcrumbs (red-first).
 *
 * `src/lib/breadcrumb.ts` did not exist when this file was written, so the
 * whole suite fails on the missing module until the helpers land. They are the
 * pure, view-facing shaping layer under the page-header breadcrumb: turn the
 * flat `{id, parentId, title}` rows into a labelled root → page chain
 * (`buildBreadcrumb`), trim a deep chain to a fixed budget with an ellipsis
 * (`truncateBreadcrumb`), render the title fallback (`breadcrumbLabel`) and
 * compare two chains by page identity (`isSameChain`).
 *
 * The DB trail (`getAncestorTrail`) and the sidebar kernel (`ancestryOf` in
 * `page-tree.ts`) already exist; these helpers stay free of both — plain rows
 * in, plain crumbs out, no mutation of the caller's data.
 */

const page = (
  id: string,
  parentId: string | null,
  title: string | null = `Page ${id}`,
): BreadcrumbPage => ({ id, parentId, title });

/** root → child → grandchild, the common three-level header case. */
const chainPages: BreadcrumbPage[] = [
  page("root", null, "Workspace home"),
  page("mid", "root", "Notes"),
  page("leaf", "mid", "Meeting notes"),
];

describe("breadcrumbLabel", () => {
  it("returns the page title when present", () => {
    expect(breadcrumbLabel({ title: "Roadmap" })).toBe("Roadmap");
  });

  it("trims surrounding whitespace", () => {
    expect(breadcrumbLabel({ title: "  Roadmap  " })).toBe("Roadmap");
  });

  it("falls back when the title is absent, null or blank", () => {
    expect(breadcrumbLabel({})).toBe(UNTITLED_LABEL);
    expect(breadcrumbLabel({ title: null })).toBe(UNTITLED_LABEL);
    expect(breadcrumbLabel({ title: "" })).toBe(UNTITLED_LABEL);
    expect(breadcrumbLabel({ title: "   " })).toBe(UNTITLED_LABEL);
  });

  it("exposes the documented Untitled fallback", () => {
    expect(UNTITLED_LABEL).toBe("Untitled");
  });

  it("does not mutate the page it labels", () => {
    const input = { id: "p", parentId: null, title: "  Keep me  " };
    expect(breadcrumbLabel(input)).toBe("Keep me");
    expect(input.title).toBe("  Keep me  ");
  });
});

describe("buildBreadcrumb", () => {
  it("returns just the page for a root", () => {
    expect(buildBreadcrumb(chainPages, "root")).toEqual([
      { id: "root", label: "Workspace home" },
    ]);
  });

  it("returns the ancestor chain root → page, page last", () => {
    expect(buildBreadcrumb(chainPages, "leaf")).toEqual([
      { id: "root", label: "Workspace home" },
      { id: "mid", label: "Notes" },
      { id: "leaf", label: "Meeting notes" },
    ]);
  });

  it("is independent of the input row order", () => {
    const shuffled = [chainPages[2], chainPages[0], chainPages[1]];
    expect(buildBreadcrumb(shuffled, "leaf")).toEqual(buildBreadcrumb(chainPages, "leaf"));
  });

  it("is deterministic across calls", () => {
    expect(buildBreadcrumb(chainPages, "leaf")).toEqual(buildBreadcrumb(chainPages, "leaf"));
  });

  it("returns [] for an unknown start id and for an empty list", () => {
    expect(buildBreadcrumb(chainPages, "nope")).toEqual([]);
    expect(buildBreadcrumb([], "leaf")).toEqual([]);
  });

  it("fails closed when an ancestor is missing from the list", () => {
    const broken = [page("leaf", "ghost", "Leaf")];
    expect(buildBreadcrumb(broken, "leaf")).toEqual([]);
  });

  it("is cycle-safe: a parent loop yields [] instead of looping", () => {
    const loop = [page("a", "b", "A"), page("b", "a", "B")];
    expect(buildBreadcrumb(loop, "a")).toEqual([]);
  });

  it("is cycle-safe for a self-parented page", () => {
    expect(buildBreadcrumb([page("x", "x", "X")], "x")).toEqual([]);
  });

  it("labels untitled ancestors via the Untitled fallback", () => {
    const pages = [page("root", null, null), page("leaf", "root", "")];
    expect(buildBreadcrumb(pages, "leaf")).toEqual([
      { id: "root", label: "Untitled" },
      { id: "leaf", label: "Untitled" },
    ]);
  });

  it("does not mutate the input rows", () => {
    const rows = chainPages.map((p) => ({ ...p }));
    buildBreadcrumb(rows, "leaf");
    expect(rows).toEqual(chainPages);
  });
});

describe("truncateBreadcrumb", () => {
  const crumbs = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
    { id: "d", label: "D" },
    { id: "e", label: "E" },
  ];

  it("returns the chain unchanged while it fits the budget", () => {
    expect(truncateBreadcrumb(crumbs.slice(0, 3), { max: 5 })).toEqual(crumbs.slice(0, 3));
    expect(truncateBreadcrumb(crumbs, { max: 5 })).toEqual(crumbs);
  });

  it("keeps the first and last crumbs and collapses the middle", () => {
    expect(truncateBreadcrumb(crumbs, { max: 3 })).toEqual([
      { id: "a", label: "A" },
      { id: BREADCRUMB_ELLIPSIS_ID, label: "…" },
      { id: "e", label: "E" },
    ]);
  });

  it("honours the max budget exactly and keeps the deepest crumbs", () => {
    const out = truncateBreadcrumb(crumbs, { max: 4 });
    expect(out).toHaveLength(4);
    expect(out.map((c) => c.id)).toEqual(["a", BREADCRUMB_ELLIPSIS_ID, "d", "e"]);
  });

  it("uses a custom ellipsis label", () => {
    const out = truncateBreadcrumb(crumbs, { max: 3, ellipsisLabel: "… 3 more" });
    expect(out[1]).toEqual({ id: BREADCRUMB_ELLIPSIS_ID, label: "… 3 more" });
  });

  it("collapses max 1 to the current page and max 2 to first + last", () => {
    expect(truncateBreadcrumb(crumbs, { max: 1 })).toEqual([{ id: "e", label: "E" }]);
    expect(truncateBreadcrumb(crumbs, { max: 2 })).toEqual([
      { id: "a", label: "A" },
      { id: "e", label: "E" },
    ]);
  });

  it("returns [] for a non-positive budget", () => {
    expect(truncateBreadcrumb(crumbs, { max: 0 })).toEqual([]);
    expect(truncateBreadcrumb(crumbs, { max: -3 })).toEqual([]);
  });

  it("returns a fresh array and leaves the input untouched", () => {
    const input = crumbs.map((c) => ({ ...c }));
    const out = truncateBreadcrumb(input, { max: 5 });
    expect(out).not.toBe(input);
    expect(input).toEqual(crumbs);
  });
});

describe("isSameChain", () => {
  it("is true for the same ids in the same order", () => {
    expect(isSameChain(chainPages.map((p) => ({ id: p.id })), [{ id: "root" }, { id: "mid" }, { id: "leaf" }])).toBe(true);
  });

  it("ignores labels when the ids match", () => {
    const before: BreadcrumbItem[] = [
      { id: "root", label: "Old" },
      { id: "leaf", label: "Stale" },
    ];
    const after: BreadcrumbItem[] = [
      { id: "root", label: "New" },
      { id: "leaf", label: "Fresh" },
    ];
    expect(isSameChain(before, after)).toBe(true);
  });

  it("is false on a length mismatch or a differing id", () => {
    expect(isSameChain([{ id: "a" }], [{ id: "a" }, { id: "b" }])).toBe(false);
    expect(isSameChain([{ id: "a" }, { id: "b" }], [{ id: "a" }, { id: "c" }])).toBe(false);
    expect(isSameChain([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "a" }])).toBe(false);
  });

  it("treats two empty chains as equal", () => {
    expect(isSameChain([], [])).toBe(true);
  });
});
