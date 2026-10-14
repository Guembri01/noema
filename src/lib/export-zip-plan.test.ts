import { describe, expect, it } from "vitest";
import {
  ZIP_PLAN_VERSION,
  buildZipPlan,
  planManifest,
  slugifySegment,
  validatePlan,
  type ZipPlanEntry,
  type ZipPlanKind,
  type ZipPlanSource,
} from "./export-zip-plan";

/**
 * Export ZIP plan (F7) — the pure, deterministic path planner.
 *
 * Red-first: this file was written BEFORE `src/lib/export-zip-plan.ts`
 * existed, so every import resolved to module-not-found and the suite failed
 * to collect. It pins the plan a workspace/page export is built from:
 *
 *  - `slugifySegment` — one archive-safe path segment (diacritics folded,
 *    punctuation collapsed) with an `untitled` fallback;
 *  - `buildZipPlan` — a page/workspace tree becomes entries whose paths nest
 *    by depth (`parent/child.md`), dedupe siblings with `-1`, give databases a
 *    `.csv` extension, and never hang on a parent cycle;
 *  - `planManifest` — a path-sorted, immutable manifest with per-kind totals;
 *  - `validatePlan` — reports duplicate paths, unsafe path names and parent
 *    cycles, and terminates on a cyclic plan instead of looping.
 */

const page = (id: string, title: string, parentId: string | null = null): ZipPlanSource => ({
  id,
  title,
  parentId,
  kind: "page",
});

const database = (id: string, title: string, parentId: string | null = null): ZipPlanSource => ({
  id,
  title,
  parentId,
  kind: "database",
});

/** Terse plan-entry builder for the validatePlan cases. */
const entry = (
  id: string,
  path: string,
  parentId: string | null = null,
  kind: ZipPlanKind = "page",
): ZipPlanEntry => ({ id, title: id, parentId, kind, path, depth: 0 });

const paths = (plan: ReturnType<typeof buildZipPlan>): string[] =>
  plan.entries.map((e) => e.path);

describe("slugifySegment", () => {
  it("folds a title into one safe, URL-style path segment", () => {
    expect(slugifySegment("Getting Started")).toBe("getting-started");
    expect(slugifySegment("  Section 1: Intro!  ")).toBe("section-1-intro");
    expect(slugifySegment("Café au lait")).toBe("cafe-au-lait");
  });

  it("falls back to `untitled` when a title slugifies to nothing", () => {
    expect(slugifySegment("")).toBe("untitled");
    expect(slugifySegment("!!!")).toBe("untitled");
    expect(slugifySegment("   ")).toBe("untitled");
  });
});

describe("buildZipPlan", () => {
  it("gives root pages a flat `.md` path, deterministically ordered", () => {
    const plan = buildZipPlan([page("p2", "Roadmap"), page("p1", "Getting Started")]);

    expect(plan.version).toBe(ZIP_PLAN_VERSION);
    expect(plan.count).toBe(2);
    expect(paths(plan)).toEqual(["getting-started.md", "roadmap.md"]);
    expect(plan.entries[0].id).toBe("p1");
    expect(plan.entries[0].kind).toBe("page");
    expect(plan.entries[0].depth).toBe(0);
    expect(plan.entries[0].parentId).toBeNull();
  });

  it("nests children in a folder named after the parent, by depth", () => {
    const plan = buildZipPlan([
      page("p1", "Projects"),
      page("p2", "Alpha", "p1"),
      database("p3", "Beta", "p2"),
    ]);

    expect(paths(plan)).toEqual(["projects.md", "projects/alpha.md", "projects/alpha/beta.csv"]);
    expect(plan.entries.map((e) => e.depth)).toEqual([0, 1, 2]);
    expect(plan.entries[2].kind).toBe("database");
    expect(plan.entries[1].parentId).toBe("p1");
  });

  it("dedupes colliding siblings with a `-1` suffix", () => {
    const plan = buildZipPlan([page("n2", "Notes"), page("n1", "Notes")]);

    expect(paths(plan)).toEqual(["notes.md", "notes-1.md"]);
    expect(plan.entries.map((e) => e.id)).toEqual(["n1", "n2"]);
  });

  it("keeps same-titled parents and their children in distinct folders", () => {
    const plan = buildZipPlan([
      page("p1", "Projects"),
      page("p2", "Alpha", "p1"),
      page("p3", "Projects"),
      page("p4", "Alpha", "p3"),
    ]);

    expect(paths(plan)).toEqual([
      "projects.md",
      "projects/alpha.md",
      "projects-1.md",
      "projects-1/alpha.md",
    ]);
  });

  it("treats a missing parent as a root instead of dropping the page", () => {
    const plan = buildZipPlan([page("p1", "Solo", "ghost")]);

    expect(paths(plan)).toEqual(["solo.md"]);
    expect(plan.entries[0].depth).toBe(0);
    expect(plan.entries[0].parentId).toBeNull();
  });

  it("falls back to `untitled` for blank titles, still deduped", () => {
    const plan = buildZipPlan([page("p1", ""), page("p2", "!!!")]);

    expect(paths(plan)).toEqual(["untitled.md", "untitled-1.md"]);
  });

  it("is cycle-safe: a parent loop terminates and keeps every page", () => {
    const plan = buildZipPlan([page("a", "Alpha", "b"), page("b", "Beta", "a")]);

    expect(plan.count).toBe(2);
    expect(paths(plan)).toEqual(["alpha.md", "alpha/beta.md"]);
    expect(new Set(paths(plan)).size).toBe(2);
  });

  it("is order-independent — a shuffled input builds the same plan", () => {
    const sources = [
      page("p1", "Projects"),
      page("p2", "Alpha", "p1"),
      database("p3", "Beta", "p2"),
      page("p4", "Notes"),
    ];

    expect(buildZipPlan([...sources].reverse())).toEqual(buildZipPlan(sources));
  });

  it("never mutates its input rows", () => {
    const sources = [page("p1", "Projects"), page("p2", "Alpha", "p1")];
    const snapshot = structuredClone(sources);

    buildZipPlan(sources);

    expect(sources).toEqual(snapshot);
  });
});

describe("planManifest", () => {
  it("sorts entries by path and totals each kind", () => {
    const sources = [page("p2", "Roadmap"), database("p3", "Metrics"), page("p1", "Getting Started")];
    const manifest = planManifest([...buildZipPlan(sources).entries].reverse());

    expect(manifest.version).toBe(ZIP_PLAN_VERSION);
    expect(manifest.count).toBe(3);
    expect(manifest.entries.map((e) => e.path)).toEqual([
      "getting-started.md",
      "metrics.csv",
      "roadmap.md",
    ]);
    expect(manifest.byKind).toEqual({ page: 2, database: 1 });
  });

  it("returns fresh entries without mutating the plan it was given", () => {
    const entries = buildZipPlan([page("p1", "Roadmap")]).entries;
    const manifest = planManifest(entries);

    expect(manifest.entries).not.toBe(entries);
    expect(manifest.entries[0]).not.toBe(entries[0]);
    manifest.entries[0].path = "changed.md";
    expect(entries[0].path).toBe("roadmap.md");
  });
});

describe("validatePlan", () => {
  it("accepts a plan built from a clean tree", () => {
    const plan = buildZipPlan([
      page("p1", "Projects"),
      page("p2", "Alpha", "p1"),
      database("p3", "Beta", "p2"),
    ]);

    expect(validatePlan(plan.entries)).toEqual({ ok: true, issues: [] });
  });

  it("accepts a built plan even when the source tree had a cycle", () => {
    const plan = buildZipPlan([page("a", "Alpha", "b"), page("b", "Beta", "a")]);

    expect(validatePlan(plan.entries).ok).toBe(true);
  });

  it("flags a duplicate path on the later entry", () => {
    const result = validatePlan([entry("a", "dup.md"), entry("b", "dup.md")]);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ id: "b", path: "dup.md", reason: "duplicate-path" }]);
  });

  it("flags absolute, traversing, backslash and empty-segment paths", () => {
    const unsafe = ["/abs.md", "a/../b.md", "a\\b.md", "", "a//b.md", "a/./b.md", "a\u0000b.md"];
    const result = validatePlan(unsafe.map((path, i) => entry(`u${i}`, path)));

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(unsafe.length);
    expect(result.issues.every((issue) => issue.reason === "unsafe-path")).toBe(true);
  });

  it("reports every page caught in a parent cycle and terminates", () => {
    const result = validatePlan([
      entry("a", "a.md", "b"),
      entry("b", "b.md", "a"),
      entry("c", "c.md", null),
    ]);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { id: "a", path: "a.md", reason: "cycle" },
      { id: "b", path: "b.md", reason: "cycle" },
    ]);
  });

  it("reports a self-referencing parent as a cycle", () => {
    const result = validatePlan([entry("s", "s.md", "s")]);

    expect(result.issues).toEqual([{ id: "s", path: "s.md", reason: "cycle" }]);
  });

  it("orders issues deterministically regardless of input order", () => {
    const forward = [entry("b", "b.md", "a"), entry("a", "a.md", "b")];

    expect(validatePlan(forward)).toEqual(validatePlan([...forward].reverse()));
  });
});
