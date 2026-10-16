import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_VISIBLE_TOASTS,
  TOAST_BASE_CLASS,
  TOAST_VARIANT_CLASS,
  overflowCount,
  toastVariantClass,
  ToastView,
} from "./toaster";

describe("toast overflow maths", () => {
  it("keeps the three-toast window", () => {
    expect(MAX_VISIBLE_TOASTS).toBe(3);
  });

  it("counts only the toasts hidden behind the window", () => {
    expect(overflowCount(0)).toBe(0);
    expect(overflowCount(3)).toBe(0);
    expect(overflowCount(4)).toBe(1);
    expect(overflowCount(10)).toBe(7);
  });

  it("honours a custom maximum and floors junk", () => {
    expect(overflowCount(5, 2)).toBe(3);
    expect(overflowCount(4.9)).toBe(1);
    expect(overflowCount(Number.NaN)).toBe(0);
    expect(overflowCount(Infinity)).toBe(0);
    expect(overflowCount(5, -1)).toBe(5);
  });
});

describe("toast variant → class map", () => {
  it("carries the status colour on the left edge", () => {
    expect(toastVariantClass("success")).toContain("border-l-success");
    expect(toastVariantClass("error")).toContain("border-l-danger");
    expect(toastVariantClass("info")).toContain("border-l-accent");
    expect(toastVariantClass("warning")).toContain("border-l-warning");
    expect(toastVariantClass("default")).toContain("border-l-border-strong");
    expect(toastVariantClass("undo")).toContain("border-l-border-strong");
  });

  it("gives every variant the 2px accent edge, and shares the frame", () => {
    for (const classes of Object.values(TOAST_VARIANT_CLASS)) {
      expect(classes).toContain("border-l-2");
    }
    expect(TOAST_BASE_CLASS).toContain("rounded-md");
    expect(TOAST_BASE_CLASS).toContain("border-border");
  });
});

describe("ToastView", () => {
  it("renders a success toast with an action button at Z.toast", () => {
    const html = renderToStaticMarkup(
      createElement(ToastView, {
        variant: "success",
        title: "Saved",
        description: "Your page is up to date",
        actionLabel: "Undo",
        onAction: () => {},
      }),
    );
    expect(html).toContain('data-testid="toast"');
    expect(html).toContain('data-variant="success"');
    expect(html).toContain("Saved");
    expect(html).toContain("Your page is up to date");
    expect(html).toContain("Undo");
    expect(html).toContain("border-l-success");
    expect(html).toContain("z-index:70");
  });

  it("renders an undo toast without a description or action", () => {
    const html = renderToStaticMarkup(
      createElement(ToastView, { variant: "undo", title: "Note archived" }),
    );
    expect(html).toContain('data-variant="undo"');
    expect(html).toContain("Note archived");
    expect(html).not.toContain("<button");
  });
});
