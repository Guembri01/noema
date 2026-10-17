import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Select, type SelectProps, type SelectOption } from "./select";

/**
 * dw10 — the Select listbox must be rendered into `document.body` (a detached
 * portal) so no scrolling/overflow ancestor can clip it. `react-dom` is mocked
 * here only to observe `createPortal`'s container without a real DOM; the
 * server renderer still receives the children so the markup can be asserted.
 */

const portalState = vi.hoisted(() => {
  const calls: Array<{ container: unknown }> = [];
  return { calls };
});

vi.mock("react-dom", () => ({
  createPortal: (children: unknown, container: unknown) => {
    portalState.calls.push({ container });
    return children;
  },
}));

const OPTIONS: SelectOption[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
];

const render = (props: SelectProps): string =>
  renderToStaticMarkup(createElement(Select as ComponentType<SelectProps>, props));

describe("Select portal layer", () => {
  it("renders the open listbox into document.body when a DOM exists", () => {
    const body = { nodeType: 1, tagName: "BODY" } as unknown as HTMLElement;
    (globalThis as unknown as { document?: unknown }).document = { body };
    portalState.calls.length = 0;
    try {
      const html = render({ options: OPTIONS, defaultOpen: true });
      expect(portalState.calls.length).toBeGreaterThan(0);
      expect(portalState.calls[0].container).toBe(body);
      // children still render, so the detached listbox content is present
      expect(html).toContain('data-testid="select-menu"');
      expect(html).toContain('role="listbox"');
      expect(html).toContain("Apple");
    } finally {
      delete (globalThis as unknown as { document?: unknown }).document;
    }
  });

  it("renders inline during SSR (no document) without touching a portal", () => {
    portalState.calls.length = 0;
    const html = render({ options: OPTIONS, defaultOpen: true });
    expect(portalState.calls.length).toBe(0);
    expect(html).toContain('data-testid="select-menu"');
  });
});
