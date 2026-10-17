#!/usr/bin/env node
/**
 * Content-Security-Policy check against a **production** server.
 *
 * Why a production server: `next dev` serves a deliberately laxer policy, so a
 * script the production CSP blocks is invisible while developing. That is exactly
 * how a stale `THEME_SCRIPT_SHA256` reached an installed build: the pin no longer
 * matched the next-themes bootstrap, the browser blocked it, and only the
 * installed app showed it.
 *
 * What it does:
 *   1. loads pages and fails on any CSP violation in the console;
 *   2. reads the served policy and every inline `<script>`: each script must be
 *      either **nonced with the response nonce** or **hash-allowed** by the
 *      policy — nothing else can execute;
 *   3. when a script is covered by neither, it prints the exact `sha256-…` the
 *      policy would need, so fixing it is mechanical (that is how the stale pin is
 *      repaired rather than guessed).
 *
 *   npm run check:csp                       # against a running production server
 *   npm run check:csp -- --base http://127.0.0.1:3210
 *   npm run check:csp -- --fix-print        # just print the pins it would need
 *   npm run check:csp -- --browser chromium # the bundled Playwright Chromium
 */
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";

const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const BASE = argValue("--base", "http://127.0.0.1:3210");
/**
 * The browser the check drives.
 *
 * `msedge` is the default, because that is what the check has always used and
 * what the installed desktop app ships with. `chromium` is the Playwright
 * browser the repository already installs (`npx playwright install chromium`):
 * a CI runner has no Edge, so the gate there asks for the bundled Chromium.
 */
const BROWSER = argValue("--browser", process.env.CSP_BROWSER ?? "msedge");
const PRINT_ONLY = argv.includes("--fix-print");
const DEMO_EMAIL = "demo@noema.local";
const DEMO_PASSWORD = "password123";

const failures = [];
const record = (ok, label, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const sha256 = (text) => `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;

/** All `sha256-…` sources allowed by a CSP value. */
const allowedHashes = (csp) => new Set([...csp.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((m) => m[1]));

/** Inline `<script>` bodies in an HTML document (no `src`). */
function inlineScripts(html) {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs]) => !/\ssrc=/.test(attrs))
    .map(([, attrs, body]) => ({ nonce: attrs.match(/nonce="([^"]*)"/)?.[1] ?? null, body }))
    .filter((script) => script.body.trim().length > 0);
}

async function probe(page, path) {
  const response = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(600);
  const csp = response?.headers()["content-security-policy"] ?? "";
  const html = await response.text();
  return { csp, html };
}

async function main() {
  const browser = await chromium.launch(BROWSER === "chromium" ? {} : { channel: BROWSER });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const violations = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|CSP/i.test(text) && message.type() === "error") violations.push(text);
  });

  console.log(`CSP check — ${BASE}\n`);

  let target;
  try {
    target = await probe(page, "/login");
  } catch (error) {
    console.error(`No production server at ${BASE} (${String(error.message).split("\n")[0]}).`);
    await browser.close();
    process.exit(1);
  }

  const responseNonce = target.csp.match(/'nonce-([^']+)'/)?.[1] ?? null;
  const hashes = allowedHashes(target.csp);
  console.log(`  policy: ${target.csp.slice(0, 120)}…`);
  console.log(`  nonce:  ${responseNonce ? "present" : "ABSENT"}`);
  console.log(`  pinned hashes: ${hashes.size}\n`);

  const scripts = inlineScripts(target.html);
  console.log(`  inline scripts on /login: ${scripts.length}`);
  const uncovered = [];
  for (const script of scripts) {
    const nonced = script.nonce && responseNonce && script.nonce === responseNonce;
    const hashed = hashes.has(sha256(script.body));
    if (!nonced && !hashed) uncovered.push({ ...script, hash: sha256(script.body) });
  }
  record(
    uncovered.length === 0,
    "every inline script is nonced or hash-allowed",
    uncovered.length === 0 ? "" : `${uncovered.length} blocked`,
  );
  for (const script of uncovered) {
    console.log(`       BLOCKED script needs ${script.hash}`);
    console.log(`         body: ${script.body.trim().slice(0, 90)}…`);
  }

  if (uncovered.length > 0 && PRINT_ONLY) {
    console.log("\n  (--fix-print) paste the hashes above into THEME_SCRIPT_SHA256 / buildCsp sources");
  }

  // Sign in and re-check a real document: the authenticated pages are the ones
  // users actually load.
  await page.locator('input[name="email"]').fill(DEMO_EMAIL);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL(/\/w\//, { timeout: 40000 });
  await page.waitForTimeout(1500);

  const authed = await probe(page, "/w/demo-workspace");
  const authedNonce = authed.csp.match(/'nonce-([^']+)'/)?.[1] ?? null;
  const authedHashes = allowedHashes(authed.csp);
  const authedUncovered = inlineScripts(authed.html).filter((script) => {
    const nonced = script.nonce && authedNonce && script.nonce === authedNonce;
    return !nonced && !authedHashes.has(sha256(script.body));
  });
  record(
    authedUncovered.length === 0,
    "every inline script on an authenticated page is covered",
    authedUncovered.length === 0 ? "" : `${authedUncovered.length} blocked`,
  );
  for (const script of authedUncovered) {
    console.log(`       BLOCKED script needs ${sha256(script.body)}`);
  }

  record(violations.length === 0, "no CSP violations reported by the browser", violations.slice(0, 1).join("").slice(0, 140));
  for (const violation of violations.slice(0, 3)) {
    console.log(`       ${violation.slice(0, 200)}`);
  }

  await browser.close();
  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} problem(s): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("CSP is clean: nothing the app ships is blocked.");
}

main().catch((error) => {
  console.error("csp check crashed:", error);
  process.exit(1);
});
