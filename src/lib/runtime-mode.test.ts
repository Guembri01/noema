import { afterEach, describe, expect, it } from "vitest";
import {
  apiUrl,
  appVersion,
  desktopBridge,
  desktopChrome,
  hideSiteOnlyChrome,
  isDesktop,
  nativeCapabilities,
  platform,
  resolveApiBase,
  resolveDataDir,
} from "@/lib/runtime-mode";

const bridge = {
  mode: "desktop" as const,
  apiBase: "http://127.0.0.1:47821",
  dataDir: "C:/Users/x/AppData/Roaming/Noema",
  appVersion: "1.4.0",
  platform: "windows-x86_64",
};

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete process.env.NEXT_PUBLIC_APP_VERSION;
});

function withWindow(b: unknown) {
  (globalThis as unknown as { window: { __NOEMA_DESKTOP__?: unknown } }).window = {
    __NOEMA_DESKTOP__: b,
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
    expect(appVersion()).toBe("1.4.0");
    expect(desktopChrome()).toBe(true);
    expect(hideSiteOnlyChrome()).toBe(true);
  });

  it("ignores a malformed or foreign bridge object", () => {
    withWindow({ mode: "something-else" });
    expect(isDesktop()).toBe(false);
    expect(desktopBridge()).toBeNull();
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
