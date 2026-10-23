import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PropertyType } from "@prisma/client";
import {
  Cell,
  avatarHue,
  cellKeyOutcome,
  cellStateClass,
  cellVisualState,
  isEditableCellType,
  optionTagHue,
  type CellVisualState,
} from "./view-parts";
import { COLOR_CHOICES, type DBProperty, type DBRow } from "@/components/database/database-types";
import { TAG_PALETTE, tagClass, tagStyle } from "@/lib/design-tokens";
import type { RowColorRule } from "@/lib/row-color-rules";

/**
 * ds14 — cell-level polish in the table.
 *
 * The table is the most-seen surface, so every cell type shares one state
 * vocabulary: hover tint, focus-visible ring, selected accent outline, an
 * editing state and an invalid (danger) state. These node tests pin the *pure*
 * state → class mapping and the token-backed tag/avatar mappings, then render a
 * real `Cell` in each state so a regression that re-inlines a raw colour or
 * drops a state fails here.
 */

const noop = () => {};

const property = (
  type: string,
  config: unknown,
  name = "Field",
  id = "p1",
  extra: Record<string, unknown> = {},
): DBProperty =>
  ({
    id,
    name,
    type: type as PropertyType,
    config: config as DBProperty["config"],
    ...extra,
  }) as DBProperty;

const render = (props: Parameters<typeof Cell>[0]) =>
  renderToStaticMarkup(createElement(Cell, props));

/** Every cell type the table can render, editable and derived. */
const EDITABLE_TYPES = [
  "TEXT",
  "NUMBER",
  "SELECT",
  "STATUS",
  "MULTI_SELECT",
  "DATE",
  "CHECKBOX",
  "URL",
  "EMAIL",
  "PHONE",
  "PEOPLE",
  "FILES",
  "PLACE",
  "ICON",
  "RELATION",
  "VERIFICATION",
  "BUTTON",
  "AI_AUTOFILL",
] as const;

const READ_ONLY_TYPES = [
  "FORMULA",
  "ROLLUP",
  "CREATED_TIME",
  "LAST_EDITED_TIME",
  "CREATED_BY",
  "LAST_EDITED_BY",
  "UNIQUE_ID",
] as const;

describe("isEditableCellType", () => {
  it("treats value-bearing types as editable", () => {
    for (const type of EDITABLE_TYPES) {
      expect(isEditableCellType(type)).toBe(true);
    }
  });

  it("treats derived types as read-only (no editor, so no editing state)", () => {
    for (const type of READ_ONLY_TYPES) {
      expect(isEditableCellType(type)).toBe(false);
    }
  });
});

describe("cellVisualState — state precedence", () => {
  it("lets invalid beat every other flag", () => {
    expect(
      cellVisualState("TEXT", {
        invalid: true,
        editing: true,
        selected: true,
        focus: true,
        hover: true,
      }),
    ).toBe("invalid");
  });

  it("lets editing beat selected/focus/hover for an editable type", () => {
    expect(cellVisualState("TEXT", { editing: true, selected: true })).toBe(
      "editing",
    );
  });

  it("ignores editing on a read-only type", () => {
    expect(cellVisualState("FORMULA", { editing: true })).toBe("idle");
    expect(cellVisualState("FORMULA", { editing: true, selected: true })).toBe(
      "selected",
    );
  });

  it("orders selected > focus > hover > idle", () => {
    expect(cellVisualState("TEXT", { selected: true, focus: true, hover: true })).toBe(
      "selected",
    );
    expect(cellVisualState("TEXT", { focus: true, hover: true })).toBe("focus");
    expect(cellVisualState("TEXT", { hover: true })).toBe("hover");
    expect(cellVisualState("TEXT", {})).toBe("idle");
  });
});

describe("cellStateClass — state → class, per cell type", () => {
  const allTypes = [...EDITABLE_TYPES, ...READ_ONLY_TYPES];

  it("gives every cell type a hover tint and a focus-visible ring", () => {
    for (const type of allTypes) {
      const cls = cellStateClass(type);
      expect(cls).toContain("hover:bg-surface-2/60");
      expect(cls).toContain("focus-within:ring-2");
      expect(cls).toContain("focus-within:ring-ring/60");
    }
  });

  it("resolves editing to the neutral focus ring on editable types", () => {
    for (const type of EDITABLE_TYPES) {
      const cls = cellStateClass(type, { editing: true });
      expect(cls).toContain("ring-focus/40");
      expect(cls).toContain("bg-bg");
      expect(cls).toContain("cursor-text");
    }
  });

  it("never marks a read-only type as editing", () => {
    for (const type of READ_ONLY_TYPES) {
      const cls = cellStateClass(type, { editing: true });
      expect(cls).not.toContain("ring-focus/40");
      expect(cls).not.toContain("cursor-text");
    }
  });

  it("resolves invalid to the danger ring for every type", () => {
    for (const type of allTypes) {
      const cls = cellStateClass(type, { invalid: true });
      expect(cls).toContain("ring-danger");
      // Exactly one *base* ring: danger replaces the editing/selected ring.
      // (`focus-within:ring-ring/60` is a variant, not a competing base ring.)
      expect(cls).not.toContain("ring-focus/40");
      expect(cls).not.toContain("bg-selection-soft");
      expect(cls).not.toMatch(/(?:^|\s)ring-ring(?:\/|$|\s)/);
    }
  });

  it("resolves selected to the soft selection fill", () => {
    const cls = cellStateClass("TEXT", { selected: true });
    expect(cls).toContain("bg-selection-soft");
    expect(cls).not.toContain("ring-focus/40");
    expect(cls).not.toContain("ring-danger");
  });

  it("emits no raw hex and no bespoke Tailwind colour pairs", () => {
    for (const type of allTypes) {
      for (const state of [
        {},
        { editing: true },
        { invalid: true },
        { selected: true },
        { focus: true },
        { hover: true },
      ] satisfies CellVisualState[]) {
        const cls = cellStateClass(type, state);
        expect(cls).not.toMatch(/#[0-9a-fA-F]{3,8}/);
        // e.g. `text-green-700`, `bg-red-500/10` — colours must come from tokens.
        expect(cls).not.toMatch(/\b(?:red|green|amber|blue|yellow|orange|purple|pink)-\d{2,3}\b/);
      }
    }
  });
});

describe("cellKeyOutcome — editor entry/exit keyboard contract", () => {
  it("maps Enter → commit, Escape → cancel, Tab → move", () => {
    expect(cellKeyOutcome("Enter")).toBe("commit");
    expect(cellKeyOutcome("Escape")).toBe("cancel");
    expect(cellKeyOutcome("Tab")).toBe("move");
  });

  it("leaves the native arrows and typing to the control", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "a", "Backspace"]) {
      expect(cellKeyOutcome(key)).toBe("none");
    }
  });
});

describe("optionTagHue — stored option colour → shared tag palette", () => {
  it("passes every configured option colour straight through", () => {
    for (const color of COLOR_CHOICES) {
      expect(optionTagHue(color)).toBe(color);
    }
  });

  it("accepts the extra `teal` hue the tag palette defines", () => {
    expect(optionTagHue("teal")).toBe("teal");
  });

  it("falls back to gray for anything unknown", () => {
    expect(optionTagHue(null)).toBe("gray");
    expect(optionTagHue(undefined)).toBe("gray");
    expect(optionTagHue("")).toBe("gray");
    expect(optionTagHue("chartreuse")).toBe("gray");
    expect(optionTagHue("default")).toBe("gray");
  });

  it("builds a token class + style for every hue (never a raw colour)", () => {
    for (const hue of TAG_PALETTE) {
      expect(tagClass(hue)).toBe(`tag tag-${hue}`);
      expect(tagStyle(hue)).toEqual({
        color: `var(--tag-${hue}-fg)`,
        background: `var(--tag-${hue}-bg)`,
        borderColor: `var(--tag-${hue}-bd)`,
      });
    }
  });
});

describe("avatarHue — deterministic mini-avatar colour", () => {
  it("is stable for a name and always a palette hue", () => {
    for (const name of ["Ada Lovelace", "Grace Hopper", "Zoe", "", "林徽因"]) {
      const hue = avatarHue(name);
      expect(TAG_PALETTE).toContain(hue);
      expect(avatarHue(name)).toBe(hue);
    }
  });

  it("spreads a roster across more than one hue", () => {
    const hues = new Set(["Ada", "Grace", "Alan", "Katherine"].map(avatarHue));
    expect(hues.size).toBeGreaterThan(1);
  });
});

describe("Cell — the shell renders each state", () => {
  it("renders the hover tint and focus ring on an idle cell", () => {
    const html = render({
      property: property("TEXT", null, "Notes"),
      value: { text: "hello" },
      editable: false,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain('data-cell-type="TEXT"');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("hover:bg-surface-2/60");
    expect(html).toContain("focus-within:ring-2");
  });

  it("marks an editing cell with the neutral focus ring and a filling input", () => {
    const html = render({
      property: property("TEXT", null, "Notes"),
      value: { text: "hello" },
      editable: true,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain('data-state="editing"');
    expect(html).toContain("ring-focus/40");
    // The editor fills the cell (no layout shift) and carries the focus ring.
    expect(html).toMatch(/<input[^>]*class="[^"]*focus-ring[^"]*w-full/);
  });

  it("flags an invalid cell with the danger ring, aria-invalid and the message", () => {
    const html = render({
      property: property("TEXT", null, "Title", "p1", { required: true }),
      value: null,
      editable: false,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain('data-invalid="true"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('data-state="invalid"');
    expect(html).toContain("ring-danger");
    expect(html).toContain("Title is required.");
    expect(html).not.toContain("ring-red-500");
  });

  it("paints the soft selection fill on a selected cell", () => {
    const html = render({
      property: property("TEXT", null, "Notes"),
      value: { text: "hello" },
      editable: false,
      selected: true,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain('data-state="selected"');
    expect(html).toContain("bg-selection-soft");
  });
});

describe("Cell — select / chip polish", () => {
  it("renders a select chip through the tag palette with the hue as its title", () => {
    const html = render({
      property: property(
        "SELECT",
        { options: [{ id: "done", name: "Done", color: "green" }] },
        "Status",
      ),
      value: { optionId: "done" },
      editable: false,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain('data-testid="option-chip"');
    expect(html).toContain("tag tag-green");
    expect(html).toContain("var(--tag-green-fg)");
    expect(html).toContain('title="green"');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("falls back to the gray tag for an unknown option colour", () => {
    const html = render({
      property: property(
        "SELECT",
        { options: [{ id: "x", name: "X", color: "neon" }] },
        "Status",
      ),
      value: { optionId: "x" },
      editable: false,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain("tag tag-gray");
  });

  it("renders multi-select chips without a raw hex", () => {
    const html = render({
      property: property(
        "MULTI_SELECT",
        {
          options: [
            { id: "a", name: "Alpha", color: "blue" },
            { id: "b", name: "Beta", color: "pink" },
          ],
        },
        "Tags",
      ),
      value: { optionIds: ["a"] },
      editable: true,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain("tag tag-blue");
    expect(html).toContain("tag tag-pink");
    expect(html).toContain("var(--tag-blue-bg)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});

describe("Cell — checkbox tick and person avatar", () => {
  it("animates a checked checkbox tick with the 160 ms token", () => {
    const html = render({
      property: property("CHECKBOX", null, "Done"),
      value: { checked: true },
      editable: true,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("animate-scale-in");
  });

  it("draws no tick while unchecked", () => {
    const html = render({
      property: property("CHECKBOX", null, "Done"),
      value: { checked: false },
      editable: true,
      onChange: noop,
      locale: "en",
    });
    expect(html).not.toContain("animate-scale-in");
  });

  it("renders a mini avatar (initials + tag colour) on a person chip", () => {
    const html = render({
      property: property("PEOPLE", null, "Assignees"),
      value: { names: ["Ada Lovelace"] },
      editable: false,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain(">AL<");
    expect(html).toContain(`var(--tag-${avatarHue("Ada Lovelace")}-bg)`);
  });
});

describe("Cell — verification chip and truncation", () => {
  it("renders the verification chip through the tag palette (no bespoke pairs)", () => {
    const html = render({
      property: property("VERIFICATION", null, "Checked"),
      value: {
        verified: true,
        verifiedById: "u1",
        verifiedAt: "2026-03-01T12:00:00.000Z",
      },
      editable: true,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain('data-tone="verified"');
    expect(html).toContain("tag tag-green");
    expect(html).not.toContain("border-green-600");
    expect(html).not.toContain("bg-green-600");
    expect(html).not.toContain("text-green-700");
  });

  it("truncates a derived display and keeps the full value as its title", () => {
    const html = render({
      property: property("FORMULA", null, "Total"),
      value: null,
      computed: "a very long computed value",
      editable: false,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain("truncate");
    expect(html).toContain('title="a very long computed value"');
  });

  it("paints a conditional-format cell tint from the tag tokens, not a raw hex", () => {
    const properties = [
      property("NUMBER", null, "Estimate", "estimate"),
      property("TEXT", null, "Status", "status"),
    ];
    const rule: RowColorRule = {
      id: "c1",
      propertyId: "status",
      filter: { propertyId: "estimate", operator: "gt", value: "1" },
      color: "red",
      target: "cell",
    };
    const row: DBRow = {
      id: "r1",
      title: "Row",
      icon: null,
      propertyValues: [
        { propertyId: "estimate", value: { number: 5 } },
        { propertyId: "status", value: { text: "x" } },
      ],
    };
    const html = render({
      property: properties[1],
      value: { text: "x" },
      editable: false,
      colorRules: [rule],
      row,
      properties,
      onChange: noop,
      locale: "en",
    });
    expect(html).toContain("background-color:var(--tag-red-bg)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
