/**
 * Export ZIP plan (F7) — the pure, deterministic path planner behind a zip
 * export.
 *
 * A zip export is a flattening problem before it is a packaging problem: a
 * page/workspace tree (`{ id, title, parentId, kind }`) has to become a list
 * of archive entries whose paths are safe, unique and nested by depth. This
 * module owns every decision that has to be provable without a database, a
 * filesystem or React, mirroring the sibling `export-format.ts` builders:
 *
 *  - `slugifySegment` — one archive-safe path segment (diacritics folded,
 *    punctuation collapsed) with an `untitled` fallback;
 *  - `buildZipPlan` — walks the tree and returns entries with paths nested by
 *    depth (`parent/child.md`), siblings deduped with `-1`, `-2`…, databases
 *    as `.csv` and pages as `.md`. Orphaned and cyclic parents are broken
 *    deterministically so the walk always terminates and every page survives;
 *  - `planManifest` — a path-sorted, immutable manifest with per-kind totals;
 *  - `validatePlan` — reports duplicate paths, unsafe path names and parent
 *    cycles, terminating on a cyclic plan instead of looping.
 *
 * Everything is pure and immutable: no function mutates its arguments, each
 * returns fresh arrays/objects, sibling order is derived from content (slug,
 * title, then id) rather than input order, and no clock is read — so the same
 * set of pages always yields byte-identical paths.
 */

import { slugify } from "./slug";
import type { WorkspaceZipKind } from "./export-format";

/** Plan format version, bumped when the entry shape changes. */
export const ZIP_PLAN_VERSION = 1;

/** Extension given to exported pages. */
export const PAGE_EXTENSION = "md";

/** Extension given to exported databases. */
export const DATABASE_EXTENSION = "csv";

/** Segment used when a title slugifies to nothing. */
export const UNTITLED_SEGMENT = "untitled";

/**
 * What a planned entry is. `export-format.ts`'s `WorkspaceZipKind` also covers
 * `attachment`; a *page plan* only ever describes pages and databases.
 */
export type ZipPlanKind = Exclude<WorkspaceZipKind, "attachment">;

/** A page or database as seen by the planner. */
export type ZipPlanSource = {
  id: string;
  title: string;
  parentId: string | null;
  kind: ZipPlanKind;
};

/** One planned archive entry. */
export type ZipPlanEntry = {
  id: string;
  title: string;
  /** Parent the entry was placed under; `null` for a broken/orphaned link. */
  parentId: string | null;
  kind: ZipPlanKind;
  /** POSIX-style path within the archive, e.g. `parent/child.md`. */
  path: string;
  /** Number of ancestor folders (a root entry is depth `0`). */
  depth: number;
};

/** The plan a zip export is assembled from. */
export type ZipPlan = {
  version: number;
  count: number;
  entries: ZipPlanEntry[];
};

/** A path-sorted manifest describing a plan's entries. */
export type ZipPlanManifest = {
  version: number;
  count: number;
  entries: ZipPlanEntry[];
  byKind: Record<ZipPlanKind, number>;
};

/** Why `validatePlan` rejected an entry. */
export type ZipPlanIssueReason = "duplicate-path" | "unsafe-path" | "cycle";

/** One problem found by `validatePlan`. */
export type ZipPlanIssue = {
  id: string;
  path: string;
  reason: ZipPlanIssueReason;
};

/** Result of auditing a plan. */
export type ZipPlanValidation = {
  ok: boolean;
  issues: ZipPlanIssue[];
};

/** `slugify`'s fallback for empty input; a filename prefers `untitled`. */
const EMPTY_SLUG = slugify("");

/**
 * One archive-safe path segment from a title: `@/lib/slug`'s `slugify`
 * (`[a-z0-9-]`, ≤ 48 chars), except that a title with no usable characters
 * becomes `untitled` rather than `workspace`.
 */
export function slugifySegment(title: string): string {
  const input = typeof title === "string" ? title : "";
  const slug = slugify(input);
  const hasContent = /[a-z0-9]/i.test(input);
  return slug === EMPTY_SLUG && !hasContent ? UNTITLED_SEGMENT : slug;
}

/** Extension a kind exports with. */
function extensionFor(kind: ZipPlanKind): string {
  return kind === "database" ? `.${DATABASE_EXTENSION}` : `.${PAGE_EXTENSION}`;
}

/** Content-derived sibling order: slug, then title, then id (all unique ids). */
function compareSiblings(a: ZipPlanSource, b: ZipPlanSource): number {
  const slugA = slugifySegment(a.title);
  const slugB = slugifySegment(b.title);
  if (slugA !== slugB) return slugA < slugB ? -1 : 1;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** `base`, or `base-1`, `base-2`… — the first name not already `used`. */
function uniqueSegment(used: Set<string>, base: string): string {
  let candidate = base;
  let n = 1;
  while (used.has(candidate)) candidate = `${base}-${n++}`;
  used.add(candidate);
  return candidate;
}

/** `start` and its ancestors, self-first, stopping at a missing or repeated id. */
function chainOf(index: ReadonlyMap<string, ZipPlanSource>, start: ZipPlanSource): ZipPlanSource[] {
  const chain: ZipPlanSource[] = [];
  const seen = new Set<string>();
  let current: ZipPlanSource | undefined = start;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  return chain;
}

/** Group ids by their resolved parent (`null` key = roots). */
function buildChildren(
  list: readonly ZipPlanSource[],
  resolved: ReadonlyMap<string, string | null>,
): Map<string | null, string[]> {
  const children = new Map<string | null, string[]>();
  for (const source of list) {
    const parent = resolved.get(source.id) ?? null;
    const bucket = children.get(parent) ?? [];
    bucket.push(source.id);
    children.set(parent, bucket);
  }
  return children;
}

/** Ids reachable from `roots` by following child links. */
function reachableFrom(children: ReadonlyMap<string | null, string[]>, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const kids = children.get(id);
    if (kids) for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return seen;
}

/**
 * Build a plan from page/workspace rows. Rows are copied (never mutated),
 * duplicated ids keep their first row, and each entry gets a safe, unique path:
 *
 *  - a child lives in a folder named after its parent (`projects/alpha.md`);
 *  - siblings that share a base name are deduped with `-1`, `-2`…, so two
 *    pages called "Notes" become `notes.md` and `notes-1.md`;
 *  - a missing, self-referential or cyclic parent is broken to a root at the
 *    smallest id, so the walk terminates and no page is dropped.
 */
export function buildZipPlan(sources: readonly ZipPlanSource[]): ZipPlan {
  const rows = Array.isArray(sources) ? sources : [];
  const index = new Map<string, ZipPlanSource>();
  const list: ZipPlanSource[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw.id !== "string" || raw.id === "" || index.has(raw.id)) continue;
    const source: ZipPlanSource = {
      id: raw.id,
      title: typeof raw.title === "string" ? raw.title : "",
      parentId: typeof raw.parentId === "string" && raw.parentId !== "" ? raw.parentId : null,
      kind: raw.kind === "database" ? "database" : "page",
    };
    index.set(source.id, source);
    list.push(source);
  }

  // Resolve each row's parent. A link that points nowhere (or straight back
  // through the row itself) leaves the row at the top level.
  const resolved = new Map<string, string | null>();
  for (const source of list) {
    const chain = chainOf(index, source);
    resolved.set(source.id, chain.length > 1 ? chain[1].id : null);
  }

  // Any component that is still unreachable is a pure parent cycle; break it
  // at its smallest id and retry until every row can be walked to a root.
  let children = buildChildren(list, resolved);
  const rootIds = (): string[] =>
    list.filter((source) => resolved.get(source.id) === null).map((source) => source.id);
  let orphans = list.filter((source) => !reachableFrom(children, rootIds()).has(source.id));
  while (orphans.length > 0) {
    const pick = orphans.map((source) => source.id).sort()[0];
    resolved.set(pick, null);
    children = buildChildren(list, resolved);
    orphans = list.filter((source) => !reachableFrom(children, rootIds()).has(source.id));
  }

  const entries: ZipPlanEntry[] = [];
  const walk = (parentId: string | null, dirPath: string, depth: number): void => {
    const siblings = (children.get(parentId) ?? [])
      .map((id) => index.get(id))
      .filter((source): source is ZipPlanSource => source !== undefined)
      .sort(compareSiblings);
    const used = new Set<string>();
    for (const source of siblings) {
      const name = uniqueSegment(used, slugifySegment(source.title));
      entries.push({
        id: source.id,
        title: source.title,
        parentId,
        kind: source.kind,
        path: `${dirPath}${name}${extensionFor(source.kind)}`,
        depth,
      });
      if ((children.get(source.id) ?? []).length > 0) {
        walk(source.id, `${dirPath}${name}/`, depth + 1);
      }
    }
  };
  walk(null, "", 0);

  return { version: ZIP_PLAN_VERSION, count: entries.length, entries };
}

/** Path-ascending comparator (id breaks ties), shared by sorted outputs. */
function byPath(a: ZipPlanEntry, b: ZipPlanEntry): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Describe a plan: fresh copies of its entries sorted by `path`, the total
 * count and a per-kind breakdown. The input array and its entries are never
 * mutated.
 */
export function planManifest(entries: readonly ZipPlanEntry[]): ZipPlanManifest {
  const list = (Array.isArray(entries) ? entries : []).map(
    (entry: ZipPlanEntry) => ({ ...entry }),
  );
  list.sort(byPath);
  const byKind: Record<ZipPlanKind, number> = { page: 0, database: 0 };
  for (const entry of list) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  return { version: ZIP_PLAN_VERSION, count: list.length, entries: list, byKind };
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * True when `path` is a relative, POSIX-style archive path no segment of which
 * can escape the archive: no absolute/backslash/control characters, no empty
 * or `.`/`..` segments, and every segment limited to `[A-Za-z0-9._-]`.
 */
function isSafePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (path.includes("\\") || CONTROL_CHARS.test(path)) return false;
  return path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 && segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment),
    );
}

/** Ids whose `parentId` chain loops back on itself (cycle-safe, iterative). */
function findCycleNodes(entries: readonly ZipPlanEntry[]): Set<string> {
  const parentOf = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry && typeof entry.id === "string") parentOf.set(entry.id, entry.parentId ?? null);
  }
  const state = new Map<string, 1 | 2>();
  const cycle = new Set<string>();
  const ids = [...parentOf.keys()].sort();
  for (const start of ids) {
    if (state.get(start) === 2) continue;
    const stack: string[] = [];
    let current: string | null = start;
    while (current !== null && parentOf.has(current) && state.get(current) !== 2) {
      if (state.get(current) === 1) {
        const at = stack.indexOf(current);
        for (let i = at; i < stack.length; i += 1) cycle.add(stack[i]);
        break;
      }
      state.set(current, 1);
      stack.push(current);
      current = parentOf.get(current) ?? null;
    }
    for (const id of stack) state.set(id, 2);
  }
  return cycle;
}

/** Issue order: path, then id, then reason — stable regardless of input order. */
function compareIssues(a: ZipPlanIssue, b: ZipPlanIssue): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
  return 0;
}

/**
 * Audit a plan, three ways:
 *
 *  - `unsafe-path` — a path that is empty, absolute, uses backslashes/control
 *    characters, or carries an empty/`.`/`..` segment;
 *  - `duplicate-path` — a safe path already claimed by an earlier entry;
 *  - `cycle` — an entry whose `parentId` chain loops back on itself.
 *
 * A plan produced by `buildZipPlan` always validates clean (its paths are
 * slugs, deduped, and cycles already broken). The audit terminates on a cyclic
 * plan, reporting each node in the loop, and orders its issues deterministically.
 */
export function validatePlan(entries: readonly ZipPlanEntry[]): ZipPlanValidation {
  const list = Array.isArray(entries) ? entries : [];
  const issues: ZipPlanIssue[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const id = entry && typeof entry.id === "string" ? entry.id : "";
    const path = entry && typeof entry.path === "string" ? entry.path : "";
    if (!isSafePath(path)) {
      issues.push({ id, path, reason: "unsafe-path" });
      continue;
    }
    if (seen.has(path)) issues.push({ id, path, reason: "duplicate-path" });
    else seen.add(path);
  }

  const cyclic = findCycleNodes(list);
  for (const entry of list) {
    if (entry && typeof entry.id === "string" && cyclic.has(entry.id)) {
      issues.push({
        id: entry.id,
        path: typeof entry.path === "string" ? entry.path : "",
        reason: "cycle",
      });
    }
  }

  issues.sort(compareIssues);
  return { ok: issues.length === 0, issues };
}
