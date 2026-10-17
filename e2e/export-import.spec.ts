import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * B94 — export / import parity (OWN spec, targeted run).
 *
 * Pins (docs/specs/import-export.md R23.16 export contract + the import
 * surface's format list):
 *
 *  1. page Markdown export `GET /api/export/page/:id?format=md` → 200,
 *     `text/markdown` + `attachment` download headers, and the SEEDED heading
 *     in the body; an unknown `?format` is a 400 (never a silent Markdown
 *     fallback). Exercised through `page.request` so the request rides the
 *     logged-in cookie jar — the session-auth branch of the route is covered,
 *     not just the handler.
 *  2. database CSV export `GET /api/export/database/:id` → 200, `text/csv` +
 *     `attachment`, body contains the seeded row.
 *  3. B91 may have added `?format=json` to that same route CONCURRENTLY (it
 *     owns the allowlist edit): when it answers 200 the response is asserted
 *     as JSON carrying the seeded row; when it still 400s the check is
 *     SKIPPED explicitly with an annotation instead of silently passing.
 *  4. the import surface lists every supported import format
 *     (md / zip / docx / trello / notion) and the page-actions "Import"
 *     entry opens the import dialog.
 *
 * Discipline: dedicated prisma fixtures with
 * try/finally cleanup — never the shared first page; targeted runs only under
 * the TARGETED-RUN CONCURRENCY rule; component/importer sources are READ-ONLY
 * for this change because B71 runs import code live (check `git status` before
 * any "quick fix" there — report instead).
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };
const SLUG = "demo-workspace";

// Generous budgets: dev :3201 recompiles on demand and several suites may
// run playwright against the same server.
const NAV_TIMEOUT = { timeout: 60_000 };

test.setTimeout(120_000);
// Note: several suites may run playwright concurrently in this working dir;
// the shared test-results/.playwright-artifacts-* dirs then collide mid-trace
// ("trace recording fixture timeout during setup"). Opt this spec out of
// tracing; give it its own output dir on the command line
// (`--output=test-results-b94`).
test.use({ trace: "off" });

const prisma = new PrismaClient();

test.afterAll(async () => {
  await prisma.page
    .deleteMany({ where: { title: { startsWith: "B94 " } } })
    .catch(() => {});
  await prisma.$disconnect();
});

/**
 * Navigation only, never assertions: with several suites running targeted e2e
 * against one `next dev`, a page load can come back `net::ERR_ABORTED` when a
 * a concurrent run's compile interrupts it (dev-server artifact).
 * Copied from e2e/version-parity.spec.ts (B67).
 */
async function gotoStable(page: Page, url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.goto(url, NAV_TIMEOUT);
      return;
    } catch (error) {
      lastError = error;
      console.log(`goto ${url} attempt ${attempt} failed:`, String(error).split("\n")[0]);
      if (!/ERR_ABORTED|Timeout|net::/.test(String(error))) throw error;
      await page.waitForTimeout(2_000);
    }
  }
  throw lastError;
}

async function signIn(page: Page) {
  await gotoStable(page, "/login");
  await page.getByLabel("Email").fill(CREDENTIALS.email);
  await page.getByLabel("Password").fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//, NAV_TIMEOUT);
}

async function workspaceAndOwner() {
  const workspace = await prisma.workspace.findUnique({ where: { slug: SLUG } });
  const owner = await prisma.user.findUnique({ where: { email: CREDENTIALS.email } });
  if (!workspace || !owner) throw new Error("demo workspace/user not seeded");
  return { workspace, owner };
}

type ExportFixture = {
  pageId: string;
  title: string;
  heading: string;
  body: string;
};

/** A dedicated PAGE whose content carries a unique heading + body marker. */
async function createExportPage(): Promise<ExportFixture> {
  const { workspace, owner } = await workspaceAndOwner();
  const stamp = Date.now();
  const title = `B94 export page ${stamp}`;
  const heading = `B94 Export Heading ${stamp}`;
  const body = `B94 export body marker ${stamp}`;
  const created = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      createdById: owner.id,
      title,
      position: 950_000,
      content: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: heading }],
          },
          { type: "paragraph", content: [{ type: "text", text: body }] },
        ],
      },
    },
    select: { id: true },
  });
  return { pageId: created.id, title, heading, body };
}

type CsvFixture = { databaseId: string; rowTitle: string; columnName: string };

/** A dedicated DATABASE (primary "Name" column) with one seeded row page. */
async function createCsvDatabase(): Promise<CsvFixture> {
  const { workspace, owner } = await workspaceAndOwner();
  const stamp = Date.now();
  const rowTitle = `B94 csv row ${stamp}`;
  const columnName = `B94 Name ${stamp}`;

  const db = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      createdById: owner.id,
      type: "DATABASE",
      title: `B94 database ${stamp}`,
      position: 951_000,
    },
    select: { id: true },
  });
  await prisma.property.create({
    data: {
      databasePageId: db.id,
      name: columnName,
      type: "TEXT",
      position: 1000,
      config: { primary: true },
    },
    select: { id: true },
  });
  await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      createdById: owner.id,
      parentId: db.id,
      title: rowTitle,
      position: 1000,
    },
    select: { id: true },
  });

  return { databaseId: db.id, rowTitle, columnName };
}

test.describe("export / import parity (B94)", () => {
  test("page Markdown export: 200, download headers, seeded heading; unknown format is 400", async ({
    page,
  }) => {
    const fixture = await createExportPage();
    try {
      await signIn(page);

      const response = await page.request.get(
        `/api/export/page/${fixture.pageId}?format=md`,
      );
      expect(response.status()).toBe(200);

      const headers = response.headers();
      expect(headers["content-type"]).toContain("text/markdown");
      expect(headers["content-disposition"]).toContain("attachment");
      expect(headers["content-disposition"]).toContain(".md");

      const body = await response.text();
      // The seeded heading (and its title H1) survive the round trip.
      expect(body).toContain(fixture.heading);
      expect(body).toContain(`# ${fixture.title}`);
      expect(body).toContain(fixture.body);

      // R23.16: an unknown format is a 400 with the valid list, never a
      // silent Markdown fallback (page route is stable / off-limits to B91).
      const unknown = await page.request.get(
        `/api/export/page/${fixture.pageId}?format=not-a-format`,
      );
      expect(unknown.status()).toBe(400);
      const unknownBody = (await unknown.json()) as { valid?: string[] };
      expect(unknownBody.valid).toContain("md");
    } finally {
      await prisma.page.deleteMany({ where: { id: fixture.pageId } }).catch(() => {});
    }
  });

  test("database CSV export: 200, text/csv, seeded row", async ({ page }) => {
    const fixture = await createCsvDatabase();
    try {
      await signIn(page);

      const response = await page.request.get(
        `/api/export/database/${fixture.databaseId}`,
      );
      expect(response.status()).toBe(200);

      const headers = response.headers();
      expect(headers["content-type"]).toContain("text/csv");
      expect(headers["content-disposition"]).toContain("attachment");
      expect(headers["content-disposition"]).toContain(".csv");

      const csv = await response.text();
      expect(csv).toContain(fixture.columnName);
      expect(csv).toContain(fixture.rowTitle);
    } finally {
      await prisma.page.deleteMany({ where: { id: fixture.databaseId } }).catch(() => {});
    }
  });

  test("database JSON export (B91 ?format=json) is asserted when present, skipped otherwise", async ({
    page,
  }) => {
    const fixture = await createCsvDatabase();
    try {
      await signIn(page);

      const response = await page.request.get(
        `/api/export/database/${fixture.databaseId}?format=json`,
      );

      // B91 owns the database export allowlist and is running right now.
      if (response.status() === 400) {
        const body = (await response.json()) as { valid?: string[] };
        // Whatever else happens, the contract stays: 400 + the valid list.
        expect(body.valid).toContain("csv");
        test.info().annotations.push({
          type: "note",
          description:
            "B94: B91 ?format=json not present yet — JSON export assertion skipped explicitly",
        });
        test.skip(true, "B91 ?format=json not implemented yet (asserted 400 + valid list)");
      }

      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("application/json");
      const raw = await response.text();
      JSON.parse(raw); // must really be JSON, not Markdown with a JSON type
      expect(raw).toContain(fixture.rowTitle);
      expect(raw).toContain(fixture.columnName);
    } finally {
      await prisma.page.deleteMany({ where: { id: fixture.databaseId } }).catch(() => {});
    }
  });

  test("import surface lists md/zip/docx/trello/notion and the import dialog opens", async ({
    page,
  }) => {
    const { workspace, owner } = await workspaceAndOwner();
    const probe = await prisma.page.create({
      data: {
        workspaceId: workspace.id,
        createdById: owner.id,
        title: `B94 import probe ${Date.now()}`,
        position: 952_000,
      },
      select: { id: true },
    });

    try {
      await signIn(page);
      await gotoStable(page, `/w/${SLUG}/${probe.id}`);
      // Hydration signal: the editor only mounts once React has attached, so a
      // click before it only writes to the DOM (see e2e/descriptions.spec.ts).
      await expect(page.locator(".ProseMirror")).toBeVisible();

      // The format list lives in the sidebar import section (md / zip / docx /
      // trello / notion — transcribe is a bonus entry, not a format).
      const sidebar = page.locator("aside");
      for (const label of [
        "Import Markdown",
        "Import export (.zip)",
        "Import Word (.docx)",
        "Import Trello (JSON)",
        "Import from Notion (API)",
      ]) {
        await expect(sidebar.getByRole("button", { name: label, exact: true })).toBeVisible();
      }

      // The page-actions menu exposes Import/Export, and Import opens the
      // import dialog (the Notion import dialog is the dialog this app has).
      await page.getByRole("button", { name: "Actions", exact: true }).click();
      const actions = page.getByRole("dialog", { name: "Page actions" });
      await expect(actions).toBeVisible();
      await expect(actions.getByRole("option", { name: /^Import$/ })).toBeVisible();
      await expect(actions.getByRole("option", { name: /^Export$/ })).toBeVisible();

      await actions.getByRole("option", { name: /^Import$/ }).click();
      // The dialog element carries no accessible name (plain <h2>, no
      // DialogTitle/aria-label) so `role + name` cannot find it - identify it
      // by the heading INSIDE it instead. The missing accessible name on
      // role="dialog" is reported upstream: notion-import-dialog.tsx is
      // B71-dirty and READ-ONLY for this change.
      const importDialog = page
        .getByRole("dialog")
        .filter({ has: page.getByRole("heading", { name: "Import from Notion" }) });
      await expect(importDialog).toBeVisible();
      await expect(importDialog.getByLabel("Integration token")).toBeVisible();
      await expect(importDialog.getByLabel("Page URL or id")).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(importDialog).toHaveCount(0);
    } finally {
      await prisma.page.deleteMany({ where: { id: probe.id } }).catch(() => {});
    }
  });
});
