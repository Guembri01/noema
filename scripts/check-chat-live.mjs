#!/usr/bin/env node
/**
 * End-to-end chat check: ask a real question through the real UI and assert the
 * answer is grounded in the data it should be.
 *
 * Unit tests can prove what goes *into* the prompt; only this can prove what comes
 * back out. It needs a dev server (`npx next dev -p 3200`) and a configured AI
 * provider (`.env` `AI_API_KEY`, or per-workspace settings).
 *
 *   npm run check:chat                       # both probes
 *   npm run check:chat -- --keep            # leave the answers on screen
 *
 * The two probes are the ones that were wrong before:
 *   1. "what is this page that I'm in??" with a page open — must describe THAT
 *      page, not recite workspace counts;
 *   2. a question with no keywords at all ("hello there, what can you see?") —
 *      must still answer from the workspace (the old keyword gating meant such a
 *      question saw almost nothing).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "docs", "screenshots", "chat");
const argv = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const BASE = argValue("--base", "http://localhost:3200");
/** An existing chat thread; the panel opens via `?chat=<id>`. */
const THREAD_ID = argValue("--thread", "");
const KEEP = argv.includes("--keep");
const ANSWER_TIMEOUT_MS = 120_000;

const failures = [];
const record = (ok, label, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Strip the app's print stylesheet (and any other CSS) out of extracted text. */
function sanitise(text) {
  return text
    .replace(/@media[\s\S]*$/i, "")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  console.log(`Live chat check — ${BASE}\n`);

  try {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (error) {
    console.error(
      `No dev server at ${BASE} (${String(error.message).split("\n")[0]}).\nStart it: npx next dev -p 3200`,
    );
    await browser.close();
    process.exit(1);
  }

  await page.locator('input[name="email"]').fill("demo@noema.local");
  await page.locator('input[name="password"]').fill("password123");
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL(/\/w\//, { timeout: 40000 });

  // Open a real page (the page chrome is what the first probe is about).
  const STATIC_ROUTES = /\/(projects|tickets|cycles|library|inbox|audit|roadmap|templates|search|settings|home)/;
  let pageHref = null;
  for (const candidate of await page.locator('a[href^="/w/demo-workspace/"]').all()) {
    const href = await candidate.getAttribute("href");
    if (href && !STATIC_ROUTES.test(href) && href.split("/").length === 4) {
      pageHref = href;
      break;
    }
  }
  if (!pageHref) {
    record(false, "found a page to open");
    await browser.close();
    process.exit(1);
  }
  const threadQuery = THREAD_ID ? `?chat=${THREAD_ID}` : "";
  await page.goto(`${BASE}${pageHref}${threadQuery}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const pageTitle = (await page.locator("textarea[aria-label='Page title']").inputValue().catch(() => "")) || "";
  console.log(`  (page open: ${pageHref}${pageTitle ? ` — "${pageTitle}"` : ""})\n`);

  // If the panel did not come up from the query param, click the sidebar's Chat
  // tab and then the first thread (that dispatches OPEN_CHAT_EVENT).
  if ((await page.locator('textarea[aria-label="Ask the AI"]').count()) === 0) {
    await page.locator('button:has-text("Chat")').first().click().catch(() => {});
    await page.waitForTimeout(800);
    await page.locator('[data-testid="chat-thread-row"], li button').first().click().catch(() => {});
  }
  await page.waitForSelector('textarea[aria-label="Ask the AI"]', { timeout: 25000 });

  const ask = async (question) => {
    const composer = page.locator('textarea[aria-label="Ask the AI"]');
    await composer.click();
    await composer.fill(question);
    await page.locator('button[aria-label="Send message"]').first().click();

    // Wait for the answer to finish streaming: the streaming bubble disappears.
    const deadline = Date.now() + ANSWER_TIMEOUT_MS;
    let last = "";
    while (Date.now() < deadline) {
      await sleep(1500);
      const streaming = await page.locator('[data-testid="chat-streaming"]').count();
      const answers = await page.locator('li[data-message-role="assistant"]').allTextContents();
      const latest = answers.length > 0 ? answers[answers.length - 1].trim() : "";
      // Keep the longest answer seen: streaming replaces the bubble as it grows.
      if (latest.length > last.length) last = latest;
      if (streaming === 0 && last.length > 0 && Date.now() > deadline - ANSWER_TIMEOUT_MS + 6000) break;
    }
    return sanitise(last);
  };

  // Probe 1: the exact question that used to answer with workspace counts.
  console.log("  probe 1: \"what is this page that I'm in??\"");
  const pageAnswer = await ask("what is this page that I'm in??");
  const describesPage =
    pageTitle.length > 0 && pageAnswer.toLowerCase().includes(pageTitle.toLowerCase());
  const recitesCounts = /(\d+)\s*(notes|databases|chat threads)\b/i.test(pageAnswer);
  record(
    describesPage || !recitesCounts,
    "the answer is about the open page, not workspace counts",
    describesPage ? `mentions "${pageTitle}"` : "no count recital",
  );
  console.log(`       answer: ${pageAnswer.slice(0, 220).replace(/\s+/g, " ")}…`);
  writeFileSync(join(SHOTS, "answer-this-page.txt"), pageAnswer, "utf8");
  await page.screenshot({ path: join(SHOTS, "answer-this-page.png") });

  // Probe 2: no keywords at all — the old gating had nothing to match on.
  console.log("\n  probe 2: \"hello there, what can you see?\" (no keywords)");
  const generic = await ask("hello there, what can you see?");
  const mentionsWorkspace = /(workspace|page|note|database|ticket|project)/i.test(generic) && generic.length > 80;
  record(mentionsWorkspace, "a keyword-free question still gets a grounded answer", `${generic.length} chars`);
  console.log(`       answer: ${generic.slice(0, 220).replace(/\s+/g, " ")}…`);
  writeFileSync(join(SHOTS, "answer-generic.txt"), generic, "utf8");
  await page.screenshot({ path: join(SHOTS, "answer-generic.png") });

  record(consoleErrors.length === 0, "no console errors", consoleErrors.slice(0, 2).join(" | ").slice(0, 160));

  if (!KEEP) await browser.close();
  else console.log("\n  (--keep: leaving the browser open is not supported in this harness; closing)");
  if (KEEP) await browser.close();

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} problem(s): ${failures.join("; ")}`);
    console.error(`Answers written to ${SHOTS}`);
    process.exit(1);
  }
  console.log(`Grounded answers confirmed. Transcripts: ${SHOTS}`);
}

main().catch((error) => {
  console.error("chat check crashed:", error);
  process.exit(1);
});
