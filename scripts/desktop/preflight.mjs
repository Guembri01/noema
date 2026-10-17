#!/usr/bin/env node
/**
 * Desktop preflight: tells you exactly what is missing before a build fails
 * somewhere deep inside Cargo. Run it first (it is also wired into
 * `npm run desktop:build`).
 *
 * Checks, in the order they bite:
 *   1. node + npm versions
 *   2. the Rust toolchain (rustc, cargo, the target triple)
 *   3. the platform's native prerequisites (WebView2 / Xcode CLT / webkit2gtk)
 *   4. generated icons (Tauri refuses to bundle without them)
 *   5. the sidecar binary for this triple
 *   6. the Next standalone build
 *
 * Exit code 1 with an actionable list when something is missing. Nothing is
 * installed automatically: this is a local-first project, and a build step that
 * silently installs system packages is not acceptable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sidecarPath, targetTriple } from "./sidecar.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const os = platform();
const problems = [];
const notes = [];

const ok = (label) => console.log(`  ok    ${label}`);
const bad = (label, fix) => {
  problems.push(`${label}\n        fix: ${fix}`);
  console.log(`  FAIL  ${label}`);
};
const warn = (label) => {
  notes.push(label);
  console.log(`  warn  ${label}`);
};

function version(command, args = ["--version"]) {
  try {
    return execFileSync(command, args, { encoding: "utf8", shell: os === "win32" }).trim();
  } catch {
    return null;
  }
}

console.log("Noema desktop preflight\n");

// 1. Node / npm.
const node = process.versions.node;
const major = Number(node.split(".")[0]);
if (major >= 20) ok(`node ${node}`);
else bad(`node ${node}`, "install Node 20+ (the SEA build and Next 15 need it)");
const npmVersion = version("npm.cmd") ?? version("npm");
npmVersion ? ok(`npm ${npmVersion}`) : warn("npm not on PATH (fine if you only run tauri)");

// 2. Rust toolchain.
const rustc = version("rustc");
const cargo = version("cargo");
rustc ? ok(rustc) : bad("rustc not found", "install Rust: https://rustup.rs  (then `rustup default stable`)");
cargo ? ok(cargo) : bad("cargo not found", "install Rust: https://rustup.rs");
const triple = targetTriple();
if (cargo) {
  try {
    const installed = execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8", shell: os === "win32" });
    if (installed.includes(triple)) ok(`rust target ${triple}`);
    else bad(`rust target ${triple} not installed`, `rustup target add ${triple}`);
  } catch {
    warn("rustup not found (fine if rustc came from a distro package)");
  }
}

// 3. Platform prerequisites.
if (os === "win32") {
  notes.push("Windows: WebView2 runtime (preinstalled on Windows 11; otherwise Evergreen bootstrapper) is required by the app and by the installer");
  ok(`windows ${release()}`);
} else if (os === "darwin") {
  try {
    execFileSync("xcode-select", ["-p"], { stdio: "ignore" });
    ok("xcode command line tools");
  } catch {
    bad("xcode command line tools missing", "xcode-select --install");
  }
} else {
  const pkgConfig = version("pkg-config");
  pkgConfig ? ok(`pkg-config ${pkgConfig}`) : bad("pkg-config missing", "apt install pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev");
}

// 4. Icons.
const iconsDir = join(root, "src-tauri", "icons");
const iconFiles = existsSync(iconsDir) ? readdirSync(iconsDir).filter((f) => /\.(png|ico|icns)$/.test(f)) : [];
if (iconFiles.length >= 3) ok(`icons (${iconFiles.length} files)`);
else bad("icon set missing", "npx.cmd tauri icon assets/icon.png   (then re-run this check)");

// 5. Sidecar.
const sidecar = sidecarPath(triple);
if (existsSync(sidecar)) ok(`sidecar ${sidecar.replace(root + "\\", "").replace(root + "/", "")}`);
else bad("sidecar binary missing", "npm run desktop:sidecar   (adds postject if needed; or NOEMA_SIDECAR_MODE=shim for dev)");

// 6. Next standalone.
if (existsSync(join(root, ".next", "standalone", "server.js"))) ok("next standalone build");
else warn("next standalone build missing (npm run desktop:sidecar builds it)");

console.log("");
if (notes.length > 0) {
  console.log("Notes:");
  for (const note of notes) console.log(`  - ${note}`);
  console.log("");
}
if (problems.length > 0) {
  console.error(`${problems.length} blocker(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("Everything needed for a desktop build is present.");
