/**
 * Per-workspace SAML connection → the same {@link SamlSettings} shape the
 * env-level flow consumes. A row carries only public IdP material (entity id,
 * SSO URL, certificate); private SP keys are not persisted in this slice.
 */

import {
  DEFAULT_SAML_EMAIL_ATTRIBUTE,
  DEFAULT_SAML_GROUPS_ATTRIBUTE,
  DEFAULT_SAML_NAME_ATTRIBUTE,
  DEFAULT_SAML_NAME_ID_FORMAT,
  normalizePem,
  parseSamlRoleRules,
  SAML_ACS_PATH,
  SAML_METADATA_PATH,
  SAML_SLO_PATH,
  type SamlSettings,
} from "./saml";

/** The fields the route/action layer reads from an `SsoConnection` row. */
export type SsoConnectionRow = {
  id: string;
  workspaceId: string;
  name: string;
  protocol: string;
  idpEntityId: string;
  ssoUrl: string;
  certificate: string;
  prevCertificate: string | null;
  prevCertificateExpiresAt: Date | null;
  metadataUrl: string | null;
  metadataFetchedAt: Date | null;
  spEntityId: string | null;
  callbackUrl: string | null;
  emailAttribute: string | null;
  nameAttribute: string | null;
  groupsAttribute: string | null;
  roleRules: unknown;
  enabled: boolean;
};

export type SsoConnectionSettings =
  | { ok: true; settings: SamlSettings; connectionId: string; name: string }
  | { ok: false; reason: string };

/**
 * Resolve one DB connection against the request origin. The connection's own
 * workspace is the auto-join target; role rules travel as stored JSON.
 */
export function settingsFromSsoConnection(
  row: SsoConnectionRow,
  origin: string,
): SsoConnectionSettings {
  if (row.protocol !== "saml") {
    return { ok: false, reason: "This connection is not a SAML connection." };
  }
  if (!row.enabled) {
    return { ok: false, reason: "This SAML connection is disabled." };
  }
  if (!row.ssoUrl?.trim() || !row.idpEntityId?.trim() || !row.certificate?.trim()) {
    return { ok: false, reason: "This SAML connection is incomplete." };
  }
  if (!/^https?:\/\//i.test(row.ssoUrl)) {
    return { ok: false, reason: "This SAML connection has an invalid SSO URL." };
  }

  const rawRules =
    row.roleRules === null || row.roleRules === undefined
      ? ""
      : JSON.stringify(row.roleRules);
  const rules = parseSamlRoleRules(rawRules);
  if (!rules.ok) return { ok: false, reason: rules.reason };

  const cleanOrigin = origin.replace(/\/+$/, "");
  const certificates = [normalizePem(row.certificate)];
  if (
    row.prevCertificate &&
    (!row.prevCertificateExpiresAt || row.prevCertificateExpiresAt.getTime() > Date.now())
  ) {
    certificates.push(normalizePem(row.prevCertificate));
  }
  return {
    ok: true,
    connectionId: row.id,
    name: row.name,
    settings: {
      idpEntityId: row.idpEntityId.trim(),
      ssoUrl: row.ssoUrl.trim(),
      idpCertificate: certificates.length === 1 ? certificates[0] : certificates,
      spEntityId: row.spEntityId?.trim() || `${cleanOrigin}${SAML_METADATA_PATH}`,
      callbackUrl: row.callbackUrl?.trim() || `${cleanOrigin}${SAML_ACS_PATH}`,
      logoutCallbackUrl: `${cleanOrigin}${SAML_SLO_PATH}?connection=${encodeURIComponent(row.id)}`,
      identifierFormat: DEFAULT_SAML_NAME_ID_FORMAT,
      emailAttribute: row.emailAttribute?.trim() || DEFAULT_SAML_EMAIL_ATTRIBUTE,
      nameAttribute: row.nameAttribute?.trim() || DEFAULT_SAML_NAME_ATTRIBUTE,
      groupsAttribute: row.groupsAttribute?.trim() || DEFAULT_SAML_GROUPS_ATTRIBUTE,
      roleRules: rules.rules,
      workspaceId: row.workspaceId,
    },
  };
}
