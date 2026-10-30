import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * B45 - focus management for the ui primitives (FEATURE_MATRIX row
 * "Focus management"):
 *
 * Drives the Radix-backed Dialog primitive through a REAL flow (page-title
 * "Share" button -> ShareDialog, which mounts `src/components/ui/dialog.tsx`)
 * and asserts the whole keyboard contract the matrix row promises:
 *  (a) the modal is exposed as role=dialog + aria-modal=true,
 *  (b) initial focus lands INSIDE the dialog when it opens,
 *  (c) Tab and Shift+Tab CYCLE INSIDE the dialog - every stop is inside, the
 *      cycle wraps back to the first stop, and the document keeps focus
 *      (never escapes to the browser chrome / the page behind the overlay),
 *  (d) the keyboard-focused element inside carries the global focus ring
 *      (`:where(a, button, ...):focus-visible` in src/app/globals.css),
 *  (e) Escape closes the dialog and focus RETURNS TO THE INVOKER (the Share
 *      button that opened it).
 *
 * Owned files: src/components/ui/** (B45). share-dialog.tsx / page-title.tsx /
 * sidebar workspace-switcher belong to other work - READ-ONLY here, asserted
 * exactly as they are.
 * The assertions target the primitive contract (role / aria-modal / focus
 * containment / focus return) rather than dialog-specific copy, so any dialog
 * mounting the primitive is covered by this spec. A second test locks the same
 * contract for the DropdownMenu primitive (focus in, Escape, return to
 * trigger) - note menus intentionally release focus on Tab (WAI-ARIA menu
 * semantics), so Tab containment is asserted for dialogs only.
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };
const SLUG = "demo-workspace";
/** Max Tab presses before we declare the cycle never wrapped. */
const MAX_TABS = 40;

const prisma = new PrismaClient();

test.afterAll(async () => {
  await prisma.page
    .deleteMany({ where: { title: { startsWith: "B45 focus page" } } })
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
 * keys to host nodes when it takes over from the server HTML. Clicking a
 * server-rendered button before that point does nothing.
 */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((key) => key.startsWith("__react"));
    },
    selector,
    { timeout: 60_000 },
  );
}

/** Dedicated prisma page so the dialog flow never touches a shared page. */
async function createFocusPage() {
  const owner = await prisma.user.findUnique({
    where: { email: CREDENTIALS.email },
    select: { id: true },
  });
  const workspace = await prisma.workspace.findFirst({
    where: { slug: SLUG },
    select: { id: true },
  });
  if (!owner || !workspace) throw new Error("demo workspace/user not seeded");

  const title = `B45 focus page ${Date.now()}`;
  return prisma.page.create({
    data: {
      workspaceId: workspace.id,
      title,
      icon: "??",
      createdById: owner.id,
      content: { type: "doc", content: [{ type: "paragraph" }] },
      searchText: `${title} focus trap coverage`,
    },
    select: { id: true },
  });
}

async function deletePage(id: string) {
  await prisma.page.delete({ where: { id } }).catch(() => {});
}

type Stop = {
  /** activeElement is inside the [role=dialog] subtree */
  inside: boolean;
  /** the document still owns keyboard focus (false = browser chrome stole it) */
  focus: boolean;
  /** stable identity of the focused element inside the dialog */
  sig: string;
};

test.describe("focus management", () => {
  test("dialog traps focus, exposes aria-modal and returns focus to the invoker", async ({
    page,
  }) => {
    // Cold dev server compiles + sign-in round trip can eat the default 60 s.
    test.setTimeout(300_000);
    await signIn(page);
    const seeded = await createFocusPage();

    /** Where is focus now, relative to the dialog? */
    const readStop = () =>
      page.evaluate((): Stop => {
        const root = document.querySelector('[role="dialog"]');
        const el = document.activeElement as Element | null;
        const focusables = root
          ? Array.from(
              root.querySelectorAll(
                "a[href],button,input,select,textarea,[tabindex]",
              ),
            )
          : [];
        return {
          inside: !!root && !!el && root.contains(el),
          focus: document.hasFocus(),
          sig: el ? `${el.tagName}#${el.id}@${focusables.indexOf(el)}` : "none",
        };
      });

    try {
      await page.goto(`/w/${SLUG}/${seeded.id}`, { waitUntil: "domcontentloaded" });
      await waitForHydration(page, "#main");

      // --- open the dialog via a real flow (page-title "Share" button) -----
      const share = page.locator('button[aria-label="Share"]');
      await expect(share).toBeVisible();
      await share.click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toHaveCount(1);
      await expect(dialog).toBeVisible();

      // (a) aria-modal on the primitive.
      await expect(dialog).toHaveAttribute("aria-modal", "true", {
        timeout: 5_000,
      });

      // (b) initial focus moved inside the dialog.
      await expect
        .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)), {
          timeout: 5_000,
        })
        .toBe(true);

      const initial = await readStop();
      expect(initial.inside, "initial focus is not inside the dialog").toBe(true);

      // (c) Tab cycles INSIDE: every stop stays in the document AND in the
      // dialog, focus never leaks to the browser chrome, and the cycle wraps
      // back to the element auto-focused on open.
      let allInside = true;
      let keepsFocus = true;
      let wrapped = false;
      let ring: { tag: string; style: string; width: number } | null = null;

      for (let i = 0; i < MAX_TABS; i += 1) {
        await page.keyboard.press("Tab");
        const stop = await readStop();
        allInside &&= stop.inside;
        keepsFocus &&= stop.focus;
        if (i === 0) {
          // First Tab stop is a genuine tabbable element: check the ring here.
          ring = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            if (!el || el === document.body || el === document.documentElement) {
              return null;
            }
            const cs = getComputedStyle(el);
            return {
              tag: el.tagName,
              style: cs.outlineStyle,
              width: parseFloat(cs.outlineWidth) || 0,
            };
          });
        }
        if (stop.sig === initial.sig) {
          wrapped = true;
          break;
        }
      }

      expect(allInside, "Tab escaped the dialog").toBe(true);
      expect(keepsFocus, "the page lost focus to the browser chrome").toBe(true);
      expect(wrapped, "Tab never wrapped back to the first stop").toBe(true);

      // (d) keyboard focus carries the global focus ring.
      expect(ring, "no active element after Tab").not.toBeNull();
      expect(ring!.style, `focus ring outline missing on ${ring!.tag}`).not.toBe(
        "none",
      );
      expect(ring!.width, `focus ring has no width on ${ring!.tag}`).toBeGreaterThan(0);

      // Shift+Tab cycles backwards and stays inside too.
      for (let i = 0; i < 5; i += 1) {
        await page.keyboard.press("Shift+Tab");
        const stop = await readStop();
        expect(stop.inside, "Shift+Tab escaped the dialog").toBe(true);
        expect(stop.focus, "Shift+Tab leaked focus to the browser chrome").toBe(
          true,
        );
      }

      // (e) Escape closes and focus RETURNS TO THE INVOKER.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(share).toBeFocused();
    } finally {
      await deletePage(seeded.id);
    }
  });

  test("dropdown menu takes keyboard focus, closes on Escape and returns focus to its trigger", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await signIn(page);
    const seeded = await createFocusPage();

    try {
      await page.goto(`/w/${SLUG}/${seeded.id}`, { waitUntil: "domcontentloaded" });
      await waitForHydration(page, "#main");

      // Real flow: sidebar footer -> Theme toggle (Radix DropdownMenu primitive).
      const trigger = page.getByRole("button", { name: "Theme", exact: true });
      await expect(trigger).toBeVisible();
      await trigger.click();

      const menu = page.getByRole("menu");
      await expect(menu).toHaveCount(1);
      await expect(menu).toBeVisible();

      // Keyboard focus moves into the menu (roving tabindex, arrow keys).
      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() => menu.evaluate((el) => el.contains(document.activeElement)), {
          timeout: 5_000,
        })
        .toBe(true);

      // Escape closes the menu ...
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      // ... and focus RETURNS TO THE TRIGGER (not <body>).
      await expect(trigger).toBeFocused();
    } finally {
      await deletePage(seeded.id);
    }
  });
});
