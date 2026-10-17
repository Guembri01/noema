import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The module is CJS on purpose (next.config.ts imports it, the desktop boot
// wrapper requires it from an untranspiled payload): a single implementation for
// both, so this test covers the policy itself and the fact that there is still
// only one copy of it.
const require = createRequire(import.meta.url);
const { allowedOrigins, localHosts } = require("./allowed-origins.cjs");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

/** A stub interface table: two real addresses, one internal, one IPv6. */
const interfaces = {
  "Wi-Fi": [{ address: "10.153.77.93", family: "IPv4", internal: false }],
  ProTUN: [{ address: "10.2.0.2", family: "IPv4", internal: false }],
  Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  Ethernet: [{ address: "fe80::1234", family: "IPv6", internal: false }],
};

describe("allowedOrigins", () => {
  it("lists loopback and every non-internal IPv4 address, per port", () => {
    const origins = allowedOrigins({ env: { PORT: "4123" }, interfaces });
    for (const host of ["localhost", "127.0.0.1", "[::1]", "10.153.77.93", "10.2.0.2"]) {
      expect(origins).toContain(`${host}:4123`);
    }
  });

  it("ignores internal and IPv6 interfaces", () => {
    const hosts = localHosts(interfaces);
    expect(hosts.sort()).toEqual(
      ["localhost", "127.0.0.1", "[::1]", "10.153.77.93", "10.2.0.2"].sort(),
    );
  });

  it("covers the conventional ports, so the address `next start` prints works", () => {
    const origins = allowedOrigins({ env: {}, interfaces });
    for (const port of ["3200", "3000"]) {
      expect(origins).toContain(`localhost:${port}`);
      expect(origins).toContain(`10.153.77.93:${port}`);
    }
  });

  it("normalises APP_ORIGINS, which is how a proxy or tunnel is named", () => {
    const origins = allowedOrigins({
      env: { APP_ORIGINS: "https://notes.example.com/, http://tunnel.example.net ,,  " },
      interfaces,
    });
    expect(origins).toContain("notes.example.com");
    expect(origins).toContain("tunnel.example.net");
    expect(origins).not.toContain("");
  });

  it("is never empty: loopback is always allowed", () => {
    const origins = allowedOrigins({ env: {}, interfaces: {} });
    expect(origins.length).toBeGreaterThan(0);
    expect(origins).toContain("127.0.0.1:3200");
  });

  it("reads this machine's own interfaces when none are injected", () => {
    expect(allowedOrigins({ env: {} })).toContain("127.0.0.1:3200");
  });

  // The whole point of the module: the packaged app recomputes the list at
  // launch, so it must not grow a second copy of the policy anywhere.
  it("is the only implementation, used by the config and by the boot wrapper", () => {
    const config = readFileSync(join(root, "next.config.ts"), "utf8");
    expect(config).toContain('from "./scripts/desktop/allowed-origins.cjs"');
    expect(config).not.toContain("networkInterfaces");

    const wrapper = readFileSync(join(here, "boot-wrapper.cjs"), "utf8");
    expect(wrapper).toContain('require("./allowed-origins.cjs")');
    expect(wrapper).toContain("allowedOrigins()");

    const prepare = readFileSync(join(here, "prepare.mjs"), "utf8");
    expect(prepare).toContain('"allowed-origins.cjs"');
  });
});
