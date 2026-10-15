import { describe, expect, it } from "vitest";
import {
  formatUserAgent,
  isBot,
  parseUserAgent,
  summarizeUserAgent,
} from "@/lib/user-agent";

/* Real-world UA strings are deliberately ugly and inconsistent. The module's
   promise is that *any* string (including empty and garbage) parses to a total
   shape without throwing, so expectations pin the fallback values as carefully
   as the happy paths. */

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FIREFOX_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const EDGE_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91";
const OPERA_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0";
const IE_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0) like Gecko";
const CHROMEBOOK =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LINUX_DESKTOP =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WINDOWS_PHONE =
  "Mozilla/5.0 (Windows Phone 10.0; Android 4.2.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/46.0.2486.0 Mobile Safari/537.36 Edge/13.10586";
const GOOGLEBOT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const CURL = "curl/8.4.0";

describe("parseUserAgent", () => {
  it("parses a desktop Chrome on Windows", () => {
    expect(parseUserAgent(CHROME_WIN)).toEqual({
      browser: "Chrome",
      browserVersion: "120.0.0.0",
      os: "Windows",
      osVersion: "10.0",
      device: "desktop",
      isBot: false,
    });
  });

  it("parses Firefox on macOS and normalises the OS version", () => {
    const info = parseUserAgent(FIREFOX_MAC);
    expect(info.browser).toBe("Firefox");
    expect(info.browserVersion).toBe("121.0");
    expect(info.os).toBe("macOS");
    expect(info.osVersion).toBe("10.15");
    expect(info.device).toBe("desktop");
  });

  it("parses Safari on iOS as a mobile device", () => {
    const info = parseUserAgent(SAFARI_IOS);
    expect(info.browser).toBe("Safari");
    expect(info.browserVersion).toBe("17.3");
    expect(info.os).toBe("iOS");
    expect(info.osVersion).toBe("17.3");
    expect(info.device).toBe("mobile");
  });

  it("parses Chrome on Android as a mobile device", () => {
    const info = parseUserAgent(CHROME_ANDROID);
    expect(info.browser).toBe("Chrome");
    expect(info.os).toBe("Android");
    expect(info.osVersion).toBe("14");
    expect(info.device).toBe("mobile");
  });

  it("treats Android without a Mobile token as a tablet", () => {
    expect(parseUserAgent(ANDROID_TABLET).device).toBe("tablet");
  });

  it("treats iPad as a tablet", () => {
    const info = parseUserAgent(IPAD);
    expect(info.device).toBe("tablet");
    expect(info.os).toBe("iOS");
    expect(info.osVersion).toBe("16.0");
  });

  it("does not mistake Edge for Chrome", () => {
    const info = parseUserAgent(EDGE_WIN);
    expect(info.browser).toBe("Edge");
    expect(info.browserVersion).toBe("120.0.2210.91");
  });

  it("does not mistake Opera for Chrome", () => {
    expect(parseUserAgent(OPERA_WIN).browser).toBe("Opera");
  });

  it("parses Internet Explorer from the Trident token", () => {
    const info = parseUserAgent(IE_WIN);
    expect(info.browser).toBe("Internet Explorer");
    expect(info.browserVersion).toBe("11.0");
  });

  it("parses Chrome OS", () => {
    expect(parseUserAgent(CHROMEBOOK).os).toBe("Chrome OS");
  });

  it("parses a bare Linux desktop UA with no OS version", () => {
    const info = parseUserAgent(LINUX_DESKTOP);
    expect(info.os).toBe("Linux");
    expect(info.osVersion).toBeUndefined();
    expect(info.device).toBe("desktop");
  });

  it("prefers Windows Phone over the Android token it embeds", () => {
    const info = parseUserAgent(WINDOWS_PHONE);
    expect(info.os).toBe("Windows Phone");
    expect(info.device).toBe("mobile");
  });

  it("names a crawler and captures its version", () => {
    const info = parseUserAgent(GOOGLEBOT);
    expect(info.browser).toBe("Googlebot");
    expect(info.browserVersion).toBe("2.1");
    expect(info.isBot).toBe(true);
  });

  it("falls back to unknown for empty and garbage input without throwing", () => {
    expect(parseUserAgent("")).toEqual({
      browser: "unknown",
      os: "unknown",
      device: "desktop",
      isBot: false,
    });
    expect(() => parseUserAgent("!!! not a user agent ((")).not.toThrow();
    expect(parseUserAgent("!!! not a user agent ((").browser).toBe("unknown");
  });
});

describe("isBot", () => {
  it("recognises crawlers and HTTP clients", () => {
    expect(isBot(GOOGLEBOT)).toBe(true);
    expect(isBot("Twitterbot/1.0")).toBe(true);
    expect(isBot(CURL)).toBe(true);
    expect(isBot("python-requests/2.31.0")).toBe(true);
  });

  it("does not flag ordinary browsers", () => {
    expect(isBot(CHROME_WIN)).toBe(false);
    expect(isBot(SAFARI_IOS)).toBe(false);
    expect(isBot(FIREFOX_MAC)).toBe(false);
  });
});

describe("formatUserAgent", () => {
  it("renders a full, versioned description", () => {
    expect(formatUserAgent(parseUserAgent(CHROME_WIN))).toBe(
      "Chrome 120.0.0.0 on Windows 10.0 (desktop)",
    );
  });

  it("omits missing versions and flags bots", () => {
    expect(
      formatUserAgent({
        browser: "unknown",
        os: "unknown",
        device: "desktop",
        isBot: false,
      }),
    ).toBe("unknown on unknown (desktop)");
    expect(formatUserAgent(parseUserAgent(GOOGLEBOT))).toBe(
      "Googlebot 2.1 on unknown (desktop) [bot]",
    );
  });
});

describe("summarizeUserAgent", () => {
  it("drops versions for a compact label", () => {
    expect(summarizeUserAgent(CHROME_WIN)).toBe("Chrome on Windows (desktop)");
  });

  it("keeps the bot marker and still works for empty input", () => {
    expect(summarizeUserAgent(GOOGLEBOT)).toBe(
      "Googlebot on unknown (desktop) [bot]",
    );
    expect(summarizeUserAgent("")).toBe("unknown on unknown (desktop)");
  });
});
