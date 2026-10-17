import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * B57 — `withGlobalTauri` put the whole IPC bridge into every document.
 *
 * `withGlobalTauri: true` makes Tauri inject `window.__TAURI__` into every
 * document the web view hosts — the served app, a redirect, a foreign
 * document. The object carries the **whole** API: app, core, dpi, event,
 * image, menu, path, tray, webview, window. The app needs two things of it:
 * `core.invoke` and `event.listen`.
 *
 * The fix binds the app through the official `@tauri-apps/api` package
 * instead: the global is off, and the only bridge in the document is the one
 * the package itself builds on the shell's internals. Which commands a
 * document may call is still decided by the capabilities — the global only
 * decided *where* the code came from.
 *
 * The shell's own bootstrap page (`src-tauri/dist/index.html`) has no build
 * step and therefore no import; it talks to the same transport the package
 * uses.
 *
 * These tests pin all of it, so undoing the fix fails here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const config = JSON.parse(
  readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The directories the global must not reach any more. */
const SCAN_DIRECTORIES = ["src", "src-tauri/src", "src-tauri/dist"];

/** The files a scan reads. */
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|html|rs)$/;

/** Every source file below `directory`, recursively. */
function filesBelow(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...filesBelow(path));
    else if (SOURCE_FILE.test(entry)) found.push(path);
  }
  return found;
}

describe("the IPC bridge of the desktop shell (B57)", () => {
  it("does not put the global API object into every document", () => {
    expect(config.app.withGlobalTauri).toBe(false);
  });

  it("is used by no file of the app", () => {
    const used = [];
    for (const directory of SCAN_DIRECTORIES) {
      for (const file of filesBelow(join(root, directory))) {
        if (readFileSync(file, "utf8").includes("window.__TAURI__")) {
          used.push(file.slice(root.length + 1));
        }
      }
    }
    expect(
      used,
      `the global API object is used in ${used.join(", ")} — bind through @tauri-apps/api instead`,
    ).toEqual([]);
  });

  it("binds the app through the official package", () => {
    const dependency = pkg.dependencies?.["@tauri-apps/api"];
    expect(dependency, "@tauri-apps/api must be a real dependency").toBeTruthy();
  });

  it("uses the version of the Rust side", () => {
    // The JS API and the Rust crate are released together: the package talks
    // to the shell's internals, and a newer package can expect a newer
    // transport than the crate provides.
    const lock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");
    const crate = lock.match(/name = "tauri"\r?\nversion = "([^"]+)"/)?.[1];
    expect(crate, "the version of the tauri crate").toBeTruthy();
    const wanted = String(pkg.dependencies["@tauri-apps/api"]).replace(/^[^\d]*/, "");
    expect(wanted.startsWith(crate)).toBe(true);
  });

  it("lets the shell's own page reach the same transport", () => {
    // The bootstrap page has no bundler, so it cannot import the package — it
    // uses the internals the package itself uses.
    const page = readFileSync(join(root, "src-tauri", "dist", "index.html"), "utf8");
    expect(page).toContain("__TAURI_INTERNALS__");
    expect(page).not.toContain("window.__TAURI__");
  });
});
