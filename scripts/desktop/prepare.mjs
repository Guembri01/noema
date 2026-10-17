#!/usr/bin/env node
/**
 * Prepares everything the desktop bundle needs, before Tauri packs it.
 *
 *   1. `next build` with `output: "standalone"`      → .next/standalone
 *   2. copy `.next/static` and `public/` into it     (Next does not do this itself)
 *   3. copy the Prisma CLI + engines into it         (so first run can migrate)
 *   4. write `start.cjs`                             (migrate, then serve)
 *   5. copy the Node runtime to src-tauri/binaries/  (the sidecar Tauri ships)
 *
 * Why a bundled runtime and not a Node Single Executable Application: the Next
 * standalone server resolves its dependency graph from `node_modules` with
 * dynamic `require`, and Prisma loads a native query engine. A SEA blob cannot
 * carry either, so the "one file server" would build and then fail to boot.
 * Shipping `node.exe` costs ~60 MB and requires nothing of the user.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
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
  const nodeModules = join(standalone, "node_modules");
  for (const pkg of ["prisma", "@prisma"]) {
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
  // The boot wrapper requires this next to itself.
  copyFileSync(
    join(root, "scripts", "desktop", "docker-db.cjs"),
    join(standalone, "docker-db.cjs"),
  );
  console.log("· copied boot wrapper → start.cjs (managed database → migrate → serve)");
}

function copyNodeRuntime() {
  const triple = targetTriple();
  mkdirSync(binariesDir, { recursive: true });
  const target = nodeSidecarPath(triple);
  // `process.execPath` is the Node that is running this script, so the runtime
  // we ship always matches the runtime we built with.
  cpSync(process.execPath, target);
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
  const target = join(root, "src-tauri", "server");
  const staging = join(root, "src-tauri", "server.tmp");
  rmSync(staging, { recursive: true, force: true });
  cpSync(standalone, staging, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  console.log(`· staged payload → src-tauri/server/ (${mb(size(target))})`);
}

function main() {
  if (process.env.NOEMA_SKIP_BUILD !== "1") buildStandalone();
  // After the build, only the build's own output must exist…
  assertPayload([["server.js", "the Next standalone server entry"]]);
  copyRuntimeAssets();
  writeBootScript();
  // …and after the copies, everything the installer ships must be present.
  assertPayload();
  copyNodeRuntime();
  stageIntoTauri();
  console.log(`\nstandalone payload: ${mb(size(standalone))}`);
  console.log("next: npm run desktop:build");
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (invokedDirectly) main();
