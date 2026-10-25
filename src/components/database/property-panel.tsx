/**
 * Read-only property panel for a database row.
 *
 * Extracted from ./view-renderers; the public import path stays stable through
 * that module's re-export.
 */
"use client";

import { Cell, PropertyHeader } from "./view-parts";
import { Fragment, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type RefObject } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  ChevronRight,
  ExternalLink,
  Inbox,
  LayoutTemplate,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { DUR, TAG_PALETTE, Z, tagClass, type TagHue } from "@/lib/design-tokens";
import {
  formatCell,
  hasStatusGroups,
  statusGroupColumns,
  visibleColumns,
  type QueryProperty,
  type QueryRow,
  type Sort,
  type ViewConfig,
} from "@/lib/database-query";
import { applySort, type SortSpec } from "@/lib/sort-compare";
import { groupRowsByProperty, visibleGroups as filterVisibleGroups } from "@/lib/board-groups";
import { buildSwimlanes, laneCounts } from "@/lib/board-swimlanes";
import { checkWip, type WipLimits, type WipStatus } from "@/lib/kanban-wip";
import { reorderRows, sortByOrder } from "@/lib/row-order";
import { reorderRowsAction } from "@/server/actions/database";
import { evaluateRowColors, type RowColorRule } from "@/lib/row-color-rules";
import {
  AGGREGATION_FUNCTIONS,
  aggregateGroups,
  type AggregateOptions,
  type AggregationFn,
  type GroupAggregationSpec,
} from "@/lib/aggregations";
import {
  CARD_SIZES,
  COVER_PROPERTY_TYPES,
  cardFieldOrder,
  cardSizeFor,
  densityOptions,
  listRowModel,
  resolveCardPreview,
  type CardSizeName,
  type ListDensity,
} from "@/lib/view-presets";
import { pagePropertyPlan } from "@/lib/page-property-layout";
import type { PropertyLayout } from "@/lib/property-layout-engine";
import { PropertyLayoutControl } from "./property-layout-control";
import {
  deleteColumn as deleteTableColumn,
  deleteRow as deleteTableRow,
  insertColumn as insertTableColumn,
  insertRow as insertTableRow,
  moveColumn as moveTableColumn,
  moveRow as moveTableRow,
} from "@/lib/table-ops";
import {
  indentItem,
  normalizeLevels,
  outdentItem,
  type ListItem,
} from "@/lib/list-ops";
import {
  captureAnchor,
  nearestVisibleIndex,
  restoreScrollTop,
} from "@/lib/scroll-anchor";
import {
  computeFooter,
  forGroup,
  parseFooterSpec,
  type FooterColumnResult,
  type FooterSpec,
} from "@/lib/footer-calculations";
import {
  parsePreviewConfig,
  resolveCardPreview as resolveGalleryPreview,
  type GalleryPropertyLike,
  type PreviewConfig,
  type ResolvedCardPreview,
} from "@/lib/gallery-preview";
import {
  buildFormSchema,
  defaultAnswers,
  describeForm,
  parseFormSchema,
  toRowValues,
  validateSubmission,
  type FormDescription,
  type FormField,
  type FormIssue,
  type FormSchema,
} from "@/lib/form-view";
import { optionEdge, optionInk, optionSurface, type DBProperty, type DBRow, type HeaderConfig } from "@/components/database/database-types";
import { shouldAnimateLayout, useFlipList } from "@/lib/layout-shift";
import {
  ROW_MOTION_MS,
  enteredIds,
  groupChevronClass,
  retainLeaving,
  rowIdsKey,
  rowMotionClass,
  rowMotionState,
  rowMotionStyle,
  sameIds,
  type RowMotionState,
} from "./group-motion";

import {
  TABLE_ROW_HEIGHTS,
  TABLE_ROW_HEIGHT_MODES,
  resolveTableRowHeight,
  tableRowHeight,
  tableRowCellClass,
  CARD_LIFT,
  boardCardClass,
  boardDropValue,
  galleryBadgeHue,
  SKELETON_COUNTS,
  skeletonCount,
  gallerySkeletonCards,
  listIndentGuides,
  collapsedListIds,
  moveTableRowIds,
  insertTableRowIds,
  deleteTableRowIds,
  moveTableColumnIds,
  insertTableColumnIds,
  deleteTableColumnIds,
  outlineItems,
  nextOutlineLevel,
  anchoredScrollTop,
  useScrollAnchor,
  legacyPropertyColumns,
  propertyPlacements,
  listRowHeight,
  orderRows,
  persistRowOrder,
  sortSpecsFor,
  sortRowsWith,
  tableFooterSpec,
  groupTableRows,
  useMotionEnabled,
  useRowPresence,
  type TableRowHeight,
  type TableFooterCalculation,
} from "./view-renderers-helpers";
export * from "./view-renderers-helpers";

export function PropertyPanel({
  properties,
  layout,
  values,
  computedFor,
  availableWidth,
  locale = "en",
  onLayoutChange,
}: {
  properties: DBProperty[];
  /** Persisted layout: legacy array-of-columns JSON or the flat engine shape. */
  layout?: unknown;
  /** Resolve a property's stored value. */
  values: (propertyId: string) => unknown;
  /** Optional computed display that wins over the stored value. */
  computedFor?: (property: DBProperty) => string | undefined;
  /** Usable width in pixels; omit to measure the panel and collapse if narrow. */
  availableWidth?: number;
  locale?: string;
  /** When provided, renders the single/two-column layout control. */
  onLayoutChange?: (layout: PropertyLayout) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | undefined>(undefined);

  useEffect(() => {
    const element = containerRef.current;
    if (
      availableWidth !== undefined ||
      !element ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      setMeasuredWidth(entries[0]?.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [availableWidth]);

  const width = availableWidth ?? measuredWidth;
  // A measured width overrides the bucket default, so the panel collapses at
  // the same 2 x LAYOUT_MIN_COLUMN_WIDTH boundary in any host. Before the first
  // measurement (SSR/first paint) the medium bucket keeps a saved two-column
  // layout two columns instead of flashing one.
  const effective = pagePropertyPlan(layout, properties, {
    widthBucket: width === undefined ? "medium" : "narrow",
    ...(width === undefined ? {} : { availableWidth: width }),
  });
  const columnCount = effective.plan.columns;
  const byId = new Map(properties.map((property) => [property.id, property]));
  return (
    <div ref={containerRef} data-testid="property-panel" data-columns={columnCount}>
      {onLayoutChange && (
        <PropertyLayoutControl
          layout={effective.baseLayout}
          properties={properties}
          locale={locale}
          disabled={false}
          className="mb-2 border-b border-border pb-2"
          onChange={onLayoutChange}
        />
      )}
      <div
        data-testid="property-panel-grid"
        data-columns={columnCount}
        data-collapsed={effective.plan.collapsed ? "true" : "false"}
        className="grid gap-x-6 gap-y-2"
        style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
      >
        {effective.placements.map((placement) => {
          const property = byId.get(placement.propertyId);
          if (!property) return null;
          const displayed =
            computedFor?.(property) ??
            formatCell(values(property.id), property as unknown as QueryProperty);
          return (
            <div
              key={placement.propertyId}
              data-testid={`property-${property.name}`}
              data-column={placement.column}
              data-row={placement.row}
              className={
                placement.column > 0 && columnCount === 2 && effective.layout.dividers
                  ? "flex items-center justify-between gap-2 border-l border-border pl-4 text-sm"
                  : "flex items-center justify-between gap-2 text-sm"
              }
              style={
                placement.span === 2 && columnCount === 2
                  ? { gridColumn: "1 / -1" }
                  : undefined
              }
            >
              <span className="truncate text-muted">{property.name}</span>
              <span className="truncate">{displayed || "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
