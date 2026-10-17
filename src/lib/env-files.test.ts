// The env files of the app, and the order in which they win.
//
// This is the test the B05 backfill script and the 2FA e2e fixture both
// depend on: Next.js resolves `.env.<NODE_ENV>.local` > `.env.local` >
// `.env.<NODE_ENV>` > `.env`, and the first file that sets a variable wins.
// A loader that gets the order wrong reads a DIFFERENT `DATABASE_URL` than the
// app — the backfill would then seal the seeds of another database.
//
// The order is pinned twice: against the documented Next.js precedence, and
// against the `@next/env` the app itself uses (the cross-check is skipped —
// loudly — when that package is not installed).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { envFileNames, envMode, loadEnvFiles } from "./env-files";

/** A variable name no deployment uses — the probe of the precedence. */
const PROBE = "NOEMA_ENV_FILE_PRECEDENCE_PROBE";

/** The repository root — the two call sites that must not drift apart. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const require_ = createRequire(import.meta.url);

/** The `@next/env` the app itself loads its env files with — if it is there. */
function nextEnvEntry(): string | null {
  try {
    return require_.resolve("@next/env");
  } catch {
    return null;
  }
}

/**
 * The value Next.js resolves for the probe variable, measured with the app's
 * own `@next/env` in a child process (so the global `process.env` of this
 * test run stays untouched).
 */
function nextEnvValue(dir: string, mode: string): string | null {
  const entry = nextEnvEntry();
  if (!entry) return null;
  const script = [
    `const { loadEnvConfig } = require(${JSON.stringify(entry)});`,
    `const { combinedEnv } = loadEnvConfig(${JSON.stringify(dir)}, ${
      mode === "development"
    }, { error() {} });`,
    `process.stdout.write(JSON.stringify(combinedEnv[${JSON.stringify(PROBE)}] ?? null));`,
  ].join("\n");
  const env = { ...process.env, NODE_ENV: mode };
  delete env[PROBE];
  const out = execFileSync(process.execPath, ["-e", script], {
    env,
    encoding: "utf8",
  });
  return JSON.parse(out) as string | null;
}

/** The directories this test created — removed again after every case. */
const tempDirs: string[] = [];

/** A directory with the four env files, each holding a different value. */
function envDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noema-env-files-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, ".env"), `${PROBE}=from-dotenv\n`, "utf8");
  writeFileSync(join(dir, ".env.local"), `${PROBE}=from-dotenv-local\n`, "utf8");
  writeFileSync(join(dir, ".env.production"), `${PROBE}=from-dotenv-production\n`, "utf8");
  writeFileSync(
    join(dir, ".env.production.local"),
    `${PROBE}=from-dotenv-production-local\n`,
    "utf8",
  );
  return dir;
}

/**
 * Load the env files with the probe variable unset and report the value that
 * survived — the whole `process.env` is restored afterwards.
 */
function loadedValue(dir: string, mode = "production"): string | undefined {
  const snapshot = { ...process.env };
  try {
    delete process.env[PROBE];
    loadEnvFiles(dir, mode);
    return process.env[PROBE];
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, snapshot);
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the order of the env files", () => {
  it("is descending priority — the file that wins is loaded FIRST", () => {
    expect(envFileNames("production")).toEqual([
      ".env.production.local",
      ".env.local",
      ".env.production",
      ".env",
    ]);
    expect(envFileNames("development")).toEqual([
      ".env.development.local",
      ".env.local",
      ".env.development",
      ".env",
    ]);
  });

  it("uses the production mode unless NODE_ENV says development", () => {
    const snapshot = { ...process.env };
    try {
      delete process.env.NODE_ENV;
      expect(envMode()).toBe("production");
      process.env.NODE_ENV = "production";
      expect(envMode()).toBe("production");
      process.env.NODE_ENV = "test";
      expect(envMode()).toBe("production");
      process.env.NODE_ENV = "development";
      expect(envMode()).toBe("development");
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, snapshot);
    }
  });
});

describe("loading the env files", () => {
  it("lets the file with the highest priority win", () => {
    expect(loadedValue(envDir())).toBe("from-dotenv-production-local");
  });

  it("falls back to the next file when the highest one does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "noema-env-files-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, ".env"), `${PROBE}=from-dotenv\n`, "utf8");
    writeFileSync(join(dir, ".env.local"), `${PROBE}=from-dotenv-local\n`, "utf8");
    expect(loadedValue(dir)).toBe("from-dotenv-local");
  });

  it("never overrides a variable the environment already carries", () => {
    const dir = envDir();
    const snapshot = { ...process.env };
    try {
      process.env[PROBE] = "from-the-environment";
      loadEnvFiles(dir, "production");
      expect(process.env[PROBE]).toBe("from-the-environment");
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, snapshot);
    }
  });

  it("resolves exactly like Next.js does", () => {
    const dir = envDir();
    const ours = loadedValue(dir);
    const next = nextEnvValue(dir, "production");
    if (!next) {
      // @next/env is not installed — the order is pinned by the cases above.
      expect(ours).toBe("from-dotenv-production-local");
      return;
    }
    expect(ours).toBe(next);
  });
});

describe("the two call sites", () => {
  it("load the env files through this module — the order cannot drift", () => {
    const script = readFileSync(
      join(REPO_ROOT, "scripts", "backfill-2fa-secrets.mjs"),
      "utf8",
    );
    const spec = readFileSync(join(REPO_ROOT, "e2e", "auth-2fa.spec.ts"), "utf8");

    expect(script).toMatch(
      /import\s*\{[^}]*loadEnvFiles[^}]*\}\s*from\s*"\.\.\/src\/lib\/env-files\.ts"/,
    );
    expect(spec).toMatch(
      /import\s*\{[^}]*loadEnvFiles[^}]*\}\s*from\s*"\.\.\/src\/lib\/env-files"/,
    );
    // Neither of them loads an env file on its own any more.
    expect(script).not.toMatch(/process\.loadEnvFile\s*\(/);
    expect(spec).not.toMatch(/process\.loadEnvFile\s*\(/);
  });
});
