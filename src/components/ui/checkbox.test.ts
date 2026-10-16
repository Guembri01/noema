import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Checkbox,
  FOCUS_RING,
  TOUCH_TARGET,
  checkboxAriaChecked,
  checkboxDataState,
  isIndeterminate,
  nextCheckboxState,
  type CheckboxProps,
} from "./checkbox";

/**
 * ds02 — the Checkbox primitive. These node tests pin the pure tri-state
 * mapping (the only logic) and statically render every state so a regression in
 * the ARIA wiring or the token classes fails here.
 */

const render = (props: CheckboxProps): string =>
  renderToStaticMarkup(createElement(Checkbox, props));

describe("checkbox state mapping", () => {
  it("maps the tri-state to aria-checked, including mixed", () => {
    expect(checkboxAriaChecked(true)).toBe("true");
    expect(checkboxAriaChecked(false)).toBe("false");
    expect(checkboxAriaChecked("indeterminate")).toBe("mixed");
  });

  it("maps the tri-state to one canonical data-state", () => {
    expect(checkboxDataState(true)).toBe("checked");
    expect(checkboxDataState(false)).toBe("unchecked");
    expect(checkboxDataState("indeterminate")).toBe("indeterminate");
  });

  it("flags only the indeterminate state", () => {
    expect(isIndeterminate("indeterminate")).toBe(true);
    expect(isIndeterminate(true)).toBe(false);
    expect(isIndeterminate(false)).toBe(false);
  });

  it("toggles mixed/unchecked to checked, checked to unchecked", () => {
    expect(nextCheckboxState("indeterminate")).toBe(true);
    expect(nextCheckboxState(false)).toBe(true);
    expect(nextCheckboxState(true)).toBe(false);
  });

  it("exposes the shared, single focus ring and the touch target", () => {
    expect(FOCUS_RING).toBe("focus-ring");
    expect(TOUCH_TARGET).toContain("min-h-11");
  });
});

describe("checkbox render states", () => {
  it("renders an unchecked box with role=checkbox and aria-checked=false", () => {
    const html = render({ checked: false, "aria-label": "Done" });
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('data-state="unchecked"');
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain("focus-ring");
    expect(html).toContain("min-h-11");
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("renders a checked box with aria-checked=true and a glyph", () => {
    const html = render({ checked: true });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-state="checked"');
    expect(html).toContain("opacity-100");
    expect(html).toContain("<svg");
  });

  it("renders the indeterminate box as aria-checked=mixed", () => {
    const html = render({ checked: "indeterminate" });
    expect(html).toContain('aria-checked="mixed"');
    expect(html).toContain('data-state="indeterminate"');
    expect(html).toContain("opacity-100");
  });

  it("renders the disabled state with the disabled attribute", () => {
    const html = render({ checked: false, disabled: true });
    expect(html).toContain("disabled");
    expect(html).toContain("opacity-50");
  });

  it("renders the error state as invalid with the message below", () => {
    const html = render({
      checked: false,
      error: "This field is required",
    });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("border-danger");
    expect(html).toContain("This field is required");
    expect(html).toContain("text-danger");
  });

  it("wires label and description via ids, and the error into aria-describedby", () => {
    const html = render({
      checked: true,
      id: "notify",
      label: "Notifications",
      description: "Send me email",
      error: "Nope",
    });
    expect(html).toContain('id="notify"');
    expect(html).toContain('for="notify"');
    expect(html).toContain('id="notify-description"');
    expect(html).toContain('id="notify-error"');
    expect(html).toContain('aria-describedby="notify-description notify-error"');
    expect(html).toContain("Notifications");
    expect(html).toContain("Send me email");
  });

  it("renders both sizes without changing the control's own layout", () => {
    expect(render({ checked: false, size: "sm" })).toContain("h-4 w-4");
    expect(render({ checked: false, size: "md" })).toContain("h-5 w-5");
  });
});
