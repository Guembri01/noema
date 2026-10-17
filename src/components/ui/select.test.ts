import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GROUP_ROW_HEIGHT,
  MATCH_EXACT,
  MATCH_META,
  MATCH_PREFIX,
  MATCH_SUBSTRING,
  MATCH_WORD,
  OPTION_OVERSCAN,
  OPTION_ROW_HEIGHT,
  Select,
  VIRTUALIZE_THRESHOLD,
  applySelection,
  buildRows,
  clearSelection,
  consumeEscape,
  filterOptions,
  firstEnabledIndex,
  groupOptions,
  initialActiveIndex,
  isSelected,
  lastEnabledIndex,
  matchedOption,
  nextEnabledIndex,
  normalizeQuery,
  optionId,
  rankOption,
  removeValue,
  selectNavItems,
  shouldShowCreate,
  toSelectionArray,
  toggleValue,
  virtualOptionWindow,
  type SelectOption,
  type SelectProps,
} from "./select";

/**
 * The pure mapping/keyboard/selection engine behind `<Select>` is exercised
 * directly (no DOM). The closed trigger and the open popup are snapshotted with
 * `renderToStaticMarkup` so the a11y contract, the seven states and the
 * virtualisation window are pinned without a browser.
 */

const render = (props: SelectProps): string =>
  renderToStaticMarkup(createElement(Select as ComponentType<SelectProps>, props));

const OPTIONS: SelectOption[] = [
  { value: "apple", label: "Apple" },
  { value: "apricot", label: "Apricot" },
  { value: "banana", label: "Banana" },
  { value: "grape-apple", label: "Grape Apple" },
  { value: "pineapple", label: "Pineapple", group: "Tropical" },
  { value: "blueberry", label: "Blueberry", description: "a small apple-like berry" },
];

const values = (list: readonly SelectOption[]): string[] => list.map((o) => o.value);

/* -------------------------------------------------------------------------- */

describe("normalizeQuery", () => {
  it("folds case, diacritics and whitespace", () => {
    expect(normalizeQuery("  Café   Crème ")).toBe("cafe creme");
    expect(normalizeQuery("ABC")).toBe("abc");
    expect(normalizeQuery("")).toBe("");
  });
});

describe("ranking / filtering", () => {
  it("ranks exact > prefix > word > substring > metadata", () => {
    expect(rankOption({ value: "a", label: "Apple" }, "apple")).toBe(MATCH_EXACT);
    expect(rankOption({ value: "a", label: "Applesauce" }, "apple")).toBe(MATCH_PREFIX);
    expect(rankOption({ value: "a", label: "Grape Apple" }, "apple")).toBe(MATCH_WORD);
    expect(rankOption({ value: "a", label: "Pineapple" }, "apple")).toBe(MATCH_SUBSTRING);
    expect(
      rankOption({ value: "a", label: "Blueberry", description: "an apple-like berry" }, "apple"),
    ).toBe(MATCH_META);
    expect(rankOption({ value: "a", label: "Banana" }, "apple")).toBeNull();
  });

  it("orders matches by rank then source order, and drops non-matches", () => {
    expect(values(filterOptions(OPTIONS, "apple"))).toEqual([
      "apple", // exact
      "grape-apple", // word
      "pineapple", // substring
      "blueberry", // description
    ]);
  });

  it("keeps equal ranks in source order and honours a limit", () => {
    expect(values(filterOptions(OPTIONS, "ap"))).toEqual([
      "apple", // prefix
      "apricot", // prefix (same rank → source order)
      "grape-apple", // word
      "pineapple", // substring
      "blueberry", // metadata
    ]);
    expect(values(filterOptions(OPTIONS, "ap", 2))).toEqual(["apple", "apricot"]);
  });

  it("reveals everything, in order, for a blank query", () => {
    expect(values(filterOptions(OPTIONS, "   "))).toEqual(values(OPTIONS));
    expect(values(filterOptions(OPTIONS, "", 2))).toEqual(["apple", "apricot"]);
  });

  it("matches values, groups, keywords and folds diacritics", () => {
    expect(values(filterOptions([{ value: "café", label: "Café" }], "cafe"))).toEqual(["café"]);
    expect(values(filterOptions(OPTIONS, "tropical"))).toEqual(["pineapple"]);
    expect(values(filterOptions([{ value: "x", label: "Thing", keywords: ["widget"] }], "widget")))
      .toEqual(["x"]);
    expect(filterOptions(OPTIONS, "zzz")).toEqual([]);
  });

  it("reflects the create gating", () => {
    expect(matchedOption(OPTIONS, "apple")?.value).toBe("apple");
    expect(matchedOption(OPTIONS, "app")).toBeNull();
    expect(matchedOption(OPTIONS, "  APPLE ")).not.toBeNull();
    expect(shouldShowCreate(OPTIONS, "New", true)).toBe(true);
    expect(shouldShowCreate(OPTIONS, "Apple", true)).toBe(false);
    expect(shouldShowCreate(OPTIONS, "New", false)).toBe(false);
    expect(shouldShowCreate(OPTIONS, "   ", true)).toBe(false);
  });
});

describe("grouping", () => {
  it("keeps first-appearance group order and folds blanks to ungrouped", () => {
    const groups = groupOptions([
      { value: "a", label: "A", group: "X" },
      { value: "b", label: "B", group: "Y" },
      { value: "c", label: "C", group: "X" },
      { value: "d", label: "D" },
      { value: "e", label: "E", group: "  " },
    ]);
    expect(groups.map((g) => g.group)).toEqual(["X", "Y", null]);
    expect(values(groups[0].options)).toEqual(["a", "c"]);
    expect(values(groups[1].options)).toEqual(["b"]);
    expect(values(groups[2].options)).toEqual(["d", "e"]);
  });

  it("flattens into heading + option rows", () => {
    const rows = buildRows(
      groupOptions([
        { value: "a", label: "A", group: "Fruit" },
        { value: "b", label: "B", group: "Fruit" },
        { value: "c", label: "C", group: "Veg" },
      ]),
    );
    expect(rows.map((r) => r.kind)).toEqual(["group", "option", "option", "group", "option"]);
    expect(rows[0]).toMatchObject({ kind: "group", label: "Fruit" });
    expect(rows[1].key).toBe("option:a");
  });
});

describe("keyboard index movement", () => {
  // enabled at 0, 2, 3; disabled at 1.
  const items = [{}, { disabled: true }, {}, {}];

  it("skips disabled rows in both directions", () => {
    expect(nextEnabledIndex(items, 0, 1)).toBe(2);
    expect(nextEnabledIndex(items, 2, 1)).toBe(3);
    expect(nextEnabledIndex(items, 0, -1)).toBe(3); // skip 1 backwards, wrap
  });

  it("wraps at both ends and stays put without wrap", () => {
    expect(nextEnabledIndex(items, 3, 1)).toBe(0);
    expect(nextEnabledIndex(items, 3, 1, false)).toBe(3);
    expect(nextEnabledIndex(items, 0, -1, false)).toBe(0);
  });

  it("starts at the first/last row when nothing is active", () => {
    expect(nextEnabledIndex(items, -1, 1)).toBe(0);
    expect(nextEnabledIndex(items, -1, -1)).toBe(3);
    expect(firstEnabledIndex(items)).toBe(0);
    expect(lastEnabledIndex(items)).toBe(3);
  });

  it("degrades safely when everything is disabled", () => {
    const none = [{ disabled: true }, { disabled: true }];
    expect(firstEnabledIndex(none)).toBe(-1);
    expect(lastEnabledIndex(none)).toBe(-1);
    expect(nextEnabledIndex(none, 0, 1)).toBe(0); // no movement
    expect(nextEnabledIndex([], 0, 1)).toBe(-1);
  });

  it("picks the selected row first, else the first enabled row", () => {
    expect(initialActiveIndex(items, [3, 2])).toBe(3);
    expect(initialActiveIndex(items, [1, 2])).toBe(2); // 1 is disabled
    expect(initialActiveIndex(items, [])).toBe(0);
  });

  it("marks group headings and disabled options unselectable, create last", () => {
    const rows = buildRows(
      groupOptions([
        { value: "a", label: "A", group: "X" },
        { value: "b", label: "B", disabled: true, group: "X" },
        { value: "c", label: "C" },
      ]),
    );
    expect(selectNavItems(rows, false)).toEqual([
      { disabled: true }, // "X" heading
      { disabled: false },
      { disabled: true }, // disabled option
      { disabled: false },
    ]);
    // With the create affordance appended, ArrowDown from the last option lands on it.
    const nav = selectNavItems(rows, true);
    expect(nav).toHaveLength(rows.length + 1);
    expect(nextEnabledIndex(nav, 3, 1)).toBe(4);
  });
});

describe("selection logic", () => {
  it("toggles values in multi mode", () => {
    expect(toggleValue([], "a")).toEqual(["a"]);
    expect(toggleValue(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleValue(["a", "b"], "a")).toEqual(["b"]);
    expect(isSelected(["a"], "a")).toBe(true);
    expect(isSelected(["a"], "b")).toBe(false);
    expect(removeValue(["a", "b"], "a")).toEqual(["b"]);
  });

  it("applies single vs multi selection, with and without clear", () => {
    expect(applySelection(["a"], "b", { multiple: true })).toEqual(["a", "b"]);
    expect(applySelection(["a", "b"], "a", { multiple: true })).toEqual(["b"]);
    expect(applySelection(["a"], "b", { multiple: false })).toEqual(["b"]);
    // Re-picking the current single value clears when clearing is allowed…
    expect(applySelection(["a"], "a", { multiple: false, allowClear: true })).toEqual([]);
    // …and is a no-op otherwise.
    expect(applySelection(["a"], "a", { multiple: false, allowClear: false })).toEqual(["a"]);
  });

  it("clears", () => {
    expect(clearSelection()).toEqual([]);
  });

  it("normalises controlled/default values", () => {
    expect(toSelectionArray(undefined, false)).toEqual([]);
    expect(toSelectionArray("", false)).toEqual([]);
    expect(toSelectionArray("a", false)).toEqual(["a"]);
    expect(toSelectionArray(["a", "b"], true)).toEqual(["a", "b"]);
    expect(toSelectionArray(["a", "b"] as unknown as string, false)).toEqual(["a"]);
  });
});

describe("virtualisation", () => {
  it("windows a long list with overscan and clamps an empty one", () => {
    expect(VIRTUALIZE_THRESHOLD).toBe(200);
    expect(OPTION_OVERSCAN).toBe(6);
    expect(virtualOptionWindow({ count: 1000, scrollTop: 0, viewportSize: 320 })).toEqual({
      start: 0,
      end: 10 + OPTION_OVERSCAN,
    });
    expect(virtualOptionWindow({ count: 1000, scrollTop: 3200, viewportSize: 320 })).toEqual({
      start: 100 - OPTION_OVERSCAN,
      end: 110 + OPTION_OVERSCAN,
    });
    expect(virtualOptionWindow({ count: 0, scrollTop: 0, viewportSize: 320 })).toEqual({
      start: 0,
      end: 0,
    });
  });

  it("accounts for shorter group rows", () => {
    const heightOf = (index: number) => (index % 3 === 0 ? GROUP_ROW_HEIGHT : OPTION_ROW_HEIGHT);
    const range = virtualOptionWindow({ count: 900, scrollTop: 0, viewportSize: 320, heightOf });
    expect(range.start).toBe(0);
    expect(range.end).toBeGreaterThan(0);
    expect(range.end).toBeLessThan(900);
  });
});

describe("optionId", () => {
  it("is stable and index-based", () => {
    expect(optionId("sel", 0)).toBe("sel-option-0");
    expect(optionId("sel", 7)).toBe("sel-option-7");
  });
});

/* -------------------------------------------------------------------------- */

describe("closed trigger snapshots", () => {
  it("default: combobox wiring, placeholder and token classes", () => {
    const html = render({ options: OPTIONS, placeholder: "Pick one" });
    expect(html).toContain('data-testid="select-trigger"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("aria-controls=");
    expect(html).toContain("Pick one");
    // design-system utilities, not ad-hoc styling
    expect(html).toContain("focus-ring");
    expect(html).toContain("u-interactive");
    expect(html).toContain("u-colors");
    expect(html).toContain("hover:bg-surface-2");
    // no popup when closed
    expect(html).not.toContain('data-testid="select-menu"');
    expect(html).not.toContain('role="listbox"');
    // no raw hex anywhere in the markup
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("single selection shows the label, an icon and a token-driven tag chip", () => {
    const html = render({
      options: [
        { value: "done", label: "Done", tag: "blue", icon: createElement("span", null, "ok") },
      ],
      defaultValue: "done",
    });
    expect(html).toContain(">Done<");
    expect(html).toContain("--tag-blue-fg"); // tagStyle(), a token var — never a hex
    expect(html).toContain('data-testid="select-clear"');
    expect(html).toContain('aria-label="Clear"');
  });

  it("multi selection renders chips and a +N overflow chip", () => {
    const html = render({
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
        { value: "c", label: "Gamma" },
        { value: "d", label: "Delta" },
      ],
      multiple: true,
      defaultValue: ["a", "b", "c", "d"],
      maxChips: 3,
    });
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html).toContain("Gamma");
    expect(html).not.toContain("Delta");
    expect(html).toContain("+1");
  });

  it("disabled: native disabled + disabled state utilities, no clear", () => {
    const html = render({ options: OPTIONS, defaultValue: "apple", disabled: true });
    expect(html).toMatch(/ disabled(="")?[ >]/);
    expect(html).toContain("disabled:opacity-50");
    expect(html).toContain("disabled:cursor-not-allowed");
    expect(html).not.toContain('data-testid="select-clear"');
  });

  it("loading: aria-busy and a spinner", () => {
    const html = render({ options: OPTIONS, loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("animate-spin");
  });

  it("error: aria-invalid, danger ring and message", () => {
    const html = render({ options: OPTIONS, invalid: true, errorMessage: "Required field" });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("border-danger");
    expect(html).toContain('data-testid="select-error"');
    expect(html).toContain("text-danger");
    expect(html).toContain("Required field");
    expect(html).toContain("aria-describedby=");
  });

  it("compact size and hidden form input", () => {
    const html = render({ options: OPTIONS, defaultValue: "apple", size: "sm", name: "fruit" });
    expect(html).toContain("min-h-8");
    expect(html).toContain('name="fruit"');
    expect(html).toContain('value="apple"');
  });
});

describe("open popup snapshots", () => {
  it("renders a raised, risen listbox with combobox search and options", () => {
    const html = render({ options: OPTIONS, defaultOpen: true });
    expect(html).toContain('data-testid="select-menu"');
    expect(html).toContain("animate-rise");
    expect(html).toContain("surface-raised");
    expect(html).toContain("z-index:50"); // Z.popover, not a magic number
    expect(html).toContain('role="listbox"');
    expect(html).toContain('data-testid="select-search"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="false"');
    expect(html).toContain("Apple");
  });

  it("marks multi listboxes aria-multiselectable and shows check marks", () => {
    const html = render({ options: OPTIONS, multiple: true, defaultOpen: true });
    expect(html).toContain('aria-multiselectable="true"');
  });

  it("groups options under headings", () => {
    const html = render({
      options: [
        { value: "a", label: "Apple", group: "Fruit" },
        { value: "c", label: "Carrot", group: "Vegetables" },
      ],
      defaultOpen: true,
    });
    expect(html).toContain(">Fruit</div>");
    expect(html).toContain(">Vegetables</div>");
    expect(html).toContain('role="presentation"');
  });

  it("empty: an empty state with title and hint", () => {
    const html = render({ options: [], defaultOpen: true });
    expect(html).toContain('data-testid="select-empty"');
    expect(html).toContain("No results");
    expect(html).toContain("Try a different search.");
  });

  it("loading: five skeleton rows and busy listbox", () => {
    const html = render({ options: OPTIONS, loading: true, defaultOpen: true });
    expect(html).toContain('data-testid="select-loading"');
    expect((html.match(/animate-pulse-soft/g) ?? []).length).toBe(10); // 5 rows × 2 bars
    expect(html).toContain('aria-busy="true"');
  });

  it("create affordance appears for an unmatched query and hides on an exact match", () => {
    const created = render({
      options: OPTIONS,
      defaultOpen: true,
      defaultQuery: "Mango",
      onCreate: () => {},
    });
    expect(created).toMatch(/id="[^"]*-create"/);
    expect(created).toContain("Create");
    expect(created).toContain("Mango");

    const suppressed = render({
      options: OPTIONS,
      defaultOpen: true,
      defaultQuery: "Apple",
      onCreate: () => {},
    });
    expect(suppressed).not.toMatch(/id="[^"]*-create"/);
  });

  it("windows lists above the threshold", () => {
    const many: SelectOption[] = Array.from({ length: 260 }, (_, i) => ({
      value: `v${i}`,
      label: `Option ${i}`,
    }));
    const html = render({ options: many, defaultOpen: true });
    const rendered = (html.match(/role="option"/g) ?? []).length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(many.length); // not the whole 260
    expect(html).toContain("height:"); // top/bottom spacers
    expect(html).toContain("Option 0");
    expect(html).not.toContain("Option 200");
  });
});

/* -------------------------------------------------------------------------- */
/* dw10 — Escape propagation + portal/placement wiring                          */
/* -------------------------------------------------------------------------- */

const SELECT_SOURCE = readFileSync(new URL("./select.tsx", import.meta.url), "utf8");

describe("Escape does not leak to a parent dialog", () => {
  it("consumeEscape preventDefaults and stops propagation", () => {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    consumeEscape(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("uses consumeEscape in the Escape key branch", () => {
    expect(SELECT_SOURCE).toMatch(
      /case "Escape":\s*\n\s*consumeEscape\(event\);[\s\S]*?break;/,
    );
  });
});

describe("portal + collision-aware placement wiring", () => {
  it("portals the listbox into document.body in the browser, inline during SSR", () => {
    expect(SELECT_SOURCE).toContain("createPortal(children, document.body)");
    expect(SELECT_SOURCE).toContain('typeof document === "undefined"');
    // the click-outside test understands the detached tree too
    expect(SELECT_SOURCE).toContain('[data-testid="select-menu"]');
  });

  it("resolves the popup with the shared collision engine (flip + clamp)", () => {
    expect(SELECT_SOURCE).toContain('from "@/lib/floating"');
    expect(SELECT_SOURCE).toContain("placeFloating({");
    expect(SELECT_SOURCE).toContain("floatingStyle(");
    // placement is resolved on open and while the page scrolls / resizes
    expect(SELECT_SOURCE).toContain('window.addEventListener("resize", resolve)');
    expect(SELECT_SOURCE).toContain('window.addEventListener("scroll", resolve, true)');
  });
});
