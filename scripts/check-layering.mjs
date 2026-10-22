#!/usr/bin/env node
/**
 * Layering check: the modal tier must beat the docked AI panel.
 *
 * Route content is wrapped in the page-transition element
 * (`className="animate-fade"` in `workspace-shell.tsx`). A *filled* animation on
 * `opacity` keeps that wrapper a **stacking context** for as long as the fill
 * applies, and a stacking context cannot be escaped by its descendants: every
 * `fixed` surface rendered inside the route - the ticket drawer, the database
 * peek, the editor's popovers - was painted inside the wrapper's level, i.e.
 * *behind* the docked AI panel, which is a later flex sibling of `<main>` no
 * matter how high its z-index was. Opening a ticket with the assistant open
 * showed the panel, not the ticket.
 *
 * Four contracts keep that from coming back; all are measured in a real
 * browser, and the middle two inject a probe inside the route wrapper so the
 * claim is about measured paint order, not about a class name:
 *
 *   1. the page-transition wrapper releases its stacking context when the
 *      transition finishes (`animation-fill-mode` that does not fill forwards);
 *   2. a `Z.modal` (60) surface inside the route paints over the panel;
 *   3. a `Z.overlay` (40) scrim inside the route paints over the panel too -
 *      which requires the panel to sit in the chrome tier (`Z.sidebar`, 30),
 *      not in the scrim tier it used to share with those scrims;
 *   4. a popup opened *inside* such a surface (the ticket drawer's assignee
 *      `Select`) is itself hittable, i.e. painted above the drawer it belongs
 *      to. Releasing the wrapper's stacking context in step 1 is what puts the
 *      drawer at its real `Z.modal`, so a `Z.popover` (50) popup portalled to
 *      `<body>` would otherwise land *behind* it - the surface must offer a
 *      floating host (`FloatingHostProvider`) for its own popups.
 *
 *   npm run check:layering                    # against http://localhost:3200
 *   npm run check:layering -- --base <url>
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "docs", "screenshots", "layering");
const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const BASE = argValue("--base", "http://localhost:3200");
const DEMO_EMAIL = "demo@noema.local";
const DEMO_PASSWORD = "password123";
const VIEWPORT = { width: 1440, height: 900 };

/** The layer tokens this file asserts, mirrored from `src/lib/design-tokens.ts`. */
const Z_OVERLAY = 40;
const Z_MODAL = 60;

/**
 * The route-transition wrapper: `.animate-fade` is a shared motion class (the
 * editor's placeholder, the sticky title, chat bubbles all wear it), so the
 * check has to name the one that wraps the route - the direct child of `<main>`.
 */
const ROUTE_WRAPPER = "main > .animate-fade";

const failures = [];
const record = (ok, label, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

/** Place a full-viewport probe inside the route wrapper at `zIndex` (or clear). */
const probe = ([selector, zIndex]) => {
  document.querySelectorAll("[data-layering-probe]").forEach((node) => node.remove());
  if (zIndex === null) return true;
  const wrapper = document.querySelector(selector);
  if (!wrapper) return false;
  const node = document.createElement("div");
  node.setAttribute("data-layering-probe", String(zIndex));
  node.style.cssText = `position:fixed;inset:0;z-index:${zIndex}`;
  wrapper.appendChild(node);
  return true;
};

/** Name whatever owns a viewport point: a probe, the panel, or route content. */
const ownerOf = ([x, y]) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return "none";
  const probeAttr = el.getAttribute("data-layering-probe");
  if (probeAttr) return `probe-${probeAttr}`;
  if (el.closest("aside[aria-label]")) return "chat-panel";
  return `route:${el.tagName.toLowerCase()}`;
};

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('input[name="email"]').fill(DEMO_EMAIL);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL(/\/w\//, { timeout: 45000 });
}

/**
 * The sidebar's first *editor* page: the page header (and its Share control)
 * only exists there, and the tree is user data, so the check reads it instead of
 * hard-coding an id (the same approach `check-floating` takes).
 */
async function editorPageHref(page) {
  await page.goto(`${BASE}/w/demo-workspace`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="/w/demo-workspace/"]'))
      .map((a) => a.getAttribute("href"))
      .filter((href) => href && href.split("/").length === 4)
      .slice(0, 10),
  );
  for (const href of hrefs) {
    await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1100);
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
    const href = await editorPageHref(page);
    if (!href) {
      record(false, "found an editor page to open", "no page with [data-undo-depth] in the sidebar");
      return;
    }
    console.log(`  editor page: ${href}`);

    // 1. The page-transition wrapper must release its stacking context.
    const transition = await page.evaluate(([selector]) => {
      const wrapper = document.querySelector(selector);
      if (!wrapper) return null;
      const style = getComputedStyle(wrapper);
      return {
        name: style.animationName,
        fillMode: style.animationFillMode,
        inline: wrapper.getAttribute("style") || "",
      };
    }, [ROUTE_WRAPPER]);
    record(
      transition !== null,
      "the route-transition wrapper is mounted",
      transition ? `inline style: ${transition.inline}` : `no ${ROUTE_WRAPPER}`,
    );
    record(
      transition?.fillMode === "backwards" || transition?.fillMode === "none",
      "the page-transition wrapper releases its stacking context",
      `animation ${transition?.name} / fill-mode ${transition?.fillMode}`,
    );
    if (transition?.fillMode === "both" || transition?.fillMode === "forwards") {
      console.log(
        "       (a filled opacity animation keeps the wrapper a stacking context, which traps every fixed surface inside the route)",
      );
    }

    // 2. The panel, then the modal and scrim tiers measured against it.
    await page.locator('[data-testid="chat-fab"]').click();
    await page.waitForTimeout(900);
    const panelBox = await page.evaluate(() => {
      const panel = document.querySelector("aside[aria-label]");
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        z: Number(getComputedStyle(panel).zIndex),
      };
    });
    record(panelBox !== null, "the AI panel opens");
    if (!panelBox) return;

    const point = [
      Math.round(panelBox.right - 24),
      Math.round((panelBox.top + panelBox.bottom) / 2),
    ];

    const baseline = await page.evaluate(ownerOf, point);
    record(
      baseline === "chat-panel",
      "the AI panel owns its own column",
      `at (${point[0]}, ${point[1]}) the top element is ${baseline}`,
    );

    const modalInjected = await page.evaluate(probe, [ROUTE_WRAPPER, Z_MODAL]);
    record(modalInjected, "a modal-tier probe can be placed inside the route");
    await page.waitForTimeout(120);
    const overModal = await page.evaluate(ownerOf, point);
    record(
      overModal === `probe-${Z_MODAL}`,
      "a route-level modal (Z.modal) paints over the AI panel",
      `top element is ${overModal}`,
    );
    await page.screenshot({ path: join(SHOTS, "modal-over-panel.png") });

    const scrimInjected = await page.evaluate(probe, [ROUTE_WRAPPER, Z_OVERLAY]);
    record(scrimInjected, "a scrim-tier probe can be placed inside the route");
    await page.waitForTimeout(120);
    const overScrim = await page.evaluate(ownerOf, point);
    record(
      overScrim === `probe-${Z_OVERLAY}`,
      "a route-level scrim (Z.overlay) paints over the AI panel",
      `top element is ${overScrim} — the panel is at Z.sidebar ${panelBox.z}`,
    );
    record(
      panelBox.z === 30,
      "the AI panel sits in the chrome tier (Z.sidebar)",
      `z-index ${panelBox.z}`,
    );

    await page.evaluate(probe, [ROUTE_WRAPPER, null]);
    await page.screenshot({ path: join(SHOTS, "panel-restored.png") });

    // 3. A popup opened inside a route-level modal must beat that modal: the
    //    drawer owns the assignee `Select`, and a popup painted under its own
    //    drawer cannot be clicked at all. The tracker may legitimately be empty,
    //    so the check makes its own ticket through the composer and deletes it
    //    again at the end - a gate must not depend on, or leave, demo data.
    await page.goto(`${BASE}/w/demo-workspace/tickets`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    const created = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (el) => (el.textContent || "").trim() === "New ticket",
      );
      if (!button) return false;
      button.click();
      return true;
    });
    record(created, "the ticket composer opens");
    const title = page.locator('input[aria-label="Ticket title"]').first();
    await title.waitFor({ state: "visible", timeout: 15000 });
    await title.fill("Layering check ticket");
    await page.waitForTimeout(200);
    const submit = page
      .locator("button")
      .filter({ hasText: /^Create ticket$/ })
      .first();
    await submit.click();
    await page.waitForTimeout(2500);

    // Target the ticket this check just created. Taking the first card would
    // open (and later delete) an unrelated demo ticket.
    const card = page
      .locator('[data-testid="ticket-board-card"], tbody tr')
      .filter({ hasText: "Layering check ticket" })
      .first();
    const opened = (await card.count()) > 0;
    record(opened, "the new ticket is on the board");
    if (opened) await card.click();
    await page.waitForTimeout(900);

    const trigger = page.locator('[aria-label="Ticket assignee"]').first();
    record((await trigger.count()) > 0, "the ticket drawer exposes an assignee Select");
    await trigger.click();
    await page.waitForTimeout(600);
    const popup = await page.evaluate(() => {
      const menu = document.querySelector('[data-testid="select-menu"]');
      if (!menu) return { found: false };
      const first = menu.querySelector('[role="option"]');
      const row = first ?? menu;
      const rect = row.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const top = document.elementFromPoint(x, y);
      return {
        found: true,
        point: [x, y],
        inPopup: Boolean(top?.closest('[data-testid="select-menu"]')),
        owner: top ? `${top.tagName.toLowerCase()}.${(top.className || "").toString().slice(0, 42)}` : "none",
      };
    });
    record(popup.found, "the drawer's assignee popup opens");
    record(
      popup.inPopup === true,
      "a popup opened inside the drawer paints above the drawer",
      popup.found ? `at (${popup.point[0]}, ${popup.point[1]}) the top element is ${popup.owner}` : "",
    );
    await page.screenshot({ path: join(SHOTS, "popup-over-drawer.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // Clean up: the ticket this check created (and its drawer) must not stay.
    const remove = page.locator('[data-testid="ticket-delete"]').first();
    if ((await remove.count()) > 0) {
      await remove.click();
      await page.waitForTimeout(700);
      // The confirm button's accessible name is stable; match its test id
      // rather than its visible label, which is easy to break with markup.
      await page.locator('[data-testid="confirm-submit"]').click();
      // Wait for the drawer to close, which happens after the server action
      // resolves. A fixed pause can reload into the in-flight delete and abort
      // it, leaving the ticket behind.
      await page
        .locator('[data-testid="ticket-delete"]')
        .waitFor({ state: "detached", timeout: 10_000 })
        .catch(() => {});
      await page.waitForTimeout(500);
      // Reload before asserting so the check reads the persisted board, not the
      // optimistic client copy that can keep the card mounted for a frame. Count
      // the card, not matching text: the success toast also contains the title.
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1000);
      const remaining = page
        .locator('[data-testid="ticket-board-card"]')
        .filter({ hasText: "Layering check ticket" });
      const gone = (await remaining.count()) === 0;
      record(
        gone,
        "the check cleans up the ticket it created",
        gone ? "" : JSON.stringify((await remaining.allTextContents()).slice(0, 2)),
      );
    }

    // 4. A real modal from the page header still covers the panel's column.
    await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const shareClicked = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('[data-testid="page-title-bar"] button')).find(
        (el) => (el.getAttribute("aria-label") || "").toLowerCase() === "share",
      );
      if (!button) return false;
      button.click();
      return true;
    });
    record(shareClicked, "the Share dialog can be opened from the page header");
    await page.waitForTimeout(900);
    const overShare = await page.evaluate(ownerOf, point);
    record(
      overShare !== "chat-panel",
      "the Share dialog's scrim covers the AI panel",
      `at (${point[0]}, ${point[1]}) the top element is ${overShare}`,
    );
    await page.screenshot({ path: join(SHOTS, "share-over-panel.png") });

    record(errors.length === 0, "no page errors", errors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} layering problem(s). Screenshots: ${SHOTS}`);
    process.exit(1);
  }
  console.log(`\nThe modal tier beats the docked panel. Screenshots: ${SHOTS}`);
}

await main();
