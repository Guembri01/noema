import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Envelope encryption for stored provider keys (AES-256-GCM).
 *
 * The key is derived from AUTH_SECRET, so a database dump alone is not enough
 * to read a stored API key. Ciphertext is versioned (`v1:iv:tag:payload`) so the
 * scheme can be rotated later. Secrets are never sent back to the client — the
 * UI only ever sees a masked form.
 */

function encryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET ?? "";
  if (!secret) {
    throw new Error("AUTH_SECRET is required to store provider keys.");
  }
  // Fixed, domain-separated salt: the secret is the entropy source.
  return createHash("sha256").update(`noema:ai-provider:v1:${secret}`).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const payload = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${payload.toString("base64")}`;
}

export function decryptSecret(envelope: string | null | undefined): string | null {
  if (!envelope) return null;
  const [version, iv, tag, payload] = envelope.split(":");
  if (version !== "v1" || !iv || !tag || !payload) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Versioned keyring & key rotation (docs/MISSING_FEATURES.md §17) — additive
 * to the legacy `v1:` envelope above.
 *
 * A `Keyring` is an ordered map of key-version → 32-byte AES-256-GCM key with
 * a designated `activeVersion`. `encrypt` seals under the active version and
 * embeds it in the payload (`v2:<version>:<iv>:<tag>:<payload>`), so `decrypt`
 * selects the right key even after `rotateKeyring` has promoted a newer one.
 * Legacy `v1:` envelopes carry no key version and are implicitly pinned to
 * key version `1` (`LEGACY_KEY_VERSION`) — register the env-derived key
 * (`deriveLegacyKey`) there to keep old ciphertexts readable during a
 * migration pass (`reencrypt`).
 *
 * Persisting the keyring (vault/KMS) and wiring env-based keys into the app
 * are follow-ups; this module stays pure logic over Node `crypto`.
 */

const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Key version that legacy `v1:` envelopes are implicitly pinned to. */
export const LEGACY_KEY_VERSION = "1";

/** Default rotation policy consumed by `needsRotation`: 90 days. */
export const DEFAULT_MAX_KEY_AGE_SECONDS = 90 * 24 * 3600;

export interface Keyring {
  /** Key versions → raw 32-byte AES keys; insertion order preserved. */
  readonly keys: ReadonlyMap<string, Buffer>;
  /** Version used by `encrypt` and embedded in new payloads. */
  readonly activeVersion: string;
  /** Unix seconds the active key was introduced — feeds `needsRotation`. */
  readonly activeSince: number;
}

export type SecretDecryptErrorCode =
  /** Not a parseable envelope (wrong scheme/shape, bad IV or tag sizes). */
  | "malformed"
  /** No key version embedded, or the keyring has no key for it. */
  | "unknown-version"
  /** GCM auth-tag mismatch: tampered payload or wrong key material. */
  | "auth-failed";

/** Fail-closed error thrown by `decrypt`/`reencrypt`; never leaks plaintext. */
export class SecretDecryptError extends Error {
  readonly code: SecretDecryptErrorCode;
  readonly keyVersion: string | null;

  constructor(
    code: SecretDecryptErrorCode,
    message: string,
    keyVersion: string | null = null,
  ) {
    super(message);
    this.name = "SecretDecryptError";
    this.code = code;
    this.keyVersion = keyVersion;
  }
}

/** The env-derived key behind legacy `v1:` envelopes — register it as `1`. */
export function deriveLegacyKey(): Buffer {
  return encryptionKey();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function assertKeyVersion(version: string): void {
  if (!KEY_VERSION_PATTERN.test(version)) {
    throw new Error(
      `Invalid key version: expected /^[A-Za-z0-9._-]+$/ (got ${JSON.stringify(version)}).`,
    );
  }
}

function copyKeyMaterial(material: Uint8Array, version: string): Buffer {
  const key = Buffer.from(material); // defensive copy — caller may mutate
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(
      `Key "${version}" must be exactly ${AES_KEY_BYTES} bytes, got ${key.length}.`,
    );
  }
  return key;
}

/** Build an immutable-by-convention keyring; validates keys and active version. */
export function createKeyring(
  keys: Readonly<Record<string, Uint8Array>> | ReadonlyMap<string, Uint8Array>,
  activeVersion: string,
  now: number = nowSeconds(),
): Keyring {
  const entries =
    keys instanceof Map ? [...keys.entries()] : Object.entries(keys);
  if (entries.length === 0) {
    throw new Error("A keyring needs at least one key.");
  }
  const normalized = new Map<string, Buffer>();
  for (const [version, material] of entries) {
    assertKeyVersion(version);
    normalized.set(version, copyKeyMaterial(material, version));
  }
  if (!normalized.has(activeVersion)) {
    throw new Error(
      `activeVersion "${activeVersion}" has no key in the keyring.`,
    );
  }
  return { keys: normalized, activeVersion, activeSince: now };
}

/** Seal under the ACTIVE version, embedding it in the payload. */
export function encrypt(plaintext: string, keyring: Keyring): string {
  const key = keyring.keys.get(keyring.activeVersion);
  if (!key) {
    // Invariant: createKeyring guarantees the active key exists.
    throw new Error(
      `Keyring has no key for activeVersion "${keyring.activeVersion}".`,
    );
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v2:${keyring.activeVersion}:${iv.toString("base64")}:${tag.toString("base64")}:${payload.toString("base64")}`;
}

/**
 * Open a keyring payload: read the embedded version, select that key, fail
 * closed with a typed `SecretDecryptError` on unknown/missing version or on a
 * GCM auth-tag mismatch (tamper detection). Legacy `v1:` envelopes are
 * resolved against `LEGACY_KEY_VERSION`.
 */
export function decrypt(envelope: string, keyring: Keyring): string {
  const segments = envelope.split(":");
  const [scheme] = segments;
  if (scheme === "v1") {
    const [, iv, tag, payload] = segments;
    if (segments.length !== 4 || !iv || !tag || payload === undefined) {
      throw new SecretDecryptError("malformed", "Malformed legacy `v1:` envelope.");
    }
    const key = keyring.keys.get(LEGACY_KEY_VERSION);
    if (!key) {
      throw new SecretDecryptError(
        "unknown-version",
        `Keyring has no key for legacy version "${LEGACY_KEY_VERSION}".`,
        LEGACY_KEY_VERSION,
      );
    }
    return openAesGcm(key, iv, tag, payload);
  }
  if (scheme !== "v2") {
    throw new SecretDecryptError(
      "malformed",
      "Not a `v1:`/`v2:` AES-256-GCM envelope.",
    );
  }
  const [, version, iv, tag, payload] = segments;
  if (segments.length !== 5) {
    throw new SecretDecryptError(
      "malformed",
      "Malformed `v2:` envelope: expected `v2:<version>:<iv>:<tag>:<payload>`.",
    );
  }
  if (!version) {
    throw new SecretDecryptError(
      "unknown-version",
      "Envelope has no embedded key version.",
    );
  }
  const key = keyring.keys.get(version);
  if (!key) {
    throw new SecretDecryptError(
      "unknown-version",
      `Keyring has no key for version "${version}".`,
      version,
    );
  }
  return openAesGcm(key, iv, tag, payload);
}

function openAesGcm(
  key: Buffer,
  ivB64: string,
  tagB64: string,
  payloadB64: string,
): string {
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
    throw new SecretDecryptError(
      "malformed",
      "Envelope IV/auth tag must decode to 12/16 bytes.",
    );
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(payloadB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecretDecryptError(
      "auth-failed",
      "GCM auth tag mismatch: payload was tampered with or sealed under another key.",
    );
  }
}

export interface RotateKeyringOptions {
  /** Explicit version for the new key; inferred from numeric versions otherwise. */
  readonly version?: string;
  /** Unix seconds to stamp as the new `activeSince` (default: now). */
  readonly now?: number;
}

function nextKeyVersion(keyring: Keyring): string {
  let max = 0;
  for (const version of keyring.keys.keys()) {
    if (!/^\d+$/.test(version)) {
      throw new Error(
        "Cannot infer the next key version from non-numeric versions; pass an explicit version.",
      );
    }
    max = Math.max(max, Number(version));
  }
  return String(max + 1);
}

/**
 * Return a NEW keyring with `newKey` active and every prior key retained, so
 * ciphertexts pinned to older versions keep decrypting.
 */
export function rotateKeyring(
  keyring: Keyring,
  newKey: Uint8Array,
  options: RotateKeyringOptions = {},
): Keyring {
  const version = options.version ?? nextKeyVersion(keyring);
  assertKeyVersion(version);
  if (keyring.keys.has(version)) {
    throw new Error(
      `Key version "${version}" already exists; rotation must not overwrite keys.`,
    );
  }
  const keys = new Map(keyring.keys);
  keys.set(version, copyKeyMaterial(newKey, version));
  return {
    keys,
    activeVersion: version,
    activeSince: options.now ?? nowSeconds(),
  };
}

/** True when the active key is older than `maxAgeSeconds` (default: 90 days). */
export function needsRotation(
  keyring: Keyring,
  maxAgeSeconds: number = DEFAULT_MAX_KEY_AGE_SECONDS,
  now: number = nowSeconds(),
): boolean {
  return now - keyring.activeSince > maxAgeSeconds;
}

/** Migration pass: decrypt under `oldKeyring`, re-seal under the new active version. */
export function reencrypt(
  oldPayload: string,
  oldKeyring: Keyring,
  newKeyring: Keyring,
): string {
  return encrypt(decrypt(oldPayload, oldKeyring), newKeyring);
}

/** Show only the shape of a stored key: `sk-ab…9f2c`. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

/** SHA-256 hex digest, used for single-use invite tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(`noema:token:${token}`).digest("hex");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/* ------------------------------------------------------------------------- *
 * §17 secret-handling engine — additive.
 *
 * Validation/classification, redaction, generation and operator diagnostics
 * for env secrets. Every function here is pure: none of them logs a value and
 * none of the diagnostics they return contains the secret itself.
 * ------------------------------------------------------------------------- */

/** Scope an env secret belongs to — drives rotation guidance and grouping. */
export type SecretScope =
  | "auth"
  | "database"
  | "ai"
  | "email"
  | "sso"
  | "cron";

/** Minimum acceptable length for a strong secret (mirrors `auth.ts`). */
export const MIN_SECRET_LENGTH = 16;

/** Classification of a single env secret; never carries the value. */
export type SecretStatus = "ok" | "weak" | "missing";

/**
 * Key names (normalized: lowercased, separators stripped) whose values
 * `redactObject` masks by default.
 */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  "secret",
  "password",
  "passwd",
  "pwd",
  "token",
  "apikey",
  "auth",
  "authorization",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "privatekey",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "signature",
];

/** Keys whose string values are connection strings → `maskConnString`. */
const CONNECTION_STRING_KEYS: readonly string[] = [
  "databaseurl",
  "connectionstring",
  "dsn",
];

/** Placeholder written in place of a masked credential. */
const REDACTED_PLACEHOLDER = "***";

/** Characters of the head kept before the ellipsis in `redact`. */
const REDACT_HEAD_LENGTH = 3;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface ParseEnvSecretOptions {
  /** A missing required secret is invalid; a missing optional one is not. */
  readonly required?: boolean;
  /** Values shorter than this are classified `weak` (default 16). */
  readonly minLength?: number;
}

export interface ParsedEnvSecret {
  readonly name: string;
  readonly required: boolean;
  readonly present: boolean;
  readonly length: number;
  readonly minLength: number;
  readonly status: SecretStatus;
  readonly valid: boolean;
}

/**
 * Validate and classify an environment secret without exposing its value.
 * `invalid` (i.e. `valid: false`) means either a required secret is absent or a
 * present value is shorter than `minLength`.
 */
export function parseEnvSecret(
  name: string,
  value: string | null | undefined,
  options: ParseEnvSecretOptions = {},
): ParsedEnvSecret {
  const required = options.required ?? false;
  const minLength = options.minLength ?? MIN_SECRET_LENGTH;
  const length = typeof value === "string" ? value.length : 0;
  const present = length > 0;

  let status: SecretStatus;
  if (!present) {
    status = "missing";
  } else if (length < minLength) {
    status = "weak";
  } else {
    status = "ok";
  }

  const valid = status === "ok" || (status === "missing" && !required);
  return { name, required, present, length, minLength, status, valid };
}

export interface RedactOptions {
  /** Characters kept at the tail of the value (default 4). */
  readonly keep?: number;
}

/**
 * Mask a secret value for display: a short head, an ellipsis and the last
 * `keep` characters (`redact("sk-abcdef1234")` → `"sk-…1234"`). Values too
 * short to mask are reduced to a lone ellipsis so nothing leaks either end.
 */
export function redact(
  value: string | null | undefined,
  options: RedactOptions = {},
): string {
  if (value === null || value === undefined || value === "") return "";
  const keep = Math.max(0, Math.trunc(options.keep ?? 4));
  if (value.length <= REDACT_HEAD_LENGTH + keep) return "…";
  const head = value.slice(0, REDACT_HEAD_LENGTH);
  const tail = keep === 0 ? "" : value.slice(-keep);
  return `${head}…${tail}`;
}

export interface RedactObjectOptions {
  /** Characters kept at the tail of each redacted string (default 4). */
  readonly keep?: number;
}

/**
 * Deeply redact an object graph, returning a fresh copy and never mutating the
 * input. Any key that normalizes to a known secret name (or to `extraKeys`)
 * is masked; connection-string keys are masked with `maskConnString`. Cycles
 * become `"[Circular]"`.
 */
export function redactObject<T>(
  input: T,
  extraKeys: readonly string[] = [],
  options: RedactObjectOptions = {},
): T {
  const keys = new Set<string>(
    [...DEFAULT_REDACT_KEYS, ...CONNECTION_STRING_KEYS, ...extraKeys].map(
      normalizeKey,
    ),
  );
  const connectionKeys = new Set<string>(CONNECTION_STRING_KEYS);
  const seen = new WeakSet<object>();

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      return value.map((item) => walk(item));
    }
    if (isPlainObject(value)) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        const normalized = normalizeKey(key);
        out[key] = keys.has(normalized)
          ? redactMatched(child, connectionKeys.has(normalized), options)
          : walk(child);
      }
      return out;
    }
    return value;
  };

  return walk(input) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function redactMatched(
  value: unknown,
  isConnectionString: boolean,
  options: RedactObjectOptions,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return "[redacted]";
  if (isConnectionString) return maskConnString(value);
  return redact(value, options);
}

export interface GenerateSecretOptions {
  /** Number of random bytes (default 32). */
  readonly bytes?: number;
  /** Clock override: a Unix-ms number or a function returning one. */
  readonly now?: number | (() => number);
  /** Optional scheme prefix, e.g. `"sk-"`. */
  readonly prefix?: string;
  /** Entropy source; defaults to `crypto.randomBytes`. */
  readonly random?: (size: number) => Uint8Array;
}

export interface GeneratedSecret {
  readonly value: string;
  readonly prefix: string;
  readonly bytes: number;
  readonly createdAt: number;
}

/**
 * Generate a random secret from the platform CSPRNG (`crypto.randomBytes`),
 * falling back to an injected `random` source when supplied. Never uses
 * `Math.random`.
 */
export function generateSecret(
  options: GenerateSecretOptions = {},
): GeneratedSecret {
  const bytes = options.bytes ?? 32;
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(
      `generateSecret: \`bytes\` must be a positive integer (got ${bytes}).`,
    );
  }
  const prefix = options.prefix ?? "";
  const random = options.random ?? ((size: number) => randomBytes(size));
  const raw = random(bytes);
  if (!(raw instanceof Uint8Array) || raw.length !== bytes) {
    throw new Error(
      "generateSecret: the random source must return exactly `bytes` bytes.",
    );
  }
  return {
    value: `${prefix}${Buffer.from(raw).toString("base64url")}`,
    prefix,
    bytes,
    createdAt: resolveNow(options.now),
  };
}

function resolveNow(now: number | (() => number) | undefined): number {
  if (typeof now === "function") return now();
  if (typeof now === "number") return now;
  return Date.now();
}

/**
 * Compare two strings in constant time with respect to their contents. Length
 * differences are folded into the accumulator, so the loop always scans the
 * longer input and never short-circuits on the first mismatch.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export interface SecretRegistryEntry {
  readonly name: string;
  readonly required: boolean;
  readonly scope: SecretScope;
  /** Recommended rotation interval in days. */
  readonly rotationDays: number;
  /** Overrides `MIN_SECRET_LENGTH` for this secret when present. */
  readonly minLength?: number;
}

/** Known env secrets documented in `.env.example` / `README.md`. */
export const SECRET_REGISTRY: readonly SecretRegistryEntry[] = [
  { name: "DATABASE_URL", required: true, scope: "database", rotationDays: 365 },
  { name: "AUTH_SECRET", required: true, scope: "auth", rotationDays: 90 },
  { name: "AI_API_KEY", required: false, scope: "ai", rotationDays: 180 },
  {
    name: "AI_TRANSCRIBE_API_KEY",
    required: false,
    scope: "ai",
    rotationDays: 180,
  },
  { name: "SSO_CLIENT_SECRET", required: false, scope: "sso", rotationDays: 180 },
  { name: "SMTP_PASSWORD", required: false, scope: "email", rotationDays: 180 },
  { name: "CRON_SECRET", required: false, scope: "cron", rotationDays: 90 },
];

/** A minimal read-only view of `process.env` — values are never returned. */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** Names of required secrets absent from `env`, in registry order. */
export function missingSecrets(
  env: EnvRecord,
  registry: readonly SecretRegistryEntry[] = SECRET_REGISTRY,
): string[] {
  const missing: string[] = [];
  for (const entry of registry) {
    if (!entry.required) continue;
    const { status } = parseEnvSecret(entry.name, env[entry.name], {
      required: true,
      minLength: entry.minLength,
    });
    if (status === "missing") missing.push(entry.name);
  }
  return missing;
}

export interface SecretDescription {
  readonly name: string;
  readonly scope: SecretScope;
  readonly required: boolean;
  readonly status: SecretStatus;
  readonly rotationDays: number;
}

/**
 * Per-secret status for operator diagnostics — present/missing/weak, plus the
 * registry metadata. Values are deliberately omitted.
 */
export function describeSecretStatus(
  env: EnvRecord,
  registry: readonly SecretRegistryEntry[] = SECRET_REGISTRY,
): SecretDescription[] {
  return registry.map((entry) => {
    const { status } = parseEnvSecret(entry.name, env[entry.name], {
      required: entry.required,
      minLength: entry.minLength,
    });
    return {
      name: entry.name,
      scope: entry.scope,
      required: entry.required,
      status,
      rotationDays: entry.rotationDays,
    };
  });
}

/**
 * Mask the credentials embedded in a connection string
 * (`postgresql://user:pw@host:5432/db` → `postgresql://user:***@host:5432/db`)
 * and any password query parameter. Never throws; unparseable input falls back
 * to regex masking.
 */
export function maskConnString(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return maskConnStringWithUrl(url);
  } catch {
    return maskConnStringFallback(url);
  }
}

function maskConnStringWithUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = REDACTED_PLACEHOLDER;
  for (const key of Array.from(parsed.searchParams.keys())) {
    const normalized = normalizeKey(key);
    if (
      normalized === "password" ||
      normalized === "pwd" ||
      normalized === "sslpassword"
    ) {
      parsed.searchParams.set(key, REDACTED_PLACEHOLDER);
    }
  }
  return parsed.toString();
}

function maskConnStringFallback(url: string): string {
  const withCreds = url.replace(
    /(:\/\/[^:@/?#\s]+:)([^@/?#\s]+)(@)/,
    `$1${REDACTED_PLACEHOLDER}$3`,
  );
  return withCreds.replace(
    /([?&](?:password|pwd|sslpassword)=)([^&\s]*)/gi,
    `$1${REDACTED_PLACEHOLDER}`,
  );
}
