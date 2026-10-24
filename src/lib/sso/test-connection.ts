/**
 * Dry-run checks for a stored SAML connection.
 *
 * Nothing here mutates the connection and nothing sends a login request: the
 * function only inspects the stored fields, parses the public certificate and
 * (when a metadata URL is configured) fetches + parses that public document
 * through the outbound SSRF guard. The returned report never contains secret
 * material — certificate details are reduced to their validity window.
 */

import { X509Certificate } from "node:crypto";
import { safeFetchGuarded } from "@/lib/feed-guard";
import { parseIdpMetadata } from "./metadata";
import type {
  SsoConnectionTestCheck,
  SsoConnectionTestReport,
} from "./test-connection-types";
import {
  normalizePem,
  SAML_ACS_PATH,
  SAML_METADATA_PATH,
} from "./saml";

export type {
  SsoConnectionTestCheck,
  SsoConnectionTestReport,
} from "./test-connection-types";

/** The stored fields the dry run reads. Never a secret (the certificate is public). */
export type SsoConnectionTestSource = {
  id: string;
  protocol: string;
  idpEntityId: string | null;
  ssoUrl: string | null;
  certificate: string | null;
  metadataUrl: string | null;
  spEntityId: string | null;
  callbackUrl: string | null;
  emailAttribute: string | null;
  groupsAttribute: string | null;
};

export type SsoCertificateInspection =
  | { ok: true; validFrom: string; expiresAt: string }
  | { ok: false; reason: string };

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/;

/**
 * Parse the first PEM certificate in the stored value and check its validity
 * window. The report exposes dates only — never the certificate body.
 */
export function inspectSsoCertificate(
  value: string | null | undefined,
): SsoCertificateInspection {
  const pem = normalizePem(value ?? "");
  const match = PEM_CERTIFICATE.exec(pem);
  if (!match) {
    return { ok: false, reason: "The IdP certificate is missing or not PEM text." };
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(match[0]);
  } catch {
    return { ok: false, reason: "The IdP certificate could not be parsed." };
  }

  const validFrom = Date.parse(certificate.validFrom);
  const expiresAt = Date.parse(certificate.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(expiresAt)) {
    return { ok: false, reason: "The IdP certificate has no readable validity window." };
  }
  const now = Date.now();
  if (expiresAt <= now) {
    return {
      ok: false,
      reason: `The IdP certificate expired on ${new Date(expiresAt).toISOString().slice(0, 10)}.`,
    };
  }
  // A few seconds of clock drift is normal; a certificate that is not valid for
  // another five minutes is almost certainly the wrong file.
  if (validFrom > now + 5 * 60 * 1000) {
    return {
      ok: false,
      reason: `The IdP certificate is not valid before ${new Date(validFrom).toISOString().slice(0, 10)}.`,
    };
  }
  return {
    ok: true,
    validFrom: new Date(validFrom).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function asHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function canonicalCertificate(value: string): string {
  return normalizePem(value).replace(/\s+/g, "");
}

function check(
  id: string,
  label: string,
  passed: boolean,
  detail: string,
): SsoConnectionTestCheck {
  return { id, label, status: passed ? "pass" : "fail", detail };
}

/**
 * Run every dry check and return them in a stable order. Metadata checks are
 * appended only when a metadata URL is configured, so an absent URL is reported
 * as a pass with an explicit "manual fields" detail instead of a fake fetch.
 */
export async function testSsoConnection(
  connection: SsoConnectionTestSource,
  origin: string,
): Promise<SsoConnectionTestReport> {
  const checks: SsoConnectionTestCheck[] = [];
  const idpEntityId = (connection.idpEntityId ?? "").trim();
  const ssoUrl = (connection.ssoUrl ?? "").trim();
  const spEntityId =
    (connection.spEntityId ?? "").trim() || `${origin.replace(/\/+$/, "")}${SAML_METADATA_PATH}`;
  const acsUrl =
    (connection.callbackUrl ?? "").trim() || `${origin.replace(/\/+$/, "")}${SAML_ACS_PATH}`;
  const metadataUrl = (connection.metadataUrl ?? "").trim();
  const certificate = connection.certificate ?? "";

  checks.push(
    check(
      "protocol",
      "Connection uses SAML",
      connection.protocol === "saml",
      connection.protocol === "saml"
        ? "This connection is a SAML connection."
        : `This connection uses the unsupported protocol "${connection.protocol || "unknown"}".`,
    ),
  );

  checks.push(
    check(
      "idp-entity-id",
      "IdP entity id",
      Boolean(idpEntityId),
      idpEntityId ? "The IdP entity id is set." : "The IdP entity id is required.",
    ),
  );

  const ssoValid = Boolean(asHttpOrigin(ssoUrl));
  checks.push(
    check(
      "sso-url",
      "IdP SSO URL",
      ssoValid,
      !ssoUrl
        ? "The IdP SSO URL is required."
        : ssoValid
          ? "The IdP SSO URL is an http(s) URL."
          : "The IdP SSO URL must be an http(s) URL.",
    ),
  );

  const spEntityOrigin = asHttpOrigin(spEntityId);
  checks.push(
    check(
      "sp-entity-id",
      "SP entity id",
      Boolean(spEntityOrigin),
      spEntityOrigin
        ? "The SP entity id is an absolute http(s) URL."
        : "The SP entity id must be an absolute http(s) URL.",
    ),
  );

  const acsOrigin = asHttpOrigin(acsUrl);
  checks.push(
    check(
      "acs-url",
      "ACS URL",
      Boolean(acsOrigin),
      acsOrigin
        ? "The ACS URL is an absolute http(s) URL."
        : "The ACS URL must be an absolute http(s) URL.",
    ),
  );

  const consistentOrigins =
    Boolean(spEntityOrigin && acsOrigin) && spEntityOrigin === acsOrigin;
  checks.push(
    check(
      "sp-origin-consistency",
      "SP entity / ACS consistency",
      consistentOrigins,
      consistentOrigins
        ? "The SP entity id and ACS URL share an origin."
        : "The SP entity id and ACS URL must share an origin.",
    ),
  );

  const certificateStatus = inspectSsoCertificate(certificate);
  checks.push(
    check(
      "certificate",
      "IdP certificate",
      certificateStatus.ok,
      certificateStatus.ok
        ? `The certificate parses and is valid until ${certificateStatus.expiresAt.slice(0, 10)}.`
        : certificateStatus.reason,
    ),
  );

  if (!metadataUrl) {
    checks.push(
      check(
        "metadata-url",
        "IdP metadata URL",
        true,
        "No metadata URL configured; the manual IdP fields are used.",
      ),
    );
    return { passed: checks.every((entry) => entry.status === "pass"), checks };
  }

  if (!/^https:\/\//i.test(metadataUrl)) {
    checks.push(
      check(
        "metadata-url",
        "IdP metadata URL",
        false,
        "The metadata URL must be an https URL.",
      ),
    );
    return { passed: checks.every((entry) => entry.status === "pass"), checks };
  }

  let fetched: Awaited<ReturnType<typeof safeFetchGuarded>>;
  try {
    fetched = await safeFetchGuarded(metadataUrl, {
      headers: { accept: "application/samlmetadata+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    checks.push(
      check(
        "metadata-url",
        "IdP metadata URL",
        false,
        "The metadata URL could not be reached.",
      ),
    );
    return { passed: checks.every((entry) => entry.status === "pass"), checks };
  }
  if (!fetched.ok) {
    checks.push(
      check(
        "metadata-url",
        "IdP metadata URL",
        false,
        fetched.reason === "blocked"
          ? "The metadata URL was refused by the outbound network guard."
          : "The metadata URL could not be reached.",
      ),
    );
    return { passed: checks.every((entry) => entry.status === "pass"), checks };
  }
  if (!fetched.response.ok) {
    checks.push(
      check(
        "metadata-url",
        "IdP metadata URL",
        false,
        `The metadata URL answered ${fetched.response.status}.`,
      ),
    );
    return { passed: checks.every((entry) => entry.status === "pass"), checks };
  }

  let metadataXml: string;
  try {
    metadataXml = await fetched.response.text();
  } catch {
    checks.push(
      check(
        "metadata-url",
        "IdP metadata URL",
        false,
        "The metadata response could not be read.",
      ),
    );
    return { passed: checks.every((entry) => entry.status === "pass"), checks };
  }
  const parsed = await parseIdpMetadata(metadataXml);
  if (!parsed.ok) {
    checks.push(
      check(
        "metadata-url",
        "IdP metadata URL",
        false,
        parsed.reason,
      ),
    );
    return { passed: checks.every((entry) => entry.status === "pass"), checks };
  }

  checks.push(
    check(
      "metadata-url",
      "IdP metadata URL",
      true,
      "The metadata URL is reachable and returns a parseable IdP document.",
    ),
  );

  const entityMatches = parsed.metadata.entityId === idpEntityId;
  checks.push(
    check(
      "metadata-entity-id",
      "Metadata entity id",
      entityMatches,
      entityMatches
        ? "The metadata entity id matches the stored IdP entity id."
        : "The metadata entity id does not match the stored IdP entity id.",
    ),
  );

  const ssoMatches = parsed.metadata.ssoUrl === ssoUrl;
  checks.push(
    check(
      "metadata-sso-url",
      "Metadata SSO URL",
      ssoMatches,
      ssoMatches
        ? "The metadata SSO URL matches the stored SSO URL."
        : "The metadata SSO URL does not match the stored SSO URL.",
    ),
  );

  const storedCertificate = certificateStatus.ok ? canonicalCertificate(certificate) : "";
  const certificateMatches = parsed.metadata.certificates.some(
    (candidate) => canonicalCertificate(candidate) === storedCertificate,
  );
  checks.push(
    check(
      "metadata-certificate",
      "Metadata signing certificate",
      certificateMatches,
      certificateMatches
        ? "The metadata signing certificate matches the stored certificate."
        : "The metadata signing certificate does not match the stored certificate.",
    ),
  );

  return { passed: checks.every((entry) => entry.status === "pass"), checks };
}
