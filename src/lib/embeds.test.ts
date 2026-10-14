import { describe, expect, it } from "vitest";
import {
  detectEmbed,
  embedMeta,
  hostOf,
  isEmbedHostAllowed,
  isHttpUrl,
  isPrivateHost,
  normalizeUrl,
  parseHtmlMetadata,
  parseStartTime,
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

/* ------------------------------------------------- provider-specific path */

describe("embeds / provider-specific embed path", () => {
  it("maps every YouTube URL shape to the provider embed", () => {
    expect(detectEmbed("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toEqual({
      provider: "youtube",
      embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    });
    expect(detectEmbed("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toEqual({
      provider: "youtube",
      embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    });
    expect(detectEmbed("https://www.youtube.com/live/dQw4w9WgXcQ").embedUrl).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    );
    expect(detectEmbed("https://m.youtube.com/watch?v=dQw4w9WgXcQ").provider).toBe("youtube");
    expect(detectEmbed("https://youtube.com/embed/dQw4w9WgXcQ").embedUrl).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    );
    // A watch URL without an id is not an embed.
    expect(detectEmbed("https://www.youtube.com/results?search_query=cats").provider).toBe("none");
  });

  it("carries the start time into the embed URL", () => {
    expect(detectEmbed("https://youtu.be/dQw4w9WgXcQ?t=1m30s").embedUrl).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?start=90",
    );
    expect(detectEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45").embedUrl).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?start=45",
    );
    expect(detectEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=1h").embedUrl).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?start=3600",
    );
    // No start time → no start param (the plain embed URL stays canonical).
    expect(detectEmbed("https://youtu.be/dQw4w9WgXcQ").embedUrl).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    );
  });

  it("maps every Vimeo URL shape to the player embed", () => {
    expect(detectEmbed("https://vimeo.com/channels/staffpicks/76979871").embedUrl).toBe(
      "https://player.vimeo.com/video/76979871",
    );
    expect(detectEmbed("https://vimeo.com/groups/sketch/videos/76979871").embedUrl).toBe(
      "https://player.vimeo.com/video/76979871",
    );
    expect(detectEmbed("https://player.vimeo.com/video/76979871")).toEqual({
      provider: "vimeo",
      embedUrl: "https://player.vimeo.com/video/76979871",
    });
    expect(detectEmbed("https://vimeo.com/76979871?t=30").embedUrl).toBe(
      "https://player.vimeo.com/video/76979871#t=30",
    );
    // A Vimeo page that is not a video id (no numeric id) must not embed.
    expect(detectEmbed("https://vimeo.com/blog").provider).toBe("none");
    expect(detectEmbed("https://vimeo.com/channels/staffpicks").provider).toBe("none");
  });

  it("exposes a host allowlist so only provider hosts become iframes", () => {
    expect(isEmbedHostAllowed("www.youtube.com")).toBe(true);
    expect(isEmbedHostAllowed("youtube-nocookie.com")).toBe(true);
    expect(isEmbedHostAllowed("player.vimeo.com")).toBe(true);
    expect(isEmbedHostAllowed("evil.example.com")).toBe(false);
    expect(isEmbedHostAllowed("localhost")).toBe(false);
    expect(isEmbedHostAllowed("")).toBe(false);
    expect(detectEmbed("https://evil.example.com/watch?v=x").provider).toBe("none");
  });

  it("describes each provider so renderers can specialise the iframe", () => {
    expect(embedMeta("youtube")).toMatchObject({ label: "YouTube", aspectRatio: "16 / 9" });
    expect(embedMeta("vimeo")).toMatchObject({ label: "Vimeo", aspectRatio: "16 / 9" });
    expect(embedMeta("vimeo")?.allow).toContain("picture-in-picture");
    expect(embedMeta("spotify")?.allow).toContain("autoplay");
    expect(embedMeta("none")).toBeNull();
  });
});

/* --------------------------------------------- B87: SSRF host gate (link-preview) */

/**
 * B87 - `isPrivateHost` is the host gate behind `GET /api/link-preview`
 * (`src/app/api/link-preview/route.ts:37`), i.e. the guard that decides whether
 * the server fetches a user-supplied URL at all. It must survive exactly what
 * the WHATWG URL parser hands it (`new URL(value).hostname`) - bracketed IPv6
 * literals, FQDN trailing dots, `*.localhost` names - and cover the full
 * private/reserved literal sets the audit lists in M1 (the same set B59's
 * `feed-guard.isBlockedIpLiteral` closes for calendar feeds, but this is the
 * OTHER module: embeds.ts, not feed-guard.ts).
 *
 * Red-first: every literal/edge case below is asserted against the guard as
 * the link-preview route actually calls it, brackets included.
 */
describe("embeds / isPrivateHost edge ranges (B87)", () => {
  it("blocks loopback/private/link-local IPv4 at every range boundary", () => {
    const blocked = [
      "127.0.0.1",
      "127.255.255.255",
      "10.0.0.0",
      "10.255.255.255",
      "172.16.0.0",
      "172.31.255.255",
      "192.168.0.0",
      "192.168.255.255",
      "169.254.0.0",
      "169.254.169.254",
      "0.0.0.0",
      "0.1.2.3",
    ];
    for (const host of blocked) expect(isPrivateHost(host), host).toBe(true);

    const allowed = [
      "126.255.255.255",
      "128.0.0.1",
      "9.255.255.255",
      "11.0.0.1",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "1.1.1.1",
      "8.8.8.8",
      "93.184.216.34",
    ];
    for (const host of allowed) expect(isPrivateHost(host), host).toBe(false);
  });

  it("blocks the reserved/special-purpose IPv4 ranges (audit M1 set)", () => {
    const blocked = [
      "100.64.0.1", // CGNAT 100.64/10
      "100.127.255.255",
      "198.18.0.1", // benchmarking 198.18/15
      "198.19.255.255",
      "192.0.0.1", // IETF protocol assignments
      "192.0.2.1", // TEST-NET-1
      "198.51.100.1", // TEST-NET-2
      "203.0.113.1", // TEST-NET-3
      "224.0.0.1", // multicast
      "240.0.0.1", // reserved
      "255.255.255.255", // broadcast
    ];
    for (const host of blocked) expect(isPrivateHost(host), host).toBe(true);

    const allowed = ["100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1"];
    for (const host of allowed) expect(isPrivateHost(host), host).toBe(false);
  });

  it("blocks bracketed IPv6 exactly as WHATWG hands hostname to the route", () => {
    // new URL("http://[::1]/").hostname === "[::1]" - audit M1: brackets must
    // not defeat the guard; the mapped forms below are the loopback/metadata
    // bypasses the URL parser canonicalises into (hex pairs, not dotted quad).
    const blocked = [
      "[::1]",
      "[::]",
      "0:0:0:0:0:0:0:1", // expanded loopback (direct callers)
      "[::ffff:7f00:1]", // IPv4-mapped 127.0.0.1 (WHATWG hex form)
      "[::ffff:127.0.0.1]", // same address, dotted form
      "[::ffff:a9fe:a9fe]", // IPv4-mapped 169.254.169.254 (cloud metadata)
      "[::ffff:a00:1]", // IPv4-mapped 10.0.0.1
      "[fc00::1]", // unique local fc00::/7
      "[fd12:3456::1]",
      "[fe80::1]", // link-local fe80::/10
      "[ff02::1]", // multicast ff00::/8
      "[2001:db8::1]", // documentation range
      "fe80::1%eth0", // zone id (feed-guard strips those too)
    ];
    for (const host of blocked) expect(isPrivateHost(host), host).toBe(true);
  });

  it("allows public IPv6 addresses, bracketed and IPv4-mapped included", () => {
    const allowed = [
      "2606:4700:4700::1111",
      "[2606:4700:4700::1111]",
      "[2001:4860:4888::8888]",
      "[::ffff:5db8:d822]", // IPv4-mapped 93.184.216.34 - decode, don't guess
      "::ffff:93.184.216.34",
    ];
    for (const host of allowed) expect(isPrivateHost(host), host).toBe(false);
  });

  it("blocks localhost subdomains and trailing-dot FQDNs, passes real names", () => {
    const blocked = [
      "localhost",
      "LOCALHOST",
      "localhost.", // FQDN root dot: URL keeps it, "localhost." !== "localhost"
      "LOCALHOST.",
      "foo.localhost",
      "a.b.localhost",
      "foo.localhost.",
      "printer.local",
      "db.internal",
      "metadata.google.internal",
      "", // fail closed
    ];
    for (const host of blocked) expect(isPrivateHost(host), host).toBe(true);

    const allowed = ["example.com", "sub.example.com", "notlocalhost", "localhost.example.com"];
    for (const host of allowed) expect(isPrivateHost(host), host).toBe(false);
  });
});

/* ----------------------------------------- B87: embed URL builder/allowlist edges */

describe("embeds / provider mapping edge cases (B87)", () => {
  it("maps every loom share/embed/bare-id path and refuses empty ones", () => {
    expect(detectEmbed("https://www.loom.com/share/abc123")).toEqual({
      provider: "loom",
      embedUrl: "https://www.loom.com/embed/abc123",
    });
    expect(detectEmbed("https://www.loom.com/embed/abc123").embedUrl).toBe(
      "https://www.loom.com/embed/abc123",
    );
    expect(detectEmbed("https://www.loom.com/abc123").embedUrl).toBe(
      "https://www.loom.com/embed/abc123",
    );
    expect(detectEmbed("https://www.loom.com/").provider).toBe("none");
    expect(detectEmbed("https://www.loom.com/share").provider).toBe("none");
  });

  it("wraps plain spotify links and passes embed links through verbatim", () => {
    expect(detectEmbed("https://open.spotify.com/track/abc123").embedUrl).toBe(
      "https://open.spotify.com/embed/track/abc123",
    );
    expect(detectEmbed("https://open.spotify.com/playlist/pl_1?si=zzz").embedUrl).toBe(
      "https://open.spotify.com/embed/playlist/pl_1?si=zzz",
    );
    const embed = "https://open.spotify.com/embed/track/abc123?si=zzz";
    expect(detectEmbed(embed)).toEqual({ provider: "spotify", embedUrl: embed });
  });

  it("url-encodes the target for the soundcloud and figma players", () => {
    expect(detectEmbed("https://soundcloud.com/artist/track?x=1&y=2")).toEqual({
      provider: "soundcloud",
      embedUrl:
        "https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack%3Fx%3D1%26y%3D2",
    });
    expect(detectEmbed("https://www.figma.com/file/abc/Design")).toEqual({
      provider: "figma",
      embedUrl:
        "https://www.figma.com/embed?embed_host=noema&url=https%3A%2F%2Fwww.figma.com%2Ffile%2Fabc%2FDesign",
    });
  });

  it("maps codepen /pen/ paths to /embed/", () => {
    expect(detectEmbed("https://codepen.io/team/pen/slug").embedUrl).toBe(
      "https://codepen.io/team/embed/slug",
    );
    expect(detectEmbed("https://codepen.io/team/pen/slug/").embedUrl).toBe(
      "https://codepen.io/team/embed/slug/",
    );
  });

  it("refuses youtube URLs without a usable video id", () => {
    expect(detectEmbed("https://www.youtube.com/watch").provider).toBe("none");
    expect(detectEmbed("https://www.youtube.com/watch?v=").provider).toBe("none");
    // The id must match [A-Za-z0-9_-]+ - a decoded %2F must never reach the iframe.
    expect(detectEmbed("https://www.youtube.com/watch?v=ab%2Fcd").provider).toBe("none");
    expect(detectEmbed("https://www.youtube.com/shorts/").provider).toBe("none");
    expect(detectEmbed("https://youtu.be/").provider).toBe("none");
    expect(detectEmbed("https://www.youtube.com/@somehandle").provider).toBe("none");
  });

  it("never turns a non-http(s) scheme into an iframe", () => {
    const values = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://www.youtube.com/watch?v=abc",
      "file:///etc/passwd",
      "//www.youtube.com/watch?v=abc",
      "",
    ];
    for (const value of values) {
      expect(detectEmbed(value), value).toEqual({ provider: "none", embedUrl: null });
    }
  });

  it("rejects userinfo tricks, lookalike hosts and non-listed subdomains", () => {
    const rejected = [
      "https://www.youtube.com@evil.example/watch?v=x", // userinfo: real host is evil.example
      "https://youtube.com.evil.example/watch?v=x",
      "https://evilyoutube.com/watch?v=x",
      "https://notyoutube.com/watch?v=x",
      "https://music.youtube.com/watch?v=x", // no wildcard subdomains
      "https://www.youtube.com./watch?v=x", // trailing dot is a different host string
    ];
    for (const value of rejected) {
      expect(detectEmbed(value).provider, value).toBe("none");
    }
    // Case and port are not part of the host.
    expect(detectEmbed("https://WWW.YOUTUBE.COM/watch?v=abc123").provider).toBe("youtube");
    expect(detectEmbed("HTTPS://youtube.com:8443/watch?v=abc123").provider).toBe("youtube");
  });

  it("keeps the embed allowlist exact: www tolerated, no wildcards, no lookalikes", () => {
    const allowed = [
      "youtube.com",
      "www.youtube.com",
      "WWW.YOUTUBE.COM",
      "m.youtube.com",
      "youtu.be",
      "youtube-nocookie.com",
      "vimeo.com",
      "player.vimeo.com",
      "loom.com",
      "open.spotify.com",
      "soundcloud.com",
      "www.soundcloud.com",
      "figma.com",
      "codepen.io",
    ];
    for (const host of allowed) expect(isEmbedHostAllowed(host), host).toBe(true);

    const rejected = [
      "youtube.com.evil.example",
      "evil-youtube.com",
      "evilyoutube.com",
      "music.youtube.com",
      "sub.youtube.com",
      "youtu.be.evil.example",
      "www.www.youtube.com",
      "youtube.com.",
      "w.soundcloud.com",
      "localhost",
      "",
    ];
    for (const host of rejected) expect(isEmbedHostAllowed(host), host).toBe(false);
  });

  it("parses start times defensively", () => {
    expect(parseStartTime(null)).toBeNull();
    expect(parseStartTime(undefined)).toBeNull();
    expect(parseStartTime("")).toBeNull();
    expect(parseStartTime("t=")).toBeNull();
    expect(parseStartTime("abc")).toBeNull();
    expect(parseStartTime("5x")).toBeNull();
    expect(parseStartTime("hms")).toBeNull();
    expect(parseStartTime("90")).toBe(90);
    expect(parseStartTime("t=45")).toBe(45);
    expect(parseStartTime("1m30s")).toBe(90);
    expect(parseStartTime("1h2m3s")).toBe(3723);
    expect(parseStartTime("  120  ")).toBe(120);
  });

  it("describes every embeddable provider", () => {
    const providers = [
      "youtube",
      "vimeo",
      "loom",
      "spotify",
      "soundcloud",
      "figma",
      "codepen",
    ] as const;
    for (const provider of providers) {
      const meta = embedMeta(provider);
      expect(meta, provider).not.toBeNull();
      expect(meta?.label, provider).toBeTruthy();
      expect(meta?.aspectRatio, provider).toMatch(/^\d+ \/ \d+$/);
      expect(meta?.allow, provider).toBeTruthy();
    }
    expect(embedMeta("none")).toBeNull();
  });
});
