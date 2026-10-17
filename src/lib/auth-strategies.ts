import { randomBytes } from "node:crypto";
import {
  PASSWORD_POLICY,
  isCommonPassword,
  type PasswordPolicy,
} from "./password-policy";

/**
 * §17 Authentication "providers limited" — a provider-agnostic sign-in
 * strategy layer.
 *
 * Sign-in used to be one password form plus a hard-wired OIDC callback. This
 * module turns "how can a user sign in" into data: a {@link STRATEGIES}
 * registry of descriptors (`password`, `oidc`, `saml`, `magic-link`,
 * `passkey`) with the pure decisions that sit around them —
 * {@link validatePassword}, {@link startLogin}, {@link validateCallback},
 * {@link normalizeIdentity}, {@link linkOrCreate}, {@link describeStrategy} and
 * {@link enabledStrategies}.
 *
 * Everything here is deterministic and free of I/O: the clock is injected as
 * `now`, login randomness as `random`, and the provider profile/params arrive
 * as plain records. That keeps every branch unit-testable and lets the same
 * code run on the server (authoritative) and the client (preview). Nothing
 * throws on hostile input — a malformed password, callback or profile degrades
 * to a failing result, never an exception.
 */

/** The sign-in mechanisms the layer understands. */
export type AuthKind = "password" | "oidc" | "saml" | "magic-link" | "passkey";

/**
 * Provider connection details. Every field is optional: a descriptor can exist
 * before it is configured, and {@link enabledStrategies} decides whether a
 * configured environment actually turns it on.
 */
export type AuthStrategyConfig = {
  /** OIDC authorize endpoint. */
  authorizationUrl?: string;
  /** OIDC token endpoint. */
  tokenUrl?: string;
  /** OIDC userinfo endpoint. */
  userInfoUrl?: string;
  /** OIDC issuer identifier. */
  issuer?: string;
  /** OAuth/OIDC client id. */
  clientId?: string;
  /** Requested OIDC scopes; defaults to `openid email profile`. */
  scopes?: readonly string[];
  /** SAML identity-provider entity id. */
  entityId?: string;
  /** SAML single-sign-on endpoint. */
  ssoUrl?: string;
  /** SAML signing certificate (PEM). */
  certificate?: string;
  /** Magic-link validity window, in seconds. */
  ttlSeconds?: number;
  /** WebAuthn relying-party id. */
  rpId?: string;
  /** WebAuthn relying-party display name. */
  rpName?: string;
  /** Same-origin path the provider returns to. */
  callbackPath?: string;
};

/** One way to sign in. */
export type AuthStrategy = {
  /** Stable identifier, e.g. `"password"` or `"google"`. */
  id: string;
  /** Human label, e.g. `"Google"`. */
  label: string;
  kind: AuthKind;
  /** Whether the layer supports this strategy at all. */
  enabled: boolean;
  config: AuthStrategyConfig;
};

/**
 * A registry entry: an {@link AuthStrategy} plus the password policy that
 * applies when this strategy sets a password (only the `password` kind does).
 */
export type StrategyDefinition = AuthStrategy & {
  passwordPolicy?: Partial<PasswordPolicy>;
};

/** Default scopes for an OIDC strategy. */
export const DEFAULT_OIDC_SCOPES: readonly string[] = ["openid", "email", "profile"];

/** Same-origin fallback when no (safe) `returnTo` is supplied. */
export const DEFAULT_RETURN_TO = "/";

/** Hard upper bound on password length; beyond this there is only DoS value. */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Canonical registry. Endpoints are the providers' well-known public
 * authorize hosts; credentials (`clientId`, `ssoUrl`, …) are supplied by the
 * environment at deploy time, which is why a descriptor can ship with an empty
 * `config` and still be valid.
 */
export const STRATEGIES: readonly StrategyDefinition[] = [
  {
    id: "password",
    label: "Email and password",
    kind: "password",
    enabled: true,
    config: {},
    passwordPolicy: { ...PASSWORD_POLICY },
  },
  {
    id: "google",
    label: "Google",
    kind: "oidc",
    enabled: true,
    config: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      issuer: "https://accounts.google.com",
      scopes: DEFAULT_OIDC_SCOPES,
      callbackPath: "/api/auth/callback/google",
    },
  },
  {
    id: "microsoft",
    label: "Microsoft",
    kind: "oidc",
    enabled: true,
    config: {
      authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      issuer: "https://login.microsoftonline.com/common/v2.0",
      scopes: DEFAULT_OIDC_SCOPES,
      callbackPath: "/api/auth/callback/microsoft",
    },
  },
  {
    id: "saml",
    label: "SAML SSO",
    kind: "saml",
    enabled: true,
    config: { callbackPath: "/api/auth/saml/callback" },
  },
  {
    id: "magic-link",
    label: "Magic link",
    kind: "magic-link",
    enabled: true,
    config: { ttlSeconds: 900, callbackPath: "/api/auth/magic-link/callback" },
  },
  {
    id: "passkey",
    label: "Passkey",
    kind: "passkey",
    enabled: true,
    config: { rpName: "Noema", callbackPath: "/api/auth/passkey/callback" },
  },
];

/** The registry entry with `id`, if any. */
export function getStrategy(id: string): StrategyDefinition | undefined {
  return STRATEGIES.find((strategy) => strategy.id === id);
}

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

/**
 * Why a password was rejected, in the stable order {@link validatePassword}
 * reports them. `empty` and `not_a_string` short-circuit and are the only
 * element when they appear.
 */
export type PasswordIssueCode =
  | "empty"
  | "not_a_string"
  | "too_short"
  | "too_long"
  | "missing_lower"
  | "missing_upper"
  | "missing_digit"
  | "missing_symbol"
  | "common"
  | "similar_to_email";

/** Options for {@link validatePassword}. */
export type PasswordValidationOptions = {
  /** Overrides for the default policy (see `PASSWORD_POLICY`). */
  policy?: Partial<PasswordPolicy>;
  /** The account email, checked for similarity. */
  email?: string;
  /** Extra denylisted passwords beyond the built-in list. */
  commonPasswords?: readonly string[];
};

/** Result of {@link validatePassword}. */
export type PasswordValidationResult = {
  ok: boolean;
  issues: PasswordIssueCode[];
};

const LOWERCASE = /[a-z]/;
const UPPERCASE = /[A-Z]/;
const DIGIT = /[0-9]/;
const SYMBOL = /[^A-Za-z0-9]/;

/** Resolve a partial policy against {@link PASSWORD_POLICY}. */
function resolvePolicy(policy?: Partial<PasswordPolicy>): PasswordPolicy {
  const source: Partial<PasswordPolicy> = policy ?? {};
  const minLength =
    typeof source.minLength === "number" &&
    Number.isInteger(source.minLength) &&
    source.minLength >= 1
      ? source.minLength
      : PASSWORD_POLICY.minLength;
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
  return {
    minLength,
    requireUpper: bool(source.requireUpper, PASSWORD_POLICY.requireUpper),
    requireLower: bool(source.requireLower, PASSWORD_POLICY.requireLower),
    requireDigit: bool(source.requireDigit, PASSWORD_POLICY.requireDigit),
    requireSymbol: bool(source.requireSymbol, PASSWORD_POLICY.requireSymbol),
    forbidCommon: bool(source.forbidCommon, PASSWORD_POLICY.forbidCommon),
  };
}

/** True when the caller-supplied denylist contains `password` (case-insensitive). */
function isListedCommon(password: string, list?: readonly string[]): boolean {
  if (!list || list.length === 0) return false;
  const candidate = password.trim().toLowerCase();
  return list.some((entry) => entry.trim().toLowerCase() === candidate);
}

/**
 * Whether `password` is too similar to `email` to be allowed: equal to the
 * whole address or its local part, or containing/contained by a local part of
 * at least four characters. Case-insensitive; falsey/unrelated inputs are safe.
 */
export function isSimilarToEmail(password: unknown, email: unknown): boolean {
  if (typeof password !== "string" || typeof email !== "string") return false;
  const pw = password.trim().toLowerCase();
  const mail = email.trim().toLowerCase();
  const at = mail.indexOf("@");
  if (!pw || at <= 0) return false;
  const local = mail.slice(0, at);
  if (!local) return false;
  if (pw === mail || pw === local) return true;
  if (local.length >= 4 && pw.includes(local)) return true;
  if (pw.length >= 4 && local.includes(pw)) return true;
  return false;
}

/**
 * Validate `password` against `policy` (defaults to the built-in policy),
 * returning every failing {@link PasswordIssueCode} rather than the first.
 * Non-string input yields `["not_a_string"]`; empty input yields `["empty"]`.
 */
export function validatePassword(
  password: unknown,
  options: PasswordValidationOptions = {},
): PasswordValidationResult {
  if (typeof password !== "string") {
    return { ok: false, issues: ["not_a_string"] };
  }
  if (password.length === 0) {
    return { ok: false, issues: ["empty"] };
  }
  const policy = resolvePolicy(options.policy);
  const issues: PasswordIssueCode[] = [];
  if (password.length < policy.minLength) issues.push("too_short");
  if (password.length > MAX_PASSWORD_LENGTH) issues.push("too_long");
  if (policy.requireLower && !LOWERCASE.test(password)) issues.push("missing_lower");
  if (policy.requireUpper && !UPPERCASE.test(password)) issues.push("missing_upper");
  if (policy.requireDigit && !DIGIT.test(password)) issues.push("missing_digit");
  if (policy.requireSymbol && !SYMBOL.test(password)) issues.push("missing_symbol");
  if (
    policy.forbidCommon &&
    (isCommonPassword(password) || isListedCommon(password, options.commonPasswords))
  ) {
    issues.push("common");
  }
  if (isSimilarToEmail(password, options.email)) issues.push("similar_to_email");
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Login start
// ---------------------------------------------------------------------------

/** Injected randomness: return `bytes` of entropic text. */
export type RandomFn = (bytes: number) => string;

/** Options for {@link startLogin}. */
export type StartLoginOptions = {
  /** Same-origin path to return to after the callback. */
  returnTo?: string;
  /** Injectable randomness; defaults to `crypto.randomBytes`. */
  random?: RandomFn;
};

/** Result of {@link startLogin}. */
export type LoginStart = {
  redirectUrl: string;
  state: string;
  nonce: string;
};

/** Default start path per kind, used when the strategy has no URL configured. */
const START_PATHS: Record<AuthKind, string> = {
  password: "/login",
  oidc: "/api/auth/oidc/start",
  saml: "/api/auth/saml/start",
  "magic-link": "/api/auth/magic-link/start",
  passkey: "/api/auth/passkey/start",
};

const STATE_BYTES = 16;

function defaultRandom(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** Append `params` to an absolute URL or a same-origin path, skipping unset values. */
function withParams(base: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  if ([...search].length === 0) return base;
  const query = search.toString();
  if (/^https?:\/\//i.test(base)) {
    const url = new URL(base);
    search.forEach((value, key) => url.searchParams.set(key, value));
    return url.toString();
  }
  return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

/**
 * Begin sign-in for `strategy`: mint a `state`/`nonce` pair and build the
 * redirect the caller should send the browser to. Randomness is injected, so
 * the same inputs plus the same `random` always produce the same result. An
 * unsafe `returnTo` (absolute, protocol-relative, backslash-prefixed) is
 * replaced with {@link DEFAULT_RETURN_TO}, so a crafted value never leaks
 * off-origin into the redirect.
 */
export function startLogin(
  strategy: AuthStrategy,
  options: StartLoginOptions = {},
): LoginStart {
  const random = options.random ?? defaultRandom;
  const state = random(STATE_BYTES);
  const nonce = random(STATE_BYTES);
  const requested = typeof options.returnTo === "string" ? options.returnTo.trim() : "";
  const returnTo = isSafeReturnTo(requested) ? requested : DEFAULT_RETURN_TO;
  const base =
    strategy.kind === "saml"
      ? (strategy.config.ssoUrl ?? START_PATHS.saml)
      : (strategy.config.authorizationUrl ?? START_PATHS[strategy.kind]);

  let redirectUrl: string;
  switch (strategy.kind) {
    case "password":
      redirectUrl = withParams(START_PATHS.password, { returnTo });
      break;
    case "oidc":
      redirectUrl = withParams(base, {
        response_type: "code",
        client_id: strategy.config.clientId,
        redirect_uri: strategy.config.callbackPath,
        scope: (strategy.config.scopes ?? DEFAULT_OIDC_SCOPES).join(" "),
        state,
        nonce,
      });
      break;
    case "saml":
      redirectUrl = withParams(base, { RelayState: state });
      break;
    case "magic-link":
      redirectUrl = withParams(base, { state, returnTo });
      break;
    case "passkey":
      redirectUrl = withParams(base, { state });
      break;
  }

  return { redirectUrl, state, nonce };
}

// ---------------------------------------------------------------------------
// Callback validation
// ---------------------------------------------------------------------------

/** The query parameters a provider sends back (missing keys are `undefined`). */
export type CallbackParams = Record<string, string | undefined>;

/** What the server remembered when it called {@link startLogin}. */
export type CallbackExpectation = {
  /** The state minted by {@link startLogin}. */
  state: string;
  /** The nonce minted by {@link startLogin} (OIDC only). */
  nonce?: string;
  /** Server-side remembered return path, used when params omit one. */
  returnTo?: string;
  /** Allowed same-origin path prefixes; empty means "any safe path". */
  allowedReturnTo?: readonly string[];
};

/** Why a callback was rejected. */
export type CallbackIssue =
  | "provider_error"
  | "missing_state"
  | "state_mismatch"
  | "missing_nonce"
  | "nonce_mismatch"
  | "missing_code"
  | "return_to_not_allowed";

/** Result of {@link validateCallback}. */
export type CallbackValidation = {
  ok: boolean;
  issues: CallbackIssue[];
  code?: string;
  returnTo?: string;
};

/** Credential parameter names that satisfy a callback, per kind. */
const CREDENTIAL_KEYS: Record<AuthKind, readonly string[]> = {
  password: [],
  oidc: ["code"],
  saml: ["SAMLResponse", "code"],
  "magic-link": ["token"],
  passkey: [],
};

/**
 * Whether `value` is a safe same-origin redirect target: it must start with a
 * single `/`, contain no backslash or control characters, and stay internal
 * even after percent-decoding (so `/%2F%2Fevil` cannot smuggle an absolute
 * URL past a later `new URL(...)`).
 */
export function isSafeReturnTo(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return false;
  if (trimmed.startsWith("//")) return false;
  if (trimmed.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return false;
  }
  return !decoded.startsWith("//") && !decoded.includes("\\");
}

/** True when `value` equals or sits under one of the allowed prefixes. */
function isAllowedReturnTo(value: string, allowed?: readonly string[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.some((prefix) => {
    const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return value === normalized || value.startsWith(`${normalized}/`);
  });
}

/** First present, non-empty value among `keys`. */
function presentParam(params: CallbackParams, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Verify a provider callback against what {@link startLogin} remembered: the
 * `state` must match, the `nonce` must match when one was expected, the
 * credential must be present, and the resolved `returnTo` must be a safe,
 * allow-listed path. The result carries the `code` and the resolved `returnTo`
 * only when the callback is valid; a rejected callback never yields a redirect
 * target, so a tampered `returnTo` cannot become an open redirect.
 */
export function validateCallback(
  strategy: AuthStrategy,
  options: { params: CallbackParams; expected: CallbackExpectation },
): CallbackValidation {
  const { params, expected } = options;
  const issues: CallbackIssue[] = [];

  if (typeof params.error === "string" && params.error.length > 0) {
    issues.push("provider_error");
  }

  if (!params.state) {
    issues.push("missing_state");
  } else if (params.state !== expected.state) {
    issues.push("state_mismatch");
  }

  if (expected.nonce !== undefined) {
    if (!params.nonce) {
      issues.push("missing_nonce");
    } else if (params.nonce !== expected.nonce) {
      issues.push("nonce_mismatch");
    }
  }

  const code = presentParam(params, CREDENTIAL_KEYS[strategy.kind]);
  if (CREDENTIAL_KEYS[strategy.kind].length > 0 && code === undefined) {
    issues.push("missing_code");
  }

  const candidate = params.returnTo ?? expected.returnTo;
  let returnTo: string | undefined;
  if (typeof candidate === "string" && candidate.length > 0) {
    const trimmed = candidate.trim();
    if (!isSafeReturnTo(trimmed) || !isAllowedReturnTo(trimmed, expected.allowedReturnTo)) {
      issues.push("return_to_not_allowed");
    } else {
      returnTo = trimmed;
    }
  }

  const result: CallbackValidation = { ok: issues.length === 0, issues };
  if (code !== undefined) result.code = code;
  if (returnTo !== undefined) result.returnTo = returnTo;
  return result;
}

// ---------------------------------------------------------------------------
// Identity normalization
// ---------------------------------------------------------------------------

/** A raw provider profile (OIDC claims, SAML attributes, local form fields). */
export type IdentityProfile = Record<string, unknown>;

/** The one shape the rest of the app links and creates accounts from. */
export type Identity = {
  email: string;
  name: string;
  avatarUrl?: string;
  externalId: string;
};

const EMAIL_KEYS: readonly string[] = [
  "email",
  "mail",
  "e-mail",
  "emailAddress",
  "email_address",
  "urn:oid:0.9.2342.19200300.100.1.3",
];

const NAME_KEYS: readonly string[] = [
  "name",
  "displayName",
  "display_name",
  "fullName",
  "full_name",
  "cn",
  "urn:oid:2.16.840.1.113730.3.1.241",
];

const AVATAR_KEYS: readonly string[] = [
  "avatarUrl",
  "avatar_url",
  "picture",
  "avatar",
  "image",
  "photo",
];

const EXTERNAL_ID_KEYS: Record<AuthKind, readonly string[]> = {
  password: [],
  oidc: ["sub", "id", "externalId", "external_id", "oid"],
  saml: ["nameID", "nameId", "name_id", "NameID", "subject", "id"],
  "magic-link": [],
  passkey: ["credentialId", "credential_id", "credentialID", "id", "externalId"],
};

/** First non-empty string among `keys`, trimmed. */
function stringField(profile: IdentityProfile, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Map a provider profile onto the shared {@link Identity} shape. The email is
 * lower-cased; the name falls back to the email local part; the avatar is only
 * present when the provider supplied one; the external id is the provider's
 * stable subject (`sub` / `nameID` / credential id), falling back to the email
 * for password and magic-link sign-in. Missing fields degrade to `""` rather
 * than throwing — {@link linkOrCreate} decides what a missing email means.
 */
export function normalizeIdentity(
  strategy: AuthStrategy,
  profile: IdentityProfile,
): Identity {
  const rawEmail = stringField(profile, EMAIL_KEYS);
  const email = rawEmail ? rawEmail.toLowerCase() : "";
  const rawName = stringField(profile, NAME_KEYS);
  const name = rawName ?? (email ? email.split("@")[0] : "");
  const avatarUrl = stringField(profile, AVATAR_KEYS);
  const externalId =
    stringField(profile, EXTERNAL_ID_KEYS[strategy.kind]) ?? email;

  const identity: Identity = { email, name, externalId };
  if (avatarUrl) identity.avatarUrl = avatarUrl;
  return identity;
}

// ---------------------------------------------------------------------------
// Account linking
// ---------------------------------------------------------------------------

/** Any accepted clock input; normalised to epoch milliseconds internally. */
export type TimeInput = number | string | Date;

/** A local account, as much of it as linking needs to see. */
export type ExistingUser = {
  id: string;
  email: string;
  emailVerified?: boolean;
  /** Provider subjects already bound to this account. */
  externalIds?: readonly string[];
};

/** Input to {@link linkOrCreate}. */
export type LinkOrCreateInput = {
  existingUsers: readonly ExistingUser[];
  identity: Identity;
  /** The strategy performing the sign-in; drives email-trust defaults. */
  strategy: AuthStrategy;
  /** Injected clock. */
  now: TimeInput;
  /** Whether the provider asserts the email is verified; defaults per kind. */
  emailVerified?: boolean;
};

/** Why {@link linkOrCreate} reached its decision. */
export type LinkDecisionReason =
  | "external_id_match"
  | "email_match"
  | "new_identity"
  | "email_taken_unverified"
  | "external_id_conflict"
  | "missing_email";

/** The link/create/conflict decision. */
export type LinkDecision =
  | { action: "link"; userId: string; reason: LinkDecisionReason; at: string }
  | {
      action: "create";
      reason: LinkDecisionReason;
      emailVerified: boolean;
      at: string;
    }
  | {
      action: "conflict";
      reason: LinkDecisionReason;
      existingUserId?: string;
      at: string;
    };

/** Normalise any `TimeInput` to epoch ms; a bad value is a programming error. */
function asMillis(input: TimeInput, label = "now"): number {
  const ms =
    typeof input === "number"
      ? input
      : input instanceof Date
        ? input.getTime()
        : Date.parse(input);
  if (!Number.isFinite(ms)) {
    throw new RangeError(`Invalid ${label}: ${String(input)}`);
  }
  return ms;
}

/**
 * Whether a provider of `kind` is trusted to assert the user's email address.
 * OIDC and SAML are signed assertion flows and a magic link is only delivered
 * to the mailbox itself, so all three vouch for the email; a local password
 * registration and a raw passkey are not email proofs.
 */
export function trustsProviderEmail(kind: AuthKind): boolean {
  return kind === "oidc" || kind === "saml" || kind === "magic-link";
}

/** Lower-cased, trimmed comparison key for an email. */
const emailKey = (email: string): string => email.trim().toLowerCase();

/**
 * Decide what to do with a freshly normalised {@link Identity} against the
 * accounts that already exist:
 *
 *  1. a matching external id links, even across an email change (the provider
 *     subject is the durable key) — but only if the trusted email does not
 *     point at a different account, which is a hard conflict;
 *  2. otherwise a matching email links when it is already verified or the
 *     provider vouches for it; an unverified local account plus an untrusted
 *     provider is a conflict (never auto-link, which would be account
 *     takeover);
 *  3. otherwise the identity is new and gets created — an email is required.
 *
 * Pure: the inputs are never mutated and `now` is stamped onto the decision.
 */
export function linkOrCreate(input: LinkOrCreateInput): LinkDecision {
  const at = new Date(asMillis(input.now)).toISOString();
  const email = emailKey(input.identity.email);
  const externalId = input.identity.externalId.trim();
  const trusted = input.emailVerified ?? trustsProviderEmail(input.strategy.kind);

  const byExternal = externalId
    ? input.existingUsers.filter((user) =>
        (user.externalIds ?? []).some((candidate) => candidate === externalId),
      )
    : [];
  const byEmail = email
    ? input.existingUsers.filter((user) => emailKey(user.email) === email)
    : [];

  const externalUser = byExternal[0];
  if (externalUser) {
    const conflictingEmail = byEmail.find((user) => user.id !== externalUser.id);
    if (conflictingEmail && trusted) {
      return {
        action: "conflict",
        reason: "external_id_conflict",
        existingUserId: externalUser.id,
        at,
      };
    }
    return { action: "link", userId: externalUser.id, reason: "external_id_match", at };
  }

  const emailUser = byEmail[0];
  if (emailUser) {
    if (emailUser.emailVerified || trusted) {
      return { action: "link", userId: emailUser.id, reason: "email_match", at };
    }
    return {
      action: "conflict",
      reason: "email_taken_unverified",
      existingUserId: emailUser.id,
      at,
    };
  }

  if (!email) {
    return { action: "conflict", reason: "missing_email", at };
  }
  return { action: "create", reason: "new_identity", emailVerified: trusted, at };
}

// ---------------------------------------------------------------------------
// Descriptions & environment gating
// ---------------------------------------------------------------------------

/** A strategy rendered for a sign-in page or a settings list. */
export type StrategyDescription = {
  id: string;
  label: string;
  kind: AuthKind;
  enabled: boolean;
  /** One sentence a UI can show under the button. */
  description: string;
  /** Whether the flow leaves the origin (false for password/passkey). */
  redirects: boolean;
  /** The strategy's password policy, or `null` when it takes no password. */
  passwordPolicy: Partial<PasswordPolicy> | null;
};

const REDIRECTING_KINDS: ReadonlySet<AuthKind> = new Set<AuthKind>([
  "oidc",
  "saml",
  "magic-link",
]);

/** The sentence {@link describeStrategy} renders for a kind. */
function describeKind(strategy: AuthStrategy): string {
  switch (strategy.kind) {
    case "password":
      return "Sign in with an email address and password.";
    case "oidc":
      return `Sign in with ${strategy.label} using OpenID Connect.`;
    case "saml":
      return `Sign in with ${strategy.label} using SAML 2.0.`;
    case "magic-link":
      return "Sign in with a one-time link sent to your email.";
    case "passkey":
      return "Sign in with a passkey (WebAuthn).";
  }
}

/** Render a strategy for the UI without exposing its raw config. */
export function describeStrategy(strategy: StrategyDefinition): StrategyDescription {
  return {
    id: strategy.id,
    label: strategy.label,
    kind: strategy.kind,
    enabled: strategy.enabled,
    description: describeKind(strategy),
    redirects: REDIRECTING_KINDS.has(strategy.kind),
    passwordPolicy: strategy.passwordPolicy ?? null,
  };
}

/** Environment variables (typically `process.env`). */
export type AuthEnv = Record<string, string | undefined>;

const TRUTHY = new Set(["1", "true", "on", "yes"]);
const FALSY = new Set(["0", "false", "off", "no", "disabled"]);

function isTruthy(value: string | undefined): boolean {
  return typeof value === "string" && TRUTHY.has(value.trim().toLowerCase());
}

function isFalsy(value: string | undefined): boolean {
  return typeof value === "string" && FALSY.has(value.trim().toLowerCase());
}

/** Whether a descriptor's own environment gate is satisfied. */
function isStrategyAvailable(strategy: StrategyDefinition, env: AuthEnv): boolean {
  switch (strategy.id) {
    case "password":
      return !isFalsy(env.AUTH_PASSWORD);
    case "google":
      return isTruthy(env.AUTH_GOOGLE_ENABLED) || Boolean(env.AUTH_GOOGLE_CLIENT_ID);
    case "microsoft":
      return isTruthy(env.AUTH_MICROSOFT_ENABLED) || Boolean(env.AUTH_MICROSOFT_CLIENT_ID);
    case "saml":
      return Boolean(env.AUTH_SAML_SSO_URL) || Boolean(env.AUTH_SAML_ENTITY_ID);
    case "magic-link":
      return isTruthy(env.AUTH_MAGIC_LINK);
    case "passkey":
      return isTruthy(env.AUTH_PASSKEY);
    default:
      return false;
  }
}

/** Parse `AUTH_STRATEGIES` into an allow-list, or `null` when unset/blank. */
function strategyAllowList(env: AuthEnv): Set<string> | null {
  const entries = (env.AUTH_STRATEGIES ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return entries.length > 0 ? new Set(entries) : null;
}

/**
 * The strategies enabled for a given environment: each descriptor's own gate
 * must pass, and — when `AUTH_STRATEGIES` is set — its id must be on the
 * comma-separated allow-list. Order follows the {@link STRATEGIES} registry,
 * so a sign-in page renders deterministically.
 */
export function enabledStrategies(env: AuthEnv = {}): StrategyDefinition[] {
  const allowList = strategyAllowList(env);
  return STRATEGIES.filter((strategy) => {
    if (allowList && !allowList.has(strategy.id)) return false;
    return isStrategyAvailable(strategy, env);
  });
}

/**
 * Whether the password strategy is enabled for a given environment.
 *
 * The local password sign-in and sign-up are gated by the same registry as
 * every other strategy: `AUTH_PASSWORD` set to a falsy value (`disabled`,
 * `off`, `no`, `0`, `false`) turns it off, and an `AUTH_STRATEGIES` allow-list
 * that does not contain `password` excludes it. Fails closed — an unexpected
 * error while reading the registry leaves the strategy disabled.
 */
export function passwordStrategyEnabled(env: AuthEnv = {}): boolean {
  try {
    return enabledStrategies(env).some((strategy) => strategy.kind === "password");
  } catch {
    return false;
  }
}
