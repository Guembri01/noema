// B62 — the backup path, end to end.
//
// A dump carries every password hash, 2FA seed, OAuth client secret and
// provider key in cleartext, so the script may only write it sealed (AES-256-GCM,
// passphrase from BACKUP_ENCRYPTION_KEY) and with mode 0600 inside a 0700
// directory — and it may not write it at all without a passphrase.
//
// The dump itself comes from a stub `pg_dump` (there is no database on the
// test host): the script asks for pg_dump the way it does in production and
// the stub answers. The seal, the modes and the restore are the real code.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The suite builds a POSIX `pg_dump` shim and asserts POSIX mode bits; neither
// exists on Windows. The production paths are still exercised on Linux CI.
const describeBackup = process.platform === "win32" ? describe.skip : describe;

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BACKUP = join(REPO, "scripts", "backup.mjs");
const RESTORE = join(REPO, "scripts", "backup-restore.mjs");

/** A passphrase for the tests only — never a real key, never a credential. */
const SEAL_KEY = "noema-b62-e2e-seal-key-001";
const DATABASE_URL = "postgresql://noema@127.0.0.1:5432/noema";

/** The row the dump carries in cleartext — the thing that must not be on disk. */
const SECRET_ROW = "JBSWY3DPEHPK3PXP";

const DUMP_TEXT = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "",
  'CREATE TABLE public."User" (id text, email text, "twoFactorSecret" text);',
  'CREATE TABLE public."Workspace" (id text, name text);',
  'CREATE TABLE public."Page" (id text, title text);',
  'CREATE TABLE public."Ticket" (id text, title text);',
  'CREATE TABLE public."Activity" (id text, kind text);',
  "",
  'COPY public."User" (id, email, "twoFactorSecret") FROM stdin;',
  `user-1\talice@example.test\t${SECRET_ROW}`,
  "\\.",
  "",
  'COPY public."Workspace" (id, name) FROM stdin;',
  "ws-1\tAlpha",
  "\\.",
  "",
  'COPY public."Page" (id, title) FROM stdin;',
  "page-1\tHello",
  "\\.",
  "",
  'COPY public."Ticket" (id, title) FROM stdin;',
  "ticket-1\tBroken",
  "\\.",
  "",
  'COPY public."Activity" (id, kind) FROM stdin;',
  "act-1\tcreated",
  "\\.",
  "",
  "-- padding so the dump is bigger than the 1 KiB the script insists on",
  ...Array.from({ length: 40 }, (_, i) => `-- padding line ${i} ................................`),
  "",
].join("\n");

/** A `pg_dump` that answers `--version` and prints the dump above. */
const STUB_PG_DUMP = [
  "#!/usr/bin/env node",
  `const dump = ${JSON.stringify(DUMP_TEXT)};`,
  'if (process.argv.includes("--version")) {',
  '  console.log("pg_dump (PostgreSQL) 16.4");',
  "  process.exit(0);",
  "}",
  "process.stdout.write(dump);",
  "",
].join("\n");

/** A `docker` that is not there — the script must fall back to the pg_dump on PATH. */
const STUB_DOCKER = ["#!/bin/sh", "exit 1", ""].join("\n");

const workspaces = [];

/** A throwaway workspace with a stub pg_dump on the PATH. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "noema-b62-"));
  workspaces.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, source] of [
    ["pg_dump", STUB_PG_DUMP],
    ["docker", STUB_DOCKER],
  ]) {
    const stub = join(bin, name);
    writeFileSync(stub, source, { mode: 0o755 });
    chmodSync(stub, 0o755);
  }
  return dir;
}

/**
 * The environment of a run: no passphrase unless the test asks for one.
 * @param {string} dir
 * @param {Record<string, string>} [extra]
 */
function environment(dir, extra = {}) {
  const env = { ...process.env };
  delete env.BACKUP_ENCRYPTION_KEY;
  env.PATH = `${join(dir, "bin")}:${env.PATH ?? ""}`;
  env.DATABASE_URL = DATABASE_URL;
  return { ...env, ...extra };
}

/**
 * Run the backup script in the workspace; never throws.
 * @param {string} dir
 * @param {Record<string, string>} [extra]
 */
function runBackup(dir, extra = {}) {
  try {
    const output = execFileSync("node", [BACKUP], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      env: environment(dir, extra),
    });
    return { code: 0, output };
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

/**
 * Run the restore script against a dump of the workspace; never throws.
 * @param {string} dir
 * @param {string} file
 * @param {Record<string, string>} [extra]
 */
function runRestore(dir, file, extra = {}) {
  try {
    const stdout = execFileSync("node", [RESTORE, join(dir, "backups", file)], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      env: environment(dir, extra),
    });
    return { code: 0, stdout, output: stdout };
  } catch (error) {
    const stdout = error.stdout ?? "";
    return {
      code: error.status ?? 1,
      stdout,
      output: `${stdout}${error.stderr ?? ""}`,
    };
  }
}

/** The files the backup wrote, or an empty list when it wrote none. */
function artifacts(dir) {
  const backups = join(dir, "backups");
  return existsSync(backups) ? readdirSync(backups) : [];
}

/**
 * The mode bits of a file or directory.
 * @param {string} path
 */
function modeOf(path) {
  return statSync(path).mode & 0o777;
}

/**
 * The one artifact of the given kind — the test fails loudly when it is
 * missing instead of failing later with a confusing error.
 * @param {string} dir
 * @param {string} suffix
 */
function artifactOf(dir, suffix) {
  const name = artifacts(dir).find((entry) => entry.endsWith(suffix));
  if (!name) throw new Error(`no ${suffix} in ${dir}`);
  return name;
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describeBackup("backup without a passphrase (fail closed)", () => {
  it("writes nothing and says why", () => {
    const dir = workspace();
    const result = runBackup(dir);

    expect(result.code).toBe(1);
    expect(result.output).toContain("BACKUP_ENCRYPTION_KEY");
    expect(artifacts(dir)).toEqual([]);
  });

  it("writes nothing when the passphrase is too short", () => {
    const dir = workspace();
    const result = runBackup(dir, { BACKUP_ENCRYPTION_KEY: "short" });

    expect(result.code).toBe(1);
    expect(result.output).toContain("BACKUP_ENCRYPTION_KEY");
    expect(artifacts(dir)).toEqual([]);
  });
});

describeBackup("backup with a passphrase", () => {
  it("writes a sealed dump with mode 0600 into a 0700 directory", () => {
    const dir = workspace();
    const result = runBackup(dir, { BACKUP_ENCRYPTION_KEY: SEAL_KEY });

    expect(result.code).toBe(0);
    const files = artifacts(dir);
    const dump = artifactOf(dir, ".sql.enc");
    expect(files).toContain(dump);
    expect(modeOf(join(dir, "backups"))).toBe(0o700);
    expect(modeOf(join(dir, "backups", dump))).toBe(0o600);

    const manifest = artifactOf(dir, ".manifest.json");
    expect(modeOf(join(dir, "backups", manifest))).toBe(0o600);
  });

  it("keeps the plaintext out of the file on disk", () => {
    const dir = workspace();
    runBackup(dir, { BACKUP_ENCRYPTION_KEY: SEAL_KEY });

    const dump = artifactOf(dir, ".sql.enc");
    const bytes = readFileSync(join(dir, "backups", dump));
    expect(bytes.includes(Buffer.from(SECRET_ROW))).toBe(false);
    expect(bytes.includes(Buffer.from("CREATE TABLE"))).toBe(false);
  });

  it("records the seal in the manifest", () => {
    const dir = workspace();
    runBackup(dir, { BACKUP_ENCRYPTION_KEY: SEAL_KEY });

    const dump = artifactOf(dir, ".sql.enc");
    const manifest = artifactOf(dir, ".manifest.json");
    const parsed = JSON.parse(readFileSync(join(dir, "backups", manifest), "utf8"));
    expect(parsed.encryption).toBe("aes-256-gcm");
    expect(parsed.file).toBe(dump);
    expect(parsed.rowCounts.User).toBe(1);
  });
});

describeBackup("restore", () => {
  it("opens the dump back to the rows it was taken from", () => {
    const dir = workspace();
    runBackup(dir, { BACKUP_ENCRYPTION_KEY: SEAL_KEY });
    const dump = artifactOf(dir, ".sql.enc");

    const result = runRestore(dir, dump, { BACKUP_ENCRYPTION_KEY: SEAL_KEY });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(SECRET_ROW);
    expect(result.stdout).toContain('CREATE TABLE public."User"');
    expect(result.stdout).toContain("user-1\talice@example.test");
  });

  it("refuses a wrong passphrase instead of restoring garbage", () => {
    const dir = workspace();
    runBackup(dir, { BACKUP_ENCRYPTION_KEY: SEAL_KEY });
    const dump = artifactOf(dir, ".sql.enc");

    const result = runRestore(dir, dump, {
      BACKUP_ENCRYPTION_KEY: "noema-b62-wrong-passphrase-9",
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("BACKUP_ENCRYPTION_KEY");
    expect(result.stdout).toBe("");
  });

  it("refuses a plain, unencrypted dump", () => {
    const dir = workspace();
    mkdirSync(join(dir, "backups"), { recursive: true });
    writeFileSync(join(dir, "backups", "noema-2026-10-15T07-45-30.sql"), DUMP_TEXT);

    const result = runRestore(dir, "noema-2026-10-15T07-45-30.sql", {
      BACKUP_ENCRYPTION_KEY: SEAL_KEY,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("Not a Noema backup");
  });
});
