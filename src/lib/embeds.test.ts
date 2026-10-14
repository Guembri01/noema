import { describe, expect, it } from "vitest";
import {
  detectEmbed,
  hostOf,
  isHttpUrl,
  isPrivateHost,
  normalizeUrl,
  parseHtmlMetadata,
  safeImageUrl,
} from "@/lib/embeds";

describe("embeds / url helpers", () => {
  it("validates http(s) URLs", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("http://example.com/x")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });

  it("normalises scheme-less URLs", () => {
    expect(normalizeUrl("example.com/a")).toBe("https://example.com/a");
    expect(normalizeUrl("http://x.io")).toBe("http://x.io");
  });

  it("extracts the host", () => {
    expect(hostOf("https://www.Example.com/p?q=1")).toBe("example.com");
    expect(hostOf("nope")).toBe("");
  });

  it("detects private/loopback hosts (SSRF guard)", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("10.1.2.3")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
  });

  it("maps known providers to iframe embeds", () => {
    expect(detectEmbed("https://www.youtube.com/watch?v=abc123").embedUrl).toBe(
      "https://www.youtube.com/embed/abc123",
    );
    expect(detectEmbed("https://youtu.be/xyz").provider).toBe("youtube");
    expect(detectEmbed("https://vimeo.com/12345").embedUrl).toBe(
      "https://player.vimeo.com/video/12345",
    );
    expect(detectEmbed("https://open.spotify.com/track/1").provider).toBe("spotify");
    expect(detectEmbed("https://example.com/article").provider).toBe("none");
  });

  it("rejects non-http preview images", () => {
    expect(safeImageUrl("https://x.io/a.png")).toBe("https://x.io/a.png");
    expect(safeImageUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safeImageUrl(42)).toBeNull();
  });

  it("parses OpenGraph/HTML metadata", () => {
    const html = `<!doctype html><html><head>
      <title>Fallback title</title>
      <meta property="og:title" content="OG &amp; Title" />
      <meta name="description" content="A description" />
      <meta property="og:image" content="https://cdn.example.com/a.png" />
      <link rel="icon" href="/favicon.ico" />
    </head><body></body></html>`;
    const meta = parseHtmlMetadata(html);
    expect(meta.title).toBe("OG & Title");
    expect(meta.description).toBe("A description");
    expect(meta.image).toBe("https://cdn.example.com/a.png");
    expect(meta.icon).toBe("/favicon.ico");
  });
});
