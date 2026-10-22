/**
 * Gallery layout for the database surface.
 *
 * Extracted from ./view-renderers; the public import path stays stable through
 * that module's re-export. Cover/preview resolution and card sizing live here.
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
import {
  flattenLayout,
  parsePropertyLayout as parseLegacyPropertyLayout,
} from "@/lib/property-layout";
import {
  resolveLayout as resolvePropertyPlacements,
  type PropertyPlacement,
} from "@/lib/property-layout-engine";
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

export { TableView } from "./table-view";

export { ListView } from "./list-view";

export function PropertyPanel({
  properties,
  layout,
  values,
  computedFor,
}: {
  properties: DBProperty[];
  /** Persisted legacy `PropertyLayout` (array-of-columns JSON) — untrusted. */
  layout?: unknown;
  /** Resolve a property's stored value. */
  values: (propertyId: string) => unknown;
  /** Optional computed display that wins over the stored value. */
  computedFor?: (property: DBProperty) => string | undefined;
}) {
  const placements = propertyPlacements(layout, properties);
  const hasSecondColumn = placements.some((placement) => placement.column === 1);
  const byId = new Map(properties.map((property) => [property.id, property]));
  return (
    <div
      data-testid="property-panel"
      className="grid gap-x-6 gap-y-2"
      style={{ gridTemplateColumns: `repeat(${hasSecondColumn ? 2 : 1}, minmax(0, 1fr))` }}
    >
      {placements.map((placement) => {
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
            className="flex items-center justify-between gap-2 text-sm"
            style={placement.span === 2 ? { gridColumn: "1 / -1" } : undefined}
          >
            <span className="truncate text-muted">{property.name}</span>
            <span className="truncate">{displayed || "—"}</span>
          </div>
        );
      })}
    </div>
  );
}

/** WIP badge colours keyed by `checkWip`'s grade (all from the token set). */
const WIP_STYLES: Record<WipStatus, string> = {
  ok: "bg-surface-2 text-muted",
  at: "bg-warning-soft text-warning",
  over: "bg-danger-soft text-danger",
};

/**
 * Functions a grouped view reports per group, in display order. `sum`/`average`
 * only mean something for numeric cells and fall back to the lib's "—" sentinel
 * when a group holds none; `countValues` counts non-empty cells (rollup's
 * "count" semantics) so it differs from the plain row count beside the header.
 */
const GROUP_SUMMARY_FNS: readonly AggregationFn[] = ["sum", "average", "countValues"];

/** One formatted aggregation in a group's summary line. */
export { BoardView } from "./board-view";

function isPlainConfig(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A gallery card's resolved preview plus whether the engine path is active. */
export type GalleryPreviewPlan = {
  /** True when the view carries a usable preview config. */
  active: boolean;
  /** The canonical config handed to `resolveCardPreview`. */
  config: PreviewConfig;
};

/**
 * Map a gallery view's persisted preview config onto `@/lib/gallery-preview`'s
 * `PreviewConfig`. The persisted `previewPropertyId` (the settings popover's
 * cover choice) becomes the engine's `coverPropertyId`, and any richer
 * `previewConfig` object is parsed (`parsePreviewConfig`) so malformed stored
 * JSON falls back to the engine defaults instead of throwing.
 *
 * `active` is false only when the view has no preview config at all, so an
 * unconfigured gallery keeps rendering through `@/lib/view-presets`.
 */
export function galleryPreviewPlan(
  previewPropertyId: string | null | undefined,
  previewConfig?: unknown,
): GalleryPreviewPlan {
  const base = isPlainConfig(previewConfig) ? previewConfig : {};
  const withCover = previewPropertyId
    ? { ...base, coverPropertyId: previewPropertyId }
    : base;
  const parsed = parsePreviewConfig(withCover);
  // A malformed richer config must not lose an otherwise valid cover choice.
  const config: PreviewConfig = parsed.ok
    ? parsed.config
    : {
        fit: "cover",
        ...(previewPropertyId ? { coverPropertyId: previewPropertyId } : {}),
      };
  const active = Boolean(
    config.coverPropertyId ||
      config.contentPropertyId ||
      (config.showProperties && config.showProperties.length > 0),
  );
  return { active, config };
}

/**
 * Resolve one card through the gallery-preview engine. Kept as a named helper
 * so the config ⇄ engine mapping is testable without rendering the component.
 */
export function resolveGalleryCard(
  row: DBRow,
  plan: GalleryPreviewPlan,
  properties: readonly GalleryPropertyLike[],
): ResolvedCardPreview {
  return resolveGalleryPreview(row, plan.config, { properties });
}

export function GalleryView({
  locale,
  workspaceSlug,
  properties,
  rows,
  primary,
  valueFor,
  computedFor,
  cardSize: cardSizeProp,
  previewPropertyId,
  previewConfig,
  loading = false,
  onAddRow,
}: {
  locale: string;
  workspaceSlug: string;
  properties: DBProperty[];
  rows: DBRow[];
  primary: DBProperty | null;
  valueFor: (row: DBRow, propertyId: string) => unknown;
  computedFor?: (row: DBRow, property: DBProperty) => string | undefined;
  /** Force a card size; without it the size follows the container width. */
  cardSize?: CardSizeName;
  /**
   * The property each card draws its preview image from (the persisted gallery
   * setting). Mapped onto `@/lib/gallery-preview`'s `coverPropertyId`; the
   * engine then resolves the cover, the text excerpt and the badge strip. Unset
   * or blank with no `previewConfig` keeps the previous `@/lib/view-presets`
   * card, so an unconfigured gallery renders exactly as it did before.
   */
  previewPropertyId?: string | null;
  /**
   * The full persisted gallery preview config (`coverPropertyId`,
   * `contentPropertyId`, `fit`, `aspect`, `showTitle`, `showProperties`) when a
   * caller carries one. Untrusted JSON; `galleryPreviewPlan` parses it and
   * `previewPropertyId` overrides its cover.
   */
  previewConfig?: unknown;
  /** Render skeleton cards (matching the final grid) instead of rows. */
  loading?: boolean;
  /** Empty-state primary action; absent renders the hint without a button. */
  onAddRow?: () => void;
}) {
  // The card size tracks the container: `cardSizeFor` maps a measured width to
  // a preset, and `CARD_SIZES` supplies the column count, aspect and whether
  // the cover is shown. Initial width is 0 (the densest preset) so server and
  // client render identically until the observer reports the real width.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const size = cardSizeProp ?? cardSizeFor(containerWidth);
  const spec = CARD_SIZES[size];

  // The preset engine reads lower-case property types (e.g. "files"), matching
  // `COVER_PROPERTY_TYPES`; `DatabaseView` stores them upper-case.
  const presetProperties = properties.map((property) => ({
    id: property.id,
    name: property.name,
    type: property.type.toLowerCase(),
  }));
  // The persisted preview choice wins; unset or blank keeps the automatic
  // cover — the first cover-eligible (FILES/MEDIA/URL) property, matching
  // `resolveCardPreview` — so a gallery without a stored choice only changes
  // when the schema itself does. `coverPropertyId` is the single source for
  // both the preview and the field that must not be repeated below.
  const coverPropertyId =
    previewPropertyId ||
    properties.find((property) =>
      (COVER_PROPERTY_TYPES as readonly string[]).includes(
        property.type.toLowerCase(),
      ),
    )?.id ||
    null;
  // The gallery-preview engine (covers + excerpts + badges). Active only when a
  // persisted preview config exists; otherwise the legacy card below is used so
  // an unconfigured gallery is byte-for-byte unchanged. The primary/name
  // property is the card title, so it is never offered as a badge.
  const plan = galleryPreviewPlan(previewPropertyId, previewConfig);
  const previewProperties = presetProperties.filter(
    (property) => property.id !== primary?.id,
  );
  const fields = cardFieldOrder(
    // The primary/name property is the card title, so it is never listed twice.
    previewProperties,
    {
      previewPropertyId: coverPropertyId,
      maxFields: spec.showPreview ? 3 : 4,
    },
  )
    .map((id) => properties.find((property) => property.id === id))
    .filter((property): property is DBProperty => property !== undefined);

  if (loading) {
    return (
      <div
        data-testid="gallery-skeleton"
        aria-busy="true"
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: gallerySkeletonCards(size) }).map((_, index) => (
          <div
            key={index}
            className="overflow-hidden rounded-lg border border-border bg-bg"
          >
            {spec.showPreview && (
              <div className="notion-skeleton" style={{ aspectRatio: spec.aspect }} />
            )}
            <div className="space-y-2 p-3">
              <span className="notion-skeleton block h-3 w-3/4 rounded-sm" />
              <span className="notion-skeleton block h-3 w-1/2 rounded-sm" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        className="notion-empty rounded-lg border border-dashed border-border"
        data-testid="gallery-empty"
      >
        <span className="notion-empty-icon" aria-hidden="true">
          <Inbox className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-fg">{t(locale, "noCardsYet")}</p>
        <p className="text-xs">{t(locale, "dbNoRowsHint")}</p>
        {onAddRow && (
          <button
            type="button"
            data-testid="gallery-add-row"
            onClick={onAddRow}
            aria-label={t(locale, "newRow")}
            className="focus-ring u-interactive mt-1 inline-flex items-center gap-1 rounded-sm bg-accent px-3 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            {t(locale, "newRow")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="grid gap-4"
      style={{ gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))` }}
      data-card-size={size}
    >
      {rows.map((row) => {
        // Config present → resolve cover/excerpt/badges through the engine;
        // otherwise keep the legacy preset preview.
        const card = plan.active
          ? resolveGalleryCard(row, plan, previewProperties)
          : null;
        const preview = card
          ? null
          : resolveCardPreview(row, presetProperties, { coverPropertyId });
        return (
          <Link
            key={row.id}
            href={`/w/${workspaceSlug}/${row.id}`}
            className="group overflow-hidden rounded-lg border border-border bg-bg u-surface hover:bg-surface-2"
          >
            {spec.showPreview && (
              <div
                className="grid place-items-center overflow-hidden bg-surface text-3xl"
                style={{ aspectRatio: card?.cover?.aspect ?? spec.aspect }}
                data-testid="gallery-banner"
              >
                {card?.cover ? (
                  /* eslint-disable-next-line @next/next/no-img-element -- raw attachment URLs are not statically analysable for next/image */
                  <img
                    src={card.cover.url}
                    alt={row.title}
                    className="u-transform h-full w-full object-cover group-hover:scale-[1.02]"
                    style={{ objectFit: card.cover.fit }}
                  />
                ) : preview?.kind === "cover" ? (
                  /* eslint-disable-next-line @next/next/no-img-element -- raw attachment URLs are not statically analysable for next/image */
                  <img
                    src={preview.value}
                    alt={row.title}
                    className="u-transform h-full w-full object-cover group-hover:scale-[1.02]"
                  />
                ) : (
                  preview?.value ?? row.icon ?? "📄"
                )}
              </div>
            )}
            <div className="p-3">
              <p className="truncate text-sm font-medium">
                {!spec.showPreview && <span className="mr-1">{row.icon ?? "📄"}</span>}
                {row.title || t(locale, "untitled")}
              </p>
              {card?.excerpt && (
                <p
                  data-testid="gallery-excerpt"
                  className="mt-1 line-clamp-2 text-xs text-muted"
                >
                  {card.excerpt.text}
                </p>
              )}
              {card && card.badges.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1" data-testid="gallery-badges">
                  {card.badges.map((badge) => (
                    <span
                      key={badge.propertyId}
                      data-testid={`gallery-badge-${badge.propertyId}`}
                      className={tagClass(galleryBadgeHue(badge.propertyId))}
                    >
                      {badge.value}
                    </span>
                  ))}
                </div>
              )}
              {!card && (
                <dl className="mt-2 space-y-1">
                  {fields.map((property) => (
                    <div key={property.id} className="flex items-center justify-between gap-2 text-xs text-muted">
                      <dt className="truncate">{property.name}</dt>
                      <dd className="truncate">
                        {(computedFor?.(row, property) ||
                          formatCell(
                            valueFor(row, property.id),
                            property as unknown as QueryProperty,
                          )) || "—"}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Calendar view

   The month grid now lives in `./timeline-chart-views` as the multi-day
   `CalendarView`: each dated row is projected to a half-open `[start, end)`
   span and packed into non-overlapping lanes per week by the pure
   `@/lib/calendar-multiday` engine, so a multi-day event draws one bar across
   every day it touches instead of collapsing onto its start day. The prop
   surface is unchanged, so this renderer keeps its existing callers — it is
   re-exported here to avoid a duplicate implementation drifting from the one
   that is actually rendered.
   --------------------------------------------------------------------------- */

export { CalendarView } from "./timeline-chart-views";

/* ---------------------------------------------------------------------------
   Form view
   --------------------------------------------------------------------------- */

/** The resolved form plan the renderer consumes. */
