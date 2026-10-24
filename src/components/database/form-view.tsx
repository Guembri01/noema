/**
 * Form layout for the database surface.
 *
 * Extracted from ./view-renderers; the public import path stays stable through
 * that module's re-export. The resolved plan is pure; the renderer only maps
 * accepted answers back to the row-creation seam.
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

export type FormPlan = {
  /** Stored form schema with each field enriched from the live property. */
  schema: FormSchema;
  /** The visible (non-hidden) questions, in order. */
  fields: FormField[];
  /** Display metadata: title, description, submit label, success message. */
  meta: FormDescription;
};

export function resolveFormPlan(properties: DBProperty[], config: unknown): FormPlan {
  const parsed = parseFormSchema(config);
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const resolvedFields =
    parsed.fields.length > 0 ? parsed.fields : buildFormSchema(properties, config);
  const schema: FormSchema = {
    ...parsed,
    fields: resolvedFields.map((field) => {
      const property = propertyById.get(field.propertyId);
      if (!property) return field;
      return {
        ...field,
        type: property.type,
        config: (property.config ?? {}) as Record<string, unknown>,
      };
    }),
  };
  return {
    schema,
    fields: schema.fields.filter((field) => field.hidden !== true),
    meta: describeForm(schema),
  };
}

/**
 * Render a database as a respondent form.
 *
 * `resolveFormPlan` resolves the ordered questions from the stored form config
 * (`config.form`: a `FormSchema`, or the legacy `fieldIds` shape) plus the
 * live properties, so computed/system types are skipped and stale ids are
 * tolerated. Each question is edited with the existing `Cell` editor for its
 * property type, so the form can only offer answers the rest of the app
 * accepts. On submit, `validateSubmission` gates the answers with the same
 * rules a cell write uses and `toRowValues` maps an accepted submission to the
 * `{ propertyId, value }` cells a new row stores.
 *
 * `onSubmit` is the create-row seam: it receives those cells in field order and
 * the parent creates the row (the same `createRowAction` path the table's "+"
 * uses) and applies the values. Without it the form is render-only — the
 * questions show read-only and no submit is offered.
 */
export function FormView({
  locale,
  properties,
  config,
  onSubmit,
  loading = false,
}: {
  locale: string;
  properties: DBProperty[];
  /** Stored form configuration (`config.form`); every value is untrusted JSON. */
  config?: unknown;
  /**
   * Persist an accepted submission: receives the mapped property values for a
   * new row, in field order. Absent → the form renders read-only.
   */
  onSubmit?: (
    values: { propertyId: string; value: unknown }[],
  ) => void | Promise<{ ok: true } | { error: string }>;
  /** Render the loading skeleton (matching the final layout) instead of fields. */
  loading?: boolean;
}) {
  const { schema, fields, meta } = resolveFormPlan(properties, config);
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  // Pre-fill any stored field defaults so a fresh respondent starts where the
  // form config says; a form with no defaults is exactly as empty as before.
  const [answers, setAnswers] = useState<Record<string, unknown>>(() =>
    defaultAnswers(schema),
  );
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const editable = onSubmit !== undefined;

  if (loading) {
    return (
      <div
        data-testid="form-skeleton"
        aria-busy="true"
        className="mx-auto max-w-xl space-y-4 rounded-lg border border-border p-4"
      >
        {Array.from({ length: skeletonCount("form") }).map((_, index) => (
          <div key={index} className="space-y-2">
            <span className="notion-skeleton block h-3 w-24 rounded-sm" />
            <span className="notion-skeleton block h-9 w-full rounded-sm" />
          </div>
        ))}
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <div
        className="notion-empty mx-auto max-w-xl rounded-lg border border-dashed border-border"
        data-testid="form-empty"
      >
        <span className="notion-empty-icon" aria-hidden="true">
          <Inbox className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-fg">{t(locale, "dbNoRows")}</p>
        <p className="text-xs">{t(locale, "dbNoRowsHint")}</p>
      </div>
    );
  }

  const setAnswer = (propertyId: string, value: unknown) => {
    setAnswers((current) => {
      const next = { ...current };
      // A cleared editor (empty text/number) writes nothing, mirroring an
      // unanswered optional question; objects like `{ checked: false }` stay.
      if (value === undefined || value === null) delete next[propertyId];
      else next[propertyId] = value;
      return next;
    });
    // Editing a field clears its previous error so the form can be resubmitted.
    setIssues((current) =>
      current.some((issue) => issue.propertyId === propertyId)
        ? current.filter((issue) => issue.propertyId !== propertyId)
        : current,
    );
    setSubmitError(null);
  };

  const submit = () => {
    if (!onSubmit || pending) return;
    // Client-side validation through the same engine the server action uses,
    // so only an acceptable submission is handed to the create-row seam.
    const validation = validateSubmission(schema, answers);
    if (!validation.ok) {
      setIssues(validation.issues);
      return;
    }
    setIssues([]);
    setSubmitError(null);
    const values = toRowValues(schema, answers);
    const submitValues = onSubmit;
    // Promise.resolve() also turns a synchronous throw from an older parent
    // into the same error path, so the form never gets stuck in `pending`.
    setPending(true);
    void Promise.resolve()
      .then(async () => submitValues(values))
      .then((result) => {
        if (result && "error" in result) {
          setSubmitError(result.error);
          return;
        }
        setAnswers(defaultAnswers(schema));
        setSubmitted(true);
      })
      .catch(() => setSubmitError("Could not submit the form. Try again."))
      .finally(() => setPending(false));
  };

  // After a successful submit the form becomes a small confirmation with an
  // "Add another" button, so a respondent can log several rows in a row.
  if (submitted && editable) {
    return (
      <div
        data-testid="form-success"
        role="status"
        className="mx-auto max-w-xl space-y-3 rounded-lg border border-border p-6 text-center"
      >
        <p className="text-sm font-medium">{meta.successMessage}</p>
        <button
          type="button"
          data-testid="form-add-another"
          onClick={() => {
            setAnswers(defaultAnswers(schema));
            setSubmitted(false);
          }}
          aria-label={t(locale, "add")}
          className="focus-ring u-interactive rounded-control bg-action px-4 py-1.5 text-sm text-action-fg hover:opacity-90"
        >
          {t(locale, "add")}
        </button>
      </div>
    );
  }

  return (
    <form
      data-testid="form-view"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="mx-auto max-w-xl space-y-4 rounded-lg border border-border p-4"
    >
      {meta.title !== "" && (
        <h2 data-testid="form-title" className="text-base font-medium">
          {meta.title}
        </h2>
      )}
      {meta.description !== "" && <p className="text-sm text-muted">{meta.description}</p>}
      {fields.map((field) => {
        const property = propertyById.get(field.propertyId);
        if (!property) return null;
        const issue = issues.find((candidate) => candidate.propertyId === field.propertyId);
        return (
          <div key={field.propertyId} className="space-y-1">
            <div className="flex items-center gap-1 text-sm font-medium">
              <span>{field.label}</span>
              {field.required && (
                <span className="text-danger" aria-hidden="true">
                  *
                </span>
              )}
            </div>
            <div className="u-surface focus-within:outline-none rounded-control border-control bg-bg px-2 py-1.5 focus-within:border-[var(--ring)] focus-within:shadow-[var(--shadow-focus)]">
              <Cell
                locale={locale}
                property={property}
                value={answers[field.propertyId]}
                editable={editable}
                onChange={(value) => setAnswer(field.propertyId, value)}
              />
            </div>
            {issue && (
              <ul
                data-testid={`form-issue-${field.propertyId}`}
                className="space-y-0.5 text-xs text-danger"
              >
                {issue.errors.map((error) => (
                  <li key={error.code}>{error.message}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {submitError && (
        <p
          role="alert"
          data-testid="form-submit-error"
          className="text-sm text-danger"
        >
          {submitError}
        </p>
      )}
      {editable && (
        <button
          type="submit"
          data-testid="form-submit"
          aria-label={meta.submitLabel}
          disabled={pending}
          aria-busy={pending}
          className="focus-ring u-interactive rounded-control bg-action px-4 py-1.5 text-sm text-action-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? t(locale, "saving") : meta.submitLabel}
        </button>
      )}
    </form>
  );
}

/* ---------------------------------------------------------------------------
   View settings (filter / sort / group)
   --------------------------------------------------------------------------- */

