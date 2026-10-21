import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  normalizeTheme,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  THEME_COOKIE_OPTIONS,
  THEME_NAMES,
  themeHandoff,
} from "./theme-preference";
import { middleware } from "../middleware";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeTheme", () => {
  it("accepts exactly the three preferences next-themes understands", () => {
    expect(THEME_NAMES).toEqual(["light", "dark", "system"]);
    for (const name of THEME_NAMES) expect(normalizeTheme(name)).toBe(name);
  });

  it("is forgiving about case and padding, because the shell's store is a string", () => {
    expect(normalizeTheme(" Dark ")).toBe("dark");
    expect(normalizeTheme("SYSTEM")).toBe("system");
  });

  it("never guesses at an unknown value", () => {
    // A stale value from an older release, a typo, or a crafted query string
    // must not silently become a preference.
    for (const junk of ["", "  ", "solarized", "DARKER", "light dark", null, undefined]) {
      expect(normalizeTheme(junk as string | null | undefined)).toBeNull();
    }
  });
});

describe("themeHandoff", () => {
  it("does nothing without the parameter", () => {
    expect(themeHandoff("/", "")).toBeNull();
    expect(themeHandoff("/w/demo-workspace", "?page=abc")).toBeNull();
  });

  it("does nothing for a value that is not a theme", () => {
    expect(themeHandoff("/", "?theme=neon")).toBeNull();
  });

  it("returns the theme and a clean location", () => {
    expect(themeHandoff("/", "?theme=dark")).toEqual({ theme: "dark", location: "/" });
  });

  it("keeps the other parameters, and their order", () => {
    expect(themeHandoff("/w/demo", "?theme=dark&page=abc")).toEqual({
      theme: "dark",
      location: "/w/demo?page=abc",
    });
    expect(themeHandoff("/w/demo", "?page=abc&theme=dark")).toEqual({
      theme: "dark",
      location: "/w/demo?page=abc",
    });
  });

  it("hands over every known theme, so `system` still follows the OS", () => {
    for (const name of THEME_NAMES) {
      expect(themeHandoff("/", `?theme=${name}`)?.theme).toBe(name);
    }
  });

  it("refuses a path that would carry the redirect to another origin (B118)", () => {
    // A path that starts with two separators is protocol-relative: the
    // middleware resolves it with `new URL(location, origin)`, and the WHATWG
    // parser reads `//evil.com` as the *host* `evil.com` — the redirect would
    // leave the site. A backslash counts as a separator in a special scheme,
    // so `/\\evil.com` is the same attack in a different spelling.
    for (const path of ["//evil.com", "/\\evil.com", "\\\\evil.com", "///evil.com"]) {
      expect(themeHandoff(path, "?theme=dark"), path).toBeNull();
    }
  });

  it("keeps a query that carries a bare percent sign", () => {
    // `isSafeReturnTo` would drop this one: its `decodeURIComponent` throws on
    // a bare `%`, and the whole hand-off would be refused. The parameter
    // survives here — percent-encoded by `URLSearchParams`, which decodes back
    // to `%` on the server.
    expect(themeHandoff("/w/demo", "?theme=dark&q=100%")).toEqual({
      theme: "dark",
      location: "/w/demo?q=100%25",
    });
  });
});

describe("the hand-off redirect (src/middleware.ts)", () => {
  it("redirects to the same origin, without the theme parameter", () => {
    const response = middleware(
      new NextRequest("https://noema.example/w/demo?theme=dark&page=abc"),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://noema.example/w/demo?page=abc",
    );
    expect(response.headers.get("set-cookie")).toContain("noema-theme=dark");
  });

  it("never redirects to another origin (B118)", () => {
    const response = middleware(
      new NextRequest("https://noema.example//evil.com?theme=dark"),
    );
    // Refused hand-off: the request is served as it is — no redirect, no
    // cookie, and the theme parameter simply stays in the URL.
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.status).not.toBe(307);
  });
});

describe("the cookie", () => {
  it("is readable by the server on the next request, and long enough to last", () => {
    expect(THEME_COOKIE).toBe("noema-theme");
    expect(THEME_COOKIE_OPTIONS.path).toBe("/");
    // The layout reads it with `cookies()`, which sees httpOnly cookies; the
    // browser never needs to, so it stays out of reach of page scripts.
    expect(THEME_COOKIE_OPTIONS.httpOnly).toBe(true);
    expect(THEME_COOKIE_OPTIONS.sameSite).toBe("lax");
    expect(THEME_COOKIE_MAX_AGE).toBe(60 * 60 * 24 * 365);
    expect(THEME_COOKIE_OPTIONS.maxAge).toBe(THEME_COOKIE_MAX_AGE);
  });

  // B31: the cookie carries `Secure` in production, like every other cookie
  // of the app. The attributes are read once, when the module is loaded, so
  // the production case needs a fresh import.
  it("is marked secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();

    const production = await import("./theme-preference");

    expect(production.THEME_COOKIE_OPTIONS.secure).toBe(true);
  });

  it("is not marked secure outside production", () => {
    expect(THEME_COOKIE_OPTIONS.secure).toBe(false);
  });
});
