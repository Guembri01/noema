import { describe, expect, it } from "vitest";
import {
  classifyLink,
  isExternalLink,
  isSafeScheme,
  isSameOrigin,
  normalizeLink,
} from "@/lib/link-check";

const APP = "https://app.noema.example";

describe("classifyLink()", () => {
  it("rejects non-strings and blank input as invalid", () => {
    expect(classifyLink(42)).toBe("invalid");
    expect(classifyLink(null)).toBe("invalid");
    expect(classifyLink("   ")).toBe("invalid");
  });

  it("classifies same-document fragments and contact schemes", () => {
    expect(classifyLink("#reading-list")).toBe("anchor");
    expect(classifyLink("mailto:a@b.co")).toBe("mailto");
    expect(classifyLink("TEL:+33123456789")).toBe("tel");
  });

  it("marks dangerous and protocol-relative targets unsafe", () => {
    expect(classifyLink("javascript:alert(1)")).toBe("unsafe");
    expect(classifyLink("data:text/html,<script>x</script>")).toBe("unsafe");
    expect(classifyLink("//evil.test/x")).toBe("unsafe");
    expect(classifyLink("java\nscript:alert(1)")).toBe("unsafe");
  });

  it("separates internal page links from external ones", () => {
    expect(classifyLink(`${APP}/w/demo/p1`, { origin: APP })).toBe("page");
    expect(classifyLink("https://other.test/x", { origin: APP })).toBe(
      "external",
    );
  });

  it("recognises a workspace page on another host by slug", () => {
    expect(
      classifyLink("https://cdn.noema.example/w/demo/p1", {
        origin: APP,
        workspaceSlug: "demo",
      }),
    ).toBe("page");
    expect(
      classifyLink("https://cdn.noema.example/w/other/p1", {
        origin: APP,
        workspaceSlug: "demo",
      }),
    ).toBe("external");
  });

  it("treats scheme-less paths as internal pages", () => {
    expect(classifyLink("/w/demo/p1")).toBe("page");
    expect(classifyLink("./p1#frag")).toBe("page");
  });
});

describe("isExternalLink()", () => {
  it("is true only for cross-origin absolute links", () => {
    expect(isExternalLink("https://other.test/x", { origin: APP })).toBe(true);
    expect(isExternalLink(`${APP}/w/demo/p1`, { origin: APP })).toBe(false);
    expect(isExternalLink("#anchor")).toBe(false);
  });
});

describe("isSafeScheme()", () => {
  it("allows allowlisted schemes and scheme-less targets, rejects the rest", () => {
    expect(isSafeScheme("https://example.com/x")).toBe(true);
    expect(isSafeScheme("mailto:a@b.co")).toBe(true);
    expect(isSafeScheme("/w/demo/p1")).toBe(true);
    expect(isSafeScheme("javascript:alert(1)")).toBe(false);
    expect(isSafeScheme("//evil.test")).toBe(false);
    expect(isSafeScheme(7)).toBe(false);
  });
});

describe("normalizeLink()", () => {
  it("trims input and returns null for unsafe or invalid targets", () => {
    expect(normalizeLink("  /w/demo/p1  ")).toBe("/w/demo/p1");
    expect(normalizeLink("javascript:alert(1)")).toBeNull();
    expect(normalizeLink("   ")).toBeNull();
  });

  it("lowercases the mailto:/tel: scheme and canonicalizes absolute links", () => {
    expect(normalizeLink("MAILTO: a@b.co ")).toBe("mailto:a@b.co");
    expect(normalizeLink("https://EXAMPLE.com/path?a=1")).toBe(
      "https://example.com/path?a=1",
    );
  });

  it("reduces a same-origin page link to its in-app path", () => {
    expect(normalizeLink(`${APP}/w/demo/p1?x=1#h`, { origin: APP })).toBe(
      "/w/demo/p1?x=1#h",
    );
  });
});

describe("isSameOrigin()", () => {
  it("compares parsed origins and never throws on garbage", () => {
    expect(isSameOrigin(`${APP}/a`, `${APP}/b`)).toBe(true);
    expect(isSameOrigin("https://other.test/a", APP)).toBe(false);
    expect(isSameOrigin("/relative", APP)).toBe(false);
    expect(isSameOrigin("http://", APP)).toBe(false);
  });
});
