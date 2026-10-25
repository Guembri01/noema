/**
 * Page property layout adapter.
 *
 * Two persisted shapes exist in this codebase:
 *  - the older `@/lib/property-layout` array-of-columns JSON
 *    (`{ columns: [["title"], ["status", "owner"]] }`), and
 *  - the flat `@/lib/property-layout-engine` layout
 *    (`{ columns: 1 | 2, order: string[], spans?, dividers? }`).
 *
 * The engine is the model the panel renders and edits. This module is the
 * single reader that decides which shape a stored value is, normalises it
 * against the page schema (saved ids first, new properties appended), and can
 * resolve the responsive placements. It is pure and total: malformed JSON or an
 * object of the wrong shape degrades to "every property, one column" instead of
 * throwing.
 */

import {
  flattenLayout,
  parsePropertyLayout as parseLegacyPropertyLayout,
} from "@/lib/property-layout";
import {
  orderLayout,
  parsePropertyLayout as parseEnginePropertyLayout,
  resolveLayout,
  responsivePlan,
  type LayoutProperty,
  type PropertyLayout,
  type PropertyPlacement,
  type ResponsivePlan,
  type ResponsivePlanOptions,
} from "@/lib/property-layout-engine";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when a stored value is the flat engine shape. A legacy layout stores
 * `columns` as an array; the engine stores `1` or `2`. Anything else falls back
 * to the legacy parser, whose own normaliser tolerates junk.
 */
export function isEnginePropertyLayout(raw: unknown): boolean {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  return isRecord(parsed) && (parsed.columns === 1 || parsed.columns === 2);
}

/**
 * Convert either persisted shape into the engine model, then reconcile it with
 * the page schema. Saved ids keep their order; ids the schema gained are
 * appended in schema order, so a reorder control can reach every property
 * without the panel ever dropping one.
 */
export function propertyPanelLayout(
  raw: unknown,
  properties: readonly LayoutProperty[],
): PropertyLayout {
  if (isEnginePropertyLayout(raw)) {
    return orderLayout(parseEnginePropertyLayout(raw), { properties });
  }

  const knownIds = properties.map((property) => property.id);
  const legacy = parseLegacyPropertyLayout(raw, knownIds);
  return orderLayout(
    {
      columns: legacy.columns.length >= 2 ? 2 : 1,
      order: flattenLayout(legacy),
      spans: {},
      dividers: false,
    },
    { properties },
  );
}

/** A layout resolved for a viewport bucket, with its grid placements. */
export type PagePropertyPlan = {
  /** The saved layout before responsive collapsing (drives the layout control). */
  baseLayout: PropertyLayout;
  /** The layout actually rendered (column count may have collapsed to one). */
  layout: PropertyLayout;
  plan: ResponsivePlan;
  placements: PropertyPlacement[];
};

/**
 * Resolve the stored layout for a viewport and return both the effective
 * layout (column count may have collapsed to one) and the row-major placements
 * the panel renders. Collapsing preserves the full `order`, so a narrow render
 * never loses a property or its saved position.
 */
export function pagePropertyPlan(
  raw: unknown,
  properties: readonly LayoutProperty[],
  options: ResponsivePlanOptions,
): PagePropertyPlan {
  const layout = propertyPanelLayout(raw, properties);
  const plan = responsivePlan(layout, options);
  const effective: PropertyLayout =
    plan.columns === layout.columns ? layout : { ...layout, columns: plan.columns };
  return {
    baseLayout: layout,
    layout: effective,
    plan,
    placements: resolveLayout(effective, { properties }),
  };
}
