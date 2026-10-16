// One-off capture script: logs in as the seeded demo user and screenshots the
// key surfaces so the app's real rendered state can be inspected.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3200";
const OUT = path.join("docs", "screenshots");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const shots = [];

  async function shot(name, url, waitFor) {
    await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
    }
    await page.waitForTimeout(900);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    const title = await page.title();
    const h1 = (await page.locator("h1").first().textContent().catch(() => "")) ?? "";
    shots.push({ name, url, status: "ok", title: title.trim(), heading: h1.trim().slice(0, 80), file });
  }

  // Public pages
  await shot("01-landing", "/");
  await shot("02-login", "/login");

  // Sign in as the seeded demo user
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', "demo@noema.local");
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  await shot("03-workspace-home", "/w/demo-workspace");
  await shot("04-library", "/w/demo-workspace/library");
  await shot("05-inbox", "/w/demo-workspace/inbox");
  await shot("06-search", "/w/demo-workspace/search?q=editor");
  await shot("07-settings", "/w/demo-workspace/settings");
  await shot("08-templates", "/w/demo-workspace/templates");
  await shot("09-roadmap", "/w/demo-workspace/roadmap");
  await shot("10-audit", "/w/demo-workspace/audit");
  await shot("11-trash", "/w/demo-workspace/trash");
  await shot("12-billing", "/w/demo-workspace/settings/billing");
  await shot("13-data-controls", "/w/demo-workspace/settings/data");
  await shot("14-prompt-library", "/w/demo-workspace/settings/prompts");
  await shot("15-move-pages", "/w/demo-workspace/settings/move");

  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(shots, null, 2));
  console.log(JSON.stringify(shots, null, 1));
  await browser.close();
})().catch((err) => {
  console.error("CAPTURE_FAILED", err.message);
  process.exit(1);
});
