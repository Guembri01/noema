import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HIGH_CONTRAST_KEY,
  planActionsMenuTab,
} from "@/components/topbar/actions-menu";
import { planWhoHasAccessTab } from "@/components/who-has-access";
import { planVersionHistoryTab } from "@/components/version-history";
import { planTicketDrawerTab } from "@/components/tickets/ticket-drawer";
import {
  equationDirection,
  planEquationEditorTab,
} from "@/components/editor/equation-editor";
import { HIGH_CONTRAST_TOKENS } from "@/lib/high-contrast";
import type { Focusable, FocusPlan } from "@/lib/focus-trap";

/**
 * Wiring proof for the three previously-unimported pure engines:
 *
 *  - `@/lib/focus-trap` → the five hand-rolled overlays. Each overlay exports
 *    its own `plan*Tab` seam (a thin, DOM-free route into `trapPlan`); these
 *    tests drive that seam with the overlay's representative tab ring and
 *    assert the wrap/enter/skip behaviour the dialog relies on.
 *  - `@/lib/bidi` → the equation editor's per-block direction.
 *  - `@/lib/high-contrast` → the persisted contrast preference + its CSS token
 *    set.
 */

const stop = (id: string, over: Partial<Focusable> = {}): Focusable => ({
  id,
  ...over,
});

type Planner = (
  stops: readonly Focusable[],
  opts?: { activeId?: string | null; shift?: boolean },
) => FocusPlan | null;

/** One representative ring per overlay — the controls its Tab trap wraps. */
const OVERLAYS: Array<[string, Planner, Focusable[]]> = [
  [
    "actions-menu",
    planActionsMenuTab,
    [stop("search"), stop("item-copy"), stop("item-trash"), stop("footer")],
  ],
  [
    "who-has-access",
    planWhoHasAccessTab,
    [stop("close"), stop("row-1"), stop("row-2"), stop("done")],
  ],
  [
    "version-history",
    planVersionHistoryTab,
    [stop("close"), stop("row-1-restore"), stop("row-1-diff"), stop("row-2-diff")],
  ],
  [
    "ticket-drawer",
    planTicketDrawerTab,
    [stop("archive"), stop("close"), stop("title"), stop("description"), stop("save")],
  ],
  [
    "equation-editor",
    planEquationEditorTab,
    [stop("source"), stop("symbol-search"), stop("symbol-1"), stop("cancel"), stop("apply")],
  ],
];

describe.each(OVERLAYS)("%s focus trap", (_name, plan, ring) => {
  it("advances with Tab and wraps from the last stop to the first", () => {
    expect(plan(ring, { activeId: ring[0].id })?.target.id).toBe(ring[1].id);
    const wrap = plan(ring, { activeId: ring[ring.length - 1].id });
    expect(wrap).toMatchObject({ reason: "next", wrapped: true });
    expect(wrap?.target.id).toBe(ring[0].id);
  });

  it("steps back with Shift+Tab and wraps to the last stop", () => {
    const wrap = plan(ring, { activeId: ring[0].id, shift: true });
    expect(wrap).toMatchObject({ reason: "prev", wrapped: true });
    expect(wrap?.target.id).toBe(ring[ring.length - 1].id);
  });

  it("enters the ring when focus is outside it", () => {
    expect(plan(ring, { activeId: null })?.target.id).toBe(ring[0].id);
    expect(plan(ring, { activeId: null, shift: true })?.target.id).toBe(
      ring[ring.length - 1].id,
    );
  });

  it("skips disabled and hidden stops", () => {
    const list = [ring[0], stop("skipped", { hidden: true }), ring[1]];
    expect(plan(list, { activeId: null })?.target.id).toBe(ring[0].id);
    expect(plan(list, { activeId: ring[0].id })?.target.id).toBe(ring[1].id);
  });

  it("releases the key when nothing can take focus", () => {
    expect(plan([stop("x", { hidden: true }), stop("y", { disabled: true })])).toBeNull();
    expect(plan([], { activeId: null })).toBeNull();
  });
});

/** RTL strings are \u-escaped so the file stays ASCII. */
const ARABIC = "\u0645\u0631\u062D\u0628\u0627"; // مرحبا

describe("equation editor per-block direction (lib/bidi)", () => {
  it("resolves LTR, RTL and mixed content", () => {
    expect(equationDirection("x^2 + y^2")).toMatchObject({
      dir: "ltr",
      mixed: false,
      hint: "ltr",
    });
    expect(equationDirection(ARABIC)).toMatchObject({
      dir: "rtl",
      mixed: false,
      hint: "rtl",
    });
    const mixed = equationDirection(`${ARABIC} = x`);
    expect(mixed.dir).toBe("rtl");
    expect(mixed.mixed).toBe(true);
    expect(mixed.className).toContain("dir-rtl");
    expect(mixed.className).toContain("dir-mixed");
  });

  it("marks strong-less content as dir-auto", () => {
    expect(equationDirection("123 + 456").className).toContain("dir-auto");
  });
});

describe("high-contrast preference (lib/high-contrast)", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

  /** Body of the first `selector { ... }` rule. */
  function ruleBody(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} rule missing from globals.css`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  }

  it("names the persisted preference key the component writes", () => {
    expect(HIGH_CONTRAST_KEY).toBe("noema:high-contrast");
  });

  it("mirrors the light tokens on [data-contrast=\"more\"]", () => {
    const body = ruleBody('[data-contrast="more"]');
    for (const [token, value] of Object.entries(HIGH_CONTRAST_TOKENS.light)) {
      expect(body, `--${token}`).toContain(`--${token}: ${value};`);
    }
  });

  it("mirrors the dark tokens on .dark [data-contrast=\"more\"]", () => {
    const body = ruleBody('.dark [data-contrast="more"]');
    for (const [token, value] of Object.entries(HIGH_CONTRAST_TOKENS.dark)) {
      expect(body, `--${token}`).toContain(`--${token}: ${value};`);
    }
  });

  it("ships the dir-* direction classes the bidi engine returns", () => {
    for (const cls of [".dir-ltr", ".dir-rtl", ".dir-mixed", ".dir-auto"]) {
      expect(css).toContain(cls);
    }
  });
});
