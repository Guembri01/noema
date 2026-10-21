import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * B58 — the asset protocol was scoped to the whole home directory.
 *
 * `assetProtocol.scope` listed `$HOME/**` next to the app's own directories,
 * and the `asset://` scheme was allowed by the CSP (`default-src`, `img-src`,
 * `media-src`). A page in the web view could therefore point an `<img>` or a
 * `<video>` at `asset://localhost/<Home>/…` — the SSH keys, the cloud
 * credentials, the browser profiles, the shell history — and read the bytes
 * out of the user's home directory.
 *
 * The app uses **none** of it: there is not a single `convertFileSrc` and not
 * a single `asset://` URL in the tree, and the uploads are served over HTTP by
 * the app itself (`/api/files/<workspaceId>/<name>`, the app-owned prefix that
 * `src/lib/validation.ts` enforces). So the protocol is switched **off** here,
 * the scope keeps only the app's own directories (so that switching it on
 * again does not open the home directory), and the CSP no longer knows the
 * scheme.
 *
 * The tests below pin all three, so undoing the fix fails here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

const security = config.app.security ?? {};
const assetProtocol = security.assetProtocol ?? {};

/**
 * The directories the asset protocol may name: the app's own ones. `$HOME`
 * and `$TEMP` are the user's — a foreign document must not read from them.
 */
const APP_DIRECTORIES = ["$APPDATA", "$APPLOCALDATA"];

/** The CSP of the configuration, as a list of directives with their values. */
function directives(csp) {
  return String(csp ?? "")
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const [name, ...values] = directive.split(/\s+/);
      return { name, values };
    });
}

/** The directories the app's own files live in — the ones a scan has to read. */
const SCAN_DIRECTORIES = ["src", "src-tauri/src", "src-tauri/dist", "src-tauri/capabilities"];

/** The files a scan reads: the sources of the app and of the shell. */
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|html|json|rs)$/;

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

describe("the asset protocol (B58)", () => {
  it("is switched off", () => {
    // Nothing in the app uses the scheme (the test below proves it), so the
    // protocol is not registered at all: an `asset://` URL cannot resolve,
    // whatever a page asks for.
    expect(assetProtocol.enable).toBe(false);
  });

  it("names no directory outside the app's own", () => {
    const scope = assetProtocol.scope ?? [];
    expect(Array.isArray(scope)).toBe(true);
    for (const entry of scope) {
      for (const forbidden of ["$HOME", "$TEMP"]) {
        expect(
          entry.includes(forbidden),
          `the asset scope names "${entry}" — ${forbidden} is the user's directory, not the app's`,
        ).toBe(false);
      }
      expect(
        APP_DIRECTORIES.some((directory) => entry.startsWith(directory)),
        `the asset scope names "${entry}" — only the app's own directories may be in it`,
      ).toBe(true);
    }
  });

  it("is not allowed by the content security policy", () => {
    for (const { name, values } of directives(security.csp)) {
      expect(
        values.includes("asset:"),
        `the CSP directive "${name}" allows the asset scheme — the protocol is switched off, the scheme must not be allowed either`,
      ).toBe(false);
    }
  });

  it("is not compiled in — the features match the configuration", () => {
    // `tauri-build` refuses the build when the `tauri` features in
    // `Cargo.toml` do not match the configuration: with the protocol switched
    // off, the `protocol-asset` feature has to be gone as well — otherwise
    // the build script panics with "the `tauri` dependency features … does
    // not match the allowlist defined under `tauri.conf.json`" and the Rust
    // build of every platform fails.
    const cargo = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
    const line = /^tauri = \{[^\n]*features = \[([^\]]*)\]/m.exec(cargo);
    expect(line, "the tauri dependency with its features was not found in Cargo.toml").not.toBeNull();
    const features = line[1]
      .split(",")
      .map((feature) => feature.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    expect(
      features.filter((feature) => feature.startsWith("protocol-")),
      `the tauri features ${features.filter((f) => f.startsWith("protocol-")).join(", ")} do not match the configuration — with the asset protocol switched off, the protocol-asset feature has to be gone`,
    ).toEqual([]);
  });

  it("is not used by a single file of the app", () => {
    // The reason why the protocol can be switched off: the uploads are served
    // over HTTP by the app itself, not through the asset protocol.
    const used = [];
    for (const directory of SCAN_DIRECTORIES) {
      for (const file of filesBelow(join(root, directory))) {
        const source = readFileSync(file, "utf8");
        if (source.includes("convertFileSrc") || source.includes("asset://")) {
          used.push(file.slice(root.length + 1));
        }
      }
    }
    expect(
      used,
      `the app uses the asset protocol in ${used.join(", ")} — switch it on deliberately if that is intended`,
    ).toEqual([]);
  });
});
