// The `Origin` headers a Server Action POST is accepted from.
//
// Next.js only accepts a Server Action when the request's `Origin` matches its
// `Host` (CSRF protection). The app is normally reached at `127.0.0.1:<port>`,
// which is same-origin and passes on its own — but `next start` also prints a LAN
// address, and behind a reverse proxy or a tunnel the forwarded host differs, so
// a request sent while browsing one of this machine's *own* addresses was aborted
// with "does not match `origin` header … Aborting the action": saving spun
// forever, comments and chat did nothing. Those addresses are listed here, and a
// foreign origin stays rejected.
//
// Why this is a module rather than a function inside next.config.ts: Next
// serializes the list into the build (`required-server-files.json`, and the
// literal inside the standalone `server.js`), so a *packaged* app would inherit
// the network interfaces of whatever machine built it — a VPN adapter that
// appears later, or a build on someone else's machine, would leave the app
// refusing its own address. The desktop boot wrapper therefore recomputes the
// list at launch from this same module (see boot-wrapper.cjs), while
// next.config.ts imports it for `next dev` / `next start`.
//
// Plain CommonJS on purpose: next.config.ts imports it (the project has
// `allowJs`), and the payload's boot wrapper `require`s it from a payload that is
// never transpiled. One implementation, two consumers.

const { networkInterfaces } = require("node:os");

/** Ports the app is conventionally reached on, beyond the one it listens on. */
const CONVENTIONAL_PORTS = ["3200", "3000"];

/**
 * The host names loopback and this machine's own addresses answer to.
 *
 * @param {NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>} [interfaces]
 * @returns {string[]}
 */
function localHosts(interfaces) {
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  for (const addresses of Object.values(interfaces ?? {})) {
    for (const address of addresses ?? []) {
      // IPv4 only: `[::1]` above is the one IPv6 name a browser sends, and an
      // interface's link-local IPv6 form never appears in an `Origin` host.
      if (address.family === "IPv4" && !address.internal) hosts.add(address.address);
    }
  }
  return [...hosts];
}

/**
 * The `host:port` entries Next accepts a Server Action from.
 *
 * @param {{ env?: NodeJS.ProcessEnv, interfaces?: NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]> }} [options]
 *   Injectable for tests; both default to this process and this machine.
 * @returns {string[]}
 */
function allowedOrigins(options = {}) {
  const env = options.env ?? process.env;
  const interfaces = options.interfaces ?? networkInterfaces();

  const ports = new Set([env.PORT ?? "", ...CONVENTIONAL_PORTS]);
  const origins = new Set();
  for (const host of localHosts(interfaces)) {
    for (const port of ports) {
      if (port) origins.add(`${host}:${port}`);
    }
  }

  // APP_ORIGINS covers a reverse proxy or a tunnel, where the browser's `Origin`
  // is a public name that no interface on this machine can enumerate.
  for (const entry of (env.APP_ORIGINS ?? "").split(",")) {
    const value = entry.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (value) origins.add(value);
  }

  return [...origins];
}

module.exports = { allowedOrigins, localHosts, CONVENTIONAL_PORTS };
