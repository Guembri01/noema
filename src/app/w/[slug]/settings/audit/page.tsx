import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import { getActivityPage, getWorkspaceBySlug, getWorkspaceMembers } from "@/server/queries";
import type { AuditFilter } from "@/lib/audit-log";
import { AuditFeed } from "@/components/audit-feed";
import { t } from "@/lib/i18n";

export const metadata = { title: "Audit log" };

/** `YYYY-MM-DD`, the only shape a date input can hand back. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Events fetched per page — the initial window and each "Load more" window. */
const AUDIT_PAGE_SIZE = 50;

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
 * Workspace-wide audit log: the `Activity` feed the settings summary draws from,
 * but walked one cursor page at a time (newest first) through the additive
 * `getActivityPage`, then narrowed by actor/action/date and sectioned into UTC
 * day buckets by the pure `@/lib/audit-log` module. This page is only the thin
 * server shell (permission gate + URL filters + first page); appending later
 * pages is the `AuditFeed` client component's "Load more" control.
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

  const workspaceId = workspace.id;
  const [page, members] = await Promise.all([
    getActivityPage(workspaceId, { limit: AUDIT_PAGE_SIZE }),
    // `getActivityPage` only carries actor ids; member records supply the names
    // the filter's actor select shows.
    getWorkspaceMembers(workspaceId),
  ]);
  const events = page.items;

  const nameById = new Map<string, string>();
  for (const member of members) nameById.set(member.id, member.name);
  const actorOptions = [...new Set(events.map((event) => event.actorId))]
    .sort()
    .map((id) => ({ id, label: nameById.get(id) ?? id }));
  const typeOptions = [...new Set(events.map((event) => event.type))].sort();

  const filter: AuditFilter = {
    ...(actor ? { actorIds: [actor] } : {}),
    ...(type ? { types: [type] } : {}),
    ...(dayStartIso(from) ? { from: dayStartIso(from) } : {}),
    ...(dayEndIso(to) ? { to: dayEndIso(to) } : {}),
  };

  /** Next page of the audit feed, handed to `AuditFeed`'s "Load more". */
  async function loadMoreActivity(input: { cursor: string }) {
    "use server";
    const current = await requireUser();
    const currentAccess = await getWorkspaceAccess(current.id, workspaceId);
    if (!currentAccess || !canManageMembers(currentAccess.role)) {
      return { error: "Not allowed." };
    }
    try {
      const next = await getActivityPage(workspaceId, {
        limit: AUDIT_PAGE_SIZE,
        cursor: input.cursor,
      });
      return { ok: true as const, events: next.items, nextCursor: next.nextCursor };
    } catch {
      return { error: "Could not load more activity." };
    }
  }

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

      <AuditFeed
        initialEvents={events}
        filter={filter}
        nextCursor={page.nextCursor}
        now={Date.now()}
        locale={locale}
        loadMore={loadMoreActivity}
      />
    </div>
  );
}
