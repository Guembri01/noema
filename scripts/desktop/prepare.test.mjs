import { describe, expect, it } from "vitest";

import { sharpPlatformTag, shouldKeepSharpPackage } from "./prepare.mjs";

describe("desktop payload sharp pruning", () => {
  it("names the platform variant sharp can load", () => {
    expect(sharpPlatformTag("linux", "x64", false)).toBe("linux-x64");
    expect(sharpPlatformTag("linux", "arm64", false)).toBe("linux-arm64");
    expect(sharpPlatformTag("linux", "x64", true)).toBe("linuxmusl-x64");
    expect(sharpPlatformTag("darwin", "arm64", false)).toBe("darwin-arm64");
    expect(sharpPlatformTag("darwin", "x64", false)).toBe("darwin-x64");
    expect(sharpPlatformTag("win32", "x64", false)).toBe("win32-x64");
  });

  it("keeps the matching package and its libvips, and prunes every other platform", () => {
    expect(shouldKeepSharpPackage("sharp-linux-x64", "linux-x64")).toBe(true);
    expect(shouldKeepSharpPackage("sharp-libvips-linux-x64", "linux-x64")).toBe(true);
    expect(shouldKeepSharpPackage("colour", "linux-x64")).toBe(true);

    expect(shouldKeepSharpPackage("sharp-linuxmusl-x64", "linux-x64")).toBe(false);
    expect(shouldKeepSharpPackage("sharp-libvips-linuxmusl-x64", "linux-x64")).toBe(false);
    expect(shouldKeepSharpPackage("sharp-darwin-arm64", "linux-x64")).toBe(false);
    expect(shouldKeepSharpPackage("sharp-win32-x64", "linux-x64")).toBe(false);
    expect(shouldKeepSharpPackage("sharp-wasm32", "linux-x64")).toBe(false);
  });
});
