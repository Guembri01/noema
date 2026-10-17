#!/usr/bin/env node
/**
 * Smoke-test the packaged payload, without the webview.
 *
 * This is the check that proves the *installer's contents* work: it runs the
 * bundled Node runtime on the staged `server/start.cjs` (which migrates the
 * database and then boots the Next server), waits for `/api/health`, and fetches
 * a real page. If this passes, the only thing left that can fail is the webview
 * window itself.
 *
 * It needs a reachable Postgres (the app's own schema) — the same one the site
 * version uses. `DATABASE_URL` from `.env` is used unless `NOEMA_DATABASE_URL`
 * is set.
 *
 *   npm run desktop:smoke
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeSidecarPath, targetTriple } from "./prepare.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const payload = join(root, "src-tauri", "server");
const runtime = nodeSidecarPath(targetTriple());
const READY_TIMEOUT_MS = 120_000;

function databaseUrl() {
  if (process.env.NOEMA_DATABASE_URL) return process.env.NOEMA_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = join(root, ".env");
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .find((entry) => entry.startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).replace(/^"|"$/g, "");
  }
  return "";
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

const problems = [];
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "ok   " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  console.log("Desktop payload smoke test\n");

  if (!existsSync(runtime)) {
    console.error(`Bundled runtime missing (${runtime}). Run: npm run desktop:prepare`);
    process.exit(1);
  }
  check(true, "bundled runtime present");
  if (!existsSync(join(payload, "start.cjs")) || !existsSync(join(payload, "server.js"))) {
    console.error(`Payload incomplete at ${payload}. Run: npm run desktop:prepare`);
    process.exit(1);
  }
  check(true, "payload staged (server.js + start.cjs)");

  const url = databaseUrl();
  if (!url) {
    console.error("No DATABASE_URL found (.env, NOEMA_DATABASE_URL or DATABASE_URL).");
    process.exit(1);
  }
  check(true, "database URL resolved", url.replace(/\/\/[^@]*@/, "//***@"));

  const dataDir = mkdtempSync(join(tmpdir(), "noema-smoke-"));
  const port = await freePort();
  console.log(`\n  starting the packaged server on 127.0.0.1:${port} …\n`);

  const child = spawn(runtime, [join(payload, "start.cjs")], {
    cwd: payload,
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      NOEMA_RUNTIME: "desktop",
      NOEMA_DATA_DIR: dataDir,
      DATABASE_URL: url,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  let status = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      status = response.status;
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await sleep(500);
  }

  if (!ready) {
    console.log("  --- server output (tail) ---");
    for (const line of output.split(/\r?\n/).slice(-25)) console.log(`  ${line}`);
    console.log("  ----------------------------\n");
  }
  check(ready, "GET /api/health returns 200", ready ? "" : `last status ${status || "no response"}`);

  if (ready) {
    const page = await fetch(`http://127.0.0.1:${port}/login`);
    const html = await page.text();
    check(page.status === 200, "GET /login returns 200", `status ${page.status}`);
    check(html.includes("<html") && html.length > 500, "page HTML is real (not an error shell)", `${html.length} bytes`);
    check(/noema|Noema/i.test(html), "page mentions the product");

    const css = await fetch(`http://127.0.0.1:${port}/login`).then((r) => r.text());
    check(/<link[^>]+\.css|styles/i.test(css), "stylesheets are linked (static assets copied)");
  }

  child.kill();
  await sleep(300);
  rmSync(dataDir, { recursive: true, force: true });

  console.log("");
  if (problems.length) {
    console.error(`${problems.length} problem(s): ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log("Payload boots, migrates and serves. The installer contains a working app.");
}

main().catch((error) => {
  console.error("smoke test crashed:", error);
  process.exit(1);
});
