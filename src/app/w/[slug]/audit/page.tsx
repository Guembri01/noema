import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import { getWorkspaceBySlug, getWorkspaceMembers } from "@/server/queries";
import { getAuditRecords } from "@/server/audit-engine-data";
import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  SYSTEM_ACTOR_ID,
  describeAuditAction,
  groupByDay,
  redactEvent,
  type AuditEvent,
  type AuditSeverity,
} from "@/lib/audit-log-engine";
import {
  auditSearchParams,
  buildAuditView,
  isAuditAdmin,
  parseAuditQuery,
} from "@/lib/audit-engine-query";
import { t } from "@/lib/i18n";

export const metadata = { title: "Audit log" };

/** Always dynamic: the page runs an auth gate and an ambient-clock day bucket. */
export const dynamic = "force-dynamic";

/** Target kinds `logActivity` records (see `src/lib/activity.ts`). */
const TARGET_TYPES = ["workspace", "page", "ticket", "label", "comment", "member"] as const;

/** Tailwind classes for a severity badge. */
const SEVERITY_TONE: Record<AuditSeverity, string> = {
  info: "bg-surface-2 text-muted",
  notice: "bg-surface-2 text-fg",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  critical: "bg-red-500/15 text-red-700 dark:text-red-300",
};

/** ISO instant → compact `YYYY-MM-DD HH:MMZ`, tolerating an odd timestamp. */
function formatInstant(at: string): string {
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return at;
  return new Date(parsed).toISOString().replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, "Z");
}

/** Tailwind classes shared by the filter controls. */
const CONTROL =
  "h-9 rounded border border-border bg-bg px-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/40";

/** One event row, shared by the flat and grouped views. */
function AuditEventRow({
  event,
  actorLabel,
}: {
  event: AuditEvent;
  actorLabel: (id: string) => string;
}) {
  const descriptor = AUDIT_ACTIONS.find((entry) => entry.action === event.action);
  const severity: AuditSeverity = descriptor?.severity ?? "info";
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border/60 py-2 text-sm last:border-b-0">
      <time className="w-40 shrink-0 font-mono text-xs text-muted" dateTime={event.at}>
        {formatInstant(event.at)}
      </time>
      <span className="font-medium text-fg">{actorLabel(event.actorId)}</span>
      <span className="text-fg">{describeAuditAction(event.action)}</span>
      <span className="text-muted">
        {event.targetType}{" "}
        <span className="font-mono text-xs text-fg">{event.targetName ?? event.targetId}</span>
      </span>
      <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] ${SEVERITY_TONE[severity]}`}>
        {descriptor?.category ?? "uncategorised"} · {severity}
      </span>
    </li>
  );
}

/**
 * Workspace-wide audit log over the engine in `src/lib/audit-log-engine.ts`,
 * reading the real Prisma `Activity` rows the workspace records.
 *
 * The page is a thin server shell: it gates access (managers and above), parses
 * the URL into a validated engine query, and hands the newest matching rows to
 * `buildAuditView` (filter → sort → keyset page → day groups → summary). The
 * same query drives the CSV export route so the download matches the screen,
 * and only the workspace owner sees the unredacted `ip`/`meta` payload.
 */
export default async function AuditEnginePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const rawParams = await searchParams;

  const user = await requireUser();
  const locale = user.locale ?? "en";
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();
  // The audit trail is management data: never rendered for non-managers.
  if (!canManageMembers(access.role)) notFound();

  const query = parseAuditQuery(rawParams);
  const [records, members] = await Promise.all([
    getAuditRecords(workspace.id, query.filter),
    getWorkspaceMembers(workspace.id),
  ]);

  const now = Date.now();
  const view = buildAuditView(records, query, now);

  // Only the owner is the audit "admin": a manager still reads the feed, but
  // through `redactEvent`, which drops the sensitive ip/meta payload.
  const admin = isAuditAdmin(access.role);
  const pageEvents = view.page.items.map((event) => redactEvent(event, admin));
  const items = view.items.map((event) => redactEvent(event, admin));
  const groups = query.grouped ? groupByDay(pageEvents, now) : [];

  const nameById = new Map(members.map((member) => [member.id, member.name]));
  const actorLabel = (id: string): string =>
    id === SYSTEM_ACTOR_ID ? "System" : (nameById.get(id) ?? id);

  // Option lists stay stable while filtering: the action/category catalogue is
  // static and the actor list comes from the member directory.
  const actionOptions = [
    ...AUDIT_ACTIONS.map((entry) => entry.action),
    ...records.map((record) => record.action),
  ].filter((action, index, all) => all.indexOf(action) === index);
  const actorOptions = [SYSTEM_ACTOR_ID, ...members.map((member) => member.id)].filter(
    (id, index, all) => all.indexOf(id) === index,
  );

  const base = `/w/${workspace.slug}/audit`;
  const exportHref = `${base}/export?${auditSearchParams(query, { cursor: null }).toString()}`;
  const listHref = `${base}?${auditSearchParams(query, { view: "list", cursor: null }).toString()}`;
  const groupedHref = `${base}?${auditSearchParams(query, {
    view: "grouped",
    cursor: null,
  }).toString()}`;
  const olderHref =
    view.page.hasMore && view.page.nextCursor
      ? `${base}?${auditSearchParams(query, { cursor: view.page.nextCursor }).toString()}`
      : null;
  const firstHref = query.cursor
    ? `${base}?${auditSearchParams(query, { cursor: null }).toString()}`
    : null;

  const topActors = Object.entries(view.summary.byActor).slice(0, 5);
  const topActions = Object.entries(view.summary.byAction).slice(0, 5);

  return (
    <div className="mx-auto max-w-5xl px-10 py-12">
      <Link href={`/w/${workspace.slug}/settings`} className="text-xs text-muted hover:underline">
        ← {t(locale, "settings")}
      </Link>
      <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">
        {t(locale, "activityHeading")}
      </h1>
      <p className="mb-6 text-sm text-muted">{t(locale, "activityIntro")}</p>

      <div className="mb-6 flex flex-wrap gap-3 text-xs">
        <span className="rounded border border-border px-2 py-1 text-fg">
          {view.total} matching event{view.total === 1 ? "" : "s"}
        </span>
        {AUDIT_CATEGORIES.filter((category) => view.summary.byCategory[category] > 0).map(
          (category) => (
            <span key={category} className="rounded border border-border px-2 py-1 text-muted">
              {category}: {view.summary.byCategory[category]}
            </span>
          ),
        )}
      </div>

      <form
        method="GET"
        action={base}
        className="mb-8 flex flex-wrap items-end gap-3"
        aria-label={t(locale, "filter")}
      >
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t(locale, "member")}
          <select name="actor" defaultValue={query.raw.actor ?? ""} className={CONTROL}>
            <option value="">All</option>
            {actorOptions.map((id) => (
              <option key={id} value={id}>
                {actorLabel(id)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Action
          <select name="action" defaultValue={query.raw.action ?? ""} className={CONTROL}>
            <option value="">All</option>
            {actionOptions.map((action) => (
              <option key={action} value={action}>
                {describeAuditAction(action)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Category
          <select name="category" defaultValue={query.raw.category ?? ""} className={CONTROL}>
            <option value="">All</option>
            {AUDIT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Target
          <select name="target" defaultValue={query.raw.target ?? ""} className={CONTROL}>
            <option value="">All</option>
            {TARGET_TYPES.map((target) => (
              <option key={target} value={target}>
                {target}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Search
          <input
            type="search"
            name="q"
            defaultValue={query.raw.query ?? ""}
            placeholder="name, id or action"
            className={CONTROL}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          From
          <input type="date" name="from" defaultValue={query.raw.from ?? ""} className={CONTROL} />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          To
          <input type="date" name="to" defaultValue={query.raw.to ?? ""} className={CONTROL} />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          {t(locale, "sort")}
          <select name="sort" defaultValue={query.raw.sort} className={CONTROL}>
            <option value="at">Time</option>
            <option value="actor">Actor</option>
            <option value="action">Action</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Order
          <select name="dir" defaultValue={query.raw.dir} className={CONTROL}>
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          View
          <select name="view" defaultValue={query.raw.view} className={CONTROL}>
            <option value="list">Flat</option>
            <option value="grouped">By day</option>
          </select>
        </label>

        <button
          type="submit"
          className="inline-flex h-9 items-center rounded border border-border px-3 text-sm hover:bg-surface-2"
        >
          {t(locale, "apply")}
        </button>
        <Link
          href={base}
          className="inline-flex h-9 items-center rounded px-2 text-sm text-muted hover:underline"
        >
          Clear
        </Link>
        <a
          href={exportHref}
          className="inline-flex h-9 items-center rounded border border-border px-3 text-sm hover:bg-surface-2"
        >
          Export CSV
        </a>
      </form>

      <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted">
        <Link href={listHref} className={query.grouped ? "hover:underline" : "font-semibold text-fg"}>
          Flat
        </Link>
        <span>·</span>
        <Link
          href={groupedHref}
          className={query.grouped ? "font-semibold text-fg" : "hover:underline"}
        >
          Group by day
        </Link>
        {topActors.length > 0 ? (
          <span className="ml-auto">
            top: {topActors.map(([id, count]) => `${actorLabel(id)} (${count})`).join(", ")}
          </span>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="rounded border border-border px-4 py-8 text-center text-sm text-muted">
          {t(locale, "noResults")}
        </p>
      ) : query.grouped ? (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.day}>
              <h2 className="mb-1 text-sm font-semibold text-fg">
                {group.label}
                <span className="ml-2 font-normal text-muted">{group.count}</span>
              </h2>
              <ul>
                {group.events.map((event) => (
                  <AuditEventRow key={event.id} event={event} actorLabel={actorLabel} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="rounded border border-border px-4">
          {items.map((event) => (
            <AuditEventRow key={event.id} event={event} actorLabel={actorLabel} />
          ))}
        </ul>
      )}

      {(olderHref || firstHref) && (
        <div className="mt-6 flex items-center gap-4 text-sm">
          {firstHref ? (
            <Link href={firstHref} className="text-muted hover:underline">
              ← Newest
            </Link>
          ) : null}
          {olderHref ? (
            <Link href={olderHref} className="ml-auto hover:underline">
              Older →
            </Link>
          ) : null}
        </div>
      )}

      <p className="mt-8 text-xs text-muted">
        {admin
          ? "As workspace owner you see the full audit payload."
          : "Managers see the audit trail with the sensitive IP and metadata fields redacted."}
      </p>

      {topActions.length > 0 ? (
        <p className="mt-2 text-xs text-muted">
          Most frequent actions:{" "}
          {topActions.map(([action, count]) => `${describeAuditAction(action)} (${count})`).join(", ")}
        </p>
      ) : null}
    </div>
  );
}
