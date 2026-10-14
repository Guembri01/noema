import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Next.js only accepts a Server Action POST when the request's `Origin` matches
 * the `Host` header (CSRF protection). Because `next start` also prints a LAN
 * address, browsing the app at `http://<lan-ip>:3200` (or `127.0.0.1`) silently
 * broke every action — saving spun forever, comments and chat did nothing.
 *
 * We therefore allow this machine's own addresses explicitly: loopback, every
 * non-internal IPv4 interface, the usual dev ports, and anything in APP_ORIGINS
 * (for a reverse proxy or tunnel). Foreign origins stay rejected.
 */
function allowedOrigins(): string[] {
  const hosts = new Set<string>(["localhost", "127.0.0.1", "[::1]"]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) hosts.add(address.address);
    }
  }

  const ports = new Set<string>([process.env.PORT ?? "", "3200", "3000"]);
  const origins = new Set<string>();
  for (const host of hosts) {
    for (const port of ports) {
      if (port) origins.add(`${host}:${port}`);
    }
  }

  for (const entry of (process.env.APP_ORIGINS ?? "").split(",")) {
    const value = entry.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (value) origins.add(value);
  }
  return [...origins];
}

const nextConfig: NextConfig = {
  // Pin the tracing root so an unrelated lockfile above this project does not
  // change how the standalone output is assembled.
  outputFileTracingRoot: root,
  experimental: {
    serverActions: {
      allowedOrigins: allowedOrigins(),
    },
  },
};

export default nextConfig;
