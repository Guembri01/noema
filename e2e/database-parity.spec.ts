import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * B15 — database view family parity:
 *  (a) a long-tail filter operator narrows the table,
 *  (b) two sorts are active at once and the visible order proves both,
 *  (c) show/hide properties + filters persist across a reload (per-view config),
 *  (d) duplicating a view creates a copy carrying the configuration,
 *  (e) a deleted row is restorable from the database's "Deleted rows" panel,
 *  (f) the active view tab survives a reload.
 *
 * Every test builds its own database through prisma and removes it in a
 * `finally` block — never the shared first page (e2e discipline).
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };

const prisma = new PrismaClient();

// A cold dev server compiles routes on demand and other suites share it, so
// the per-test budget is deliberately generous (the config is 60s).
test.describe.configure({ timeout: 120_000 });

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  // The dev server is shared: it can be restarting under us (another suite's
  // Tier HEAVY build), so sign-in is retried instead of failing the test.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto("/login", { timeout: 60_000 });
      await page.getByLabel("Email").fill(CREDENTIALS.email);
      await page.getByRole("textbox", { name: "Password" }).fill(CREDENTIALS.password);
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

/**
 * Deterministic hydration signal: React attaches `__reactFiber$`/`__reactProps$`
 * keys to host nodes when it takes over from the server HTML. Clicking before
 * that point writes to the DOM and is thrown away on takeover.
 *
 * A cold dev server compiles the route on the first hit and other suites
 * restart it, so the wait retries with a reload instead of failing outright.
 */
async function waitForHydration(page: Page, selector: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return !!el && Object.keys(el).some((key) => key.startsWith("__react"));
        },
        selector,
        { timeout: 45_000 },
      );
      return;
    } catch (error) {
      lastError = error;
      await page.reload({ timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(3_000);
    }
  }
  throw lastError;
}

type Fixture = {
  pageId: string;
  tableViewId: string;
  propertyIds: { name: string; estimate: string; due: string; status: string };
  rowIds: { alpha: string; beta: string; gamma: string };
};

async function workspaceAndOwner() {
  const workspace = await prisma.workspace.findFirst({
    where: { slug: "demo-workspace" },
    select: { id: true },
  });
  const owner = await prisma.user.findUnique({
    where: { email: CREDENTIALS.email },
    select: { id: true },
  });
  if (!workspace || !owner) throw new Error("demo workspace/user not seeded");
  return { workspace, owner };
}

/**
 * A dedicated database: Name (primary), Estimate, Due, Status; a Table and a
 * Board view; three rows whose values are chosen so that one sort is not
 * enough to produce the expected order (Alpha/Beta tie on Estimate).
 */
async function createDatabase(): Promise<Fixture> {
  const { workspace, owner } = await workspaceAndOwner();

  const db = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      type: "DATABASE",
      title: `B15 database ${Date.now()}`,
      createdById: owner.id,
      position: 900_000,
    },
    select: { id: true },
  });

  const name = await prisma.property.create({
    data: { databasePageId: db.id, name: "Name", type: "TEXT", position: 1000, config: { primary: true } },
    select: { id: true },
  });
  const estimate = await prisma.property.create({
    data: { databasePageId: db.id, name: "Estimate", type: "NUMBER", position: 2000 },
    select: { id: true },
  });
  const due = await prisma.property.create({
    data: { databasePageId: db.id, name: "Due", type: "DATE", position: 3000 },
    select: { id: true },
  });
  const status = await prisma.property.create({
    data: {
      databasePageId: db.id,
      name: "Status",
      type: "STATUS",
      position: 4000,
      config: {
        options: [
          { id: "todo", name: "To-do", color: "gray" },
          { id: "done", name: "Done", color: "green" },
        ],
      },
    },
    select: { id: true },
  });

  const table = await prisma.databaseView.create({
    data: { databasePageId: db.id, name: "Table", type: "TABLE", position: 1000 },
    select: { id: true },
  });
  await prisma.databaseView.create({
    data: {
      databasePageId: db.id,
      name: "Board",
      type: "BOARD",
      position: 2000,
      config: { groupByPropertyId: status.id },
    },
  });

  const rows = [
    { key: "alpha", title: "B15 Alpha", position: 1000, estimate: 5, due: "2026-03-01", status: "todo" },
    { key: "beta", title: "B15 Beta", position: 2000, estimate: 5, due: "2026-01-15", status: "done" },
    { key: "gamma", title: "B15 Gamma", position: 3000, estimate: 9, due: null, status: "todo" },
  ] as const;

  const rowIds = { alpha: "", beta: "", gamma: "" };
  for (const row of rows) {
    const page = await prisma.page.create({
      data: {
        workspaceId: workspace.id,
        parentId: db.id,
        title: row.title,
        createdById: owner.id,
        position: row.position,
      },
      select: { id: true },
    });
    await prisma.propertyValue.createMany({
      data: [
        { propertyId: estimate.id, pageId: page.id, value: { number: row.estimate } },
        { propertyId: status.id, pageId: page.id, value: { optionId: row.status } },
        ...(row.due
          ? [{ propertyId: due.id, pageId: page.id, value: { start: row.due } }]
          : []),
      ],
    });
    rowIds[row.key] = page.id;
  }

  return {
    pageId: db.id,
    tableViewId: table.id,
    propertyIds: { name: name.id, estimate: estimate.id, due: due.id, status: status.id },
    rowIds,
  };
}

/** Remove the fixture (rows, properties, views and values cascade). */
async function destroyDatabase(pageId: string) {
  await prisma.page.deleteMany({ where: { id: pageId } }).catch(() => {});
}

/** Navigate with retries: the shared dev server may be mid-restart. */
async function gotoWithRetry(page: Page, url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(url, { timeout: 60_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(5_000);
    }
  }
  throw lastError;
}

/** Reload with retries (same reason as `gotoWithRetry`). */
async function reloadPage(page: Page) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.reload({ timeout: 60_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(5_000);
    }
  }
  throw lastError;
}

async function openDatabase(page: Page, pageId: string) {
  await signIn(page);
  await gotoWithRetry(page, `/w/demo-workspace/${pageId}`);
  await waitForHydration(page, '[aria-label="Add a view"]');
}

/** The primary column cells, in visible row order. */
const nameCells = (page: Page) => page.locator('tbody input[aria-label="Name"]');

const visibleOrder = async (page: Page) => {
  const values: string[] = [];
  const count = await nameCells(page).count();
  for (let index = 0; index < count; index += 1) {
    values.push(await nameCells(page).nth(index).inputValue());
  }
  return values;
};

type StoredConfig = {
  filters?: { propertyId?: string; operator?: string; value?: string }[];
  sorts?: { propertyId?: string; direction?: string }[];
  visiblePropertyIds?: string[];
};

/** The view configuration as the database actually holds it. */
async function storedConfig(fixture: Fixture): Promise<StoredConfig> {
  const view = await prisma.databaseView.findUnique({
    where: { id: fixture.tableViewId },
    select: { config: true },
  });
  return JSON.parse(JSON.stringify(view?.config ?? {})) as StoredConfig;
}

/**
 * Assert that the server eventually holds `check(config)`, re-running `act`
 * between polls. The dev server hot-reloads while other suites edit files,
 * and a single swallowed update must not read as a feature failure — the
 * retry is idempotent (the UI dedupes filter/sort rows by property+operator).
 */
async function pollConfig(
  fixture: Fixture,
  check: (config: StoredConfig) => boolean,
  act?: () => unknown | Promise<unknown>,
) {
  await expect
    .poll(
      async () => {
        const config = await storedConfig(fixture);
        if (check(config)) return true;
        if (act) await act();
        return false;
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe(true);
}

test.describe("database parity", () => {
  test("filters with a long-tail operator (starts with)", async ({ page }) => {
    const fixture = await createDatabase();
    try {
      await openDatabase(page, fixture.pageId);
      await expect(nameCells(page)).toHaveCount(3);

      await page.getByTestId("filter-trigger").click();
      const popover = page.getByTestId("db-filter-popover");
      await expect(popover).toBeVisible();

      const propertySelect = popover.getByTestId("filter-property");
      const operatorSelect = popover.getByTestId("filter-operator");
      const valueInput = popover.getByTestId("filter-value");

      // Every step is asserted against the stored configuration: the shared
      // dev server hot-reloads while other suites edit, and one swallowed
      // update must not read as a feature failure (the retry is idempotent).
      await pollConfig(fixture, (c) => (c.filters?.length ?? 0) >= 1, () =>
        popover.getByTestId("add-filter").click(),
      );
      await expect(page.getByRole("button", { name: "Filter (1)" })).toBeVisible();

      await propertySelect.selectOption(fixture.propertyIds.name);
      await pollConfig(
        fixture,
        (c) => c.filters?.[0]?.propertyId === fixture.propertyIds.name,
        () => propertySelect.selectOption(fixture.propertyIds.name),
      );
      // Wait for the browser to re-render with the stored value too: the next
      // write is built from these props, so acting on a stale select would
      // revert the property we just changed.
      await expect(propertySelect).toHaveValue(fixture.propertyIds.name);
      await operatorSelect.selectOption("starts_with");
      await pollConfig(
        fixture,
        (c) => c.filters?.[0]?.operator === "starts_with",
        () => operatorSelect.selectOption("starts_with"),
      );
      await expect(operatorSelect).toHaveValue("starts_with");
      await valueInput.fill("B15 B");
      await pollConfig(
        fixture,
        (c) => (c.filters?.[0]?.value ?? "").toLowerCase() === "b15 b",
        () => valueInput.fill("B15 B"),
      );
      await expect(valueInput).toHaveValue("B15 B");

      // Render straight from the persisted configuration.
      await reloadPage(page);
      await waitForHydration(page, '[aria-label="Add a view"]');
      await expect(nameCells(page)).toHaveCount(1);
      await expect(nameCells(page).first()).toHaveValue("B15 Beta");
      await expect(page.locator("table")).not.toContainText("B15 Alpha");
      await expect(page.locator("table")).not.toContainText("B15 Gamma");
      await expect(page.getByRole("button", { name: "Filter (1)" })).toBeVisible();
      // The first column is pinned while the table scrolls horizontally.
      await expect(page.locator("thead th").first()).toHaveCSS("position", "sticky");
    } finally {
      await destroyDatabase(fixture.pageId);
    }
  });

  test("applies two sorts and shows the order both keys produce", async ({
    page,
  }) => {
    const fixture = await createDatabase();
    try {
      await openDatabase(page, fixture.pageId);
      await expect(nameCells(page)).toHaveCount(3);

      await page.getByTestId("sort-trigger").click();
      const popover = page.getByTestId("db-sort-popover");
      await expect(popover).toBeVisible();

      // Key 1: Estimate, descending.
      await pollConfig(fixture, (c) => (c.sorts?.length ?? 0) >= 1, () =>
        popover.getByTestId("add-sort").click(),
      );
      await expect(page.getByRole("button", { name: "Sort (1)" })).toBeVisible();
      await popover.getByTestId("sort-direction").first().selectOption("desc");
      await pollConfig(
        fixture,
        (c) => c.sorts?.[0]?.direction === "desc",
        () => popover.getByTestId("sort-direction").first().selectOption("desc"),
      );
      // The browser must show the new direction before the next write is
      // composed from these props (otherwise it reverts to "asc").
      await expect(popover.getByTestId("sort-direction").first()).toHaveValue("desc");

      // Key 2: the next unused property (Due), ascending — breaks the tie.
      await pollConfig(fixture, (c) => (c.sorts?.length ?? 0) >= 2, () =>
        popover.getByTestId("add-sort").click(),
      );
      await expect(page.getByRole("button", { name: "Sort (2)" })).toBeVisible();

      // Render straight from the persisted configuration: two sort keys are
      // offered, the second one is Due ascending…
      await reloadPage(page);
      await waitForHydration(page, '[aria-label="Add a view"]');
      await expect(page.getByRole("button", { name: "Sort (2)" })).toBeVisible();
      await page.getByTestId("sort-trigger").click();
      const reopened = page.getByTestId("db-sort-popover");
      await expect(reopened.getByTestId("sort-property")).toHaveCount(2);
      await expect(reopened.getByTestId("sort-property").nth(1)).toHaveValue(
        fixture.propertyIds.due,
      );
      await expect(reopened.getByTestId("sort-direction").nth(1)).toHaveValue("asc");

      // …and the visible order needs both keys: Estimate desc puts Gamma
      // first, Alpha/Beta tie at 5 and Due asc decides between them.
      await expect
        .poll(() => visibleOrder(page), { timeout: 15_000 })
        .toEqual(["B15 Gamma", "B15 Beta", "B15 Alpha"]);
    } finally {
      await destroyDatabase(fixture.pageId);
    }
  });

  test("persists show/hide properties and filters across a reload", async ({
    page,
  }) => {
    const fixture = await createDatabase();
    try {
      await openDatabase(page, fixture.pageId);
      await expect(nameCells(page)).toHaveCount(3);

      // Filter: Name contains "Beta" → one row.
      await page.getByTestId("filter-trigger").click();
      const filterPopover = page.getByTestId("db-filter-popover");
      await expect(filterPopover).toBeVisible();
      const filterProperty = filterPopover.getByTestId("filter-property");
      const filterValue = filterPopover.getByTestId("filter-value");
      await pollConfig(fixture, (c) => (c.filters?.length ?? 0) >= 1, () =>
        filterPopover.getByTestId("add-filter").click(),
      );
      await expect(page.getByRole("button", { name: "Filter (1)" })).toBeVisible();
      await filterProperty.selectOption(fixture.propertyIds.name);
      await pollConfig(
        fixture,
        (c) => c.filters?.[0]?.propertyId === fixture.propertyIds.name,
        () => filterProperty.selectOption(fixture.propertyIds.name),
      );
      await expect(filterProperty).toHaveValue(fixture.propertyIds.name);
      await filterValue.fill("Beta");
      await pollConfig(
        fixture,
        (c) => (c.filters?.[0]?.value ?? "") === "Beta",
        () => filterValue.fill("Beta"),
      );
      await expect(filterValue).toHaveValue("Beta");
      await expect(nameCells(page)).toHaveCount(1);

      // Hide the Due column in this view. The checkbox is controlled by the
      // server-rendered config, so assert through the stored configuration.
      await page.getByTestId("properties-trigger").click();
      const propertiesPopover = page.getByTestId("db-properties-popover");
      await expect(propertiesPopover).toBeVisible();
      await propertiesPopover.getByLabel(`Properties: Due`).click();
      await pollConfig(
        fixture,
        (c) =>
          Array.isArray(c.visiblePropertyIds) &&
          !c.visiblePropertyIds.includes(fixture.propertyIds.due),
      );
      await expect(page.locator("thead")).not.toContainText("Due");
      await expect(page.locator("thead")).toContainText("Estimate");
      await expect(propertiesPopover.getByLabel("Properties: Due")).not.toBeChecked();

      await reloadPage(page);
      await waitForHydration(page, '[aria-label="Add a view"]');

      // Per-view configuration survived: the filter still narrows to one row
      // and Due is still hidden in this view.
      await expect(page.getByRole("button", { name: "Filter (1)" })).toBeVisible();
      await expect(nameCells(page)).toHaveCount(1);
      await expect(nameCells(page).first()).toHaveValue("B15 Beta");
      await expect(page.locator("thead")).not.toContainText("Due");

      await page.getByTestId("properties-trigger").click();
      await expect(page.getByTestId("db-properties-popover").getByLabel("Properties: Due")).not.toBeChecked();
      await expect(page.getByTestId("db-properties-popover").getByLabel("Properties: Estimate")).toBeChecked();
    } finally {
      await destroyDatabase(fixture.pageId);
    }
  });

  test("duplicates a view into its own tab with the configuration copied", async ({
    page,
  }) => {
    const fixture = await createDatabase();
    try {
      // Give the source view a stored configuration to prove the copy keeps it.
      const config = {
        sorts: [{ propertyId: fixture.propertyIds.estimate, direction: "desc" }],
        visiblePropertyIds: [fixture.propertyIds.estimate, fixture.propertyIds.due],
      };
      await prisma.databaseView.update({
        where: { id: fixture.tableViewId },
        data: { config },
      });

      await openDatabase(page, fixture.pageId);

      await page.getByRole("button", { name: "View options" }).click();
      await page.getByRole("menuitem", { name: "Duplicate" }).click();

      // The copy exists in the database (asserted first: the shared dev server
      // can lag, and the tab cannot appear before the row does).
      await expect
        .poll(
          async () => {
            const copy = await prisma.databaseView.findFirst({
              where: { databasePageId: fixture.pageId, name: "Table copy" },
            });
            return copy !== null;
          },
          { timeout: 30_000 },
        )
        .toBe(true);

      const copyTab = page.getByRole("button", { name: "Table copy" });
      await expect(copyTab).toBeVisible();
      // The new tab becomes the active one…
      await expect(copyTab).toHaveAttribute("aria-current", "true");

      // …and it is a real DatabaseView row carrying the same configuration.
      const copy = await prisma.databaseView.findFirst({
        where: { databasePageId: fixture.pageId, name: "Table copy" },
      });
      expect(copy).not.toBeNull();
      expect(copy?.type).toBe("TABLE");
      expect(JSON.parse(JSON.stringify(copy?.config ?? null))).toEqual(
        JSON.parse(JSON.stringify(config)),
      );
    } finally {
      await destroyDatabase(fixture.pageId);
    }
  });

  test("restores a deleted row from the Deleted rows panel", async ({ page }) => {
    const fixture = await createDatabase();
    try {
      await openDatabase(page, fixture.pageId);
      await expect(nameCells(page)).toHaveCount(3);

      // Third row = B15 Gamma — deleted, then restored from the panel. The
      // write is verified against the database and re-clicked if the shared
      // dev server swallowed the first update.
      await page.getByTitle("Delete row").nth(2).click();
      await expect
        .poll(
          async () => {
            const row = await prisma.page.findUnique({
              where: { id: fixture.rowIds.gamma },
              select: { deletedAt: true },
            });
            if (row?.deletedAt) return true;
            await page.getByTitle("Delete row").nth(2).click();
            return false;
          },
          { timeout: 30_000, intervals: [1_000] },
        )
        .toBe(true);
      await expect(nameCells(page)).toHaveCount(2);
      await expect(page.locator("table")).not.toContainText("B15 Gamma");

      await page.getByRole("button", { name: "Deleted rows" }).click();
      const panel = page.getByRole("region", { name: "Deleted rows" });
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("B15 Gamma");
      await panel.getByRole("button", { name: "Restore" }).click();

      await expect
        .poll(
          async () => {
            const row = await prisma.page.findUnique({
              where: { id: fixture.rowIds.gamma },
              select: { deletedAt: true },
            });
            if (row?.deletedAt === null) return true;
            await panel.getByRole("button", { name: "Restore" }).click();
            return false;
          },
          { timeout: 30_000, intervals: [1_000] },
        )
        .toBe(true);

      await expect(nameCells(page)).toHaveCount(3);
      await expect(nameCells(page).nth(2)).toHaveValue("B15 Gamma");
      await expect(panel).toContainText("No deleted rows in this database.");
    } finally {
      await destroyDatabase(fixture.pageId);
    }
  });

  test("keeps the active view tab across a reload", async ({ page }) => {
    const fixture = await createDatabase();
    try {
      await openDatabase(page, fixture.pageId);

      const boardTab = page.getByRole("button", { name: "Board" });
      await boardTab.click();
      await expect(boardTab).toHaveAttribute("aria-current", "true");
      await expect(page.getByText("To-do").first()).toBeVisible();

      await reloadPage(page);
      await waitForHydration(page, '[aria-label="Add a view"]');

      // The remembered tab wins over the default first tab.
      await expect(boardTab).toHaveAttribute("aria-current", "true");
      await expect(page.getByText("To-do").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Table" })).not.toHaveAttribute(
        "aria-current",
        "true",
      );
    } finally {
      await destroyDatabase(fixture.pageId);
    }
  });

  test("converts a view between types from the view menu", async ({ page }) => {
    const fixture = await createDatabase();
    try {
      await openDatabase(page, fixture.pageId);
      await expect(page.locator("main table")).toBeVisible();

      await page.getByRole("button", { name: "View options" }).click();
      await page.getByRole("menuitem", { name: "Type" }).click();
      // The submenu item renders its view glyph next to the label, so the
      // accessible name is "☰ List" — match on the substring.
      const listMenuItem = page.getByRole("menuitem", { name: "List" });
      await expect(listMenuItem).toBeVisible();
      await listMenuItem.click();

      // The type is persisted on the view…
      await expect
        .poll(
          async () => {
            const view = await prisma.databaseView.findUnique({
              where: { id: fixture.tableViewId },
              select: { type: true },
            });
            if (view?.type === "LIST") return true;
            // Retry the switch if the shared dev server swallowed the update.
            await page.getByRole("button", { name: "View options" }).click();
            await page.getByRole("menuitem", { name: "Type" }).click();
            await page
              .getByRole("menuitem", { name: "List" })
              .click()
              .catch(() => {});
            return false;
          },
          { timeout: 30_000, intervals: [1_000] },
        )
        .toBe(true);

      // …and the same tab now renders the list view (config kept, type swapped).
      await expect(page.locator("main table")).toHaveCount(0);
      await expect(page.locator("main ul li a").first()).toBeVisible();
      await reloadPage(page);
      await waitForHydration(page, '[aria-label="Add a view"]');
      await expect(page.locator("main ul li a").first()).toBeVisible();
    } finally {
      await destroyDatabase(fixture.pageId);
    }
  });

  test("edits a row property from the side peek panel", async ({ page }) => {
    const fixture = await createDatabase();
    try {
      await openDatabase(page, fixture.pageId);
      await expect(nameCells(page)).toHaveCount(3);

      // First row = B15 Alpha.
      await page.getByTitle("Open side peek").first().click();
      const peek = page.getByRole("complementary", { name: "Row" });
      await expect(peek).toBeVisible();
      await expect(peek).toContainText("B15 Alpha");
      await expect(peek).toContainText("Estimate");

      // The panel is editable: change Alpha's estimate from 5 to 7.
      const estimate = peek.getByLabel("Estimate");
      await estimate.fill("7");
      await estimate.blur();
      await expect
        .poll(
          async () => {
            const stored = await prisma.propertyValue.findUnique({
              where: {
                propertyId_pageId: {
                  propertyId: fixture.propertyIds.estimate,
                  pageId: fixture.rowIds.alpha,
                },
              },
              select: { value: true },
            });
            const value = JSON.parse(JSON.stringify(stored?.value ?? null)) as {
              number?: number;
            };
            if (value?.number === 7) return true;
            await estimate.fill("7");
            await estimate.blur().catch(() => {});
            return false;
          },
          { timeout: 30_000, intervals: [1_000] },
        )
        .toBe(true);
    } finally {
      await destroyDatabase(fixture.pageId);
    }
  });
});
