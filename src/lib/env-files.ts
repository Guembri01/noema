/**
 * The env files of the app, and the order in which they win.
 *
 * Next.js (`@next/env`) reads four files and the **first** one that sets a
 * variable wins:
 *
 *   1. `.env.<NODE_ENV>.local`
 *   2. `.env.local`
 *   3. `.env.<NODE_ENV>`
 *   4. `.env`
 *
 * `process.loadEnvFile` never overrides a variable that is already set, so a
 * loader that walks the files in exactly that order reproduces Next.js: among
 * the files the first one wins, and a variable the process environment
 * already carries is never touched. The order is therefore **descending
 * priority** — the highest-priority file is loaded FIRST. (Loading them the
 * other way round makes `.env`, the LOWEST-priority file, win: the script then
 * reads a different `DATABASE_URL` than the app.)
 *
 * This module is the single place that knows the order: the backfill script
 * (`scripts/backfill-2fa-secrets.mjs`) and the 2FA e2e fixture
 * (`e2e/auth-2fa.spec.ts`) both use it, so they cannot drift apart.
 *
 * One difference to Next.js remains: Node's own parser does not expand `$VAR`
 * references inside a file (Next.js does). A file that relies on that
 * expansion is read literally here.
 */
import { resolve } from "node:path";

/**
 * The mode whose env files are loaded.
 *
 * The app runs in production mode (`next build` / `next start`) unless it is a
 * development server (`next dev`) — and `NODE_ENV` is exactly what Next.js
 * sets for those two cases. So `production` is the mode whenever `NODE_ENV`
 * says anything else (`production`, unset, or `test`): the production server
 * reads the production files, and a tool that runs next to it has to read the
 * same ones.
 */
export function envMode(): string {
  return process.env.NODE_ENV === "development" ? "development" : "production";
}

/**
 * The env files, in the order they win: the highest priority first.
 *
 * @param mode the mode whose files are loaded ("production" / "development")
 * @returns the file names, highest priority first
 */
export function envFileNames(mode: string = envMode()): string[] {
  return [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"];
}

/**
 * Load the env files into `process.env`, the way Next.js resolves them.
 *
 * A variable that the environment already carries is never overridden; among
 * the files the first one that sets a variable wins — which is why the files
 * are loaded in descending priority (see {@link envFileNames}).
 *
 * A file that does not exist is skipped (the environment may inject
 * everything). A file that exists but cannot be read — a syntax error, say —
 * is skipped as well and reported through `onError`, exactly as Next.js logs
 * it and carries on.
 *
 * @param dir the directory that holds the env files (the app's root)
 * @param mode the mode whose files are loaded ("production" / "development")
 * @param onError called with the reason a file could not be read
 * @returns the names of the files that were loaded
 */
export function loadEnvFiles(
  dir: string = process.cwd(),
  mode: string = envMode(),
  onError?: (reason: string) => void,
): string[] {
  const loaded: string[] = [];
  for (const name of envFileNames(mode)) {
    const file = resolve(dir, name);
    try {
      process.loadEnvFile(file);
      loaded.push(name);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") continue; // no such file — not an error
      onError?.(
        `could not read the env file ${file}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return loaded;
}
