import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * B46 — the desktop shell's capability split.
 *
 * The shell shows the **served** web app, whose origin (`http://127.0.0.1:<port>`)
 * is not the shell's own (`http://tauri.localhost`). Tauri treats that as a
 * *remote* origin, and a capability bound to a remote URL hands its permissions
 * to every script that runs there — an XSS in the app, or a page that grabbed
 * the port first. `desktop-everything` used to be bound to that URL *and* to
 * carry `shell:allow-execute` for the bundled Node sidecar with `"args": true`
 * (no argument checking at all), which is arbitrary code execution for the
 * desktop user.
 *
 * The fix is a split, not a deletion: the shell's own page keeps the broad set
 * (`desktop-everything`, local only), the served app gets a narrow one
 * (`desktop-remote`). These tests pin the split, so undoing it fails here.
 *
 * The checks below cover **every** capability the app ships — the files in
 * `src-tauri/capabilities/` *and* the ones declared inline in
 * `tauri.conf.json` (`CapabilityEntry::Inlined`), which the ACL assembles
 * exactly like the files. A split that only constrains the files can be undone
 * without touching them at all.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const capabilitiesDir = join(root, "src-tauri", "capabilities");
const tauriConfigPath = join(root, "src-tauri", "tauri.conf.json");

/**
 * Permission namespaces a **remote** origin must never hold.
 *
 * `fs:` reads and writes the user's files, `shell:` runs processes, `store:`
 * holds the unredacted connection string, `opener:`/`dialog:` reach out to the
 * OS, `process:` can quit the app, `os:` fingerprints the machine and `log:`
 * hands out the app's own log stream. None of them belongs to a web page that
 * merely happens to be served from loopback.
 */
const FORBIDDEN_REMOTE_PREFIXES = [
  "fs:",
  "shell:",
  "store:",
  "opener:",
  "dialog:",
  "process:",
  "os:",
  "log:",
];

/**
 * Permissions the **shell's own page** needs and the served app must never
 * get: the server lifecycle and the preference store, which holds the
 * unredacted database connection string.
 *
 * `store:default` is in this list for the same reason the app commands are:
 * `get_pref`/`set_pref` are thin wrappers around the store plugin
 * (`src-tauri/src/commands.rs` — `app.store(state::PREFS_FILE)`), so a remote
 * origin that holds the plugin reaches the very same file, unredacted
 * connection string included. Since B48 the plugin is withheld from *every*
 * origin (see the B48 block below) — but the served app must never get it
 * either.
 */
const SHELL_PAGE_ONLY = [
  "allow-database-url",
  "allow-get-pref",
  "allow-quit",
  "allow-restart-server",
  "allow-set-database-url",
  "allow-set-pref",
  "allow-stop-server",
  "store:default",
];

/**
 * The only `core:` permissions a remote origin may hold — exactly what
 * `listenShell` (`window.__TAURI__.event.listen`) needs to subscribe to the
 * shell's menu events, plus the unlisten that subscription returns.
 *
 * An allow-list, not a deny-list. `core:default` expands to the image plugin
 * (`plugin:image|from_path` is a bare `std::fs::read` with no scope check), to
 * the menu and tray plugins (a forged item id reaches the commands in
 * `src-tauri/src/shell.rs`), to the path plugin (it resolves the user's home
 * directory) and to `core:event:allow-emit` (the app only ever listens).
 */
const ALLOWED_REMOTE_CORE = ["core:event:allow-listen", "core:event:allow-unlisten"];

/**
 * Script files the call-site scan covers. A call site is a call site whatever
 * it is written in — a `.js` file or a single-quoted string would otherwise
 * be invisible, and `invokeShell` swallows an ACL rejection
 * (`src/lib/runtime-mode.ts`), so a command that stops being granted would
 * fail silently.
 */
const SCRIPT_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** Test files are not call sites: they exercise the helper, they do not ship. */
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** `invokeShell("…")`, `invokeShell('…')` and ``invokeShell(`…`)`` alike. */
const INVOKE_SHELL_CALL = /invokeShell\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readCapability(name) {
  return readJson(join(capabilitiesDir, name));
}

function capabilityFiles() {
  return readdirSync(capabilitiesDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function tauriConfig() {
  return readJson(tauriConfigPath);
}

/**
 * The capability **references** in `tauri.conf.json` — the names of the files
 * in `src-tauri/capabilities/`.
 */
function registeredCapabilities() {
  return tauriConfig()
    .app.security.capabilities.filter((entry) => typeof entry === "string");
}

/**
 * The capabilities declared **inline** in `tauri.conf.json`
 * (`CapabilityEntry::Inlined`). They are assembled into the ACL exactly like
 * the files are, so they have to be checked the same way — otherwise the
 * split could be undone by appending one object to the config.
 */
function inlineCapabilities() {
  return tauriConfig()
    .app.security.capabilities.filter(
      (entry) => typeof entry === "object" && entry !== null,
    );
}

/** Every capability the app ships: the files plus the inline ones. */
function allCapabilities() {
  return [
    ...capabilityFiles().map((name) => readCapability(name)),
    ...inlineCapabilities(),
  ];
}

/** The capabilities bound to a remote URL — the origin the fix distrusts. */
function remoteCapabilities() {
  return allCapabilities().filter((capability) => capability.remote);
}

/** The permission identifiers of a capability — strings or scoped objects. */
function permissionIds(capability) {
  return (capability.permissions ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.identifier,
  );
}

/**
 * The shell commands the served web app calls, read from the source rather than
 * from a list that can drift: `invokeShell("…")` in `src/**` is the app's whole
 * IPC surface (`src/lib/runtime-mode.ts`).
 */
function servedAppCommands() {
  const commands = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!SCRIPT_FILE.test(entry.name)) continue;
      // The helper's own tests are not call sites.
      if (TEST_FILE.test(entry.name)) continue;
      for (const match of readFileSync(path, "utf8").matchAll(INVOKE_SHELL_CALL)) {
        commands.add(match[1] ?? match[2] ?? match[3]);
      }
    }
  };
  walk(join(root, "src"));
  return [...commands].sort();
}

/** `desktop_info` → `allow-desktop-info` (the ACL names the commands kebab-cased). */
function allowId(command) {
  return `allow-${command.replace(/_/g, "-")}`;
}

/**
 * Call sites whose command name is not a literal. `invokeShell` swallows the
 * ACL rejection (`src/lib/runtime-mode.ts`), so a computed command would fail
 * silently in the app instead of loudly here — and the scan above would not
 * even see it.
 */
function nonLiteralCallSites() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!SCRIPT_FILE.test(entry.name)) continue;
      if (TEST_FILE.test(entry.name)) continue;
      const source = readFileSync(path, "utf8");
      const calls = (source.match(/invokeShell\s*\(/g) ?? []).length;
      const definitions =
        (source.match(/(?:export\s+)?(?:async\s+)?function\s+invokeShell\b/g) ?? []).length;
      const literals = (source.match(INVOKE_SHELL_CALL) ?? []).length;
      const nonLiteral = calls - definitions - literals;
      if (nonLiteral > 0) found.push({ file: path, count: nonLiteral });
    }
  };
  walk(join(root, "src"));
  return found;
}

describe("desktop capabilities (B46)", () => {
  it("keeps the shell's own broad capability local — no remote URL", () => {
    const everything = readCapability("desktop-everything.json");
    expect(everything.identifier).toBe("desktop-everything");
    expect(everything.remote).toBeUndefined();
    expect(everything.local).toBe(true);
    // The broad set is unchanged: the shell's own page still needs its
    // commands. (The file-system permission that used to be part of it is
    // gone — the plugin has no JavaScript face in this app, see #62.)
    const ids = permissionIds(everything);
    expect(ids).toContain("shell:allow-execute");
  });

  it("registers every capability file in tauri.conf.json", () => {
    const registered = registeredCapabilities();
    // Every file in `src-tauri/capabilities/` must be registered: a
    // capability that is not registered grants nothing, so a split that leaves
    // one of them out is a split that does not hold.
    for (const name of capabilityFiles()) {
      const identifier = name.replace(/\.json$/, "");
      expect(
        registered,
        `capability file "${name}" is not registered in tauri.conf.json`,
      ).toContain(identifier);
    }
    // And nothing else: a registered name without a file grants nothing
    // either, which is a typo that looks like a working configuration.
    for (const name of registered) {
      expect(
        capabilityFiles(),
        `tauri.conf.json registers "${name}", which has no capability file`,
      ).toContain(`${name}.json`);
    }
    // The served app's capability is the one the split exists for, so it must
    // be among the registered ones.
    expect(registered).toContain("desktop-remote");
  });

  it("grants no capability bound to a remote URL the dangerous plugins", () => {
    const remote = remoteCapabilities();
    expect(remote.length).toBeGreaterThan(0);

    for (const capability of remote) {
      for (const id of permissionIds(capability)) {
        for (const prefix of FORBIDDEN_REMOTE_PREFIXES) {
          expect(
            id.startsWith(prefix),
            `capability "${capability.identifier}" grants "${id}" to a remote origin`,
          ).toBe(false);
        }
      }
    }
  });

  it("gives the served app a capability of its own, on the loopback origin only", () => {
    expect(existsSync(join(capabilitiesDir, "desktop-remote.json"))).toBe(true);
    const remote = readCapability("desktop-remote.json");
    expect(remote.identifier).toBe("desktop-remote");
    expect(remote.remote).toEqual({ urls: ["http://127.0.0.1:*"] });
    // Local only by omission: the shell's own page is covered by `default` and
    // `desktop-everything`, so this capability must not leak into it.
    expect(remote.local).toBe(false);
  });

  it("registers the remote capability in tauri.conf.json", () => {
    const config = tauriConfig();
    const capabilities = config.app.security.capabilities;
    expect(capabilities).toContain("default");
    expect(capabilities).toContain("desktop-everything");
    expect(capabilities).toContain("desktop-remote");
  });

  it("grants the served app exactly the shell commands it calls", () => {
    const remote = readCapability("desktop-remote.json");
    const granted = permissionIds(remote).filter((id) => id.startsWith("allow-")).sort();
    const called = servedAppCommands().map(allowId).sort();

    // The scan must actually find the call sites, or the check is vacuous.
    expect(called.length).toBeGreaterThan(0);
    expect(granted).toEqual(called);
  });

  it("grants no remote capability a command the served app does not call", () => {
    const called = servedAppCommands().map(allowId);
    expect(called.length).toBeGreaterThan(0);

    // The app's whole IPC surface is the commands it invokes, so no
    // remote-bound capability may hand out another one — not the file, and
    // not an inline capability in `tauri.conf.json`.
    for (const capability of remoteCapabilities()) {
      for (const id of permissionIds(capability)) {
        if (!id.startsWith("allow-")) continue;
        expect(
          called,
          `capability "${capability.identifier}" grants "${id}", which the served app never calls`,
        ).toContain(id);
      }
    }
  });

  it("binds every remote capability to the loopback origin only", () => {
    // The split exists so that the served app's permissions are handed to
    // exactly the loopback origin. A second remote capability — a new file
    // or an inline one — must not widen that to another host.
    const remote = remoteCapabilities();
    expect(remote.length).toBeGreaterThan(0);

    for (const capability of remote) {
      for (const url of capability.remote?.urls ?? []) {
        expect(
          url,
          `capability "${capability.identifier}" binds the remote origin "${url}"`,
        ).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)(:\*)?$/);
      }
    }
  });

  it("calls the shell only with literal command names", () => {
    const nonLiteral = nonLiteralCallSites();
    expect(
      nonLiteral.map((entry) => `${entry.file} (${entry.count})`).join(", "),
      "a non-literal invokeShell(...) call site is invisible to the scan — " +
        "the app would fail silently at runtime, because invokeShell swallows the ACL rejection",
    ).toBe("");
  });

  it("grants a remote origin exactly the core permissions the app needs", () => {
    const core = new Set();
    for (const capability of remoteCapabilities()) {
      for (const id of permissionIds(capability)) {
        if (id.startsWith("core:")) core.add(id);
      }
    }
    // Set equality, not a subset: a core permission that is *missing* breaks
    // the app's menu subscriptions, and one that is *extra* is the hole this
    // list exists to close.
    expect([...core].sort()).toEqual(ALLOWED_REMOTE_CORE);
  });

  it("gives a remote origin no plugin permission beyond the core allow-list", () => {
    const allowed = new Set(ALLOWED_REMOTE_CORE);
    // Everything the app calls is one of its own commands; the rest is the
    // core allow-list it needs to listen. No other plugin may slip in: `os:`
    // would fingerprint the machine, `log:` would hand out the app's log
    // stream, and `fs:`/`shell:`/`store:`/`opener:`/`dialog:`/`process:`
    // would be far worse — the app calls none of them.
    for (const capability of remoteCapabilities()) {
      for (const id of permissionIds(capability)) {
        if (id.startsWith("allow-")) continue;
        expect(
          allowed.has(id),
          `capability "${capability.identifier}" grants "${id}" to a remote origin`,
        ).toBe(true);
      }
    }
  });

  it("keeps the shell page's lifecycle and secret commands away from the served app", () => {
    for (const capability of remoteCapabilities()) {
      const granted = permissionIds(capability);
      for (const id of SHELL_PAGE_ONLY) {
        expect(
          granted,
          `the served app must not be granted ${id} (capability "${capability.identifier}")`,
        ).not.toContain(id);
      }
    }
  });

  it("lets the served app listen for the shell's menu events", () => {
    const remote = readCapability("desktop-remote.json");
    // `listenShell` (`window.__TAURI__.event.listen`) needs
    // `core:event:allow-listen`, and the unlisten it returns needs
    // `core:event:allow-unlisten`; without them the native menu goes dead
    // inside the app.
    const ids = permissionIds(remote);
    expect(ids).toContain("core:event:allow-listen");
    expect(ids).toContain("core:event:allow-unlisten");
  });
});

/**
 * B48 — the store plugin is granted without a scope.
 *
 * `tauri-plugin-store` does no scope and no ACL check of its own: `store|load`
 * takes an arbitrary `path`, and `resolve_store_path` resolves it against the
 * app's data directory only when the path is **relative** — an absolute path is
 * used as it is, and `Store::save` then writes it. So `store:default` is a
 * read (and a write) primitive over any JSON file on the machine.
 *
 * The store this app keeps is worse than that: `preferences.json` holds the
 * **unredacted** database connection string (`set_database_url` writes it there
 * through `state::set_pref`), so the grant handed out the password.
 *
 * The permission bought nothing: nothing in the app uses the plugin's
 * JavaScript face. The shell reads and writes the store through Rust
 * (`state::set_pref`, `app.store(...)`), which the ACL does not gate — the ACL
 * governs the IPC commands a webview may invoke. So the store is withheld from
 * **every** origin: remote *and* local.
 */
describe("desktop capabilities (B48)", () => {
  it("grants no origin the store plugin", () => {
    const capabilities = allCapabilities();
    expect(capabilities.length).toBeGreaterThan(0);

    for (const capability of capabilities) {
      for (const id of permissionIds(capability)) {
        expect(
          id.startsWith("store:"),
          `capability "${capability.identifier}" grants "${id}" — the store plugin does no scope check of its own, and its file holds the unredacted connection string`,
        ).toBe(false);
      }
    }
  });

  it("keeps the shell's own page its audited way into the store", () => {
    // The store stays reachable for the shell's own page — through the app
    // commands (`get_pref`/`set_pref`), which the ACL *can* gate. What must
    // not happen is the plugin's own permission set, which the ACL can only
    // hand out unscoped.
    const ids = permissionIds(readCapability("default.json"));
    expect(ids).toContain("default");

    const permissionSet = readFileSync(
      join(root, "src-tauri", "permissions", "default.toml"),
      "utf8",
    );
    expect(permissionSet).toContain("allow-get-pref");
    expect(permissionSet).toContain("allow-set-pref");
  });
});
