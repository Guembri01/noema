"use client";

import { useMemo, useState } from "react";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import {
  describeAuditEvent,
  filterAuditEvents,
  groupAuditByDay,
  type AuditEvent,
  type AuditFilter,
} from "@/lib/audit-log";
import { diffObjects, isEmptyDiff, summarizeDiff } from "@/lib/audit-diff";
import { LocalTime } from "@/components/local-time";
import { cn } from "@/lib/utils";

/**
 * Fetch the window of events strictly after `cursor`, or an error string.
 * Supplied by the server page so the feed stays a single server/client split and
 * the client never imports the Prisma-backed `getActivityPage` itself.
 */
export type AuditPageLoader = (input: { cursor: string }) => Promise<
  { ok: true; events: AuditEvent[]; nextCursor: string | null } | { error: string }
>;

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

/**
 * The audit feed body with a keyset "Load more".
 *
 * The first window arrives already server-rendered; each click appends the next
 * `getActivityPage` window to the same client list, then re-applies the active
 * filter and re-groups by UTC day, so a day that spans a page boundary stays a
 * single section. `now` is pinned by the server so the "Today"/"Yesterday"
 * labels are identical on the server render and after hydration.
 *
 * Quick filter chips (one row per axis, derived from the loaded events) narrow
 * that same list client-side on top of the server `filter` prop, and a "Clear"
 * control drops both axes; grouping and "Load more" are untouched, so appended
 * pages flow straight into the refined view.
 */
export function AuditFeed({
  initialEvents,
  filter,
  nextCursor,
  now,
  locale,
  loadMore,
}: {
  initialEvents: AuditEvent[];
  filter: AuditFilter;
  nextCursor: string | null;
  /** Server clock (epoch ms) used for the day-bucket labels. */
  now: number;
  locale: string;
  loadMore: AuditPageLoader;
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
                  <button
                    key={option}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setActorId(active ? null : option)}
                    className={cn(
                      "h-7 rounded-full border px-3 text-xs font-medium transition",
                      active
                        ? "border-accent bg-accent/15 text-fg"
                        : "border-border text-muted hover:bg-surface-2 hover:text-fg",
                    )}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          )}

          {typeOptions.length > 1 && (
            <div role="group" aria-label="Action" className="flex flex-wrap items-center gap-2">
              {typeOptions.map((option) => {
                const active = type === option;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setType(active ? null : option)}
                    className={cn(
                      "h-7 rounded-full border px-3 text-xs font-medium transition",
                      active
                        ? "border-accent bg-accent/15 text-fg"
                        : "border-border text-muted hover:bg-surface-2 hover:text-fg",
                    )}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          )}

          {refined && (
            <button
              type="button"
              onClick={() => {
                setActorId(null);
                setType(null);
              }}
              className="h-7 rounded-full px-3 text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {groups.length === 0 ? (
        <p className="text-sm text-muted">{t(locale, "noResults")}</p>
      ) : (
        groups.map((group) => (
          <section key={group.day}>
            <h2 className="mb-3 flex items-baseline justify-between text-sm font-medium uppercase tracking-wide text-muted">
              <span>{group.label}</span>
              <span className="text-xs normal-case">{group.count}</span>
            </h2>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {group.events.map((event) => {
                const change = changeSummary(event);
                return (
                  <li key={event.id} className="flex items-start gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block">{describeAuditEvent(event)}</span>
                      {change && <span className="mt-0.5 block text-xs text-muted">{change}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      <LocalTime value={event.createdAt} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      {cursor !== null && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={onLoadMore}
            className="inline-flex h-9 items-center rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
          >
            {t(locale, "loadMore")}
          </button>
          {error && (
            <span role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
