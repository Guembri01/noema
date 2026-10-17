#!/usr/bin/env node
// Visual regression + review harness. One command for every wave.
//
// WHAT IT DOES
//   Signs in as the seeded demo user (demo@noema.local / password123), walks a
//   route list (workspace home, tickets board, a database table, a page with a
//   code block + table, settings, and /dev/ui when it exists), and captures one
//   screenshot per route in each of three themes: light, dark, high-contrast.
//
//   Screenshots  -> docs/screenshots/visual/<route>-<theme>.png   (gitignored)
//   Fingerprints -> scripts/visual-baseline.json
//                  route -> theme -> { hash, width, height, metrics }
//                  metrics = sidebar / main / first-card boxes + scrollWidth.
//
// WORKFLOW
//   1. Capture/refresh the baseline after an intentional UI change:
//        node scripts/visual-check.mjs --update
//   2. Review the PNGs under docs/screenshots/visual/ (open them, eyeball the
//      three themes) and commit scripts/visual-baseline.json.
//   3. On later waves run the plain check:
//        node scripts/visual-check.mjs
//      A route whose hash changed is REPORTED, not failed — a diff is not
//      automatically a bug (fonts, copy, intentional redesign). Open the PNGs
//      to judge it, then `--update` if it is intended.
//   4. A RED hard-failure is a real regression. The check hard-fails (exit 1)
//      on: a route returning != 200, a page-level console error / uncaught
//      exception, horizontal overflow (scrollWidth > clientWidth + 2), or an
//      element metric (sidebar / first card box) drifting beyond tolerance.
//
// USAGE
//   node scripts/visual-check.mjs [--update] [--base <url>] [--port <n>] [--only <route>]
//   Env: VISUAL_BASE_URL, VISUAL_PORT (defaults to http://localhost:3218).
//
// Keep a full run under ~2 minutes: the viewport is fixed and the browser is
// launched once (channel: msedge — the bundled Chromium is not downloaded).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "visual-baseline.json");
const SHOT_DIR = join(ROOT, "docs", "screenshots", "visual");

// Resolve DATABASE_URL deterministically from the worktree `.env` — the same
// file `next dev` loads — so routes are read from the very database the dev
// server is serving. Prisma Client loads a `.env` next to the generated client
// at import time (here that is the *main* repo), which would otherwise win;
// passing `datasourceUrl` below overrides it. `--database` / VISUAL_DATABASE_URL
// exist for the rare case of a server started with an explicit override.
function dotenvValue(name) {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && match[1] === name) return match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // No `.env`: fall back to the environment.
  }
  return undefined;
}
const flagValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const databaseUrl =
  flagValue("--database") ?? process.env.VISUAL_DATABASE_URL ?? dotenvValue("DATABASE_URL") ?? process.env.DATABASE_URL;

const DEMO_EMAIL = "demo@noema.local";
const THEMES = ["light", "dark", "high-contrast"];
const VIEWPORT = { width: 1280, height: 900 };
/** Pixel tolerance for element-metric drift (sub-pixel/antialias jitter). */
const TOLERANCE = 2;
/** Horizontal overflow allowance (`scrollWidth > clientWidth + 2`). */
const OVERFLOW_SLACK = 2;
/** Let hydration, fonts and the first paint settle before the shutter. */
const SETTLE_MS = 700;

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const update = argv.includes("--update");
const only = valueOf("--only");
const port = Number(valueOf("--port") ?? process.env.VISUAL_PORT ?? 3218);
const base = (
  valueOf("--base") ?? process.env.VISUAL_BASE_URL ?? `http://localhost:${port}`
).replace(/\/$/, "");
const triedPort = (() => {
  try {
    return new URL(base).port || (base.startsWith("https") ? "443" : "80");
  } catch {
    return String(port);
  }
})();

// ------------------------------------------------------------------ reporting
const hardFailures = [];
let changed = 0;

function mark(ok) {
  return ok ? "ok  " : "FAIL";
}
function note(ok, label) {
  if (!ok) hardFailures.push(label);
}

// -------------------------------------------------------------- reachability
async function waitForServer(ms = 25000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      // Any HTTP response means something is listening — a 500 is a reachable
      // (if broken) server and is reported per-route below, not as "no server".
      await fetch(`${base}/login`, { redirect: "manual" });
      return true;
    } catch (error) {
      last = error.cause?.code ?? error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return last;
}

const reachable = await waitForServer();
if (reachable !== true) {
  console.error(`No dev server responded at ${base} (last error: ${reachable}).`);
  console.error("Start the dev server first, then re-run the visual check:\n");
  console.error(`  npx next dev -p ${triedPort}\n`);
  process.exit(1);
}

// ------------------------------------------------------------------- fixtures
// The route list is resolved from the seeded demo data so the harness keeps
// working when ids change. A page carrying both a code block and a table is not
// part of the seed, so one is created once (by a stable title) and reused —
// its id must stay put or the captured route would move between runs.
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const prisma = new PrismaClient(databaseUrl ? { datasourceUrl: databaseUrl } : {});
const user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
if (!user) {
  console.error(`Seeded demo user ${DEMO_EMAIL} is missing. Seed the database first.`);
  await prisma.$disconnect();
  process.exit(1);
}
const workspace =
  (await prisma.workspace.findFirst({ where: { ownerId: user.id } })) ??
  (await prisma.workspace.findFirst());
if (!workspace) {
  console.error("No workspace found for the demo user. Seed the database first.");
  await prisma.$disconnect();
  process.exit(1);
}

const pages = await prisma.page.findMany({
  where: { workspaceId: workspace.id, deletedAt: null },
  select: { id: true, title: true, type: true, content: true },
  orderBy: { position: "asc" },
});

const databasePage = pages.find((page) => page.type === "DATABASE");
if (!databasePage) {
  console.error("No database page in the demo workspace; the route list needs one.");
  await prisma.$disconnect();
  process.exit(1);
}

const FIXTURE_TITLE = "Visual check fixture";
const hasCodeAndTable = (page) => {
  const json = JSON.stringify(page.content ?? null);
  return json.includes('"codeBlock"') && json.includes('"table"');
};
let codeTablePage = pages.find((page) => page.type === "PAGE" && hasCodeAndTable(page));
if (!codeTablePage) {
  const created = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      title: FIXTURE_TITLE,
      icon: "🧪",
      createdById: user.id,
      position: 1500,
      content: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: FIXTURE_TITLE }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "A stable fixture so the visual check always has a page with a code block and a table." },
            ],
          },
          {
            type: "codeBlock",
            attrs: { language: "ts" },
            content: [{ type: "text", text: "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}" }],
          },
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Token" }] }] },
                  { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] },
                ],
              },
              {
                type: "tableRow",
                content: [
                  { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "radius" }] }] },
                  { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "rounded-md" }] }] },
                ],
              },
              {
                type: "tableRow",
                content: [
                  { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "duration" }] }] },
                  { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "DUR.base" }] }] },
                ],
              },
            ],
          },
        ],
      },
    },
    select: { id: true, title: true, type: true, content: true },
  });
  codeTablePage = created;
  console.log(`Created the "${FIXTURE_TITLE}" fixture page (${created.id}).`);
}

// `/dev/ui` is optional: only captured when it actually resolves.
async function devUiExists() {
  try {
    const res = await fetch(`${base}/dev/ui`, { redirect: "manual" });
    return res.status === 200;
  } catch {
    return false;
  }
}

const slug = workspace.slug;
const routeList = [
  { key: "workspace-home", label: "workspace home", path: `/w/${slug}` },
  { key: "tickets-board", label: "tickets board", path: `/w/${slug}/tickets` },
  { key: "database-table", label: "database table", path: `/w/${slug}/${databasePage.id}` },
  { key: "page-code-table", label: "page with code block + table", path: `/w/${slug}/${codeTablePage.id}` },
  { key: "settings", label: "settings", path: `/w/${slug}/settings` },
];
if (await devUiExists()) {
  routeList.push({ key: "dev-ui", label: "dev UI", path: "/dev/ui" });
}
const routes = only ? routeList.filter((route) => route.key === only) : routeList;
if (routes.length === 0) {
  console.error(`No route matches --only ${only}. Known: ${routeList.map((r) => r.key).join(", ")}`);
  await prisma.$disconnect();
  process.exit(1);
}

// --------------------------------------------------------------- capture page
const PNG = (buf) =>
  buf.length >= 24 && buf.toString("ascii", 1, 4) === "PNG"
    ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    : { width: 0, height: 0 };

// Belt-and-braces on top of the context's `reducedMotion: "reduce"` (the design
// system already neutralises motion there): kill any transition/animation so a
// frame is never captured mid-motion.
const FREEZE_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";

// Freeze the page clock so relative labels ("Edited 3 minutes ago") are stable
// across runs — otherwise every capture drifts as wall-clock time passes.
function freezeClock() {
  const FIXED = Date.UTC(2026, 9, 15, 12, 0, 0);
  const RealDate = Date;
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED);
      else super(...args);
    }
    static now() {
      return FIXED;
    }
  }
  MockDate.parse = RealDate.parse;
  MockDate.UTC = RealDate.UTC;
  window.Date = MockDate;
}

// Applied before every document boots: pick the theme through the app's own
// storage keys (next-themes `theme`, the topbar's high-contrast flag) so the
// real provider paints it, and pin the sidebar width for a stable layout.
function applyTheme(theme) {
  const dark = theme === "dark";
  const high = theme === "high-contrast";
  try {
    localStorage.setItem("theme", dark ? "dark" : "light");
    localStorage.setItem("noema:high-contrast", high ? "1" : "0");
    localStorage.setItem("noema:sidebar-width", "240");
  } catch {
    // Storage blocked: the class toggles below still apply the tokens.
  }
  // This runs at document-start, before the parser has necessarily created
  // <html>, so guard the root and retry once the document is ready.
  const paint = () => {
    const root = document.documentElement;
    if (!root) return false;
    root.classList.toggle("dark", dark);
    root.classList.toggle("high-contrast", high);
    return true;
  };
  if (!paint()) {
    document.addEventListener("DOMContentLoaded", paint, { once: true });
  }
}

function collectMetrics() {
  const rect = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)];
  };
  const main = document.querySelector("main");
  const cardSelectors = [
    '[data-testid="gallery-card"]',
    'main [role="listitem"]',
    "main article",
    "main table tbody tr",
    "main [role=\"button\"]",
    "main button",
    "main a",
  ];
  let firstCard = null;
  if (main) {
    for (const selector of cardSelectors) {
      const candidate = main.querySelector(selector);
      const box = candidate?.getBoundingClientRect();
      if (box && box.width >= 60 && box.height >= 20) {
        firstCard = candidate;
        break;
      }
    }
  }
  return {
    sidebar: rect(document.querySelector('[data-testid="sidebar"]')),
    main: rect(main),
    firstCard: rect(firstCard),
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  };
}

// Console noise that is never a page regression. Keep this list short and
// justified — everything else counts as a hard failure.
const CONSOLE_IGNORE = [
  /Download the React DevTools/i,
  /favicon/i,
];
const isIgnored = (text) => CONSOLE_IGNORE.some((re) => re.test(text));

async function capture(page, route, theme) {
  const errors = [];
  const onConsole = (message) => {
    if (message.type() === "error" && !isIgnored(message.text())) {
      const where = message.location()?.url;
      errors.push(`console: ${message.text()}${where ? ` (${where})` : ""}`);
    }
  };
  const onPageError = (error) => {
    const origin = error.stack?.split("\n")[1]?.trim().replace(/^at\s+/, "");
    errors.push(`uncaught: ${error.message}${origin ? ` (${origin})` : ""}`);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  let status = 0;
  try {
    const response = await page.goto(`${base}${route.path}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    status = response?.status() ?? 0;
    await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
    await page.waitForSelector("main", { timeout: 15000 }).catch(() => {});
  } catch (error) {
    errors.push(`navigation: ${error.message}`);
  }

  await page
    .evaluate(() => (document.fonts ? document.fonts.ready : true))
    .catch(() => {});
  await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);

  // Hydration can scroll-into-view an active tree item; pin every scroll
  // container (and the window) to the origin so the frame is reproducible.
  await page.evaluate(resetViewport).catch(() => {});
  const buffer = await stableShot(page);
  const metrics = await page.evaluate(collectMetrics).catch(() => null);

  page.off("console", onConsole);
  page.off("pageerror", onPageError);

  const file = join(SHOT_DIR, `${route.key}-${theme}.png`);
  writeFileSync(file, buffer);
  const size = PNG(buffer);
  return {
    status,
    hash: createHash("sha256").update(buffer).digest("hex"),
    width: size.width,
    height: size.height,
    metrics,
    errors,
  };
}

// Reset the window and every scroll container to the origin. Shared by the
// capture path; kept as a plain function so Playwright can serialise it.
function resetViewport() {
  window.scrollTo(0, 0);
  for (const element of document.querySelectorAll("*")) {
    if (element.scrollTop) element.scrollTop = 0;
    if (element.scrollLeft) element.scrollLeft = 0;
  }
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

// Take screenshots until several consecutive frames are byte-identical, so a
// lazy image, a late hydration repaint, async syntax highlighting or a leftover
// animation never lands in the fingerprint. Bounded so a genuinely oscillating
// page still terminates.
async function stableShot(page, { tries = 12, gap = 200, streak = 3 } = {}) {
  let last = await page.screenshot({ type: "png" });
  let same = 1;
  for (let attempt = 1; attempt < tries; attempt += 1) {
    await page.waitForTimeout(gap);
    const next = await page.screenshot({ type: "png" });
    same = next.equals(last) ? same + 1 : 1;
    last = next;
    if (same >= streak) return last;
  }
  return last;
}

// ------------------------------------------------------------------ the run
mkdirSync(SHOT_DIR, { recursive: true });
const browser = await chromium.launch({ channel: "msedge" });
const browserContext = await browser.newContext({ viewport: VIEWPORT, reducedMotion: "reduce" });
const loginPage = await browserContext.newPage();

let loggedIn = true;
try {
  await loginPage.goto(`${base}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await loginPage.getByLabel("Email").fill(DEMO_EMAIL);
  await loginPage.getByLabel("Password").fill("password123");
  await loginPage.getByRole("button", { name: "Sign in" }).click();
  await loginPage.waitForURL(/\/w\//, { timeout: 30000 });
} catch (error) {
  loggedIn = false;
  console.error(`Could not sign in as ${DEMO_EMAIL}: ${error.message}`);
}
const storageState = loggedIn ? await browserContext.storageState() : null;
if (!loggedIn) note(false, "sign-in as the seeded demo user failed");

// Warm-up: hit every route once so Turbopack finishes compiling and any
// first-load streaming/skeleton never becomes the frame we fingerprint.
if (loggedIn) {
  for (const route of routes) {
    await loginPage
      .goto(`${base}${route.path}`, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => {});
    await loginPage.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
    await loginPage.waitForTimeout(700);
  }
}
await loginPage.close();

console.log(`Visual check — ${base} · ${routes.length} routes × ${THEMES.length} themes · viewport ${VIEWPORT.width}×${VIEWPORT.height}\n`);

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : { routes: {} };
const next = {
  generatedAt: new Date().toISOString(),
  baseUrl: base,
  viewport: VIEWPORT,
  tolerance: TOLERANCE,
  routes: update ? {} : { ...baseline.routes },
};

if (loggedIn) {
  for (const route of routes) {
    console.log(`  ${route.label}  (${route.path})`);
    next.routes[route.key] = { label: route.label, path: route.path, themes: update ? {} : { ...(baseline.routes[route.key]?.themes ?? {}) } };

    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        reducedMotion: "reduce",
        colorScheme: theme === "dark" ? "dark" : "light",
        storageState,
      });
      await context.addInitScript(applyTheme, theme);
      await context.addInitScript(freezeClock);
      const page = await context.newPage();
      const shot = await capture(page, route, theme);
      await context.close();

      const entry = { hash: shot.hash, width: shot.width, height: shot.height, metrics: shot.metrics };
      next.routes[route.key].themes[theme] = entry;

      // ---- hard checks -------------------------------------------------
      const problems = [];
      if (shot.status !== 200) problems.push(`HTTP ${shot.status}`);
      if (!shot.metrics) problems.push("element metrics unavailable");
      if (shot.errors.length) problems.push(...shot.errors);
      if (
        shot.metrics &&
        shot.metrics.scrollWidth > shot.metrics.clientWidth + OVERFLOW_SLACK
      ) {
        problems.push(
          `horizontal overflow (scrollWidth ${shot.metrics.scrollWidth} > clientWidth ${shot.metrics.clientWidth} + ${OVERFLOW_SLACK})`,
        );
      }

      // ---- fingerprint comparison -------------------------------------
      const prior = baseline.routes[route.key]?.themes?.[theme];
      let detail;
      if (update) {
        detail = "captured";
      } else if (!prior) {
        detail = "no baseline — run --update";
        problems.push(detail);
      } else if (prior.hash !== shot.hash) {
        detail = `hash changed (${prior.hash.slice(0, 8)} → ${shot.hash.slice(0, 8)})`;
        changed += 1;
      } else {
        const drift = compareMetrics(prior.metrics, shot.metrics);
        if (drift) {
          detail = `metrics drifted (${drift})`;
          problems.push(detail);
        } else {
          detail = "unchanged";
        }
      }

      const ok = problems.length === 0;
      note(ok, `${route.key}/${theme}: ${problems.join("; ")}`);
      console.log(`    ${mark(ok)} ${theme.padEnd(13)} ${shot.hash.slice(0, 8)}  ${detail}`);
      for (const error of shot.errors.slice(0, 4)) console.log(`           ${error}`);
    }
    console.log("");
  }
}

// --------------------------------------------------------------- write result
if (loggedIn) {
  if (update) {
    if (hardFailures.length === 0) {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`  wrote ${relative(BASELINE_PATH)} · ${routes.length * THEMES.length} captures`);
    } else {
      console.log("\n  baseline NOT written — fix the hard failures above, then --update again.");
    }
  } else if (changed > 0) {
    console.log(`\n  ${changed} capture(s) changed — open docs/screenshots/visual/ and judge, then --update if intended.`);
  } else if (hardFailures.length === 0) {
    console.log("\n  no changes.");
  }
}

await browser.close();
await prisma.$disconnect();

function relative(path) {
  return path.replace(ROOT + "\\", "").replace(/\\/g, "/");
}

function compareMetrics(prior, current) {
  if (!prior && !current) return null;
  if (!prior || !current) return "metrics unavailable";
  const labels = ["sidebar", "main", "firstCard"];
  for (const label of labels) {
    const a = prior[label];
    const b = current[label];
    if (!a && !b) continue;
    if (!a || !b) return `${label} ${a ? "removed" : "missing"}`;
    for (let i = 0; i < 4; i += 1) {
      if (Math.abs(a[i] - b[i]) > TOLERANCE) {
        const axis = ["x", "y", "w", "h"][i];
        return `${label}.${axis} ${a[i]}→${b[i]}`;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------- summary
console.log(`\n  ${hardFailures.length} hard failure(s), ${changed} changed capture(s).`);
if (hardFailures.length > 0) {
  console.error("\nVISUAL REGRESSION — the captures above are real failures:");
  for (const failure of hardFailures) console.error(`  - ${failure}`);
  process.exit(1);
}
process.exit(0);
