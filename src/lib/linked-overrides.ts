/**
 * In-block filter editing for a linked-database instance (R89.14/R89.15).
 *
 * The persisted `ViewConfig` has three filter shapes: the legacy flat
 * `filters`, the flat `filterTree`, and the richer AND/OR `filterBuilder` that
 * wins over both. A linked instance in `detached` mode needs to override
 * whatever the source view stored without losing the source's other settings.
 * These helpers therefore always operate on a `filterBuilder` root: the first
 * edit seeds a root from the effective config (builder, then tree, then flat
 * filters), and every later edit works on that root.
 *
 * Pure and immutable: no React, no Prisma, no clock. `makeLeaf` is the only
 * place that mints ids, and callers persist the resulting ids in the node's
 * `overrides` attribute.
 */

import {
  normalizeViewConfig,
  type Filter,
  type FilterNode as QueryFilterNode,
  type ViewConfig,
} from "./database-query";
import {
  isGroup,
  isLeaf,
  makeGroup,
  makeLeaf,
  type FilterGroup,
  type FilterLeaf,
  type FilterNode,
} from "./filter-tree-ui";

/** Every leaf below a builder root, in document order. */
export function filterLeaves(tree: FilterGroup): FilterLeaf[] {
  const out: FilterLeaf[] = [];
  const walk = (nodes: readonly FilterNode[]) => {
    for (const node of nodes) {
      if (isGroup(node)) walk(node.children);
      else out.push(node);
    }
  };
  walk(tree.children);
  return out;
}

function idFor(path: string): string {
  return `linked-${path}`;
}

function leafFromQuery(filter: Filter, path: string): FilterLeaf {
  return makeLeaf({
    propertyId: filter.propertyId,
    op: filter.operator,
    ...(filter.value === undefined ? {} : { value: filter.value }),
    id: idFor(path),
  });
}

function nodeFromQuery(node: QueryFilterNode, path: string): FilterNode | null {
  if ("and" in node) {
    return makeGroup(
      "and",
      node.and
        .map((child, index) => nodeFromQuery(child, `${path}-and-${index}`))
        .filter((child): child is FilterNode => child !== null),
      idFor(path),
    );
  }
  if ("or" in node) {
    return makeGroup(
      "or",
      node.or
        .map((child, index) => nodeFromQuery(child, `${path}-or-${index}`))
        .filter((child): child is FilterNode => child !== null),
      idFor(path),
    );
  }
  if (typeof node.propertyId !== "string" || node.propertyId === "") return null;
  return leafFromQuery(node, path);
}

/** Build the editable filter root from a normalized effective view config. */
export function filterBuilderFromConfig(
  config: ViewConfig | null | undefined,
): FilterGroup {
  const effective = normalizeViewConfig(config ?? {});
  if (effective.filterBuilder) return effective.filterBuilder;
  if (effective.filterTree) {
    return makeGroup(
      effective.filterMode ?? "and",
      effective.filterTree
        .map((node, index) => nodeFromQuery(node, `tree-${index}`))
        .filter((node): node is FilterNode => node !== null),
      "linked-root",
    );
  }
  return makeGroup(
    effective.filterMode ?? "and",
    (effective.filters ?? []).map((filter, index) =>
      leafFromQuery(filter, `flat-${index}`),
    ),
    "linked-root",
  );
}

/** Append a leaf to the root. The source's nested groups are preserved. */
export function addFilterLeaf(
  tree: FilterGroup,
  filter: { propertyId: string; op: FilterLeaf["op"]; value?: string },
): FilterGroup {
  return {
    ...tree,
    children: [
      ...tree.children,
      makeLeaf({
        propertyId: filter.propertyId,
        op: filter.op,
        ...(filter.value === undefined ? {} : { value: filter.value }),
      }),
    ],
  };
}

/** Update one leaf anywhere in the tree, keeping the node identity. */
export function updateFilterLeaf(
  tree: FilterGroup,
  id: string,
  patch: Partial<Pick<FilterLeaf, "propertyId" | "op" | "value">>,
): FilterGroup {
  const walk = (node: FilterNode): FilterNode => {
    if (isLeaf(node)) return node.id === id ? { ...node, ...patch } : node;
    return {
      ...node,
      children: node.children.map(walk),
    };
  };
  return { ...tree, children: tree.children.map(walk) };
}

/** Remove one leaf anywhere in the tree (nested groups stay otherwise). */
export function removeFilterLeaf(
  tree: FilterGroup,
  id: string,
): FilterGroup {
  const walk = (node: FilterNode): FilterNode => {
    if (isLeaf(node)) return node;
    return {
      ...node,
      children: node.children.map(walk).filter((child) => !(isLeaf(child) && child.id === id)),
    };
  };
  return { ...tree, children: tree.children.map(walk) };
}

/** Change the root conjunction (the nested groups keep their own). */
export function setFilterMatch(
  tree: FilterGroup,
  op: "and" | "or",
): FilterGroup {
  return { ...tree, op };
}

/**
 * Remove every row-selection override. The caller keeps display overrides such
 * as `visiblePropertyIds`; this only resets filters and sorts.
 */
export function clearFilterAndSortOverrides(
  overrides: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const next = { ...overrides };
  for (const key of ["filters", "filterMode", "filterTree", "filterBuilder", "sorts"]) {
    delete next[key];
  }
  return next;
}

/**
 * Type-only guard kept next to the helpers: `ViewConfig` accepts the builder,
 * and the linked override store is a partial view config. This makes an
 * accidental cast to a non-builder shape a type error at the call site.
 */
export type LinkedFilterOverride = NonNullable<ViewConfig["filterBuilder"]>;

/** A property shape the operator picker needs (kept local to avoid a UI import). */
export type FilterProperty = { id: string; type: string };

/** Guard used by the editor before it reads a property id from a persisted leaf. */
export function filterProperty(
  properties: readonly FilterProperty[],
  propertyId: string,
): FilterProperty | null {
  return properties.find((property) => property.id === propertyId) ?? null;
}


