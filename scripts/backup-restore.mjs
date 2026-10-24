// Restore a database backup written by scripts/backup.mjs.
//
//   node scripts/backup-restore.mjs backups/noema-<timestamp>.sql.enc             # → stdout
//   node scripts/backup-restore.mjs backups/<file>.sql.enc --out dump.sql         # → file (mode 0600)
//   node scripts/backup-restore.mjs --remote noema-<timestamp>.sql.enc            # from BACKUP_S3_*
//   node scripts/backup-restore.mjs backups/<file>.sql.enc | psql "$DATABASE_URL"
//
// `--remote` reads the sealed object from the S3-compatible backup destination
// (the same BACKUP_S3_* variables backup.mjs uploaded with) before opening it.
// A full `s3://bucket/key` URL is accepted too; the path is then used verbatim.
//
// The passphrase comes from BACKUP_ENCRYPTION_KEY — the very variable the
// backup was sealed with. Fail closed: without it nothing is decrypted, and a
// wrong passphrase or a tampered file is refused instead of restoring garbage.
//
// A dump written before the seal (a plain `noema-<stamp>.sql`) cannot be opened
// here — restore it with `psql "$DATABASE_URL" < <file>.sql` and re-take the
// backup afterwards.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
  BACKUP_FILE_MODE,
  BackupDecryptError,
  decryptBackup,
  remoteBackupKey,
  resolveBackupPassphrase,
  resolveBackupS3Config,
  s3GetBackup,
} from "./backup-lib.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex === -1 ? null : args[outIndex + 1];
const remoteIndex = args.indexOf("--remote");
const remote = remoteIndex === -1 ? null : args[remoteIndex + 1];
const file = args.find(
  (arg, index) =>
    !arg.startsWith("--") &&
    !(outIndex !== -1 && index === outIndex + 1) &&
    !(remoteIndex !== -1 && index === remoteIndex + 1),
);

if ((!file && !remote) || (file && remote)) {
  console.error(
    "Usage: node scripts/backup-restore.mjs <dump> [--out <file>] | --remote <key|s3://bucket/key>",
  );
  process.exit(1);
}
if (remote !== null && (remote === "" || remote.startsWith("--"))) {
  console.error("Usage: node scripts/backup-restore.mjs --remote <key|s3://bucket/key>");
  process.exit(1);
}

const passphrase = resolveBackupPassphrase(process.env);
if (!passphrase.ok) {
  console.error(passphrase.reason);
  process.exit(1);
}

let envelope;
if (remote !== null) {
  const resolved = resolveBackupS3Config(process.env);
  if (!resolved.ok) {
    console.error(resolved.reason);
    process.exit(1);
  }
  if (!resolved.config) {
    console.error(
      "Offsite restore needs BACKUP_S3_BUCKET (and BACKUP_S3_ENDPOINT / keys) in the environment.",
    );
    process.exit(1);
  }
  let config = resolved.config;
  let key;
  if (remote.startsWith("s3://")) {
    const url = new URL(remote);
    if (!url.hostname) {
      console.error(`Not an S3 object URL: ${remote}`);
      process.exit(1);
    }
    config = { ...config, bucket: url.hostname };
    key = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } else {
    key = remote.startsWith(`${config.prefix}/`) || config.prefix === ""
      ? remote
      : remoteBackupKey(remote, config.prefix);
  }
  try {
    console.error(`Reading s3://${config.bucket}/${key} …`);
    envelope = await s3GetBackup(config, key);
  } catch (error) {
    console.error(`Could not read the offsite backup: ${error.message}`);
    process.exit(1);
  }
  if (!envelope) {
    console.error(`Offsite backup not found: s3://${config.bucket}/${key}`);
    process.exit(1);
  }
} else {
  envelope = readFileSync(file);
}

let plaintext;
try {
  plaintext = decryptBackup(envelope, passphrase.passphrase);
} catch (error) {
  if (error instanceof BackupDecryptError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(`Could not read the backup: ${error.message}`);
  process.exit(1);
}

if (out) {
  writeFileSync(out, plaintext, { mode: BACKUP_FILE_MODE });
  // `mode` is only a creation hint and chmod is unsupported on some mounts
  // (FAT, some network shares). The dump is already on disk at this point, so a
  // throw here must not leave the operator without the path to delete.
  try {
    chmodSync(out, BACKUP_FILE_MODE);
  } catch {
    // best effort: the file is still owner-created; document the mount limit
  }
  console.error(
    `Wrote ${out} (${plaintext.length} bytes, mode 0600) — delete it once the restore succeeded.`,
  );
} else {
  process.stdout.write(plaintext);
}
