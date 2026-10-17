#!/usr/bin/env node
/**
 * Popover placement check.
 *
 * A floating panel must open **attached to the control that opened it** and stay
 * inside the viewport. That is not automatic: `position: fixed` is only
 * viewport-relative when no ancestor creates a containing block, and several
 * surfaces here have one (the page header uses `backdrop-blur`; the editor
 * animates blocks with `transform`). The symptom is a menu that appears in the
 * corner of its container instead of under its button — the bug this file exists
 * to catch.
 *
 *   npm run check:popovers                     # against http://localhost:3200
 *   npm run check:popovers -- --base <url>
 *
 * For each surface it opens the popup, measures the panel against its trigger,
 * and fails if the panel is detached, off-screen, or clipped. Screenshots of each
 * case are written to docs/screenshots/popovers/ for a human to look at.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "docs", "screenshots", "popovers");
const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const BASE = argValue("--base", "http://localhost:3200");
const DEMO_EMAIL = "demo@noema.local";
const DEMO_PASSWORD = "password123";
const VIEWPORT = { width: 1280, height: 900 };
/** How far a panel may sit from its trigger before we call it detached. */
const TOLERANCE = 24;

const failures = [];
const record = (ok, label, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

/**
 * Attached = the panel starts within a hair of the trigger's edge, overlaps it
 * horizontally (or vertically, for side placements), and is fully on screen.
 */
function analyse(rawTrigger, rawPanel) {
  // Playwright gives {x, y, width, height}; everything below wants edges.
  const box = (b) => ({ top: b.y, left: b.x, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height });
  const trigger = box(rawTrigger);
  const panel = box(rawPanel);
  const problems = [];
  const gapTop = panel.top - trigger.bottom;
  const gapBottom = trigger.top - panel.bottom;
  const vertical = gapTop >= -4 && gapTop <= TOLERANCE + 8;
  const flippedUp = gapBottom >= -4 && gapBottom <= TOLERANCE + 8;
  if (!vertical && !flippedUp) {
    problems.push(`vertically detached (gap ${Math.round(gapTop)}px)`);
  }
  const overlapsX = panel.left <= trigger.right + TOLERANCE && panel.right >= trigger.left - TOLERANCE;
  const overlapsY = panel.top <= trigger.bottom + TOLERANCE && panel.bottom >= trigger.top - TOLERANCE;
  if (!overlapsX && !overlapsY) problems.push("does not overlap its trigger at all");
  if (panel.left < -1) problems.push(`overflows the left edge (${Math.round(panel.left)}px)`);
  if (panel.right > VIEWPORT.width + 1) {
    problems.push(`overflows the right edge (${Math.round(panel.right - VIEWPORT.width)}px)`);
  }
  if (panel.top < -1) problems.push(`overflows the top (${Math.round(panel.top)}px)`);
  if (panel.bottom > VIEWPORT.height + 1) {
    problems.push(`overflows the bottom (${Math.round(panel.bottom - VIEWPORT.height)}px)`);
  }
  if (panel.width < 80) problems.push(`suspiciously narrow (${Math.round(panel.width)}px)`);
  return { problems, gapTop, flippedUp, vertical };
}


/**
 * Sibling controls must not overlap each other: a wrapped flex toolbar whose
 * children render wider than their wrappers produces controls that are visually
 * cut off or sitting on top of one another.
 */
async function checkNoOverlap(page, label, containerSelector, childSelector = ":scope > *") {
  const container = page.locator(containerSelector).first();
  if ((await container.count()) === 0) {
    console.log(`  skip ${label} — no ${containerSelector}`);
    return;
  }
  const boxes = await container.locator(childSelector).evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { tag: node.tagName.toLowerCase(), text: (node.textContent || "").trim().slice(0, 24), ...rect };
      })
      .filter((box) => box.width > 1 && box.height > 1),
  );
  const clashes = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      // A few pixels of rounding is not an overlap; 4+ in both axes is.
      if (overlapX > 4 && overlapY > 4) {
        clashes.push(`"${a.text || a.tag}" / "${b.text || b.tag}" overlap ${Math.round(overlapX)}×${Math.round(overlapY)}px`);
      }
    }
  }
  record(clashes.length === 0, `${label}: no sibling controls overlap`, clashes.join("; "));
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: "reduce" });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  console.log(`Popover placement — ${BASE}\n`);

  // Reachability first, with a useful message.
  try {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (error) {
    console.error(
      `No dev server responded at ${BASE} (${String(error.message).split("\n")[0]}).\n` +
        "Start it first:  npx next dev -p 3200",
    );
    await browser.close();
    process.exit(1);
  }

  await page.locator('input[name="email"]').fill(DEMO_EMAIL);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL(/\/w\//, { timeout: 40000 });
  await page.waitForSelector("main", { timeout: 20000 });

  /** Open a popup, measure it against its trigger, screenshot both states. */
  const check = async (label, triggerSelector, panelSelector, { closeKey = "Escape" } = {}) => {
    const trigger = page.locator(triggerSelector).first();
    if ((await trigger.count()) === 0) {
      console.log(`  skip ${label} — no ${triggerSelector} on this page`);
      return;
    }
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    const before = await trigger.boundingBox();
    await trigger.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(450);
    const panel = page.locator(panelSelector).first();
    if ((await panel.count()) === 0) {
      record(false, `${label}: panel appeared`);
      return;
    }
    const box = await panel.boundingBox();
    if (!box || !before) {
      record(false, `${label}: measurable box`);
      return;
    }
    const after = await trigger.boundingBox();
    const shifted =
      after && (Math.abs(after.y - before.y) > 4 || Math.abs(after.x - before.x) > 4);
    const verdict = analyse(before, box);
    if (shifted) {
      console.log(
        `       note: the trigger moved when the panel opened (y ${Math.round(before.y)} → ${Math.round(after.y)})`,
      );
      verdict.problems.push("opening the panel reflows/scrolls its own trigger");
    }
    record(verdict.problems.length === 0, `${label}: attached to its trigger`, verdict.problems.join("; "));
    console.log(
      `       trigger ${Math.round(before.x)},${Math.round(before.y)} ${Math.round(before.width)}×${Math.round(before.height)}` +
        `  panel ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}` +
        `  gap ${Math.round(verdict.gapTop)}px`,
    );
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });
    writeFileSync(join(SHOTS, `${slug}.png`), shot);
    await page.keyboard.press(closeKey);
    await page.waitForTimeout(250);
  };

  // A real page: the page chrome (icon, title, ⋯) only exists on a page route.
  await page.goto(`${BASE}/w/demo-workspace`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const STATIC_ROUTES = /\/(projects|tickets|cycles|library|inbox|audit|roadmap|templates|search|settings|home)/;
  const candidates = await page.locator('a[href^="/w/demo-workspace/"]').all();
  let pageHref = null;
  for (const candidate of candidates) {
    const href = await candidate.getAttribute("href");
    if (href && !STATIC_ROUTES.test(href) && href.split("/").length === 4) {
      pageHref = href;
      break;
    }
  }
  const pageLink = { count: async () => (pageHref ? 1 : 0), getAttribute: async () => pageHref };
  if ((await pageLink.count()) > 0) {
    const href = await pageLink.getAttribute("href");
    if (href) {
      await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      console.log(`  (checking the page chrome on ${href})\n`);
    }
  } else {
    console.log("  warning: no page link found in the sidebar\n");
  }

  // 1. The reported bug: the page's ⋯ actions menu, inside a `backdrop-blur` header.
  await check("page actions menu", 'button[aria-label="Actions"]', '[role="dialog"][aria-label="Page actions"]');

  // 2. The page icon picker (a second floating panel in the page chrome).
  await check(
    "page icon picker",
    'button[aria-label="Change icon"], button[aria-label="Add icon"]',
    '[role="dialog"][aria-label="Pick an icon"]',
  );

  // 3. A Select from the database toolbar (portalled listbox).
  await page.goto(`${BASE}/w/demo-workspace/tickets`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  // The popup is `[data-testid="select-menu"]`; `[role="listbox"]` is the list
  // *inside* it, below the search field — measuring that reported a false 47px gap.
  await check("tickets toolbar select", 'button[aria-haspopup="listbox"]', '[data-testid="select-menu"]');

  // Layout: siblings in the toolbar rows must not overlap.
  await checkNoOverlap(page, "tickets toolbar", '[data-testid="tickets-toolbar"]');

  if (consoleErrors.length > 0) {
    record(false, "no console errors", consoleErrors.slice(0, 2).join(" | ").slice(0, 200));
  } else {
    record(true, "no console errors");
  }

  await browser.close();
  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} problem(s): ${failures.join("; ")}`);
    console.error(`Screenshots: ${SHOTS}`);
    process.exit(1);
  }
  console.log(`All popovers open attached to their trigger. Screenshots: ${SHOTS}`);
}

main().catch((error) => {
  console.error("popover check crashed:", error);
  process.exit(1);
});
