import { describe, expect, it } from "vitest";
import { isApplePlatform } from "./use-is-mac";

/**
 * The hook itself cannot be tested without a DOM, but the rule behind it can —
 * and the rule is what decides whether every shortcut hint in the app reads
 * `⌘K` or `Ctrl+K`, so it is worth pinning.
 */
describe("isApplePlatform", () => {
  it("recognises the Apple user agents", () => {
    for (const userAgent of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15",
    ]) {
      expect(isApplePlatform(userAgent)).toBe(true);
    }
  });

  it("does not mistake the other platforms for Apple", () => {
    for (const userAgent of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    ]) {
      expect(isApplePlatform(userAgent)).toBe(false);
    }
  });

  it("treats a missing user agent as not-Apple", () => {
    // Server rendering and non-browser callers: the safe answer is the one that
    // renders `Ctrl`, which is what most installs want anyway.
    expect(isApplePlatform("")).toBe(false);
    expect(isApplePlatform(undefined)).toBe(false);
    expect(isApplePlatform(null)).toBe(false);
  });
});
