import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * B134 — the documented backfill command must run.
 *
 * The script reads the app's TypeScript modules (`src/lib/env-files.ts`,
 * `src/lib/secrets.ts`), and those import each other without a file
 * extension. Node's ESM resolver needs the extension, so under plain `node`
 * the script died with `ERR_MODULE_NOT_FOUND` before it printed its own
 * usage — the operator's command could not run at all, and the cleartext
 * two-factor seeds it is meant to seal stayed cleartext.
 *
 * The loader (`tsx`) is the fix; this test runs the command **out of
 * `package.json`** — the documented way — and asks for the usage, which
 * needs no database.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The command an operator runs. */
function backfillCommand() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return pkg.scripts["backfill:2fa"];
}

/**
 * Run the documented command without a shell.
 *
 * The old test used `sh -c`, which does not exist on Windows: `spawnSync`
 * returned `status: null` before the command started. Resolve the loader from
 * `node_modules` and pass the rest of the package script to it through the
 * current `node` binary instead — the same thing npm does, on every platform.
 */
function runBackfillHelp() {
  const command = backfillCommand();
  const parts = command.split(/\s+/).filter(Boolean);
  assert.equal(parts[0], "tsx", `the documented command must use the tsx loader: ${command}`);
  const tsxCli = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  return spawnSync(process.execPath, [tsxCli, ...parts.slice(1), "--help"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
}

if (process.env.VITEST) {
  const { describe, it } = await import("vitest");

  describe("the backfill command (B134)", () => {
    it("runs and prints its usage", () => {
      const result = runBackfillHelp();

      assert.equal(
        result.status,
        0,
        `the documented command must run\n${backfillCommand()}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
      );
      assert.match(
        `${result.stdout ?? ""}${result.stderr ?? ""}`,
        /backfill:2fa/,
        "the command must print its usage",
      );
    });
  });
} else {
  const result = runBackfillHelp();
  assert.equal(result.status, 0, `the documented command must run\n${result.stderr ?? ""}`);
  console.log("ok — the documented backfill command runs");
}
