/**
 * The film's asset capture — 2x page textures + element cutouts for `video/`.
 *
 *   node video/scripts/capture.mjs                  # every texture
 *   node video/scripts/capture.mjs --only db-       # by name prefix
 *   node video/scripts/capture.mjs --list           # names, no browser
 *   node video/scripts/capture.mjs --explore /w/demo-workspace/tickets
 *
 * Why this exists next to `scripts/screenshots.mjs`: that harness produces 1x
 * viewport images for the README, which is the right thing for a gallery and the
 * wrong thing for a film. The camera in `video/src/lib/PageCam.tsx` moves a
 * screenshot around in 2.5D, so it needs (a) 2x pixels, so text stays sharp when
 * a shot pushes in, (b) the full document, so a shot can pan down a long page,
 * and (c) a coordinate table for the elements a shot pulls out and animates on
 * their own — a ticket card, a burndown line, a label pill.
 *
 * It drives the **installed Edge** (`--channel msedge`) for the same reason the
 * gallery does: no ~150 MB browser download for a task that is not part of CI.
 *
 * Requires the seeded demo workspace and a server on `--base`
 * (`npm start -- --port 3200`, see docs/DESKTOP.md for the embedded database).
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "textures");
const CUT = join(ROOT, "public", "cutouts");

/** Login created by the demo seed. */
const DEMO = { email: "demo@noema.local", password: "password123" };

/** The film is 1920x1080; textures are captured at 2x. */
const VIEWPORT = { width: 1920, height: 1080 };
const SCALE = 2;

function parseArgs(argv) {
  const options = { base: "http://127.0.0.1:3200", channel: "msedge", only: null, explore: null, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") options.base = argv[++index];
    else if (arg === "--channel") options.channel = argv[++index];
    else if (arg === "--only") options.only = argv[++index];
    else if (arg === "--explore") options.explore = argv[++index];
    else if (arg === "--list") options.list = true;
  }
  return options;
}

/* -------------------------------------------------------------------------- *
 * Page helpers (same discipline as scripts/screenshots.mjs)
 * -------------------------------------------------------------------------- */

async function settle(page, timeout = 1400) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // Fonts and covers land after networkidle often enough that a fixed settle is
  // worth more than a cleverer wait — a half-loaded cover is exactly the kind of
  // thing nobody notices until it is in a film.
  await page.waitForTimeout(timeout);
}

async function login(page, base) {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', DEMO.email);
  await page.fill('input[name="password"]', DEMO.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  await settle(page);
}

async function tap(page, selector, timeout = 6000) {
  const hit = page.locator(selector).first();
  await hit.click({ timeout }).catch(() => undefined);
  return hit;
}

async function waitFor(page, selector, timeout = 15_000) {
  await page.waitForSelector(selector, { timeout }).catch(() => undefined);
}

/**
 * Theme is a cookie *and* localStorage (the server reads the cookie, next-themes
 * reads storage, and the library prefers storage). Setting one leaves a
 * first-paint flash — or a light capture of a dark session.
 */
async function applyTheme(page, base, theme) {
  await page.context().addCookies([{ name: "noema-theme", value: theme, url: base }]);
  await page
    .evaluate((next) => {
      try {
        window.localStorage.setItem("theme", next);
      } catch {
        /* storage blocked: the cookie alone still renders the right theme */
      }
    }, theme)
    .catch(() => undefined);
}

/**
 * Pick a database view by the label on its tab (`Table`, `Board`, …).
 *
 * Scoped to the tab bar — the strip that also holds "Add a view". An unscoped
 * `button:has-text("Calendar")` matches the sidebar's own Calendar entry first,
 * and the capture then silently shows the wrong surface; that is how `db-board`
 * ended up with an import dialog on it.
 */
async function pickView(page, label) {
  const tabBar = page.locator('button[aria-label="Add a view"]').locator("xpath=..");
  await tabBar
    .getByRole("button", { name: label, exact: false })
    .first()
    .click({ timeout: 8000 })
    .catch(() => undefined);
  await page.waitForTimeout(1400);
}

/** Pick a tickets view through its segmented control. */
async function pickTicketsView(page, view) {
  await tap(page, `[data-testid="segmented-option-${view}"]`);
  await page.waitForTimeout(1200);
}

async function scrollTo(page, selector) {
  await page
    .locator(selector)
    .first()
    .evaluate((node) => {
      node.scrollIntoView({ block: "center", behavior: "instant" });
    })
    .catch(() => undefined);
  await page.waitForTimeout(600);
}

async function explore(page, base, path) {
  await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  await settle(page, 2400);
  const info = await page.evaluate(() => {
    const text = (node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 46);
    return {
      title: document.title,
      testids: [...new Set([...document.querySelectorAll("[data-testid]")].map((n) => n.getAttribute("data-testid")))],
      buttons: [
        ...new Set(
          [...document.querySelectorAll("button")].map((n) => {
            const label = n.getAttribute("aria-label");
            const id = n.getAttribute("data-testid");
            return label ? `aria:${label}` : id ? `id:${id}` : `text:${text(n)}`;
          }),
        ),
      ].slice(0, 90),
      classes: [...new Set([...document.querySelectorAll("[class]")].map((n) => n.className).filter((c) => typeof c === "string"))]
        .flatMap((c) => c.split(/\s+/))
        .filter((c) => /^(notion-|db-|ticket|cycle|project|milestone|chat|burndown|label|view-)/.test(c))
        .slice(0, 90),
    };
  });
  console.log(`\n=== ${path} ===`);
  console.log(JSON.stringify(info, null, 1));
}

/* -------------------------------------------------------------------------- *
 * The textures
 * -------------------------------------------------------------------------- */

/**
 * A texture is `{ name, url, theme?, fullPage?, cutouts?, setup? }`.
 *
 * `cutouts` names the elements a shot animates separately; each is captured at
 * 2x into `public/cutouts/` and recorded in the texture's `layout.json` in
 * **texture space** (CSS px from the top-left of the captured image).
 */
function textures(ctx) {
  const w = `/w/${ctx.slug}`;
  return [
    { name: "landing", url: "/", anonymous: true, fullPage: true },
    { name: "login", url: "/login", anonymous: true },
    {
      name: "home",
      url: w,
      setup: (page) => waitFor(page, '[data-testid="template-preview"]'),
      cutouts: [{ name: "sidebar", selector: '[data-testid="workspace-sidebar"]' }],
    },
    {
      name: "home-dark",
      url: w,
      theme: "dark",
      setup: (page) => waitFor(page, '[data-testid="template-preview"]'),
    },
    {
      name: "editor",
      url: `${w}/${ctx.handbookId}`,
      fullPage: true,
      setup: (page) => scrollTo(page, "h1"),
    },
    {
      name: "slash",
      url: `${w}/${ctx.handbookId}`,
      setup: async (page) => {
        await tap(page, ".ProseMirror");
        await page.keyboard.press("Control+End");
        await page.keyboard.press("Enter");
        await page.keyboard.type("/");
        await waitFor(page, '[role="listbox"]');
      },
    },
    {
      name: "quickfind",
      url: `${w}/${ctx.pageId}`,
      setup: async (page) => {
        await page.keyboard.press("Control+p");
        await page.waitForTimeout(900);
      },
    },
    {
      name: "palette",
      url: `${w}/${ctx.pageId}`,
      setup: async (page) => {
        await page.keyboard.press("Control+k");
        await page.waitForTimeout(800);
      },
    },
    { name: "db-table", url: `${w}/${ctx.roadmapId}`, setup: (page) => pickView(page, "Table") },
    { name: "db-board", url: `${w}/${ctx.roadmapId}`, setup: (page) => pickView(page, "Board") },
    { name: "db-timeline", url: `${w}/${ctx.roadmapId}`, setup: (page) => pickView(page, "Timeline") },
    { name: "db-chart", url: `${w}/${ctx.roadmapId}`, setup: (page) => pickView(page, "By status") },
    { name: "db-list", url: `${w}/${ctx.roadmapId}`, setup: (page) => pickView(page, "List") },
    { name: "db-calendar", url: `${w}/${ctx.tasksId}`, setup: (page) => pickView(page, "Calendar") },
    { name: "db-gallery", url: `${w}/${ctx.contentId}`, setup: (page) => pickView(page, "Gallery") },
    {
      name: "db-properties",
      url: `${w}/${ctx.roadmapId}`,
      setup: async (page) => {
        // Pin the view first: the selected view is a persisted preference, so
        // without this a capture inherits whatever the last shot left behind.
        await pickView(page, "Table");
        // Open a *computed* property's editor rather than the column-visibility
        // popover: the caption is about property types, and only the editor shows
        // the type. `Est. (tasks)` is the roadmap's rollup (sum of sub-task
        // estimates, over the `Tasks` relation).
        await tap(page, '[data-testid="property-header-Est. (tasks)"]');
        await page.waitForTimeout(1400);
      },
      cutouts: [{ name: "progress-header", selector: '[data-testid="property-header-Progress"]' }],
    },
    {
      name: "db-rules",
      url: `${w}/${ctx.roadmapId}`,
      setup: async (page) => {
        await pickView(page, "Table");
        await tap(page, '[data-testid="color-trigger"]');
        await page.waitForTimeout(700);
        // Author a rule rather than photograph an empty panel: the whole point
        // of the shot is that the rows change colour when the rule matches.
        await tap(page, '[data-testid="add-color-rule"]');
        await page.waitForTimeout(600);
        // The rule defaults to the first property (`Status`) with the `is`
        // operator, so the value has to be a status — "Done" colours every
        // completed row, which is the readable version of the feature.
        await page
          .fill('input[aria-label="Color rule value"]', "Done")
          .catch(() => undefined);
        await page.waitForTimeout(1600);
      },
    },
    {
      name: "peek",
      url: `${w}/${ctx.roadmapId}`,
      setup: async (page) => {
        // The row peek lives on the table view (the list view has no peek
        // affordance), and the selected view is persisted — so pin it.
        await pickView(page, "Table");
        await tap(page, 'button[aria-label^="Open side peek"]');
        await waitFor(page, '[data-testid="peek-drawer"]', 8000);
        await page.waitForTimeout(1400);
      },
      cutouts: [{ name: "drawer", selector: '[data-testid="peek-drawer"]' }],
    },
    {
      name: "tickets-list",
      url: `${w}/tickets`,
      // The tickets view is a persisted preference too, so without pinning it this
      // capture inherits the board and the film shows the same surface twice.
      setup: (page) => pickTicketsView(page, "list"),
    },
    {
      name: "tickets-board",
      url: `${w}/tickets`,
      setup: (page) => pickTicketsView(page, "board"),
      cutouts: [
        { name: "card", selector: '[data-testid="ticket-board-card"]' },
        { name: "card-all", selector: '[data-testid="ticket-board-card"]', all: true },
      ],
    },
    {
      name: "tickets-timeline",
      url: `${w}/tickets`,
      setup: (page) => pickTicketsView(page, "timeline"),
    },
    {
      name: "ticket-drawer",
      url: `${w}/tickets`,
      setup: async (page) => {
        await tap(page, `button:has-text("${ctx.ticketKey}")`);
        await page.waitForTimeout(1700);
      },
    },
    {
      name: "cycles",
      url: `${w}/cycles`,
      cutouts: [
        { name: "card", selector: '[data-testid="cycle-card"]' },
        { name: "burndown", selector: 'svg:has([data-testid="burndown-point"])' },
      ],
    },
    {
      name: "projects",
      url: `${w}/projects`,
      cutouts: [{ name: "card", selector: '[data-testid="project-card"]' }],
    },
    { name: "project-detail", url: `${w}/projects/${ctx.projectId}` },
    { name: "roadmap", url: `${w}/roadmap`, fullPage: true },
    { name: "library", url: `${w}/library` },
    { name: "search", url: `${w}/search?q=roadmap` },
    { name: "inbox", url: `${w}/inbox` },
    {
      name: "chat",
      url: `${w}?chat=${ctx.chatId}`,
      setup: (page) => page.waitForTimeout(2000),
    },
    {
      name: "comments",
      url: `${w}/${ctx.commentPageId}`,
      setup: async (page) => {
        await tap(page, 'button:has-text("Add a comment")');
        await page.waitForTimeout(1100);
      },
    },
    {
      name: "versions",
      url: `${w}/${ctx.versionPageId}`,
      setup: async (page) => {
        await tap(page, 'button:has-text("Version history")');
        await page.waitForTimeout(1300);
      },
    },
    {
      name: "share",
      url: `${w}/${ctx.pageId}`,
      setup: async (page) => {
        await tap(page, 'button[aria-label="Share"]');
        await page.waitForTimeout(1100);
      },
    },
    { name: "public", url: `/s/${ctx.shareToken}`, fullPage: true },
    { name: "templates", url: `${w}/templates` },
    { name: "audit", url: `${w}/audit` },
    { name: "trash", url: `${w}/trash` },
    { name: "settings", url: `${w}/settings` },
    { name: "settings-data", url: `${w}/settings/data` },
    { name: "settings-tokens", url: `${w}/settings/tokens` },
    {
      name: "about",
      url: w,
      setup: async (page) => {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("noema:shell:about")));
        await page.waitForTimeout(800);
      },
    },
    {
      name: "shortcuts",
      url: w,
      setup: async (page) => {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("noema:shell:shortcuts")));
        await page.waitForTimeout(800);
      },
    },
    { name: "mobile", url: `${w}/${ctx.handbookId}`, viewport: { width: 390, height: 844 } },
  ];
}

/* -------------------------------------------------------------------------- *
 * Main
 * -------------------------------------------------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({ channel: options.channel });

  const newPage = async (context) => {
    const page = await context.newPage();
    page.on("pageerror", (error) => console.error("[pageerror]", error.message));
    return page;
  };

  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      locale: "en-US",
      // Noema honours this; it makes every capture the *resting* state of the
      // interface instead of a frame of an entrance animation. A texture that
      // was caught mid-transition is a texture with a half-faded block on it.
      reducedMotion: "reduce",
    });
    const page = await newPage(context);

    if (options.explore) {
      await login(page, options.base);
      for (const path of options.explore.split(",")) await explore(page, options.base, path.trim());
      return;
    }

    const all = textures(await demoContext());
    if (options.list) {
      for (const texture of all) console.log(texture.name.padEnd(20), texture.url);
      return;
    }
    const selected = options.only
      ? all.filter((texture) => texture.name.startsWith(options.only) || texture.name.includes(options.only))
      : all;
    if (selected.length === 0) throw new Error(`no texture matches ${options.only}`);

    // A partial run must not wipe the textures it is not re-capturing: `--only
    // db-` would otherwise delete the other thirty and leave the film with
    // missing pages.
    if (!options.only) {
      rmSync(OUT, { recursive: true, force: true });
      rmSync(CUT, { recursive: true, force: true });
    }
    mkdirSync(OUT, { recursive: true });
    mkdirSync(CUT, { recursive: true });

    // Signed-out surfaces need a context that has never logged in: `/` and
    // `/login` redirect into the workspace once a session cookie exists.
    const anonContext = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      locale: "en-US",
      reducedMotion: "reduce",
    });
    const anonPage = await newPage(anonContext);
    let loggedIn = false;

    const manifest = [];
    for (const texture of selected) {
      process.stdout.write(`  ${texture.name} … `);
      const target = texture.anonymous ? anonPage : page;
      if (!texture.anonymous && !loggedIn) {
        await login(page, options.base);
        loggedIn = true;
      }
      await target.setViewportSize(texture.viewport ?? VIEWPORT);
      await applyTheme(target, options.base, texture.theme ?? "light");
      await target.goto(`${options.base}${texture.url}`, { waitUntil: "domcontentloaded" });
      await settle(target);
      if (texture.setup) await texture.setup(target);

      // No forced scroll: a texture is whatever the viewport shows, and the
      // setup above may have scrolled deliberately (a settings section, a
      // sidebar section). Coordinates are resolved against the real scroll
      // position below.
      await target.waitForTimeout(400);

      const file = `${texture.name}.png`;
      await target.screenshot({ path: join(OUT, file), fullPage: Boolean(texture.fullPage) });

      const box = await target.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      }));
      // Coordinates are in **texture space** — CSS px from the top-left of the
      // captured image, which is what the camera and the fly-in shots read.
      // Playwright's `boundingBox()` is viewport-relative, so a full-page
      // capture adds the scroll offset and a viewport capture does not.
      const originX = texture.fullPage ? box.scrollX : 0;
      const originY = texture.fullPage ? box.scrollY : 0;
      const viewport = texture.viewport ?? VIEWPORT;
      const elements = {};
      for (const cutout of texture.cutouts ?? []) {
        const locator = target.locator(cutout.selector);
        const handles = cutout.all ? await locator.all() : [locator.first()];
        let index = 0;
        for (const handle of handles) {
          if ((await handle.count()) === 0) continue;
          const rect = await handle.boundingBox().catch(() => null);
          if (!rect) continue;
          const label = cutout.all ? `${cutout.name}-${index}` : cutout.name;
          const cutFile = `${texture.name}--${label}.png`;
          await handle.screenshot({ path: join(CUT, cutFile) }).catch(() => undefined);
          elements[label] = {
            x: Math.round(rect.x + originX),
            y: Math.round(rect.y + originY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            file: `cutouts/${cutFile}`,
          };
          index += 1;
        }
      }

      const layout = {
        name: texture.name,
        url: texture.url,
        theme: texture.theme ?? "light",
        fullPage: Boolean(texture.fullPage),
        scale: SCALE,
        viewport: { width: viewport.width, height: viewport.height },
        texture: {
          file: `textures/${file}`,
          width: viewport.width * SCALE,
          height: Math.round((texture.fullPage ? box.height : viewport.height) * SCALE),
        },
        page: { width: box.width, height: box.height },
        scroll: { x: box.scrollX, y: box.scrollY },
        elements,
      };
      writeFileSync(join(OUT, `${texture.name}.layout.json`), `${JSON.stringify(layout, null, 2)}\n`);
      manifest.push({ name: texture.name, url: texture.url, fullPage: layout.fullPage, elements: Object.keys(elements) });
      console.log(`ok (${Object.keys(elements).length} cutout(s))`);
    }

    writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\n${manifest.length} texture(s) → video/public/textures/`);
  } finally {
    await browser.close();
  }
}

/** The ids the seed minted, looked up by title — cuids cannot be written down. */
async function demoContext() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const pageId = async (title) =>
    (await prisma.page.findFirstOrThrow({ where: { title }, select: { id: true } })).id;
  try {
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: "demo-workspace" } });
    const versionPage = await prisma.pageVersion.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
      select: { pageId: true },
    });
    const commentPage = await prisma.comment.findFirstOrThrow({
      orderBy: { createdAt: "asc" },
      select: { pageId: true },
    });
    const tickets = await prisma.ticket.findMany({
      where: { workspaceId: workspace.id },
      select: { key: true, _count: { select: { comments: true, relations: true, activity: true } } },
    });
    const richest = tickets.sort(
      (a, b) =>
        b._count.comments + b._count.relations + b._count.activity -
        (a._count.comments + a._count.relations + a._count.activity),
    )[0];
    const row = await prisma.page.findFirstOrThrow({
      where: { parentId: await pageId("Product roadmap") },
      orderBy: { position: "asc" },
      select: { title: true },
    });
    return {
      slug: workspace.slug,
      pageId: await pageId("Getting started"),
      handbookId: await pageId("Company handbook"),
      roadmapId: await pageId("Product roadmap"),
      tasksId: await pageId("Task tracking"),
      contentId: await pageId("Content calendar"),
      rowTitle: row.title,
      ticketKey: richest?.key ?? "DW-1",
      projectId: (
        await prisma.project.findFirstOrThrow({
          where: { workspaceId: workspace.id },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        })
      ).id,
      chatId: (
        await prisma.chatThread.findFirstOrThrow({
          where: { workspaceId: workspace.id },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        })
      ).id,
      versionPageId: versionPage.pageId,
      commentPageId: commentPage.pageId,
      shareToken: (
        await prisma.shareLink.findFirstOrThrow({
          where: { page: { workspaceId: workspace.id } },
          select: { token: true },
        })
      ).token,
    };
  } finally {
    await prisma.$disconnect();
  }
}

await main();
