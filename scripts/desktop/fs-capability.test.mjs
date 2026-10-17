import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The desktop capabilities decide what the shell (and the web app it serves)
// may do through the Tauri IPC. The `fs` plugin is the sharpest one: its
// scope reaches the file system, and `fs:allow-remove` / `fs:allow-rename` /
// `fs:allow-copy-file` turn that into the power to delete or overwrite the
// user's files. Nothing in this app uses the JavaScript face of the plugin —
// the shell reads and writes its files server-side, in Rust — so no capability
// may hand it out at all. `fs:default` in the local-only `default` capability
// used to stay, as the plugin's own narrow set over the app's own data
// directories; since B59 it is gone too: the page that capability covers
// (`src-tauri/dist/index.html`) never calls the plugin either, so the grant
// bought nothing and only handed out a read of the app's data directory — the
// database, the sessions and the uploads included.
const here = dirname(fileURLToPath(import.meta.url));
const capabilitiesDir = join(here, "..", "..", "src-tauri", "capabilities");

const capabilityFiles = readdirSync(capabilitiesDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({
    name,
    capability: JSON.parse(readFileSync(join(capabilitiesDir, name), "utf8")),
  }));

// A capability may also be declared inline in `tauri.conf.json`
// (`app.security.capabilities`), where the ACL assembles it exactly like a
// file. Reading only the files would leave an inline capability invisible —
// and an inline one is the easy way to smuggle a permission past a file-based
// check.
const tauriConfig = JSON.parse(
  readFileSync(join(here, "..", "..", "src-tauri", "tauri.conf.json"), "utf8"),
);
const inlineCapabilities = (tauriConfig.app?.security?.capabilities ?? [])
  .filter((entry) => typeof entry === "object" && entry !== null)
  .map((entry) => ({ name: `inline:${entry.identifier ?? "unnamed"}`, capability: entry }));

const allCapabilities = [...capabilityFiles, ...inlineCapabilities];

/** The `fs:*` permissions of a capability, scope objects included. */
function fsPermissions(capability) {
  return (capability.permissions ?? [])
    .map((permission) =>
      typeof permission === "string" ? permission : permission.identifier,
    )
    .filter((identifier) => identifier.startsWith("fs:"));
}

/** The paths a capability's `fs:scope` opens up. */
function fsScopePaths(capability) {
  return (capability.permissions ?? []).flatMap((permission) =>
    typeof permission === "string" || permission.identifier !== "fs:scope"
      ? []
      : permission.allow.map((entry) => entry.path),
  );
}

/**
 * The capabilities a remote origin can reach: the served web app is a remote
 * origin, so it is covered by the `remote` block of a capability or by a
 * capability that is remote-only.
 */
const remoteCapabilities = allCapabilities.filter(
  ({ name, capability }) => name === "desktop-remote.json" || Boolean(capability.remote),
);

describe("desktop capability file-system permissions", () => {
  it("never scopes the file system to the user's home or media directories", () => {
    const userDirectories = [
      "$HOME",
      "$DESKTOP",
      "$DOCUMENT",
      "$DOWNLOAD",
      "$PICTURE",
      "$VIDEO",
      "$AUDIO",
    ];

    for (const { name, capability } of allCapabilities) {
      for (const path of fsScopePaths(capability)) {
        for (const directory of userDirectories) {
          expect(path, `${name} scopes ${path}`).not.toContain(directory);
        }
      }
    }
  });

  it("grants no inline capability a file-system permission either", () => {
    // An inline capability is assembled by the ACL just like a file, so it
    // must not be able to smuggle the file system back in.
    for (const { name, capability } of inlineCapabilities) {
      expect(fsPermissions(capability), name).toEqual([]);
      expect(fsScopePaths(capability), name).toEqual([]);
    }
  });

  it("grants the broad capability no file-system permission at all", () => {
    const everything = capabilityFiles.find(
      (entry) => entry.name === "desktop-everything.json",
    );
    expect(everything).toBeDefined();
    expect(fsPermissions(everything.capability)).toEqual([]);
  });

  it("grants the broad capability none of the destructive file operations", () => {
    const everything = capabilityFiles.find(
      (entry) => entry.name === "desktop-everything.json",
    );
    expect(everything).toBeDefined();

    const permissions = fsPermissions(everything.capability);
    for (const forbidden of [
      "fs:allow-remove",
      "fs:allow-rename",
      "fs:allow-copy-file",
    ]) {
      expect(permissions).not.toContain(forbidden);
    }
  });

  it("grants the served web app's capability no file-system permission", () => {
    // Before the local/remote split the served web app shares the broad
    // capability; afterwards it has one of its own. Either way it must not
    // reach the file system.
    expect(remoteCapabilities.length).toBeGreaterThan(0);
    for (const { name, capability } of remoteCapabilities) {
      expect(fsPermissions(capability), name).toEqual([]);
    }
  });

  it("grants no capability the file-system plugin at all", () => {
    // The plugin's JavaScript face is unused — the shell reads and writes its
    // files in Rust, where the ACL does not gate it — so the permission buys
    // nothing and only widens what a document can reach. The narrow
    // `fs:default` in the local-only `default` capability is gone with it
    // (B59): that page never calls the plugin either.
    for (const { name, capability } of allCapabilities) {
      expect(fsPermissions(capability), name).toEqual([]);
    }
  });

  it("no longer advertises file access in the broad capability's description", () => {
    const everything = capabilityFiles.find(
      (entry) => entry.name === "desktop-everything.json",
    );
    expect(everything).toBeDefined();

    const description = everything.capability.description ?? "";
    expect(description).not.toContain("read/write the user's files");
    expect(description).not.toContain("$HOME");
  });
});
