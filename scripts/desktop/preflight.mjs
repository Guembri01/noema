#!/usr/bin/env node
/**
 * Desktop preflight: tells you exactly what is missing before a build fails
 * somewhere deep inside Cargo. Run it first; `npm run desktop:build` also
 * depends on everything it checks.
 *
 * Checks, in the order they bite:
 *   1. node + npm versions
 *   2. the Rust toolchain and **the linker** (the one people forget)
 *   3. the platform's native prerequisites (WebView2 / Xcode CLT / webkit2gtk)
 *   4. the generated icon set
 *   5. the bundled Node runtime sidecar
 *   6. the Next standalone payload (`.next/standalone` + its copied assets)
 *
 * Exit code 1 with an actionable list when something is missing. Nothing is
 * installed automatically: a build step that silently installs system packages
 * is not acceptable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeSidecarPath, targetTriple } from "./prepare.mjs";
import { REQUIRED_PAYLOAD } from "./prepare.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const os = platform();
const problems = [];
const notes = [];
const has = (command, args = ["--version"]) => {
  try {
    // `stdio` drops the "not recognized" noise from a missing command.
    return execFileSync(command, args, {
      encoding: "utf8",
      shell: os === "win32",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

const ok = (label) => console.log(`  ok    ${label}`);
const bad = (label, fix) => {
  problems.push(`${label}\n        fix: ${fix}`);
  console.log(`  FAIL  ${label}`);
};
const warn = (label) => {
  notes.push(label);
  console.log(`  warn  ${label}`);
};

console.log(`Noema desktop preflight — ${os}-${arch()}\n`);

// 1. Node / npm.
const node = process.versions.node;
if (Number(node.split(".")[0]) >= 20) ok(`node ${node}`);
else bad(`node ${node}`, "install Node 20+ (Next 15 and the standalone server need it)");
const npmVersion = has("npm.cmd") ?? has("npm");
npmVersion ? ok(`npm ${npmVersion}`) : warn("npm not on PATH");

// 2. Rust + linker.
const rustc = has("rustc");
const cargo = has("cargo");
const cargoTauri = has("cargo-tauri", ["--version"]);
rustc ? ok(rustc) : bad("rustc not found", "install Rust: https://rustup.rs (or `winget install Rustlang.Rustup`)");
cargo ? ok(cargo) : bad("cargo not found", "install Rust: https://rustup.rs");
cargoTauri
  ? ok(`tauri cli ${cargoTauri.replace(/^tauri-cli\s*/, "")}`)
  : bad("tauri CLI not found", "cargo install tauri-cli --version 2.12.3 --locked");
const triple = targetTriple();
if (os === "win32") {
  // The MSVC linker is the classic silent failure: rustc is installed, `cargo
  // build` then dies with "link.exe not found".
  const link = has("link", ["/?"]) ?? has("lld-link", ["--version"]);
  if (link) ok("msvc linker reachable");
  else {
    const vswhere = join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const vsPath =
      existsSync(vswhere)
        ? execFileSync(vswhere, ["-products", "*", "-latest", "-property", "installationPath"], {
            encoding: "utf8",
            // No shell: the path contains spaces ("C:\Program Files (x86)\...").
          }).trim()
        : "";
    if (vsPath) ok(`Visual Studio / Build Tools at ${vsPath} (rustc finds the linker there)`);
    else bad("no MSVC toolchain", "install Visual Studio Build Tools with the 'Desktop development with C++' workload");
  }
  // WebView2 is required at runtime by the app and by the installer.
  const webview = has("reg", [
    "query",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "/v",
    "pv",
  ]);
  webview ? ok("WebView2 runtime present") : warn("WebView2 runtime not detected in HKLM (usually preinstalled on Windows 11)");
} else if (os === "darwin") {
  has("xcode-select", ["-p"]) ? ok("xcode command line tools") : bad("xcode CLT missing", "xcode-select --install");
} else {
  has("pkg-config") ? ok("pkg-config") : bad("pkg-config missing", "apt install pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev");
}

// 3. Icons.
const iconsDir = join(root, "src-tauri", "icons");
const icons = existsSync(iconsDir) ? readdirSync(iconsDir).filter((f) => /\.(png|ico|icns)$/.test(f)) : [];
icons.length >= 4
  ? ok(`icon set (${icons.length} files)`)
  : bad("icon set missing", "npm run desktop:icons   (generates every size from assets/icon.png)");

// 4. Bundled runtime.
const runtime = nodeSidecarPath(triple);
existsSync(runtime)
  ? ok(`bundled node runtime (${runtime.split(/[\\/]/).pop()})`)
  : bad("bundled node runtime missing", "npm run desktop:prepare   (copies the Node runtime into src-tauri/binaries)");

// 5. Standalone payload.
const standalone = join(root, ".next", "standalone");
const staged = join(root, "src-tauri", "server");
// Check the *staged* payload (what the installer ships) and, when it is absent,
// the standalone output it is copied from.
const payloadRoot = existsSync(join(staged, "server.js")) ? staged : standalone;
const missing = REQUIRED_PAYLOAD.filter(([relative]) => !existsSync(join(payloadRoot, relative))).map(
  ([relative]) => relative,
);
missing.length === 0
  ? ok(`standalone payload complete (${payloadRoot.replace(root + "\\", "")})`)
  : bad(`payload incomplete (${missing.join(", ")})`, "npm run desktop:prepare (and never build the site version at the same time — they share .next/)");

// 6. Frontend dist (Tauri needs a directory to bundle).
existsSync(join(root, "src-tauri", "dist", "index.html"))
  ? ok("shell frontend dist")
  : bad("src-tauri/dist/index.html missing", "restore it (it is the shell's placeholder page)");

console.log("");
if (notes.length) {
  console.log("Notes:");
  for (const note of notes) console.log(`  - ${note}`);
  console.log("");
}
if (problems.length) {
  console.error(`${problems.length} blocker(s):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("Everything needed for a desktop build is present.");
