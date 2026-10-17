#!/usr/bin/env node
/**
 * Builds the desktop sidecar: the Next.js standalone server, compiled into a
 * single executable that Tauri ships as an `externalBin`.
 *
 * Flow:
 *   1. `next build` with `output: "standalone"`  → .next/standalone/server.js
 *   2. bundle a launcher + the whole server tree as SEA *assets*
 *   3. `node --experimental-sea-config`          → dist/sea-prep.blob
 *   4. copy the node binary + `postject` the blob → binaries/noema-server[-<triple>[.exe]]
 *
 * Why SEA (and not "just run node"): an installable app must not require Node to
 * be installed. Node's Single Executable Application support is the supported,
 * dependency-light way to get there; `postject` is the injector.
 *
 * When a prerequisite is missing the script fails with the exact command to run
 * rather than producing a half-broken bundle. `NOEMA_SIDECAR_MODE=shim` builds a
 * development shim instead (a launcher that uses the system `node`), which is
 * what `tauri dev` uses.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binariesDir = join(root, "src-tauri", "binaries");
const distDir = join(root, "dist");
const mode = process.env.NOEMA_SIDECAR_MODE ?? "sea";

/** Rust target triple for the current machine (Tauri names external binaries with it). */
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

/** Where the sidecar binary must land for the current platform. */
export function sidecarPath(triple = targetTriple()) {
  const suffix = triple.includes("windows") ? ".exe" : "";
  return join(binariesDir, `noema-server-${triple}${suffix}`);
}

const run = (file, args, options = {}) =>
  execFileSync(file, args, { stdio: "inherit", cwd: root, shell: process.platform === "win32", ...options });

function has(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    return true;
  } catch {
    return false;
  }
}

function buildNext() {
  console.log("· building the Next.js standalone server…");
  run("npx.cmd", ["next", "build"], {
    env: { ...process.env, NOEMA_RUNTIME: "desktop", NOEMA_STANDALONE: "1" },
  });
  const server = join(root, ".next", "standalone", "server.js");
  if (!existsSync(server)) {
    throw new Error(
      "`.next/standalone/server.js` is missing — set `output: \"standalone\"` in next.config.ts and rebuild.",
    );
  }
  return server;
}

/** The SEA launcher: starts the standalone server on the port the shell chose. */
function writeSeaEntry() {
  const entry = join(distDir, "sea-entry.cjs");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    entry,
    `// Injected as a SEA asset: start the bundled Next server, then hand over.
const path = require("node:path");
const { startServer } = require("next/dist/server/lib/start-server");

async function main() {
  const root = path.dirname(process.execPath);
  const serverDir = process.env.NOEMA_SERVER_DIR || path.join(root, "server");
  process.chdir(serverDir);
  delete process.env.__NEXT_PRIVATE_STANDALONE_CONFIG;
  await startServer({
    dir: serverDir,
    isDev: false,
    hostname: process.env.HOSTNAME || "127.0.0.1",
    port: Number(process.env.PORT || 0),
    allowRetry: true,
  });
}

main().catch((error) => {
  console.error("[noema-server] failed to start:", error);
  process.exit(1);
});
`,
  );
  return entry;
}

function writeSeaConfig(entry) {
  const configPath = join(distDir, "sea-config.json");
  const assets = {};
  // Everything the server needs at runtime travels inside the binary, so the
  // installer is one file per platform plus the app shell.
  const standalone = join(root, ".next", "standalone");
  const walk = (dir, base = "") => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = join(base, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, rel);
      else assets[`server/${rel.replace(/\\/g, "/")}`] = full;
    }
  };
  walk(standalone);
  writeFileSync(
    configPath,
    JSON.stringify(
      { main: entry, output: join(distDir, "sea-prep.blob"), disableExperimentalSEAWarning: true, assets, useSnapshot: false, useCodeCache: false },
      null,
      2,
    ),
  );
  return configPath;
}

function buildShim() {
  const triple = targetTriple();
  mkdirSync(binariesDir, { recursive: true });
  const target = sidecarPath(triple);
  const windows = triple.includes("windows");
  if (windows) {
    writeFileSync(
      target.replace(/\.exe$/, "") + ".cmd",
      `@node "%~dp0..\\..\\.next\\standalone\\server.js" %*\r\n`,
    );
  } else {
    writeFileSync(target, `#!/bin/sh\nexec node "${join(root, ".next", "standalone", "server.js")}" "$@"\n`, { mode: 0o755 });
  }
  console.log(`· shim sidecar for tauri dev → ${target}`);
}

function buildSea() {
  if (!has("node")) throw new Error("node is required");
  buildNext();
  const entry = writeSeaEntry();
  const configPath = writeSeaConfig(entry);
  const blob = join(distDir, "sea-prep.blob");
  if (existsSync(blob)) rmSync(blob);

  console.log("· generating the SEA blob…");
  run(process.execPath, ["--experimental-sea-config", configPath]);

  const triple = targetTriple();
  mkdirSync(binariesDir, { recursive: true });
  const target = sidecarPath(triple);
  cpSync(process.execPath, target);

  console.log("· injecting the blob (postject)…");
  try {
    run("npx.cmd", [
      "postject",
      target,
      "NODE_SEA_BLOB",
      blob,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ]);
  } catch {
    throw new Error(
      [
        "postject is not available, so the single-executable sidecar could not be produced.",
        "Either:  npm i -D postject        (then re-run `npm run desktop:sidecar`)",
        "Or:      set NOEMA_SIDECAR_MODE=shim and use the development shim (requires node on the machine).",
      ].join("\n"),
    );
  }

  console.log(`· sidecar ready → ${target}`);
  const size = (readFileSync(target).length / 1024 / 1024).toFixed(1);
  console.log(`  ${size} MB`);
}

function main() {
  if (process.env.NOEMA_SKIP_SIDECAR === "1") {
    console.log("· NOEMA_SKIP_SIDECAR=1 — reusing the existing sidecar");
    return;
  }
  if (mode === "shim") return buildShim();
  return buildSea();
}

// Only build when run directly. `preflight.mjs` imports this module for
// `sidecarPath`/`targetTriple`, and importing must never trigger a build.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
