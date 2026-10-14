import { expect, test, type Page } from "@playwright/test";
import { PrismaClient, type Prisma } from "@prisma/client";

/**
 * B96 — TOC scroll-spy: outline rendering, active-entry tracking
 * (`aria-current`), click-to-scroll with the prefers-reduced-motion gate, and
 * the view-local anchor strategy (slug ids stamped on the rendered headings,
 * never in the document model).
 *
 * The TOC is inserted via DOC FIXTURE: each test seeds a dedicated prisma page
 * whose JSON already contains a `tableOfContents` atom followed by 30 numbered
 * headings, two duplicate-text headings (slug dedupe) and a deep tail of
 * filler paragraphs — deterministic, no slash-menu typing races, and it
 * exercises the JSON load path the editor uses for every reopened page.
 *
 * Every test builds its own page and removes it in `finally` — never the
 * shared first page (LOOP_PLAYBOOK e2e discipline).
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };

const prisma = new PrismaClient();

// A cold dev server compiles routes on demand and other batches share it, so
// the per-test budget is deliberately generous (the config is 60s).
test.describe.configure({ timeout: 180_000 });

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto("/login", { timeout: 60_000 });
      await page.getByLabel("Email").fill(CREDENTIALS.email);
      await page.getByLabel("Password").fill(CREDENTIALS.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/w\//, { timeout: 60_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(5_000);
    }
  }
  throw lastError;
}

const SECTION_COUNT = 30;
const FILLER =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod " +
  "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim " +
  "veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.";

/** Doc fixture: TOC atom + numbered headings + duplicates + deep scroll tail. */
function seedContent(): Prisma.InputJsonValue {
  const content: Prisma.InputJsonValue[] = [{ type: "tableOfContents" }];
  for (let i = 1; i <= SECTION_COUNT; i += 1) {
    content.push({
      type: "heading",
      attrs: { level: 1 + (i % 3) }, // 1–3, deep-ish tree
      content: [{ type: "text", text: `Section ${i}` }],
    });
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: `${FILLER} ${FILLER}` }],
    });
  }
  // Duplicate texts → slug dedupe must keep both anchors unique.
  for (let i = 0; i < 2; i += 1) {
    content.push({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Deep dive" }],
    });
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: FILLER }],
    });
  }
  // Tail: >1 viewport below the last heading so the bottom-of-page scroll
  // still passes the final heading over the reading line.
  for (let i = 0; i < 10; i += 1) {
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: `${FILLER} ${FILLER}` }],
    });
  }
  return { type: "doc", content };
}

async function createTocPage() {
  const workspace = await prisma.workspace.findFirst({
    where: { slug: "demo-workspace" },
    select: { id: true, slug: true },
  });
  const owner = await prisma.user.findFirst({
    where: { email: CREDENTIALS.email },
    select: { id: true },
  });
  if (!workspace || !owner) throw new Error("demo workspace/user not seeded");
  const created = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      type: "PAGE",
      title: `B96 toc ${Date.now()}`,
      createdById: owner.id,
      position: 930_000,
      content: seedContent(),
    },
    select: { id: true },
  });
  return {
    pageId: created.id,
    slug: workspace.slug,
    cleanup: async () => {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    },
  };
}

async function openTocPage(page: Page, pageId: string, slug: string) {
  await signIn(page);
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
    try {
      await page.goto(`/w/${slug}/${pageId}`, { timeout: 60_000 });
      opened = true;
    } catch {
      await page.waitForTimeout(5_000);
    }
  }
  if (!opened) throw new Error(`could not open toc page ${pageId}`);
  const toc = page.locator(".noema-toc");
  await expect(toc).toBeVisible({ timeout: 45_000 });
  return toc;
}

/** Heading's content offset inside `#main` (i.e. the scrollTop that aligns it to the top). */
async function headingOffset(page: Page, text: string): Promise<number> {
  return page.evaluate((headingText) => {
    const main = document.getElementById("main");
    const heading = [...document.querySelectorAll("#main .ProseMirror h1, #main .ProseMirror h2, #main .ProseMirror h3")].find(
      (el) => el.textContent === headingText,
    );
    if (!main || !heading) throw new Error(`heading not found: ${headingText}`);
    return heading.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
  }, text);
}

/** Distance from `#main`'s top edge to the heading (0 = aligned to the reading line). */
async function headingGap(page: Page, text: string): Promise<number> {
  return page.evaluate((headingText) => {
    const main = document.getElementById("main");
    const heading = [...document.querySelectorAll("#main .ProseMirror h1, #main .ProseMirror h2, #main .ProseMirror h3")].find(
      (el) => el.textContent === headingText,
    );
    if (!main || !heading) throw new Error(`heading not found: ${headingText}`);
    return Math.abs(heading.getBoundingClientRect().top - main.getBoundingClientRect().top);
  }, text);
}

const mainScrollTop = (page: Page) =>
  page.evaluate(() => document.getElementById("main")!.scrollTop);

test.describe("B96 TOC scroll-spy", () => {
  test("outline tracks the active heading: click scrolls, aria-current follows", async ({
    page,
  }) => {
    const fixture = await createTocPage();
    try {
      const toc = await openTocPage(page, fixture.pageId, fixture.slug);
      const buttons = toc.locator("ul button");
      await expect(buttons).toHaveCount(SECTION_COUNT + 2);

      // Initial state: before the first heading reaches the reading line the
      // first entry is current (clamp — there is always an active entry).
      await expect(buttons.first()).toHaveAttribute("aria-current", "true");

      // Anchor strategy, observable: unique view-local ids on the rendered
      // headings, prefixed, with the duplicate texts deduped in doc order.
      const ids = await page.$$eval(
        "#main .ProseMirror h1[id], #main .ProseMirror h2[id], #main .ProseMirror h3[id]",
        (els) => els.map((el) => el.id),
      );
      expect(ids).toHaveLength(SECTION_COUNT + 2);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => id.startsWith("toc-"))).toBe(true);
      expect(ids.filter((id) => id.startsWith("toc-deep-dive"))).toEqual([
        "toc-deep-dive",
        "toc-deep-dive-2",
      ]);

      // …and none of it leaked into the stored document model.
      const stored = await prisma.page.findUnique({
        where: { id: fixture.pageId },
        select: { content: true },
      });
      expect(JSON.stringify(stored?.content)).not.toContain('"id"');

      // Click "Section 20": scroll must be SMOOTH (still in flight 150 ms
      // after the click over a ~2000 px distance), then settle aligned.
      const target = await headingOffset(page, "Section 20");
      expect(target).toBeGreaterThan(800);
      await toc.getByRole("button", { name: "Section 20", exact: true }).click();
      await page.waitForTimeout(150);
      const inFlight = await mainScrollTop(page);
      expect(inFlight).toBeLessThan(target - 200); // an instant jump would already be there
      await expect.poll(() => headingGap(page, "Section 20"), { timeout: 10_000 }).toBeLessThanOrEqual(3);
      await expect(
        toc.getByRole("button", { name: "Section 20", exact: true }),
      ).toHaveAttribute("aria-current", "true");

      // Manual scroll: the spy follows the heading at the reading line…
      const scrollTop = await headingOffset(page, "Section 10");
      await page.evaluate((top) => {
        document.getElementById("main")!.scrollTop = top;
      }, scrollTop);
      await expect(
        toc.getByRole("button", { name: "Section 10", exact: true }),
      ).toHaveAttribute("aria-current", "true");
      // …only that entry stays current.
      await expect(
        toc.getByRole("button", { name: "Section 11", exact: true }),
      ).not.toHaveAttribute("aria-current", "true");

      // Back to the top → first entry current again.
      await page.evaluate(() => {
        document.getElementById("main")!.scrollTop = 0;
      });
      await expect(buttons.first()).toHaveAttribute("aria-current", "true");

      // Bottom of the page → last entry current.
      await page.evaluate(() => {
        const main = document.getElementById("main")!;
        main.scrollTop = main.scrollHeight;
      });
      await expect(buttons.last()).toHaveAttribute("aria-current", "true", {
        timeout: 10_000,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("click scroll is instant under prefers-reduced-motion", async ({ page }) => {
    const fixture = await createTocPage();
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const toc = await openTocPage(page, fixture.pageId, fixture.slug);
      const target = await headingOffset(page, "Section 25");
      expect(target).toBeGreaterThan(800);

      const entry = toc.getByRole("button", { name: "Section 25", exact: true });
      await entry.click();

      // The gate must make the jump synchronous: one fixed sample (no
      // retries!) taken after the deferred scroll frame has certainly run.
      // A smooth animation would still be >200 px short at this point.
      await page.waitForTimeout(150);
      const settled = await mainScrollTop(page);
      expect(Math.abs(settled - target)).toBeLessThanOrEqual(3);

      await expect(entry).toHaveAttribute("aria-current", "true");
      expect(await headingGap(page, "Section 25")).toBeLessThanOrEqual(3);
    } finally {
      await fixture.cleanup();
    }
  });
});
