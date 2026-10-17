// Restore a database backup written by scripts/backup.mjs.
//
//   node scripts/backup-restore.mjs backups/noema-<timestamp>.sql.enc             # → stdout
//   node scripts/backup-restore.mjs backups/<file>.sql.enc --out dump.sql         # → file (mode 0600)
//   node scripts/backup-restore.mjs backups/<file>.sql.enc | psql "$DATABASE_URL"
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
  resolveBackupPassphrase,
} from "./backup-lib.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex === -1 ? null : args[outIndex + 1];
const file = args.find(
  (arg, index) => !arg.startsWith("--") && !(outIndex !== -1 && index === outIndex + 1),
);

if (!file) {
  console.error("Usage: node scripts/backup-restore.mjs <dump> [--out <file>]");
  process.exit(1);
}

const passphrase = resolveBackupPassphrase(process.env);
if (!passphrase.ok) {
  console.error(passphrase.reason);
  process.exit(1);
}

let plaintext;
try {
  plaintext = decryptBackup(readFileSync(file), passphrase.passphrase);
} catch (error) {
  if (error instanceof BackupDecryptError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(`Could not read ${file}: ${error.message}`);
  process.exit(1);
}

if (out) {
  writeFileSync(out, plaintext, { mode: BACKUP_FILE_MODE });
  chmodSync(out, BACKUP_FILE_MODE);
  console.error(
    `Wrote ${out} (${plaintext.length} bytes, mode 0600) — delete it once the restore succeeded.`,
  );
} else {
  process.stdout.write(plaintext);
}
