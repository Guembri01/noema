"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SsoConnectionForm } from "@/components/sso-connection-form";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import {
  deleteSsoConnectionAction,
  generateScimTokenAction,
  refreshSsoConnectionMetadataAction,
  revokeScimTokenAction,
} from "@/server/actions/sso-connections";
import {
  addVerifiedDomainAction,
  deleteVerifiedDomainAction,
  verifyVerifiedDomainAction,
} from "@/server/actions/verified-domains";

export type SsoConnectionRow = {
  id: string;
  name: string;
  idpEntityId: string;
  ssoUrl: string;
  certificate: string;
  metadataUrl: string | null;
  metadataFetchedAt: string | null;
  spEntityId: string | null;
  callbackUrl: string | null;
  emailAttribute: string | null;
  nameAttribute: string | null;
  groupsAttribute: string | null;
  roleRules: string;
  enabled: boolean;
  scimEnabled: boolean;
};

export type VerifiedDomainRow = {
  id: string;
  domain: string;
  recordName: string;
  verifyToken: string;
  verifiedAt: string | null;
  connectionId: string | null;
};

/** Render the connection list; the full editor lives on each connection page. */
export function SsoSettings({
  workspaceId,
  slug,
  locale,
  connections,
  domains,
  activity = [],
}: {
  workspaceId: string;
  slug: string;
  locale: string;
  connections: SsoConnectionRow[];
  domains: VerifiedDomainRow[];
  activity?: { id: string; action: string; createdAt: string }[];
}) {
  const router = useRouter();
  const { run, pending } = useAction(locale);
  const [adding, setAdding] = useState(false);
  const [domain, setDomain] = useState("");
  const [domainConnection, setDomainConnection] = useState("");
  const [scimToken, setScimToken] = useState<string | null>(null);

  const refresh = () => router.refresh();
  const reset = () => {
    setAdding(false);
  };

  return (
    <section className="mt-10" aria-labelledby="sso-heading">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 id="sso-heading" className="text-lg font-semibold tracking-tight">
            Single sign-on
          </h2>
          <p className="mt-1 text-sm text-muted">
            SAML connections for this workspace. The IdP reads SP metadata at{" "}
            <code>/api/auth/saml/metadata?connection=&lt;id&gt;</code>.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => setAdding((value) => !value)}
          leftIcon={<Plus className="h-4 w-4" />}
        >
          {adding ? t(locale, "cancel") : t(locale, "add")}
        </Button>
      </div>

      <div className="space-y-3">
        {connections.length === 0 && (
          <p className="text-sm text-muted">No workspace SAML connection yet.</p>
        )}
        {connections.map((row) => (
          <Card key={row.id} variant="flat" padding="md">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{row.name}</p>
                <p className="truncate text-xs text-muted">{row.ssoUrl}</p>
                <p className="mt-1 text-xs text-muted">
                  {row.enabled ? "Enabled" : "Disabled"}
                  {row.scimEnabled ? " · SCIM enabled" : ""}
                  {row.metadataUrl ? ` · metadata ${row.metadataUrl}` : ""}
                  {row.metadataFetchedAt ? ` · fetched ${row.metadataFetchedAt}` : ""}
                </p>
                {scimToken && (
                  <p className="mt-2 break-all rounded border border-border bg-surface-2 p-2 font-mono text-xs">
                    SCIM token (shown once): {scimToken}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button type="button" size="sm" variant="ghost" asChild>
                  <Link href={`/w/${slug}/settings/sso/${row.id}`}>Manage</Link>
                </Button>
                {row.metadataUrl && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => refreshSsoConnectionMetadataAction(workspaceId, row.id),
                        { success: "Metadata refreshed", onSuccess: refresh },
                      )
                    }
                    leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                  >
                    {t(locale, "refresh")}
                  </Button>
                )}
                {row.scimEnabled ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      run(() => revokeScimTokenAction(workspaceId, row.id), {
                        success: "SCIM token revoked",
                        onSuccess: () => {
                          setScimToken(null);
                          refresh();
                        },
                      })
                    }
                  >
                    Revoke SCIM
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      run(() => generateScimTokenAction(workspaceId, row.id), {
                        success: "SCIM token created — copy it now",
                        onSuccess: (value) => {
                          if ("ok" in value && value.ok) setScimToken(value.token);
                          refresh();
                        },
                      })
                    }
                  >
                    SCIM token
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    run(() => deleteSsoConnectionAction(workspaceId, row.id), {
                      success: "SAML connection deleted",
                      onSuccess: refresh,
                    })
                  }
                  leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                >
                  {t(locale, "delete")}
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {adding && (
        <Card variant="flat" padding="md" className="mt-4">
          <h3 className="mb-3 text-sm font-semibold">New SAML connection</h3>
          <SsoConnectionForm
            workspaceId={workspaceId}
            locale={locale}
            onCancel={reset}
          />
        </Card>
      )}

      {activity.length > 0 && (
        <div className="mt-8">
          <h3 className="text-base font-semibold">Recent SSO activity</h3>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">
            {activity.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="font-mono text-xs">{entry.action}</span>
                <time dateTime={entry.createdAt} className="text-xs text-muted">
                  {entry.createdAt}
                </time>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8">
        <h3 className="text-base font-semibold">Verified domains</h3>
        <p className="mt-1 text-sm text-muted">
          A verified email domain can auto-join this workspace on SAML login.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            Domain
            <Input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="acme.com" />
          </label>
          <label className="text-sm">
            Connection (optional)
            <select
              value={domainConnection}
              onChange={(event) => setDomainConnection(event.target.value)}
              className="focus-ring h-9 rounded-control border border-border bg-bg px-2 text-sm"
            >
              <option value="">Any connection</option>
              {connections.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() =>
              run(() => addVerifiedDomainAction(workspaceId, domain, domainConnection || undefined), {
                success: "Domain added — publish the TXT record",
                onSuccess: () => {
                  setDomain("");
                  setDomainConnection("");
                  refresh();
                },
              })
            }
            leftIcon={<Plus className="h-4 w-4" />}
          >
            {t(locale, "add")}
          </Button>
        </div>

        <div className="mt-3 space-y-2">
          {domains.length === 0 && <p className="text-sm text-muted">No verified domain yet.</p>}
          {domains.map((row) => (
            <Card key={row.id} variant="flat" padding="md">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {row.domain}{" "}
                    {row.verifiedAt ? (
                      <span className="text-xs text-success">verified</span>
                    ) : (
                      <span className="text-xs text-warning">pending</span>
                    )}
                  </p>
                  {!row.verifiedAt && (
                    <p className="mt-1 break-all text-xs text-muted">
                      TXT <code>{row.recordName}</code> = <code>{row.verifyToken}</code>
                    </p>
                  )}
                </div>
                <div className="flex gap-1">
                  {!row.verifiedAt && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        run(() => verifyVerifiedDomainAction(workspaceId, row.domain), {
                          success: "Domain verified",
                          onSuccess: refresh,
                        })
                      }
                      leftIcon={<ShieldCheck className="h-3.5 w-3.5" />}
                    >
                      Verify
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      run(() => deleteVerifiedDomainAction(workspaceId, row.domain), {
                        success: "Domain removed",
                        onSuccess: refresh,
                      })
                    }
                    leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                  >
                    {t(locale, "delete")}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
