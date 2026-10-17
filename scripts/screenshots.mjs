/**
 * Feature gallery — captures the screenshots in `docs/screenshots/`.
 *
 *   npm run screenshots                 # every shot
 *   npm run screenshots -- --only db-   # by name prefix
 *   npm run screenshots -- --list       # names and captions, no browser
 *   npm run screenshots -- --explore /w/demo-workspace   # dump affordances
 *
 * Why a script instead of thirty hand-taken images: the gallery is part of the
 * repository, so it has to be reproducible. Whoever changes a surface runs this
 * against a seeded database and the README images move with the code.
 *
 * It drives the **installed Edge** (`channel: "msedge"`) rather than a
 * Playwright-managed Chromium: a ~150 MB browser download is a heavy
 * prerequisite for a task that is not part of CI, and every Windows and macOS
 * machine already has a browser. `--channel chromium` uses a managed one.
 *
 * Requires a seeded demo workspace (`npm run seed`) and a server on `--base`
 * (default `http://127.0.0.1:3200`, i.e. `npm start -- --port 3200`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "screenshots");

/** Login created by the demo seed. */
const DEMO = { email: "demo@noema.local", password: "password123" };

/** The viewport every shot is taken at, unless the shot overrides it. */
const DESKTOP = { width: 1440, height: 900 };

function parseArgs(argv) {
  const options = {
    base: "http://127.0.0.1:3200",
    channel: "msedge",
    only: null,
    explore: null,
    list: false,
    gallery: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") options.base = argv[++index];
    else if (arg === "--channel") options.channel = argv[++index];
    else if (arg === "--only") options.only = argv[++index];
    else if (arg === "--explore") options.explore = argv[++index];
    else if (arg === "--list") options.list = true;
    else if (arg === "--gallery") options.gallery = true;
  }
  return options;
}

/* -------------------------------------------------------------------------- *
 * Page helpers
 * -------------------------------------------------------------------------- */

/** Wait until the app has painted and stopped moving. */
async function settle(page, timeout = 1500) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // Covers and fonts land after `networkidle` often enough that a fixed settle is
  // worth more than a cleverer wait: a half-loaded cover image is exactly the
  // kind of thing nobody notices until it is published.
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

/** Click the first element matching `selector`, ignoring a miss. */
async function tap(page, selector, timeout = 6000) {
  const hit = page.locator(selector).first();
  await hit.click({ timeout }).catch(() => undefined);
  return hit;
}

/* -------------------------------------------------------------------------- *
 * Explore — dump a page's affordances so selectors are never guessed
 * -------------------------------------------------------------------------- */

async function explore(page, base, path) {
  await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  await settle(page, 2500);
  const info = await page.evaluate(() => {
    const text = (node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
    return {
      title: document.title,
      headings: [...document.querySelectorAll("h1, h2")].map(text),
      testids: [
        ...new Set([...document.querySelectorAll("[data-testid]")].map((n) => n.getAttribute("data-testid"))),
      ],
      buttons: [
        ...new Set(
          [...document.querySelectorAll("button")].map((n) => {
            const label = n.getAttribute("aria-label");
            const id = n.getAttribute("data-testid");
            return label ? `aria:${label}` : id ? `id:${id}` : `text:${text(n)}`;
          }),
        ),
      ],
      links: [...new Set([...document.querySelectorAll("a[href]")].map((n) => n.getAttribute("href")))],
    };
  });
  console.log(`\n=== ${path} ===`);
  console.log(JSON.stringify(info, null, 1));
}

/* -------------------------------------------------------------------------- *
 * Small interactions
 * -------------------------------------------------------------------------- */

/**
 * Point the session at `theme` before the next navigation.
 *
 * Both halves are needed: the cookie is what the server renders (`defaultTheme`)
 * and `localStorage` is what next-themes applies on mount, and the library
 * prefers storage. Setting only one leaves a first-paint flash — or, worse, a
 * light screenshot of a dark session.
 *
 * It has to run for **every** shot, not just the dark one: a theme is a
 * preference, so once `04-home-dark` has written `dark` the setting would ride
 * along and every later screenshot would come out dark.
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

/** Pick a database view by the label on its tab (`Table`, `Board`, …). */
async function pickView(page, label) {
  await tap(page, `button:has-text("${label}")`);
  await page.waitForTimeout(1400);
}

/** Pick a tickets view through its segmented control. */
async function pickTicketsView(page, view) {
  await tap(page, `[data-testid="segmented-option-${view}"]`);
  await page.waitForTimeout(1200);
}

/** Scroll the nearest scrollable ancestor so `selector` is in view. */
async function scrollTo(page, selector) {
  await page
    .locator(selector)
    .first()
    .evaluate((node) => {
      node.scrollIntoView({ block: "center", behavior: "instant" });
    })
    .catch(() => undefined);
  await page.waitForTimeout(700);
}

/* -------------------------------------------------------------------------- *
 * The gallery
 * -------------------------------------------------------------------------- */

/**
 * `ctx` carries the ids the seed minted — they are cuids, so they cannot be
 * written down. Everything else is a route.
 *
 * A shot is `{ name, caption, url, setup?, fullPage?, viewport?, theme?,
 * anonymous? }`. `anonymous` means "only exists for a signed-out visitor": those
 * are captured in a context that has never logged in.
 */
function shots(ctx) {
  const w = `/w/${ctx.slug}`;
  return [
    { name: "01-landing", caption: "The public landing page", url: "/", fullPage: true, anonymous: true },
    {
      name: "02-login",
      caption: "Sign in — email, password, remember-me",
      url: "/login",
      anonymous: true,
    },
    {
      name: "03-home",
      caption: "Workspace home — quick starts and the template gallery",
      url: w,
      setup: (page) => waitFor(page, '[data-testid="template-preview"]'),
    },
    {
      name: "04-home-dark",
      caption: "The same home in dark mode",
      url: w,
      theme: "dark",
      setup: (page) => waitFor(page, '[data-testid="template-preview"]'),
    },
    {
      name: "05-sidebar",
      caption: "Sidebar — favourites, pages, teamspaces, projects, tickets",
      url: `${w}/${ctx.pageId}`,
    },
    {
      name: "06-editor",
      caption: "The block editor — headings, callouts, toggles, code, tables, backlinks",
      url: `${w}/${ctx.handbookId}`,
      setup: (page) => scrollTo(page, "h1"),
    },
    {
      name: "07-slash-menu",
      caption: "The slash menu",
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
      name: "08-command-palette",
      caption: "Command palette (Ctrl/⌘ K)",
      url: `${w}/${ctx.pageId}`,
      setup: async (page) => {
        await page.keyboard.press("Control+k");
        await page.waitForTimeout(700);
      },
    },
    {
      name: "09-quick-find",
      caption: "Quick find (Ctrl/⌘ P)",
      url: `${w}/${ctx.pageId}`,
      setup: async (page) => {
        await page.keyboard.press("Control+p");
        await page.waitForTimeout(900);
      },
    },
    {
      name: "10-shortcuts",
      caption: "Keyboard shortcuts — the same dialog the desktop menu opens",
      url: `${w}/${ctx.pageId}`,
      setup: async (page) => {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("noema:shell:shortcuts")));
        await page.waitForTimeout(700);
      },
    },
    {
      name: "11-db-table",
      caption: "Database — table view with relations, a rollup and a percent property",
      url: `${w}/${ctx.roadmapId}`,
    },
    {
      name: "12-db-board",
      caption: "Database — board view grouped by status",
      url: `${w}/${ctx.roadmapId}`,
      setup: (page) => pickView(page, "Board"),
    },
    {
      name: "13-db-timeline",
      caption: "Database — timeline view",
      url: `${w}/${ctx.roadmapId}`,
      setup: (page) => pickView(page, "Timeline"),
    },
    {
      name: "14-db-chart",
      caption: "Database — chart view",
      url: `${w}/${ctx.roadmapId}`,
      setup: (page) => pickView(page, "By status"),
    },
    {
      name: "15-db-list",
      caption: "Database — list view",
      url: `${w}/${ctx.roadmapId}`,
      setup: (page) => pickView(page, "List"),
    },
    {
      name: "16-db-calendar",
      caption: "Database — calendar view",
      url: `${w}/${ctx.tasksId}`,
      setup: (page) => pickView(page, "Calendar"),
    },
    {
      name: "17-db-gallery",
      caption: "Database — gallery view with cover images",
      url: `${w}/${ctx.contentId}`,
      setup: (page) => pickView(page, "Gallery"),
    },
    {
      name: "18-row-peek",
      caption: "A row, opened in the side peek",
      url: `${w}/${ctx.roadmapId}`,
      setup: async (page) => {
        await tap(page, `button[aria-label="Open side peek: ${ctx.rowTitle}"]`);
        await waitFor(page, '[data-testid="peek-drawer"]');
      },
    },
    { name: "19-tickets-list", caption: "Tickets — list view with filters and saved views", url: `${w}/tickets` },
    {
      name: "20-tickets-board",
      caption: "Tickets — board view",
      url: `${w}/tickets`,
      setup: (page) => pickTicketsView(page, "board"),
    },
    {
      name: "21-tickets-timeline",
      caption: "Tickets — timeline view",
      url: `${w}/tickets`,
      setup: (page) => pickTicketsView(page, "timeline"),
    },
    {
      name: "22-ticket-drawer",
      caption: "A ticket — description, activity, comments and linked work",
      url: `${w}/tickets`,
      setup: async (page) => {
        await tap(page, `button:has-text("${ctx.ticketKey}")`);
        await page.waitForTimeout(1600);
      },
    },
    { name: "23-cycles", caption: "Cycles — burndown, scope and progress", url: `${w}/cycles` },
    { name: "24-projects", caption: "Projects — progress, owners and target dates", url: `${w}/projects` },
    { name: "25-project", caption: "A project — milestones and linked tickets", url: `${w}/projects/${ctx.projectId}` },
    { name: "26-library", caption: "Library — every database in the workspace", url: `${w}/library` },
    { name: "27-search", caption: "Search — full text, scoped to what you can see", url: `${w}/search?q=editor` },
    { name: "28-inbox", caption: "Inbox — mentions, comments and updates", url: `${w}/inbox` },
    {
      name: "29-chat",
      caption: "Chat — a workspace conversation, with the notes it cites",
      url: `${w}?chat=${ctx.chatId}`,
      setup: async (page) => {
        await page.waitForTimeout(1800);
      },
    },
    {
      name: "30-comments",
      caption: "Comments and page discussion",
      url: `${w}/${ctx.commentPageId}`,
      setup: async (page) => {
        await tap(page, 'button:has-text("Add a comment")');
        await page.waitForTimeout(1000);
      },
    },
    {
      name: "31-versions",
      caption: "Version history — every save, restorable",
      url: `${w}/${ctx.versionPageId}`,
      setup: async (page) => {
        await tap(page, 'button:has-text("Version history")');
        await page.waitForTimeout(1200);
      },
    },
    {
      name: "32-share",
      caption: "Share — public link, permissions and export",
      url: `${w}/${ctx.pageId}`,
      setup: async (page) => {
        await tap(page, 'button[aria-label="Share"]');
        await page.waitForTimeout(1000);
      },
    },
    { name: "33-public-page", caption: "A published page, as a visitor sees it", url: `/s/${ctx.shareToken}`, fullPage: true },
    { name: "34-templates", caption: "Templates — saved templates and the built-in library", url: `${w}/templates` },
    { name: "35-roadmap", caption: "Roadmap — the workspace-level timeline", url: `${w}/roadmap` },
    { name: "36-audit", caption: "Audit log — who changed what", url: `${w}/audit` },
    { name: "37-trash", caption: "Trash — restore, or delete for good", url: `${w}/trash` },
    { name: "38-settings", caption: "Settings — general, members, roles and invites", url: `${w}/settings` },
    { name: "39-settings-tokens", caption: "Settings — API tokens", url: `${w}/settings/tokens` },
    { name: "40-settings-data", caption: "Settings — data, export and privacy", url: `${w}/settings/data` },
    { name: "41-settings-prompts", caption: "Settings — the prompt library", url: `${w}/settings/prompts` },
    { name: "42-settings-notifications", caption: "Settings — notification preferences", url: `${w}/settings/notifications` },
    {
      name: "43-mobile-editor",
      caption: "The same page on a phone viewport",
      url: `${w}/${ctx.handbookId}`,
      viewport: { width: 390, height: 844 },
    },
    {
      // Reached through Help → About in the desktop menu. The listener is
      // attached in the browser too, so dispatching the same window event the
      // shell bridge emits proves the wiring without a Tauri build.
      name: "44-about",
      caption: "About — version, credits and licence, from Help → About",
      url: `${w}`,
      setup: async (page) => {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("noema:shell:about")));
        await page.waitForTimeout(700);
      },
    },
  ];
}

/** Wait for a selector without failing the run when it never arrives. */
async function waitFor(page, selector, timeout = 15_000) {
  await page.waitForSelector(selector, { timeout }).catch(() => undefined);
}

/* -------------------------------------------------------------------------- *
 * docs/GALLERY.md
 * -------------------------------------------------------------------------- */

const GALLERY_FILE = join(ROOT, "docs", "GALLERY.md");
const GALLERY_START = "<!-- gallery:start -->";
const GALLERY_END = "<!-- gallery:end -->";

/**
 * Rewrite the region between the markers in `docs/GALLERY.md` from a report.
 *
 * The captions are written in `shots()` above, next to the selectors that take
 * the picture; a second, hand-maintained copy in the docs is a caption that is
 * wrong the next time a surface changes. Everything outside the markers — the
 * prose, the regeneration instructions — is left exactly as written.
 */
function writeGallery(report) {
  let current;
  try {
    current = readFileSync(GALLERY_FILE, "utf8");
  } catch {
    console.log("no docs/GALLERY.md to update — skipping the gallery table");
    return;
  }
  const start = current.indexOf(GALLERY_START);
  const end = current.indexOf(GALLERY_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`docs/GALLERY.md is missing the ${GALLERY_START} / ${GALLERY_END} markers`);
  }

  const body = report
    .map(
      (shot) =>
        `### ${shot.name}\n\n${shot.caption}\n\n` +
        `![${shot.caption}](./screenshots/${shot.name}.png)\n`,
    )
    .join("\n");

  const next =
    current.slice(0, start + GALLERY_START.length) +
    `\n\n${body}\n` +
    current.slice(end);
  writeFileSync(GALLERY_FILE, next);
  console.log(`docs/GALLERY.md updated (${report.length} image(s))`);
}

/* -------------------------------------------------------------------------- *
 * Main
 * -------------------------------------------------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({ channel: options.channel });
  const context = await browser.newContext({
    viewport: DESKTOP,
    deviceScaleFactor: 1,
    locale: "en-US",
    // The app pins a strict CSP; a console error here is worth seeing, not
    // swallowing — a blocked script is why a shot would come out half-drawn.
    bypassCSP: false,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("[pageerror]", error.message));

  try {
    if (options.explore) {
      await login(page, options.base);
      for (const path of options.explore.split(",")) await explore(page, options.base, path.trim());
      return;
    }

    // `--gallery` only rewrites the list from the last run's report: no browser
    // and no database needed, so it is checked before anything is connected to.
    if (options.gallery) {
      writeGallery(JSON.parse(readFileSync(join(OUT, "report.json"), "utf8")));
      return;
    }

    const all = shots(await demoContext());
    if (options.list) {
      for (const shot of all) console.log(`${shot.name.padEnd(26)} ${shot.caption}`);
      return;
    }
    const selected = options.only
      ? all.filter((shot) => shot.name.startsWith(options.only) || shot.name.includes(options.only))
      : all;
    if (selected.length === 0) throw new Error(`no shot matches ${options.only}`);

    mkdirSync(OUT, { recursive: true });

    const report = [];
    const capture = async (target, shot) => {
      process.stdout.write(`  ${shot.name} … `);
      await target.setViewportSize(shot.viewport ?? DESKTOP);
      await applyTheme(target, options.base, shot.theme ?? "light");
      await target.goto(`${options.base}${shot.url}`, { waitUntil: "domcontentloaded" });
      await settle(target);
      if (shot.setup) await shot.setup(target);

      await target.screenshot({
        path: join(OUT, `${shot.name}.png`),
        fullPage: Boolean(shot.fullPage),
      });
      const heading = await target.locator("h1, h2").first().textContent().catch(() => null);
      report.push({
        name: shot.name,
        caption: shot.caption,
        url: shot.url,
        title: await target.title(),
        heading: (heading ?? "").trim().slice(0, 120),
        file: `docs/screenshots/${shot.name}.png`,
      });
      console.log("ok");
    };

    // Signed-out shots first, in a context that has never logged in. `/` and
    // `/login` both redirect to the workspace once a session cookie exists, so
    // capturing them after the login produced two images captioned "landing
    // page" and "sign in" that both showed the workspace home.
    const anonymous = selected.filter((shot) => shot.anonymous);
    if (anonymous.length > 0) {
      const anonContext = await browser.newContext({
        viewport: DESKTOP,
        deviceScaleFactor: 1,
        locale: "en-US",
      });
      const anonPage = await anonContext.newPage();
      anonPage.on("pageerror", (error) => console.error("[pageerror]", error.message));
      console.log(`${anonymous.length} signed-out shot(s)`);
      for (const shot of anonymous) await capture(anonPage, shot);
      await anonContext.close();
    }

    const authed = selected.filter((shot) => !shot.anonymous);
    if (authed.length > 0) {
      await login(page, options.base);
      console.log(`logged in as ${DEMO.email} · ${authed.length} shot(s)`);
      for (const shot of authed) await capture(page, shot);
    }

    // Ordered by name, so the gallery reads 01…44 whichever context captured
    // which shot — and so `--only` still writes a file the docs can render.
    report.sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeGallery(report);
    console.log(`\n${report.length} screenshot(s) → docs/screenshots/`);
  } finally {
    await browser.close();
  }
}

/**
 * The ids the seed minted, looked up by title. Connecting to the database is the
 * only way to address a page: the ids are cuids and every route needs one.
 */
async function demoContext() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const pageId = async (title) =>
    (
      await prisma.page.findFirstOrThrow({ where: { title }, select: { id: true } })
    ).id;
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
    // The richest ticket, so the drawer shows comments, activity and links
    // rather than an empty shell.
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
      where: { parentId: (await pageId("Product roadmap")) },
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
