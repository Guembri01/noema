import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTERNAL_IMAGE_HOSTS,
  EXTERNAL_IMAGE_ALLOWLIST_ENV,
  EXTERNAL_IMAGE_ROUTE,
  externalImageHosts,
  externalImageProxyPath,
  externalImageSrc,
  isAllowedExternalImageHost,
  parseExternalImageHosts,
} from "./external-image";

/**
 * B69 - the external-image gate.
 *
 * The read-only renderer used to emit the stored `src` verbatim, so a picture
 * on any host was fetched BY THE VISITOR'S BROWSER: the request carried the
 * visitor's IP address and the `Referer` of the share link (which carries the
 * share token) to a host the publisher chose.
 *
 * The contract under test:
 *
 *  - an absolute `http(s)` picture becomes the server's proxy path, so the
 *    rendered document never points a browser at a third party;
 *  - an upload (a relative path), a `data:` and a `blob:` URL stay as they
 *    are - they never leave the page;
 *  - a protocol-relative URL is external too (the browser resolves it against
 *    the page's scheme) and is rewritten the same way;
 *  - any other scheme (`javascript:`, `file:`, …) is dropped;
 *  - the allowlist is EXACT: no wildcard, no subdomain, and the default list
 *    is small and explicit.
 */

describe("externalImageSrc", () => {
  it("points an external picture at the server's proxy", () => {
    const src = externalImageSrc("https://images.example.com/a.png");
    expect(src).toBe("/api/external-image?url=https%3A%2F%2Fimages.example.com%2Fa.png");
    // The rendered document must not name the third party as a source.
    expect(src.startsWith("https://")).toBe(false);
    expect(src).not.toContain("https://images.example.com");
  });

  it("keeps an upload, a data URL and a blob URL as they are", () => {
    expect(externalImageSrc("/api/files/ws-1/a.png")).toBe("/api/files/ws-1/a.png");
    expect(externalImageSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(externalImageSrc("blob:http://localhost/abc")).toBe("blob:http://localhost/abc");
  });

  it("treats a protocol-relative URL as external", () => {
    expect(externalImageSrc("//images.example.com/a.png")).toBe(
      "/api/external-image?url=https%3A%2F%2Fimages.example.com%2Fa.png",
    );
    expect(externalImageSrc("\\\\images.example.com\\a.png")).toBe(
      "/api/external-image?url=https%3A%2F%2Fimages.example.com%2Fa.png",
    );
  });

  it("drops every scheme that is not http(s)", () => {
    expect(externalImageSrc("javascript:alert(1)")).toBe("");
    expect(externalImageSrc("file:///etc/passwd")).toBe("");
    expect(externalImageSrc("")).toBe("");
    expect(externalImageSrc(null)).toBe("");
    expect(externalImageSrc(undefined)).toBe("");
  });

  it("normalises the URL it proxies", () => {
    expect(externalImageSrc("https://images.example.com")).toBe(
      "/api/external-image?url=https%3A%2F%2Fimages.example.com%2F",
    );
  });
});

describe("the allowlist", () => {
  it("parses hosts, full URLs and noise", () => {
    expect(parseExternalImageHosts("a.example, B.example  https://c.example/d")).toEqual([
      "a.example",
      "b.example",
      "c.example",
    ]);
    expect(parseExternalImageHosts("")).toEqual([]);
    expect(parseExternalImageHosts(undefined)).toEqual([]);
  });

  it("matches a host exactly - no subdomain, no wildcard", () => {
    const hosts = ["images.example.com"];
    expect(isAllowedExternalImageHost("images.example.com", hosts)).toBe(true);
    expect(isAllowedExternalImageHost("IMAGES.example.com", hosts)).toBe(true);
    expect(isAllowedExternalImageHost("images.example.com.", hosts)).toBe(true);
    expect(isAllowedExternalImageHost("evil.images.example.com", hosts)).toBe(false);
    expect(isAllowedExternalImageHost("*.example.com", hosts)).toBe(false);
    expect(isAllowedExternalImageHost("", hosts)).toBe(false);
  });

  it("defaults to a small, explicit list and adds the operator's hosts", () => {
    expect(DEFAULT_EXTERNAL_IMAGE_HOSTS.length).toBeGreaterThan(0);
    expect(DEFAULT_EXTERNAL_IMAGE_HOSTS.length).toBeLessThanOrEqual(4);
    const saved = process.env[EXTERNAL_IMAGE_ALLOWLIST_ENV];
    try {
      delete process.env[EXTERNAL_IMAGE_ALLOWLIST_ENV];
      expect(externalImageHosts()).toEqual([...DEFAULT_EXTERNAL_IMAGE_HOSTS]);
      process.env[EXTERNAL_IMAGE_ALLOWLIST_ENV] = "images.example.com";
      expect(externalImageHosts()).toContain("images.example.com");
      expect(externalImageHosts()).toContain(DEFAULT_EXTERNAL_IMAGE_HOSTS[0]);
    } finally {
      if (saved === undefined) delete process.env[EXTERNAL_IMAGE_ALLOWLIST_ENV];
      else process.env[EXTERNAL_IMAGE_ALLOWLIST_ENV] = saved;
    }
  });
});

describe("externalImageProxyPath", () => {
  it("builds a same-origin path with the target encoded", () => {
    expect(externalImageProxyPath("https://images.example.com/a.png")).toBe(
      `${EXTERNAL_IMAGE_ROUTE}?url=https%3A%2F%2Fimages.example.com%2Fa.png`,
    );
  });
});
