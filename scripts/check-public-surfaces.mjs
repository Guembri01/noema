#!/usr/bin/env node
/**
 * Public-surface visual and accessibility check.
 *
 * Runs the landing, sign-in and sign-up pages at the two widths the design
 * system promises (390 and 1440) in light and dark. It is deliberately a
 * *public* check: it needs no database and no seeded workspace, so it can run
 * on every laptop before a change lands.
 *
 * Checks per page:
 *   - HTTP 200
 *   - no console/page errors
 *   - no horizontal overflow
 *   - exactly one h1
 *   - every focusable control has an accessible name
 *   - body text meets AA against the body background
 *   - the email field boundary meets 3:1 against the page
 *
 * Usage:
 *   node scripts/check-public-surfaces.mjs
 *   node scripts/check-public-surfaces.mjs http://localhost:3000
 */
import { chromium } from "@playwright/test";

const base = (process.argv[2] ?? process.env.PUBLIC_UI_BASE ?? "http://localhost:3000").replace(/\/$/, "");
const cases = [
  { path: "/", name: "landing" },
  { path: "/login", name: "login" },
  { path: "/signup", name: "signup" },
  { path: "/this-page-does-not-exist", name: "not-found", expectedStatus: 404 },
];
const viewports = [
  { width: 390, height: 844, label: "mobile" },
  { width: 1440, height: 1000, label: "desktop" },
];
const schemes = ["light", "dark"];

function channels(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  const [r, g, b, a = 1] = parts;
  if (![r, g, b, a].every(Number.isFinite)) return null;
  return { r, g, b, a };
}

function over(fg, bg) {
  return {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  return [r, g, b]
    .map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(fg, bg) {
  if (!fg || !bg) return 0;
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const browser = await chromium.launch();
let failed = 0;
let checked = 0;

for (const testCase of cases) {
  for (const viewport of viewports) {
    for (const scheme of schemes) {
      checked += 1;
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
      });
      if (scheme === "dark") {
        await page.addInitScript(() => localStorage.setItem("theme", "dark"));
      }

      const errors = [];
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        // A 404 document legitimately logs one failed-resource entry in dev.
        if (
          testCase.expectedStatus === 404 &&
          /status of 404/i.test(message.text())
        ) {
          return;
        }
        errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));

      const response = await page.goto(`${base}${testCase.path}`, {
        waitUntil: "networkidle",
      });
      const report = await page.evaluate(() => {
        const root = document.documentElement;
        const body = document.body;
        const focusables = [
          ...document.querySelectorAll("a,button,input,select,textarea"),
        ].filter((el) => {
          if (el.tagName === "INPUT" && el.type === "hidden") return false;
          if (el.getAttribute("aria-hidden") === "true") return false;
          return true;
        });
        const unnamed = focusables
          .filter((el) => {
            const name =
              el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              el.textContent?.trim() ||
              (el.labels && el.labels.length ? el.labels[0].textContent?.trim() : "");
            return !name;
          })
          .map((el) => el.outerHTML.slice(0, 160));
        const h1 = [...document.querySelectorAll("h1")].map((el) =>
          el.textContent?.trim(),
        );
        const email = document.querySelector("input[type=email]");
        const heading = document.querySelector("h1");
        return {
          overflow: Math.max(root.scrollWidth, body.scrollWidth) - window.innerWidth,
          h1,
          unnamed,
          bodyBackground: getComputedStyle(body).backgroundColor,
          bodyColor: getComputedStyle(body).color,
          headingColor: heading ? getComputedStyle(heading).color : null,
          inputBorder: email ? getComputedStyle(email).borderColor : null,
        };
      });

      const background = channels(report.bodyBackground);
      const bodyText = channels(report.bodyColor);
      const headingText = channels(report.headingColor ?? report.bodyColor);
      const inputBorder = channels(report.inputBorder);
      const textRatio = contrast(
        bodyText?.a === 1 ? bodyText : bodyText && background ? over(bodyText, background) : null,
        background,
      );
      const headingRatio = contrast(
        headingText?.a === 1 ? headingText : headingText && background ? over(headingText, background) : null,
        background,
      );
      const borderRatio = inputBorder ? contrast(inputBorder, background) : null;
      const failures = [];
      const expectedStatus = testCase.expectedStatus ?? 200;
      if (response?.status() !== expectedStatus) {
        failures.push(`HTTP ${response?.status()} (expected ${expectedStatus})`);
      }
      if (errors.length) failures.push(`${errors.length} console error(s)`);
      if (report.overflow > 0) failures.push(`horizontal overflow ${report.overflow}px`);
      if (report.h1.length !== 1) failures.push(`${report.h1.length} h1 elements`);
      if (report.unnamed.length) failures.push(`${report.unnamed.length} unnamed control(s)`);
      if (textRatio < 4.5) failures.push(`body text contrast ${textRatio.toFixed(2)}`);
      if (headingRatio < 4.5) failures.push(`heading contrast ${headingRatio.toFixed(2)}`);
      if (borderRatio !== null && borderRatio < 3) {
        failures.push(`control border contrast ${borderRatio.toFixed(2)}`);
      }

      const name = `${testCase.name} ${viewport.label} ${scheme}`;
      if (failures.length) {
        failed += 1;
        console.log(`FAIL  ${name}: ${failures.join("; ")}`);
        for (const snippet of report.unnamed.slice(0, 3)) console.log(`      ${snippet}`);
      } else {
        console.log(
          `PASS  ${name}  text ${textRatio.toFixed(2)}:1` +
            (borderRatio === null ? "" : `, border ${borderRatio.toFixed(2)}:1`),
        );
      }
      await page.close();
    }
  }
}

await browser.close();
if (failed > 0) {
  console.log(`\n${failed}/${checked} public surface(s) failed.`);
  process.exit(1);
}
console.log(`\n${checked}/${checked} public surfaces passed.`);
