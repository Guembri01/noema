#!/usr/bin/env node
/**
 * Prepares everything the desktop bundle needs, before Tauri packs it.
 *
 *   1. `next build` with `output: "standalone"`      → .next/standalone
 *   2. copy `.next/static` and `public/` into it     (Next does not do this itself)
 *   3. copy the Prisma CLI + engines into it         (so first run can migrate)
 *   4. write `start.cjs`                             (database → migrate → serve)
 *   5. strip the `.env` Next copied in               (it carries the dev URL + secrets)
 *   6. copy the Node runtime to src-tauri/binaries/  (the sidecar Tauri ships)
 *
 * Why a bundled runtime and not a Node Single Executable Application: the Next
 * standalone server resolves its dependency graph from `node_modules` with
 * dynamic `require`, and Prisma loads a native query engine. A SEA blob cannot
 * carry either, so the "one file server" would build and then fail to boot.
 * Shipping `node.exe` costs ~60 MB and requires nothing of the user.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const standalone = join(root, ".next", "standalone");
const binariesDir = join(root, "src-tauri", "binaries");

/** Rust target triple for this machine (Tauri names external binaries with it). */
export function targetTriple(os = platform(), cpu = arch()) {
  const table = {
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
  };
  const triple = table[`${os}-${cpu}`];
  if (!triple) throw new Error(`unsupported platform ${os}-${cpu}`);
  return triple;
}

/** Where the Node runtime sidecar must land for the current platform. */
export function nodeSidecarPath(triple = targetTriple()) {
  const suffix = triple.includes("windows") ? ".exe" : "";
  return join(binariesDir, `noema-node-${triple}${suffix}`);
}

const run = (file, args, options = {}) =>
  execFileSync(file, args, { stdio: "inherit", cwd: root, shell: process.platform === "win32", ...options });

const size = (path) => {
  const stats = statSync(path);
  if (stats.isFile()) return stats.size;
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  walk(path);
  return total;
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Refuse to reuse a build that is older than the source.
 *
 * `NOEMA_SKIP_BUILD=1` exists so a smoke test or a re-bundle does not pay for a
 * fresh `next build` — but it also happily ships stale application code, which is
 * how a desktop payload ended up without an app/page.tsx change that had already
 * been written and tested. Comparing the build stamp against `src/` turns that
 * silent staleness into a clear error.
 */
function assertBuildIsFresh() {
  const stamp = join(root, ".next", "BUILD_ID");
  if (!existsSync(stamp)) return;
  const builtAt = statSync(stamp).mtimeMs;
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.(tsx?|css|json)$/.test(entry.name)) {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  walk(join(root, "src"));
  // …and the config, which is serialized *into* the payload
  // (`required-server-files.json`, and the literal in the standalone entry).
  // Without it here, a change to the Server Action allowlist would be ignored by
  // a `NOEMA_SKIP_BUILD=1` re-stage, which is precisely the change that has to
  // reach the payload.
  const configFile = join(root, "next.config.ts");
  if (existsSync(configFile)) newest = Math.max(newest, statSync(configFile).mtimeMs);
  if (newest > builtAt + 1000) {
    throw new Error(
      [
        "refusing to reuse .next: src/ changed after the last build.",
        `  build stamp: ${new Date(builtAt).toISOString()}`,
        `  newest source: ${new Date(newest).toISOString()}`,
        "",
        "Run without NOEMA_SKIP_BUILD=1 so the payload contains current code:",
        "",
        "    npm run desktop:prepare",
      ].join("\n"),
    );
  }
}

function buildStandalone() {
  console.log("· next build (output: standalone)…");
  run("npx.cmd", ["next", "build"], {
    env: { ...process.env, NOEMA_RUNTIME: "desktop", NOEMA_STANDALONE: "1" },
  });
  if (!existsSync(join(standalone, "server.js"))) {
    throw new Error(
      '`.next/standalone/server.js` is missing — next.config.ts must set `output: "standalone"` when NOEMA_STANDALONE=1.',
    );
  }
}

/** Everything a working server needs. Checked before anything is staged. */
export const REQUIRED_PAYLOAD = [
  ["server.js", "the Next standalone server entry"],
  [".next/static", "the built client assets"],
  ["node_modules/next", "Next's runtime (traced dependencies)"],
  ["public", "static files served by the app"],
  ["prisma/schema.prisma", "the database schema"],
  ["start.cjs", "the boot wrapper (database → migrate → serve)"],
  ["docker-db.cjs", "the managed-database helper"],
  ["embedded-db.cjs", "the embedded-database helper"],
  ["allowed-origins.cjs", "the Server Action origin policy the wrapper recomputes at launch"],
  ["node_modules/@electric-sql/pglite", "the embedded PostgreSQL engine (WASM)"],
  ["node_modules/@electric-sql/pglite-socket", "the wire protocol Prisma connects over"],
];

/**
 * Fail loudly if `.next/standalone` is not a complete standalone build.
 *
 * This exists because it is easy to produce a *plausible* broken bundle: a
 * `next build` without `NOEMA_STANDALONE=1` (the site build) rewrites `.next/`
 * and removes `server.js`, and a desktop build with `NOEMA_SKIP_BUILD=1` will
 * happily copy the leftovers — producing an installer that boots to nothing.
 * Measured, not assumed.
 *
 * Two call sites, two expectations:
 *  · `["server.js"]` right after the build — that is all the build must produce;
 *  · the full list after the copy steps — that is what ships.
 */
function assertPayload(required = REQUIRED_PAYLOAD) {
  const missing = required.filter(([relative]) => !existsSync(join(standalone, relative)));
  if (missing.length === 0) return;
  const nothingBuilt = !existsSync(join(standalone, "server.js"));
  throw new Error(
    [
      nothingBuilt
        ? ".next/standalone has no server.js — the standalone build has not run."
        : ".next/standalone is incomplete:",
      ...(nothingBuilt ? [] : missing.map(([relative, why]) => `  - ${relative} (${why})`)),
      "",
      "Most likely one of:",
      "  · a site build (`next build` without NOEMA_STANDALONE=1) replaced the",
      "    standalone output — the two builds share .next/ and must not overlap;",
      "  · `NOEMA_SKIP_BUILD=1` reused a `.next` that had been wiped or replaced.",
      "",
      "Fix: rebuild the payload, without skipping the build:",
      "",
      "    npm run desktop:prepare",
    ].join("\n"),
  );
}

/**
 * Resolve a package the way Node does, walking up from `from` to the repo root.
 * Hoisting is the normal case; the walk keeps a nested layout working too.
 */
function resolvePackageDir(name, from = root) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (!parent.startsWith(root)) return null;
    dir = parent;
  }
}

/**
 * Stage a package together with the dependency closure it actually imports.
 *
 * `node_modules/prisma` is not self-contained: its CLI is a thin shell around
 * `@prisma/config` and third-party packages (`effect`, `jiti`, …) that a hoisted
 * node_modules keeps at the top level. Next's trace only covers what the *app*
 * imports, so none of them ship by default — and the breakage is invisible from a
 * checkout, because Node resolves the missing package from the repo's own
 * node_modules. On a user's machine it is fatal: `migrate deploy` dies with
 * `Cannot find module 'effect'`, no schema is created, and the app answers 503.
 * That is measured, on a fresh install with no Postgres running.
 *
 * An unresolvable *required* dependency fails the build here, deliberately: a
 * loud packager beats an installer that cannot migrate.
 */
function bundlePackageClosure(roots, destination = join(standalone, "node_modules")) {
  const visited = new Set();
  const copied = [];
  const queue = roots.map((name) => ({ name, from: root }));
  while (queue.length) {
    const { name, from } = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);

    const source = resolvePackageDir(name, from);
    if (!source) throw new Error(`cannot resolve '${name}' from ${from} — the payload needs it`);
    const target = join(destination, name);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
      copied.push(name);
    }

    // Only runtime dependencies: dev and optional ones are not needed to migrate,
    // and an optional platform binary is resolved from the app when it exists.
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name: dependency, from: source });
    }
  }
  return copied;
}

function copyRuntimeAssets() {
  // Next's own docs are explicit: static assets and `public/` are NOT traced
  // into the standalone output. Without these two copies the app boots and then
  // serves an unstyled, script-less page.
  const staticFrom = join(root, ".next", "static");
  const staticTo = join(standalone, ".next", "static");
  if (existsSync(staticFrom)) {
    rmSync(staticTo, { recursive: true, force: true });
    cpSync(staticFrom, staticTo, { recursive: true });
    console.log(`· copied .next/static → ${mb(size(staticTo))}`);
  } else {
    throw new Error(".next/static is missing — did the build succeed?");
  }

  const publicFrom = join(root, "public");
  if (existsSync(publicFrom)) {
    const publicTo = join(standalone, "public");
    rmSync(publicTo, { recursive: true, force: true });
    cpSync(publicFrom, publicTo, { recursive: true });
  }

  // Migrations + schema travel with the app, so a fresh database can be set up
  // by the user without a terminal.
  const prismaFrom = join(root, "prisma");
  if (existsSync(prismaFrom)) {
    const prismaTo = join(standalone, "prisma");
    rmSync(prismaTo, { recursive: true, force: true });
    cpSync(prismaFrom, prismaTo, { recursive: true });
  }

  // The Prisma CLI (and its engines) are what make `migrate deploy` possible on
  // first run. `@prisma/client` is already traced in; these are not.
  //
  // The embedded database is here for the same reason: Next never sees it (the
  // boot wrapper requires it), so its packages must be staged explicitly — and it
  // must ship, or a fresh install has no database at all.
  const nodeModules = join(standalone, "node_modules");
  for (const pkg of [
    "prisma",
    "@prisma",
    "@electric-sql/pglite",
    "@electric-sql/pglite-socket",
  ]) {
    const from = join(root, "node_modules", pkg);
    if (!existsSync(from)) continue;
    const to = join(nodeModules, pkg);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    console.log(`· bundled ${pkg} → ${mb(size(to))}`);
  }

  // Prisma's generated client keeps its engine outside node_modules/.prisma in
  // some layouts; make sure whichever exists is present in the bundle.
  const generatedFrom = join(root, "node_modules", ".prisma");
  if (existsSync(generatedFrom)) {
    const generatedTo = join(nodeModules, ".prisma");
    rmSync(generatedTo, { recursive: true, force: true });
    cpSync(generatedFrom, generatedTo, { recursive: true });
  }

  // …and the CLI needs its own dependencies, which Next never traces (they are
  // only reachable from `node_modules/prisma`, not from the app).
  const closure = bundlePackageClosure(["prisma"]);
  if (closure.length) {
    console.log(`· bundled the Prisma CLI's dependencies → ${closure.length} package(s)`);
  }
}

/**
 * Remove the development `.env` from the payload.
 *
 * Next's standalone output copies `.env` files into `.next/standalone` itself, so
 * without this step the installer would ship the *developer's* environment: the
 * development `DATABASE_URL` (which is why an install used to insist on a Postgres
 * on `localhost:5433`), a single `AUTH_SECRET` shared by every copy of the
 * installer, and the AI API keys.
 *
 * A packaged install needs none of it: the boot wrapper provisions its own
 * database and generates its own session secret, and anything a user configures
 * travels through the app's own settings. `.env.example` stays, because it is
 * documentation rather than configuration.
 *
 * The check afterwards is the point of the function: a future Next release (or a
 * rename) that starts copying something else must fail the build, not ship a
 * secret.
 */
function stripDevelopmentEnv() {
  const kept = new Set([".env.example"]);
  const removed = readdirSync(standalone).filter(
    (entry) => (entry === ".env" || entry.startsWith(".env.")) && !kept.has(entry),
  );
  for (const entry of removed) rmSync(join(standalone, entry), { force: true });
  if (removed.length) console.log(`· stripped development env from the payload (${removed.join(", ")})`);

  const leaked = readdirSync(standalone).filter((entry) => entry === ".env" || entry.startsWith(".env."));
  const surprising = leaked.filter((entry) => !kept.has(entry));
  if (surprising.length) {
    throw new Error(
      [
        `the payload would ship environment files (${surprising.join(", ")}).`,
        "They carry the development database URL and secrets; strip them in prepare.mjs.",
      ].join("\n"),
    );
  }
}

function writeBootScript() {
  // The wrapper is a real file in the repo, not generated text: generating it
  // with a template literal meant a stray ${ or backtick in the generated code
  // broke the packager itself. Copying keeps it lintable and reviewable.
  const source = join(root, "scripts", "desktop", "boot-wrapper.cjs");
  if (!existsSync(source)) {
    throw new Error("scripts/desktop/boot-wrapper.cjs is missing (it is the payload's entry point)");
  }
  const boot = join(standalone, "start.cjs");
  copyFileSync(source, boot);
  // The boot wrapper requires these next to itself (defensively, so an older
  // payload still boots without them). `allowed-origins.cjs` is the same policy
  // next.config.ts imports: the wrapper recomputes the Server Action allowlist
  // for the machine the app actually runs on, rather than the one that built it.
  for (const helper of ["docker-db.cjs", "embedded-db.cjs", "allowed-origins.cjs"]) {
    copyFileSync(join(root, "scripts", "desktop", helper), join(standalone, helper));
  }
  console.log("· copied boot wrapper → start.cjs (embedded PostgreSQL → Docker → migrate → serve)");
}

function copyNodeRuntime() {
  const triple = targetTriple();
  mkdirSync(binariesDir, { recursive: true });
  const target = nodeSidecarPath(triple);

  // Windows locks a running executable, and the staged server *runs from this
  // payload* during smoke tests — so this copy is the step that fails with EPERM
  // while a bundled server is alive. Identical content is the normal case (same
  // Node), so a locked-but-identical binary is not worth failing a build over.
  const sameSize = existsSync(target) && statSync(target).size === statSync(process.execPath).size;
  if (sameSize && readFileSync(target).equals(readFileSync(process.execPath))) {
    console.log("· node runtime already current (identical, left in place)");
    return;
  }
  try {
    cpSync(process.execPath, target);
  } catch (error) {
    if (["EPERM", "EBUSY", "EACCES"].includes(error.code)) {
      throw new Error(
        [
          `cannot replace the bundled runtime at ${target} — it is in use.`,
          "Close the running Noema app (or any 'bundled server' smoke test) and retry.",
        ].join("\n"),
      );
    }
    throw error;
  }
  console.log(`· node runtime → src-tauri/binaries/${target.split(/[\\/]/).pop()} (${mb(size(target))})`);
}

function stageIntoTauri() {
  // The payload is staged inside src-tauri so `bundle.resources` can be a plain
  // `["server/"]` array. Mapping `../.next/standalone` through the resource
  // resolver works in some versions and silently lands under `_up_/` in others;
  // staging removes that class of surprise, and the staging dir is gitignored.
  //
  // Staged via a temporary directory and a rename: a build that is interrupted
  // (or a smoke test running concurrently) then sees either the old payload or
  // the new one, never a half-copied tree.
  //
  // The old payload is renamed out of the way rather than deleted first, because
  // Windows refuses to delete files that a running server still holds open — and
  // the smoke tests run the server *from* this directory.
  const target = join(root, "src-tauri", "server");
  const staging = join(root, "src-tauri", "server.tmp");
  const retired = join(root, "src-tauri", `server.old-${Date.now().toString(36)}`);
  rmSync(staging, { recursive: true, force: true });
  cpSync(standalone, staging, { recursive: true });
  if (existsSync(target)) renameSync(target, retired);
  renameSync(staging, target);
  try {
    rmSync(retired, { recursive: true, force: true });
  } catch {
    // Locked by a running server: it is gitignored and gets cleaned up later.
    console.log(`· left ${retired.split(/[\\/]/).pop()} in place (in use); it is gitignored`);
  }
  console.log(`· staged payload → src-tauri/server/ (${mb(size(target))})`);
}

/**
 * Remove the app's *runtime* state from the payload.
 *
 * Next traces the app's own `path.join(process.cwd(), …)` expressions, so a build
 * on a machine where the app has been used copies the builder's uploaded files,
 * session file and backups into `.next/standalone` - and the installer then ships
 * them. A packaged install keeps this state in its data directory (the shell
 * passes `STORAGE_DIR` and `SESSION_STORE_PATH`), so none of it belongs here.
 *
 * The check afterwards is the point: a tracing change must fail the build, not
 * ship someone else's files.
 */
const RUNTIME_STATE = ["uploads", ".data", "backups"];

function stripRuntimeState() {
  const present = RUNTIME_STATE.filter((entry) => existsSync(join(standalone, entry)));
  for (const entry of present) {
    rmSync(join(standalone, entry), { recursive: true, force: true });
  }
  if (present.length) console.log(`· stripped runtime state from the payload (${present.join(", ")})`);

  const leaked = RUNTIME_STATE.filter((entry) => existsSync(join(standalone, entry)));
  if (leaked.length) {
    throw new Error(
      [
        `the payload would ship the builder's runtime state (${leaked.join(", ")}).`,
        "A packaged install keeps uploads, sessions and backups in its data directory;",
        "strip them in prepare.mjs.",
      ].join("\n"),
    );
  }
}

function main() {
  if (process.env.NOEMA_SKIP_BUILD === "1") assertBuildIsFresh();
  else buildStandalone();
  // After the build, only the build's own output must exist…
  assertPayload([["server.js", "the Next standalone server entry"]]);
  copyRuntimeAssets();
  writeBootScript();
  stripDevelopmentEnv();
  stripRuntimeState();
  // …and after the copies, everything the installer ships must be present.
  assertPayload();
  copyNodeRuntime();
  stageIntoTauri();
  console.log(`\nstandalone payload: ${mb(size(standalone))}`);
  console.log("next: npm run desktop:build");
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly) main();
