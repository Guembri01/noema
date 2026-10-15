/**
 * Pure email-address helpers.
 *
 * Signup, login, invites and outbound mail all take an email today, and each
 * entry point re-implements the same shaggy regex (see the private
 * `normalizeEmail` in `server/actions/email.ts` and
 * `server/actions/teamspace-invites.ts`). This module centralises the
 * practical subset of RFC 5321/5322 the app actually needs, plus the small
 * hygiene checks a signup form wants (throwaway domains, role mailboxes and
 * "did you mean gmail.com" typo hints).
 *
 * Design rules:
 *
 * - **Practical, not pedantic.** Exactly one `@`; an ASCII local part
 *   (atext + `.`, no leading/trailing/double dots); dot-separated domain
 *   labels (1-63 chars, alphanumeric/hyphen, no edge hyphens) ending in an
 *   alphabetic TLD of at least two characters. Quoted local parts, comments
 *   and bare IP-literal domains are deliberately out of scope.
 * - **Untrusted input, fail-safe by contract.** Every value is `unknown` at
 *   runtime and nothing here ever throws: a non-string, an empty address or a
 *   pathological value is simply invalid/absent.
 * - **Local case is preserved.** `parseEmail`/`normalizeEmail` lowercase only
 *   the domain (case-insensitive by DNS) and keep the local part untouched, so
 *   `normalizeEmail` is a safe identity key rather than a mutating one. Plus
 *   tags are kept unless the caller explicitly opts into `stripPlus`.
 *
 * No DB, no routes, no React - a form can validate as it types and a server
 * action can re-validate with the exact same rules. Unit-pinned red-first by
 * `src/lib/email-validation.test.ts`.
 */

const LOCAL_MAX = 64;
const DOMAIN_MAX = 253;
const LABEL_MAX = 63;
const ADDRESS_MAX = 254;

/** RFC 5322 `atext` plus `.` - the characters we allow in a local part. */
const LOCAL_ALLOWED = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const LABEL_ALLOWED = /^[A-Za-z0-9-]+$/;
const TLD_ALLOWED = /^[A-Za-z]{2,}$/;

/** A parsed address; `domain` is lowercased, `local` is kept verbatim. */
export type ParsedEmail = {
  readonly local: string;
  readonly domain: string;
};

/** True when a local part is well-formed (`atext` runs joined by single dots). */
function isValidLocal(local: string): boolean {
  if (local.length === 0 || local.length > LOCAL_MAX) return false;
  if (local.startsWith(".") || local.endsWith(".")) return false;
  if (local.includes("..")) return false;
  return LOCAL_ALLOWED.test(local);
}

/** True when a domain has at least two valid labels and an alphabetic TLD. */
function isValidDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > DOMAIN_MAX) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  if (domain.includes("..")) return false;
  const labels = domain.split(".");
  // Require a registrable-ish name: `localhost` and `a@b` are not addresses we
  // would ever want to mail, so at least one dot is mandatory.
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > LABEL_MAX) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    if (!LABEL_ALLOWED.test(label)) return false;
  }
  return TLD_ALLOWED.test(labels[labels.length - 1]);
}

/**
 * Practical RFC-ish check for an email address. Surrounding whitespace is
 * trimmed (a paste/retype artefact); any interior whitespace is rejected.
 * Returns `false` - never throws - for non-strings and empty input.
 */
export function isValidEmail(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const email = value.trim();
  if (email.length === 0 || email.length > ADDRESS_MAX) return false;
  if (/\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  return (
    isValidLocal(email.slice(0, at)) &&
    isValidDomain(email.slice(at + 1))
  );
}

/**
 * Split a valid address into its local and domain parts, or `null` when it is
 * not valid. The domain is lowercased (DNS is case-insensitive) while the local
 * part keeps its case and any plus tag. Never throws.
 */
export function parseEmail(value: unknown): ParsedEmail | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (!isValidEmail(email)) return null;
  const at = email.indexOf("@");
  return {
    local: email.slice(0, at),
    domain: email.slice(at + 1).toLowerCase(),
  };
}

/** Drop everything from the first `+` in a local part (plus-addressing). */
function stripPlusTag(local: string): string {
  const plus = local.indexOf("+");
  return plus === -1 ? local : local.slice(0, plus);
}

/**
 * Canonical form of an address: trimmed, domain lowercased, local part kept
 * as-is (including its case and, by default, any `+tag`). Returns `null` for
 * anything invalid. Pass `{ stripPlus: true }` to fold `a+tag@x` onto `a@x`
 * for de-duplication - a lossy choice callers must opt into, since plus tags
 * are meaningful to many mailboxes.
 */
export function normalizeEmail(
  value: unknown,
  options: { stripPlus?: boolean } = {},
): string | null {
  const parsed = parseEmail(value);
  if (!parsed) return null;
  const local = options.stripPlus ? stripPlusTag(parsed.local) : parsed.local;
  if (local.length === 0) return null;
  return `${local}@${parsed.domain}`;
}

/** A small curated set of well-known throwaway/relay domains. */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com",
  "yopmail.com",
  "guerrillamail.com",
  "sharklasers.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "throwawaymail.com",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "fakeinbox.com",
  "maildrop.cc",
  "mailnesia.com",
]);

/**
 * Normalise a domain-ish input: trim, lowercase, take the part after the last
 * `@` (so a full address also works) and strip a leading `@` or stray dots.
 * Returns `null` when nothing usable remains.
 */
function domainKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let domain = value.trim().toLowerCase();
  const at = domain.lastIndexOf("@");
  if (at !== -1) domain = domain.slice(at + 1);
  domain = domain.replace(/^\.+/, "").replace(/\.+$/, "");
  return domain === "" ? null : domain;
}

/**
 * True when the domain (or any subdomain of it) is a known throwaway/relay
 * provider. Accepts a bare domain, a leading-`@` handle or a full address;
 * case-insensitive. Never throws.
 */
export function isDisposableDomain(domain: unknown): boolean {
  const key = domainKey(domain);
  if (key === null) return false;
  if (DISPOSABLE_DOMAINS.has(key)) return true;
  for (const candidate of DISPOSABLE_DOMAINS) {
    if (key.endsWith(`.${candidate}`)) return true;
  }
  return false;
}

/**
 * Common role mailboxes, stored without separators so `no-reply`, `no_reply`
 * and `noreply` all collapse to the same key.
 */
const ROLE_LOCALS: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "support",
  "help",
  "helpdesk",
  "sales",
  "info",
  "contact",
  "billing",
  "accounts",
  "finance",
  "noreply",
  "postmaster",
  "webmaster",
  "hostmaster",
  "abuse",
  "security",
  "privacy",
  "legal",
  "dmca",
  "root",
  "office",
  "hello",
  "team",
  "marketing",
  "newsletter",
  "notifications",
  "jobs",
  "careers",
  "hr",
  "feedback",
  "service",
]);

/**
 * True when a local part looks like a shared role mailbox rather than a person
 * (`admin`, `support`, `no-reply`, …). Case-insensitive, tolerates separators
 * and plus tags, and accepts a full address (only the local part is inspected).
 * Never throws.
 */
export function isRoleAddress(local: unknown): boolean {
  if (typeof local !== "string") return false;
  let key = local.trim().toLowerCase();
  const at = key.lastIndexOf("@");
  if (at !== -1) key = key.slice(0, at);
  const plus = key.indexOf("+");
  if (plus !== -1) key = key.slice(0, plus);
  key = key.replace(/[._-]+/g, "");
  return key !== "" && ROLE_LOCALS.has(key);
}

/** Common misspellings of popular consumer domains, typo → canonical. */
const DOMAIN_FIXES: Readonly<Record<string, string>> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmil.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.comm": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "homail.com": "hotmail.com",
  "hotmaill.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "yaho.com": "yahoo.com",
  "yahho.com": "yahoo.com",
  "yhoo.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "outlok.com": "outlook.com",
  "outllook.com": "outlook.com",
  "outloo.com": "outlook.com",
  "outlook.co": "outlook.com",
  "iclod.com": "icloud.com",
  "icoud.com": "icloud.com",
  "icloud.co": "icloud.com",
  "protonmai.com": "protonmail.com",
  "protonmail.co": "protonmail.com",
  "aol.co": "aol.com",
  "aol.con": "aol.com",
  "live.co": "live.com",
  "live.con": "live.com",
  "msn.con": "msn.com",
};

/**
 * Suggest a canonical domain for a common typo (`gmial.com` → `gmail.com`,
 * `hotmai.com` → `hotmail.com`). Accepts a bare domain, a leading-`@` handle or
 * a full address; case-insensitive. Returns a fresh array - `[]` when the
 * domain is unknown or already correct - so callers can render the hint
 * directly. Never throws.
 */
export function suggestDomainFixes(domain: unknown): string[] {
  const key = domainKey(domain);
  if (key === null) return [];
  const fix = DOMAIN_FIXES[key];
  return fix ? [fix] : [];
}
