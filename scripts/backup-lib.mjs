// B92 — pure helpers for scripts/backup.mjs (backup hardening).
//
// Everything here is a pure function: no fs, no docker, no pg_dump — that is
// what makes `--dry-run`, the per-backup manifest.json and keep-N retention
// unit-testable under vitest (scripts/backup-lib.test.mjs).
//
// B62 — the dump is the most secret file the product writes: it carries every
// password hash, 2FA seed, OAuth client secret and provider key in cleartext.
// So it is sealed (AES-256-GCM, passphrase from BACKUP_ENCRYPTION_KEY) and only
// ever written with mode 0600 — the helpers below are the pure core of that:
// the passphrase policy, the envelope and the artifact names.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from "node:crypto";
import path from "node:path";

/** Default number of dumps retained when `--keep` is absent or invalid. */
export const DEFAULT_KEEP = 5;

/** Mode of a backup artifact: read/write for the owner, nobody else. */
export const BACKUP_FILE_MODE = 0o600;

/** Mode of the backup directory: the owner only. */
export const BACKUP_DIR_MODE = 0o700;

/** Suffix that marks an encrypted dump (`noema-<stamp>.sql.enc`). */
export const ENCRYPTED_SUFFIX = ".enc";

/**
 * Dump artifacts are `noema-*.sql` (a plain dump, e.g. written before B62)
 * and `noema-*.sql.enc` (the sealed dump this script writes today).
 * Manifests/notes never are.
 */
export function isBackupDump(name) {
  return (
    name.startsWith("noema-") && (name.endsWith(".sql") || name.endsWith(`.sql${ENCRYPTED_SUFFIX}`))
  );
}

/**
 * `noema-<stamp>.sql` → `noema-<stamp>.manifest.json` (its sibling manifest).
 * A sealed dump (`…sql.enc`) keeps the same manifest name — the seal does not
 * rename the artifact.
 */
export function manifestNameFor(dumpName) {
  const base = dumpName.endsWith(ENCRYPTED_SUFFIX)
    ? dumpName.slice(0, -ENCRYPTED_SUFFIX.length)
    : dumpName;
  return base.endsWith(".sql") ? `${base.slice(0, -4)}.manifest.json` : `${base}.manifest.json`;
}

/**
 * Row counts per table, parsed from the dump's `COPY … FROM stdin;` blocks
 * (one row per line until the `\.` terminator). A table whose block is empty
 * counts 0 — the block being present is what proves the table exists.
 */
export function parseRowCounts(dump) {
  const counts = {};
  let current = null;
  for (const line of dump.split(/\r?\n/)) {
    if (current === null) {
      const match = /^COPY\s+(.+?)\s+\([^)]*\)\s+FROM stdin;\s*$/.exec(line);
      if (match) {
        const relation = match[1].split(".").pop() ?? "";
        current = relation.replace(/^"|"$/g, "");
        counts[current] = 0;
      }
    } else if (line === "\\.") {
      current = null;
    } else {
      counts[current] += 1;
    }
  }
  return counts;
}

/**
 * Short, stable fingerprint of prisma/schema.prisma — the manifest's
 * `schemaVersion`. Changes whenever the schema text changes.
 */
export function schemaFingerprint(schemaText) {
  return createHash("sha256").update(schemaText, "utf8").digest("hex").slice(0, 12);
}

/**
 * Assemble the manifest written next to every successful backup: timestamp,
 * row counts (parsed from the dump), schema fingerprint and app version.
 * `encryption` names the seal the dump was written under (`aes-256-gcm`), so
 * a restore knows what it has to open — the manifest itself never holds a key.
 */
export function buildManifest({
  timestamp,
  file,
  sizeBytes,
  rowCounts,
  schemaVersion,
  appVersion,
  keep,
  encryption,
}) {
  const counts = { ...rowCounts };
  return {
    timestamp,
    file,
    sizeBytes,
    schemaVersion,
    appVersion,
    keep,
    encryption,
    rowCounts: counts,
    rowCountTotal: Object.values(counts).reduce((sum, n) => sum + n, 0),
  };
}

/** `--keep` is trusted only when it is a finite number ≥ 1 (floored). */
function normalizeKeep(keep) {
  const n = Number(keep);
  if (!Number.isFinite(n)) return DEFAULT_KEEP;
  return Math.max(1, Math.floor(n));
}

/**
 * Retention plan: newest-first (dump names are ISO timestamps, so they sort
 * lexicographically), keep the newest N, prune the rest.
 *
 * Invariants the tests pin:
 * - the newest dump is NEVER pruned — `keep` is clamped to ≥ 1;
 * - files that are not dumps (manifests, notes) are never listed at all;
 * - invalid `keep` (NaN, undefined, "banana") falls back to DEFAULT_KEEP.
 */
export function planRetention(names, keep) {
  const effectiveKeep = normalizeKeep(keep);
  const dumps = names.filter(isBackupDump).sort().reverse();
  return {
    keep: effectiveKeep,
    retained: dumps.slice(0, effectiveKeep),
    prunable: dumps.slice(effectiveKeep),
  };
}

/* ------------------------------------------------------------------ *
 * B62 — the seal: a dump is only written encrypted (fail closed)
 * ------------------------------------------------------------------ */

/** The cipher every dump is sealed with. */
export const BACKUP_CIPHER = "aes-256-gcm";

/** Minimum length of the backup passphrase (in characters). */
export const MIN_BACKUP_PASSPHRASE_LENGTH = 16;

/** Magic bytes at the head of a sealed dump ("NOEMABAK1"). */
export const BACKUP_MAGIC = "NOEMABAK1";

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** magic + salt + iv + auth tag. */
const HEADER_BYTES = BACKUP_MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;

/**
 * Why a sealed dump could not be opened:
 * - `malformed` — not a Noema envelope (wrong magic, truncated, too short);
 * - `auth-failed` — GCM auth-tag mismatch: wrong passphrase or a tampered
 *   payload.
 *
 * @typedef {"malformed" | "auth-failed"} BackupDecryptErrorCode
 */

/** Fail-closed error thrown by {@link decryptBackup}; never leaks plaintext. */
export class BackupDecryptError extends Error {
  /**
   * @param {BackupDecryptErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "BackupDecryptError";
    this.code = code;
  }
}

/**
 * The passphrase that seals the dump, or the reason there is none.
 *
 * Fail closed: a dump holds every password hash, 2FA seed, OAuth client secret
 * and provider key of the installation in cleartext, so without a passphrase no
 * dump is written at all — never an unencrypted one.
 */
export function resolveBackupPassphrase(env) {
  const raw = typeof env?.BACKUP_ENCRYPTION_KEY === "string" ? env.BACKUP_ENCRYPTION_KEY : "";
  if (raw.trim() === "") {
    return {
      ok: false,
      reason:
        "BACKUP_ENCRYPTION_KEY is not set — refusing to write an unencrypted dump (it holds every password hash, 2FA seed and provider key in cleartext).",
    };
  }
  const passphrase = raw.trim();
  if (passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    return {
      ok: false,
      reason: `BACKUP_ENCRYPTION_KEY is too short (${passphrase.length} characters) - at least ${MIN_BACKUP_PASSPHRASE_LENGTH} are required.`,
    };
  }
  return { ok: true, passphrase };
}

/** Stretch the passphrase into a 32-byte key (memory-hard, salted per file). */
function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32);
}

/**
 * Seal a dump: `magic | salt | iv | auth tag | ciphertext`.
 *
 * AES-256-GCM (the same primitive `src/lib/secrets.ts` seals provider keys
 * with) — the auth tag is what makes a tampered backup fail loudly instead of
 * restoring garbage. The salt is fresh per file, so two dumps of the same
 * database never share a key.
 */
export function encryptBackup(plaintext, passphrase) {
  if (typeof passphrase !== "string" || passphrase === "") {
    throw new Error("encryptBackup: a passphrase is required.");
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(BACKUP_CIPHER, deriveKey(passphrase, salt), iv);
  const payload = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.concat([
    Buffer.from(BACKUP_MAGIC, "ascii"),
    salt,
    iv,
    cipher.getAuthTag(),
  ]);
  return Buffer.concat([header, payload]);
}

/**
 * Open a sealed dump. Throws {@link BackupDecryptError} — `malformed` when the
 * file is not a Noema envelope, `auth-failed` when the passphrase is wrong or
 * the payload was tampered with. Never returns partial plaintext.
 */
export function decryptBackup(envelope, passphrase) {
  const raw = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope ?? "");
  if (raw.length < HEADER_BYTES) {
    throw new BackupDecryptError("malformed", "Not a Noema backup: the file is too short to be a sealed dump.");
  }
  if (raw.subarray(0, BACKUP_MAGIC.length).toString("ascii") !== BACKUP_MAGIC) {
    throw new BackupDecryptError(
      "malformed",
      "Not a Noema backup: the magic bytes are missing (a plain, unencrypted dump cannot be opened by this script).",
    );
  }
  let offset = BACKUP_MAGIC.length;
  const salt = raw.subarray(offset, (offset += SALT_BYTES));
  const iv = raw.subarray(offset, (offset += IV_BYTES));
  const tag = raw.subarray(offset, (offset += TAG_BYTES));
  const payload = raw.subarray(HEADER_BYTES);
  try {
    const decipher = createDecipheriv(BACKUP_CIPHER, deriveKey(passphrase, salt), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]);
  } catch {
    throw new BackupDecryptError(
      "auth-failed",
      "The backup could not be opened: wrong BACKUP_ENCRYPTION_KEY or a tampered file.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * Offsite copies — S3-compatible storage (Signature V4 over fetch)
 * ------------------------------------------------------------------ */

/** Default key prefix for offsite backup objects. */
export const DEFAULT_BACKUP_S3_PREFIX = "backups";

/** The empty-payload digest every S3 request has to declare. */
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

/** SHA-256 of a body, as lowercase hex (S3's `x-amz-content-sha256`). */
export function sha256Hex(body) {
  return createHash("sha256")
    .update(Buffer.isBuffer(body) ? body : Buffer.from(body ?? ""))
    .digest("hex");
}

/** AWS's URI encoding rules (not `encodeURIComponent`). */
function encodeAws(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** URL-safe key prefix: no leading/trailing slash, no empty segment. */
export function normalizeBackupPrefix(prefix) {
  return String(prefix ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

/** The object key of a backup artifact under the configured prefix. */
export function remoteBackupKey(name, prefix = DEFAULT_BACKUP_S3_PREFIX) {
  const cleanPrefix = normalizeBackupPrefix(prefix);
  return cleanPrefix ? `${cleanPrefix}/${name}` : name;
}

/**
 * Resolve the offsite backup destination from the environment.
 *
 * Offsite is opt-in: without `BACKUP_S3_BUCKET` the script stays local. Once a
 * bucket is named, the credentials must be complete — a half-configured
 * destination fails closed instead of silently taking a local-only backup.
 */
export function resolveBackupS3Config(env) {
  const bucket = typeof env?.BACKUP_S3_BUCKET === "string" ? env.BACKUP_S3_BUCKET.trim() : "";
  if (bucket === "") return { ok: true, config: null };

  const endpoint = (
    (typeof env?.BACKUP_S3_ENDPOINT === "string" && env.BACKUP_S3_ENDPOINT.trim()) ||
    "https://s3.amazonaws.com"
  ).replace(/\/+$/, "");
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return {
      ok: false,
      reason: `BACKUP_S3_ENDPOINT is not a valid URL (${endpoint}).`,
    };
  }
  if (parsedEndpoint.protocol !== "https:" && parsedEndpoint.protocol !== "http:") {
    return {
      ok: false,
      reason: "BACKUP_S3_ENDPOINT must be an http(s) URL.",
    };
  }

  const accessKeyId =
    typeof env?.BACKUP_S3_ACCESS_KEY_ID === "string" ? env.BACKUP_S3_ACCESS_KEY_ID.trim() : "";
  const secretAccessKey =
    typeof env?.BACKUP_S3_SECRET_ACCESS_KEY === "string"
      ? env.BACKUP_S3_SECRET_ACCESS_KEY.trim()
      : "";
  if (accessKeyId === "" || secretAccessKey === "") {
    return {
      ok: false,
      reason:
        "BACKUP_S3_BUCKET is set but BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY are missing — refusing to take a local-only backup that looks offsite.",
    };
  }

  return {
    ok: true,
    config: {
      endpoint,
      bucket,
      region:
        (typeof env?.BACKUP_S3_REGION === "string" && env.BACKUP_S3_REGION.trim()) ||
        "us-east-1",
      accessKeyId,
      secretAccessKey,
      prefix: normalizeBackupPrefix(
        typeof env?.BACKUP_S3_PREFIX === "string"
          ? env.BACKUP_S3_PREFIX
          : DEFAULT_BACKUP_S3_PREFIX,
      ),
    },
  };
}

/**
 * Sign one S3 request with AWS Signature V4.
 *
 * `key` is relative to the bucket (empty for a bucket-level list); `query` is
 * the canonical query object. The returned headers include `content-type` when
 * a body type is supplied, and that header is part of the signature.
 */
export function signBackupS3Request(input) {
  const now = input.now ?? new Date();
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const endpointUrl = new URL(input.endpoint);
  const host = endpointUrl.host;
  const endpointPath = endpointUrl.pathname.replace(/\/+$/, "");
  const encodedKey = String(input.key ?? "")
    .split("/")
    .filter((segment) => segment !== "")
    .map(encodeAws)
    .join("/");
  const canonicalUri = `${endpointPath}/${encodeAws(input.bucket)}${encodedKey ? `/${encodedKey}` : "/"}`;

  const query = Object.entries(input.query ?? {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name, value]) => [encodeAws(name), encodeAws(value)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const canonicalQuery = query.map(([name, value]) => `${name}=${value}`).join("&");

  const headers = {
    host,
    "x-amz-content-sha256": input.payloadHash ?? EMPTY_SHA256,
    "x-amz-date": amzDate,
  };
  if (input.contentType) headers["content-type"] = input.contentType;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}`).join("\n");
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    `${canonicalHeaders}\n`,
    signedHeaderNames.join(";"),
    headers["x-amz-content-sha256"],
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${dateStamp}/${input.region}/s3/aws4_request`,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signingKey = createHmac("sha256", `AWS4${input.secretAccessKey}`)
    .update(dateStamp)
    .digest();
  const regionKey = createHmac("sha256", signingKey).update(input.region).digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  const requestKey = createHmac("sha256", serviceKey).update("aws4_request").digest();
  const signature = createHmac("sha256", requestKey).update(stringToSign).digest("hex");

  return {
    url: `${input.endpoint}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${dateStamp}/${input.region}/s3/aws4_request, ` +
        `SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
    },
  };
}

/** One object returned by an S3 ListObjectsV2 response. */
export function parseS3ListXml(xml) {
  const decode = (value) =>
    value
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  const tag = (block, name) => {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
    return match ? decode(match[1]) : null;
  };

  const objects = (xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [])
    .map((block) => {
      const key = tag(block, "Key");
      if (key === null) return null;
      const size = Number(tag(block, "Size") ?? "0");
      return {
        key,
        size: Number.isFinite(size) ? size : 0,
        lastModified: tag(block, "LastModified"),
      };
    })
    .filter(Boolean);
  const token = tag(xml, "NextContinuationToken");
  return {
    objects,
    nextContinuationToken: token === null || token === "" ? null : token,
    isTruncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml),
  };
}

/**
 * Move one object through the configured S3-compatible endpoint.
 * `body` is only sent for PUT; a missing GET response is `null`.
 */
export async function s3Object(config, { method, key = "", query, body, contentType }, fetchImpl = fetch) {
  const payload = body === undefined ? "" : body;
  const signed = signBackupS3Request({
    method,
    endpoint: config.endpoint,
    bucket: config.bucket,
    key,
    query,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    payloadHash: body === undefined ? EMPTY_SHA256 : sha256Hex(body),
    ...(contentType ? { contentType } : {}),
  });
  return fetchImpl(signed.url, {
    method,
    headers: signed.headers,
    ...(body === undefined ? {} : { body: payload }),
  });
}

/** Upload bytes to the offsite backup destination. */
export async function s3PutBackup(config, key, body, contentType, fetchImpl = fetch) {
  const response = await s3Object(
    config,
    { method: "PUT", key, body, contentType },
    fetchImpl,
  );
  if (!response.ok) {
    throw new Error(`Offsite storage rejected ${key} (${response.status}).`);
  }
}

/** Read an offsite backup object, or `null` when it is absent. */
export async function s3GetBackup(config, key, fetchImpl = fetch) {
  const response = await s3Object(config, { method: "GET", key }, fetchImpl);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Offsite storage could not read ${key} (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Delete one offsite object; a missing object is already gone. */
export async function s3DeleteBackup(config, key, fetchImpl = fetch) {
  const response = await s3Object(config, { method: "DELETE", key }, fetchImpl);
  if (!response.ok && response.status !== 404) {
    throw new Error(`Offsite storage could not delete ${key} (${response.status}).`);
  }
}

/**
 * List every key under one prefix, following `NextContinuationToken` until the
 * bucket says the listing is complete. Returns bare keys (prefix included).
 */
export async function listBackupObjects(config, prefix, fetchImpl = fetch) {
  const keys = [];
  let continuationToken = null;
  for (let page = 0; page < 10_000; page += 1) {
    const query = {
      "list-type": "2",
      prefix,
      "max-keys": "1000",
      ...(continuationToken ? { "continuation-token": continuationToken } : {}),
    };
    const response = await s3Object(config, { method: "GET", query }, fetchImpl);
    if (!response.ok) {
      throw new Error(`Offsite storage could not list s3://${config.bucket}/${prefix} (${response.status}).`);
    }
    const parsed = parseS3ListXml(await response.text());
    keys.push(...parsed.objects.map((object) => object.key));
    if (!parsed.isTruncated || !parsed.nextContinuationToken) return keys;
    if (parsed.nextContinuationToken === continuationToken) {
      throw new Error("Offsite storage returned the same continuation token twice.");
    }
    continuationToken = parsed.nextContinuationToken;
  }
  throw new Error("Offsite storage listing did not terminate.");
}

/**
 * Prune the offsite copies with the same newest-N rule as the local directory.
 * Only `noema-*.sql` / `noema-*.sql.enc` objects are candidates; a pruned dump
 * takes its manifest. The newest dump is never deleted. Per-key failures are
 * reported, never thrown, so one locked object does not block the sweep.
 */
export async function pruneOffsiteBackups(config, keep, fetchImpl = fetch) {
  const prefix = config.prefix ? `${config.prefix}/` : "";
  const keys = await listBackupObjects(config, prefix, fetchImpl);
  const names = keys
    .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
    .map((key) => key.slice(prefix.length))
    .filter(isBackupDump);
  const plan = planRetention(names, keep);
  const deleted = [];
  const failed = [];
  for (const name of plan.prunable) {
    try {
      await s3DeleteBackup(config, remoteBackupKey(name, config.prefix), fetchImpl);
      await s3DeleteBackup(
        config,
        remoteBackupKey(manifestNameFor(name), config.prefix),
        fetchImpl,
      ).catch((error) => {
        failed.push({
          key: remoteBackupKey(manifestNameFor(name), config.prefix),
          error: error instanceof Error ? error.message : String(error),
        });
      });
      deleted.push(name);
    } catch (error) {
      failed.push({
        key: remoteBackupKey(name, config.prefix),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ...plan, deleted, failed };
}

/** Human-readable `--dry-run` plan. Pure: prints nothing, returns the text. */
export function formatDryRunPlan({
  root,
  database,
  host,
  port,
  dumper,
  target,
  keep,
  retained,
  prunable,
  encryption,
  offsite,
}) {
  const rel = (file) => path.relative(root, file).split(path.sep).join("/");
  const dumpPath = rel(target);
  const manifestPath = rel(manifestNameFor(target));
  const via =
    dumper === null
      ? "NO pg_dump (container unreachable and none on PATH)"
      : dumper.kind === "docker"
        ? `docker container "${dumper.container}"`
        : "pg_dump on PATH";
  const lines = [
    "DRY RUN — nothing will be written or removed.",
    `Source:      database "${database}" at ${host}:${port} via ${via}`,
  ];
  if (dumper === null) {
    lines.push("would FAIL: no pg_dump available (start the database container or install postgresql-client).");
  }
  if (offsite?.ok === false) {
    lines.push(`Offsite:     would FAIL — ${offsite.reason}`);
  } else if (offsite?.config) {
    lines.push(
      `Offsite:     s3://${offsite.config.bucket}/${offsite.config.prefix || ""} (${offsite.config.endpoint})`,
    );
  } else if (offsite?.ok === true) {
    lines.push("Offsite:     disabled (set BACKUP_S3_BUCKET to upload a copy)");
  }
  lines.push(
    `Target:      ${dumpPath}`,
    `Manifest:    ${manifestPath}`,
    `Encryption:  ${
      encryption?.ok
        ? `${BACKUP_CIPHER}, passphrase from BACKUP_ENCRYPTION_KEY`
        : `would FAIL — ${encryption?.reason ?? "BACKUP_ENCRYPTION_KEY is not set."}`
    }`,
    `Restore:     node scripts/backup-restore.mjs ${dumpPath} | psql "$DATABASE_URL"`,
    `             createdb noema-restore-check && node scripts/backup-restore.mjs ${dumpPath} | psql -d noema-restore-check`,
    `             then compare row counts against ${manifestPath}`,
    `Retention:   keep ${keep} — ${retained.length} kept, ${prunable.length} would be removed`,
  );
  const dir = path.dirname(target);
  for (const name of retained) lines.push(`  keep         ${rel(path.join(dir, name))}`);
  for (const name of prunable) lines.push(`  would remove ${rel(path.join(dir, name))}`);
  return lines.join("\n");
}
