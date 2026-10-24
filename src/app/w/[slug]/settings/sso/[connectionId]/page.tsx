import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canManageMembers, getWorkspaceAccess } from "@/lib/permissions";
import { getWorkspaceBySlug } from "@/server/queries";
import { prisma } from "@/lib/db";
import { SsoConnectionForm } from "@/components/sso-connection-form";
import { SsoCopyField } from "@/components/sso-copy-field";
import { SsoConnectionTestPanel } from "@/components/sso-connection-test";
import { LocalTime } from "@/components/local-time";
import { Card } from "@/components/ui/card";
import { t } from "@/lib/i18n";
import { requestOrigin } from "@/lib/sso/request-origin";
import {
  SAML_ACS_PATH,
  SAML_METADATA_PATH,
  SAML_SLO_PATH,
} from "@/lib/sso/saml";
import { inspectSsoCertificate } from "@/lib/sso/test-connection";
import type { SsoConnectionInput } from "@/server/actions/sso-connections";
import { SettingsNav } from "../../settings-nav";

export const metadata = { title: "SAML connection" };

/**
 * One IdP connection's setup surface. The settings index stays a manageable
 * list; this page owns the connection-specific values an admin copies into the
 * IdP, the certificate/metadata status, the dry test and the edit form.
 */
export default async function SsoConnectionPage({
  params,
}: {
  params: Promise<{ slug: string; connectionId: string }>;
}) {
  const { slug, connectionId } = await params;
  const user = await requireUser();
  const locale = user.locale ?? "en";
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const access = await getWorkspaceAccess(user.id, workspace.id);
  if (!access) notFound();
  if (!canManageMembers(access.role)) notFound();

  const connection = await prisma.ssoConnection.findFirst({
    where: { id: connectionId, workspaceId: workspace.id },
    select: {
      id: true,
      name: true,
      idpEntityId: true,
      ssoUrl: true,
      certificate: true,
      metadataUrl: true,
      metadataFetchedAt: true,
      prevCertificate: true,
      prevCertificateExpiresAt: true,
      spEntityId: true,
      callbackUrl: true,
      emailAttribute: true,
      nameAttribute: true,
      groupsAttribute: true,
      roleRules: true,
      enabled: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!connection) notFound();

  const origin = (await requestOrigin()).replace(/\/+$/, "");
  const acsUrl = connection.callbackUrl?.trim() || `${origin}${SAML_ACS_PATH}`;
  const spEntityId = connection.spEntityId?.trim() || `${origin}${SAML_METADATA_PATH}`;
  const metadataUrl = `${origin}${SAML_METADATA_PATH}?connection=${connection.id}`;
  const sloUrl = `${origin}${SAML_SLO_PATH}?connection=${connection.id}`;
  const certificate = inspectSsoCertificate(connection.certificate);

  const initial: SsoConnectionInput = {
    name: connection.name,
    idpEntityId: connection.idpEntityId,
    ssoUrl: connection.ssoUrl,
    certificate: connection.certificate,
    metadataUrl: connection.metadataUrl ?? "",
    spEntityId: connection.spEntityId ?? "",
    callbackUrl: connection.callbackUrl ?? "",
    emailAttribute: connection.emailAttribute ?? "",
    nameAttribute: connection.nameAttribute ?? "",
    groupsAttribute: connection.groupsAttribute ?? "",
    roleRules:
      connection.roleRules === null || connection.roleRules === undefined
        ? ""
        : JSON.stringify(connection.roleRules),
    enabled: connection.enabled,
  };

  return (
    <div className="mx-auto w-full max-w-[1100px] px-8 py-12">
      <Link
        href={`/w/${workspace.slug}/settings#sso-heading`}
        className="focus-ring rounded-sm text-xs text-muted hover:underline"
      >
        ← {t(locale, "settings")} · Single sign-on
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{connection.name}</h1>
        <span
          className={
            connection.enabled
              ? "rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success"
              : "rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted"
          }
        >
          {connection.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted">
        Workspace SAML connection for{" "}
        <code className="font-mono text-xs">{connection.idpEntityId}</code>.
      </p>

      <SettingsNav slug={workspace.slug} locale={locale} className="mb-10 mt-6" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card variant="flat" padding="md">
          <h2 className="text-base font-semibold">Service provider values</h2>
          <p className="mb-4 mt-1 text-sm text-muted">
            Copy these into the IdP application. They are specific to this connection.
          </p>
          <div className="space-y-3">
            <SsoCopyField
              label="ACS URL"
              value={acsUrl}
              description="Single sign-on / reply URL."
            />
            <SsoCopyField
              label="SP entity id"
              value={spEntityId}
              description="Audience URI / identifier."
            />
            <SsoCopyField
              label="Metadata URL"
              value={metadataUrl}
              description="The IdP can import this document directly."
            />
            <SsoCopyField
              label="SLO URL"
              value={sloUrl}
              description="Single logout endpoint for this connection."
            />
          </div>
        </Card>

        <Card variant="flat" padding="md">
          <h2 className="text-base font-semibold">Identity provider</h2>
          <dl className="mt-3 divide-y divide-border text-sm">
            <div className="flex items-start justify-between gap-4 py-2">
              <dt className="text-muted">Entity id</dt>
              <dd className="break-all text-right font-mono text-xs">{connection.idpEntityId}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2">
              <dt className="text-muted">SSO URL</dt>
              <dd className="break-all text-right font-mono text-xs">{connection.ssoUrl}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2">
              <dt className="text-muted">Email attribute</dt>
              <dd className="break-all text-right font-mono text-xs">
                {connection.emailAttribute ?? "default"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2">
              <dt className="text-muted">Groups attribute</dt>
              <dd className="break-all text-right font-mono text-xs">
                {connection.groupsAttribute ?? "default"}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2">
              <dt className="text-muted">Certificate</dt>
              <dd className={certificate.ok ? "text-right text-success" : "text-right text-danger"}>
                {certificate.ok
                  ? `Valid until ${certificate.expiresAt.slice(0, 10)}`
                  : certificate.reason}
                {connection.prevCertificate && (
                  <span className="block text-xs text-muted">
                    Previous certificate retained
                    {connection.prevCertificateExpiresAt ? (
                      <>
                        {" "}
                        until <LocalTime value={connection.prevCertificateExpiresAt} />
                      </>
                    ) : null}
                    .
                  </span>
                )}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2">
              <dt className="text-muted">Metadata</dt>
              <dd className="break-all text-right text-xs">
                {connection.metadataUrl ? (
                  <>
                    <span className="block font-mono">{connection.metadataUrl}</span>
                    <span className="text-muted">
                      {connection.metadataFetchedAt ? (
                        <>
                          Last fetched <LocalTime value={connection.metadataFetchedAt} />
                        </>
                      ) : (
                        "Not fetched yet"
                      )}
                    </span>
                  </>
                ) : (
                  "Manual fields (no metadata URL)"
                )}
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      <div className="mt-4">
        <SsoConnectionTestPanel
          workspaceId={workspace.id}
          connectionId={connection.id}
          locale={locale}
        />
      </div>

      <Card variant="flat" padding="md" className="mt-4">
        <h2 className="text-base font-semibold">Edit connection</h2>
        <p className="mb-4 mt-1 text-sm text-muted">
          Changes are validated on the server. Run the test afterwards to confirm the
          IdP values still line up.
        </p>
        <SsoConnectionForm
          workspaceId={workspace.id}
          connectionId={connection.id}
          locale={locale}
          initial={initial}
          submitLabel={t(locale, "save")}
        />
      </Card>
    </div>
  );
}
