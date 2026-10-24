"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import {
  createSsoConnectionAction,
  updateSsoConnectionAction,
  type SsoConnectionInput,
} from "@/server/actions/sso-connections";

export const EMPTY_SSO_CONNECTION: SsoConnectionInput = {
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

/**
 * The one SAML connection form. The settings index renders it for a new
 * connection; the per-connection page renders it with `connectionId` for edits,
 * so the field set and validation hints cannot drift between the two surfaces.
 */
export function SsoConnectionForm({
  workspaceId,
  locale,
  connectionId,
  initial,
  submitLabel,
  onCancel,
}: {
  workspaceId: string;
  locale: string;
  connectionId?: string;
  initial?: Partial<SsoConnectionInput>;
  submitLabel?: string;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const { run, pending, error } = useAction(locale);
  const [draft, setDraft] = useState<SsoConnectionInput>({
    ...EMPTY_SSO_CONNECTION,
    ...initial,
  });

  const save = () => {
    run(
      () =>
        connectionId
          ? updateSsoConnectionAction(workspaceId, connectionId, draft)
          : createSsoConnectionAction(workspaceId, draft),
      {
        success: connectionId ? "SAML connection updated" : "SAML connection created",
        onSuccess: () => {
          if (!connectionId) setDraft({ ...EMPTY_SSO_CONNECTION });
          router.refresh();
        },
      },
    );
  };

  return (
    <div>
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
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={save}>
          {submitLabel ?? t(locale, "save")}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t(locale, "cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}
