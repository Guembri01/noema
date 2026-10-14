import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/** B96 throwaway diagnostic — deleted before the batch finishes. */

const prisma = new PrismaClient();
test.describe.configure({ timeout: 180_000 });
test.afterAll(async () => {
  await prisma.$disconnect();
});

test("probe toc stamping", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __NOEMA_E2E?: boolean }).__NOEMA_E2E = true;
  });
  const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
  const owner = await prisma.user.findFirst({ where: { email: "demo@noema.local" } });
  const created = await prisma.page.create({
    data: {
      workspaceId: workspace!.id,
      type: "PAGE",
      title: `B96 probe ${Date.now()}`,
      createdById: owner!.id,
      position: 940_000,
      content: {
        type: "doc",
        content: [
          { type: "tableOfContents" },
          ...[1, 2, 3, 4].flatMap((i) => [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: `Probe ${i}` }],
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: `filler ${i} `.repeat(20) }],
            },
          ]),
        ],
      } as never,
    },
    select: { id: true },
  });
  try {
    await page.goto("/login");
    await page.getByLabel("Email").fill("demo@noema.local");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/w\//);
    await page.goto(`/w/demo-workspace/${created.id}`);
    await expect(page.locator(".noema-toc")).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(1500);

    const report = await page.evaluate(() => {
      const w = window as unknown as { __noemaEditor?: { view: { nodeDOM(p: number): unknown; domAtPos(p: number): { node: Node; offset: number } }; state: { doc: { descendants(cb: (n: { type: { name: string }; textContent: string }, p: number) => boolean) => void } } } };
      const ed = w.__noemaEditor;
      const rows: unknown[] = [];
      if (ed) {
        ed.state.doc.descendants((node, pos) => {
          if (node.type.name === "heading") {
            let viaNodeDOM: string;
            try {
              const dom = ed.view.nodeDOM(pos);
              viaNodeDOM =
                dom == null
                  ? "null"
                  : `${(dom as Element).tagName} id=${(dom as Element).id || "-"} instanceof HTMLElement=${dom instanceof HTMLElement}`;
            } catch (e) {
              viaNodeDOM = `THROW ${String(e)}`;
            }
            let viaDomAtPos: string;
            try {
              const { node: n, offset } = ed.view.domAtPos(pos);
              const child = n.childNodes[offset];
              viaDomAtPos = `${n.nodeName}#${offset} -> ${child ? `${(child as Element).nodeName ?? child.nodeName} id=${(child as Element).id || "-"}` : "NONE"}`;
            } catch (e) {
              viaDomAtPos = `THROW ${String(e)}`;
            }
            rows.push({ pos, text: node.textContent, viaNodeDOM, viaDomAtPos });
          }
          return true;
        });
      }
      const headingIds = [...document.querySelectorAll(".ProseMirror h1, .ProseMirror h2, .ProseMirror h3")].map(
        (h) => `${h.tagName}:${h.id || "(none)"}`,
      );
      // Can a manual stamp survive, or does PM wipe attribute mutations?
      const first = document.querySelector(".ProseMirror h2") as HTMLElement | null;
      if (first) first.id = "probe-manual";
      return { exposed: !!ed, rows, headingIds, manual: first?.id ?? null };
    });
    console.log("PROBE_REPORT " + JSON.stringify(report, null, 2));

    await page.waitForTimeout(800);
    const survivor = await page.evaluate(() => {
      const h = document.querySelector(".ProseMirror h2") as HTMLElement | null;
      return { id: h?.id ?? null, all: [...document.querySelectorAll(".ProseMirror h1, .ProseMirror h2, .ProseMirror h3")].map((x) => x.id || "-") };
    });
    console.log("PROBE_SURVIVOR " + JSON.stringify(survivor));

    // Does a doc update re-stamp?
    await page.evaluate(() => {
      const w = window as unknown as { __noemaEditor?: { commands: { insertContentAt(pos: number, c: unknown): boolean } } };
      w.__noemaEditor?.commands.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "probe edit" }] });
    });
    await page.waitForTimeout(800);
    const afterEdit = await page.evaluate(() =>
      [...document.querySelectorAll(".ProseMirror h1, .ProseMirror h2, .ProseMirror h3")].map((x) => x.id || "-"),
    );
    console.log("PROBE_AFTER_EDIT " + JSON.stringify(afterEdit));
  } finally {
    await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
  }
});
