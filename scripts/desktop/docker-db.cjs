#!/usr/bin/env node
/**
 * Managed Postgres for the desktop app, via Docker.
 *
 * The app's schema is Postgres (full-text search, `pg_trgm`), so a desktop install
 * needs a Postgres. Rather than asking the user to install and administer one,
 * the desktop build provisions its own container on first run:
 *
 *   1. use `NOEMA_DATABASE_URL` if the user configured one (CI, shared server);
 *   2. else use a container this app manages — created once, reused afterwards,
 *      with its credentials and port kept in the app's data directory;
 *   3. else fall back to the conventional local URL, so an existing Postgres
 *      still works.
 *
 * Deliberate choices:
 *  · **A private container name and volume** (`noema-postgres`, `noema-pgdata`),
 *    never `noema-db`: the project's own compose stack uses that name, and a
 *    desktop install must not adopt, restart or delete the developer's database.
 *  · **A free host port**, tried in order: if 5433 is taken (it usually is, by the
 *    compose stack) the app takes 5434, and so on.
 *  · **A generated password**, stored in the data directory with restrictive
 *    intent — a local-only database with the default `postgres/postgres` is a
 *    habit worth not having.
 *  · **Non-destructive**: the volume is never removed, and a stopped container is
 *    started rather than recreated.
 *  · **Docker Desktop is started if the engine is down** — on Windows that is the
 *    single most common reason "it just did not work".
 *
 * Exposed for the boot wrapper (`boot-wrapper.cjs`) and for manual diagnosis:
 *   node scripts/desktop/docker-db.cjs --status
 *   node scripts/desktop/docker-db.cjs --ensure
 */
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** Container/volume names are namespaced away from the project's compose stack. */
const CONTAINER = "noema-postgres";
const VOLUME = "noema-pgdata";
const IMAGE = "postgres:16-alpine";
const DB_USER = "noema";
const DB_NAME = "noema";
const STARTUP_TIMEOUT_MS = 180_000;

const log = (message) => console.log(`[noema:docker] ${message}`);

/** Where the managed-database credentials live (inside the app's data directory). */
function stateFile(dataDir) {
  return path.join(dataDir || process.cwd(), "managed-database.json");
}

function readState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dataDir), "utf8"));
  } catch {
    return null;
  }
}

function writeState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(stateFile(dataDir), JSON.stringify(state, null, 2), { mode: 0o600 });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  // Windows tools print CRLF; a trailing \r inside a password or a port silently
  // breaks whatever consumes it.
  if (typeof result.stdout === "string") result.stdout = result.stdout.replace(/\r/g, "");
  if (typeof result.stderr === "string") result.stderr = result.stderr.replace(/\r/g, "");
  return result;
}

/** `docker ...`, never throwing: a missing Docker is a normal outcome here. */
function docker(args, options = {}) {
  return run("docker", args, options);
}

/** Is the Docker engine answering? (Installed is not the same as running.) */
function dockerEngineUp() {
  const result = docker(["info", "--format", "{{.ServerVersion}}"]);
  return result.status === 0 && (result.stdout || "").trim().length > 0;
}

/** Where Docker Desktop lives on Windows. */
function dockerDesktopPath() {
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "Docker",
      "Docker",
      "Docker Desktop.exe",
    ),
    path.join(process.env.LOCALAPPDATA || "", "Docker", "Docker Desktop.exe"),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Start Docker Desktop and wait for the engine (Windows). */
async function ensureEngine() {
  if (dockerEngineUp()) return true;
  const desktop = dockerDesktopPath();
  if (!desktop) {
    log("Docker is not installed (or is not on PATH) — skipping managed database");
    return false;
  }
  log("Docker engine is not running — starting Docker Desktop…");
  run(desktop, [], { detached: true, stdio: "ignore" });
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (dockerEngineUp()) {
      log("Docker engine is up");
      return true;
    }
  }
  log("Docker Desktop did not become ready in time");
  return false;
}

/** Docker's stderr, trimmed to the line that actually says what went wrong. */
function dockerError(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  if (!text) return `exit code ${result.status}`;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^Run 'docker/.test(line) && !/^See 'docker/.test(line));
  return lines[0] || text.split("\n")[0];
}

/** The managed container's own environment, as a map. */
function containerEnv() {
  const result = docker(["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", CONTAINER]);
  if (result.status !== 0) return null;
  const pairs = String(result.stdout || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    });
  return Object.fromEntries(pairs);
}

/**
 * Recover the credentials from the container itself.
 *
 * The container's environment *is* the record of the password its cluster was
 * initialised with, so this survives a lost/reset data directory — the case that
 * otherwise led to recreating a container over an existing volume, where the new
 * password no longer matches the cluster and every connection fails.
 */
function containerCredentials() {
  const env = containerEnv();
  const password = env && env.POSTGRES_PASSWORD;
  if (!password) return null;
  return {
    user: env.POSTGRES_USER || DB_USER,
    database: env.POSTGRES_DB || DB_NAME,
    password,
  };
}

/** Remove the managed container (used to recover from a half-created one). */
function removeContainer() {
  docker(["rm", "-f", CONTAINER]);
}

/** Does the named volume already hold a Postgres cluster? */
function volumeExists(name) {
  return docker(["volume", "inspect", name]).status === 0;
}

/** The published host port of the managed container, if it has one. */
function publishedPort() {
  const result = docker(["port", CONTAINER, "5432/tcp"]);
  if (result.status !== 0) return null;
  const match = String(result.stdout || "").match(/:(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

function containerExists() {
  return docker(["inspect", "--format", "{{.State.Running}}", CONTAINER]).status === 0;
}

function containerRunning() {
  const result = docker(["inspect", "--format", "{{.State.Running}}", CONTAINER]);
  return result.status === 0 && String(result.stdout).trim() === "true";
}

function startContainer() {
  log(`starting the existing container ${CONTAINER}`);
  return docker(["start", CONTAINER]).status === 0;
}

/** Wait until the container answers `pg_isready`. */
async function waitForPostgres() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = docker(["exec", CONTAINER, "pg_isready", "-U", DB_USER, "-d", DB_NAME]);
    if (result.status === 0) return true;
    await sleep(1500);
  }
  return false;
}

/**
 * Can we actually authenticate with these credentials?
 *
 * `pg_isready` only says a server is listening, and a `docker exec psql` without
 * `-h` connects over the local socket, where the image trusts everyone — so
 * neither proves the password works. This connects over **TCP inside the
 * container**, which goes through `scram-sha-256` exactly like the app will.
 *
 * It exists because the failure it catches is nasty: a container recreated over a
 * volume that already holds a cluster keeps the *old* password (the image only
 * honours `POSTGRES_PASSWORD` on first init), so the app would hand the server a
 * password that cannot work and the user would see an endless "unhealthy".
 *
 * The password does not go into the argument list of the docker process: the
 * argument list of a process is world-readable. It travels in the environment
 * of that process, and the `-e` flag names only the variable — the docker
 * client takes the value from its own environment, exactly like it does for
 * `docker run -e NAME`.
 */
function verifyCredentials(password) {
  const result = docker(
    [
      "exec",
      "-e",
      "PGPASSWORD",
      CONTAINER,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      DB_USER,
      "-d",
      DB_NAME,
      "-tAc",
      "select 1",
    ],
    { env: { ...process.env, PGPASSWORD: password } },
  );
  return result.status === 0 && String(result.stdout || "").trim() === "1";
}

/**
 * Create the container (and its volume) with a generated password.
 *
 * The host port is chosen by **Docker** (`-p 127.0.0.1::5432`), not by us: any
 * fixed port can collide with a Postgres the user already runs — this project's
 * own compose stack publishes 5433, which is the very first candidate — and the
 * install would then fail with "port is already allocated", a message nobody can
 * act on. Letting Docker pick removes the whole class.
 */
async function createContainer(password, volume) {
  log(`creating ${CONTAINER} (${IMAGE}) on the volume ${volume}`);
  const created = docker([
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-e",
    `POSTGRES_USER=${DB_USER}`,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    `POSTGRES_DB=${DB_NAME}`,
    "-p",
    "127.0.0.1::5432",
    "-v",
    `${volume}:/var/lib/postgresql/data`,
    "--restart",
    "unless-stopped",
    IMAGE,
  ]);
  if (created.status !== 0) {
    log(`could not create the container: ${dockerError(created)}`);
    // Never leave a half-created container behind: the next attempt would find a
    // broken container it cannot use and could not explain.
    removeContainer();
    return null;
  }
  const port = publishedPort();
  if (!port) {
    log("the container was created but has no published port");
    removeContainer();
    return null;
  }
  return port;
}

function buildUrl(port, password) {
  return `postgresql://${DB_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${DB_NAME}?schema=public`;
}

/**
 * Ensure a managed Postgres is running and return its connection URL.
 *
 * Returns `null` when Docker is unavailable — the caller then falls back to a
 * conventional local URL, and the app's own bootstrap page can ask for one.
 */
async function ensureManagedDatabase({ dataDir } = {}) {
  if (!(await ensureEngine())) return null;

  // A container we already made: recover its credentials and reuse it.
  if (containerExists()) {
    const stored = readState(dataDir);
    // Prefer what we stored; fall back to the container's own environment, which
    // still knows the password its cluster was initialised with even if the data
    // directory (and therefore our record) is gone.
    const credentials = stored?.password
      ? { password: stored.password, user: stored.user || DB_USER, database: stored.database || DB_NAME }
      : containerCredentials();
    const port = publishedPort() || stored?.port;

    if (credentials && port) {
      let usable = true;
      if (!containerRunning() && !startContainer()) {
        log(`could not start ${CONTAINER}`);
        usable = false;
      } else if (!(await waitForPostgres())) {
        log(`${CONTAINER} did not become ready`);
        usable = false;
      }
      if (usable && !verifyCredentials(credentials.password)) {
        log("the container's credentials do not match its data — recreating it");
        usable = false;
      }
      if (usable) {
        if (!stored?.password) {
          // Remember what we recovered, so the next launch is a plain read.
          try {
            writeState(dataDir, { container: CONTAINER, volume: VOLUME, port, ...credentials });
          } catch {
            // Losing the cache is not fatal: recovery works every time.
          }
        }
        log(`reusing ${CONTAINER} on 127.0.0.1:${port}`);
        return { url: buildUrl(port, credentials.password), port, container: CONTAINER, managed: true };
      }
    }

    // Unusable: remove it. Its volume is preserved, never deleted.
    log(`${CONTAINER} is unusable without its credentials — recreating it`);
    removeContainer();
  }

  // First run (or a recovery): generate credentials and create the container.
  //
  // If a volume from a previous install still exists, the new container gets a
  // **new** volume name: a fresh Postgres over an old cluster would keep the old
  // password (the image only honours POSTGRES_PASSWORD on first init), so the
  // credentials we just generated would never work. Leaving the old volume in
  // place — untouched, never deleted — is the only honest option when its
  // password is unknown.
  const password = crypto.randomBytes(24).toString("base64url");
  let volume = VOLUME;
  if (volumeExists(VOLUME)) {
    volume = `${VOLUME}-${Date.now().toString(36)}`;
    log(`previous data volume preserved; this install uses ${volume}`);
  }
  const port = await createContainer(password, volume);
  if (!port) return null;
  if (!(await waitForPostgres())) {
    log(`${CONTAINER} was created but did not become ready`);
    return null;
  }
  if (!verifyCredentials(password)) {
    // Should be impossible with a fresh volume; if it ever happens, say so loudly
    // instead of starting a server that cannot connect.
    log("the new container rejected its own credentials — refusing to use it");
    return null;
  }
  try {
    writeState(dataDir, { container: CONTAINER, volume, port, user: DB_USER, database: DB_NAME, password });
  } catch (error) {
    log(`could not persist credentials: ${error.message}`);
  }
  log(`managed database ready on 127.0.0.1:${port}`);
  return { url: buildUrl(port, password), port, container: CONTAINER, managed: true };
}

/** Human-readable status, for `--status` and for support. */
async function status({ dataDir } = {}) {
  const state = readState(dataDir);
  return {
    dockerInstalled: docker(["--version"]).status === 0,
    engineUp: dockerEngineUp(),
    containerExists: containerExists(),
    containerRunning: containerRunning(),
    publishedPort: publishedPort(),
    storedCredentials: Boolean(state?.password),
    stateFile: stateFile(dataDir),
  };
}

module.exports = {
  CONTAINER,
  VOLUME,
  IMAGE,
  DB_USER,
  DB_NAME,
  buildUrl,
  ensureManagedDatabase,
  dockerEngineUp,
  status,
};

if (require.main === module) {
  const dataDir = process.env.NOEMA_DATA_DIR || process.cwd();
  const mode = process.argv.includes("--ensure") ? "ensure" : "status";
  (async () => {
    if (mode === "ensure") {
      const managed = await ensureManagedDatabase({ dataDir });
      console.log(managed ? managed.url.replace(/\/\/[^@]*@/, "//***@") : "unavailable");
      process.exit(managed ? 0 : 1);
    }
    console.log(JSON.stringify(await status({ dataDir }), null, 2));
  })();
}
