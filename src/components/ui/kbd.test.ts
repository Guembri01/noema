import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KBD_BASE, KBD_SIZES, Kbd, kbdClasses, kbdKeys } from "./kbd";

/**
 * Node tests for the Kbd primitive: the size class map, the key-group split,
 * and a static render for single keys, groups and every size.
 */

describe("kbd class maps", () => {
  it("exposes xs/sm/md sizes on the micro type size", () => {
    expect(Object.keys(KBD_SIZES).sort()).toEqual(["md", "sm", "xs"]);
    for (const size of Object.keys(KBD_SIZES) as Array<keyof typeof KBD_SIZES>) {
      expect(KBD_SIZES[size]).toContain("text-xs");
    }
    expect(KBD_SIZES.xs).toContain("h-4");
    expect(KBD_SIZES.sm).toContain("h-5");
    expect(KBD_SIZES.md).toContain("h-6");
  });

  it("uses the shared chip shape and token colours", () => {
    expect(KBD_BASE).toContain("rounded-xs");
    expect(KBD_BASE).toContain("border-border");
    expect(KBD_BASE).toContain("bg-surface");
    expect(KBD_BASE).toContain("text-muted");
    expect(kbdClasses({ className: "ms-2" })).toContain("ms-2");
  });
});

describe("kbdKeys", () => {
  it("splits a shortcut string into keycaps", () => {
    expect(kbdKeys("Ctrl K")).toEqual(["Ctrl", "K"]);
    expect(kbdKeys("Ctrl Shift K")).toEqual(["Ctrl", "Shift", "K"]);
  });

  it("keeps a single key as one cap", () => {
    expect(kbdKeys("Esc")).toEqual(["Esc"]);
    expect(kbdKeys("⌘K")).toEqual(["⌘K"]);
  });

  it("prefers an explicit keys array", () => {
    expect(kbdKeys("ignored", ["Ctrl", "K"])).toEqual(["Ctrl", "K"]);
  });

  it("returns no caps for arbitrary nodes", () => {
    expect(kbdKeys(createElement("span", null, "x"))).toEqual([]);
  });
});

describe("renderToStaticMarkup", () => {
  it("renders a single key as one <kbd>", () => {
    const html = renderToStaticMarkup(createElement(Kbd, null, "Esc"));
    expect(html.startsWith("<kbd")).toBe(true);
    expect(html).toContain(">Esc<");
    expect(html).not.toContain("kbd-group");
  });

  it("splits the existing `Ctrl K` usage into a key group", () => {
    const html = renderToStaticMarkup(createElement(Kbd, null, "Ctrl K"));
    expect(html).toContain('data-slot="kbd-group"');
    expect(html).toContain(">Ctrl<");
    expect(html).toContain(">K<");
    // Two keycaps, both styled.
    expect(html.match(/<kbd/g)?.length).toBe(2);
  });

  it("renders an explicit group", () => {
    const html = renderToStaticMarkup(
      createElement(Kbd, { keys: ["Shift", "Enter"] }),
    );
    expect(html).toContain(">Shift<");
    expect(html).toContain(">Enter<");
  });

  for (const size of ["xs", "sm", "md"] as const) {
    it(`renders size ${size}`, () => {
      const html = renderToStaticMarkup(
        createElement(Kbd, { size }, "K"),
      );
      expect(html).toContain(KBD_SIZES[size].split(" ")[0]);
    });
  }
});
