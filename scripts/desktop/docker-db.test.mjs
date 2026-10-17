/**
 * B123 — the generated database password must not reach the argument list of
 * the docker process.
 *
 * The managed database of the desktop app is created with a generated
 * password. The password is written into the state file with the mode `0o600`,
 * so the *file* side is protected — but the `docker run` that creates the
 * container used to carry it in its argument list, and an argument list is
 * world-readable: every program on the machine can read
 * `/proc/<pid>/cmdline` of every other process.
 *
 * The password therefore travels in the **environment** of the docker process:
 * `--env POSTGRES_PASSWORD` (without a value) takes the value from the
 * environment of the docker client, so the *name* is in the argument list and
 * the secret is not.
 *
 * The test drives the real helper (`ensureManagedDatabase()`) with a fake
 * `docker` in place of the real one, so it sees the command line the helper
 * actually builds. The password is read back from the state file the helper
 * writes — the same place the app reads it from — so the assertions do not
 * depend on the fix itself.
 *
 * The scope is the `docker run` call. The `docker exec -e PGPASSWORD=…` of the
 * same file is the finding B79 and is fixed on its own.
 */
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const realSpawnSync = childProcess.spawnSync;

/** Every call the helper made to the fake docker. */
let calls = [];

/** A `docker` that answers like a daemon with an empty, healthy world. */
function fakeSpawnSync(command, args, options = {}) {
  calls.push({ command, args: [...args], options });
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const missing = (what) => ({ status: 1, stdout: "", stderr: `Error: no such ${what}` });
  const [sub] = args;
  if (sub === "info") return ok("29.9.2\n");
  if (sub === "inspect") return missing("container");
  if (sub === "volume") return missing("volume");
  if (sub === "run") return ok("0123456789abcdef\n");
  if (sub === "port") return ok("127.0.0.1:5434\n");
  if (sub === "exec") {
    if (args.includes("pg_isready")) return ok("/var/run/postgresql:5432 - accepting connections\n");
    if (args.includes("psql")) return ok("1\n");
  }
  return ok();
}

let dataDir;
let helper;

beforeEach(() => {
  calls = [];
  dataDir = mkdtempSync(join(tmpdir(), "noema-docker-db-"));
  childProcess.spawnSync = fakeSpawnSync;
  // The helper takes `spawnSync` out of the module when it loads, so the fake
  // has to be in place before the module is required.
  delete require.cache[require.resolve("./docker-db.cjs")];
  helper = require("./docker-db.cjs");
});

afterEach(() => {
  childProcess.spawnSync = realSpawnSync;
  rmSync(dataDir, { recursive: true, force: true });
});

/** The call that creates the container. */
const runCall = () => calls.find((call) => call.args[0] === "run");

/** The password, read back from the state file the helper wrote. */
const storedPassword = () =>
  JSON.parse(readFileSync(join(dataDir, "managed-database.json"), "utf8")).password;

describe("the managed database (B123)", () => {
  it("keeps the generated password out of the argument list of the docker process", async () => {
    const managed = await helper.ensureManagedDatabase({ dataDir });
    expect(managed).not.toBeNull();

    const password = storedPassword();
    expect(password).toBeTruthy();

    const call = runCall();
    expect(call).toBeDefined();
    // The value is nowhere in the argument list.
    for (const argument of call.args) {
      expect(argument).not.toContain(password);
    }
    // The name is in the argument list, the value is not.
    expect(call.args).toContain("POSTGRES_PASSWORD");
    // … and the value is in the environment of the process instead.
    expect(call.options.env.POSTGRES_PASSWORD).toBe(password);
  });

  it("hands the password to the container in the environment of the docker client", async () => {
    await helper.ensureManagedDatabase({ dataDir });
    const call = runCall();
    // `--env NAME` without a value takes the value from the environment of the
    // docker client — so the name has to stand alone behind its flag.
    const at = call.args.indexOf("POSTGRES_PASSWORD");
    expect(at).toBeGreaterThan(0);
    expect(call.args[at - 1]).toBe("-e");
    // The rest of the environment has to survive: the spawn replaces it.
    expect(call.options.env.PATH).toBe(process.env.PATH);
  });

  it("still hands the app a working URL and stores the password in a private file", async () => {
    const managed = await helper.ensureManagedDatabase({ dataDir });
    const password = storedPassword();

    expect(managed.url).toBe(
      `postgresql://noema:${encodeURIComponent(password)}@127.0.0.1:5434/noema?schema=public`,
    );
    expect(managed.port).toBe(5434);
    expect(managed.managed).toBe(true);

    const mode = statSync(join(dataDir, "managed-database.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
