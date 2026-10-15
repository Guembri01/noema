import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import { getRecentActivity, getWorkspaceBySlug } from "@/server/queries";
import {
  SYSTEM_ACTOR_ID,
  describeAuditEvent,
  filterAuditEvents,
  groupAuditByDay,
  normalizeAuditEvent,
  sortAuditEvents,
  type AuditEvent,
  type AuditFilter,
} from "@/lib/audit-log";
import { diffObjects, isEmptyDiff, summarizeDiff } from "@/lib/audit-diff";
import { LocalTime } from "@/components/local-time";
import { t } from "@/lib/i18n";

export const metadata = { title: "Audit log" };

/** One row of `getRecentActivity`, named so the mapper below stays readable. */
type ActivityRow = Awaited<ReturnType<typeof getRecentActivity>>[number];

/** `YYYY-MM-DD`, the only shape a date input can hand back. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive lower bound (UTC midnight) for a `YYYY-MM-DD` day, or undefined. */
function dayStartIso(day: string | undefined): string | undefined {
  if (!day || !DAY_PATTERN.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) {
    return undefined;
  }
  return `${day}T00:00:00.000Z`;
}

/** Inclusive upper bound (UTC end of day) for a `YYYY-MM-DD` day, or undefined. */
function dayEndIso(day: string | undefined): string | undefined {
  if (!day || !DAY_PATTERN.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) {
    return undefined;
  }
  return `${day}T23:59:59.999Z`;
}

/**
 * Project a Prisma `Activity` row onto the audit feed's normalised shape. The
 * tolerant `normalizeAuditEvent` door (from the read-only `@/lib/audit-log`)
 * validates and coerces, returning `null` for a row the feed cannot render;
 * a missing relation actor becomes `SYSTEM_ACTOR_ID`, and a row without a
 * `targetId` falls back to its own id so it is never silently dropped.
 */
function toAuditEvent(row: ActivityRow): AuditEvent | null {
  return normalizeAuditEvent({
    id: row.id,
    actorId: row.actor?.id ?? SYSTEM_ACTOR_ID,
    type: row.action,
    entityId: row.targetId ?? row.id,
    entityType: row.targetType,
    createdAt: row.createdAt,
    meta: row.meta ?? undefined,
  });
}

/**
 * A one-line "which fields changed" summary when the activity meta carries the
 * pair the audit-diff helper understands; `null` for every event that does not.
 */
function changeSummary(event: AuditEvent): string | null {
  const meta = event.meta;
  if (meta === undefined || !("before" in meta) || !("after" in meta)) return null;
  const entries = diffObjects(meta.before, meta.after);
  return isEmptyDiff(entries) ? null : summarizeDiff(entries);
}

/**
 * Workspace-wide audit log: the same `Activity` feed the settings summary draws
 * from, filtered by actor/action/date and sectioned into UTC day buckets. The
 * query half is the pure `@/lib/audit-log` module; this page is only the thin
 * server shell (permission gate + URL filters) over it.
 */
export default async function AuditLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ actor?: string; type?: string; from?: string; to?: string }>;
}) {
  const { slug } = await params;
  const { actor, type, from, to } = await searchParams;
  const user = await requireUser();
  const locale = user.locale ?? "en";
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();
  // The audit trail is management data: never rendered for non-managers.
  if (!canManageMembers(access.role)) notFound();

  const rows = await getRecentActivity(workspace.id, 200);

  // One pass builds the normalised events and the id -> display-name map the
  // filter options and the "no name" case need.
  const actorNames = new Map<string, string>();
  const events: AuditEvent[] = [];
  for (const row of rows) {
    const event = toAuditEvent(row);
    if (event === null) continue;
    events.push(event);
    if (row.actor && !actorNames.has(row.actor.id)) actorNames.set(row.actor.id, row.actor.name);
  }

  const filter: AuditFilter = {
    ...(actor ? { actorIds: [actor] } : {}),
    ...(type ? { types: [type] } : {}),
    ...(dayStartIso(from) ? { from: dayStartIso(from) } : {}),
    ...(dayEndIso(to) ? { to: dayEndIso(to) } : {}),
  };
  const ordered = sortAuditEvents(filterAuditEvents(events, filter));
  const groups = groupAuditByDay(ordered);

  const actorOptions = [...new Set(events.map((event) => event.actorId))]
    .sort()
    .map((id) => ({ id, label: actorNames.get(id) ?? id }));
  const typeOptions = [...new Set(events.map((event) => event.type))].sort();

  return (
    <div className="mx-auto max-w-3xl px-10 py-12">
      <Link href={`/w/${workspace.slug}/settings`} className="text-xs text-muted hover:underline">
        ← {t(locale, "settings")}
      </Link>
      <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">
        {t(locale, "activityHeading")}
      </h1>
      <p className="mb-6 text-sm text-muted">{t(locale, "activityIntro")}</p>

      <form method="GET" className="mb-8 flex flex-wrap items-end gap-3" aria-label={t(locale, "filter")}>
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t(locale, "member")}
          <select
            name="actor"
            defaultValue={actor ?? ""}
            className="h-9 rounded border border-border bg-bg px-2 text-sm text-fg"
          >
            <option value="">All</option>
            {actorOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Action
          <select
            name="type"
            defaultValue={type ?? ""}
            className="h-9 rounded border border-border bg-bg px-2 text-sm text-fg"
          >
            <option value="">All</option>
            {typeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          From
          <input
            type="date"
            name="from"
            defaultValue={from ?? ""}
            aria-label="From"
            className="h-9 rounded border border-border bg-bg px-2 text-sm text-fg"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          To
          <input
            type="date"
            name="to"
            defaultValue={to ?? ""}
            aria-label="To"
            className="h-9 rounded border border-border bg-bg px-2 text-sm text-fg"
          />
        </label>

        <button
          type="submit"
          className="inline-flex h-9 items-center rounded border border-border px-3 text-sm hover:bg-surface-2"
        >
          {t(locale, "apply")}
        </button>
        <Link
          href={`/w/${workspace.slug}/settings/audit`}
          className="inline-flex h-9 items-center rounded px-2 text-sm text-muted hover:underline"
        >
          Clear
        </Link>
      </form>

      {groups.length === 0 ? (
        <p className="text-sm text-muted">{t(locale, "noResults")}</p>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map((group) => (
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
          ))}
        </div>
      )}
    </div>
  );
}
