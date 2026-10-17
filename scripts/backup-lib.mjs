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
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
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
  if (raw.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    return {
      ok: false,
      reason: `BACKUP_ENCRYPTION_KEY is too short (${raw.length} characters) — at least ${MIN_BACKUP_PASSPHRASE_LENGTH} are required.`,
    };
  }
  return { ok: true, passphrase: raw };
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
