import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Switch,
  switchAriaBusy,
  switchAriaChecked,
  switchDataState,
  switchInteractive,
  type SwitchProps,
} from "./switch";

/**
 * ds02 — the Switch primitive. These node tests pin the optimistic-state mapping
 * (checked/pending → aria + interactivity) and statically render every state,
 * including the `--dur-2` / `--ease-spring` thumb motion.
 */

const render = (props: SwitchProps): string =>
  renderToStaticMarkup(createElement(Switch, props));

describe("switch state mapping", () => {
  it("maps checked to aria-checked and data-state", () => {
    expect(switchAriaChecked(true)).toBe("true");
    expect(switchAriaChecked(false)).toBe("false");
    expect(switchDataState(true)).toBe("checked");
    expect(switchDataState(false)).toBe("unchecked");
  });

  it("marks aria-busy only while a change is in flight", () => {
    expect(switchAriaBusy(true)).toBe(true);
    expect(switchAriaBusy(false)).toBeUndefined();
  });

  it("lets an optimistic change block a second activation", () => {
    expect(switchInteractive(false, false)).toBe(true);
    expect(switchInteractive(true, false)).toBe(false);
    expect(switchInteractive(false, true)).toBe(false);
    expect(switchInteractive(true, true)).toBe(false);
  });
});

describe("switch render states", () => {
  it("renders an off switch with role=switch and aria-checked=false", () => {
    const html = render({ checked: false, "aria-label": "Sync" });
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('data-state="unchecked"');
    expect(html).toContain('aria-label="Sync"');
    expect(html).toContain("focus-ring");
    expect(html).toContain("min-h-11");
    expect(html).not.toContain("aria-busy");
  });

  it("renders an on switch with the thumb at its checked position", () => {
    const html = render({ checked: true });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-state="checked"');
    expect(html).toContain("translate-x-5"); // md default thumb travel
    expect(html).toContain("bg-action");
  });

  it("renders the in-flight state as aria-busy and disabled, keeping the value", () => {
    const html = render({ checked: true, pending: true });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    expect(html).toContain("animate-spin");
  });

  it("renders the disabled state", () => {
    const html = render({ checked: false, disabled: true });
    expect(html).toContain("disabled");
    expect(html).toContain("opacity-50");
    expect(html).not.toContain("aria-busy");
  });

  it("animates the thumb on the token duration and easing", () => {
    const html = render({ checked: false });
    expect(html).toContain("var(--dur-2)");
    expect(html).toContain("var(--ease-spring)");
    expect(html).toContain("motion-reduce:transition-none");
  });

  it("wires the label and description", () => {
    const html = render({
      checked: true,
      id: "dark-mode",
      label: "Dark mode",
      description: "Follow the system",
    });
    expect(html).toContain('id="dark-mode"');
    expect(html).toContain('for="dark-mode"');
    expect(html).toContain('id="dark-mode-description"');
    expect(html).toContain("Dark mode");
    expect(html).toContain("Follow the system");
  });

  it("renders both sizes", () => {
    expect(render({ checked: false, size: "sm" })).toContain("h-5 w-9");
    expect(render({ checked: false, size: "md" })).toContain("h-6 w-11");
  });
});
