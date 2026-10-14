import { expect, test, type Page } from "@playwright/test";

/**
 * B71 — Notion import dialog progress surface (D23.4, spec `import-export.md`
 * §12 dialog sketch): instead of a bare `pending` boolean the dialog renders
 * an aria-live status region (`data-testid="notion-import-status"`) that
 * carries the running stage and settles into either the counts summary
 * ("Imported {imported} · skipped {skipped} · failed {failed}") or the server
 * failure line.
 *
 * Red-first was proven at unit level (src/server/actions/import-integrity.test.ts:
 * 10/10 red before the implementation). This e2e pins the DOM contract on the
 * live dev server. The import itself is expected to FAIL (dummy token), so the
 * region must settle on the alert line and the dialog must return to its
 * import action.
 *
 * Own file — never edits e2e/noema.spec.ts. Dedicated run:
 *   E2E_BASE_URL=http://localhost:3201 npx playwright test e2e/b71-import-progress.spec.ts
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };
// B44 note: sign-in costs 30–90 s when sibling batches build against the
// shared dev server — budget accordingly.
const NAV_TIMEOUT = { timeout: 150_000 };

test.setTimeout(300_000);
// Fleet note (B44): sibling batches run playwright concurrently in this
// working dir — opt out of tracing so shared artifact dirs cannot collide.
test.use({ trace: "off", actionTimeout: 20_000 });

async function signIn(page: Page) {
  await page.goto("/login", NAV_TIMEOUT);
  await page.getByLabel("Email").fill(CREDENTIALS.email);
  await page.getByLabel("Password").fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//, NAV_TIMEOUT);
}

test("notion import dialog shows a stage/count status line, not a bare pending flag", async ({
  page,
}) => {
  await signIn(page);

  await page.getByRole("button", { name: "Import from Notion (API)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible(NAV_TIMEOUT);

  await dialog.locator("#notion-token").fill("secret_b71_dummy_token");
  await dialog.locator("#notion-page").fill("b71-dummy-page-id");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();

  // The status region exists and is visible while the action runs (this is
  // the element that did not exist before B71).
  const status = page.getByTestId("notion-import-status");
  await expect(status).toBeVisible({ timeout: 60_000 });

  // It settles with real content: either the failure line (dummy token) or,
  // if a mock Notion backend accepted it, the counts summary.
  const alert = status.locator('[role="alert"]');
  const summary = status.locator("p", { hasText: "Imported" });
  await expect(alert.or(summary)).toBeVisible({ timeout: 90_000 });

  // The dialog returns to a usable import action after the failure settles.
  await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeEnabled();
});
