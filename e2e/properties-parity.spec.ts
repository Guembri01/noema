import { expect, test, type Page } from "@playwright/test";
import { signInWithSession } from "./auth";
import { PrismaClient, type Prisma, type PropertyType } from "@prisma/client";

/**
 * B17 — properties family parity:
 *  (a) number formats: percent + currency render and persist,
 *  (b) select option rename + colour change persist across a reload,
 *  (c) status group buckets (To-do / In progress / Done) drive board columns,
 *  (d) multi-user PEOPLE assignment from workspace members,
 *  (e) property drag reorder persists (positions rewritten in the DB),
 *  (f) property delete asks for confirmation before losing data,
 *  (g) friendly date format + created/last-edited time+by surfaced in the UI,
 *  (h) FILES: attach an attachment and preview it in the gallery.
 *
 * Every test builds its own database through prisma and removes it in a
 * `finally` block — never the shared first page (e2e discipline).
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };

const prisma = new PrismaClient();

// A cold dev server compiles routes on demand and other suites share it, so
// the per-test budget is deliberately generous (the config is 60s).
test.describe.configure({ timeout: 180_000 });

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  await signInWithSession(page, CREDENTIALS);
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
  /** Defaults to the workspace owner. */
  createdById?: string;
};

type ViewDef = {
  name: string;
  type: "TABLE" | "BOARD" | "LIST" | "GALLERY" | "CALENDAR" | "TIMELINE" | "CHART";
  groupBy?: string; // property name
};

type Fixture = {
  pageId: string;
  propIds: Record<string, string>;
  rowIds: string[];
  workspaceId: string;
  ownerId: string;
  cleanup: () => Promise<void>;
};

async function workspaceAndOwner() {
  const workspace = await prisma.workspace.findFirst({
    where: { slug: "demo-workspace" },
    select: { id: true },
  });
  const owner = await prisma.user.findUnique({
    where: { email: CREDENTIALS.email },
    select: { id: true, name: true },
  });
  if (!workspace || !owner) throw new Error("demo workspace/user not seeded");
  return { workspace, owner };
}

async function buildDatabase(
  props: PropDef[],
  rows: RowDef[] = [],
  views: ViewDef[] = [{ name: "Table", type: "TABLE" }],
): Promise<Fixture> {
  const { workspace, owner } = await workspaceAndOwner();

  const db = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      type: "DATABASE",
      title: `B17 database ${Date.now()}`,
      createdById: owner.id,
      position: 910_000,
    },
    select: { id: true },
  });

  const propIds: Record<string, string> = {};
  let position = 1000;
  const primaryName = props[0]?.name;
  for (const prop of props) {
    const created = await prisma.property.create({
      data: {
        databasePageId: db.id,
        name: prop.name,
        type: prop.type,
        position: prop.position ?? position,
        config: {
          ...(prop.config ?? {}),
          ...(prop.name === primaryName ? { primary: true } : {}),
        },
      },
      select: { id: true },
    });
    propIds[prop.name] = created.id;
    position += 1000;
  }

  const rowIds: string[] = [];
  for (const row of rows) {
    const page = await prisma.page.create({
      data: {
        workspaceId: workspace.id,
        parentId: db.id,
        title: row.title,
        createdById: row.createdById ?? owner.id,
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

  let position2 = 1000;
  for (const view of views) {
    await prisma.databaseView.create({
      data: {
        databasePageId: db.id,
        name: view.name,
        type: view.type,
        position: position2,
        ...(view.groupBy ? { config: { groupByPropertyId: propIds[view.groupBy] } } : {}),
      },
    });
    position2 += 1000;
  }

  return {
    pageId: db.id,
    propIds,
    rowIds,
    workspaceId: workspace.id,
    ownerId: owner.id,
    cleanup: async () => {
      await prisma.page.delete({ where: { id: db.id } }).catch(() => {});
    },
  };
}

/** Poll the database until `check` holds, re-running `act` between polls. */
async function pollDb<T>(
  check: () => Promise<T | null | undefined | false>,
  act?: () => unknown | Promise<unknown>,
  message = "condition not met",
) {
  await expect
    .poll(
      async () => {
        const value = await check();
        if (value) return true;
        if (act) await act();
        return false;
      },
      { timeout: 45_000, intervals: [1_000] },
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw new Error(`${message}: ${error}`);
    });
}

async function storedPropertyConfig(pageId: string, name: string) {
  const property = await prisma.property.findFirst({
    where: { databasePageId: pageId, name },
    select: { config: true },
  });
  return JSON.parse(JSON.stringify(property?.config ?? {})) as Record<string, unknown>;
}

async function storedValue(propertyId: string, rowId: string) {
  const value = await prisma.propertyValue.findUnique({
    where: { propertyId_pageId: { propertyId, pageId: rowId } },
    select: { value: true },
  });
  return JSON.parse(JSON.stringify(value?.value ?? null)) as Record<string, unknown> | null;
}

/** The property header cell for one column. */
const header = (page: Page, name: string) =>
  page.getByTestId(`property-header-${name}`);

/** Open one column's property menu (the ⌄ trigger inside its header). */
async function openHeaderMenu(page: Page, name: string) {
  await header(page, name).getByLabel("Property options").click();
}

/**
 * Pick a Format submenu entry.
 *
 * The submenu renders in a portal; a mouse click can lose the pointer-events
 * transfer race against its parent menu (hit test falls through to <html>).
 * Keyboard activation is geometry- and pointer-independent: Enter opens the
 * submenu, and pressing Enter on the item itself focuses it and selects it.
 */
async function chooseFormat(page: Page, testId: string) {
  await page.getByRole("menuitem", { name: "Format" }).press("Enter");
  await page.getByTestId(testId).press("Enter");
}

/* ---------------------------------------------------------------------------
   (a) Number formats — percent + currency
   --------------------------------------------------------------------------- */

test("renders and persists percent and currency number formats", async ({ page }) => {
  const fixture = await buildDatabase(
    [
      { name: "Name", type: "TEXT" },
      { name: "Rate", type: "NUMBER" },
      { name: "Price", type: "NUMBER" },
    ],
    [
      { title: "B17 Row", values: { Rate: { number: 0.075 }, Price: { number: 1234.5 } } },
    ],
  );
  try {
    await openDatabase(page, fixture.pageId);
    const rateCell = page.getByLabel("Rate");
    await expect(rateCell).toHaveCount(1);

    // Percent: stored fraction renders as the percentage.
    await openHeaderMenu(page, "Rate");
    await chooseFormat(page, "format-percent");
    await pollDb(
      async () => (await storedPropertyConfig(fixture.pageId, "Rate")).format === "percent",
      async () => {
        await openHeaderMenu(page, "Rate").catch(() => {});
        await chooseFormat(page, "format-percent").catch(() => {});
      },
      "percent format not stored",
    );

    // Reload before the next menu: the router.refresh() from the first write
    // would otherwise close the second menu mid-click.
    await reloadPage(page);
    await waitForHydration(page, '[aria-label="Add a view"]');
    await expect(page.getByLabel("Rate")).toHaveText("7.5%");

    // Currency: symbol, grouping, two decimals.
    await openHeaderMenu(page, "Price");
    await chooseFormat(page, "format-currency-usd");
    await pollDb(
      async () => (await storedPropertyConfig(fixture.pageId, "Price")).format === "currency",
      async () => {
        await openHeaderMenu(page, "Price").catch(() => {});
        await chooseFormat(page, "format-currency-usd").catch(() => {});
      },
      "currency format not stored",
    );

    // Render straight from the persisted configuration.
    await reloadPage(page);
    await waitForHydration(page, '[aria-label="Add a view"]');
    await expect(page.getByLabel("Rate")).toHaveText("7.5%");
    await expect(page.getByLabel("Price")).toHaveText("$1,234.50");

    // Editing uses the displayed scale: 12 → stores 0.12.
    await page.getByLabel("Rate").click();
    const editor = page.getByLabel("Rate");
    await expect(editor).toBeVisible();
    await editor.fill("12");
    await editor.blur();
    await pollDb(
      async () => {
        const value = await storedValue(fixture.propIds.Rate, fixture.rowIds[0]);
        return value && (value as { number?: number }).number === 0.12;
      },
      async () => {
        await page.getByLabel("Rate").click();
        await page.getByLabel("Rate").fill("12");
        await page.getByLabel("Rate").blur().catch(() => {});
      },
      "percent edit did not store the fraction",
    );

    await reloadPage(page);
    await waitForHydration(page, '[aria-label="Add a view"]');
    await expect(page.getByLabel("Rate")).toHaveText("12%");
  } finally {
    await fixture.cleanup();
  }
});

/* ---------------------------------------------------------------------------
   (b) Select options — rename + colour persist
   --------------------------------------------------------------------------- */

test("renames a select option and recolours it, persisting across a reload", async ({
  page,
}) => {
  const fixture = await buildDatabase(
    [
      { name: "Name", type: "TEXT" },
      {
        name: "Tier",
        type: "SELECT",
        config: { options: [{ id: "opt_a", name: "Bronze", color: "brown" }] },
      },
    ],
    [{ title: "B17 Row", values: { Tier: { optionId: "opt_a" } } }],
  );
  try {
    await openDatabase(page, fixture.pageId);
    const cell = page.getByLabel("Tier");
    await expect(cell).toContainText("Bronze");

    await openHeaderMenu(page, "Tier");
    await page.getByTestId("edit-options").click();
    const editor = page.getByRole("dialog", { name: /Edit options/ });
    await expect(editor).toBeVisible();

    // Colour first (the label carries the current name, which renames below).
    await editor
      .getByLabel("Color: Bronze")
      .getByRole("button", { name: "red", exact: true })
      .click();
    await pollDb(
      async () => {
        const config = await storedPropertyConfig(fixture.pageId, "Tier");
        const options = (config.options ?? []) as { color?: string }[];
        return options[0]?.color === "red";
      },
      async () => {
        await editor
          .getByLabel("Color: Bronze")
          .getByRole("button", { name: "red", exact: true })
          .click()
          .catch(() => {});
      },
      "option colour not stored",
    );

    // Rename. Enter commits (and the label carries the *current* name, so it
    // changes as soon as the draft updates — resolve by prefix instead).
    const nameInput = editor.getByLabel("Option name: Bronze");
    await nameInput.fill("Platinum");
    await page.keyboard.press("Enter");
    await pollDb(
      async () => {
        const config = await storedPropertyConfig(fixture.pageId, "Tier");
        const options = (config.options ?? []) as { name?: string }[];
        return options[0]?.name === "Platinum";
      },
      undefined,
      "option rename not stored",
    );

    // Render straight from the persisted configuration: the chip carries the
    // new name and the new colour.
    await reloadPage(page);
    await waitForHydration(page, '[aria-label="Add a view"]');
    const chip = page.getByTestId("option-chip");
    await expect(chip).toContainText("Platinum");
    await expect(chip).not.toContainText("Bronze");
    await expect(chip).toHaveAttribute("data-color", "red");
  } finally {
    await fixture.cleanup();
  }
});

/* ---------------------------------------------------------------------------
   (c) Status groups → board columns
   --------------------------------------------------------------------------- */

test("maps status group buckets onto board columns", async ({ page }) => {
  const fixture = await buildDatabase(
    [
      { name: "Name", type: "TEXT" },
      {
        name: "Status",
        type: "STATUS",
        config: {
          options: [
            { id: "s_backlog", name: "Backlog", color: "gray", group: "todo" },
            { id: "s_build", name: "Building", color: "blue", group: "doing" },
            { id: "s_ship", name: "Shipped", color: "green", group: "done" },
          ],
        },
      },
    ],
    [
      { title: "B17 Backlog row", values: { Status: { optionId: "s_backlog" } } },
      { title: "B17 Building row", values: { Status: { optionId: "s_build" } } },
      { title: "B17 Shipped row", values: { Status: { optionId: "s_ship" } } },
    ],
    [
      { name: "Table", type: "TABLE" },
      { name: "Board", type: "BOARD", groupBy: "Status" },
    ],
  );
  try {
    await openDatabase(page, fixture.pageId);
    await page.getByRole("button", { name: "Board" }).click();

    // Three bucket columns instead of three option columns.
    const todoColumn = page.getByTestId("board-column-todo").locator("..").locator("..");
    const doingColumn = page.getByTestId("board-column-doing").locator("..").locator("..");
    const doneColumn = page.getByTestId("board-column-done").locator("..").locator("..");
    await expect(page.getByTestId("board-column-todo")).toHaveText("To-do");
    await expect(page.getByTestId("board-column-doing")).toHaveText("In progress");
    await expect(page.getByTestId("board-column-done")).toHaveText("Done");

    // Each row landed in its option's bucket.
    await expect(todoColumn).toContainText("B17 Backlog row");
    await expect(doingColumn).toContainText("B17 Building row");
    await expect(doneColumn).toContainText("B17 Shipped row");
    await expect(todoColumn).not.toContainText("B17 Shipped row");
  } finally {
    await fixture.cleanup();
  }
});

/* ---------------------------------------------------------------------------
   (d) People — multi-user assignment
   --------------------------------------------------------------------------- */

test("assigns several workspace members to a people cell", async ({ page }) => {
  const fixture = await buildDatabase(
    [{ name: "Name", type: "TEXT" }, { name: "Owners", type: "PEOPLE" }],
    [{ title: "B17 Row" }],
  );
  const second = await prisma.user.upsert({
    where: { email: "b17-second@noema.local" },
    update: {},
    create: {
      email: "b17-second@noema.local",
      passwordHash: "x",
      name: "B17 Second",
    },
    select: { id: true },
  });
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: fixture.workspaceId, userId: second.id } },
    update: {},
    create: { workspaceId: fixture.workspaceId, userId: second.id, role: "MEMBER" },
  });
  try {
    await openDatabase(page, fixture.pageId);
    const owner = await prisma.user.findUnique({
      where: { email: CREDENTIALS.email },
      select: { name: true },
    });

    await page.getByLabel("Add person").click();
    await page.getByRole("menuitem", { name: "B17 Second" }).click();
    // Re-open for the second member (the menu closes on select). The cell
    // keeps a local draft, so the second pick appends instead of reverting.
    await page.getByLabel("Add person").click();
    await page.getByRole("menuitem", { name: owner!.name }).click();

    // Selection order is the stored order.
    const expected = ["B17 Second", owner!.name];
    await pollDb(
      async () => {
        const value = await storedValue(fixture.propIds.Owners, fixture.rowIds[0]);
        const names = (value as { names?: string[] } | null)?.names ?? [];
        return JSON.stringify(names) === JSON.stringify(expected);
      },
      undefined,
      "people value not stored",
    );

    // Both members render as chips after a reload (multi-user, selection order).
    await reloadPage(page);
    await waitForHydration(page, '[aria-label="Add a view"]');
    const people = page.getByRole("group", { name: "Owners" });
    await expect(people).toContainText(owner!.name);
    await expect(people).toContainText("B17 Second");
    await expect(people.getByLabel(`Remove: ${owner!.name}`)).toBeVisible();
  } finally {
    await prisma.workspaceMember
      .delete({
        where: { workspaceId_userId: { workspaceId: fixture.workspaceId, userId: second.id } },
      })
      .catch(() => {});
    await prisma.user.delete({ where: { id: second.id } }).catch(() => {});
    await fixture.cleanup();
  }
});

/* ---------------------------------------------------------------------------
   (e) Property drag reorder
   --------------------------------------------------------------------------- */

test("reorders columns by dragging the header and persists the order", async ({ page }) => {
  const fixture = await buildDatabase(
    [
      { name: "Name", type: "TEXT" },
      { name: "Estimate", type: "NUMBER" },
      { name: "Due", type: "DATE" },
    ],
    [{ title: "B17 Row" }],
  );
  try {
    await openDatabase(page, fixture.pageId);
    await expect(header(page, "Due")).toBeVisible();

    // Drag Due before Estimate.
    await header(page, "Due").dragTo(header(page, "Estimate"));

    const expectedOrder = ["Name", "Due", "Estimate"];
    await pollDb(
      async () => {
        const properties = await prisma.property.findMany({
          where: { databasePageId: fixture.pageId },
          orderBy: { position: "asc" },
          select: { name: true },
        });
        return JSON.stringify(properties.map((p) => p.name)) === JSON.stringify(expectedOrder);
      },
      undefined,
      "property order not persisted",
    );

    // The same order renders straight from storage after a reload.
    await reloadPage(page);
    await waitForHydration(page, '[aria-label="Add a view"]');
    await expect
      .poll(
        async () => {
          const ids = await page
            .locator("thead th[data-testid^='property-header-']")
            .evaluateAll((cells) =>
              cells.map((cell) => cell.getAttribute("data-testid")),
            );
          return JSON.stringify(ids) ===
            JSON.stringify([
              "property-header-Name",
              "property-header-Due",
              "property-header-Estimate",
            ]);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

/* ---------------------------------------------------------------------------
   (f) Property delete confirmation
   --------------------------------------------------------------------------- */

test("asks before deleting a property so a stray click loses nothing", async ({ page }) => {
  const fixture = await buildDatabase(
    [
      { name: "Name", type: "TEXT" },
      { name: "Budget", type: "NUMBER" },
    ],
    [{ title: "B17 Row", values: { Budget: { number: 42 } } }],
  );
  const propertyExists = async () =>
    (await prisma.property.findFirst({
      where: { databasePageId: fixture.pageId, name: "Budget" },
      select: { id: true },
    })) !== null;

  try {
    await openDatabase(page, fixture.pageId);

    // Open the delete confirmation — nothing is deleted yet.
    await openHeaderMenu(page, "Budget");
    await page.getByRole("menuitem", { name: "Delete property" }).click();
    const dialog = page.getByRole("dialog", { name: /Delete property: Budget/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("permanently removes");
    await page.waitForTimeout(1_500);
    expect(await propertyExists()).toBe(true);

    // Cancel keeps the property and its value.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(1_000);
    expect(await propertyExists()).toBe(true);

    // Confirm actually deletes (property + cascaded values).
    await openHeaderMenu(page, "Budget");
    await page.getByRole("menuitem", { name: "Delete property" }).click();
    const confirmDialog = page.getByRole("dialog", { name: /Delete property: Budget/ });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Delete property" }).click();
    await pollDb(async () => !(await propertyExists()), undefined, "property not deleted");
    expect(
      await prisma.propertyValue.findFirst({
        where: { propertyId: fixture.propIds.Budget },
        select: { id: true },
      }),
    ).toBeNull();

    await reloadPage(page);
    await waitForHydration(page, '[aria-label="Add a view"]');
    await expect(page.getByTestId("property-header-Budget")).toHaveCount(0);
    await expect(page.getByTestId("property-header-Name")).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

/* ---------------------------------------------------------------------------
   (g) Friendly date format + created/last-edited time+by surfaced
   --------------------------------------------------------------------------- */

test("surfaces date formatting and created/last-edited time and by", async ({ page }) => {
  const fixture = await buildDatabase(
    [
      { name: "Name", type: "TEXT" },
      { name: "Created on", type: "CREATED_TIME" },
      { name: "Created by", type: "CREATED_BY" },
      { name: "Edited on", type: "LAST_EDITED_TIME" },
      { name: "Edited by", type: "LAST_EDITED_BY" },
      { name: "Due", type: "DATE", config: { format: "friendly" } },
    ],
    [{ title: "B17 Row", values: { Due: { start: "2026-05-09" } } }],
  );
  const second = await prisma.user.upsert({
    where: { email: "b17-editor@noema.local" },
    update: {},
    create: {
      email: "b17-editor@noema.local",
      passwordHash: "x",
      name: "B17 Editor",
    },
    select: { id: true },
  });
  await prisma.page.update({
    where: { id: fixture.rowIds[0] },
    data: { createdById: second.id },
  });
  try {
    await openDatabase(page, fixture.pageId);

    // Friendly date format renders deterministically (UTC, en-GB).
    await expect(page.getByLabel("Due")).toHaveText("9 May 2026");

    // Created/edited system properties are surfaced in the table.
    const owner = await prisma.user.findUnique({
      where: { email: CREDENTIALS.email },
      select: { name: true },
    });
    await expect(page.getByLabel("Created on")).toContainText("2026");
    await expect(page.getByLabel("Edited on")).toContainText("2026");
    await expect(page.getByLabel("Created by")).toHaveText("B17 Editor");
    // Before any recorded edit the last editor falls back to the creator.
    await expect(page.getByLabel("Edited by")).toHaveText("B17 Editor");

    // Record an edit through the app: the demo user changes the row title.
    const title = page.locator('tbody input[aria-label="Name"]').first();
    await title.fill("B17 Row edited");
    await title.blur();
    await pollDb(
      async () =>
        (await prisma.activity.findFirst({
          where: {
            targetType: "page",
            targetId: fixture.rowIds[0],
            action: "row.edited",
            actorId: fixture.ownerId,
          },
          select: { id: true },
        })) !== null,
      async () => {
        const again = page.locator('tbody input[aria-label="Name"]').first();
        await again.fill("B17 Row edited");
        await again.blur().catch(() => {});
      },
      "row.edited activity not logged",
    );

    // Now the last editor is the demo user, straight from storage.
    await reloadPage(page);
    await waitForHydration(page, '[aria-label="Add a view"]');
    await expect(page.getByLabel("Edited by")).toHaveText(owner!.name);
    await expect(page.getByLabel("Created by")).toHaveText("B17 Editor");
  } finally {
    await prisma.user.delete({ where: { id: second.id } }).catch(() => {});
    await fixture.cleanup();
  }
});

/* ---------------------------------------------------------------------------
   (h) Files & media — attach + gallery preview
   --------------------------------------------------------------------------- */

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);


test("attaches a file to a cell and previews images in the gallery", async ({ page }) => {
  const fixture = await buildDatabase(
    [
      { name: "Name", type: "TEXT" },
      { name: "Attachment", type: "FILES" },
    ],
    [
      {
        title: "B17 Row",
        values: {
          Attachment: {
            files: [
              {
                name: "shot.png",
                url: "http://localhost:3200/api/assets/e2e-shot.png",
                mimeType: "image/png",
              },
            ],
          },
        },
      },
    ],
    [
      { name: "Table", type: "TABLE" },
      { name: "Gallery", type: "GALLERY" },
    ],
  );
  try {
    await openDatabase(page, fixture.pageId);

    // The table cell renders the attachment as a link.
    const cell = page.getByRole("group", { name: "Attachment" });
    await expect(cell).toContainText("shot.png");

    // Upload a second attachment through the cell's attach control.
    await page.getByTestId("property-files-input").setInputFiles({
      name: "b17-upload.png",
      mimeType: "image/png",
      buffer: PNG_1PX,
    });
    await pollDb(
      async () => {
        const value = await storedValue(fixture.propIds.Attachment, fixture.rowIds[0]);
        const files = (value as { files?: { name?: string }[] } | null)?.files ?? [];
        return files.some((file) => file.name === "b17-upload.png");
      },
      undefined,
      "upload not attached",
    );
    await reloadPage(page);
    await waitForHydration(page, '[aria-label="Add a view"]');
    await expect(page.getByRole("group", { name: "Attachment" })).toContainText(
      "b17-upload.png",
    );

    // The gallery card previews the first attached image.
    await page.getByRole("button", { name: "Gallery" }).click();
    const banner = page.getByTestId("gallery-banner").first();
    const image = banner.locator("img");
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("src", /\/api\/files\//);
  } finally {
    await fixture.cleanup();
  }
});
