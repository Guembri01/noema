import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Windows/desktop hardening regression checks that are easier to read here than
 * in Rust or in a Tauri build log.
 *
 * These pin the *configuration* that the runtime tests cannot see: the CSP the
 * shipped webview gets, the fact that the shell page has no inline script/style
 * (so `script-src 'self'` / `style-src 'self'` are enough), and the plugins that
 * are no longer linked. A future change that re-broadens one of these fails
 * before an installer is built.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

function cspDirectives() {
  const directives = new Map();
  for (const part of config.app.security.csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) directives.set(tokens[0], tokens.slice(1));
  }
  return directives;
}

describe("desktop security configuration", () => {
  it("keeps a strict self-only CSP for the local shell page", () => {
    const csp = config.app.security.csp;
    const directives = cspDirectives();

    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("style-src")).toEqual(["'self'"]);
    expect(directives.get("frame-src")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);

    // The shell page talks to Tauri's IPC only; it never fetches a remote image,
    // script, stylesheet or frame. Those were the broad escapes in the old CSP.
    for (const forbidden of [
      "unsafe-inline",
      "unsafe-eval",
      "wasm-unsafe-eval",
      "https:",
      "http://127.0.0.1:*",
      "frame-src 'self'",
    ]) {
      expect(csp, `CSP still contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("loads the shell page's script and stylesheet as external files", () => {
    const html = readFileSync(join(root, "src-tauri", "dist", "index.html"), "utf8");
    expect(html).toContain('<script src="index.js" defer></script>');
    expect(html).toContain('<link rel="stylesheet" href="index.css" />');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("has no broad local capability and no filesystem/shell plugin grant", () => {
    expect(config.app.security.capabilities).toEqual(["default", "desktop-remote"]);

    const capabilityDir = join(root, "src-tauri", "capabilities");
    for (const name of ["default.json", "desktop-remote.json"]) {
      const capability = JSON.parse(readFileSync(join(capabilityDir, name), "utf8"));
      const ids = (capability.permissions ?? []).map((entry) =>
        typeof entry === "string" ? entry : entry.identifier,
      );
      for (const id of ids) {
        expect(
          id.startsWith("shell:") || id.startsWith("fs:") || id.startsWith("store:"),
          `${name} still grants ${id}`,
        ).toBe(false);
      }
    }
  });

  it("does not link the unused Tauri plugins", () => {
    const cargo = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
    for (const plugin of [
      "tauri-plugin-dialog",
      "tauri-plugin-fs",
      "tauri-plugin-os",
      "tauri-plugin-process",
    ]) {
      expect(cargo, `Cargo.toml still links ${plugin}`).not.toContain(plugin);
    }
  });

  it("binds the desktop server to loopback and requires a strong auth secret", () => {
    const wrapper = readFileSync(join(here, "boot-wrapper.cjs"), "utf8");
    expect(wrapper).not.toContain('|| "0.0.0.0"');
    expect(wrapper).toContain("serverHostname");
    expect(wrapper).toContain("MIN_AUTH_SECRET_LENGTH = 32");
    expect(wrapper).toContain('process.env.NOEMA_RUNTIME = "desktop"');
    // The Rust shell passes the secret from DPAPI; a hand-started payload still
    // gets a file, but the generated value is explicitly random.
    expect(wrapper).toContain("crypto.randomBytes(32)");
  });
});
