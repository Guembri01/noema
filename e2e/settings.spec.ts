import { expect, test, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * B93 — settings surfaces (coverage gap: settings):
 *  (a) API tokens: create -> the plaintext is shown once AND the token shows up
 *      in the list -> revoke removes it (UI + database),
 *  (b) ticket labels: create -> edit (rename via blur-save) -> delete,
 *  (c) language switch persists across a reload (asserted on known translated
 *      strings inside #main),
 *  (d) theme toggle persists across a reload.
 *
 * Discipline:
 *  - dedicated prisma rows prefixed "B93 " with try/finally cleanup, plus an
 *    afterAll backstop - never the shared first page / demo rows,
 *  - content locators scoped to `#main` so the sidebar cannot satisfy them,
 *  - the two controls that genuinely live in the sidebar (the #locale select and
 *    the theme picker) are addressed by id / exact accessible name,
 *  - demo account (demo@noema.local): its locale is restored to "en"
 *    in every finally AND in afterAll, so a crashed run cannot poison other runs.
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };
const WORKSPACE_SLUG = "demo-workspace";
const PREFIX = "B93";

const prisma = new PrismaClient();

// The dev server is shared with concurrent suites; give navigations room.
test.describe.configure({ timeout: 120_000 });
test.use({ navigationTimeout: 60_000, actionTimeout: 30_000 });

test.afterAll(async () => {
  // Backstops: even a killed test must not leave rows or a locale behind.
  await prisma.user
    .updateMany({ where: { email: CREDENTIALS.email }, data: { locale: "en" } })
    .catch(() => {});
  await prisma.apiToken
    .deleteMany({ where: { name: { startsWith: PREFIX } } })
    .catch(() => {});
  await prisma.label
    .deleteMany({ where: { name: { startsWith: PREFIX } } })
    .catch(() => {});
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(CREDENTIALS.email);
  await page.getByRole("textbox", { name: "Password" }).fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//);
}

/**
 * Deterministic hydration signal: React attaches `__reactFiber$`/`__reactProps$`
 * keys to host nodes when it takes over from the server HTML. Interacting before
 * that point only writes to the DOM (see e2e/descriptions.spec.ts).
 */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((key) => key.startsWith("__react"));
    },
    selector,
    { timeout: 30_000 },
  );
}

const main = (page: Page): Locator => page.locator("#main");

/** The settings section that owns `heading` (h2), scoped to #main. */
const section = (page: Page, heading: string): Locator =>
  main(page).locator("section", {
    has: main(page).getByRole("heading", { name: heading, exact: true }),
  });

async function demoLocale(): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { email: CREDENTIALS.email },
    select: { locale: true },
  });
  return user?.locale ?? null;
}

async function countTokens(name: string): Promise<number> {
  return prisma.apiToken.count({ where: { name } });
}

async function countLabels(name: string): Promise<number> {
  return prisma.label.count({ where: { name } });
}

/**
 * Open workspace settings on the demo account and make the run independent of
 * whatever locale the last (possibly crashed) run left behind.
 */
async function openSettings(page: Page) {
  await page.goto(`/w/${WORKSPACE_SLUG}/settings`);
  await waitForHydration(page, "#locale");
  if ((await page.locator("#locale").inputValue()) !== "en") {
    await page.locator("#locale").selectOption("en");
    await expect.poll(demoLocale, { timeout: 15_000 }).toBe("en");
    await page.reload();
    await waitForHydration(page, "#locale");
  }
  await expect(
    main(page).getByRole("heading", { name: "Workspace settings", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("settings surfaces", () => {
  test("api token: create shows it once, revoke removes it", async ({ page }) => {
    await signIn(page);
    const name = `${PREFIX} token ${Date.now()}`;

    try {
      await openSettings(page);
      const tokens = section(page, "API tokens");
      await waitForHydration(page, 'input[aria-label="Token name"]');

      // Create -> plaintext shown exactly once.
      await tokens.getByLabel("Token name").fill(name);
      await tokens.getByRole("button", { name: "Create token", exact: true }).click();
      await expect(
        tokens.getByText(/Copy this token now/),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        tokens.locator("code").filter({ hasText: /^noema_/ }),
      ).toBeVisible();

      // …and the token appears in the list (+ row lands in the database).
      const row = tokens.getByRole("listitem").filter({ hasText: name });
      await expect(row).toHaveCount(1, { timeout: 20_000 });
      await expect.poll(() => countTokens(name), { timeout: 20_000 }).toBe(1);

      // Revoke -> gone from the list and from the database.
      await row.getByRole("button", { name: "Revoke token", exact: true }).click();
      await expect(row).toHaveCount(0, { timeout: 20_000 });
      await expect.poll(() => countTokens(name), { timeout: 20_000 }).toBe(0);
    } finally {
      await prisma.apiToken.deleteMany({ where: { name } }).catch(() => {});
    }
  });

  test("label: create, rename and delete", async ({ page }) => {
    await signIn(page);
    const stamp = Date.now();
    const name = `${PREFIX} label ${stamp}`;
    const renamed = `${PREFIX} label ${stamp} v2`;

    try {
      await openSettings(page);
      const labels = section(page, "Ticket labels");
      await waitForHydration(page, 'input[aria-label="Label name"]');

      // Create.
      await labels.getByLabel("Label name").fill(name);
      await labels.getByRole("button", { name: "Create", exact: true }).click();
      const row = labels.getByRole("listitem").filter({ hasText: name });
      await expect(row).toHaveCount(1, { timeout: 20_000 });
      await expect.poll(() => countLabels(name), { timeout: 20_000 }).toBe(1);

      // Edit: the rename input saves on blur.
      const renameField = labels.getByLabel(`Rename ${name}`);
      await renameField.fill(renamed);
      await renameField.press("Tab");
      await expect(
        labels.getByRole("listitem").filter({ hasText: renamed }),
      ).toHaveCount(1, { timeout: 20_000 });
      await expect.poll(() => countLabels(renamed), { timeout: 20_000 }).toBe(1);
      await expect.poll(() => countLabels(name), { timeout: 20_000 }).toBe(0);

      // Delete.
      await labels
        .getByRole("button", { name: `Delete ${renamed}`, exact: true })
        .click();
      await expect(
        labels.getByRole("listitem").filter({ hasText: renamed }),
      ).toHaveCount(0, { timeout: 20_000 });
      await expect.poll(() => countLabels(renamed), { timeout: 20_000 }).toBe(0);
    } finally {
      await prisma.label
        .deleteMany({ where: { name: { in: [name, renamed] } } })
        .catch(() => {});
    }
  });

  test("language switch persists across a reload", async ({ page }) => {
    await signIn(page);

    try {
      await openSettings(page);
      // English baseline inside #main.
      await expect(
        main(page).getByRole("heading", { name: "Workspace settings", exact: true }),
      ).toBeVisible();

      // The #locale select lives in the sidebar footer (outside #main by design).
      await page.locator("#locale").selectOption("de");
      await expect.poll(demoLocale, { timeout: 15_000 }).toBe("de");

      // Reload: the preference was written server-side, so the whole settings
      // surface comes back translated (ASCII-safe German copy).
      await page.reload();
      await waitForHydration(page, "#locale");
      await expect(page.locator("#locale")).toHaveValue("de");
      await expect(
        main(page).getByRole("heading", { name: "Workspace-Einstellungen", exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        main(page).getByRole("heading", { name: "API-Token", exact: true }),
      ).toBeVisible();
      await expect(
        main(page).getByRole("heading", { name: "Workspace settings", exact: true }),
      ).toHaveCount(0);
    } finally {
      // Leave the demo account (and every later test) in English.
      await page.locator("#locale").selectOption("en").catch(() => {});
      await expect.poll(demoLocale, { timeout: 20_000 }).toBe("en");
    }
  });

  test("theme toggle persists across a reload", async ({ page }) => {
    await signIn(page);
    await openSettings(page);

    // Fresh context => next-themes default (light); nothing dark yet.
    await expect(page.locator("html.dark")).toHaveCount(0);

    // Sidebar theme picker (Radix DropdownMenu), addressed by exact name now
    // that the locale is known to be English.
    const trigger = page.getByRole("button", { name: "Theme", exact: true });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Dark", exact: true }).click();

    await expect(page.locator("html.dark")).toHaveCount(1, { timeout: 15_000 });
    expect(await page.evaluate(() => window.localStorage.getItem("theme"))).toBe(
      "dark",
    );

    // Survives a reload (localStorage + class attribute), and the settings
    // content still renders scoped to #main.
    await page.reload();
    await expect(page.locator("html.dark")).toHaveCount(1, { timeout: 30_000 });
    expect(await page.evaluate(() => window.localStorage.getItem("theme"))).toBe(
      "dark",
    );
    await expect(
      main(page).getByRole("heading", { name: "Workspace settings", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
