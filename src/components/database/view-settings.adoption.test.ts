import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DW06 — design-system adoption for the settings popovers.
 *
 * Two proofs:
 *  1. the new pure mapping (`propertyOptions` / `operatorOptions`) is pinned;
 *  2. a `renderToStaticMarkup` pass renders the settings toolbar *and* a real
 *     settings popover (via the exported chrome) with Radix's portal stubbed to
 *     a pass-through, so the markup is inspectable in node.
 *
 * A source scan then proves the file carries no raw hex, no legacy Tailwind
 * palette class and no raw form element — every control is a design primitive.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/server/actions/database", () => ({
  reorderTemplatesAction: vi.fn(async () => ({ ok: true })),
  setDefaultTemplateAction: vi.fn(async () => ({ ok: true })),
}));
// Radix portals and presence are `null`/closed during SSR; stub the popover
// primitive so the chrome (which lives in a portal in the browser) renders
// inline for `renderToStaticMarkup`.
vi.mock("@radix-ui/react-popover", async () => {
  const { createElement: h } = await import("react");
  const PassThrough = ({ children }: { children?: ReactNode }) =>
    h("div", null, (children as ReactNode) ?? null);
  const Content = ({
    children,
    align: _align,
    sideOffset: _sideOffset,
    collisionPadding: _collisionPadding,
    avoidCollisions: _avoidCollisions,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) =>
    h("div", { ...rest, "data-state": "open" }, (children as ReactNode) ?? null);
  return {
    Root: PassThrough,
    Trigger: PassThrough,
    Anchor: PassThrough,
    Portal: PassThrough,
    Content,
  };
});

const {
  ViewSettings,
  SettingsPopoverContent,
  propertyOptions,
  operatorOptions,
} = await import("./view-settings");
const { Popover, PopoverTrigger } = await import("@/components/ui/popover");
const { TooltipProvider } = await import("@/components/ui/tooltip");
type DBProperty = import("./database-types").DBProperty;

const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/;
const LEGACY_PALETTE =
  /\b(?:bg|text|border|ring)-(?:red|blue|green|amber|orange|yellow|purple|pink|teal|emerald|slate|gray|zinc|neutral)-\d{2,3}\b/;
const RAW_FORM_ELEMENT = /<(?:select|input|button|option|textarea)\b/;

const properties: DBProperty[] = [
  { id: "name", name: "Name", type: "TEXT", config: { primary: true } },
  {
    id: "status",
    name: "Status",
    type: "SELECT",
    config: { options: [{ id: "todo", name: "To-do", color: "gray" }] },
  },
] as unknown as DBProperty[];

describe("propertyOptions / operatorOptions", () => {
  it("maps a property list to Select rows", () => {
    expect(propertyOptions(properties)).toEqual([
      { value: "name", label: "Name" },
      { value: "status", label: "Status" },
    ]);
  });

  it("maps a property type's operators to Select rows", () => {
    const options = operatorOptions("TEXT");
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((o) => typeof o.value === "string")).toBe(true);
    expect(options.every((o) => typeof o.label === "string")).toBe(true);
  });
});

describe("renderToStaticMarkup — settings toolbar (default state)", () => {
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(ViewSettings, {
        locale: "en",
        properties,
        config: { filters: [], sorts: [], groupByPropertyId: "status" },
        editable: true,
        onChange: () => {},
        rows: [],
      }),
    ),
  );

  it("renders the popover triggers as Button controls", () => {
    expect(html).toContain('data-testid="filter-trigger"');
    expect(html).toContain('data-testid="sort-trigger"');
    expect(html).toContain('data-testid="properties-trigger"');
    expect(html).toContain('data-testid="layout-trigger"');
    expect(html).toContain('data-testid="gallery-trigger"');
  });

  it("paints from tokens only", () => {
    expect(html).not.toMatch(RAW_HEX);
    expect(html).not.toMatch(LEGACY_PALETTE);
  });
});

describe("renderToStaticMarkup — a settings popover's chrome", () => {
  const html = renderToStaticMarkup(
    createElement(
      Popover,
      { open: true },
      createElement(PopoverTrigger, null, "Open"),
      createElement(
        SettingsPopoverContent,
        {
          title: "Filter",
          description: "All rows are shown.",
          footer: createElement("span", null, "Add filter"),
          "data-testid": "probe-popover",
        },
        createElement("p", null, "Body"),
      ),
    ),
  );

  it("is a raised, rising surface with a scrollable body and sticky rails", () => {
    expect(html).toContain("surface-raised");
    expect(html).toContain("animate-rise");
    expect(html).toContain("scrollbar-thin");
    expect(html).toContain("sticky top-0");
    expect(html).toContain("sticky bottom-0");
    expect(html).toContain('data-testid="probe-popover"');
  });

  it("paints from tokens only", () => {
    expect(html).not.toMatch(RAW_HEX);
    expect(html).not.toMatch(LEGACY_PALETTE);
  });
});

describe("view-settings source", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./view-settings.tsx", import.meta.url)),
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
