/** DNS-verified email domains for SAML auto-join (R10.9). Pure helpers only. */

/** TXT owner name an admin publishes for a domain. */
export const DOMAIN_VERIFICATION_PREFIX = "_noema-verification";

/**
 * Normalise a domain: lowercase, no scheme/path, no `@local-part`, no trailing
 * dot. Returns `null` for anything that is not a plausible dotted hostname.
 */
export function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let domain = value.trim().toLowerCase();
  if (domain.includes("@")) domain = domain.slice(domain.lastIndexOf("@") + 1);
  domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (domain.length === 0 || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return null;
  }
  return domain;
}

/** The domain part of an email address, normalised, or `null`. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return normalizeDomain(email.slice(at + 1));
}

/** The DNS name the TXT token must be published at. */
export function verificationRecordName(domain: string): string {
  return `${DOMAIN_VERIFICATION_PREFIX}.${domain}`;
}

/**
 * Whether a DNS TXT answer set contains the expected token. `resolveTxt`
 * returns one array of chunks per record, so each record is joined first.
 */
export function hasVerificationToken(
  records: readonly (readonly string[])[],
  token: string,
): boolean {
  if (!token) return false;
  return records.some((chunks) => chunks.join("").replace(/^"|"$/g, "").trim() === token);
}
