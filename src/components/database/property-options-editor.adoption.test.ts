import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DW06 — design-system adoption for the property options editor.
 *
 * `renderToStaticMarkup` renders the editor in its default (one select option)
 * and empty (no options) states with Radix's portal stubbed inline. The source
 * scan proves no raw hex, no legacy palette class and no raw form element.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/server/actions/database", () => ({
  updatePropertyAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/components/editor/formula-editor", () => ({
  FormulaEditor: () => null,
}));
// Radix dialog/portal is `null` during SSR; stub the dialog primitive so the
// portaled content renders inline for `renderToStaticMarkup`.
vi.mock("@radix-ui/react-dialog", async () => {
  const { createElement: h } = await import("react");
  const PassThrough = ({ children }: { children?: ReactNode }) =>
    h("div", null, (children as ReactNode) ?? null);
  const Content = ({
    children,
    onOpenAutoFocus: _onOpenAutoFocus,
    onCloseAutoFocus: _onCloseAutoFocus,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) =>
    h(
      "div",
      { ...rest, role: "dialog", "data-state": "open" },
      (children as ReactNode) ?? null,
    );
  return {
    Root: PassThrough,
    Trigger: PassThrough,
    Close: PassThrough,
    Title: PassThrough,
    Description: PassThrough,
    Portal: PassThrough,
    Overlay: PassThrough,
    Content,
  };
});

const { PropertyOptionsEditor } = await import("./property-options-editor");
const { Dialog } = await import("@/components/ui/dialog");
const { TooltipProvider } = await import("@/components/ui/tooltip");
type DBProperty = import("./database-types").DBProperty;

const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/;
const LEGACY_PALETTE =
  /\b(?:bg|text|border|ring)-(?:red|blue|green|amber|orange|yellow|purple|pink|teal|emerald|slate|gray|zinc|neutral)-\d{2,3}\b/;
const RAW_FORM_ELEMENT = /<(?:select|input|button|option|textarea)\b/;

/** A SELECT property with one option — the editor's default state. */
const selectProperty: DBProperty = {
  id: "status",
  name: "Status",
  type: "SELECT",
  config: { options: [{ id: "todo", name: "To-do", color: "gray" }] },
} as unknown as DBProperty;

/** A SELECT property with no options — the editor's empty state. */
const emptyProperty: DBProperty = {
  id: "tags",
  name: "Tags",
  type: "SELECT",
  config: { options: [] },
} as unknown as DBProperty;

function render(property: DBProperty): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        Dialog,
        { open: true },
        createElement(PropertyOptionsEditor, {
          locale: "en",
          property,
          onClose: () => {},
        }),
      ),
    ),
  );
}

describe("renderToStaticMarkup — property options editor (default state)", () => {
  const html = render(selectProperty);

  it("renders the themed dialog and a tag chip per option", () => {
    expect(html).toContain('data-testid="property-options-editor"');
    expect(html).toContain("surface-raised-strong");
    // The colour picker is a Tag chip row painted from the tag tokens.
    expect(html).toContain('role="group"');
    expect(html).toContain("var(--tag-");
    expect(html).toContain('data-testid="add-option"');
  });

  it("paints from tokens only", () => {
    expect(html).not.toMatch(RAW_HEX);
    expect(html).not.toMatch(LEGACY_PALETTE);
  });
});

describe("renderToStaticMarkup — property options editor (empty state)", () => {
  const html = render(emptyProperty);

  it("shows the empty hint and keeps the add affordance", () => {
    expect(html).toContain("No options yet");
    expect(html).toContain('data-testid="add-option"');
  });

  it("paints from tokens only", () => {
    expect(html).not.toMatch(RAW_HEX);
    expect(html).not.toMatch(LEGACY_PALETTE);
  });
});

describe("property-options-editor source", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./property-options-editor.tsx", import.meta.url)),
    "utf8",
  );
  const codeLines = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

  it("carries no raw hex or legacy palette class", () => {
    const offenders = codeLines.filter(
      (line) => RAW_HEX.test(line) || LEGACY_PALETTE.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it("uses only design-system controls, never a raw form element", () => {
    const offenders = codeLines.filter((line) => RAW_FORM_ELEMENT.test(line));
    expect(offenders).toEqual([]);
  });
});
