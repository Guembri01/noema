import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionId, requireUser } from "@/lib/auth";
import { listActiveSessions } from "@/lib/session-store";
import {
  canDeleteWorkspace,
  canManageMembers,
  canPerformWorkspaceAction,
  getWorkspaceAccess,
} from "@/lib/permissions";
import { getWorkspaceBySlug, getWorkspaceMembers, getRecentActivity, getRecentWebhookDeliveries } from "@/server/queries";
import { prisma } from "@/lib/db";
import { TeamspaceManager, type TeamspaceRow } from "@/components/teamspace-manager";
import { AiSettings } from "@/components/ai-settings";
import { EmailSettings } from "@/components/email-settings";
import { LabelManager } from "@/components/label-manager";
import { DangerZone } from "@/components/danger-zone";
import {
  getEmailSummary,
  listEmailDeliveries,
  listWorkspaceInvites,
} from "@/server/actions/email";
import { getAiProviderSummary } from "@/server/actions/ai-settings";
import {
  ApiTokenManager,
  type ApiTokenRow,
} from "@/components/api-token-manager";
import { EditWorkspaceButton } from "@/components/workspace-dialog";
import { MembersManager } from "@/components/members-manager";
import { TwoFactorManager } from "@/components/two-factor-manager";
import { SessionsManager, type SessionRow } from "@/components/sessions-manager";
import { OAuthAppManager, type OAuthAppRow } from "@/components/oauth-app-manager";
import {
  WebhookManager,
  type DeliveryRow,
  type WebhookRow,
} from "@/components/webhook-manager";
import { LocalTime } from "@/components/local-time";
import { t } from "@/lib/i18n";
import {
  aggregateByPage,
  dailySeries,
  topPages,
  type AnalyticsEvent,
  type AnalyticsEventKind,
} from "@/lib/analytics-events";
import { SYSTEM_ACTOR_ID } from "@/lib/audit-log";

/** i18n keys for the workspace activity trail (locale applied at render). */
const ACTIVITY_KEYS: Record<string, string> = {
  "workspace.created": "actCreated",
  "workspace.updated": "actUpdated",
  "member.role_changed": "actRoleChanged",
  "member.removed": "actMemberRemoved",
  "member.left": "actMemberLeft",
  "member.ownership_transferred": "actOwnership",
  "page.archived": "actPageArchived",
  "page.restored": "actPageRestored",
  "page.deleted": "actPageDeleted",
  "page.shared": "actPageShared",
  "page.unshared": "actPageUnshared",
  "comment.created": "actComment",
};

/** One row of `getRecentActivity`, named so the projection below stays readable. */
type ActivityRow = Awaited<ReturnType<typeof getRecentActivity>>[number];

/**
 * Workspace activity actions that describe page-level analytics, mapped onto the
 * `AnalyticsEventKind` vocabulary the read-only `@/lib/analytics-events` helpers
 * aggregate. Members, teamspaces and workspace-settings actions are not page
 * activity, so they are absent here and dropped by the projection.
 */
const ACTIVITY_ANALYTICS_KIND: Record<string, AnalyticsEventKind> = {
  "page.created": "create",
  "page.shared": "edit",
  "page.unshared": "edit",
  "page.archived": "edit",
  "page.restored": "edit",
  "page.deleted": "edit",
  "row.edited": "edit",
  "comment.created": "comment",
};

/**
 * The page an activity row is about. Page-scoped actions carry it as `targetId`;
 * `comment.created` records the comment as its target, so the page travels in
 * `meta.pageId`. Rows with no page — or a malformed meta — return null.
 */
function activityPageId(row: ActivityRow): string | null {
  if (row.targetType === "page" && row.targetId) return row.targetId;
  const meta = row.meta;
  if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
    const pageId = (meta as Record<string, unknown>).pageId;
    if (typeof pageId === "string" && pageId.length > 0) return pageId;
  }
  return null;
}

/**
 * Project the workspace activity rows already loaded for the settings view onto
 * the pure `AnalyticsEvent` shape. Rows whose action or page cannot be mapped
 * are dropped rather than guessed at, so the aggregates only count real page
 * activity and never throw on the messy edges the trail carries.
 */
function toAnalyticsEvents(rows: readonly ActivityRow[]): AnalyticsEvent[] {
  const events: AnalyticsEvent[] = [];
  for (const row of rows) {
    const kind = ACTIVITY_ANALYTICS_KIND[row.action];
    if (!kind) continue;
    const pageId = activityPageId(row);
    if (!pageId) continue;
    events.push({
      id: row.id,
      pageId,
      actorId: row.actor?.id ?? SYSTEM_ACTOR_ID,
      kind,
      at: row.createdAt.toISOString(),
    });
  }
  return events;
}

/** Short, stable label for a page id when the activity trail carries no title. */
const shortId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

/** Window, in UTC days, the activity sparkline summarises. */
const SPARKLINE_DAYS = 14;
const MS_PER_DAY = 86_400_000;
/** Tallest sparkline bar, in px; must match the bar container's `h-16`. */
const SPARKLINE_MAX_PX = 64;

/** Bar height for one day's total; empty days keep a 2px baseline. */
function barHeight(total: number, max: number): number {
  if (total <= 0 || max <= 0) return 2;
  return Math.max(4, Math.round((total / max) * SPARKLINE_MAX_PX));
}

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();
  const locale = user.locale ?? "en";
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();

  const manage = canManageMembers(access.role);
  // The member directory carries every member's name and email: guests (and
  // anyone without membership) never receive it — even in the RSC payload.
  const directory = canPerformWorkspaceAction(access.role, "viewMemberDirectory");
  const [members, tokens, webhooks, deliveries] = await Promise.all([
    getWorkspaceMembers(workspace.id),
    prisma.apiToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, createdAt: true, lastUsedAt: true },
    }),
    manage
      ? prisma.webhook.findMany({
          where: { workspaceId: workspace.id },
          orderBy: { createdAt: "desc" },
          select: { id: true, url: true, events: true, secret: true },
        })
      : Promise.resolve([]),
    manage ? getRecentWebhookDeliveries(workspace.id) : Promise.resolve([]),
  ]);

  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { twoFactorEnabled: true },
  });

  // B54 — active sessions of this account (session registry, matrix §17).
  const [activeSessions, currentSid] = await Promise.all([
    listActiveSessions(user.id),
    getSessionId(),
  ]);
  const sessionRows: SessionRow[] = activeSessions
    .map((record) => ({
      sid: record.sid,
      device: record.device,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      current: record.sid === currentSid,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current));

  const teamspaces = await prisma.teamspace.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      icon: true,
      members: { select: { userId: true } },
      invites: { where: { acceptedAt: null }, select: { id: true, email: true, role: true } },
    },
  });
  const teamspaceRows: TeamspaceRow[] = teamspaces.map((teamspace) => ({
    id: teamspace.id,
    name: teamspace.name,
    icon: teamspace.icon,
    memberIds: teamspace.members.map((member) => member.userId),
    invites: teamspace.invites,
  }));

  const activity = manage ? await getRecentActivity(workspace.id) : [];

  // B22 — analytics summary. A pure projection of the rows already loaded above
  // (no extra query) through the read-only `@/lib/analytics-events` aggregators:
  // top pages by activity, plus a dense daily series for the sparkline.
  const analyticsEvents = toAnalyticsEvents(activity);
  const pageAggregates = aggregateByPage(analyticsEvents);
  const aggregateByPageId = new Map(pageAggregates.map((entry) => [entry.pageId, entry]));
  const topActivityPages = topPages(analyticsEvents, { limit: 5 });
  const totalAnalyticsEvents = pageAggregates.reduce((sum, entry) => sum + entry.total, 0);
  const contributorCount = new Set(analyticsEvents.map((event) => event.actorId)).size;

  const rangeEnd = new Date();
  const rangeStart = new Date(rangeEnd.getTime() - (SPARKLINE_DAYS - 1) * MS_PER_DAY);
  const dailyActivity = dailySeries(analyticsEvents, {
    from: rangeStart.toISOString().slice(0, 10),
    to: rangeEnd.toISOString().slice(0, 10),
  });
  const dailyMax = dailyActivity.reduce((max, bucket) => Math.max(max, bucket.total), 0);
  const firstActivityDay = dailyActivity.at(0)?.date ?? "";
  const lastActivityDay = dailyActivity.at(-1)?.date ?? "";

  const [aiProvider, emailSummary, workspaceInvites, emailDeliveries, labels] = await Promise.all([    getAiProviderSummary(workspace.id),
    getEmailSummary(workspace.id),
    listWorkspaceInvites(workspace.id),
    listEmailDeliveries(workspace.id),
    prisma.label.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true, description: true, _count: { select: { tickets: true } } },
    }),
  ]);

  const oauthApps = await prisma.oAuthApp.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, clientId: true, redirectUris: true },
  });
  const oauthAppRows: OAuthAppRow[] = oauthApps.map((app) => ({
    id: app.id,
    name: app.name,
    clientId: app.clientId,
    redirectUris: app.redirectUris,
  }));

  const webhookRows: WebhookRow[] = webhooks.map((webhook) => ({
    id: webhook.id,
    url: webhook.url,
    events: webhook.events,
    hasSecret: Boolean(webhook.secret),
  }));

  const deliveryRows: DeliveryRow[] = deliveries.map((delivery) => ({
    id: delivery.id,
    event: delivery.event,
    ok: delivery.ok,
    status: delivery.responseStatus,
    attempts: delivery.attempts,
    error: delivery.error,
    url: delivery.webhook.url,
    createdAt: delivery.createdAt.toISOString(),
  }));

  const tokenRows: ApiTokenRow[] = tokens.map((token) => ({
    id: token.id,
    name: token.name,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
  }));

  return (
    <div className="mx-auto w-full max-w-[1600px] px-8 py-12">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">
        {t(locale, "workspaceSettings")}
      </h1>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
          {t(locale, "general")}
        </h2>
        {canManageMembers(access.role) ? (
          <EditWorkspaceButton
            workspaceId={workspace.id}
            initialName={workspace.name}
            initialIcon={workspace.icon}
            locale={locale}
          />
        ) : (
          <p className="text-sm">{workspace.name}</p>
        )}
        <p className="mt-2 text-xs text-muted">
          {t(locale, "yourRole")} {access.role.toLowerCase()}
        </p>
      </section>

      <nav aria-label={t(locale, "settings")} className="mt-8 grid gap-2 sm:grid-cols-2">
        <Link
          href={`/w/${workspace.slug}/settings/notifications`}
          className="rounded-lg border border-border px-4 py-3 text-sm hover:bg-surface-2"
        >
          {t(locale, "notifications")}
          <span className="mt-0.5 block text-xs text-muted">
            Choose which events reach you and how they are batched.
          </span>
        </Link>
        <Link
          href={`/w/${workspace.slug}/settings/tokens`}
          className="rounded-lg border border-border px-4 py-3 text-sm hover:bg-surface-2"
        >
          {t(locale, "apiTokens")}
          <span className="mt-0.5 block text-xs text-muted">
            Create and revoke scoped REST API tokens.
          </span>
        </Link>
        <Link
          href={`/w/${workspace.slug}/settings/data`}
          className="rounded-lg border border-border px-4 py-3 text-sm hover:bg-surface-2"
        >
          Data &amp; privacy
          <span className="mt-0.5 block text-xs text-muted">
            Export or erase your personal data (GDPR).
          </span>
        </Link>
        <Link
          href={`/w/${workspace.slug}/settings/move`}
          className="rounded-lg border border-border px-4 py-3 text-sm hover:bg-surface-2"
        >
          Move pages
          <span className="mt-0.5 block text-xs text-muted">
            Move a page subtree into another workspace.
          </span>
        </Link>
      </nav>

      <section className="mt-10">
        {directory && (
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
            {t(locale, "members")} ({members.length})
          </h2>
        )}
        <MembersManager
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          ownerId={workspace.ownerId}
          currentUserId={user.id}
          currentUserRole={access.role}
          locale={locale}
          members={
            directory
              ? members.map((member) => ({
                  userId: member.id,
                  name: member.name,
                  email: member.email,
                  role: member.role,
                }))
              : []
          }
        />
      </section>

      {manage && activity.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
            {t(locale, "activityHeading")}
          </h2>
          <p className="mb-3 text-xs text-muted">
            {t(locale, "activityIntro")}
          </p>
          <Link
            href={`/w/${workspace.slug}/settings/audit`}
            className="mb-3 inline-block text-xs text-accent hover:underline"
          >
            View full audit log →
          </Link>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {activity.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <strong className="font-medium">{entry.actor?.name ?? t(locale, "someone")}</strong>{" "}
                  {ACTIVITY_KEYS[entry.action]
                    ? t(locale, ACTIVITY_KEYS[entry.action] as Parameters<typeof t>[1])
                    : entry.action}
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {<LocalTime value={entry.createdAt} />}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {manage && analyticsEvents.length > 0 && (
        <section className="mt-10" aria-labelledby="analytics-heading">
          <h2
            id="analytics-heading"
            className="mb-3 text-sm font-medium uppercase tracking-wide text-muted"
          >
            Analytics
          </h2>
          <p className="mb-3 text-xs text-muted">
            Page activity from the workspace trail, most active pages first.
          </p>
          <div className="rounded-lg border border-border p-4">
            <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                <strong className="font-semibold">{totalAnalyticsEvents}</strong>{" "}
                <span className="text-muted">events</span>
              </span>
              <span>
                <strong className="font-semibold">{pageAggregates.length}</strong>{" "}
                <span className="text-muted">pages</span>
              </span>
              <span>
                <strong className="font-semibold">{contributorCount}</strong>{" "}
                <span className="text-muted">contributors</span>
              </span>
            </div>

            <div
              className="flex h-16 items-end gap-1"
              role="img"
              aria-label={`Daily page activity over the last ${SPARKLINE_DAYS} days`}
            >
              {dailyActivity.map((bucket) => (
                <div
                  key={bucket.date}
                  title={`${bucket.date}: ${bucket.total}`}
                  className={
                    bucket.total > 0
                      ? "w-full flex-1 rounded-sm bg-accent"
                      : "w-full flex-1 rounded-sm bg-border"
                  }
                  style={{ height: `${barHeight(bucket.total, dailyMax)}px` }}
                />
              ))}
            </div>
            <div className="mb-4 flex justify-between text-[10px] text-muted">
              <span>{firstActivityDay}</span>
              <span>{lastActivityDay}</span>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className="pb-2 font-medium">Page</th>
                  <th className="pb-2 text-right font-medium">Events</th>
                  <th className="hidden pb-2 text-right font-medium sm:table-cell">
                    Contributors
                  </th>
                  <th className="hidden pb-2 text-right font-medium sm:table-cell">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border border-t border-border">
                {topActivityPages.map((page) => {
                  const aggregate = aggregateByPageId.get(page.pageId);
                  return (
                    <tr key={page.pageId}>
                      <td className="py-2">
                        <Link
                          href={`/w/${workspace.slug}/${page.pageId}`}
                          className="text-accent hover:underline"
                          title={page.pageId}
                        >
                          {shortId(page.pageId)}
                        </Link>
                      </td>
                      <td className="py-2 text-right tabular-nums">{page.count}</td>
                      <td className="hidden py-2 text-right tabular-nums sm:table-cell">
                        {aggregate?.uniqueActors ?? 0}
                      </td>
                      <td className="hidden py-2 text-right text-xs text-muted sm:table-cell">
                        {aggregate?.lastActivity ? (
                          <LocalTime value={aggregate.lastActivity} />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
          {t(locale, "exportHeading")}
        </h2>        <a
          href={`/api/export/workspace/${workspace.slug}`}
          download
          className="inline-flex h-9 items-center rounded border border-border px-3 text-sm hover:bg-surface-2"
        >
          {t(locale, "downloadWorkspace")}
        </a>
      </section>

      <DangerZone
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        canDelete={canDeleteWorkspace(access.role)}
        locale={locale}
      />

      <TwoFactorManager enabled={account?.twoFactorEnabled ?? false} locale={locale} />

      <SessionsManager sessions={sessionRows} locale={locale} />

      <ApiTokenManager tokens={tokenRows} locale={locale} />

      <OAuthAppManager apps={oauthAppRows} locale={locale} />

      {manage && (
        <WebhookManager
          workspaceId={workspace.id}
          webhooks={webhookRows}
          deliveries={deliveryRows}
          locale={locale}
        />
      )}

      {manage && aiProvider && (
        <AiSettings workspaceId={workspace.id} summary={aiProvider} locale={locale} />
      )}

      {manage && (
        <LabelManager
          workspaceId={workspace.id}
          labels={labels.map((label) => ({
            id: label.id,
            name: label.name,
            color: label.color,
            description: label.description,
            count: label._count.tickets,
          }))}
          locale={locale}
        />
      )}

      {manage && emailSummary && (
        <EmailSettings
          workspaceId={workspace.id}
          summary={emailSummary}
          invites={workspaceInvites}
          deliveries={emailDeliveries.map((row) => ({
            id: row.id,
            to: row.to,
            subject: row.subject,
            kind: row.kind,
            status: row.status,
            error: row.error,
            createdAt: row.createdAt.toISOString(),
          }))}
          locale={locale}
        />
      )}

      {manage && (
        <TeamspaceManager
          workspaceId={workspace.id}
          teamspaces={teamspaceRows}
          members={members.map((member) => ({ id: member.id, name: member.name, email: member.email }))}
          locale={locale}
        />
      )}
    </div>
  );
}
