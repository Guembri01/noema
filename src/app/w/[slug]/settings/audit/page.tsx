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
 * `getActivityPage`. The active actor/action/date filters are passed straight
 * into that cursor query (its `ActivityPageFilters`), so every page — the first
 * one here and each "Load more" — is filled with matching rows instead of a
 * workspace-wide window trimmed afterwards; the same filter still reaches the
 * `AuditFeed` client component, which re-applies it idempotently and sections
 * the events into UTC day buckets via the pure `@/lib/audit-log` module. This
 * page is only the thin server shell (permission gate + URL filters + first
 * page); appending later pages is the `AuditFeed` "Load more" control.
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

  const filter: AuditFilter = {
    ...(actor ? { actorIds: [actor] } : {}),
    ...(type ? { types: [type] } : {}),
    ...(dayStartIso(from) ? { from: dayStartIso(from) } : {}),
    ...(dayEndIso(to) ? { to: dayEndIso(to) } : {}),
  };
  // The feed's own cursor walk is narrowed in the query, so a filtered page is
  // dense (it fills its window with matches) rather than a workspace-wide window
  // trimmed after the fact. The actor/action selects still have to reflect the
  // whole workspace, though: deriving them from the filtered page would erase
  // every other option the moment a filter is applied, so an extra unfiltered
  // window supplies them (skipped when no filter is active, when the feed page
  // is already unfiltered).
  const filtered = Object.keys(filter).length > 0;

  const [page, members, optionPage] = await Promise.all([
    getActivityPage(workspaceId, { limit: AUDIT_PAGE_SIZE, ...filter }),
    // `getActivityPage` only carries actor ids; member records supply the names
    // the filter's actor select shows.
    getWorkspaceMembers(workspaceId),
    filtered ? getActivityPage(workspaceId, { limit: AUDIT_PAGE_SIZE }) : null,
  ]);
  const events = page.items;
  const optionEvents = optionPage?.items ?? events;

  const nameById = new Map<string, string>();
  for (const member of members) nameById.set(member.id, member.name);
  const actorOptions = [...new Set(optionEvents.map((event) => event.actorId))]
    .sort()
    .map((id) => ({ id, label: nameById.get(id) ?? id }));
  const typeOptions = [...new Set(optionEvents.map((event) => event.type))].sort();

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
        ...filter,
      });
      return { ok: true as const, events: next.items, nextCursor: next.nextCursor };
    } catch {
      return { error: "Could not load more activity." };
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <Link
        href={`/w/${workspace.slug}/settings`}
        className="focus-ring rounded-sm text-xs text-muted hover:underline"
      >
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
            className="h-9 rounded-control border border-border bg-bg px-2 text-sm text-fg"
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
            className="h-9 rounded-control border border-border bg-bg px-2 text-sm text-fg"
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
            aria-label={t(locale, "fromLabel")}
            className="h-9 rounded-control border border-border bg-bg px-2 text-sm text-fg"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          To
          <input
            type="date"
            name="to"
            defaultValue={to ?? ""}
            aria-label={t(locale, "toLabel")}
            className="h-9 rounded-control border border-border bg-bg px-2 text-sm text-fg"
          />
        </label>

        <button
          type="submit"
          aria-label={t(locale, "apply")}
          className="focus-ring u-interactive inline-flex h-9 items-center rounded-control border border-border px-3 text-sm hover:bg-surface-2"
        >
          {t(locale, "apply")}
        </button>
        <Link
          href={`/w/${workspace.slug}/settings/audit`}
          className="focus-ring inline-flex h-9 items-center rounded-control px-2 text-sm text-muted hover:underline"
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
