import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canDeleteWorkspace, canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
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
import { OAuthAppManager, type OAuthAppRow } from "@/components/oauth-app-manager";
import {
  WebhookManager,
  type DeliveryRow,
  type WebhookRow,
} from "@/components/webhook-manager";
import { LocalTime } from "@/components/local-time";
import { t } from "@/lib/i18n";

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
    <div className="mx-auto max-w-2xl px-10 py-12">
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

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">
          {t(locale, "members")} ({members.length})
        </h2>
        <MembersManager
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          ownerId={workspace.ownerId}
          currentUserId={user.id}
          currentUserRole={access.role}
          locale={locale}
          members={members.map((member) => ({
            userId: member.id,
            name: member.name,
            email: member.email,
            role: member.role,
          }))}
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
