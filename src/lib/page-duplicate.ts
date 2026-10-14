/**
 * Duplicate a page *subtree*: the pure planning half of "Clone a page with
 * children" (docs/MISSING_FEATURES.md §Workspaces row "Duplicate page";
 * docs/specs/workspaces-structure.md R80.10).
 *
 * Today's server action (`page-menu.ts:229-281`, `duplicatePageAction`) clones a
 * single row; R80.10 upgrades it to a depth-preserving subtree copy that
 * remaps every parent link and every relation endpoint that lands inside the
 * copied set. Before any of that touches Prisma, the action needs to know which
 * ids to rewrite — this module answers that, entirely in memory (no DB, no
 * React):
 *
 * - the subtree (root plus all descendants) is collected from a flat page list
 *   using `parentId`, in the caller's input order;
 * - every copied page gets a **fresh** id, its title gains the configured
 *   suffix, and its `parentId` is remapped to the copy's parent — except the
 *   subtree root, whose (external) parent is preserved so the copy is a sibling;
 * - every block gets a fresh id too (depth-first, `children` included), while
 *   all other fields are deep-cloned byte for byte;
 * - the input is never mutated and the returned pages are fully independent.
 *
 * `validatePageDuplicate` is the safety net: it rejects a copy that reuses an
 * original id, declares a duplicate id, points a parent at the wrong page, is
 * missing from / absent in the id map, or has a page that cannot be reached
 * from the subtree root (an orphan or a detached cycle).
 */

/** A block (or nested block) carrying a stable id; extra fields are kept. */
export type PageBlock = {
  id: string;
  children?: PageBlock[];
  [key: string]: unknown;
};

/** A page reduced to what a subtree copy needs; extra fields are kept. */
export type PageNode = {
  id: string;
  /** `null`/absent = top level; otherwise the parent page id. */
  parentId?: string | null;
  title?: string;
  blocks?: PageBlock[];
  [key: string]: unknown;
};

/** Allocates one fresh id per call. */
export type IdFactory = () => string;

/** Options for `planPageDuplicate`. */
export type PageDuplicateOptions = {
  /** Fresh-id allocator; defaults to `defaultIdFactory` (deterministic callers pass their own). */
  idFactory?: IdFactory;
  /** Appended to every copied page's title. Defaults to `" (copy)"`. */
  titleSuffix?: string;
};

/** The plan a caller writes from: the copied pages and their old → new page ids. */
export type PageDuplicatePlan = {
  pages: PageNode[];
  idMap: Map<string, string>;
};

/** Outcome of `validatePageDuplicate`; `errors` is empty exactly when `ok` is true. */
export type PageDuplicateValidation = { ok: boolean; errors: string[] };

let defaultCounter = 0;

/**
 * Default id factory: fresh, collision-resistant ids. Randomised so two copies
 * in the same process never share an id, and prefixed so generated output is
 * recognisable. Callers that need determinism pass their own `IdFactory`.
 */
export function defaultIdFactory(): string {
  defaultCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `page_${defaultCounter.toString(36)}_${random}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Generic deep clone that keeps every own field, `undefined` included. */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) clone[key] = cloneValue(item);
    return clone as T;
  }
  return value;
}

/** Deep-clone a block subtree, assigning a fresh id to every block. */
function reidBlock(block: PageBlock, idFactory: IdFactory): PageBlock {
  const clone = cloneValue(block);
  clone.id = idFactory();
  if (Array.isArray(block.children)) {
    clone.children = block.children.map((child) => reidBlock(child, idFactory));
  }
  return clone;
}

/**
 * The subtree of `rootId` (root + descendants), filtered out of the input list
 * so the caller's order is preserved. Unknown root → empty. Cycle-safe: a
 * malformed descendant loop cannot make the walk revisit a page.
 */
function collectSubtree(pages: readonly PageNode[], rootId: string): PageNode[] {
  const known = new Set(pages.map((page) => page?.id));
  if (!known.has(rootId)) return [];

  const children = new Map<string, string[]>();
  for (const page of pages) {
    if (!isNonEmptyString(page?.id)) continue;
    const parent = isNonEmptyString(page.parentId) ? page.parentId : null;
    if (parent === null) continue;
    const bucket = children.get(parent) ?? [];
    bucket.push(page.id);
    children.set(parent, bucket);
  }

  const inSubtree = new Set<string>([rootId]);
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (inSubtree.has(child)) continue; // already collected — also breaks cycles
      inSubtree.add(child);
      stack.push(child);
    }
  }
  return pages.filter((page) => inSubtree.has(page?.id as string));
}

/** Every block id under `blocks`, depth-first (used by validation). */
function collectBlockIds(blocks: unknown, out: string[]): void {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as { id?: unknown; children?: unknown };
    if (isNonEmptyString(record.id)) out.push(record.id);
    collectBlockIds(record.children, out);
  }
}

/**
 * Plan a subtree duplicate of `rootId` from a flat page list.
 *
 * Ids are allocated in a stable order — every page id first (in subtree order),
 * then each page's block ids depth-first — so a supplied `idFactory` can be
 * deterministic in tests. The subtree root keeps its original (external)
 * `parentId`, making the copy a sibling; every descendant is re-parented onto
 * its copy.
 */
export function planPageDuplicate(
  pages: readonly PageNode[],
  rootId: string,
  options: PageDuplicateOptions = {},
): PageDuplicatePlan {
  const { idFactory = defaultIdFactory, titleSuffix = " (copy)" } = options;
  const list = Array.isArray(pages) ? pages : [];
  const subtree = collectSubtree(list, rootId);

  const idMap = new Map<string, string>();
  for (const page of subtree) idMap.set(page.id, idFactory());

  const copies = subtree.map((page) => {
    const clone = cloneValue(page);
    clone.id = idMap.get(page.id)!;
    clone.parentId =
      isNonEmptyString(page.parentId) && idMap.has(page.parentId)
        ? idMap.get(page.parentId)!
        : (isNonEmptyString(page.parentId) ? page.parentId : null);
    if (typeof page.title === "string") clone.title = page.title + titleSuffix;
    if (Array.isArray(clone.blocks)) {
      clone.blocks = clone.blocks.map((block) => reidBlock(block, idFactory));
    }
    return clone;
  });

  return { pages: copies, idMap };
}

/**
 * Check that `plan` is a faithful subtree duplicate of `original`.
 *
 * Reported problems: duplicate ids inside the copy (`duplicate id`), ids
 * carried over from the original (`id reused from original`, page and block),
 * a parent left pointing at the wrong page (`parent not remapped`), a copy page
 * the map does not describe (`copy page not in id map`) or a map entry with no
 * page (`missing copy page`), an unknown original (`unknown original page`), a
 * root that cannot be identified (`expected exactly one subtree root`), and
 * pages unreachable from the root — orphans and detached cycles
 * (`unreachable page`). `ok` is true exactly when the list is empty.
 */
export function validatePageDuplicate(
  original: readonly PageNode[],
  plan: PageDuplicatePlan,
): PageDuplicateValidation {
  const errors: string[] = [];
  const originalPages = Array.isArray(original) ? original : [];
  const copies = Array.isArray(plan?.pages) ? plan.pages : [];
  const idMap = plan?.idMap instanceof Map ? plan.idMap : new Map<string, string>();

  const byOld = new Map<string, PageNode>();
  const originalIds = new Set<string>();
  for (const page of originalPages) {
    if (!isNonEmptyString(page?.id)) continue;
    byOld.set(page.id, page);
    originalIds.add(page.id);
  }

  const counts = new Map<string, number>();
  for (const page of copies) {
    if (isNonEmptyString(page?.id)) counts.set(page.id, (counts.get(page.id) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count > 1) errors.push(`duplicate id: ${id}`);
    if (originalIds.has(id)) errors.push(`id reused from original: ${id}`);
  }
  const copyIds = new Set(counts.keys());

  const byNew = new Map<string, string>();
  for (const [oldId, newId] of idMap) byNew.set(newId, oldId);

  for (const page of copies) {
    if (isNonEmptyString(page?.id) && !byNew.has(page.id)) {
      errors.push(`copy page not in id map: ${page.id}`);
    }
  }
  for (const [oldId, newId] of idMap) {
    if (!copyIds.has(newId)) errors.push(`missing copy page: ${newId}`);
    if (!byOld.has(oldId)) errors.push(`unknown original page: ${oldId}`);
  }

  // The subtree root is the mapped page whose original parent is *not* mapped.
  const oldIds = new Set(idMap.keys());
  const roots = [...oldIds].filter((oldId) => {
    const parent = byOld.get(oldId)?.parentId;
    return !(isNonEmptyString(parent) && oldIds.has(parent));
  });
  if (roots.length !== 1) errors.push(`expected exactly one subtree root, found ${roots.length}`);
  const rootOld = roots.length === 1 ? roots[0] : undefined;
  const rootNew = rootOld !== undefined ? idMap.get(rootOld) : undefined;

  for (const page of copies) {
    if (!isNonEmptyString(page?.id)) continue;
    const oldId = byNew.get(page.id);
    if (oldId === undefined) continue; // already reported above
    const oldPage = byOld.get(oldId);
    if (!oldPage) continue; // already reported above
    const oldParent = isNonEmptyString(oldPage.parentId) ? oldPage.parentId : null;
    const expected =
      page.id === rootNew
        ? oldParent // root keeps its external parent
        : oldParent !== null && oldIds.has(oldParent)
          ? idMap.get(oldParent)!
          : oldParent;
    const actual = isNonEmptyString(page.parentId) ? page.parentId : null;
    if (actual !== expected) errors.push(`parent not remapped: ${page.id}`);
  }

  if (rootNew !== undefined && copyIds.has(rootNew)) {
    const children = new Map<string, string[]>();
    for (const page of copies) {
      if (!isNonEmptyString(page?.id) || !isNonEmptyString(page.parentId)) continue;
      const bucket = children.get(page.parentId) ?? [];
      bucket.push(page.id);
      children.set(page.parentId, bucket);
    }
    const visited = new Set<string>([rootNew]);
    const stack: string[] = [rootNew];
    while (stack.length > 0) {
      for (const child of children.get(stack.pop()!) ?? []) {
        if (visited.has(child)) continue;
        visited.add(child);
        stack.push(child);
      }
    }
    for (const id of copyIds) {
      if (!visited.has(id)) errors.push(`unreachable page: ${id}`);
    }
  }

  const originalBlockIds = new Set<string>();
  const originalBlockList: string[] = [];
  for (const page of originalPages) collectBlockIds(page?.blocks, originalBlockList);
  for (const id of originalBlockList) originalBlockIds.add(id);

  const copyBlockList: string[] = [];
  for (const page of copies) collectBlockIds(page?.blocks, copyBlockList);
  const blockCounts = new Map<string, number>();
  for (const id of copyBlockList) blockCounts.set(id, (blockCounts.get(id) ?? 0) + 1);
  for (const [id, count] of blockCounts) {
    if (count > 1) errors.push(`duplicate block id: ${id}`);
    if (originalBlockIds.has(id)) errors.push(`block id reused from original: ${id}`);
  }

  return { ok: errors.length === 0, errors };
}
