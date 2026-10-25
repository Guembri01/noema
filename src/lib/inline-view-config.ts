/**
 * Inline-database view configuration (docs/specs/database-deep.md §1 "Inline
 * database block — view config incomplete").
 *
 * A linked/inline block stores its own view choice on the node: the bound source
 * view, the presentation (table/list/board/gallery) and a bounded set of
 * `ViewConfig` overrides (visible properties, group-by, filters, sorts). This
 * module resolves those persisted attrs against the *current* source database so
 * a stale or foreign view can never crash or silently apply another view's
 * schema-dependent settings:
 *
 *  - a `sourceViewId` that no longer exists falls back to the source's first
 *    view and drops the instance overrides (they were authored against a view
 *    that is gone);
 *  - visible property ids are clamped to the live schema;
 *  - a group-by id must still name a groupable property;
 *  - sort keys for deleted properties are dropped.
 *
 * Pure: no Prisma, no React, no clock, no I/O. Inputs are never mutated.
 */

import {
  normalizeViewConfig,
  type Filter,
  type FilterNode,
  type Sort,
  type ViewConfig,
} from "@/lib/database-query";
import {
  createLinkedView,
  resolveViewConfig,
  type LinkedView,
  type LinkedViewMode,
  type LinkedViewOverrides,
} from "@/lib/linked-view";

/** Displays the inline block can actually render today. */
export const INLINE_SETTABLE_DISPLAYS = ["table", "list", "board", "gallery"] as const;

export type InlineSettableDisplay = (typeof INLINE_SETTABLE_DISPLAYS)[number];

export type InlineViewProperty = { id: string; name: string; type: string };

export type InlineSourceView = {
  id: string;
  name?: string;
  type: string;
  config?: unknown;
};

export type InlineViewInput = {
  instanceId: string;
  databaseId: string;
  views: readonly InlineSourceView[];
  properties: readonly InlineViewProperty[];
  sourceViewId?: string | null;
  mode?: string | null;
  display?: string | null;
  overrides?: unknown;
};

export type ResolvedInlineView = {
  /** Source view actually used (the first view when the bound id is stale). */
  sourceView: InlineSourceView | null;
  /** Normalized source view config, or `null` when the source has no views. */
  sourceConfig: ViewConfig | null;
  /** The bound id was non-empty and did not resolve against this database. */
  staleView: boolean;
  /** Presentation the block will render. */
  display: InlineSettableDisplay;
  linked: LinkedView;
  effective: ViewConfig;
  /** Effective visible ids, clamped to the live schema. */
  visiblePropertyIds: string[] | undefined;
  /** Effective group-by, only when it still names a groupable property. */
  groupByPropertyId: string | undefined;
};

const GROUPABLE_TYPES = new Set(["SELECT", "STATUS", "MULTI_SELECT"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function isSettableDisplay(value: unknown): value is InlineSettableDisplay {
  return (
    typeof value === "string" &&
    (INLINE_SETTABLE_DISPLAYS as readonly string[]).includes(value)
  );
}

/**
 * Map a source view type to the presentation this block can render. Non-grid
 * source types (calendar/timeline/chart/form) fall back to the gallery card
 * grid, matching the pre-configuration behaviour.
 */
export function inlineDisplayForViewType(value: string | null | undefined): InlineSettableDisplay {
  switch ((value ?? "").toUpperCase()) {
    case "TABLE":
      return "table";
    case "LIST":
      return "list";
    case "BOARD":
      return "board";
    case "GALLERY":
      return "gallery";
    default:
      return "gallery";
  }
}

function sanitizeFilter(node: FilterNode, known: Set<string>): FilterNode | null {
  if ("and" in node) {
    return {
      and: node.and
        .map((child) => sanitizeFilter(child, known))
        .filter((child): child is FilterNode => child !== null),
    };
  }
  if ("or" in node) {
    return {
      or: node.or
        .map((child) => sanitizeFilter(child, known))
        .filter((child): child is FilterNode => child !== null),
    };
  }
  return known.has(node.propertyId) ? node : null;
}

function sanitizeFilters(
  filters: readonly Filter[] | undefined,
  known: Set<string>,
): Filter[] | undefined {
  if (!Array.isArray(filters)) return undefined;
  const out = filters.filter((filter) => known.has(filter.propertyId));
  return out;
}

function sanitizeFilterTree(
  nodes: readonly FilterNode[] | undefined,
  known: Set<string>,
): FilterNode[] | undefined {
  if (!Array.isArray(nodes)) return undefined;
  return nodes
    .map((node) => sanitizeFilter(node, known))
    .filter((node): node is FilterNode => node !== null);
}

function sanitizeFilterBuilder(node: unknown, known: Set<string>): unknown {
  if (!isRecord(node)) return undefined;
  if (Array.isArray(node.children)) {
    const children = node.children
      .map((child) => sanitizeFilterBuilder(child, known))
      .filter((child) => child !== undefined);
    return { ...node, children };
  }
  return typeof node.propertyId === "string" && known.has(node.propertyId)
    ? node
    : undefined;
}

function sanitizeSorts(sorts: readonly Sort[] | undefined, known: Set<string>): Sort[] | undefined {
  if (!Array.isArray(sorts)) return undefined;
  return sorts.filter(
    (sort) =>
      isRecord(sort) &&
      typeof sort.propertyId === "string" &&
      known.has(sort.propertyId) &&
      (sort.direction === "asc" || sort.direction === "desc"),
  );
}

/**
 * Clamp the node's persisted overrides to the live schema. Unknown keys are
 * left for `resolveViewConfig`/`normalizeViewConfig` to drop. `staleView` makes
 * every schema-dependent override unusable, so it returns `{}`: the instance
 * falls back to the source view it can actually resolve.
 */
export function sanitizeInlineOverrides(
  overrides: unknown,
  properties: readonly InlineViewProperty[],
  options: { staleView?: boolean } = {},
): LinkedViewOverrides {
  if (options.staleView) return {};
  if (!isRecord(overrides)) return {};

  const known = new Set(properties.map((property) => property.id));
  const next: Record<string, unknown> = { ...overrides };

  if (Array.isArray(next.visiblePropertyIds)) {
    const requested = uniqueStrings(next.visiblePropertyIds);
    const valid = requested.filter((id) => known.has(id));
    // A non-empty list that resolves to nothing came from another schema: drop
    // it so the block falls back to the source view's columns rather than
    // showing only the primary property.
    if (requested.length > 0 && valid.length === 0) delete next.visiblePropertyIds;
    else next.visiblePropertyIds = valid;
  } else if (next.visiblePropertyIds !== undefined) {
    delete next.visiblePropertyIds;
  }

  if (typeof next.groupByPropertyId === "string") {
    const property = properties.find((candidate) => candidate.id === next.groupByPropertyId);
    if (!property || !GROUPABLE_TYPES.has(property.type.toUpperCase())) {
      delete next.groupByPropertyId;
    }
  } else if (next.groupByPropertyId !== undefined) {
    delete next.groupByPropertyId;
  }

  if (Array.isArray(next.sorts)) {
    const originalLength = next.sorts.length;
    const cleaned = sanitizeSorts(next.sorts as Sort[], known);
    if (originalLength > 0 && cleaned !== undefined && cleaned.length === 0) {
      delete next.sorts;
    } else {
      next.sorts = cleaned;
    }
  } else if (next.sorts !== undefined) {
    delete next.sorts;
  }

  if (Array.isArray(next.filters)) {
    const originalLength = next.filters.length;
    const cleaned = sanitizeFilters(next.filters as Filter[], known);
    if (originalLength > 0 && cleaned !== undefined && cleaned.length === 0) {
      delete next.filters;
    } else {
      next.filters = cleaned;
    }
  } else if (next.filters !== undefined) {
    delete next.filters;
  }

  if (Array.isArray(next.filterTree)) {
    const originalLength = next.filterTree.length;
    const cleaned = sanitizeFilterTree(next.filterTree as FilterNode[], known);
    if (originalLength > 0 && cleaned !== undefined && cleaned.length === 0) {
      delete next.filterTree;
    } else {
      next.filterTree = cleaned;
    }
  } else if (next.filterTree !== undefined) {
    delete next.filterTree;
  }

  if (next.filterBuilder !== undefined) {
    const builder = sanitizeFilterBuilder(next.filterBuilder, known);
    if (builder === undefined) delete next.filterBuilder;
    else next.filterBuilder = builder;
  }

  return next as LinkedViewOverrides;
}

/**
 * Resolve a node's persisted attrs against the source database. Never throws:
 * an empty `views` list yields an empty source config, the source's first view
 * is the fallback for a stale id, and every schema-dependent override is
 * clamped before it reaches a renderer.
 */
export function resolveInlineView(input: InlineViewInput): ResolvedInlineView {
  const instanceId =
    typeof input.instanceId === "string" && input.instanceId !== ""
      ? input.instanceId
      : "inline-database";
  const databaseId =
    typeof input.databaseId === "string" && input.databaseId !== ""
      ? input.databaseId
      : "unknown-database";
  const sourceViewId = typeof input.sourceViewId === "string" ? input.sourceViewId.trim() : "";
  const bound = sourceViewId
    ? (input.views.find((view) => view.id === sourceViewId) ?? null)
    : null;
  const staleView = sourceViewId !== "" && bound === null;
  const sourceView = bound ?? input.views[0] ?? null;

  const overrides = sanitizeInlineOverrides(input.overrides, input.properties, { staleView });
  const mode: LinkedViewMode = input.mode === "detached" ? "detached" : "synced";
  const linked = createLinkedView({
    instanceId,
    databaseId,
    ...(sourceView ? { sourceViewId: sourceView.id } : {}),
    mode,
  });
  linked.overrides = overrides;

  const sourceConfig = sourceView ? normalizeViewConfig(sourceView.config) : null;
  const effective = resolveViewConfig(sourceConfig, linked);
  const known = new Set(input.properties.map((property) => property.id));

  const visiblePropertyIds = effective.visiblePropertyIds?.filter((id) => known.has(id));
  const groupCandidate = effective.groupByPropertyId;
  const groupProperty =
    typeof groupCandidate === "string"
      ? input.properties.find((property) => property.id === groupCandidate)
      : undefined;
  const groupByPropertyId =
    groupProperty && GROUPABLE_TYPES.has(groupProperty.type.toUpperCase())
      ? groupProperty.id
      : undefined;

  const display = isSettableDisplay(input.display)
    ? input.display
    : inlineDisplayForViewType(sourceView?.type);

  return {
    sourceView,
    sourceConfig,
    staleView,
    display,
    linked,
    effective,
    visiblePropertyIds,
    groupByPropertyId,
  };
}

/** Selected visible ids for the settings UI (all properties when unset). */
export function visibleInlineProperties(
  properties: readonly InlineViewProperty[],
  effective: ViewConfig,
): string[] {
  const ids = effective.visiblePropertyIds;
  if (!Array.isArray(ids)) return properties.map((property) => property.id);
  const known = new Set(properties.map((property) => property.id));
  return uniqueStrings(ids).filter((id) => known.has(id));
}

/** Toggle one visible property immutably (never drops the primary id here). */
export function toggleVisibleProperty(
  selected: readonly string[],
  propertyId: string,
  checked: boolean,
): string[] {
  const set = new Set(uniqueStrings(selected));
  if (checked) set.add(propertyId);
  else set.delete(propertyId);
  return [...set];
}

/** Set or remove one override key immutably. */
export function setInlineOverride(
  overrides: Readonly<Record<string, unknown>>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...overrides };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}
