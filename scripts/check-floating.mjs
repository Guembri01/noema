#!/usr/bin/env node
/**
 * Floating corner geometry check.
 *
 * The Ask-AI button, the editor's undo/redo bar and the sync notice are all
 * `position: fixed` in the bottom-right corner, and nothing coordinated them: the
 * button and the bar were pinned to the same inset (`bottom-5 end-5` vs
 * `bottom-4 right-4`) and the button drew on top of the bar. That is the bug this
 * file exists to catch.
 *
 *   npm run check:floating                    # against http://localhost:3200
 *   npm run check:floating -- --base <url>
 *
 * It measures the real boxes in a real browser: every bottom-anchored fixed
 * element must be visible, on screen, and disjoint from the others. The slot
 * arithmetic itself lives in `src/lib/floating-corner.ts` and is unit-tested;
 * this walks the floor and checks nothing moved.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "docs", "screenshots", "floating");
const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const BASE = argValue("--base", "http://localhost:3200");
const DEMO_EMAIL = "demo@noema.local";
const DEMO_PASSWORD = "password123";
const VIEWPORT = { width: 1440, height: 900 };
/** How far up from the viewport bottom a control counts as "in the corner". */
const CORNER_BAND = 400;

const failures = [];
const record = (ok, label, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

/** Mirrors `floatingBoxesOverlap` in src/lib/floating-corner.ts. */
const overlaps = (a, b) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Every bottom-anchored fixed element, measured.
 *
 * Full-bleed overlays (the chat panel on a narrow viewport, dialogs) are skipped:
 * they are *meant* to cover the corner, and flagging them would make the check
 * noise. Everything else in the corner band has to keep to itself.
 */
const collectFloatingBoxes = (cornerBand) =>
  Array.from(document.querySelectorAll("body *"))
    .filter((node) => {
      const style = getComputedStyle(node);
      if (style.position !== "fixed") return false;
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      // Bottom band only, and never a full-bleed surface.
      if (rect.bottom < window.innerHeight - cornerBand) return false;
      if (rect.width >= window.innerWidth - 8) return false;
      return true;
    })
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        name:
          node.getAttribute("data-testid") ||
          node.getAttribute("aria-label") ||
          `${node.tagName.toLowerCase()}.${String(node.className).split(/\s+/).slice(0, 2).join(".")}`,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
      };
    })
    .filter((box) => box.top < window.innerHeight);

/**
 * The app chrome a fixed control must never land on.
 *
 * The first version of this check only compared floating controls with each
 * other, so the editor's "Suggesting" toggle passed while it sat on top of the
 * sidebar's footer: it was `fixed` at the bottom-*left*, and nothing in the
 * bottom-right contract covered that corner. A control dodging a collision by
 * moving somewhere the check does not look is the same bug, so the chrome is
 * measured too.
 */
const collectChromeBoxes = () =>
  ["sidebar", "workspace-sidebar", "workspace-tabs"]
    .flatMap((testid) => Array.from(document.querySelectorAll(`[data-testid="${testid}"]`)))
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        name: node.getAttribute("data-testid"),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
      };
    })
    .filter((box) => box.right > box.left && box.bottom > box.top);

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('input[name="email"]').fill(DEMO_EMAIL);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL(/\/w\//, { timeout: 45000 });
}

/**
 * Find a page that mounts the editor (the undo/redo bar lives inside it).
 *
 * The sidebar hrefs are the only stable way in — the tree is user data, so the
 * check reads it rather than hard-coding an id.
 */
async function openEditorPage(page) {
  await page.goto(`${BASE}/w/demo-workspace`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="/w/demo-workspace/"]'))
      .map((a) => a.getAttribute("href"))
      .filter((href) => href && href.split("/").length === 4)
      .slice(0, 6),
  );
  for (const href of hrefs) {
    await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    if (await page.locator("[data-undo-depth]").count()) return href;
  }
  return null;
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message).slice(0, 140)));

  try {
    await signIn(page);
    const href = await openEditorPage(page);
    if (!href) {
      record(false, "found a page with the editor mounted", "no [data-undo-depth] in the sidebar's first pages");
      return;
    }
    console.log(`  editor page: ${href}`);

    // The button must be there — without it there is nothing to collide with.
    const fabCount = await page.locator('[data-testid="chat-fab"]').count();
    record(fabCount === 1, "the Ask-AI button is mounted", `found ${fabCount}`);

    const boxes = await page.evaluate(collectFloatingBoxes, CORNER_BAND);
    for (const box of boxes) {
      console.log(
        `  measured ${box.name.padEnd(28)} x ${box.left}…${box.right}  y ${box.top}…${box.bottom}`,
      );
    }

    record(boxes.length >= 2, "the corner has the controls it should", `${boxes.length} floating boxes`);

    const clashes = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        if (overlaps(boxes[i], boxes[j])) clashes.push(`${boxes[i].name} ✕ ${boxes[j].name}`);
      }
    }
    record(clashes.length === 0, "no two corner controls overlap", clashes.join(", "));

    // A floating control must not sit on the app chrome either — the sidebar
    // footer is where the "Suggesting" toggle used to land.
    const chrome = await page.evaluate(collectChromeBoxes);
    const onChrome = [];
    for (const box of boxes) {
      for (const surface of chrome) {
        if (overlaps(box, surface)) onChrome.push(`${box.name} ✕ ${surface.name}`);
      }
    }
    record(onChrome.length === 0, "no corner control lands on the sidebar", onChrome.join(", "));

    // Everything must sit inside the viewport: the offline notice is 20rem wide.
    const offScreen = boxes.filter((box) => box.left < 0 || box.right > VIEWPORT.width + 1);
    record(offScreen.length === 0, "every corner control is on screen", offScreen.map((b) => b.name).join(", "));

    await page.screenshot({ path: join(SHOTS, "corner.png") });

    // With the assistant open, the button stands down instead of stacking on the panel.
    await page.locator('[data-testid="chat-fab"]').click();
    await page.waitForTimeout(900);
    const fabHidden = await page.locator('[data-testid="chat-fab"]').isHidden();
    record(fabHidden, "the button hides while the panel it opens is open");
    await page.screenshot({ path: join(SHOTS, "panel-open.png") });

    record(errors.length === 0, "no page errors", errors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} floating-corner problem(s). Screenshots: ${SHOTS}`);
    process.exit(1);
  }
  console.log(`\nThe floating corner keeps to itself. Screenshots: ${SHOTS}`);
}

await main();
