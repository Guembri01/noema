/**
 * IdP metadata parsing for connection setup and certificate rotation (R10.17).
 * This only reads public metadata; signature/assertion validation remains in
 * `@node-saml/node-saml`.
 */

import { parseStringPromise } from "xml2js";

export type IdpMetadata = {
  entityId: string;
  ssoUrl: string;
  certificates: string[];
  logoutUrl?: string;
};

export type IdpMetadataResult =
  | { ok: true; metadata: IdpMetadata }
  | { ok: false; reason: string };

type XmlNode = Record<string, unknown>;

function asArray(value: unknown): XmlNode[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is XmlNode => typeof entry === "object" && entry !== null);
  }
  return typeof value === "object" && value !== null ? [value as XmlNode] : [];
}

function attrs(node: XmlNode): Record<string, string> {
  const value = node.$;
  return typeof value === "object" && value !== null ? (value as Record<string, string>) : {};
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "object" && value !== null) {
    const nested = value as XmlNode;
    if (typeof nested._ === "string") return nested._.trim();
  }
  return "";
}

/** Find the first EntityDescriptor that carries an IDPSSODescriptor. */
function findEntityDescriptor(root: XmlNode): XmlNode | null {
  const direct = asArray(root.EntityDescriptor);
  for (const descriptor of direct) {
    if (asArray(descriptor.IDPSSODescriptor).length > 0) return descriptor;
  }
  const federation = asArray(root.EntitiesDescriptor);
  for (const group of federation) {
    const found = findEntityDescriptor(group);
    if (found) return found;
  }
  return null;
}

function certificatePem(base64: string): string {
  const compact = base64.replace(/\s+/g, "");
  const lines = compact.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/** Parse an IdP metadata document into the fields a connection stores. */
export async function parseIdpMetadata(xml: string): Promise<IdpMetadataResult> {
  if (typeof xml !== "string" || xml.trim() === "") {
    return { ok: false, reason: "The IdP metadata is empty." };
  }
  let doc: XmlNode;
  try {
    doc = (await parseStringPromise(xml, { explicitArray: true, trim: true })) as XmlNode;
  } catch {
    return { ok: false, reason: "The IdP metadata is not valid XML." };
  }
  const root = doc.EntityDescriptor
    ? doc
    : (asArray(doc.EntitiesDescriptor)[0] ?? doc);
  const entity = findEntityDescriptor(root);
  if (!entity) return { ok: false, reason: "The metadata has no IDPSSODescriptor." };
  const entityId = attrs(entity).entityID ?? "";
  if (!entityId) return { ok: false, reason: "The metadata has no entityID." };

  const idp = asArray(entity.IDPSSODescriptor)[0];
  const ssoServices = asArray(idp.SingleSignOnService);
  const sso =
    ssoServices.find((service) =>
      /HTTP-Redirect$/i.test(attrs(service).Binding ?? ""),
    ) ??
    ssoServices.find((service) => /HTTP-POST$/i.test(attrs(service).Binding ?? "")) ??
    ssoServices[0];
  const ssoUrl = sso ? attrs(sso).Location ?? "" : "";
  if (!/^https?:\/\//i.test(ssoUrl)) {
    return { ok: false, reason: "The metadata has no usable SingleSignOnService URL." };
  }

  const certificates: string[] = [];
  for (const key of asArray(idp.KeyDescriptor)) {
    const use = attrs(key).use;
    if (use && use !== "signing") continue;
    for (const keyInfo of asArray(key.KeyInfo)) {
      for (const x509 of asArray(keyInfo.X509Data)) {
        const values = Array.isArray(x509.X509Certificate)
          ? x509.X509Certificate
          : [x509.X509Certificate];
        for (const cert of values) {
          const value = text(cert);
          if (value && !certificates.includes(certificatePem(value))) {
            certificates.push(certificatePem(value));
          }
        }
      }
    }
  }
  if (certificates.length === 0) {
    return { ok: false, reason: "The metadata has no signing certificate." };
  }

  const logout = asArray(idp.SingleLogoutService).find((service) =>
    /HTTP-Redirect$/i.test(attrs(service).Binding ?? ""),
  );
  const logoutUrl = logout ? attrs(logout).Location : undefined;

  return {
    ok: true,
    metadata: {
      entityId,
      ssoUrl,
      certificates,
      ...(logoutUrl ? { logoutUrl } : {}),
    },
  };
}
