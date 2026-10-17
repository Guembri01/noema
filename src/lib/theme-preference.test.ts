import { describe, expect, it } from "vitest";
import {
  normalizeTheme,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  THEME_COOKIE_OPTIONS,
  THEME_NAMES,
  themeHandoff,
} from "./theme-preference";

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
});
