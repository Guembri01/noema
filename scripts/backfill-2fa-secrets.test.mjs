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

if (process.env.VITEST) {
  const { describe, it } = await import("vitest");

  describe("the backfill command (B134)", () => {
    it("runs and prints its usage", () => {
      const command = `${backfillCommand()} --help`;
      const result = spawnSync("sh", ["-c", command], {
        cwd: ROOT,
        encoding: "utf8",
        // The loader lives in `node_modules/.bin`; npm puts it on the PATH
        // for a script, the test has to do it itself.
        env: { ...process.env, PATH: `${join(ROOT, "node_modules", ".bin")}:${process.env.PATH}` },
        timeout: 60_000,
      });

      assert.equal(
        result.status,
        0,
        `the documented command must run\\n${command}\\n${result.stdout ?? ""}${result.stderr ?? ""}`,
      );
      assert.match(
        `${result.stdout ?? ""}${result.stderr ?? ""}`,
        /backfill:2fa/,
        "the command must print its usage",
      );
    });
  });
} else {
  const command = `${backfillCommand()} --help`;
  const result = spawnSync("sh", ["-c", command], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(ROOT, "node_modules", ".bin")}:${process.env.PATH}` },
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `the documented command must run\n${result.stderr ?? ""}`);
  console.log("ok — the documented backfill command runs");
}
