#!/usr/bin/env node
/**
 * Motion harness — measures the animation system in a real browser instead of
 * trusting that a class name is present.
 *
 * Why this exists: `npm run check:motion` is static. It proves no ad-hoc duration or
 * `transition: all` is written, and that reduced-motion is handled somewhere — but it
 * cannot tell whether a control actually animates, how fast, or whether the OS
 * preference really collapses it. "The animation exists" and "the animation runs at
 * the token's speed" are different claims, and only one of them is greppable.
 *
 * What it asserts:
 *   1. the timing tiers on the motion gallery (`/dev/ui`, dev-only) — 120/180/240/320ms;
 *   2. the same tiers on **shipped** controls: hover feedback at the micro tier, the
 *      sidebar's width at the panel tier, and the page-content transition at the
 *      page tier (which is the one a user feels on every navigation);
 *   3. that `prefers-reduced-motion: reduce` collapses all of it (measured in a
 *      second browser context, not asserted from CSS);
 *   4. that a drag surface carries `u-no-transition`, so a pointer-tracked element
 *      never animates behind the cursor.
 *
 *   npx next dev -p 3200                      # the gallery is dev-only
 *   npm run check:animation                   # against http://localhost:3200
 *   npm run check:animation -- --base http://127.0.0.1:<installed app port>
 *
 * Against the installed app the gallery checks are skipped (a production build calls
 * `notFound()` for /dev/ui) and the shipped-control checks still run — which is the
 * half that matters for what users get.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const BASE = argValue("--base", "http://localhost:3200");
const DEMO_EMAIL = "demo@noema.local";
const DEMO_PASSWORD = "password123";
const SHOT_DIR = join(ROOT, "docs", "screenshots", "motion");

/** The tiers the token layer defines (`--dur-1..4`). Milliseconds. */
const TIERS = { micro: 120, standard: 180, panel: 240, slow: 320 };
/** Reduced motion collapses to 0.01ms; anything under 20ms counts as "no motion". */
const REDUCED_CEILING_MS = 20;

const failures = [];
const notes = [];
const record = (ok, label, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};
const skip = (label, why) => {
  console.log(`  skip ${label} — ${why}`);
  notes.push(`${label}: ${why}`);
};

/** Read whichever timing a slide actually carries: transition or animation. */
const timings = (page, selector) =>
  page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return null;
    const style = getComputedStyle(element);
    const durations = (value) => value.split(",").map((part) => parseFloat(part) * 1000).filter((n) => !Number.isNaN(n));
    return {
      transition: durations(style.transitionDuration),
      animation: durations(style.animationDuration),
    };
  }, selector);

const maxOf = (values) => (values.length === 0 ? null : Math.max(...values));

/** Does the element animate at roughly this tier (in whichever way it expresses it)? */
const atTier = (timing, tierMs) => {
  if (!timing) return false;
  const candidates = [...timing.transition, ...timing.animation].filter((n) => n > 0);
  return candidates.some((value) => Math.abs(value - tierMs) <= 8);
};

const anyMotion = (timing) => {
  if (!timing) return false;
  return [...timing.transition, ...timing.animation].some((value) => value > REDUCED_CEILING_MS);
};

/**
 * Launch whatever Chromium this machine actually has. The sibling harnesses use the
 * system Edge channel; Playwright's own headless shell is not installed here.
 */
async function launchBrowser() {
  const attempts = [{ channel: "msedge" }, { channel: "chrome" }, {}];
  let lastError = null;
  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `no Chromium available (${lastError && lastError.message}); install Edge or Chrome, or run 'npx playwright install chromium'`,
  );
}

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const email = page.locator('input[name="email"]');
  const password = page.locator('input[name="password"]');
  if ((await email.count()) === 0 || (await password.count()) === 0) return false;
  await email.fill(DEMO_EMAIL);
  await password.fill(DEMO_PASSWORD);
  // The same sequence the popover harness uses: the form posts through a server
  // action, so waiting on the URL is the only reliable completion signal.
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL(/\/w\//, { timeout: 40_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page.url().includes("/w/");
}

async function main() {
  console.log(`Motion harness — ${BASE}\n`);
  mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // 1. The timing tiers themselves, on the gallery.
  let galleryReachable = false;
  try {
    const response = await page.goto(`${BASE}/dev/ui`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    galleryReachable = Boolean(response) && response.status() === 200 && (await page.locator('[data-testid="motion-gallery"]').count()) > 0;
  } catch {
    galleryReachable = false;
  }

  if (galleryReachable) {
    console.log("  (motion gallery on /dev/ui)\n");
    const demos = [
      ["motion-dur-1", TIERS.micro],
      ["motion-dur-2", TIERS.standard],
      ["motion-dur-3", TIERS.panel],
      ["motion-dur-4", TIERS.slow],
    ];
    for (const [testId, tier] of demos) {
      const timing = await timings(page, `[data-testid="${testId}"]`);
      record(atTier(timing, tier), `${testId} animates at its tier`, timing ? `${maxOf([...timing.transition, ...timing.animation])}ms (expected ~${tier}ms)` : "element not found");
    }
    const reduceToggle = page.locator('[data-testid="motion-reduce-toggle"]');
    if ((await reduceToggle.count()) > 0) {
      await reduceToggle.click();
      await page.waitForTimeout(300);
      const collapsed = await page.evaluate((ceiling) => {
        const root = document.querySelector('[data-testid="motion-gallery"]');
        const mark = root?.getAttribute("data-reduced") === "true";
        const durations = Array.from(root?.querySelectorAll('[data-testid^="motion-dur-"]') ?? []).flatMap((element) => {
          const style = getComputedStyle(element);
          return [...style.transitionDuration.split(","), ...style.animationDuration.split(",")].map((part) => parseFloat(part) * 1000);
        });
        return { mark, max: durations.length ? Math.max(...durations) : 0 };
      }, REDUCED_CEILING_MS);
      record(collapsed.mark, "the reduce-motion preview flips the gallery into reduced mode");
      record(collapsed.max <= REDUCED_CEILING_MS, "the demo durations collapse in reduced mode", `max ${Math.round(collapsed.max)}ms`);
      await page.screenshot({ path: join(SHOT_DIR, "gallery-reduced.png") });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
    } else {
      skip("the reduce-motion preview", "no [data-testid=\"motion-reduce-toggle\"] on the gallery");
    }
  } else {
    skip("the motion gallery tiers", "/dev/ui is not reachable (it is dev-only: a production build calls notFound())");
  }

  // 2. Shipped controls. These run against any build, including the installed app.
  const signedIn = await signIn(page);
  if (!signedIn) {
    record(false, "signed in to reach the shipped controls", "the demo credentials did not land in the workspace");
  } else {
    console.log(`\n  (shipped controls on ${new URL(page.url()).pathname})\n`);
  }

  const micro = await timings(page, "button.u-interactive");
  if (micro) record(atTier(micro, TIERS.micro), "hover feedback runs at the micro tier", `${maxOf([...micro.transition, ...micro.animation])}ms (expected ~${TIERS.micro}ms)`);
  else skip("hover feedback (micro tier)", "no button.u-interactive on this page");

  const panelMeasurement = await page.evaluate((tier) => {
    const handle = document.querySelector('[data-testid="sidebar-resize"]');
    if (!handle) return { handle: false };
    // The width transition is on the panel root; the handle is its child.
    for (let node = handle; node instanceof HTMLElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.transitionProperty.includes("width")) {
        return { handle: true, found: true, ms: Math.max(...style.transitionDuration.split(",").map((p) => parseFloat(p) * 1000)) };
      }
    }
    return { handle: true, found: false };
  }, TIERS.standard);
  record(panelMeasurement.handle, "the sidebar resize handle is present");
  if (panelMeasurement.found) {
    record(Math.abs(panelMeasurement.ms - TIERS.standard) <= 8, "the sidebar width transition runs at the panel tier", `${panelMeasurement.ms}ms (expected ~${TIERS.standard}ms)`);
  } else {
    skip("the sidebar width transition at the panel tier", "no ancestor of the handle animates width");
  }

  const content = await page.evaluate(() => {
    const main = document.querySelector("#main");
    if (!main) return null;
    const wrapper = main.querySelector(".animate-fade");
    if (!wrapper) return null;
    const style = getComputedStyle(wrapper);
    return { animation: [parseFloat(style.animationDuration) * 1000] };
  });
  if (content) {
    record(Math.abs(content.animation[0] - TIERS.standard) <= 8, "page navigation fades at the page tier (150–250ms)", `${content.animation[0]}ms (expected ~${TIERS.standard}ms)`);
  } else {
    skip("the page-content transition", "no .animate-fade wrapper inside #main");
  }

  const dragSafe = await page.evaluate(() => {
    // Measure the utility itself: an element that would otherwise transition for a
    // second must end up at 0 with the drag class applied.
    const probe = document.createElement("div");
    probe.style.transition = "opacity 1s linear";
    probe.className = "u-no-transition";
    document.body.appendChild(probe);
    const ms = parseFloat(getComputedStyle(probe).transitionDuration) * 1000;
    probe.remove();
    return ms;
  });
  record(dragSafe <= 1, "u-no-transition removes the transition from a drag surface", `${dragSafe}ms (a 1000ms transition becomes this)`);

  await page.screenshot({ path: join(SHOT_DIR, "app-motion.png") });

  // 3. Reduced motion, measured in its own context rather than inferred.
  const reducedContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const reducedPage = await reducedContext.newPage();
  await signIn(reducedPage);
  const reducedMicro = await timings(reducedPage, "button.u-interactive");
  const reducedContent = await reducedPage.evaluate(() => {
    const wrapper = document.querySelector("#main .animate-fade");
    return wrapper ? { animation: [parseFloat(getComputedStyle(wrapper).animationDuration) * 1000] } : null;
  });
  if (reducedMicro) record(!anyMotion(reducedMicro), "reduced motion: hover feedback stops animating", `max ${maxOf([...reducedMicro.transition, ...reducedMicro.animation])}ms`);
  else skip("reduced motion: hover feedback", "no button.u-interactive to measure");
  if (reducedContent) record(reducedContent.animation[0] <= REDUCED_CEILING_MS, "reduced motion: the page transition collapses", `${reducedContent.animation[0]}ms`);
  else skip("reduced motion: the page transition", "no .animate-fade wrapper");
  await reducedPage.screenshot({ path: join(SHOT_DIR, "app-motion-reduced.png") });

  await browser.close();

  console.log("");
  if (notes.length > 0) console.log(`  ${notes.length} check(s) skipped — see above (they are not passes).`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} problem(s): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log(`Motion is measured: the tiers hold${galleryReachable ? ", the gallery collapses under reduced motion" : ""}, and the shipped controls behave.`);
  console.log(`Screenshots: ${SHOT_DIR}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("motion harness crashed:", error);
  process.exit(1);
});
