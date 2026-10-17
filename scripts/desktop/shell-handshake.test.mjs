import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * B49 — the desktop shell's handshake with the local server.
 *
 * The shell starts the server on a loopback port and points the window at it
 * as soon as `/api/health` answers `200`. That port is picked by binding
 * `127.0.0.1:0`, reading the port and closing the socket again, so a program
 * on the same machine can take the port before the server does — and it only
 * has to answer `200` to be believed. The window would then load *that* page,
 * on an origin the Tauri capability covers, with the app's IPC rights.
 *
 * The fix is a token per start: the shell hands the server a random token
 * (through the environment), the server echoes it in a response header, and
 * the shell believes a server only when the header carries its token. The
 * token lives in the server process' environment, which a program squatting
 * the port cannot read.
 *
 * The decision itself is unit-tested in `src-tauri/src/sidecar.rs` — that
 * test runs in the desktop shell's own CI job, with a Rust toolchain. What is
 * checked here is the wiring between the two sides: the names have to agree,
 * the token has to reach the server, and neither side may quietly drop the
 * check. A rename on one side only, a readiness probe that accepts any
 * `200`, or a route that echoes a token it was never given — each of those
 * is the bug this file exists to catch, and each of them fails here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const sidecar = readFileSync(join(root, "src-tauri", "src", "sidecar.rs"), "utf8");
const healthRoute = readFileSync(
  join(root, "src", "app", "api", "health", "route.ts"),
  "utf8",
);

/**
 * The body of one Rust function: from its signature to the closing brace in
 * column zero.
 */
function rustFunction(source, signature) {
  const start = source.indexOf(signature);
  expect(start, `${signature} is missing from sidecar.rs`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end === -1 ? source.length : end);
}

describe("the desktop shell's handshake (B49)", () => {
  it("both sides agree on the name of the token and of its header", () => {
    // The shell reads the token from the environment it hands the server, and
    // the server reads it from the same variable. One name, one header — a
    // rename on one side only would silently break the handshake, and the
    // window would never be pointed at the app again.
    const rustEnv = /SHELL_TOKEN_ENV:\s*&str\s*=\s*"([^"]+)"/.exec(sidecar)?.[1];
    const rustHeader = /SHELL_TOKEN_HEADER:\s*&str\s*=\s*"([^"]+)"/.exec(sidecar)?.[1];
    const routeEnv = /process\.env\.([A-Z][A-Z0-9_]*SHELL_TOKEN[A-Z0-9_]*)/.exec(
      healthRoute,
    )?.[1];
    const routeHeader = /SHELL_TOKEN_HEADER\s*=\s*"([^"]+)"/.exec(healthRoute)?.[1];

    expect(rustEnv).toBeTruthy();
    expect(routeEnv).toBe(rustEnv);
    expect(rustHeader).toBeTruthy();
    expect(routeHeader).toBe(rustHeader);
  });

  it("the readiness probe trusts a server only when it proves the token", () => {
    const probe = rustFunction(sidecar, "pub async fn wait_until_ready");
    expect(probe).toContain("health_response_is_ours");

    // The check has to *decide*, not sit in a condition that is short
    // circuited away (`|| true`) or made optional (`&& false`).
    const conditions = [...probe.matchAll(/if\s+([^{]+)\{/g)].map((match) => match[1].trim());
    const gated = conditions.filter((condition) =>
      condition.includes("health_response_is_ours"),
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const condition of gated) {
      expect(condition).not.toMatch(/\|\||&&/);
    }

    // And the check itself fails closed: a response without the header is not
    // ours, however it answered.
    const check = rustFunction(sidecar, "pub fn health_response_is_ours");
    expect(check).toMatch(/None\s*=>\s*false/);
    expect(check).toContain("constant_time_eq");
  });

  it("the token reaches the server through the environment", () => {
    const env = rustFunction(sidecar, "pub fn server_env");
    expect(env).toMatch(/SHELL_TOKEN_ENV\.into\(\),\s*shell_token\.into\(\)/);
  });

  it("the server echoes the token only when it has one", () => {
    // No token, no header: a web deployment has no shell, and an empty
    // header value would look like a token to a caller.
    expect(healthRoute).toMatch(/process\.env\.NOEMA_SHELL_TOKEN/);
    expect(healthRoute).toMatch(/if\s*\(\s*token\s*\)/);
    expect(healthRoute).toMatch(/headers\[SHELL_TOKEN_HEADER\]\s*=\s*token;/);
  });

  it("the token never reaches the log", () => {
    // The shell's own log is written next to the app's data and shown in the
    // diagnostics panel — the token has to stay out of it.
    const logCalls = [...sidecar.matchAll(/logging::(?:line|sidecar_line)\s*\([^;]*\)/g)].map(
      (match) => match[0],
    );
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      expect(call).not.toMatch(/token/i);
    }
  });
});
