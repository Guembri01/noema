import { afterEach, describe, expect, it } from "vitest";
import {
  apiUrl,
  appVersion,
  desktopBridge,
  desktopChrome,
  hideSiteOnlyChrome,
  invokeShell,
  isDesktop,
  nativeCapabilities,
  platform,
  resolveApiBase,
  resolveDataDir,
  runtimeMode,
} from "@/lib/runtime-mode";

const bridge = {
  mode: "desktop" as const,
  apiBase: "http://127.0.0.1:47821",
  dataDir: "C:/Users/x/AppData/Roaming/Noema",
  appVersion: "1.4.1",
  platform: "windows-x86_64",
};

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete process.env.NEXT_PUBLIC_APP_VERSION;
});

function withWindow(b: unknown) {
  (globalThis as unknown as { window: { __NOEMA_DESKTOP__?: unknown } }).window = {
    __NOEMA_DESKTOP__: b,
  };
}

/** A document whose `<html>` carries (or lacks) the server-rendered mode. */
function withDocument(runtime: string | null) {
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: {
      getAttribute: (name: string) =>
        name === "data-noema-runtime" ? runtime : null,
    },
  };
}

describe("runtime mode", () => {
  it("defaults to the site version with no window at all (SSR)", () => {
    expect(isDesktop()).toBe(false);
    expect(desktopBridge()).toBeNull();
    expect(resolveApiBase()).toBe("");
    expect(resolveDataDir()).toBeNull();
    expect(desktopChrome()).toBe(false);
  });

  it("treats a plain browser as the site version", () => {
    withWindow(undefined);
    expect(isDesktop()).toBe(false);
    expect(resolveApiBase()).toBe("");
    expect(apiUrl("/api/health")).toBe("/api/health");
  });

  it("detects the desktop shell and its loopback API", () => {
    withWindow(bridge);
    expect(isDesktop()).toBe(true);
    expect(resolveApiBase()).toBe("http://127.0.0.1:47821");
    expect(apiUrl("api/ready")).toBe("http://127.0.0.1:47821/api/ready");
    expect(resolveDataDir()).toBe(bridge.dataDir);
    expect(platform()).toBe("windows-x86_64");
    expect(appVersion()).toBe("1.4.1");
    expect(desktopChrome()).toBe(true);
    expect(hideSiteOnlyChrome()).toBe(true);
  });

  it("ignores a malformed or foreign bridge object", () => {
    withWindow({ mode: "something-else" });
    expect(isDesktop()).toBe(false);
    expect(desktopBridge()).toBeNull();
  });

  it("knows it is the app from the mode the server rendered", () => {
    // The regression this guards: the shell injects its bridge into its own
    // page and then navigates the window to the served app, so by the time the
    // app runs the bridge is gone and every `isDesktop()` consumer was wrong.
    // The mode has to come from the document the server sent.
    withWindow(undefined);
    withDocument("desktop");
    expect(runtimeMode()).toBe("desktop");
    expect(isDesktop()).toBe(true);
    expect(desktopChrome()).toBe(true);
    expect(hideSiteOnlyChrome()).toBe(true);
    expect(nativeCapabilities().filesystem).toBe(true);
  });

  it("reads the hosted site's own mode as the site", () => {
    withWindow(undefined);
    withDocument("site");
    expect(runtimeMode()).toBe("site");
    expect(isDesktop()).toBe(false);
  });

  it("falls back to Tauri's global when the document carries no mode", () => {
    withWindow(undefined);
    withDocument(null);
    expect(isDesktop()).toBe(false);
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI__: { core: { invoke: () => Promise.resolve(null) } },
    };
    expect(isDesktop()).toBe(true);
  });

  it("treats an empty Tauri global as the site", () => {
    // `withGlobalTauri` installs a populated object; anything else is a page
    // that merely defined the name.
    withWindow(undefined);
    withDocument(null);
    (globalThis as unknown as { window: unknown }).window = { __TAURI__: {} };
    expect(isDesktop()).toBe(false);
  });

  it("falls back to the build-time version, then dev", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "2.0.0";
    expect(appVersion()).toBe("2.0.0");
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    expect(appVersion()).toBe("dev");
  });

  it("reports every native capability in the app and none on the site", () => {
    withWindow(undefined);
    expect(Object.values(nativeCapabilities()).every((v) => v === false)).toBe(true);
    withWindow(bridge);
    expect(Object.values(nativeCapabilities()).every((v) => v === true)).toBe(true);
  });

  it("never inserts a double slash between base and path", () => {
    withWindow(bridge);
    expect(apiUrl("api/x")).toBe("http://127.0.0.1:47821/api/x");
    expect(apiUrl("/api/x")).toBe("http://127.0.0.1:47821/api/x");
  });
});

describe("invoking the shell", () => {
  function withShell(invoke: unknown) {
    (globalThis as unknown as { window: { __TAURI__?: unknown } }).window = {
      __TAURI__: { core: { invoke } },
    };
  }

  it("is a no-op without a shell (SSR, the site, a plain browser)", () => {
    expect(invokeShell("set_theme", { theme: "dark" })).toBeNull();
    withWindow(undefined);
    expect(invokeShell("set_theme", { theme: "dark" })).toBeNull();
    withShell(undefined);
    expect(invokeShell("set_theme", { theme: "dark" })).toBeNull();
  });

  it("passes the command and its arguments through", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    withShell((command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return Promise.resolve(null);
    });
    await invokeShell("set_theme", { theme: "dark" });
    expect(calls).toEqual([{ command: "set_theme", args: { theme: "dark" } }]);
  });

  it("swallows a refusal instead of failing the caller", async () => {
    withShell(() => Promise.reject(new Error("no main window")));
    await expect(invokeShell("set_theme", { theme: "dark" })).resolves.toBeUndefined();
  });
});
