import { expect, test, type Page } from "@playwright/test";
import { PrismaClient, type Prisma, type PropertyType } from "@prisma/client";

/**
 * B38 — formulas + relations e2e coverage (B21 audit: ZERO e2e for
 * FORMULA / RELATION / ROLLUP property types):
 *  (a) a formula column created through the UI computes and renders its value,
 *  (b) a rollup over a tickets-style relation renders the aggregate,
 *  (c) the relation picker links a row (chip + persisted pageIds).
 *
 * Every test builds its own databases through prisma (unique titles) and
 * removes them in a `finally` block — never the shared first page
 * (e2e discipline). Database components are READ-ONLY for this
 * spec (B17 owns src/components/database/**): a red here documents a product
 * gap rather than being patched around.
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };

const prisma = new PrismaClient();

// A cold dev server compiles routes on demand and other suites share it, so
// the per-test budget is deliberately generous (the config is 60s). Under
// concurrent-run contention a cold route compile + sign-in retries has been measured
// at 4+ minutes per navigation; 10 minutes keeps the retries meaningful.
test.describe.configure({ timeout: 600_000 });

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

/* ---------------------------------------------------------------------------
   Fixture builders
   --------------------------------------------------------------------------- */

type PropDef = {
  name: string;
  type: PropertyType;
  config?: Record<string, unknown>;
  position?: number;
};

type RowDef = {
  title: string;
  /** Values keyed by property name. */
  values?: Record<string, unknown>;
};

type Fixture = {
  pageId: string;
  propIds: Record<string, string>;
  rowIds: string[];
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

async function createDatabase(
  title: string,
  props: PropDef[],
  rows: RowDef[] = [],
  position = 950_000,
): Promise<Fixture> {
  const { workspace, owner } = await workspaceAndOwner();

  const db = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      type: "DATABASE",
      title,
      createdById: owner.id,
      position,
    },
    select: { id: true },
  });

  const propIds: Record<string, string> = {};
  const primaryName = props[0]?.name;
  let position2 = 1000;
  for (const prop of props) {
    const created = await prisma.property.create({
      data: {
        databasePageId: db.id,
        name: prop.name,
        type: prop.type,
        position: prop.position ?? position2,
        config: {
          ...(prop.config ?? {}),
          ...(prop.name === primaryName ? { primary: true } : {}),
        },
      },
      select: { id: true },
    });
    propIds[prop.name] = created.id;
    position2 += 1000;
  }

  const rowIds: string[] = [];
  for (const row of rows) {
    const page = await prisma.page.create({
      data: {
        workspaceId: workspace.id,
        parentId: db.id,
        title: row.title,
        createdById: owner.id,
        position: 1000 * (rowIds.length + 1),
      },
      select: { id: true },
    });
    rowIds.push(page.id);
    const entries = Object.entries(row.values ?? {});
    if (entries.length > 0) {
      await prisma.propertyValue.createMany({
        data: entries.map(([name, value]) => ({
          propertyId: propIds[name],
          pageId: page.id,
          value: value as Prisma.InputJsonValue,
        })),
      });
    }
  }

  await prisma.databaseView.create({
    data: { databasePageId: db.id, name: "Table", type: "TABLE", position: 1000 },
  });

  return { pageId: db.id, propIds, rowIds };
}

/** Remove fixtures (rows, properties, views and values cascade from Page). */
async function destroy(...pageIds: string[]) {
  await prisma.page
    .deleteMany({ where: { id: { in: pageIds.filter(Boolean) } } })
    .catch(() => {});
}

/**
 * The `<td>` for one column of one row: both the header row and the body rows
 * map the same visible column order, so the header's testid index locates the
 * cell. Needed because FORMULA/ROLLUP cells render as plain spans without an
 * aria-label.
 */
async function cellAt(page: Page, headerName: string, rowIndex = 0) {
  const index = await page.locator("thead th").evaluateAll(
    (ths, name) =>
      ths.findIndex((th) => (th as HTMLElement).dataset.testid === `property-header-${name}`),
    headerName,
  );
  expect(index, `column "${headerName}" is present in the table`).toBeGreaterThanOrEqual(0);
  return page.locator("tbody tr").nth(rowIndex).locator("td").nth(index);
}

async function storedValue(propertyId: string, rowId: string) {
  const value = await prisma.propertyValue.findUnique({
    where: { propertyId_pageId: { propertyId, pageId: rowId } },
    select: { value: true },
  });
  return JSON.parse(JSON.stringify(value?.value ?? null)) as Record<string, unknown> | null;
}

async function storedPageIds(propertyId: string, rowId: string): Promise<string[]> {
  const parsed = await storedValue(propertyId, rowId);
  const ids = parsed?.pageIds;
  return Array.isArray(ids) ? (ids as string[]) : [];
}

/** The stored `expression` of a FORMULA property ("" when unset). */
async function storedExpression(
  pageId: string,
  propertyName: string,
): Promise<string> {
  const property = await prisma.property.findFirst({
    where: { databasePageId: pageId, name: propertyName },
    select: { config: true },
  });
  const config = JSON.parse(JSON.stringify(property?.config ?? {})) as {
    expression?: string;
  };
  return config.expression ?? "";
}

/* ---------------------------------------------------------------------------
   (a) Formula column — created through the UI, computed value renders
   --------------------------------------------------------------------------- */

test("creates a formula column and renders the computed value", async ({ page }) => {
  const fixture = await createDatabase(
    `B38 formula ${Date.now()}`,
    [
      { name: "Name", type: "TEXT" },
      { name: "Estimate", type: "NUMBER", config: { format: "number" } },
    ],
    [{ title: "B38 Row Alpha", values: { Estimate: { number: 7 } } }],
  );
  try {
    await openDatabase(page, fixture.pageId);
    await expect(page.locator('tbody input[aria-label="Name"]')).toHaveCount(1);

    // Create the FORMULA column through the New property form.
    await page.getByRole("button", { name: "New property" }).click();
    await page.locator("#prop-name").fill("Doubled");
    await page.locator("#prop-type").selectOption("FORMULA");
    // Scoped to #main: the sidebar also has an "Add" button (strict mode).
    await page
      .locator("#main")
      .getByRole("button", { name: "Add", exact: true })
      .click();

    // The shared dev server can swallow one action: poll the DB and retry
    // idempotently. The form only closes on success (onSuccess), so while it
    // is visible and nothing is stored the previous click is retryable; a
    // closed form means success just fired — wait for the refresh instead of
    // re-adding (which would create a duplicate column).
    await expect
      .poll(
        async () => {
          const stored = await prisma.property.findFirst({
            where: { databasePageId: fixture.pageId, name: "Doubled" },
            select: { id: true },
          });
          if (stored) return true;
          if (await page.locator("#prop-name").isVisible().catch(() => false)) {
            // In-flight (pending) keeps the button disabled: bounded wait only.
            await page
              .locator("#main")
              .getByRole("button", { name: "Add", exact: true })
              .click({ timeout: 3_000 })
              .catch(() => {});
          }
          return false;
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe(true);
    await expect(page.getByTestId("property-header-Doubled")).toBeVisible({
      timeout: 60_000,
    });

    // No expression yet: the cell renders the em-dash placeholder.
    await expect(await cellAt(page, "Doubled", 0)).toHaveText("—");

    // Property menu -> Edit formula -> save an expression over Estimate.
    await page
      .getByTestId("property-header-Doubled")
      .getByLabel("Property options")
      .click();
    await page.getByRole("menuitem", { name: "Edit formula" }).click();
    const dialog = page.getByRole("dialog", { name: "Formula" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox").fill('prop("Estimate") * 2');
    await dialog.getByRole("button", { name: "Save formula" }).click();

    // The engine computes 7 * 2 = 14 and the table cell renders it. The save
    // action can be swallowed by the shared dev server: poll the stored
    // expression and re-save idempotently (the dialog re-seeds from config).
    await dialog.getByRole("button", { name: "Save formula" }).click();
    await expect
      .poll(
        async () => {
          const config = await storedExpression(fixture.pageId, "Doubled");
          if (config === 'prop("Estimate") * 2') return true;
          await page
            .getByTestId("property-header-Doubled")
            .getByLabel("Property options")
            .click({ timeout: 3_000 })
            .catch(() => {});
          await page
            .getByRole("menuitem", { name: "Edit formula" })
            .click({ timeout: 3_000 })
            .catch(() => {});
          const retry = page.getByRole("dialog", { name: "Formula" });
          await retry
            .getByRole("textbox")
            .fill('prop("Estimate") * 2')
            .catch(() => {});
          await retry
            .getByRole("button", { name: "Save formula" })
            .click({ timeout: 3_000 })
            .catch(() => {});
          return false;
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe(true);

    // The cell must catch up with the stored config — wait for the live
    // refresh first, fall back to a reload (same persisted-config render).
    await expect
      .poll(
        async () => {
          const cell = await cellAt(page, "Doubled", 0);
          if (
            await cell
              .getByText("14")
              .isVisible()
              .catch(() => false)
          ) {
            return true;
          }
          await reloadPage(page).catch(() => {});
          await waitForHydration(page, '[aria-label="Add a view"]').catch(
            () => {},
          );
          return false;
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe(true);

    // The expression persisted: a reload re-renders the same computed value.
    await reloadPage(page);
    await waitForHydration(page, '[aria-label="Add a view"]');
    await expect(await cellAt(page, "Doubled", 0)).toHaveText("14");

    // The expression persisted server-side, not just in local state.
    expect(await storedExpression(fixture.pageId, "Doubled")).toBe(
      'prop("Estimate") * 2',
    );
  } finally {
    await destroy(fixture.pageId);
  }
});

/* ---------------------------------------------------------------------------
   (b) Rollup over a tickets/pages relation — renders the aggregate
   --------------------------------------------------------------------------- */

test("aggregates a tickets relation into a rollup column", async ({ page }) => {
  const tickets = await createDatabase(
    `B38 Tickets ${Date.now()}`,
    [
      { name: "Name", type: "TEXT" },
      { name: "Points", type: "NUMBER", config: { format: "number" } },
    ],
    [
      { title: "B38 Ticket Alpha", values: { Points: { number: 5 } } },
      { title: "B38 Ticket Beta", values: { Points: { number: 7 } } },
    ],
    951_000,
  );
  const epic = await createDatabase(
    `B38 Epic ${Date.now()}`,
    [{ name: "Name", type: "TEXT" }],
    [{ title: "B38 Epic Row" }],
    952_000,
  );

  // Relation + rollup columns need cross-database ids, so they are wired
  // directly (the UI path for them is covered by the relation picker test).
  const relation = await prisma.property.create({
    data: {
      databasePageId: epic.pageId,
      name: "Tickets",
      type: "RELATION",
      position: 2000,
      config: { targetDatabaseId: tickets.pageId },
    },
    select: { id: true },
  });
  await prisma.property.create({
    data: {
      databasePageId: epic.pageId,
      name: "Total",
      type: "ROLLUP",
      position: 3000,
      config: {
        relationPropertyId: relation.id,
        targetPropertyId: tickets.propIds.Points,
        function: "sum",
      },
    },
    select: { id: true },
  });
  await prisma.propertyValue.create({
    data: {
      propertyId: relation.id,
      pageId: epic.rowIds[0],
      value: { pageIds: tickets.rowIds } as Prisma.InputJsonValue,
    },
  });

  try {
    await openDatabase(page, epic.pageId);

    // The relation column resolves both related tickets (relationData plumbed).
    const relationCell = await cellAt(page, "Tickets", 0);
    await expect(relationCell).toContainText("B38 Ticket Alpha");
    await expect(relationCell).toContainText("B38 Ticket Beta");

    // Engine proof: the side peek renders the computed aggregate (5 + 7 = 12).
    await page.getByTitle("Open side peek").first().click();
    const peek = page.getByRole("complementary", { name: "Row" });
    await expect(peek).toBeVisible();
    const rollupRow = peek
      .locator("div.grid")
      .filter({ has: page.getByText("Total", { exact: true }) });
    await expect(rollupRow.locator("dd")).toHaveText("12", { timeout: 30_000 });
    await page.getByLabel("Close side peek").click();

    // Parity: the table cell must show the same aggregate.
    // (RED documents the product bug: the table Cell discards `computed` for
    // ROLLUP — src/components/database/view-parts.tsx:633-634.)
    await expect(await cellAt(page, "Total", 0)).toHaveText("12", { timeout: 30_000 });
  } finally {
    await destroy(epic.pageId, tickets.pageId);
  }
});

/* ---------------------------------------------------------------------------
   (c) Relation picker — links a row, chip + persisted pageIds
   --------------------------------------------------------------------------- */

test("links a row through the relation picker", async ({ page }) => {
  const tickets = await createDatabase(
    `B38 Tickets ${Date.now()}`,
    [{ name: "Name", type: "TEXT" }],
    [{ title: "B38 Ticket Alpha" }, { title: "B38 Ticket Beta" }],
    953_000,
  );
  const epic = await createDatabase(
    `B38 Epic ${Date.now()}`,
    [{ name: "Name", type: "TEXT" }],
    [{ title: "B38 Epic Row" }],
    954_000,
  );
  const relation = await prisma.property.create({
    data: {
      databasePageId: epic.pageId,
      name: "Tickets",
      type: "RELATION",
      position: 2000,
      config: { targetDatabaseId: tickets.pageId },
    },
    select: { id: true },
  });

  try {
    await openDatabase(page, epic.pageId);
    const relationCell = await cellAt(page, "Tickets", 0);
    const addRelation = relationCell.getByLabel("Add relation");
    await expect(addRelation).toBeVisible();

    // Pick the first ticket from the dropdown of the related database's rows.
    await addRelation.click();
    await page.getByRole("menuitem", { name: /B38 Ticket Alpha/ }).click();

    // The write persists (re-picked if the shared dev server swallowed it —
    // only when the UI still shows the stale empty state, so no toggle risk).
    await expect
      .poll(
        async () => {
          const ids = await storedPageIds(relation.id, epic.rowIds[0]);
          if (ids.includes(tickets.rowIds[0])) return true;
          if (await addRelation.isVisible().catch(() => false)) {
            await addRelation.click().catch(() => {});
            await page
              .getByRole("menuitem", { name: /B38 Ticket Alpha/ })
              .click()
              .catch(() => {});
          }
          return false;
        },
        { timeout: 45_000, intervals: [1_000] },
      )
      .toBe(true);

    // The cell shows a chip for the linked row. The write is already proven
    // above; the chip needs router.refresh() to re-render, which the contended
    // dev server can take a while on — reload as the act if it lags.
    await expect
      .poll(
        async () => {
          const cell = await cellAt(page, "Tickets", 0);
          if (
            await cell
              .getByText("B38 Ticket Alpha")
              .isVisible()
              .catch(() => false)
          ) {
            return true;
          }
          await reloadPage(page).catch(() => {});
          await waitForHydration(page, '[aria-label="Add a view"]').catch(
            () => {},
          );
          return false;
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe(true);

    // The link survives a reload (rendered from the stored pageIds).
    await reloadPage(page);
    await waitForHydration(page, '[aria-label="Add a view"]');
    await expect(await cellAt(page, "Tickets", 0)).toContainText("B38 Ticket Alpha");
    expect(await storedPageIds(relation.id, epic.rowIds[0])).toContain(tickets.rowIds[0]);
  } finally {
    await destroy(epic.pageId, tickets.pageId);
  }
});
