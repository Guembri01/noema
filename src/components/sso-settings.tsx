"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import {
  createSsoConnectionAction,
  deleteSsoConnectionAction,
  generateScimTokenAction,
  refreshSsoConnectionMetadataAction,
  revokeScimTokenAction,
  updateSsoConnectionAction,
  type SsoConnectionInput,
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

const EMPTY: SsoConnectionInput = {
  name: "",
  idpEntityId: "",
  ssoUrl: "",
  certificate: "",
  metadataUrl: "",
  spEntityId: "",
  callbackUrl: "",
  emailAttribute: "",
  nameAttribute: "",
  groupsAttribute: "",
  roleRules: "",
  enabled: true,
};

/** Render one connection/domain editor; all rules are re-checked server-side. */
export function SsoSettings({
  workspaceId,
  locale,
  connections,
  domains,
}: {
  workspaceId: string;
  locale: string;
  connections: SsoConnectionRow[];
  domains: VerifiedDomainRow[];
}) {
  const router = useRouter();
  const { run, pending } = useAction(locale);
  const [draft, setDraft] = useState<SsoConnectionInput>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [domain, setDomain] = useState("");
  const [domainConnection, setDomainConnection] = useState("");
  const [scimToken, setScimToken] = useState<string | null>(null);

  const refresh = () => router.refresh();
  const edit = (row: SsoConnectionRow) => {
    setEditingId(row.id);
    setDraft({
      name: row.name,
      idpEntityId: row.idpEntityId,
      ssoUrl: row.ssoUrl,
      certificate: row.certificate,
      metadataUrl: row.metadataUrl ?? "",
      spEntityId: row.spEntityId ?? "",
      callbackUrl: row.callbackUrl ?? "",
      emailAttribute: row.emailAttribute ?? "",
      nameAttribute: row.nameAttribute ?? "",
      groupsAttribute: row.groupsAttribute ?? "",
      roleRules: row.roleRules,
      enabled: row.enabled,
    });
  };
  const reset = () => {
    setEditingId(null);
    setDraft(EMPTY);
  };
  const save = () => {
    run(
      () =>
        editingId
          ? updateSsoConnectionAction(workspaceId, editingId, draft)
          : createSsoConnectionAction(workspaceId, draft),
      {
        success: editingId ? "SAML connection updated" : "SAML connection created",
        onSuccess: () => {
          reset();
          refresh();
        },
      },
    );
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
        <Button type="button" size="sm" onClick={reset} leftIcon={<Plus className="h-4 w-4" />}>
          {t(locale, "add")}
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
                <Button type="button" size="sm" variant="ghost" onClick={() => edit(row)}>
                  {t(locale, "edit")}
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

      <Card variant="flat" padding="md" className="mt-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Name
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Acme Okta"
            />
          </label>
          <label className="text-sm">
            IdP entity id
            <Input
              value={draft.idpEntityId}
              onChange={(event) => setDraft({ ...draft, idpEntityId: event.target.value })}
              placeholder="https://idp.example.com/metadata"
            />
          </label>
          <label className="text-sm">
            IdP SSO URL
            <Input
              value={draft.ssoUrl}
              onChange={(event) => setDraft({ ...draft, ssoUrl: event.target.value })}
              placeholder="https://idp.example.com/sso"
            />
          </label>
          <label className="text-sm">
            Metadata URL (optional)
            <Input
              value={draft.metadataUrl}
              onChange={(event) => setDraft({ ...draft, metadataUrl: event.target.value })}
              placeholder="https://idp.example.com/metadata"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            IdP certificate (PEM)
            <textarea
              value={draft.certificate}
              onChange={(event) => setDraft({ ...draft, certificate: event.target.value })}
              rows={3}
              className="focus-ring w-full rounded-control border border-border bg-bg px-3 py-2 font-mono text-xs"
              placeholder="-----BEGIN CERTIFICATE-----"
            />

          </label>
          <label className="text-sm">
            SP entity id (optional)
            <Input
              value={draft.spEntityId}
              onChange={(event) => setDraft({ ...draft, spEntityId: event.target.value })}
            />
          </label>
          <label className="text-sm">
            ACS URL (optional)
            <Input
              value={draft.callbackUrl}
              onChange={(event) => setDraft({ ...draft, callbackUrl: event.target.value })}
            />
          </label>
          <label className="text-sm">
            Email attribute
            <Input
              value={draft.emailAttribute}
              onChange={(event) => setDraft({ ...draft, emailAttribute: event.target.value })}
              placeholder="email"
            />
          </label>
          <label className="text-sm">
            Groups attribute
            <Input
              value={draft.groupsAttribute}
              onChange={(event) => setDraft({ ...draft, groupsAttribute: event.target.value })}
              placeholder="groups"
            />
          </label>
          <label className="text-sm">
            Name attribute
            <Input
              value={draft.nameAttribute}
              onChange={(event) => setDraft({ ...draft, nameAttribute: event.target.value })}
              placeholder="name"
            />
          </label>
          <label className="text-sm">
            Role rules
            <Input
              value={draft.roleRules}
              onChange={(event) => setDraft({ ...draft, roleRules: event.target.value })}
              placeholder="eng:ADMIN,ops:MEMBER"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            Enabled
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <Button type="button" size="sm" disabled={pending} onClick={save}>
            {t(locale, "save")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={reset}>
            {t(locale, "cancel")}
          </Button>
        </div>
      </Card>

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
