"use client";

import { useMemo, useState } from "react";
import { AlertCircle, History, RefreshCw } from "lucide-react";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { stableTime } from "@/lib/time";
import type { TagHue } from "@/lib/design-tokens";
import {
  filterAuditEvents,
  groupAuditByDay,
  type AuditEvent,
  type AuditFilter,
} from "@/lib/audit-log";
import { diffObjects, isEmptyDiff, summarizeDiff } from "@/lib/audit-diff";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Tag } from "@/components/ui/tag";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";

/**
 * Fetch the window of events strictly after `cursor`, or an error string.
 * Supplied by the server page so the feed stays a single server/client split and
 * the client never imports the Prisma-backed `getActivityPage` itself.
 */
export type AuditPageLoader = (input: { cursor: string }) => Promise<
  { ok: true; events: AuditEvent[]; nextCursor: string | null } | { error: string }
>;

/* -------------------------------------------------------------------------- *
 * Pure row mapping — colours, labels and clocks
 * -------------------------------------------------------------------------- */

/** Verb for a dotted action's final segment, with the audit vocabulary expanded. */
const VERB_LABELS: Record<string, string> = {
  created: "created",
  updated: "updated",
  deleted: "deleted",
  archived: "archived",
  restored: "restored",
  resolved: "resolved",
  reopened: "reopened",
  shared: "shared",
  unshared: "unshared",
  moved: "moved",
  duplicated: "duplicated",
  role_changed: "changed the role of",
  ownership_transferred: "transferred ownership of",
  left: "left",
  removed: "removed",
  invited: "invited",
};

/** The verb label for an action type: last dotted segment, label-expanded. */
export function auditActionLabel(type: string): string {
  const cut = type.lastIndexOf(".");
  const segment = cut === -1 ? type : type.slice(cut + 1);
  return VERB_LABELS[segment] ?? segment.replace(/_/g, " ");
}

const DESTRUCTIVE = new Set(["deleted", "removed", "archived", "left", "trashed"]);
const CREATING = new Set(["created", "restored", "resolved"]);

/** Final dotted segment of an action type. */
function actionSegment(type: string): string {
  const cut = type.lastIndexOf(".");
  return cut === -1 ? type : type.slice(cut + 1);
}

/**
 * Severity tone for an action: destructive verbs read `danger`, creating verbs
 * `success`, mutating verbs `accent`, everything else `neutral`.
 */
export function auditBadgeTone(type: string): BadgeTone {
  const segment = actionSegment(type);
  if (DESTRUCTIVE.has(segment)) return "danger";
  if (CREATING.has(segment)) return "success";
  if (segment === "updated" || segment === "moved" || segment === "duplicated") {
    return "accent";
  }
  if (segment === "reopened" || segment === "unshared") return "warning";
  if (
    segment === "shared" ||
    segment === "invited" ||
    segment === "role_changed" ||
    segment === "ownership_transferred"
  ) {
    return "accent";
  }
  return "neutral";
}

/** Tag-palette hue per entity kind (docs/DESIGN_SYSTEM.md §2 "Tags"). */
export const CATEGORY_HUE: Readonly<Record<string, TagHue>> = {
  page: "blue",
  comment: "purple",
  member: "teal",
  workspace: "brown",
  ticket: "orange",
  database: "green",
  widget: "pink",
};

/** Hue for an entity kind, falling back to `gray` for anything uncatalogued. */
export function auditCategoryHue(entityType: string): TagHue {
  return CATEGORY_HUE[entityType] ?? "gray";
}

/** Display target for a row: the meta title/name if present, else the entity id. */
export function auditTarget(event: AuditEvent): string {
  const meta = event.meta;
  if (meta !== undefined) {
    for (const key of ["title", "name"] as const) {
      const value = meta[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return event.entityId;
}

/**
 * Relative time for a row, computed against the server-pinned `now`: `just now`,
 * `5m ago`, `3h ago`, `2d ago`, and an absolute short date beyond a week. Pure
 * and deterministic, so server render and hydration agree.
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, now - then);
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return stableTime(iso, "date");
}

/** Dot ink per severity tone, so the timeline marker mirrors the badge. */
const DOT_TONE: Record<BadgeTone, string> = {
  neutral: "bg-muted",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/**
 * A one-line "which fields changed" summary when the event meta carries the
 * `before`/`after` pair the audit-diff helper understands; `null` otherwise.
 */
function changeSummary(event: AuditEvent): string | null {
  const meta = event.meta;
  if (meta === undefined || !("before" in meta) || !("after" in meta)) return null;
  const entries = diffObjects(meta.before, meta.after);
  return isEmptyDiff(entries) ? null : summarizeDiff(entries);
}

/* -------------------------------------------------------------------------- *
 * Row
 * -------------------------------------------------------------------------- */

/** One audit row: avatar + action badge + category tag + target + relative time. */
function AuditRow({ event, now }: { event: AuditEvent; now: number }) {
  const tone = auditBadgeTone(event.type);
  const hue = auditCategoryHue(event.entityType);
  const action = auditActionLabel(event.type);
  const target = auditTarget(event);
  const change = changeSummary(event);

  return (
    <li className="relative ps-6">
      {/* Timeline marker sitting on the group's indent guide. */}
      <span
        aria-hidden
        data-timeline-dot
        className={cn(
          "absolute -start-1 top-4 size-2 rounded-full ring-2 ring-bg",
          DOT_TONE[tone],
        )}
      />
      <div className="u-colors flex items-start gap-3 rounded-sm px-2 py-2 hover:bg-surface-2">
        <Avatar user={{ id: event.actorId, name: event.actorId }} size={24} alt={event.actorId} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={tone} size="sm">
              {action}
            </Badge>
            <Tag hue={hue} size="sm" dot>
              {event.entityType}
            </Tag>
            <time
              dateTime={event.createdAt}
              title={stableTime(event.createdAt, "datetime")}
              className="ms-auto shrink-0 text-xs text-muted"
            >
              {relativeTime(event.createdAt, now)}
            </time>
          </span>
          <span className="mt-0.5 block truncate text-sm text-fg" title={target}>
            {target}
          </span>
          {change && (
            <span className="mt-0.5 block truncate text-xs text-muted" title={change}>
              {change}
            </span>
          )}
        </span>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- *
 * States — loading / empty / error
 * -------------------------------------------------------------------------- */

/** Skeleton matching the final row layout (no shift when the data lands). */
function AuditFeedSkeleton({ locale }: { locale: string }) {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-live="polite">
      {[0, 1].map((group) => (
        <section key={group} className="flex flex-col gap-2">
          <Skeleton variant="block" className="h-4 w-24" />
          <ul className="border-s border-border">
            {[0, 1, 2].map((row) => (
              <li key={row} className="relative ps-6">
                <span
                  aria-hidden
                  className="absolute -start-1 top-4 size-2 rounded-full bg-surface-3"
                />
                <div className="flex items-start gap-3 px-2 py-2">
                  <Skeleton variant="circle" width={24} height={24} />
                  <div className="min-w-0 flex-1">
                    <Skeleton variant="text" lines={2} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <span className="sr-only">{t(locale, "loading")}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Feed
 * -------------------------------------------------------------------------- */

/**
 * The audit feed body with a keyset "Load more".
 *
 * The first window arrives already server-rendered; each click appends the next
 * `getActivityPage` window to the same client list, then re-applies the active
 * filter and re-groups by UTC day, so a day that spans a page boundary stays a
 * single section. `now` is pinned by the server so the "Today"/"Yesterday"
 * labels — and every relative row clock — are identical on the server render and
 * after hydration.
 *
 * Quick filter chips (one row per axis, derived from the loaded events) narrow
 * that same list client-side on top of the server `filter` prop, and a "Clear"
 * control drops both axes; grouping and "Load more" are untouched, so appended
 * pages flow straight into the refined view.
 *
 * States (docs/DESIGN_SYSTEM.md §8): `loading` (a skeleton matching the rows),
 * `empty` (an actionable empty state) and `error` (a message + retry), plus the
 * populated timeline.
 */
export function AuditFeed({
  initialEvents,
  filter,
  nextCursor,
  now,
  locale,
  loadMore,
  loading = false,
}: {
  initialEvents: AuditEvent[];
  filter: AuditFilter;
  nextCursor: string | null;
  /** Server clock (epoch ms) used for the day-bucket labels and row clocks. */
  now: number;
  locale: string;
  loadMore: AuditPageLoader;
  /** Renders the skeleton instead of the feed (additive). */
  loading?: boolean;
}) {
  const { run, pending, error } = useAction(locale);
  const [events, setEvents] = useState<AuditEvent[]>(initialEvents);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  // Quick client-side refinements layered over the server-rendered `filter` (the
  // page derives that one from its URL params). Each axis is a single-select
  // toggle; `null` means "no extra narrowing". A chip never reaches the server —
  // `loadMore` keeps paging under the URL filter — so it narrows the already
  // loaded window (the first page plus every appended one) and "Load more" fills
  // the refined view as it arrives.
  const [actorId, setActorId] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);

  const activeFilter = useMemo<AuditFilter>(
    () => ({
      ...filter,
      ...(actorId === null ? {} : { actorIds: [actorId] }),
      ...(type === null ? {} : { types: [type] }),
    }),
    [filter, actorId, type],
  );

  // Options come from every loaded event, not the refined view, so a chip never
  // vanishes (stranding the selection) the instant it is applied.
  const actorOptions = useMemo(
    () => [...new Set(events.map((event) => event.actorId))].sort(),
    [events],
  );
  const typeOptions = useMemo(
    () => [...new Set(events.map((event) => event.type))].sort(),
    [events],
  );
  const refined = actorId !== null || type !== null;

  const groups = useMemo(
    () => groupAuditByDay(filterAuditEvents(events, activeFilter), now),
    [events, activeFilter, now],
  );

  const onLoadMore = () =>
    run(
      () => loadMore({ cursor: cursor ?? "" }),
      {
        onSuccess: (result) => {
          if ("error" in result) return;
          setEvents((current) => [...current, ...result.events]);
          setCursor(result.nextCursor);
        },
      },
    );

  const clearRefinements = () => {
    setActorId(null);
    setType(null);
  };

  if (loading) return <AuditFeedSkeleton locale={locale} />;

  return (
    <div className="flex flex-col gap-8">
      {(actorOptions.length > 1 || typeOptions.length > 1) && (
        <div
          role="group"
          aria-label={t(locale, "filter")}
          className="flex flex-wrap items-center gap-x-3 gap-y-2"
        >
          {actorOptions.length > 1 && (
            <div
              role="group"
              aria-label={t(locale, "member")}
              className="flex flex-wrap items-center gap-2"
            >
              {actorOptions.map((option) => {
                const active = actorId === option;
                return (
                  <Tag
                    key={option}
                    hue="gray"
                    size="sm"
                    selected={active}
                    onSelectedChange={() => setActorId(active ? null : option)}
                  >
                    {option}
                  </Tag>
                );
              })}
            </div>
          )}

          {typeOptions.length > 1 && (
            <div role="group" aria-label={t(locale, "actionsGroup")} className="flex flex-wrap items-center gap-2">
              {typeOptions.map((option) => {
                const active = type === option;
                return (
                  <Tag
                    key={option}
                    hue={auditCategoryHue(option.split(".")[0] ?? option)}
                    size="sm"
                    selected={active}
                    onSelectedChange={() => setType(active ? null : option)}
                  >
                    {auditActionLabel(option)}
                  </Tag>
                );
              })}
            </div>
          )}

          {refined && (
            <Button type="button" variant="ghost" size="xs" onClick={clearRefinements}>
              Clear
            </Button>
          )}
        </div>
      )}

      {groups.length === 0 ? (
        <EmptyState
          variant="full"
          icon={<History />}
          title={t(locale, "noResults")}
          description="No audit events match the current filter."
          primaryAction={
            refined ? (
              <Button type="button" variant="secondary" size="sm" onClick={clearRefinements}>
                Clear filters
              </Button>
            ) : cursor !== null ? (
              <Button type="button" size="sm" loading={pending} onClick={onLoadMore}>
                {t(locale, "loadMore")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        groups.map((group) => (
          <section key={group.day} className="flex flex-col gap-2">
            <h2 className="flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-muted">
              <span>{group.label}</span>
              <Badge tone="neutral" size="sm" count={group.count} />
            </h2>
            <ul className="border-s border-border">
              {group.events.map((event) => (
                <AuditRow key={event.id} event={event} now={now} />
              ))}
            </ul>
          </section>
        ))
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{error}</span>
          {cursor !== null && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={pending}
              leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={onLoadMore}
            >
              {t(locale, "retry")}
            </Button>
          )}
        </div>
      )}

      {cursor !== null && groups.length > 0 && (
        <div>
          <Button type="button" variant="secondary" size="sm" loading={pending} onClick={onLoadMore}>
            {t(locale, "loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
