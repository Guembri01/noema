import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FloatingHostProvider, FloatingLayer, useFloatingHost } from "./floating-layer";

/**
 * The floating-host contract (docs/DESIGN_SYSTEM.md §7.3).
 *
 * A flat tier ladder cannot put a popup above the modal surface that owns it:
 * `Z.popover` (50) sits under `Z.modal` (60), which is how the ticket drawer's
 * assignee `Select` ended up painted behind the drawer. Ownership is therefore
 * structural — a modal publishes a host and every popup opened inside its
 * subtree portals there instead of into `<body>`.
 *
 * The node test environment has no DOM, so the *runtime* half of that contract
 * (the host exists, sits after the surface content at `Z.modal`, and wins the
 * paint order) is measured in a real browser by `npm run check:layering`. What
 * is pinned here is the rest: the server markup stays clean, `FloatingLayer`
 * still renders inline where no document exists, and every modal surface in the
 * kit actually publishes a host — the wiring that silently rots when a surface
 * is rewritten.
 */

const render = (children: ReactNode) =>
  renderToStaticMarkup(createElement(FloatingHostProvider, null, children));

describe("FloatingHostProvider", () => {
  it("renders the surface content untouched on the server", () => {
    const html = render(createElement("span", null, "surface"));
    // The host needs a document to receive portals, so it is client-only: a
    // closed surface must still leave no markup behind.
    expect(html).toContain("surface");
    expect(html).not.toContain("data-floating-host");
  });
});

describe("FloatingLayer", () => {
  it("renders its children inline where no DOM exists", () => {
    const html = renderToStaticMarkup(
      createElement(FloatingLayer, null, createElement("i", null, "popup")),
    );
    expect(html).toContain("popup");
  });
});

describe("useFloatingHost", () => {
  it("resolves to null outside a surface, so popups portal to the body", () => {
    const Probe = () =>
      createElement("output", null, useFloatingHost() === null ? "body" : "host");
    expect(renderToStaticMarkup(createElement(Probe))).toContain("body");
  });
});

describe("every modal surface publishes a host", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it.each([
    ["./sheet.tsx", "the side drawer / peek sheet"],
    ["./dialog.tsx", "the shared dialog"],
    ["./confirm-dialog.tsx", "the confirm dialog"],
    ["../database/database-view.tsx", "the database peek"],
  ])("%s (%s) wraps its content in FloatingHostProvider", (path) => {
    expect(source(path)).toContain("FloatingHostProvider");
  });

  it("keeps the Select's own layer host-aware instead of hard-coding body", () => {
    const select = source("./select.tsx");
    expect(select).toContain("useFloatingHost");
    expect(select).toContain("host ?? document.body");
  });
});
