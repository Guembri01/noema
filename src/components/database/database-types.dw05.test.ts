/**
 * DW05 — the option colour catalogue on the design system.
 *
 * `OPTION_FOREGROUND` used to hold raw hex. It now resolves to `var(--tag-*)`
 * token expressions while the persisted colour ids stay frozen (a stored option
 * `color` round-trips through the DB as one of those names). These node tests
 * keep both promises: every catalogue value is a tag token, the id list is
 * snapshotted, and a rendered *toned* row carries no raw hex at all.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/server/actions/database", () => ({
  reorderRowsAction: vi.fn(),
  createPropertyAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import { TAG_PALETTE } from "@/lib/design-tokens";
import {
  COLOR_CHOICES,
  OPTION_FOREGROUND,
  optionEdge,
  optionHue,
  optionInk,
  optionSurface,
  type DBProperty,
  type DBRow,
  type HeaderConfig,
} from "./database-types";
import { BoardView, TableView } from "./view-renderers";

/** A tag token expression, e.g. `var(--tag-blue-bd)`. */
const TAG_TOKEN = /^var\(--tag-[a-z]+-(fg|bg|bd)\)$/;
/** A raw hex colour, anywhere in the markup. */
const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/;

const properties: DBProperty[] = [
  { id: "title", name: "Title", type: "TEXT", config: { primary: true } },
  {
    id: "status",
    name: "Status",
    type: "SELECT",
    config: {
      options: [
        { id: "todo", name: "To do", color: "blue" },
        { id: "done", name: "Done", color: "green" },
      ],
    },
  },
];

const rows: DBRow[] = [
  {
    id: "r1",
    title: "Alpha",
    icon: null,
    propertyValues: [{ propertyId: "status", value: { optionId: "todo" } }],
  },
];

const valueFor = (row: DBRow, propertyId: string): unknown =>
  row.propertyValues.find((entry) => entry.propertyId === propertyId)?.value ?? null;

const headerConfig: HeaderConfig = {
  databases: [],
  relations: [],
  relationData: {},
  onLinkDatabase: () => {},
  onConfigureRollup: () => {},
};

const noop = () => {};

describe("option colour catalogue", () => {
  it("resolves every catalogue value to a --tag-* token expression", () => {
    for (const [id, value] of Object.entries(OPTION_FOREGROUND)) {
      expect(value, `${id} should be a tag token`).toMatch(TAG_TOKEN);
      // The catalogue paints the solid hue with the tag ink token.
      expect(value).toBe(`var(--tag-${id}-fg)`);
    }
  });

  it("exposes ink/surface/edge accessors for every hue, defaulting to gray", () => {
    for (const hue of TAG_PALETTE) {
      expect(optionHue(hue)).toBe(hue);
      expect(optionInk(hue)).toBe(`var(--tag-${hue}-fg)`);
      expect(optionSurface(hue)).toBe(`var(--tag-${hue}-bg)`);
      expect(optionEdge(hue)).toBe(`var(--tag-${hue}-bd)`);
    }
    // Anything unknown reads as gray so a swatch is never unstyled.
    expect(optionHue("chartreuse")).toBe("gray");
    expect(optionHue(undefined)).toBe("gray");
    expect(optionInk("nope")).toBe("var(--tag-gray-fg)");
    expect(optionSurface(null)).toBe("var(--tag-gray-bg)");
    expect(optionEdge("")).toBe("var(--tag-gray-bd)");
  });

  it("keeps the persisted option-colour id list frozen (snapshot)", () => {
    const ids = Object.keys(OPTION_FOREGROUND);
    // The same nine ids `COLOR_CHOICES` offers — a stored `color` value must
    // keep resolving forever.
    expect(new Set(ids)).toEqual(new Set(COLOR_CHOICES));
    // The exact list, in the order the catalogue declares it, is snapshotted.
    expect(ids).toEqual([
      "gray",
      "blue",
      "green",
      "red",
      "yellow",
      "orange",
      "purple",
      "pink",
      "brown",
    ]);
    expect(ids).toMatchSnapshot();
  });
});

describe("toned rows render from tokens, never raw hex", () => {
  it("paints a table row stripe + conditional tint from --tag-* tokens", () => {
    const html = renderToStaticMarkup(
      createElement(TableView, {
        locale: "en",
        workspaceSlug: "w",
        workspaceId: "ws",
        properties,
        rows,
        primary: properties[0],
        editable: false,
        config: {},
        valueFor,
        setValue: noop,
        setPrimary: noop,
        removeRow: noop,
        onSaveTemplate: noop,
        computedFor: () => undefined,
        relationOptionsFor: () => [],
        peopleOptions: [],
        headerConfig,
        onRunButton: noop,
        onConfigureButton: noop,
        onOpenPeek: noop,
        onRunAi: noop,
        colorOf: () => "blue",
        onEditFormula: noop,
        onSetFormat: noop,
        onEditOptions: noop,
        editingProperty: null,
        setEditingProperty: noop,
        onDeleteProperty: noop,
        onRenameProperty: noop,
        onDuplicateProperty: noop,
        onReorderProperty: noop,
        rowColorRules: [
          {
            id: "rule-1",
            propertyId: "status",
            filter: { propertyId: "status", operator: "is", value: "To do" },
            color: "red",
            textColor: "green",
            target: "row",
          },
        ],
      }),
    );
    expect(html).toContain("var(--tag-blue-bd)"); // row stripe edge
    expect(html).toContain("var(--tag-red-bg)"); // conditional row tint
    expect(html).toContain("var(--tag-green-fg)"); // conditional row text
    expect(html).not.toMatch(RAW_HEX);
  });

  it("paints the board column dot from --tag-* tokens", () => {
    const board = renderToStaticMarkup(
      createElement(BoardView, {
        locale: "en",
        workspaceSlug: "w",
        workspaceId: "ws",
        properties,
        rows,
        colorOf: () => "blue",
        groupBy: "status",
        primary: properties[0],
        valueFor,
        setValue: noop,
        editable: false,
      }),
    );
    expect(board).toContain("var(--tag-blue-fg)"); // column dot ink
    expect(board).not.toMatch(RAW_HEX);
  });
});
