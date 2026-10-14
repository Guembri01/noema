/* B19 debug: hydration state of the share page after navigation. */
import { chromium } from "@playwright/test";

const base = process.env.E2E_BASE_URL || "http://localhost:3201";
const pageId = process.env.B19_PAGE_ID;
const slug = process.env.B19_SLUG || "demo-workspace";

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

await page.goto(`${base}/login`, { timeout: 120_000, waitUntil: "domcontentloaded" });
await page.getByLabel("Email").fill("demo@noema.local");
await page.getByLabel("Password").fill("password123");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL(/\/w\//, { timeout: 120_000 });

const t0 = Date.now();
await page.goto(`${base}/w/${slug}/${pageId}`, { timeout: 120_000, waitUntil: "domcontentloaded" });
console.log(`goto done in ${Date.now() - t0}ms`);
for (let i = 1; i <= 6; i += 1) {
  await page.waitForTimeout(5_000);
  const state = await page.evaluate(() => {
    const header = document.querySelector("header");
    const share = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Share" || b.textContent?.trim() === "Share",
    );
    const keys = (el) => (el ? Object.keys(el).some((k) => k.startsWith("__react")) : null);
    return {
      ready: document.readyState,
      header: !!header,
      headerHydrated: keys(header),
      share: !!share,
      shareHydrated: keys(share),
      title: document.title,
    };
  });
  console.log(`${i * 5}s: ${JSON.stringify(state)}`);
}
await browser.close();
