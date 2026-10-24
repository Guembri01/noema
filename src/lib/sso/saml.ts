/**
 * Env-level SAML 2.0 connection (the deployment-default SP).
 *
 * The protocol itself is delegated to `@node-saml/node-saml` — this module only
 * owns the configuration, the profile/attribute mapping and the small pure
 * decisions the routes share. No XML signature, canonicalization or
 * XML-DSig code lives here (the SAML spec's iron law).
 *
 * A per-workspace `SsoConnection` model is still future work; this is the
 * env-level connection that mirrors the existing env-level OIDC one. The SAML
 * login still goes through the shared `linkOrCreate` rule, so an unverified
 * local account is never taken over by an assertion.
 */

import { createHash } from "node:crypto";
import { enabledStrategies, type AuthEnv, type AuthStrategy } from "../auth-strategies";

/** Default NameID format: the address itself. */
export const DEFAULT_SAML_NAME_ID_FORMAT =
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

/** Azure AD's default email attribute (the spec's documented default). */
export const DEFAULT_SAML_EMAIL_ATTRIBUTE =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";

/** Default display-name attribute. */
export const DEFAULT_SAML_NAME_ATTRIBUTE = "name";

/** Default group attribute. */
export const DEFAULT_SAML_GROUPS_ATTRIBUTE = "groups";

/** The absolute SP metadata path, relative to the request origin. */
export const SAML_METADATA_PATH = "/api/auth/saml/metadata";
/** The absolute ACS path, relative to the request origin. */
export const SAML_ACS_PATH = "/api/auth/saml/acs";
/** The absolute SLO path, relative to the request origin. */
export const SAML_SLO_PATH = "/api/auth/saml/slo";

/** Roles a SAML group rule may grant. OWNER is deliberately absent. */
export type SamlMappedRole = "MEMBER" | "ADMIN";

/** One ordered group→role rule. */
export type SamlRoleRule = { group: string; role: SamlMappedRole };

/** A resolved deployment connection. */
export type SamlSettings = {
  /** The IdP's entity id (also the expected assertion issuer). */
  idpEntityId: string;
  /** The IdP SSO endpoint (HTTP-Redirect binding). */
  ssoUrl: string;
  /** IdP signing certificate(s)/public key(s), PEM (rotation overlap). */
  idpCertificate: string | string[];
  /** Our entity id. */
  spEntityId: string;
  /** Our ACS URL. */
  callbackUrl: string;
  /** Optional IdP SLO endpoint. */
  logoutUrl?: string;
  /** Our SLO endpoint (advertised in metadata). */
  logoutCallbackUrl: string;
  /** NameID format requested from the IdP. */
  identifierFormat: string;
  /** Attribute carrying the email address. */
  emailAttribute: string;
  /** Attribute carrying the display name. */
  nameAttribute: string;
  /** Attribute carrying group membership. */
  groupsAttribute: string;
  /** Optional workspace every successful SAML login joins. */
  workspaceId?: string;
  /** Ordered group→role rules; highest privilege wins, OWNER is clamped. */
  roleRules: SamlRoleRule[];
  /** Optional SP private key + public cert for signing AuthnRequests/metadata. */
  signingKey?: string;
  spCertificate?: string;
  /** Optional SP private key + cert for decrypting encrypted assertions. */
  decryptionKey?: string;
  decryptionCertificate?: string;
};

/** The result of reading a SAML environment. */
export type SamlSettingsResult =
  | { ok: true; settings: SamlSettings }
  | { ok: false; reason: string };

/** Normalise PEM text from an env var (`\n` escapes included). */
export function normalizePem(value: string | undefined): string {
  return (value ?? "").replace(/\\n/g, "\n").trim();
}

/**
 * Parse `AUTH_SAML_ROLE_RULES`.
 *
 * Two shapes are accepted, both case-insensitive on the role:
 *   - JSON: `[{"group":"eng","role":"ADMIN"}]`
 *   - shorthand: `eng:ADMIN,ops:MEMBER`
 *
 * OWNER is never granted: an `OWNER` rule is clamped to `ADMIN` (ownership is
 * a human action, not a directory attribute). Unknown roles, empty groups and
 * malformed entries fail closed with a reason instead of being ignored.
 */
export function parseSamlRoleRules(
  raw: string | undefined,
): { ok: true; rules: SamlRoleRule[] } | { ok: false; reason: string } {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, rules: [] };

  const entries: { group: unknown; role: unknown }[] = [];
  if (text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: "AUTH_SAML_ROLE_RULES is not valid JSON." };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: "AUTH_SAML_ROLE_RULES must be a JSON array." };
    }
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) {
        return { ok: false, reason: "AUTH_SAML_ROLE_RULES entries must be objects." };
      }
      const record = entry as Record<string, unknown>;
      entries.push({ group: record.group, role: record.role });
    }
  } else {
    for (const part of text.split(",")) {
      const [group, role, ...rest] = part.split(":");
      if (rest.length > 0) {
        return {
          ok: false,
          reason: "AUTH_SAML_ROLE_RULES shorthand entries are `group:ROLE`.",
        };
      }
      entries.push({ group, role });
    }
  }

  const rules: SamlRoleRule[] = [];
  for (const entry of entries) {
    const group = typeof entry.group === "string" ? entry.group.trim() : "";
    if (!group) {
      return { ok: false, reason: "AUTH_SAML_ROLE_RULES has an empty group." };
    }
    const rawRole = typeof entry.role === "string" ? entry.role.trim().toUpperCase() : "";
    if (rawRole !== "MEMBER" && rawRole !== "ADMIN" && rawRole !== "OWNER") {
      return {
        ok: false,
        reason: `AUTH_SAML_ROLE_RULES has an unsupported role (${rawRole || "empty"}).`,
      };
    }
    rules.push({ group, role: rawRole === "MEMBER" ? "MEMBER" : "ADMIN" });
  }
  return { ok: true, rules };
}

/**
 * Highest-privilege rule wins. The default is MEMBER, and only ADMIN/MEMBER
 * can be returned — an OWNER rule was clamped when the rules were parsed.
 */
export function mapSamlGroupsToRole(
  rules: readonly SamlRoleRule[],
  groups: readonly string[],
): SamlMappedRole {
  if (rules.some((rule) => rule.role === "ADMIN" && groups.includes(rule.group))) {
    return "ADMIN";
  }
  return "MEMBER";
}

/** The group values from a SAML profile, as strings. */
export function samlGroups(
  profile: Record<string, unknown>,
  settings: SamlSettings,
): string[] {
  return samlValues(Array.isArray(profile.groups) ? profile.groups : profile[settings.groupsAttribute]);
}

/** First non-empty string in a value that may be a SAML multi-value array. */
export function firstSamlValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim().length > 0) return entry.trim();
    }
  }
  return undefined;
}

/** All non-empty strings in a SAML multi-value attribute. */
export function samlValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

/**
 * Read the env-level SAML connection. Required: the IdP SSO URL, the IdP
 * entity id and its signing certificate. The SP entity id/ACS default to the
 * request origin, so one deployment works on localhost and on its public host
 * without extra configuration; `AUTH_SAML_SP_ENTITY_ID` / `AUTH_SAML_CALLBACK_URL`
 * override them for reverse proxies whose external URL is not the request URL.
 */
export function resolveSamlSettings(
  env: AuthEnv,
  origin: string,
): SamlSettingsResult {
  const ssoUrl = env.AUTH_SAML_SSO_URL?.trim();
  const idpEntityId = env.AUTH_SAML_ENTITY_ID?.trim();
  const idpCertificate = normalizePem(env.AUTH_SAML_CERT);
  if (!ssoUrl || !idpEntityId || !idpCertificate) {
    return {
      ok: false,
      reason:
        "SAML is not configured: AUTH_SAML_SSO_URL, AUTH_SAML_ENTITY_ID and AUTH_SAML_CERT are required.",
    };
  }
  if (!/^https?:\/\//i.test(ssoUrl)) {
    return { ok: false, reason: "AUTH_SAML_SSO_URL must be an http(s) URL." };
  }

  const signingKey = normalizePem(env.AUTH_SAML_PRIVATE_KEY);
  const spCertificate = normalizePem(env.AUTH_SAML_SP_CERT);
  if (Boolean(signingKey) !== Boolean(spCertificate)) {
    return {
      ok: false,
      reason:
        "AUTH_SAML_PRIVATE_KEY and AUTH_SAML_SP_CERT must be set together (request/metadata signing), or both left empty.",
    };
  }

  const decryptionKey = normalizePem(env.AUTH_SAML_DECRYPTION_KEY);
  const decryptionCertificate = normalizePem(env.AUTH_SAML_DECRYPTION_CERT);
  if (Boolean(decryptionKey) !== Boolean(decryptionCertificate)) {
    return {
      ok: false,
      reason:
        "AUTH_SAML_DECRYPTION_KEY and AUTH_SAML_DECRYPTION_CERT must be set together (encrypted assertions), or both left empty.",
    };
  }

  const roleRules = parseSamlRoleRules(env.AUTH_SAML_ROLE_RULES);
  if (!roleRules.ok) return roleRules;

  const cleanOrigin = origin.replace(/\/+$/, "");
  const settings: SamlSettings = {
    idpEntityId,
    ssoUrl,
    idpCertificate,
    spEntityId:
      env.AUTH_SAML_SP_ENTITY_ID?.trim() || `${cleanOrigin}${SAML_METADATA_PATH}`,
    callbackUrl:
      env.AUTH_SAML_CALLBACK_URL?.trim() || `${cleanOrigin}${SAML_ACS_PATH}`,
    logoutCallbackUrl:
      env.AUTH_SAML_LOGOUT_CALLBACK_URL?.trim() || `${cleanOrigin}${SAML_SLO_PATH}`,
    identifierFormat:
      env.AUTH_SAML_NAME_ID_FORMAT?.trim() || DEFAULT_SAML_NAME_ID_FORMAT,
    emailAttribute:
      env.AUTH_SAML_EMAIL_ATTRIBUTE?.trim() || DEFAULT_SAML_EMAIL_ATTRIBUTE,
    nameAttribute:
      env.AUTH_SAML_NAME_ATTRIBUTE?.trim() || DEFAULT_SAML_NAME_ATTRIBUTE,
    groupsAttribute:
      env.AUTH_SAML_GROUPS_ATTRIBUTE?.trim() || DEFAULT_SAML_GROUPS_ATTRIBUTE,
    roleRules: roleRules.rules,
  };
  const workspaceId = env.AUTH_SAML_WORKSPACE_ID?.trim();
  if (workspaceId) settings.workspaceId = workspaceId;
  const logoutUrl = env.AUTH_SAML_LOGOUT_URL?.trim();
  if (logoutUrl) settings.logoutUrl = logoutUrl;
  if (signingKey) settings.signingKey = signingKey;
  if (spCertificate) settings.spCertificate = spCertificate;
  if (decryptionKey) settings.decryptionKey = decryptionKey;
  if (decryptionCertificate) settings.decryptionCertificate = decryptionCertificate;
  return { ok: true, settings };
}

/** Whether the deployment's `AUTH_STRATEGIES` gate still allows SAML. */
export function samlEnabled(env: AuthEnv): boolean {
  return enabledStrategies(env).some((strategy) => strategy.kind === "saml");
}

/**
 * Whether SAML is allowed when a workspace connection supplies the config.
 * The allow-list is authoritative; the env-level connection additionally needs
 * its `AUTH_SAML_*` settings (checked by {@link samlEnabled}).
 */
export function samlAllowedByStrategyList(env: AuthEnv): boolean {
  const entries = (env.AUTH_STRATEGIES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length === 0 || entries.includes("saml");
}

/** The registry-shaped strategy the shared identity/link code consumes. */
export function samlStrategy(settings: SamlSettings): AuthStrategy {
  return {
    id: "saml",
    label: "SAML SSO",
    kind: "saml",
    enabled: true,
    config: {
      entityId: settings.idpEntityId,
      ssoUrl: settings.ssoUrl,
      callbackPath: settings.callbackUrl,
    },
  };
}

/**
 * Map a `@node-saml/node-saml` profile to the shared identity profile.
 *
 * The configured email/name attributes win; standard claims and the NameID are
 * fallbacks. The NameID remains the stable external id, and groups are kept as
 * an array for the future per-workspace role mapper.
 */
export function samlIdentityProfile(
  profile: Record<string, unknown>,
  settings: SamlSettings,
): Record<string, unknown> {
  const nameId = firstSamlValue(profile.nameID);
  const email =
    firstSamlValue(profile[settings.emailAttribute]) ??
    firstSamlValue(profile.email) ??
    firstSamlValue(profile.mail) ??
    (nameId && nameId.includes("@") ? nameId : undefined);
  const name =
    firstSamlValue(profile[settings.nameAttribute]) ??
    firstSamlValue(profile.name) ??
    firstSamlValue(profile.displayName) ??
    undefined;
  const groups = samlValues(profile[settings.groupsAttribute]);

  return {
    ...profile,
    ...(nameId ? { nameID: nameId, externalId: nameId } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(groups.length > 0 ? { groups } : {}),
  };
}

/**
 * The assertion id when node-saml exposes one. `profile.ID` is not always
 * populated, but `profile.getAssertion()` returns the parsed assertion whose
 * `$` attributes carry `ID`.
 */
export function samlAssertionId(profile: Record<string, unknown>): string | null {
  const direct = firstSamlValue(profile.ID);
  if (direct) return direct;
  const getter = profile.getAssertion;
  if (typeof getter !== "function") return null;
  try {
    const assertion = (getter as () => unknown)();
    if (typeof assertion !== "object" || assertion === null) return null;
    const root = assertion as {
      $?: { ID?: unknown };
      Assertion?: { $?: { ID?: unknown } } | { $?: { ID?: unknown } }[];
    };
    const node = Array.isArray(root.Assertion) ? root.Assertion[0] : root.Assertion;
    return firstSamlValue(node?.$?.ID) ?? firstSamlValue(root.$?.ID) ?? null;
  } catch {
    return null;
  }
}

/**
 * The replay-cache key for one accepted response. The assertion id is the
 * stable key when node-saml exposes it (a re-encoded copy of the same signed
 * assertion then collides too); otherwise a SHA-256 of the exact
 * `SAMLResponse` payload is the privacy-preserving fallback.
 */
export function samlAssertionKey(profile: Record<string, unknown>, response: string): string {
  const id = samlAssertionId(profile);
  if (id) return `saml:${id}`;
  return `saml:${createHash("sha256").update(response).digest("hex")}`;
}


